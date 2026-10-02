import {
  BOOKING_HORIZON_DAYS,
  BOOKING_LEAD_MINUTES,
  PAYMENT_HOLD_MINUTES,
  PERMISSIONS,
} from '@healthbridge/shared';
import { DateTime } from 'luxon';
import { isUuid, newId } from '../../core/db/ids.js';
import { withActor } from '../../core/db/actorContext.js';
import { appendOutboxEvent } from '../../core/events/outbox.js';
import { ConflictError, NotFoundError } from '../../core/http/errors.js';
import { appointmentTransition, initialStatus } from './domain/appointmentStateMachine.js';
import { findSlot } from './domain/slots.js';
import { toAppointmentView } from './repository.js';

const DATA = 'data_access';
const PG_EXCLUSION_VIOLATION = '23P01';
const PG_UNIQUE_VIOLATION = '23505';

const PARTY = { patient_party: 'patient', doctor_party: 'doctor', clinic_scheduler: 'clinic' };
const isBookableDoctor = (d) =>
  d && d.verification_status === 'verified' && d.profile_status === 'active';

/**
 * Booking and the appointment lifecycle (ADR-0019).
 *
 * Every read and change runs in an actor (RLS) transaction and goes through AccessPolicy.
 * The reason for visit (appointment_intakes) is returned only to the patient side and the
 * doctor; clinic schedulers see a booking reference, never patient identity or reason.
 * Each change writes an audit row and an outbox event in the same transaction.
 */
