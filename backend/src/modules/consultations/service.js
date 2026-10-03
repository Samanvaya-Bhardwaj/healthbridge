import {
  EMERGENCY_GUIDANCE,
  PERMISSIONS,
  WAITING_ROOM_OPENS_MINUTES,
  WAITING_ROOM_PRESENCE_SECONDS,
} from '@healthbridge/shared';
import { isUuid, newId } from '../../core/db/ids.js';
import { withActor } from '../../core/db/actorContext.js';
import { appendOutboxEvent } from '../../core/events/outbox.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/http/errors.js';
import { domainMetrics } from '../../core/metrics/domain.js';
import {
  CONSULTATION_LATE_MINUTES,
  appointmentTransition,
} from '../scheduling/domain/appointmentStateMachine.js';
import { authorizeConsultationParty } from './access.js';
import { prescriptionView } from './prescriptions.js';

const DATA = 'data_access';
const noteAad = (noteId, patientId) => `clinical_note:${noteId}:${patientId}`;

/**
 * Consultations (ADR-0025): start, waiting room, video join, SOAP notes and the doctor's
 * outcome. Every change runs in the actor's RLS transaction after AccessPolicy, writes an
 * audit row and — where other modules react — an outbox event in the same transaction.
 *
 * The system never decides an outcome: A/B/C are recorded only by the consulting doctor.
 * Clinical notes are envelope-encrypted before they reach the database; signed notes are
 * immutable and corrected only by a new signed version with a reason (ADR-0009).
 */
