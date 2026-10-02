import { BOOKING_HORIZON_DAYS, BOOKING_LEAD_MINUTES, PERMISSIONS } from '@healthbridge/shared';
import { DateTime } from 'luxon';
import { isUuid, newId } from '../../core/db/ids.js';
import { withActor } from '../../core/db/actorContext.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../core/http/errors.js';
import { generateSlots, rulesOverlap } from './domain/slots.js';
import { toRuleView, toTimeOffView } from './repository.js';

const MAX_SLOT_QUERY_DAYS = 31;
const isBookableDoctor = (d) =>
  d && d.verification_status === 'verified' && d.profile_status === 'active';

/** Doctors manage their own weekly availability and time off; patients read computed slots. */
export function createAvailabilityService({
  knex,
  availability,
  appointments,
  doctors,
  clinics,
  accessPolicy,
  audit,
  now = () => new Date(),
}) {
  async function ownDoctor(principal, trx) {
    const doctor = await doctors.findByUserId(principal.userId, trx);
    if (!doctor) throw new NotFoundError('You have not created a doctor profile yet.');
    await accessPolicy.enforce({
      principal,
      permission: PERMISSIONS.AVAILABILITY_MANAGE,
      resource: { type: 'doctor_profile', id: doctor.id, ownerUserId: doctor.user_id },
    });
    if (!isBookableDoctor(doctor)) {
      throw new ForbiddenError(
        'Only verified doctors can publish availability.',
        'doctor_not_verified',
      );
    }
    return doctor;
  }

  async function listRules(principal) {
    const doctor = await ownDoctor(principal);
    return (await availability.activeRules(doctor.id)).map(toRuleView);
  }

  async function createRule(principal, input, req) {
    return knex.transaction(async (trx) => {
      const doctor = await ownDoctor(principal, trx);
      if (!DateTime.local().setZone(input.timezone).isValid) {
        throw new BadRequestError('Unknown timezone.', 'invalid_timezone');
      }
      if (
        input.clinicId &&
        !(await clinics.isActiveDoctorMember(input.clinicId, principal.userId, trx))
      ) {
        throw new BadRequestError(
          'You are not an active member of that clinic.',
          'doctor_not_at_clinic',
        );
      }
      const row = {
        id: newId(),
        doctor_id: doctor.id,
        clinic_id: input.clinicId ?? null,
        mode: input.mode,
        weekday: input.weekday,
        start_time: input.startTime,
        end_time: input.endTime,
        slot_minutes: input.slotMinutes,
        timezone: input.timezone,
        valid_from: input.validFrom,
        valid_until: input.validUntil ?? null,
        fee_paise: input.feePaise,
        created_by_user_id: principal.userId,
      };
      // A doctor cannot be in two places at once: rules may not overlap in time.
      const clash = (await availability.activeRules(doctor.id, trx)).find((existing) =>
        rulesOverlap(existing, row),
      );
      if (clash)
        throw new ConflictError(
          'This overlaps another availability window.',
          'availability_overlap',
        );
      await availability.insertRule(row, trx);
      await audit.record(
        {
          category: 'account',
          action: 'availability.rule_create',
          outcome: 'success',
          resourceType: 'availability_rule',
          resourceId: row.id,
          metadata: { mode: row.mode, weekday: row.weekday, clinicId: row.clinic_id },
        },
        { req, trx },
      );
      return toRuleView(await availability.findRule(row.id, trx));
    });
  }

  /** Archiving a rule stops new bookings; existing appointments are unaffected. */
  async function archiveRule(principal, ruleId, req) {
    if (!isUuid(ruleId)) throw new NotFoundError();
    return knex.transaction(async (trx) => {
      const doctor = await ownDoctor(principal, trx);
      const rule = await availability.findRule(ruleId, trx);
      if (!rule || rule.doctor_id !== doctor.id || rule.status !== 'active')
        throw new NotFoundError();
      await availability.archiveRule(ruleId, trx);
      await audit.record(
        {
          category: 'account',
          action: 'availability.rule_archive',
          outcome: 'success',
          resourceType: 'availability_rule',
          resourceId: ruleId,
        },
        { req, trx },
      );
    });
  }

  async function listTimeOff(principal) {
    const doctor = await ownDoctor(principal);
    return (await availability.timeOff(doctor.id, { from: now() })).map(toTimeOffView);
  }

  /** Time off blocks new bookings; it reports (but does not cancel) clashing appointments. */
  async function addTimeOff(principal, input, req) {
    const doctor = await ownDoctor(principal);
    return withActor(knex, principal.userId, async (trx) => {
      const id = newId();
      await availability.insertTimeOff(
        {
          id,
          doctor_id: doctor.id,
          starts_at: input.startsAt,
          ends_at: input.endsAt,
          reason_code: input.reasonCode,
          created_by_user_id: principal.userId,
        },
        trx,
      );
      const clashes = await appointments.busyRanges(trx, doctor.id, input.startsAt, input.endsAt);
      await audit.record(
        {
          category: 'account',
          action: 'availability.time_off_add',
          outcome: 'success',
          resourceType: 'availability_exception',
          resourceId: id,
          metadata: { reasonCode: input.reasonCode, clashingAppointments: clashes.length },
        },
        { req, trx },
      );
      return {
        ...toTimeOffView(await availability.findTimeOff(id, trx)),
        clashingAppointments: clashes.length,
      };
    });
  }

  async function removeTimeOff(principal, id, req) {
    if (!isUuid(id)) throw new NotFoundError();
    return knex.transaction(async (trx) => {
      const doctor = await ownDoctor(principal, trx);
      const entry = await availability.findTimeOff(id, trx);
      if (!entry || entry.doctor_id !== doctor.id) throw new NotFoundError();
      await availability.removeTimeOff(id, trx);
      await audit.record(
        {
          category: 'account',
          action: 'availability.time_off_remove',
          outcome: 'success',
          resourceType: 'availability_exception',
          resourceId: id,
        },
        { req, trx },
      );
    });
  }

  /** Bookable slots for a verified doctor (any authenticated user with doctors:read). */
  async function slots(principal, doctorId, { from, to, mode, clinicId }) {
    if (!isUuid(doctorId)) throw new NotFoundError();
    const doctor = await doctors.findById(doctorId);
    if (!isBookableDoctor(doctor)) throw new NotFoundError();
    const span = DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days;
    if (span < 0 || span > MAX_SLOT_QUERY_DAYS) {
      throw new BadRequestError(
        `Query at most ${MAX_SLOT_QUERY_DAYS} days.`,
        'slot_range_too_large',
      );
    }
    return withActor(knex, principal.userId, async (trx) => {
      const rangeStart = DateTime.fromISO(from).minus({ days: 1 }).toJSDate();
      const rangeEnd = DateTime.fromISO(to).plus({ days: 2 }).toJSDate();
      // Sequential: a transaction is a single connection (pg rejects concurrent queries).
      const rules = await availability.activeRules(doctor.id, trx);
      const exceptions = await availability.timeOff(
        doctor.id,
        { from: rangeStart, to: rangeEnd },
        trx,
      );
      const busy = await appointments.busyRanges(trx, doctor.id, rangeStart, rangeEnd);
      return generateSlots({
        rules,
        exceptions,
        busy,
        from,
        to,
        now: now(),
        leadMinutes: BOOKING_LEAD_MINUTES,
        horizonDays: BOOKING_HORIZON_DAYS,
        mode,
        clinicId,
      });
    });
  }

  return { listRules, createRule, archiveRule, listTimeOff, addTimeOff, removeTimeOff, slots };
}
