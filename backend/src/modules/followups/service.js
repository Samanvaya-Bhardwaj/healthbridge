import {
  EMERGENCY_GUIDANCE,
  FOLLOW_UP_MAX_REMINDERS,
  FOLLOW_UP_NO_RESPONSE_DAYS,
  FOLLOW_UP_RED_FLAGS,
  FOLLOW_UP_REMINDER_INTERVAL_HOURS,
  OPEN_FOLLOW_UP_STATUSES,
  PERMISSIONS,
  evaluateFollowUpResponse,
} from '@healthbridge/shared';
import { DateTime } from 'luxon';
import { isUuid, newId } from '../../core/db/ids.js';
import { withActor, withSystem } from '../../core/db/actorContext.js';
import { appendOutboxEvent } from '../../core/events/outbox.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../core/http/errors.js';
import { domainMetrics } from '../../core/metrics/domain.js';

const DATA = 'data_access';
const OVERALL_TEXT = {
  better: 'better than at the consultation',
  same: 'about the same as at the consultation',
  worse: 'worse than at the consultation',
};
const noteAad = (responseId, patientId) => `follow_up_response:${responseId}:${patientId}`;
const todayIst = (at) => DateTime.fromJSDate(at).setZone('Asia/Kolkata').toISODate();

/**
 * Follow-ups (ADR-0026).
 *
 * - Created from outcome A's follow-up date (worker) or by the treating doctor.
 * - The due sweep (database as source of truth) opens due check-ins, writes durable
 *   reminder events (at most FOLLOW_UP_MAX_REMINDERS, FOLLOW_UP_REMINDER_INTERVAL_HOURS
 *   apart) and alerts the doctor when nobody answers within FOLLOW_UP_NO_RESPONSE_DAYS.
 * - The patient side answers once; deterministic rules (shared `evaluateFollowUpResponse`)
 *   escalate. Red flags show fixed emergency guidance immediately. AI never decides.
 * - The bounded follow-up agent (AI service) only summarises the answer for the doctor,
 *   with citations, and only when the patient opted in to AI processing.
 */
