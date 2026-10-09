import { z } from 'zod';
import { ASSISTANT_SPECIALTIES, PERMISSIONS, careAssistantStateSchema } from '@healthbridge/shared';
import { isUuid, newId } from '../../core/db/ids.js';
import { withActor, withSystem } from '../../core/db/actorContext.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/http/errors.js';
import { domainMetrics } from '../../core/metrics/domain.js';
import { SELF_RELATIONSHIPS } from '../../core/authz/accessPolicy.js';
import { calendarContext } from './calendar.js';
import { createToolContext } from './tools.js';

export const SESSION_TTL_MS = 24 * 3_600_000;
export const MAX_TURNS = 40;
export const MAX_TOOL_ROUNDS = 3;

const FALLBACK_REPLY = Object.freeze({
  kind: 'fallback',
  message:
    'The assistant isn’t available right now. You can still find a doctor and book a time in My Doctors.',
  cards: [{ type: 'link', target: 'my_doctors' }],
});

// The AI step's answer is checked like any untrusted input before it is used.
const cardSchema = z.object({
  type: z.enum(['doctor', 'slot', 'link']),
  doctorId: z.uuid().optional(),
  startsAt: z.iso.datetime({ offset: true }).optional(),
  target: z.enum(['my_doctors', 'appointments', 'records', 'prescriptions']).optional(),
});
const stepSchema = z.object({
  state: z.unknown(),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('respond') }),
    z.object({
      type: z.literal('tool'),
      tool: z.string().max(40),
      args: z.record(z.string(), z.unknown()),
    }),
  ]),
  reply: z
    .object({
      kind: z.enum(['answer', 'clarify', 'emergency', 'fallback', 'not_yet', 'help']),
      message: z.string().min(1).max(700),
      cards: z.array(cardSchema).max(12).default([]),
    })
    .nullable(),
  run: z.object({ runId: z.uuid().optional() }).partial().optional(),
});

/**
 * The HealthBridge Assistant (M13.1, ADR-0029): a bounded orchestration layer over the
 * existing backend. The backend owns every turn: it calls the private AI service for one
 * step at a time, executes the (read-only) tools the step asks for through the existing
 * domain services, validates the returned state, and only then commits it. The AI
 * service never calls back, never sees a patient identifier in its prompt, and cannot
 * change anything. Message text is never stored — only `CareAssistantState`.
 */
