# ADR-0036: AI safeguards: spend ceiling, deferred analysis and answers from the record (step 10)

- **Status:** Accepted (implemented)
- **Date:** 2026-10-15
- **Builds on:**
  - ADR-0004: AI proposes, backend validates and commits;
  - ADR-0008: LLM use and PHI policy;
  - ADR-0012: AI execution records;
  - ADR-0022: document intelligence;
  - ADR-0029: agentic care assistant.

## Context

A review of the AI features found three gaps:

1. **No platform-wide spend limit.** Per-user rate budgets, message, turn and tool-loop
   limits, timeouts and `max_tokens` bound a single person or call. Nothing bounded total
   model spend per day once an external provider is enabled: many users, a retry storm or
   a bug could run up cost without limit.
2. **Transient failures were stored as verdicts.** An outage, a rate limit or a timeout
   during document extraction stored a `failed` extraction. Because extraction is
   idempotent per content and prompt version, the stored failure was reused, and the
   document was never analysed again.
3. **"My appointments" and "my medicines" only linked to pages.** The assistant could
   not show the person's own upcoming appointments or current medicines, although the
   backend already serves both, with access checks.

## Decision

### 1. A daily ceiling on estimated model spend (AI service)

- `LLM_DAILY_BUDGET_USD` caps estimated spend per UTC day across all AI-service
  replicas.
  - It is **required whenever the provider is external**, in every environment.
  - Every configured model must have a price in `app/llm/pricing.py`; otherwise the
    service refuses to start, because the ceiling could not be enforced.
  - Compose and ECS default it to 20; the generated development `.env` uses 5.
- **Enforcement:**
  - Before each call, the instrumented provider checks the day's total and refuses at
    the ceiling with `budget_exhausted`, a retryable kind. The model is not called.
  - The total comes from `ai.spend_since()`, a SECURITY DEFINER function that returns
    one number: the AI role's RLS cannot see other patients' runs. It is refreshed at
    most every 30 s, and the replica's own spend since then is added locally.
  - It is a soft ceiling: calls already in flight finish.
- **When the ceiling is reached:** every workflow already treats an LLM error as "AI
  unavailable".
  - The assistant answers with its fallback (My Doctors, page links); its emergency
    guidance never depends on the model.
  - Briefs and record questions show their unavailable message.
  - Document analysis is deferred (see 2).
- **Signals:** `ai_llm_budget_exhausted_total{workflow}`, `ai_llm_spend_today_usd`,
  and the `LlmDailyBudgetReached` alert.

### 2. Passing failures are deferred, not stored

- In document extraction, a retryable LLM error (outage, timeout, rate limit, ceiling)
  is not recorded. The analyse endpoint answers `503 ai_unavailable` and stores neither
  the run nor the extraction.
- The backend's `document.available` job then retries with exponential backoff, and a
  dead-lettered job can be retried from Admin → Operations.
- Non-retryable failures (invalid output, refusal) are still stored as `failed`, as
  before: they are verdicts about that content and prompt version.
- Interactive features (briefs, record questions, the assistant) already let the person
  try again, and keep their current behaviour.

### 3. Answers from the record, shown by the backend

- For `view_appointments`, `reschedule` and `cancel`, the assistant reply carries up to
  three of the session patient's **upcoming appointments**: doctor, time, mode and status.
  Each has a link to its appointment page, where the existing reschedule and cancel flows
  ask for confirmation.
- For `view_medications`, it carries the medicines of up to two **signed prescriptions
  from the last 90 days**: each line exactly as signed, plus "ask your doctor before
  changing or stopping a medicine".
- **The AI only chooses the intent.** After the AI step, the backend reads the facts
  through `appointmentService.listForPatient` and `prescriptionService.listForPatient`,
  with the same permission, relationship and RLS checks as the pages.
  - Nothing is sent to the AI service.
  - Nothing is stored with the session: the state has no place for it, and replies are
    not persisted.
  - The audit row records only the card count.
- **Labelling:** the cards are typed `appointment` and `medication` with
  `source: 'record'`. The page labels them "From your records", apart from the reply's
  "AI suggestion" badge.
- There is no new tool and no write path. The five assistant tools stay as approved.
  Record *questions* (free text about documents and results) stay on the Health Records
  page.

## Consequences

- External AI cost has a hard daily bound that operators can see and tune, and the
  service refuses to start with an external provider until that bound is set.
- An AI outage no longer leaves documents permanently unanalysed. A long outage ends
  in dead letters, which are visible and retryable.
- Patients see their own appointments and medicines in the conversation without any
  clinical data reaching a model.
- The ceiling is an estimate: prices are list prices as of `PRICING_AS_OF`, and spend is
  attributed when a run is recorded. Calls in flight at the moment of the ceiling still
  complete.

## Alternatives considered

- **Per-user or per-workflow ceilings only:** they don't bound the total, and per-user
  rate limits already exist.
- **Counting tokens in Redis:** another moving part. The run records already carry the
  estimate.
- **Letting the model read the appointments or prescriptions (a sixth tool):** it would
  send clinical data to an external provider for no benefit. The facts need no model to
  be displayed.
