import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  ASSISTANT_ANY_DOCTOR_CHOICE,
  ASSISTANT_EMERGENCY_MESSAGE,
  ASSISTANT_SPECIALTIES,
  PRACTICE_AREAS,
  PERMISSIONS,
  careAssistantStateSchema,
  isPossibleAssistantEmergency,
} from '@healthbridge/shared';
import { isUuid, newId } from '../../core/db/ids.js';
import { withActor, withSystem } from '../../core/db/actorContext.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../core/http/errors.js';
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

/** Fixed emergency guidance (the shared rule's wording); never composed by a model. */
const EMERGENCY_REPLY = Object.freeze({
  kind: 'emergency',
  message: ASSISTANT_EMERGENCY_MESSAGE,
  cards: [],
  source: 'safety_rule',
});

// The AI step's answer is checked like any untrusted input before it is used.
/** Step 10: intents answered with facts from the person's own record. */
const APPOINTMENT_INTENTS = new Set(['view_appointments', 'reschedule', 'cancel']);
const MAX_RECORD_CARDS = 3;
const MAX_PRESCRIPTION_CARDS = 2;
/** ADR-0038: a proposed booking waits this long for the person's Confirm. */
const PROPOSAL_TTL_MS = 15 * 60_000;
const BOOKING_REASON_NOTE = 'Booked with the HealthBridge Assistant.';
const RECENT_PRESCRIPTION_DAYS = 90;