export function createFollowUpService({
  knex,
  accessPolicy,
  audit,
  envelope,
  aiClient,
  logger,
  now = () => new Date(),
}) {
  function view(row, { response = null, summary = null, party } = {}) {
    return {
      id: row.id,
      patientId: row.patient_id,
      patientName: row.patient_name ?? null,
      doctorId: row.doctor_id,
      doctorName: row.doctor_name ?? null,
      consultationId: row.consultation_id,
      appointmentId: row.appointment_id,
      origin: row.origin,
      dueOn: row.due_on,
      status: row.status,
      escalation: { level: row.escalation_level, reasons: row.escalation_reasons ?? [] },
      reminderCount: row.reminder_count,
      respondedAt: row.responded_at,
      closedAt: row.closed_at,
      closeNote: party === 'doctor' ? row.close_note : null,
      response,
      summary,
      emergencyGuidance: row.status === 'urgent' && party === 'patient' ? EMERGENCY_GUIDANCE : null,
    };
  }

  const baseQuery = (trx) =>
    trx('follow_ups as f')
      .join('doctors as d', 'd.id', 'f.doctor_id')
      .leftJoin('patients as p', 'p.id', 'f.patient_id')
      .select('f.*', 'd.professional_name as doctor_name', 'p.full_name as patient_name');

  function responseView(r) {
    if (!r) return null;
    return {
      overall: r.overall,
      redFlags: r.red_flags.map((code) => ({ code, label: FOLLOW_UP_RED_FLAGS[code] ?? code })),
      note: r.note_enc ? envelope.decryptJson(r.note_enc, noteAad(r.id, r.patient_id)).note : '',
      createdAt: r.created_at,
    };
  }

  async function emit(trx, row, eventType, payload = {}, req = null) {
    await appendOutboxEvent(trx, {
      aggregateType: 'follow_up',
      aggregateId: row.id,
      eventType,
      requestId: req?.id ?? null,
      payload: {
        followUpId: row.id,
        patientId: row.patient_id,
        doctorId: row.doctor_id,
        ...payload,
      },
    });
  }

  // ── Doctor ──────────────────────────────────────────────────────

  async function create(principal, patientId, { dueOn, appointmentId }, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.FOLLOWUPS_MANAGE,
        resource: { type: 'patient', id: patientId, patientId },
        req,
        trx,
      });
      if (dueOn < todayIst(now())) {
        throw new BadRequestError('The follow-up date cannot be in the past.', 'due_in_past');
      }
      const doctor = await trx('doctors').where({ user_id: principal.userId }).first('id');
      if (!doctor) throw new ForbiddenError('A doctor profile is required.', 'not_a_doctor');
      if (appointmentId) {
        const appt = await trx('appointments')
          .where({ id: appointmentId, patient_id: patientId, doctor_id: doctor.id })
          .first('id');
        if (!appt) throw new NotFoundError();
      }
      const row = {
        id: newId(),
        patient_id: patientId,
        doctor_id: doctor.id,
        doctor_user_id: principal.userId,
        appointment_id: appointmentId ?? null,
        origin: 'doctor',
        due_on: dueOn,
        created_by_user_id: principal.userId,
      };
      await trx('follow_ups').insert(row);
      await audit.record(
        {
          category: DATA,
          action: 'follow_up.scheduled',
          outcome: 'success',
          resourceType: 'follow_up',
          resourceId: row.id,
          patientId,
          metadata: { dueOn, origin: 'doctor' },
        },
        { req, trx },
      );
      await emit(trx, row, 'follow_up.created', { dueOn }, req);
      domainMetrics.followUps.inc({ event: 'created' });
      return view(await baseQuery(trx).where('f.id', row.id).first(), { party: 'doctor' });
    });
  }

  async function listForDoctor(principal, { status } = {}, req) {
    return withActor(knex, principal.userId, async (trx) => {
      await accessPolicy.enforce({ principal, permission: PERMISSIONS.FOLLOWUPS_MANAGE, req, trx });
      const q = baseQuery(trx)
        .where('f.doctor_user_id', principal.userId)
        .orderByRaw(
          `CASE f.status WHEN 'urgent' THEN 0 WHEN 'needs_attention' THEN 1 WHEN 'responded' THEN 2
                         WHEN 'awaiting_response' THEN 3 WHEN 'scheduled' THEN 4 ELSE 5 END`,
        )
        .orderBy('f.due_on')
        .limit(200);
      if (status === 'open') q.whereIn('f.status', OPEN_FOLLOW_UP_STATUSES);
      else if (status) q.where('f.status', status);
      return (await q).map((row) => view(row, { party: 'doctor' }));
    });
  }

  async function loadForParty(trx, principal, id, req) {
    if (!isUuid(id)) throw new NotFoundError();
    // RLS: the follow-up's doctor or the patient side.
    const row = await baseQuery(trx).where('f.id', id).first();
    if (!row) throw new NotFoundError();
    if (row.doctor_user_id === principal.userId) {
      await accessPolicy.enforce({ principal, permission: PERMISSIONS.FOLLOWUPS_MANAGE, req, trx });
      return { row, party: 'doctor' };
    }
    await accessPolicy.enforce({
      principal,
      permission: PERMISSIONS.APPOINTMENTS_READ,
      resource: { type: 'patient', id: row.patient_id, patientId: row.patient_id },
      req,
      trx,
    });
    return { row, party: 'patient' };
  }

  async function get(principal, id, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { row, party } = await loadForParty(trx, principal, id, req);
      const response = await trx('follow_up_responses').where({ follow_up_id: id }).first();
      let summary = null;
      if (party === 'doctor') {
        const s = await trx('ai.follow_up_summaries')
          .where({ follow_up_id: id })
          .orderBy('created_at', 'desc')
          .first();
        if (s) {
          summary = {
            status: s.status,
            sentences: s.sentences,
            createdAt: s.created_at,
            source: 'ai_generated',
          };
        }
        if (response) {
          await audit.record(
            {
              category: DATA,
              action: 'follow_up.response_viewed',
              outcome: 'success',
              resourceType: 'follow_up',
              resourceId: id,
              patientId: row.patient_id,
            },
            { req, trx },
          );
        }
      }
      return view(row, { response: responseView(response), summary, party });
    });
  }

  async function close(principal, id, { note }, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { row, party } = await loadForParty(trx, principal, id, req);
      if (party !== 'doctor') {
        throw new ForbiddenError('Only the doctor closes a follow-up.', 'wrong_party');
      }
      if (!OPEN_FOLLOW_UP_STATUSES.includes(row.status)) {
        throw new ConflictError('This follow-up is already closed.', 'follow_up_closed');
      }
      const status = row.status === 'scheduled' ? 'cancelled' : 'closed';
      await trx('follow_ups')
        .where({ id })
        .update({
          status,
          closed_at: now(),
          closed_by_user_id: principal.userId,
          close_note: note || null,
        });
      await audit.record(
        {
          category: DATA,
          action: 'follow_up.closed',
          outcome: 'success',
          resourceType: 'follow_up',
          resourceId: id,
          patientId: row.patient_id,
          reason: status,
        },
        { req, trx },
      );
      await emit(trx, row, 'follow_up.closed', { status }, req);
      return view(await baseQuery(trx).where('f.id', id).first(), { party: 'doctor' });
    });
  }

  // ── Patient side ────────────────────────────────────────────────

  async function listForPatient(principal, patientId, req) {
    if (!isUuid(patientId)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      const decision = await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.APPOINTMENTS_READ,
        resource: { type: 'patient', id: patientId, patientId },
        req,
        trx,
      });
      if (!['patient_self', 'guardian_dependent'].includes(decision.relationship)) {
        throw new NotFoundError();
      }
      const rows = await baseQuery(trx)
        .where('f.patient_id', patientId)
        .orderBy('f.due_on', 'desc')
        .limit(100);
      return rows.map((row) => view(row, { party: 'patient' }));
    });
  }

  async function respond(principal, id, body, req) {
    const result = await withActor(knex, principal.userId, async (trx) => {
      if (!isUuid(id)) throw new NotFoundError();
      const row = await baseQuery(trx).where('f.id', id).forUpdate('f').first();
      if (!row) throw new NotFoundError();
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.FOLLOWUPS_RESPOND,
        resource: { type: 'patient', id: row.patient_id, patientId: row.patient_id },
        req,
        trx,
      });
      if (!['scheduled', 'awaiting_response'].includes(row.status)) {
        throw new ConflictError('This check-in is no longer open.', 'follow_up_not_open');
      }
      const decision = evaluateFollowUpResponse(body);
      const responseId = newId();
      const note = body.note?.trim()
        ? envelope.encryptJson({ note: body.note.trim() }, noteAad(responseId, row.patient_id))
        : null;
      await trx('follow_up_responses').insert({
        id: responseId,
        follow_up_id: id,
        patient_id: row.patient_id,
        responder_user_id: principal.userId,
        overall: body.overall,
        red_flags: body.redFlags,
        note_enc: note?.blob ?? null,
        key_id: note?.keyId ?? null,
      });
      await trx('follow_ups').where({ id }).update({
        status: decision.status,
        escalation_level: decision.level,
        escalation_reasons: decision.reasons,
        responded_at: now(),
      });
      await audit.record(
        {
          category: DATA,
          action: 'follow_up.responded',
          outcome: 'success',
          resourceType: 'follow_up',
          resourceId: id,
          patientId: row.patient_id,
          reason: decision.level,
          // Counts only: warning signs and the note are clinical content.
          metadata: { redFlags: body.redFlags.length, hasNote: Boolean(note) },
        },
        { req, trx },
      );
      await emit(trx, row, 'follow_up.responded', { level: decision.level }, req);
      domainMetrics.followUps.inc({ event: `responded_${decision.level}` });
      return { row, decision };
    });
    return {
      ...(await get(principal, id, req)),
      emergencyGuidance: result.decision.level === 'urgent' ? EMERGENCY_GUIDANCE : null,
    };
  }

  // ── Workers ─────────────────────────────────────────────────────

  /** consultation.completed (outcome A with a date) → one follow-up per consultation. */
  async function createFromOutcome({ aggregateId, payload = {} }) {
    if (payload.outcome !== 'online_managed' || !payload.followUpOn) return { outcome: 'none' };
    return withSystem(knex, 'followups', async (trx) => {
      const c = await trx('consultations').where({ id: aggregateId }).first();
      if (!c || c.outcome !== 'online_managed' || !c.outcome_detail?.followUpOn) {
        return { outcome: 'none' };
      }
      const row = {
        id: newId(),
        patient_id: c.patient_id,
        doctor_id: c.doctor_id,
        doctor_user_id: c.doctor_user_id,
        consultation_id: c.id,
        appointment_id: c.appointment_id,
        origin: 'consultation_outcome',
        due_on: c.outcome_detail.followUpOn,
      };
      const inserted = await trx('follow_ups')
        .insert(row)
        .onConflict('consultation_id')
        .ignore()
        .returning('id');
      if (!inserted.length) return { outcome: 'duplicate' };
      await emit(trx, row, 'follow_up.created', { dueOn: row.due_on });
      domainMetrics.followUps.inc({ event: 'created' });
      return { outcome: 'created', followUpId: row.id };
    });
  }

  /** Due sweep: open, remind, alert on silence. Idempotent; the database decides. */
  async function sweep() {
    const at = now();
    return withSystem(knex, 'followups', async (trx) => {
      const opened = await trx('follow_ups')
        .where({ status: 'scheduled' })
        .where('due_on', '<=', todayIst(at))
        .update({ status: 'awaiting_response', opened_at: at })
        .returning(['id', 'patient_id', 'doctor_id']);
      const reminderCutoff = new Date(at.getTime() - FOLLOW_UP_REMINDER_INTERVAL_HOURS * 3_600_000);
      const remind = await trx('follow_ups')
        .where({ status: 'awaiting_response' })
        .where('reminder_count', '<', FOLLOW_UP_MAX_REMINDERS)
        .where((w) =>
          w.whereNull('last_reminded_at').orWhere('last_reminded_at', '<=', reminderCutoff),
        )
        .forUpdate()
        .skipLocked()
        .limit(500)
        .select('id', 'patient_id', 'doctor_id', 'reminder_count');
      for (const f of remind) {
        await trx('follow_ups')
          .where({ id: f.id })
          .update({ reminder_count: f.reminder_count + 1, last_reminded_at: at });
        await emit(trx, f, 'follow_up.reminder_due', { sequence: f.reminder_count + 1 });
      }
      const silenceCutoff = new Date(at.getTime() - FOLLOW_UP_NO_RESPONSE_DAYS * 86_400_000);
      const silent = await trx('follow_ups')
        .where({ status: 'awaiting_response' })
        .where('opened_at', '<=', silenceCutoff)
        .update({
          status: 'needs_attention',
          escalation_level: 'attention',
          escalation_reasons: ['no_response'],
        })
        .returning(['id', 'patient_id', 'doctor_id']);
      for (const f of silent) await emit(trx, f, 'follow_up.no_response');
      if (opened.length || remind.length || silent.length) {
        logger?.info(
          { opened: opened.length, reminded: remind.length, noResponse: silent.length },
          'follow-up sweep',
        );
      }
      return { opened: opened.length, reminded: remind.length, noResponse: silent.length };
    });
  }

  /**
   * Bounded follow-up agent: the AI service summarises the check-in for the doctor from
   * labelled facts (cited, validated). Only with the patient's AI opt-in.
   */
  async function summarize(followUpId, { requestId } = {}) {
    if (!aiClient) return { outcome: 'ai_unavailable' };
    const input = await withSystem(knex, 'followups', async (trx) => {
      const f = await trx('follow_ups').where({ id: followUpId }).first();
      if (!f) return null;
      const optedIn = await trx.raw('SELECT authz.ai_processing_enabled(?) AS on', [f.patient_id]);
      if (!optedIn.rows[0]?.on) return { skip: 'ai_processing_disabled' };
      const r = await trx('follow_up_responses').where({ follow_up_id: followUpId }).first();
      if (!r) return { skip: 'no_response' };
      return { f, r };
    });
    if (!input) return { outcome: 'not_found' };
    if (input.skip) return { outcome: input.skip };
    const { f, r } = input;
    const facts = [
      { id: r.id, text: `Overall, the patient feels ${OVERALL_TEXT[r.overall]}.` },
      ...r.red_flags.map((code) => ({
        id: r.id,
        text: `The patient reported this warning sign: ${FOLLOW_UP_RED_FLAGS[code] ?? code}.`,
      })),
    ];
    const note = r.note_enc
      ? envelope.decryptJson(r.note_enc, noteAad(r.id, r.patient_id)).note
      : '';
    if (note) facts.push({ id: r.id, text: `Patient's note: ${note}`.slice(0, 1000) });
    facts.push({ id: r.id, text: `The check-in was due on ${f.due_on}.` });
    const result = await aiClient.summarizeFollowUp(
      {
        patientId: f.patient_id,
        followUpId: f.id,
        doctorUserId: f.doctor_user_id,
        facts,
      },
      { requestId },
    );
    domainMetrics.aiAssistRequests.inc({ kind: 'follow_up_summary', status: result.status });
    return { outcome: 'summarized', status: result.status };
  }

  async function handleEvent(event) {
    if (event.eventType === 'consultation.completed') return createFromOutcome(event);
    if (event.eventType === 'follow_up.responded') {
      return summarize(event.payload.followUpId, { requestId: event.requestId });
    }
    return { outcome: 'ignored' };
  }

  return {
    create,
    listForDoctor,
    get,
    close,
    listForPatient,
    respond,
    createFromOutcome,
    sweep,
    summarize,
    handleEvent,
  };
}