export function createAssistantService({
  knex,
  aiClient,
  accessPolicy,
  audit,
  repository,
  careService,
  doctorService,
  availabilityService,
  logger,
  now = () => new Date(),
}) {
  /** The acting patient: self, or a dependent the user guards (AccessPolicy decides). */
  async function authorizeScope(trx, principal, patientId, req) {
    const decision = await accessPolicy.enforce({
      principal,
      permission: PERMISSIONS.ASSISTANT_USE,
      resource: { type: 'patient', id: patientId, patientId },
      req,
      trx,
    });
    // Defence in depth: only the patient side ever acts through the assistant.
    if (!SELF_RELATIONSHIPS.has(decision.relationship)) throw new ForbiddenError();
    return decision.relationship === 'guardian_dependent' ? 'dependent' : 'self';
  }

  const view = (row, actingFor) => ({
    id: row.id,
    patientId: row.patient_id,
    actingFor,
    status: row.status,
    version: row.version,
    turns: row.turn_count,
    expiresAt: row.expires_at,
  });

  async function createSession(principal, { patientId } = {}, req) {
    return withActor(knex, principal.userId, async (trx) => {
      let target = patientId;
      if (!target) {
        const own = await trx('patients')
          .where({ user_id: principal.userId })
          .whereNull('deleted_at')
          .first('id');
        if (!own) throw new NotFoundError('Create your health profile first.', 'profile_required');
        target = own.id;
      }
      if (!isUuid(target)) throw new NotFoundError();
      const actingFor = await authorizeScope(trx, principal, target, req);
      const created = now();
      const row = {
        id: newId(),
        user_id: principal.userId,
        patient_id: target,
        state: careAssistantStateSchema.parse({}),
        created_at: created,
        expires_at: new Date(created.getTime() + SESSION_TTL_MS),
      };
      await repository.insert(trx, row);
      await audit.record(
        {
          category: 'data_access',
          action: 'assistant.session_started',
          outcome: 'success',
          resourceType: 'agent_session',
          resourceId: row.id,
          patientId: target,
          metadata: { actingFor },
        },
        { req, trx },
      );
      return view({ ...row, status: 'active', version: 1, turn_count: 0 }, actingFor);
    });
  }

  async function loadActive(trx, principal, sessionId, req) {
    if (!isUuid(sessionId)) throw new NotFoundError();
    const row = await repository.find(trx, sessionId); // RLS: own sessions only
    if (!row) throw new NotFoundError();
    if (row.status !== 'active' || new Date(row.expires_at) <= now()) {
      throw new ConflictError(
        'This conversation has ended. Start a new one.',
        'assistant_session_ended',
      );
    }
    // Every turn re-checks the patient scope: a revoked guardianship ends access at once.
    const actingFor = await authorizeScope(trx, principal, row.patient_id, req);
    return { row, actingFor };
  }

  async function getSession(principal, sessionId, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { row, actingFor } = await loadActive(trx, principal, sessionId, req);
      return view(row, actingFor);
    });
  }

  async function endSession(principal, sessionId) {
    if (!isUuid(sessionId)) throw new NotFoundError();
    await withActor(knex, principal.userId, async (trx) => {
      if (!(await repository.find(trx, sessionId))) throw new NotFoundError();
      await repository.end(trx, sessionId);
    });
  }

  /** Keeps only references the backend itself produced (this turn or earlier turns). */
  function sanitizeState(candidate, previous, evidence) {
    const parsed = careAssistantStateSchema.safeParse(candidate);
    if (!parsed.success) return null;
    const next = parsed.data;
    const known = (id) =>
      evidence.doctors.has(id) ||
      previous.candidateDoctorIds.includes(id) ||
      previous.careTeamDoctorIds.includes(id) ||
      previous.selectedDoctorId === id;
    next.careTeamDoctorIds = next.careTeamDoctorIds.filter(
      (id) => evidence.careTeam?.has(id) || previous.careTeamDoctorIds.includes(id),
    );
    next.candidateDoctorIds = next.candidateDoctorIds.filter(known);
    if (next.selectedDoctorId && !known(next.selectedDoctorId)) next.selectedDoctorId = null;
    next.slotStarts = next.slotStarts.filter(
      (s) =>
        evidence.slots.has(`${next.selectedDoctorId}|${s}`) ||
        (next.selectedDoctorId === previous.selectedDoctorId && previous.slotStarts.includes(s)),
    );
    return next;
  }

  /** Cards show backend data only; anything the backend did not return is dropped. */
  async function hydrate(reply, tools, patientId) {
    const team = reply.cards.some((c) => c.type !== 'link')
      ? await tools.careTeam().catch(() => new Map())
      : new Map();
    const cards = [];
    for (const card of reply.cards) {
      if (card.type === 'link' && card.target) {
        cards.push({ type: 'link', target: card.target });
      } else if (card.type === 'doctor' && tools.evidence.doctors.has(card.doctorId)) {
        const doctor = tools.evidence.doctors.get(card.doctorId);
        cards.push({ type: 'doctor', doctor, careStatus: team.get(doctor.id) ?? 'none' });
      } else if (card.type === 'slot') {
        const slot = tools.evidence.slots.get(`${card.doctorId}|${card.startsAt}`);
        const doctor = tools.evidence.doctors.get(card.doctorId);
        if (!slot || !doctor) continue;
        cards.push({
          type: 'slot',
          doctorId: doctor.id,
          doctorName: doctor.professionalName,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt ?? null,
          mode: slot.mode,
          feePaise: slot.feePaise ?? null,
          clinicId: slot.clinicId ?? null,
          patientId,
          bookable: team.get(doctor.id) === 'active',
        });
      }
    }
    return { kind: reply.kind, message: reply.message, cards, source: 'ai_assistant' };
  }

  async function sendMessage(principal, sessionId, { text, version, timeZone }, req) {
    const started = performance.now();
    const { row, actingFor } = await withActor(knex, principal.userId, (trx) =>
      loadActive(trx, principal, sessionId, req),
    );
    if (row.version !== version) {
      throw new ConflictError(
        'This conversation changed in another window. Reload to continue.',
        'assistant_session_changed',
      );
    }
    if (row.turn_count >= MAX_TURNS) {
      throw new ConflictError(
        'This conversation is long enough. Start a new one to continue.',
        'assistant_turn_limit',
      );
    }
    const previous =
      careAssistantStateSchema.safeParse(row.state).data ?? careAssistantStateSchema.parse({});
    const context = {
      ...calendarContext(timeZone, now()),
      specialties: [...ASSISTANT_SPECIALTIES],
      actingFor,
    };
    const tools = createToolContext(
      { accessPolicy, careService, doctorService, availabilityService, logger },
      { principal, patientId: row.patient_id, actingFor, timeZone, req },
    );
    const base = { patientId: row.patient_id, sessionId: row.id, context };
    const used = [];
    let failure = null;
    let step = null;
    let runId = null;
    try {
      if (!aiClient) throw Object.assign(new Error('AI client not configured'), { kind: 'ai' });
      step = stepSchema.parse(
        await aiClient.agentStep(
          { ...base, message: text, state: previous },
          { requestId: req?.id },
        ),
      );
      runId = step.run?.runId ?? null;
      while (step.action.type === 'tool') {
        if (used.length >= MAX_TOOL_ROUNDS) {
          failure = 'tool_limit';
          break;
        }
        const name = step.action.tool;
        const result = await tools.execute(name, step.action.args);
        used.push(name);
        step = stepSchema.parse(
          await aiClient.agentStep(
            {
              ...base,
              state: step.state,
              toolResult: { name, ...result },
              toolsThisTurn: [...used],
            },
            { requestId: req?.id },
          ),
        );
      }
    } catch (err) {
      failure = err instanceof z.ZodError ? 'invalid_ai_response' : 'ai_unavailable';
      // Metadata only: never the message, the state or the AI response.
      logger?.warn({ errName: err?.name, kind: failure }, 'assistant turn degraded');
    }

    let next = previous;
    let reply = FALLBACK_REPLY;
    if (!failure && step?.reply) {
      const clean = sanitizeState(step.state, previous, tools.evidence);
      if (clean) {
        next = clean;
        reply = step.reply;
      } else {
        failure = 'invalid_ai_state';
      }
    } else if (!failure) {
      failure = 'invalid_ai_response';
    }
    const hydrated = await hydrate(failure ? FALLBACK_REPLY : reply, tools, row.patient_id);

    const saved = await withActor(knex, principal.userId, async (trx) => {
      const advanced = await repository.advance(trx, row.id, version, {
        state: next,
        last_run_id: runId,
      });
      if (!advanced) {
        throw new ConflictError(
          'This conversation changed in another window. Reload to continue.',
          'assistant_session_changed',
        );
      }
      await audit.record(
        {
          category: 'data_access',
          action: 'assistant.turn',
          outcome: failure ? 'failure' : 'success',
          resourceType: 'agent_session',
          resourceId: row.id,
          patientId: row.patient_id,
          reason: failure ?? hydrated.kind,
          // Never the message, the reply text or the criteria values: names and counts.
          metadata: { intent: next.intent, tools: used, cards: hydrated.cards.length, actingFor },
        },
        { req, trx },
      );
      return advanced;
    });

    const outcome = failure ? 'degraded' : hydrated.kind;
    domainMetrics.agentRuns.inc({ intent: next.intent ?? 'none', outcome });
    if (failure) domainMetrics.agentFailures.inc({ kind: failure });
    domainMetrics.agentLatency.observe({ outcome }, (performance.now() - started) / 1000);

    return {
      session: view({ ...row, version: saved.version, turn_count: saved.turn_count }, actingFor),
      reply: hydrated,
      // What the assistant understood: structured, so the person can correct it.
      understood: { intent: next.intent, criteria: next.criteria },
      degraded: Boolean(failure),
    };
  }

  /** Retention: expired sessions are deleted (maintenance sweep). */
  async function purgeExpired() {
    return withSystem(knex, 'assistant', (trx) => repository.deleteExpired(trx));
  }

  return { createSession, getSession, endSession, sendMessage, purgeExpired };
}
