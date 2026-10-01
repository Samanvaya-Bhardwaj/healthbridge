import { newId } from '../db/ids.js';

/**
 * Transactional outbox writer (ADR-0005). Call inside the same transaction as the domain
 * change, so the event exists if and only if the change committed. Payloads carry
 * identifiers and non-sensitive attributes only — never clinical content.
 *
 * The relay (outbox → BullMQ, `FOR UPDATE SKIP LOCKED`) is added with the first consumer.
 *
 * @param {import('knex').Knex.Transaction} trx
 * @param {{ aggregateType: string, aggregateId: string, eventType: string, payload?: Record<string, unknown>, requestId?: string|null }} event
 */
export async function appendOutboxEvent(
  trx,
  { aggregateType, aggregateId, eventType, payload = {}, requestId = null },
) {
  await trx('outbox_events').insert({
    id: newId(),
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    event_type: eventType,
    payload,
    request_id: requestId,
  });
}
