# ADR-0003: Knex with explicit SQL migrations; the backend is the sole migration authority

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

The schema relies on PostgreSQL features that ORMs handle poorly: exclusion constraints,
RLS policies, `vector` columns, partial indexes and partitioning. Two services (Node and
Python) read the same database.

## Decision

- Use **Knex** for migrations and as a parameterised query builder. There is no ORM, and
  we do not build a generic abstraction over PostgreSQL features.
- Migrations live in `backend/migrations/`, are version-controlled and are explicit. Each
  one has an `up` and a `down`, and each runs in a transaction.
- The backend is the **only** migration authority, including for the `ai` schema. The AI
  service never alters the schema.
- Migrations run as the schema-owner role in a one-shot `migrate` container. Running
  services connect as least-privilege roles that cannot run DDL (ADR-0006).
- CI applies the migrations, rolls them back and re-applies them, so `down` is proven
  reversible.

## Consequences

- SQL stays visible and reviewable, and Postgres features are first-class.
- More hand-written SQL than with an ORM. Repositories keep it contained per module.
- Raw SQL must use bindings. Identifiers that cannot be bound (role names in DDL) are
  validated against a strict pattern.

## Alternatives considered

- **Prisma:** weak support for pgvector, RLS and exclusion constraints.
- **Sequelize:** heavy implicit behaviour.
- **Alembic for the AI schema:** would create a second migration authority.