const cardSchema = z.object({
  type: z.enum(['doctor', 'slot', 'link', 'choice', 'booking']),
  doctorId: z.uuid().optional(),
  startsAt: z.iso.datetime({ offset: true }).optional(),
  target: z.enum(['my_doctors', 'appointments', 'records', 'prescriptions']).optional(),
  // Step 6: a tappable answer (an allowed kind of doctor, or "any kind").
  value: z.string().max(60).optional(),
});
const CHOICES = new Set([...ASSISTANT_SPECIALTIES, ASSISTANT_ANY_DOCTOR_CHOICE]);
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
      kind: z.enum(['answer', 'clarify', 'confirm', 'emergency', 'fallback', 'not_yet', 'help']),
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
  doctorSearchService,
  recommendationService,
  availabilityService,
  appointmentService,
  prescriptionService,
  logger,
  inputDigester,
  now = () => new Date(),
}) {
  if (typeof inputDigester?.digest !== 'function') {
    throw new Error('assistant: an AI input digester is required');
  }

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

  /**
   * `allowEnded`: for possible-emergency messages only. The guidance is shown even in a
   * conversation that has ended or expired; the session itself is not advanced (the
   * conditional update refuses ended and expired rows). Access is still checked.
   */
  async function loadActive(trx, principal, sessionId, req, { allowEnded = false } = {}) {
    if (!isUuid(sessionId)) throw new NotFoundError();
    const row = await repository.find(trx, sessionId); // RLS: own sessions only
    if (!row) throw new NotFoundError();
    const ended = row.status !== 'active' || new Date(row.expires_at) <= now();
    if (ended && !allowEnded) {
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

  const actionView = (action) => ({
    id: action.id,
    status: action.status,
    ...(action.result ?? {}),
  });

  async function finishAction(principal, action, status, result, errorCode = null) {
    await withActor(knex, principal.userId, (trx) =>
      trx('assistant_actions')
        .where({ id: action.id, status: 'proposed' })
        .update({ status, result: result ?? null, error_code: errorCode, decided_at: now() }),
    );
  }

  /**
   * ADR-0038: the person confirmed a proposed booking. Access is checked again, then the
   * booking goes through the one booking path (eligibility guard, payment hold, outbox)
   * with an idempotency key derived from the proposal, so a retried tap books once.
   * Not yet in the doctor's care team: a care request is sent first; it is active at once
   * when the doctor accepts new patients, otherwise the booking waits for the doctor.
   */
  async function confirmAction(principal, sessionId, actionId, { reason }, req) {
    if (!isUuid(sessionId) || !isUuid(actionId)) throw new NotFoundError();
    const action = await withActor(knex, principal.userId, async (trx) => {
      const found = await trx('assistant_actions')
        .where({ id: actionId, session_id: sessionId })
        .first();
      if (!found) throw new NotFoundError();
      // A revoked guardianship ends the person's access here too.
      await authorizeScope(trx, principal, found.patient_id, req);
      return found;
    });
    if (action.status === 'done' || action.status === 'awaiting_doctor') {
      return actionView(action); // a repeated tap: the same result, nothing booked twice
    }
    if (action.status !== 'proposed') {
      throw new ConflictError(
        'This booking can no longer be confirmed. Ask me for the times again.',
        'assistant_action_closed',
      );
    }
    if (new Date(action.expires_at) <= now()) {
      await finishAction(principal, action, 'failed', null, 'assistant_action_expired');
      throw new ConflictError(
        'This proposal expired. Ask me for the times again.',
        'assistant_action_expired',
      );
    }
    const p = action.payload;
    const team = await careService.listForPatient(principal, action.patient_id, req);
    let care = team.find((r) => r.doctorId === p.doctorId && r.status !== 'ended') ?? null;
    if (!care) {
      care = await careService.request(
        principal,
        { patientId: action.patient_id, doctorId: p.doctorId },
        req,
      );
    }
    if (care.status !== 'active') {
      const result = { careRelationshipId: care.id, careStatus: care.status };
      await finishAction(principal, action, 'awaiting_doctor', result);
      await audit.record(
        {
          category: 'data_access',
          action: 'assistant.action_confirmed',
          outcome: 'success',
          resourceType: 'assistant_action',
          resourceId: action.id,
          patientId: action.patient_id,
          reason: 'awaiting_doctor',
          metadata: { kind: 'book' },
        },
        { req },
      );
      return { id: action.id, status: 'awaiting_doctor', ...result };
    }
    let booked;
    try {
      booked = await appointmentService.book(
        principal,
        {
          patientId: action.patient_id,
          doctorId: p.doctorId,
          startsAt: p.startsAt,
          mode: p.mode,
          ...(p.clinicId ? { clinicId: p.clinicId } : {}),
          reason: reason?.trim() || BOOKING_REASON_NOTE,
        },
        { idempotencyKey: `assistant-${action.id}` },
        req,
      );
    } catch (err) {
      if (err instanceof AppError && err.status === 409) {
        await finishAction(principal, action, 'failed', null, err.code ?? 'booking_failed');
      }
      throw err;
    }
    const result = {
      appointmentId: booked.appointment.id,
      appointmentStatus: booked.appointment.status,
    };
    await finishAction(principal, action, 'done', result);
    await audit.record(
      {
        category: 'data_access',
        action: 'assistant.action_confirmed',
        outcome: 'success',
        resourceType: 'assistant_action',
        resourceId: action.id,
        patientId: action.patient_id,
        reason: booked.appointment.status,
        metadata: { kind: 'book', appointmentId: booked.appointment.id },
      },
      { req },
    );
    return { id: action.id, status: 'done', ...result, appointment: booked.appointment };
  }

  /** The person closes the conversation; its structured state stops being usable. */
  async function endSession(principal, sessionId, req) {
    if (!isUuid(sessionId)) throw new NotFoundError();
    await withActor(knex, principal.userId, async (trx) => {
      const row = await repository.find(trx, sessionId); // RLS: own sessions only
      if (!row) throw new NotFoundError();
      if ((await repository.end(trx, sessionId)) === 0) return; // already ended: no change
      await audit.record(
        {
          category: 'data_access',
          action: 'assistant.session_ended',
          outcome: 'success',
          resourceType: 'agent_session',
          resourceId: sessionId,
          patientId: row.patient_id,
          metadata: { turns: row.turn_count },
        },
        { req, trx },
      );
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
    // Step 6: only doctors the backend showed before can be excluded from later searches.
    next.excludedDoctorIds = next.excludedDoctorIds.filter(
      (id) => previous.candidateDoctorIds.includes(id) || previous.excludedDoctorIds.includes(id),
    );
    if (next.selectedDoctorId && !known(next.selectedDoctorId)) next.selectedDoctorId = null;
    // ADR-0038: the booking doctor is one the backend showed; a chosen time one it offered.
    if (
      next.bookingDoctorId &&
      !known(next.bookingDoctorId) &&
      previous.bookingDoctorId !== next.bookingDoctorId
    ) {
      next.bookingDoctorId = null;
    }
    next.slotStarts = next.slotStarts.filter(
      (s) =>
        evidence.slots.has(`${next.selectedDoctorId}|${s}`) ||
        (next.selectedDoctorId === previous.selectedDoctorId && previous.slotStarts.includes(s)),
    );
    if (next.chosenStart && !next.slotStarts.includes(next.chosenStart)) next.chosenStart = null;
    if (!next.bookingDoctorId) next.chosenStart = null;
    return next;
  }

  /**
   * Step 10: facts from the person's own record, for intents that ask about them. The
   * backend reads them after the AI has chosen the intent, through the same services and
   * access checks as the pages; they are never sent to the AI or stored with the session.
   */
  async function recordCards(intent, principal, patientId, req) {
    try {
      if (APPOINTMENT_INTENTS.has(intent) && appointmentService) {
        const upcoming = await appointmentService.listForPatient(
          principal,
          { patientId, scope: 'upcoming' },
          req,
        );
        return upcoming.slice(0, MAX_RECORD_CARDS).map((a) => ({
          type: 'appointment',
          source: 'record',
          appointmentId: a.id,
          reference: a.reference,
          doctorName: a.doctor?.professionalName ?? null,
          startsAt: a.startsAt,
          mode: a.mode,
          status: a.status,
        }));
      }
      if (intent === 'view_medications' && prescriptionService) {
        const since = now().getTime() - RECENT_PRESCRIPTION_DAYS * 86_400_000;
        const signed = await prescriptionService.listForPatient(principal, patientId, req);
        return signed
          .filter((p) => p.status === 'signed' && new Date(p.signedAt).getTime() >= since)
          .slice(0, MAX_PRESCRIPTION_CARDS)
          .map((p) => ({
            type: 'medication',
            source: 'record',
            prescriptionId: p.id,
            reference: p.reference,
            doctorName: p.doctorName ?? null,
            signedAt: p.signedAt,
            items: p.items.map((i) => ({
              drugName: i.drugName,
              strength: i.strength,
              form: i.form,
              dose: i.dose,
              frequency: i.frequency,
              route: i.route,
              duration: i.duration,
              instructions: i.instructions,
            })),
          }));
      }
    } catch (err) {
      // The page link still answers; the reason is logged without content.
      logger?.warn(
        { errName: err?.name, code: err?.code, intent },
        'assistant record cards skipped',
      );
    }
    return [];
  }

  /**
   * ADR-0038: a proposal for a time the assistant offered. The slot is checked again with
   * the backend's own slot rules (as the person's view), then stored for 15 minutes. Nothing
   * is booked: only the confirm endpoint, called by the person's tap, books.
   * @returns {Promise<object|null>} the booking card, or null when the time is gone
   */
  async function proposeBooking({ principal, row, doctorId, startsAt, tools, team, req }) {
    const at = DateTime.fromISO(startsAt).toUTC();
    if (!at.isValid) return null;
    const slots = await availabilityService
      .slots(principal, doctorId, {
        from: at.minus({ days: 1 }).toISODate(),
        to: at.plus({ days: 1 }).toISODate(),
      })
      .catch(() => []);
    const slot = slots.find((s) => Date.parse(s.startsAt) === at.toMillis());
    if (!slot) return null;
    const profile = await doctorService.publicProfile(doctorId).catch(() => null);
    const facts = tools.evidence.doctors.get(doctorId);
    if (!profile && !facts) return null;
    const clinic = slot.clinicId
      ? ((profile?.clinics ?? facts?.clinics ?? []).find((c) => c.id === slot.clinicId) ?? null)
      : null;
    const id = newId();
    const created = now();
    const expiresAt = new Date(created.getTime() + PROPOSAL_TTL_MS);
    const payload = {
      doctorId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      mode: slot.mode,
      clinicId: slot.clinicId ?? null,
      feePaise: slot.feePaise ?? 0,
    };
    await withActor(knex, principal.userId, async (trx) => {
      await trx('assistant_actions').insert({
        id,
        session_id: row.id,
        user_id: principal.userId,
        patient_id: row.patient_id,
        kind: 'book',
        payload,
        created_at: created,
        expires_at: expiresAt,
      });
      await audit.record(
        {
          category: 'data_access',
          action: 'assistant.action_proposed',
          outcome: 'success',
          resourceType: 'assistant_action',
          resourceId: id,
          patientId: row.patient_id,
          metadata: { kind: 'book', doctorId, mode: slot.mode, paid: payload.feePaise > 0 },
        },
        { req, trx },
      );
    });
    const careStatus = team.get(doctorId) ?? 'none';
    return {
      type: 'booking',
      actionId: id,
      expiresAt: expiresAt.toISOString(),
      doctor: {
        id: doctorId,
        professionalName: profile?.professionalName ?? facts.professionalName,
        primarySpecialization: profile?.primarySpecialization ?? facts.primarySpecialization,
      },
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      mode: slot.mode,
      clinic: clinic ? { id: clinic.id, name: clinic.name, city: clinic.city ?? null } : null,
      feePaise: payload.feePaise,
      careStatus,
      // Not yet in the care team: confirming also asks to join it (at once when the doctor
      // accepts new patients; otherwise the doctor accepts first).
      joinsCareTeam: careStatus !== 'active',
      acceptsNewPatients: Boolean(profile?.acceptsNewPatients),
    };
  }

  /** Cards show backend data only; anything the backend did not return is dropped. */
  async function hydrate(reply, tools, patientId, booking = null) {
    const team = reply.cards.some((c) => ['doctor', 'slot', 'booking'].includes(c.type))
      ? await tools.careTeam().catch(() => new Map())
      : new Map();
    const cards = [];
    for (const card of reply.cards) {
      if (card.type === 'link' && card.target) {
        cards.push({ type: 'link', target: card.target });
      } else if (card.type === 'choice' && CHOICES.has(card.value)) {
        // Step 6: answers the person can tap; anything else is dropped.
        cards.push({ type: 'choice', value: card.value });
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
      } else if (card.type === 'booking' && booking && card.doctorId && card.startsAt) {
        const proposal = await proposeBooking({
          ...booking,
          doctorId: card.doctorId,
          startsAt: card.startsAt,
          tools,
          team,
        });
        if (!proposal) {
          // The time went in the meantime: say so instead of a card that cannot book.
          return {
            kind: 'answer',
            message: 'That time isn’t free any more. Ask me for other times with this doctor.',
            cards: [],
            source: 'ai_assistant',
          };
        }
        cards.push(proposal);
      }
    }
    return { kind: reply.kind, message: reply.message, cards, source: 'ai_assistant' };
  }

  /**
   * A message that may describe an emergency is answered by the backend itself with the
   * fixed guidance. No AI-service call, no tool and no booking flow runs, so the guidance
   * cannot be lost to an AI outage, a timeout or a failed AI run-record write. It is not
   * blocked by a stale version or the turn limit either (the session simply does not
   * advance then), and a failure to record the turn is logged, never shown instead.
   */
  async function emergencyTurn(principal, { row, actingFor }, version, started, req) {
    const previous =
      careAssistantStateSchema.safeParse(row.state).data ?? careAssistantStateSchema.parse({});
    let current = { version: row.version, turn_count: row.turn_count };
    try {
      const saved = await withActor(knex, principal.userId, async (trx) => {
        const advanced =
          row.status === 'active' &&
          new Date(row.expires_at) > now() &&
          row.version === version &&
          row.turn_count < MAX_TURNS
            ? await repository.advance(trx, row.id, version, { state: previous })
            : null;
        await audit.record(
          {
            category: 'data_access',
            action: 'assistant.turn',
            outcome: 'success',
            resourceType: 'agent_session',
            resourceId: row.id,
            patientId: row.patient_id,
            reason: 'emergency',
            // Never the message: names and counts only. No AI call, no tools.
            metadata: { intent: previous.intent, tools: [], cards: 0, actingFor, ai: false },
          },
          { req, trx },
        );
        return advanced;
      });
      if (saved) current = saved;
    } catch (err) {
      logger?.error({ errName: err?.name }, 'assistant emergency turn not recorded');
    }
    domainMetrics.agentRuns.inc({ intent: previous.intent ?? 'none', outcome: 'emergency' });
    domainMetrics.agentLatency.observe(
      { outcome: 'emergency' },
      (performance.now() - started) / 1000,
    );
    return {
      session: view({ ...row, ...current }, actingFor),
      reply: { ...EMERGENCY_REPLY, cards: [] },
      understood: { intent: previous.intent, criteria: previous.criteria },
      degraded: false,
    };
  }

  async function sendMessage(principal, sessionId, { text, version, timeZone, select }, req) {
    const started = performance.now();
    // Screened before anything that involves the AI service (deterministic, shared rule).
    const emergency = isPossibleAssistantEmergency(text);
    const loaded = await withActor(knex, principal.userId, (trx) =>
      loadActive(trx, principal, sessionId, req, { allowEnded: emergency }),
    );
    if (emergency) return emergencyTurn(principal, loaded, version, started, req);
    const { row, actingFor } = loaded;
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
      // M13.2: the areas of practice the AI may pick from (codes and labels; never text).
      areas: PRACTICE_AREAS.map((a) => ({
        code: a.code,
        label: a.label,
        specialties: a.specialties,
      })),
      actingFor,
    };
    const tools = createToolContext(
      {
        accessPolicy,
        careService,
        doctorService,
        doctorSearchService,
        recommendationService,
        availabilityService,
        logger,
      },
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
          // The AI service records only this keyed digest with its run, never the text.
          {
            ...base,
            message: text,
            inputDigest: inputDigester.digest('care_assistant_message', text),
            state: previous,
            // ADR-0038: a tap on an offered doctor or time (applied without a model call).
            ...(select ? { selection: select } : {}),
          },
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
    const hydrated = await hydrate(failure ? FALLBACK_REPLY : reply, tools, row.patient_id, {
      principal,
      row,
      req,
    });
    if (!failure) {
      hydrated.cards.push(...(await recordCards(next.intent, principal, row.patient_id, req)));
    }

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

  return { createSession, getSession, endSession, sendMessage, purgeExpired, confirmAction };
}
