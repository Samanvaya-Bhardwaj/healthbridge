# ADR-0032: Recommendations (M13.3)

- **Status:** Accepted (implemented)
- **Date:** 2026-10-16
- **Builds on:**
  - ADR-0031: doctor search;
  - ADR-0030: one eligibility rule;
  - ADR-0029: agentic care assistant;
  - ADR-0006 and ADR-0017: access control.

## Context

Search answers "which doctors match these criteria". Patients also need "which of them
should I consider first, and what do I do next?" The answer must use only information
HealthBridge may use for that patient, explain itself in facts, and never become medical
advice.

## Decision

1. **`recommendationService.recommend(principal, { patientId, criteria })`** returns at
   most 5 doctors, each with explanations and a next step. Ranking:
   - **Base:** the search's own order, which applies the eligibility rule and the
     requested criteria.
   - **Continuity:** the doctor is in the patient's active care team (+1). The patient
     has completed a visit with the doctor (+1.5). Only the date of the last visit is
     used, never its reason or any clinical content.
   - **Preferences the patient set:** a clinic in the profile's city (+0.75), and the
     profile's preferred language, recognised from a code like "mr-IN" or a name
     (+0.5). These lift doctors but never filter them. A preference the person states in
     the request is a filter instead, and is not counted twice.
   - **Soonest free time:** within 14 days, for the top 6 candidates (up to +0.5, sooner
     is more).
2. **Explanations are facts, with a code and a value:**
   - `seen_before` (date), `care_team`, `near_you` (city), `speaks_your_language`
     (language) and `earliest` (time and mode);
   - the search reasons (`matches_specialty`, `matches_area`, and so on).

   The interface turns them into plain sentences. Nothing is said about the patient's
   health.
3. **Next steps** follow the care relationship:
   - `book` (active, with the soonest time when known);
   - `await_acceptance` (pending or invited);
   - `request_care` (none). Booking still needs an active relationship and goes through
     the booking page.
4. **Access:** patient side only. The service requires AccessPolicy `patients:read`
   **and** the relationship `patient_self` or `guardian_dependent`. A treating doctor
   with consent can read the profile but cannot get recommendations, because these are
   the patient's own choices.
5. **Surfaces:**
   - `GET /patients/:id/recommendations` (the same criteria as search, plus the time
     zone);
   - the **Recommended for you** panel on My Doctors, with speciality, city, language
     and consultation filters;
   - the assistant: its read-only `searchDoctors` tool now returns recommendations for
     the session's patient. No new tool and no new permission. The AI keeps the backend's
     order.

## Consequences

- Recommendations are as good as the profile data and the care history. A patient with
  no history gets the search order, lifted only by city, language and availability.
- The weights are explicit constants, so they are reviewable and testable, not learned.
  Changing them is a code change with tests.
- Availability checks cost up to 6 slot computations per request. That is acceptable at
  this scale; a cache would be the next step.

## Alternatives considered

- **Model-written recommendations:** these risk invented reasons and medical-sounding
  advice, and cannot be checked against data. Rejected.
- **Using diagnoses or records to match doctors:** that is clinical inference and needs
  consent and clinical review. Out of scope by design.
- **A new assistant tool:** it would widen the approved tool set for no benefit, since
  the existing read-only search tool can return recommendations.