export function createAppointmentService({
  knex,
  appointments,
  availability,
  care,
  patients,
  doctors,
  accessPolicy,
  audit,
  logger,
  now = () => new Date(),
}) {
  const patientResource = (patientId) => ({ type: 'patient', id: patientId, patientId });
  const appointmentResource = (row, id) => ({
    type: 'appointment',
    id,
    relPatientId: row?.patient_id,
    doctorUserId: row?.doctor_user_id,
    clinicId: row?.clinic_id ?? undefined,
  });

  function mapConstraintError(err) {
    if (err.code === PG_EXCLUSION_VIOLATION) {
      return err.constraint === 'appointments_no_patient_overlap'
        ? new ConflictError(
            'You already have an appointment at this time.',
            'patient_double_booked',
          )
        : new ConflictError(
            'This slot was just taken. Please choose another time.',
            'slot_unavailable',
          );
    }
    return err;
  }

  async function emit(trx, row, eventType, req, extra = {}) {
    await appendOutboxEvent(trx, {
      aggregateType: 'appointment',
      aggregateId: row.id,
      eventType,
      requestId: req?.id ?? null,
      payload: {
        patientId: row.patient_id,
        doctorId: row.doctor_id,
        clinicId: row.clinic_id,
        status: row.status,
        startsAt: row.starts_at,
        ...extra,
      },
    });
  }

  /** Creates a booking inside an existing actor transaction (shared by book and reschedule). */
  async function createBooking(
    trx,
    principal,
    { patientId, doctorId, startsAt, mode, clinicId, reason, idempotencyKey, rescheduledFromId },
    req,
  ) {
    const doctor = await doctors.findById(doctorId, trx);
    if (!isBookableDoctor(doctor)) throw new NotFoundError('Verified doctor not found.');

    // Continuity first: bookings are made with a doctor in the patient's care team.
    const relationship = await care.findOpen(trx, patientId, doctorId);
    if (!relationship || relationship.status !== 'active') {
      throw new ConflictError(
        'Add this doctor to your care team before booking.',
        'care_relationship_required',
      );
    }

    // Stale payment holds stop blocking slots before we compute and insert.
    for (const expiredId of await appointments.expireStaleHolds(trx, doctor.id)) {
      await appendOutboxEvent(trx, {
        aggregateType: 'appointment',
        aggregateId: expiredId,
        eventType: 'appointment.expired',
        requestId: req?.id ?? null,
      });
    }

    const start = DateTime.fromISO(startsAt);
    // Sequential: a transaction is a single connection (pg rejects concurrent queries).
    const rules = await availability.activeRules(doctor.id, trx);
    const exceptions = await availability.timeOff(
      doctor.id,
      { from: start.minus({ days: 1 }).toJSDate(), to: start.plus({ days: 1 }).toJSDate() },
      trx,
    );
    // Busy time is not passed: the database EXCLUDE constraint is the single authority.
    const slot = findSlot(
      {
        rules,
        exceptions,
        busy: [],
        now: now(),
        leadMinutes: BOOKING_LEAD_MINUTES,
        horizonDays: BOOKING_HORIZON_DAYS,
      },
      { startsAt, mode, clinicId },
    );
    if (!slot)
      throw new ConflictError(
        'That time is not an available slot for this doctor.',
        'slot_not_offered',
      );

    const status = initialStatus(slot.feePaise);
    const id = newId();
    const row = {
      id,
      patient_id: patientId,
      doctor_id: doctor.id,
      clinic_id: slot.clinicId,
      availability_rule_id: slot.ruleId,
      care_relationship_id: relationship.id,
      mode,
      status,
      starts_at: slot.startsAt,
      ends_at: slot.endsAt,
      fee_paise: slot.feePaise,
      hold_expires_at:
        status === 'pending_payment'
          ? new Date(now().getTime() + PAYMENT_HOLD_MINUTES * 60_000)
          : null,
      booked_by_user_id: principal.userId,
      idempotency_key: idempotencyKey ?? null,
      rescheduled_from_id: rescheduledFromId ?? null,
      confirmed_at: status === 'confirmed' ? now() : null,
    };
    await appointments.insert(trx, row);
    await appointments.insertIntake(trx, { appointment_id: id, reason });
    await audit.record(
      {
        category: DATA,
        action: rescheduledFromId ? 'appointment.reschedule' : 'appointment.book',
        outcome: 'success',
        resourceType: 'appointment',
        resourceId: id,
        patientId,
        metadata: {
          doctorId,
          mode,
          status,
          clinicId: slot.clinicId,
          ...(rescheduledFromId ? { rescheduledFromId } : {}),
        },
      },
      { req, trx },
    );
    await emit(trx, row, 'appointment.booked', req, rescheduledFromId ? { rescheduledFromId } : {});
    return id;
  }

  async function book(principal, input, { idempotencyKey } = {}, req) {
    try {
      return await withActor(knex, principal.userId, async (trx) => {
        await accessPolicy.enforce({
          principal,
          permission: PERMISSIONS.APPOINTMENTS_CREATE,
          resource: patientResource(input.patientId),
          req,
          trx,
        });
        if (idempotencyKey) {
          const existing = await appointments.findByIdempotencyKey(
            trx,
            principal.userId,
            idempotencyKey,
          );
          if (existing) {
            const same =
              existing.doctor_id === input.doctorId &&
              existing.patient_id === input.patientId &&
              new Date(existing.starts_at).getTime() === new Date(input.startsAt).getTime();
            if (!same)
              throw new ConflictError(
                'This idempotency key was used for a different booking.',
                'idempotency_conflict',
              );
            return { appointment: toAppointmentView(existing), replayed: true };
          }
        }
        const id = await createBooking(trx, principal, { ...input, idempotencyKey }, req);
        return {
          appointment: toAppointmentView(await appointments.findById(trx, id), {
            reason: input.reason,
          }),
          replayed: false,
        };
      });
    } catch (err) {
      if (err.code === PG_UNIQUE_VIOLATION && idempotencyKey) {
        // A concurrent retry with the same key won the race: return its result.
        return withActor(knex, principal.userId, async (trx) => {
          const existing = await appointments.findByIdempotencyKey(
            trx,
            principal.userId,
            idempotencyKey,
          );
          if (!existing) throw err;
          return { appointment: toAppointmentView(existing), replayed: true };
        });
      }
      throw mapConstraintError(err);
    }
  }

  async function authorizeAppointment(trx, principal, id, permission, req) {
    if (!isUuid(id)) throw new NotFoundError();
    const row = await appointments.findForUpdate(trx, id);
    const decision = await accessPolicy.enforce({
      principal,
      permission,
      resource: appointmentResource(row, id),
      req,
      trx,
    });
    return { row, party: PARTY[decision.relationship] };
  }

  async function get(principal, id, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { party } = await authorizeAppointment(
        trx,
        principal,
        id,
        PERMISSIONS.APPOINTMENTS_READ,
        req,
      );
      const row = await appointments.findById(trx, id);
      // Payment status only (no amounts or provider data) for every party (ADR-0020).
      const paymentStatus = row.fee_paise > 0 ? await appointments.paymentStatus(trx, id) : null;
      if (party === 'clinic') return toAppointmentView(row, { paymentStatus });
      const reason = await appointments.intakeReason(trx, id);
      if (party === 'doctor') {
        await audit.record(
          {
            category: DATA,
            action: 'appointment.read',
            outcome: 'success',
            resourceType: 'appointment',
            resourceId: id,
            patientId: row.patient_id,
            reason: 'doctor_party',
            metadata: { fields: ['reason'] },
          },
          { req, trx },
        );
      }
      return toAppointmentView(row, { reason, paymentStatus });
    });
  }

  /** cancel | check_in | complete | no_show */
  async function act(principal, id, action, body = {}, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { row, party } = await authorizeAppointment(
        trx,
        principal,
        id,
        PERMISSIONS.APPOINTMENTS_MANAGE,
        req,
      );
      const at = now();
      const next = appointmentTransition(row, action, party, at);
      const patch = { status: next };
      if (action === 'cancel') {
        Object.assign(patch, {
          cancelled_at: at,
          cancelled_by_user_id: principal.userId,
          cancelled_by_party: party,
          cancel_reason: body.reasonCode ?? (party === 'patient' ? 'patient_request' : 'other'),
        });
      }
      if (action === 'check_in') patch.checked_in_at = at;
      if (action === 'complete') patch.completed_at = at;
      await appointments.update(trx, id, patch);
      const updated = { ...row, ...patch };
      await audit.record(
        {
          category: DATA,
          action: `appointment.${action}`,
          outcome: 'success',
          resourceType: 'appointment',
          resourceId: id,
          patientId: row.patient_id,
          metadata: {
            from: row.status,
            to: next,
            party,
            ...(patch.cancel_reason ? { cancelReason: patch.cancel_reason } : {}),
          },
        },
        { req, trx },
      );
      await emit(trx, updated, `appointment.${next === 'checked_in' ? 'checked_in' : next}`, req, {
        party,
      });
      return toAppointmentView(await appointments.findById(trx, id));
    });
  }

  /** Atomically cancels the old appointment and books the new slot (same doctor, mode, clinic). */
  async function reschedule(principal, id, { startsAt }, req) {
    try {
      return await withActor(knex, principal.userId, async (trx) => {
        const { row, party } = await authorizeAppointment(
          trx,
          principal,
          id,
          PERMISSIONS.APPOINTMENTS_MANAGE,
          req,
        );
        appointmentTransition(row, 'reschedule', party, now());
        const reason = await appointments.intakeReason(trx, id);
        await appointments.update(trx, id, {
          status: 'cancelled',
          cancelled_at: now(),
          cancelled_by_user_id: principal.userId,
          cancelled_by_party: 'patient',
          cancel_reason: 'rescheduled',
        });
        await emit(trx, { ...row, status: 'cancelled' }, 'appointment.cancelled', req, {
          reason: 'rescheduled',
        });
        const rebookedId = await createBooking(
          trx,
          principal,
          {
            patientId: row.patient_id,
            doctorId: row.doctor_id,
            startsAt,
            mode: row.mode,
            clinicId: row.clinic_id ?? undefined,
            reason: reason ?? 'Rescheduled appointment',
            rescheduledFromId: id,
          },
          req,
        );
        return toAppointmentView(await appointments.findById(trx, rebookedId), { reason });
      });
    } catch (err) {
      throw mapConstraintError(err);
    }
  }

  async function listForPatient(principal, { patientId, scope }, req) {
    return withActor(knex, principal.userId, async (trx) => {
      let id = patientId;
      if (!id) {
        const own = await patients.findByUserId(trx, principal.userId);
        if (!own) throw new NotFoundError('Create your patient profile first.');
        id = own.id;
      }
      if (!isUuid(id)) throw new NotFoundError();
      await accessPolicy.enforce({
        principal,
        permission: PERMISSIONS.APPOINTMENTS_READ,
        resource: patientResource(id),
        req,
        trx,
      });
      const rows = await appointments.forPatient(trx, id, { scope });
      const views = [];
      for (const row of rows) {
        const paymentStatus =
          row.fee_paise > 0 ? await appointments.paymentStatus(trx, row.id) : null;
        views.push(toAppointmentView(row, { paymentStatus }));
      }
      return views;
    });
  }

  /**
   * The doctor's schedule. Patient identity is resolved per patient through AccessPolicy
   * (treating-doctor relationship + consent basis); if that is denied the entry shows
   * only its booking reference.
   */
  async function listForDoctor(principal, { from, to }, req) {
    const doctor = await doctors.findByUserId(principal.userId);
    if (!doctor) throw new NotFoundError('You have not created a doctor profile yet.');
    return withActor(knex, principal.userId, async (trx) => {
      const rows = await appointments.forDoctor(trx, doctor.id, { from, to });
      const identities = new Map();
      for (const patientId of new Set(rows.map((r) => r.patient_id))) {
        try {
          await accessPolicy.enforce({
            principal,
            permission: PERMISSIONS.PATIENTS_READ,
            resource: patientResource(patientId),
            req,
            trx,
          });
          const p = await patients.findById(trx, patientId);
          identities.set(
            patientId,
            p ? { id: p.id, fullName: p.full_name, dateOfBirth: p.date_of_birth } : null,
          );
        } catch (err) {
          logger?.info(
            { patientId, code: err.code },
            'patient identity not available for schedule entry',
          );
          identities.set(patientId, null);
        }
      }
      return rows.map((row) => toAppointmentView(row, { patient: identities.get(row.patient_id) }));
    });
  }

  /** Clinic schedule board: times, doctors, statuses and references; no patient identity. */
  async function listForClinic(principal, clinicId, { from, to }, req) {
    await accessPolicy.enforce({
      principal,
      permission: PERMISSIONS.APPOINTMENTS_READ,
      resource: { type: 'clinic', id: clinicId, clinicId },
      req,
    });
    return withActor(knex, principal.userId, async (trx) =>
      (await appointments.forClinic(trx, clinicId, { from, to })).map((row) => {
        const { patientId: _hidden, ...view } = toAppointmentView(row);
        return view;
      }),
    );
  }

  return { book, get, act, reschedule, listForPatient, listForDoctor, listForClinic };
}
