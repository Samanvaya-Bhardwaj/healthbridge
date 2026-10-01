import { assertActorTransaction } from '../../core/db/actorContext.js';

const toIsoDate = (value) =>
  value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : value;

export function toRuleView(row) {
  return {
    id: row.id,
    doctorId: row.doctor_id,
    clinicId: row.clinic_id,
    mode: row.mode,
    weekday: row.weekday,
    startTime: row.start_time.slice(0, 5),
    endTime: row.end_time.slice(0, 5),
    slotMinutes: row.slot_minutes,
    timezone: row.timezone,
    validFrom: toIsoDate(row.valid_from),
    validUntil: row.valid_until ? toIsoDate(row.valid_until) : null,
    feePaise: row.fee_paise,
    status: row.status,
  };
}

export function toTimeOffView(row) {
  return { id: row.id, startsAt: row.starts_at, endsAt: row.ends_at, reasonCode: row.reason_code };
}

/**
 * @param {object} row appointment row (optionally joined with doctor/clinic names)
 * @param {{ reason?: string|null, patient?: object|null }} [extra]
 */
export function toAppointmentView(row, extra = {}) {
  return {
    id: row.id,
    reference: row.id.slice(-8).toUpperCase(),
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    clinicId: row.clinic_id,
    mode: row.mode,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    feePaise: row.fee_paise,
    currency: row.currency?.trim(),
    holdExpiresAt: row.status === 'pending_payment' ? row.hold_expires_at : null,
    rescheduledFromId: row.rescheduled_from_id,
    checkedInAt: row.checked_in_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    cancelledByParty: row.cancelled_by_party,
    cancelReason: row.cancel_reason,
    ...(row.doctor_name
      ? {
          doctor: {
            id: row.doctor_id,
            professionalName: row.doctor_name,
            primarySpecialization: row.doctor_specialization,
          },
        }
      : {}),
    ...(row.clinic_name ? { clinic: { id: row.clinic_id, name: row.clinic_name } } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra.patient !== undefined ? { patient: extra.patient } : {}),
  };
}

/** Availability is professional (not patient-scoped) data. */
export function createAvailabilityRepository({ knex }) {
  const db = (trx) => trx ?? knex;
  return {
    activeRules(doctorId, trx) {
      return db(trx)('availability_rules')
        .where({ doctor_id: doctorId, status: 'active' })
        .orderBy(['weekday', 'start_time']);
    },
    findRule(id, trx) {
      return db(trx)('availability_rules').where({ id }).first();
    },
    async insertRule(row, trx) {
      await db(trx)('availability_rules').insert(row);
    },
    async archiveRule(id, trx) {
      await db(trx)('availability_rules').where({ id }).update({ status: 'archived' });
    },
    timeOff(doctorId, { from, to } = {}, trx) {
      const q = db(trx)('availability_exceptions')
        .where({ doctor_id: doctorId })
        .whereNull('removed_at')
        .orderBy('starts_at');
      if (from) q.where('ends_at', '>', from);
      if (to) q.where('starts_at', '<', to);
      return q;
    },
    findTimeOff(id, trx) {
      return db(trx)('availability_exceptions').where({ id }).whereNull('removed_at').first();
    },
    async insertTimeOff(row, trx) {
      await db(trx)('availability_exceptions').insert(row);
    },
    async removeTimeOff(id, trx) {
      await db(trx)('availability_exceptions').where({ id }).update({ removed_at: knex.fn.now() });
    },
  };
}

/** Appointments and intakes are patient-scoped: every call needs an actor (RLS) transaction. */
export function createAppointmentRepository() {
  const withNames = (trx) =>
    trx('appointments as a')
      .join('doctors as d', 'd.id', 'a.doctor_id')
      .leftJoin('clinics as c', 'c.id', 'a.clinic_id')
      .select(
        'a.*',
        'd.professional_name as doctor_name',
        'd.primary_specialization as doctor_specialization',
        'd.user_id as doctor_user_id',
        'c.name as clinic_name',
      );

  return {
    async insert(trx, row) {
      assertActorTransaction(trx);
      await trx('appointments').insert(row);
    },
    findById(trx, id) {
      assertActorTransaction(trx);
      return withNames(trx).where('a.id', id).first();
    },
    findForUpdate(trx, id) {
      assertActorTransaction(trx);
      return trx('appointments as a')
        .join('doctors as d', 'd.id', 'a.doctor_id')
        .where('a.id', id)
        .forUpdate('a')
        .first('a.*', 'd.user_id as doctor_user_id');
    },
    findByIdempotencyKey(trx, userId, key) {
      assertActorTransaction(trx);
      return withNames(trx)
        .where({ 'a.booked_by_user_id': userId, 'a.idempotency_key': key })
        .first();
    },
    async update(trx, id, patch) {
      assertActorTransaction(trx);
      return trx('appointments').where({ id }).update(patch);
    },
    forPatient(trx, patientId, { scope = 'upcoming', limit = 50 } = {}) {
      assertActorTransaction(trx);
      const q = withNames(trx).where('a.patient_id', patientId).limit(limit);
      if (scope === 'upcoming') {
        q.where('a.ends_at', '>', trx.fn.now())
          .whereIn('a.status', ['pending_payment', 'confirmed', 'checked_in', 'in_consultation'])
          .orderBy('a.starts_at', 'asc');
      } else {
        q.where((w) =>
          w
            .where('a.ends_at', '<=', trx.fn.now())
            .orWhereIn('a.status', ['cancelled', 'completed', 'no_show', 'expired']),
        ).orderBy('a.starts_at', 'desc');
      }
      return q;
    },
    forDoctor(trx, doctorId, { from, to }) {
      assertActorTransaction(trx);
      return withNames(trx)
        .where('a.doctor_id', doctorId)
        .where('a.starts_at', '>=', from)
        .where('a.starts_at', '<', to)
        .orderBy('a.starts_at')
        .limit(500);
    },
    forClinic(trx, clinicId, { from, to }) {
      assertActorTransaction(trx);
      return withNames(trx)
        .where('a.clinic_id', clinicId)
        .where('a.starts_at', '>=', from)
        .where('a.starts_at', '<', to)
        .orderBy('a.starts_at')
        .limit(500);
    },
    async busyRanges(trx, doctorId, from, to) {
      assertActorTransaction(trx);
      const { rows } = await trx.raw(
        'SELECT starts_at, ends_at FROM authz.doctor_busy_ranges(?, ?, ?)',
        [doctorId, from, to],
      );
      return rows;
    },
    async expireStaleHolds(trx, doctorId) {
      assertActorTransaction(trx);
      const { rows } = await trx.raw('SELECT authz.expire_stale_holds(?) AS id', [doctorId]);
      return rows.map((r) => r.id);
    },
    async insertIntake(trx, row) {
      assertActorTransaction(trx);
      await trx('appointment_intakes').insert(row);
    },
    async intakeReason(trx, appointmentId) {
      assertActorTransaction(trx);
      return (
        (await trx('appointment_intakes').where({ appointment_id: appointmentId }).first('reason'))
          ?.reason ?? null
      );
    },
  };
}