export function createConsultationService({
  knex,
  accessPolicy,
  audit,
  envelope,
  video,
  now = () => new Date(),
}) {
  const authorize = (trx, principal, id, permission, req, options) =>
    authorizeConsultationParty({ accessPolicy }, trx, principal, id, permission, req, options);

  const requireDoctor = (party) => {
    if (party !== 'doctor') {
      throw new ForbiddenError('Only the consulting doctor can do this.', 'wrong_party');
    }
  };

  const consultationOf = (trx, appointmentId) =>
    trx('consultations').where({ appointment_id: appointmentId }).first();

  function waitingRoomState(row, presence, at = now()) {
    const opensAt = new Date(row.starts_at.getTime() - WAITING_ROOM_OPENS_MINUTES * 60_000);
    const closesAt = new Date(row.ends_at.getTime() + CONSULTATION_LATE_MINUTES * 60_000);
    const present =
      Boolean(presence) &&
      at.getTime() - new Date(presence.last_seen_at).getTime() <=
        WAITING_ROOM_PRESENCE_SECONDS * 1000;
    return {
      open:
        row.mode === 'online' &&
        ['confirmed', 'in_consultation'].includes(row.status) &&
        at >= opensAt &&
        at < closesAt,
      opensAt,
      patientPresent: present,
      patientArrivedAt: presence?.arrived_at ?? null,
    };
  }

  function consultationView(c) {
    if (!c) return null;
    return {
      id: c.id,
      status: c.status,
      mode: c.mode,
      startedAt: c.started_at,
      endedAt: c.ended_at,
      outcome: c.outcome,
      outcomeDetail: c.outcome_detail ?? {},
      video: c.mode === 'online',
    };
  }

  function noteView(row) {
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      note: envelope.decryptJson(row.content_enc, noteAad(row.id, row.patient_id)),
      signedAt: row.signed_at,
      supersedesId: row.supersedes_id,
      correctionReason: row.correction_reason,
      updatedAt: row.updated_at,
    };
  }

  async function prescriptionsOf(trx, consultationId) {
    const rows = await trx('prescriptions')
      .where({ consultation_id: consultationId })
      .orderBy('version', 'desc');
    const items = rows.length
      ? await trx('prescription_items')
          .whereIn(
            'prescription_id',
            rows.map((r) => r.id),
          )
          .orderBy('position')
      : [];
    return rows.map((r) =>
      prescriptionView(
        r,
        items.filter((i) => i.prescription_id === r.id),
      ),
    );
  }

  /** Lightweight status for polling (waiting room, live state). No clinical content. */
  async function status(principal, appointmentId, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { row, party } = await authorize(
        trx,
        principal,
        appointmentId,
        PERMISSIONS.APPOINTMENTS_READ,
        req,
      );
      const c = await consultationOf(trx, appointmentId);
      const presence = await trx('consultation_presence')
        .where({ appointment_id: appointmentId })
        .first();
      return {
        party,
        appointmentStatus: row.status,
        consultation: c ? { id: c.id, status: c.status, outcome: c.outcome } : null,
        waitingRoom: waitingRoomState(row, presence),
        emergencyGuidance: c?.outcome === 'emergency_escalation' ? EMERGENCY_GUIDANCE : null,
      };
    });
  }

  /** Full view: notes and prescriptions as RLS shows them to this party. */
  async function view(principal, appointmentId, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { row, party } = await authorize(
        trx,
        principal,
        appointmentId,
        PERMISSIONS.APPOINTMENTS_READ,
        req,
      );
      const c = await consultationOf(trx, appointmentId);
      const presence = await trx('consultation_presence')
        .where({ appointment_id: appointmentId })
        .first();
      const notes = c
        ? (
            await trx('clinical_notes').where({ consultation_id: c.id }).orderBy('version', 'desc')
          ).map(noteView)
        : [];
      const prescriptions = c ? await prescriptionsOf(trx, c.id) : [];
      if (c && (notes.length || prescriptions.length)) {
        await audit.record(
          {
            category: DATA,
            action: 'consultation.viewed',
            outcome: 'success',
            resourceType: 'consultation',
            resourceId: c.id,
            patientId: row.patient_id,
            reason: `${party}_party`,
            metadata: { notes: notes.length, prescriptions: prescriptions.length },
          },
          { req, trx },
        );
      }
      return {
        party,
        appointment: {
          id: row.id,
          status: row.status,
          mode: row.mode,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          doctorName: row.doctor_name,
          clinicName: row.clinic_name ?? null,
          patientId: row.patient_id,
          doctorId: row.doctor_id,
        },
        consultation: consultationView(c),
        waitingRoom: waitingRoomState(row, presence),
        notes,
        prescriptions,
        emergencyGuidance: c?.outcome === 'emergency_escalation' ? EMERGENCY_GUIDANCE : null,
      };
    });
  }

  /** Patient side: waiting-room heartbeat (online consultations). */
  async function arrive(principal, appointmentId, req) {
    await withActor(knex, principal.userId, async (trx) => {
      const { row, party } = await authorize(
        trx,
        principal,
        appointmentId,
        PERMISSIONS.APPOINTMENTS_READ,
        req,
      );
      if (party !== 'patient') {
        throw new ForbiddenError('Only the patient side joins the waiting room.', 'wrong_party');
      }
      if (!waitingRoomState(row, null).open) {
        throw new ConflictError(
          `The waiting room opens ${WAITING_ROOM_OPENS_MINUTES} minutes before an online appointment.`,
          'waiting_room_closed',
        );
      }
      const at = now();
      await trx('consultation_presence')
        .insert({
          appointment_id: appointmentId,
          patient_id: row.patient_id,
          doctor_id: row.doctor_id,
          user_id: principal.userId,
          arrived_at: at,
          last_seen_at: at,
        })
        .onConflict('appointment_id')
        .merge({ last_seen_at: at, user_id: principal.userId });
    });
    return status(principal, appointmentId, req);
  }

  /** Doctor: start (idempotent). The appointment moves to IN_CONSULTATION. */
  async function start(principal, appointmentId, req) {
    await withActor(knex, principal.userId, async (trx) => {
      const { row, party } = await authorize(
        trx,
        principal,
        appointmentId,
        PERMISSIONS.CONSULTATIONS_CONDUCT,
        req,
        { lock: true },
      );
      requireDoctor(party);
      const existing = await consultationOf(trx, appointmentId);
      if (existing) {
        if (existing.status === 'live') return;
        throw new ConflictError('This consultation has ended.', 'consultation_ended');
      }
      const at = now();
      appointmentTransition(row, 'start_consultation', 'doctor', at);
      await trx('appointments')
        .where({ id: appointmentId })
        .update({ status: 'in_consultation', updated_at: trx.fn.now() });
      const id = newId();
      await trx('consultations').insert({
        id,
        appointment_id: appointmentId,
        patient_id: row.patient_id,
        doctor_id: row.doctor_id,
        doctor_user_id: principal.userId,
        clinic_id: row.clinic_id,
        mode: row.mode,
        status: 'live',
        video_provider: row.mode === 'online' ? video.name : null,
        video_room_ref: row.mode === 'online' ? video.newRoom() : null,
        started_at: at,
      });
      await audit.record(
        {
          category: DATA,
          action: 'consultation.started',
          outcome: 'success',
          resourceType: 'consultation',
          resourceId: id,
          patientId: row.patient_id,
          metadata: { appointmentId, mode: row.mode },
        },
        { req, trx },
      );
      await appendOutboxEvent(trx, {
        aggregateType: 'appointment',
        aggregateId: appointmentId,
        eventType: 'appointment.in_consultation',
        requestId: req?.id ?? null,
        payload: { patientId: row.patient_id, doctorId: row.doctor_id, consultationId: id },
      });
      domainMetrics.consultations.inc({ event: 'started', mode: row.mode });
    });
    return view(principal, appointmentId, req);
  }

  /** Short-lived video join grant for a live online consultation. */
  async function join(principal, appointmentId, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { row, party } = await authorize(
        trx,
        principal,
        appointmentId,
        PERMISSIONS.APPOINTMENTS_READ,
        req,
      );
      const c = await consultationOf(trx, appointmentId);
      if (!c || c.status !== 'live' || c.mode !== 'online') {
        throw new ConflictError('The consultation is not live.', 'consultation_not_live');
      }
      const grant = await video.joinGrant({
        room: c.video_room_ref,
        identity: `${c.id}:${principal.userId}`,
        displayName: party === 'doctor' ? row.doctor_name : 'Patient',
        role: party,
      });
      await audit.record(
        {
          category: DATA,
          action: 'consultation.joined',
          outcome: 'success',
          resourceType: 'consultation',
          resourceId: c.id,
          patientId: row.patient_id,
          reason: `${party}_party`,
          metadata: { provider: grant.provider },
        },
        { req, trx },
      );
      return grant;
    });
  }

  async function liveConsultationForDoctor(trx, principal, appointmentId, req) {
    const { row, party } = await authorize(
      trx,
      principal,
      appointmentId,
      PERMISSIONS.CONSULTATIONS_CONDUCT,
      req,
      { lock: true },
    );
    requireDoctor(party);
    const c = await consultationOf(trx, appointmentId);
    if (!c) throw new ConflictError('Start the consultation first.', 'consultation_not_started');
    return { row, c };
  }

  /** Doctor: create or update the draft SOAP note (encrypted). */
  async function saveNote(principal, appointmentId, note, req) {
    await withActor(knex, principal.userId, async (trx) => {
      const { row, c } = await liveConsultationForDoctor(trx, principal, appointmentId, req);
      if (c.status !== 'live') {
        throw new ConflictError(
          'The consultation has ended; correct the signed note instead.',
          'consultation_ended',
        );
      }
      const versions = await trx('clinical_notes')
        .where({ consultation_id: c.id })
        .forUpdate()
        .select('id', 'status', 'version');
      if (versions.some((v) => v.status === 'signed')) {
        throw new ConflictError(
          'The note is signed. Use a correction to change it.',
          'note_already_signed',
        );
      }
      const draft = versions.find((v) => v.status === 'draft');
      const id = draft?.id ?? newId();
      const { keyId, blob } = envelope.encryptJson(note, noteAad(id, row.patient_id));
      if (draft) {
        await trx('clinical_notes')
          .where({ id })
          .update({ content_enc: blob, key_id: keyId, updated_at: trx.fn.now() });
      } else {
        await trx('clinical_notes').insert({
          id,
          consultation_id: c.id,
          patient_id: row.patient_id,
          doctor_user_id: principal.userId,
          version: 1,
          status: 'draft',
          content_enc: blob,
          key_id: keyId,
        });
      }
      await audit.record(
        {
          category: DATA,
          action: 'clinical_note.saved',
          outcome: 'success',
          resourceType: 'clinical_note',
          resourceId: id,
          patientId: row.patient_id,
          metadata: { consultationId: c.id },
        },
        { req, trx },
      );
    });
    return view(principal, appointmentId, req);
  }

  /** Doctor: sign the draft note. Signed notes are immutable. */
  async function signNote(principal, appointmentId, req) {
    await withActor(knex, principal.userId, async (trx) => {
      const { row, c } = await liveConsultationForDoctor(trx, principal, appointmentId, req);
      const draft = await trx('clinical_notes')
        .where({ consultation_id: c.id, status: 'draft' })
        .forUpdate()
        .first('id', 'version');
      if (!draft) throw new ConflictError('There is no draft note to sign.', 'no_draft_note');
      await trx('clinical_notes')
        .where({ id: draft.id })
        .update({ status: 'signed', signed_at: now(), updated_at: trx.fn.now() });
      await audit.record(
        {
          category: DATA,
          action: 'clinical_note.signed',
          outcome: 'success',
          resourceType: 'clinical_note',
          resourceId: draft.id,
          patientId: row.patient_id,
          metadata: { consultationId: c.id, version: draft.version },
        },
        { req, trx },
      );
    });
    return view(principal, appointmentId, req);
  }

  /** Doctor (author): correct a signed note → new signed version; the old one is superseded. */
  async function correctNote(principal, noteId, { note, reason }, req) {
    if (!isUuid(noteId)) throw new NotFoundError();
    const appointmentId = await withActor(knex, principal.userId, async (trx) => {
      // Gate 1 first: other roles are refused before any lookup.
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.CONSULTATIONS_CONDUCT,
        req,
        trx,
      });
      // RLS (FOR UPDATE applies the update policy): only the author's own notes.
      const current = await trx('clinical_notes as n')
        .join('consultations as c', 'c.id', 'n.consultation_id')
        .where('n.id', noteId)
        .forUpdate('n')
        .first('n.*', 'c.appointment_id');
      if (!current) throw new NotFoundError();
      await authorize(
        trx,
        principal,
        current.appointment_id,
        PERMISSIONS.CONSULTATIONS_CONDUCT,
        req,
      ).then(({ party }) => requireDoctor(party));
      if (current.doctor_user_id !== principal.userId) {
        throw new ForbiddenError('Only the author can correct a note.', 'not_author');
      }
      if (current.status !== 'signed') {
        throw new ConflictError(
          'Only the current signed note can be corrected.',
          'note_not_current',
        );
      }
      await trx('clinical_notes')
        .where({ id: current.id })
        .update({ status: 'superseded', updated_at: trx.fn.now() });
      const id = newId();
      const { keyId, blob } = envelope.encryptJson(note, noteAad(id, current.patient_id));
      await trx('clinical_notes').insert({
        id,
        consultation_id: current.consultation_id,
        patient_id: current.patient_id,
        doctor_user_id: principal.userId,
        version: current.version + 1,
        status: 'signed',
        content_enc: blob,
        key_id: keyId,
        supersedes_id: current.id,
        correction_reason: reason,
        signed_at: now(),
      });
      await audit.record(
        {
          category: DATA,
          action: 'clinical_note.corrected',
          outcome: 'success',
          resourceType: 'clinical_note',
          resourceId: id,
          patientId: current.patient_id,
          // The reason is clinical free text: kept on the note, not in the audit log.
          metadata: { supersedesId: current.id, version: current.version + 1 },
        },
        { req, trx },
      );
      return current.appointment_id;
    });
    return view(principal, appointmentId, req);
  }

  /**
   * Doctor: record the outcome (once) and end the consultation; the appointment completes.
   *   A online_managed / B physical_visit_required: need a signed note.
   *   C emergency_escalation: recorded immediately (no prerequisites), flagged in the audit
   *     log; the patient sees fixed emergency guidance. The system never escalates by itself.
   * Unsigned prescription drafts are cancelled.
   */
  async function recordOutcome(principal, appointmentId, body, req) {
    await withActor(knex, principal.userId, async (trx) => {
      const { row, c } = await liveConsultationForDoctor(trx, principal, appointmentId, req);
      if (c.status !== 'live') {
        throw new ConflictError('The outcome has already been recorded.', 'consultation_ended');
      }
      if (body.outcome !== 'emergency_escalation') {
        const signed = await trx('clinical_notes')
          .where({ consultation_id: c.id, status: 'signed' })
          .first('id');
        if (!signed) {
          throw new ConflictError('Sign the consultation note first.', 'note_required');
        }
      }
      const at = now();
      appointmentTransition(row, 'finish_consultation', 'doctor', at);
      const detail =
        body.outcome === 'online_managed'
          ? { followUpOn: body.followUpOn ?? null }
          : body.outcome === 'physical_visit_required'
            ? { visitNote: body.visitNote ?? '' }
            : { guidance: 'static_emergency_guidance' };
      const cancelled = await trx('prescriptions')
        .where({ consultation_id: c.id, status: 'draft' })
        .update({ status: 'cancelled', updated_at: trx.fn.now() });
      await trx('consultations')
        .where({ id: c.id })
        .update({
          status: 'ended',
          ended_at: at,
          outcome: body.outcome,
          outcome_detail: JSON.stringify(detail),
          outcome_recorded_at: at,
          updated_at: trx.fn.now(),
        });
      await trx('appointments')
        .where({ id: appointmentId })
        .update({ status: 'completed', completed_at: at, updated_at: trx.fn.now() });
      await audit.record(
        {
          category: DATA,
          action:
            body.outcome === 'emergency_escalation'
              ? 'consultation.emergency_escalated'
              : 'consultation.outcome_recorded',
          outcome: 'success',
          resourceType: 'consultation',
          resourceId: c.id,
          patientId: row.patient_id,
          reason: body.outcome,
          metadata: {
            appointmentId,
            cancelledDrafts: cancelled,
            ...(body.outcome === 'emergency_escalation' ? { flagged: true } : {}),
            ...(detail.followUpOn ? { followUpOn: detail.followUpOn } : {}),
          },
        },
        { req, trx },
      );
      const payload = {
        appointmentId,
        patientId: row.patient_id,
        doctorId: row.doctor_id,
        outcome: body.outcome,
        followUpOn: detail.followUpOn ?? null,
      };
      await appendOutboxEvent(trx, {
        aggregateType: 'consultation',
        aggregateId: c.id,
        eventType: 'consultation.completed',
        requestId: req?.id ?? null,
        payload,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'appointment',
        aggregateId: appointmentId,
        eventType: 'appointment.completed',
        requestId: req?.id ?? null,
        payload: {
          patientId: row.patient_id,
          doctorId: row.doctor_id,
          clinicId: row.clinic_id,
          status: 'completed',
          startsAt: row.starts_at,
          party: 'doctor',
        },
      });
      domainMetrics.consultations.inc({ event: body.outcome, mode: row.mode });
    });
    return view(principal, appointmentId, req);
  }

  return { status, view, arrive, start, join, saveNote, signNote, correctNote, recordOutcome };
}
