import { appendOutboxEvent } from '../../core/events/outbox.js';

/**
 * Records, inside the transaction of the change, that a doctor's or a clinic's practice
 * changed in a way that can make future bookings ineligible (clinic closed, membership
 * ended, doctor suspended, account disabled). The appointments worker then withdraws the
 * affected bookings (appointmentService.withdrawIneligible). Identifiers only.
 * @param {import('knex').Knex.Transaction} trx
 * @param {{ doctorId?: string, clinicId?: string, userId?: string, cause: string }} change
 */
export function recordPracticeChange(trx, { doctorId, clinicId, userId, cause }, req) {
  const [aggregateType, aggregateId] = doctorId
    ? ['doctor', doctorId]
    : clinicId
      ? ['clinic', clinicId]
      : ['user', userId];
  return appendOutboxEvent(trx, {
    aggregateType,
    aggregateId,
    eventType: 'practice.changed',
    requestId: req?.id ?? null,
    payload: {
      ...(doctorId ? { doctorId } : {}),
      ...(clinicId ? { clinicId } : {}),
      ...(userId ? { userId } : {}),
      cause,
    },
  });
}
