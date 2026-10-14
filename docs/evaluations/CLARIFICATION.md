# Conversational clarification: synthetic evaluation (step 6)

- **Date:** 2026-10-16
- **What:** the assistant's understanding, clarification, correction and refinement
  logic (ADR-0033).
- **How to reproduce:** `pytest -q -s ai-service/tests/test_clarify_eval.py`. It prints
  the metrics as one JSON line.

## Method

- **Data:** 24 synthetic conversations (40 turns), labelled by hand from what a person
  would expect, not from the implementation. They cover:
  - ambiguous concerns;
  - clear requests that should not be questioned;
  - corrections;
  - removed constraints;
  - multi-turn refinements;
  - "show me others";
  - unsupported preferences;
  - safety-sensitive wording;
  - a non-search request.
- **Model:** the deterministic fake, keyword rules in `ai-service/app/llm/care_fake.py`.
  Each turn runs the real graph (screening, validation, reconciliation with the state,
  routing), with tools returning canned results.

## Results

| Metric | Value | Bar |
|---|---|---|
| Clarification precision: questions that were warranted | 1.00 | ≥ 0.95 |
| Unnecessary clarification rate: should search, asked instead | 0.00 | ≤ 0.05 |
| Criterion accuracy: expected stated or corrected criteria present | 1.00 | ≥ 0.95 |
| Stale-criterion retention: removed or replaced criteria still present | 0.00 | 0 |
| Tool routing: ask, search, emergency or other as expected | 1.00 | ≥ 0.95 |
| Safety violations: emergency not first, write tool, patient ID in arguments | 0 | 0 |

The first run found one routing miss. "Can I talk to someone online?" was not
recognised as a doctor request, because the fake's intent rules needed the word
"doctor". The fake now also recognises "talk to / speak to / see someone". The fix was
made in the fake, not in the validator: treating any stated criterion as a doctor request
would misroute "what's the weather in Pune?".

## What this does and does not show

- **It shows** that the logic around the model is correct on these cases:
  - a question is asked only for a real ambiguity, and at most twice in a row;
  - corrections replace, and removals remove;
  - incompatible areas go;
  - refinements keep earlier valid criteria;
  - exclusions are honoured;
  - unsupported preferences are answered honestly;
  - emergencies always come first.
- **It does not measure language understanding.** The fake recognises the phrasing in
  this set. With a real model, the form's quality (especially detecting ambiguity) would
  need its own evaluation on held-out human wording, and that is not done here.
- **The set is small** (40 turns), so the numbers are not statistics about people.
