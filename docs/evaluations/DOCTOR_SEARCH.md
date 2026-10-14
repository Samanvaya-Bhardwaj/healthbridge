# Doctor search: held-out evaluation (M13.2)

- **Date:** 2026-10-16
- **What:** the doctor search of ADR-0031 (filters, eligibility, ranking, outcomes).
- **How to reproduce:** `npx vitest run --root backend tests/integration/searchEval.test.js --silent=false`
  against a migrated database. The test seeds its own dataset (idempotent) and prints the
  metrics as one JSON line.

## Method

- **Dataset:** a synthetic directory from `backend/scripts/lib/syntheticDirectory.js` with
  seed 7. That seed is used only for this evaluation, never for building or tuning the
  search. It has 10 cities, 20 clinics (one of them closed), and 50 doctors: 45
  bookable, plus applicants and one suspended doctor. It is seeded through the real
  services.
- **Queries (120, held out, seed 99):**
  - 70 built from real doctors' attributes, so each has at least one correct answer;
  - 30 random combinations of specialty, area, city, language and mode, many with no
    correct answer;
  - 20 name queries: 10 exact, and 10 with one vowel changed.
- **Truth:** computed from the generator's own attributes (specialty, languages, city of
  an open clinic, practice mode, verification status, the closed clinic), not from the
  search's SQL.
- **Isolation:** the search runs over this dataset only (an internal `pool` option), so
  other data in the shared test database cannot crowd the results.

## Results

| Metric | Value | Bar |
|---|---|---|
| Results returned | 336 over 120 queries | — |
| Constraint precision: results meet every requested filter | 1.00 | 1.00 |
| Eligibility violations: unverified, suspended or closed-clinic matches | 0 | 0 |
| Recall@10: correct doctors found, up to 10 | 1.00 | 1.00 |
| No-match accuracy: "nobody matches" exactly when nobody does | 1.00 | 1.00 |
| Area ranking (MRR of the first doctor listing the area; 31 queries) | 1.00 | ≥ 0.95 |
| Name search (MRR; 20 queries, half with a typo) | 1.00 | ≥ 0.95 |

## What this does and does not show

- **It shows** that the hard filters, the eligibility rule, the no-match outcome and
  area-first ranking behave as specified on unseen synthetic data, including the closed
  clinic, the suspended doctor and the applicants.
- **Perfect scores are expected here.** The filters are deterministic, and the truth
  labels test the same attributes from an independent implementation. The value of the
  evaluation is that it would catch a regression, not that the search is "perfect".
- **It does not measure relevance as people judge it.** The queries are structured
  criteria, not patients' own words. The words-to-criteria step is evaluated separately
  in `ai-service/tests/test_care_eval.py`, with a fake model.
- **Vector ranking is not measured.** This harness has no embedding provider, so ranking
  is lexical. The default provider is feature hashing, which captures word overlap only.
  A meaningful semantic evaluation needs an approved semantic provider and judged
  relevance labels.
- **Scale:** 50 doctors is small. Performance at production size (thousands of doctors)
  is not measured here.
