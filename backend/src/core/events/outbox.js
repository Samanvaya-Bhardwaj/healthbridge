import { newId } from '../db/ids.js';
import { domainMetrics } from '../metrics/domain.js';

/**
 * Transactional outbox writer (ADR-0005). Call inside the same transaction as the domain
 * change, so the event exists if and only if the change committed. Payloads carry
 * identifiers and non-sensitive attributes only — never clinical content.
 *
 * The relay (core/queue/outboxRelay.js) publishes pending events to BullMQ.
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
  // Counted at write time; a rolled-back transaction may over-count slightly.
  domainMetrics.outboxCreated.inc();
}
