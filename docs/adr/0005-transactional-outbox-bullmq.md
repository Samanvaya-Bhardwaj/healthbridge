# ADR-0005: Transactional outbox with BullMQ and idempotent consumers

- **Status:** Accepted (implementation starts in M1/M4)
- **Date:** 2026-10-01

## Context

Business transactions trigger side effects such as notifications, timeline updates, AI
briefs and reminders. Writing to the database and then enqueuing to Redis are two
separate writes. If Redis fails after the commit, the event is lost.

## Decision

- In the **same database transaction** as the domain change, insert a row into
  `outbox_events` (aggregate, type, payload, created_at).
- An outbox relay worker polls unpublished events with `FOR UPDATE SKIP LOCKED`, enqueues
  them to BullMQ, then marks them published. Delivery is at-least-once.
- Every consumer is **idempotent**. Each one is keyed by event ID (or entity plus version)
  and records what it has processed, so a duplicate delivery has no additional effect.
- Jobs use exponential backoff and a dead-letter queue, and are visible in an admin-only
  dashboard.
- Redis runs with `maxmemory-policy noeviction` and AOF persistence, so queued jobs are
  never evicted.

## Consequences

- A Redis outage delays side effects but never loses them.
- Consumers must be written to tolerate duplicates and out-of-order delivery.
- Small extra latency from polling, which is acceptable for these workloads.
