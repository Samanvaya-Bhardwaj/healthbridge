# ADR-0001: Modular monolith plus an independent AI service

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

HealthBridge needs strong transactional consistency across bookings, payments, consent,
prescriptions and records. The team is small. AI workloads (OCR, embeddings, LLM
orchestration) have different runtime, scaling and dependency profiles, and they belong
to the Python ecosystem.

## Decision

- The core platform is a **modular monolith**: one Node.js/Express codebase with strict
  module boundaries. It runs as API processes and BullMQ worker processes built from the
  same image.
- AI runs as a **separate, private FastAPI service**. It is reachable only from the backend
  on a private network, authenticated with short-lived service tokens, and never exposed
  through the public edge.
- Modules talk to each other only through service interfaces or domain events. A module
  never imports another module's repository.

## Consequences

- One deployable unit and one transaction scope for core workflows. Debugging and
  operations stay simple.
- Module boundaries let us extract a module later (e.g. notifications) if load justifies it.
- AI outages degrade AI features only. Readiness reports the AI service as non-critical,
  and booking, consultations and prescriptions keep working.
- Two languages to maintain. This is accepted because the ML ecosystem is Python-native.

## Alternatives considered

- **Microservices from day one:** rejected. It adds distributed-transaction and operational
  cost with no MVP benefit.
- **AI inside the Node process:** rejected. The ML ecosystem is weaker, and a hung model
  call would affect the core API.
