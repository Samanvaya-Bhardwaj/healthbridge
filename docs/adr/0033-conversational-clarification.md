# ADR-0033: Conversational clarification

- **Status:** Accepted (implemented)
- **Date:** 2026-10-16
- **Builds on:**
  - ADR-0029: agentic care assistant;
  - ADR-0031: doctor search;
  - ADR-0032: recommendations.

## Context

People rarely ask for "a dermatologist in Pune who speaks Marathi, online" in one go:

- they describe a concern several kinds of doctor could see;
- they correct themselves ("actually, a cardiologist");
- they drop a preference ("any city is fine");
- they refine ("not this doctor");
- they ask for things HealthBridge cannot search by ("only female doctors").

The assistant must handle all of this:

- asking only when it matters, and at most a bounded number of times;
- never carrying stale criteria forward;
- never pretending to apply a filter it cannot apply;
- without widening its tools or storing what people wrote.

## Decision

1. **The model reports; the code decides.** The model's fixed form gains four fields:
   - `specialtyOptions` (up to 3 allowed kinds of doctor, when the concern fits several
     and none is named);
   - `remove` (criteria the person no longer minds);
   - `showOthers`;
   - `unsupported` (gender, age, fees, ratings, insurance, other).

   The validator keeps only allowed values. Everything else is dropped.
2. **Explicit state.** The structured state (16 KB, 24 hours, never text) adds:
   - `pendingChoice` (the open question and its options);
   - `clarifyTurns` (at most 2 in a row);
   - `removed` (criteria the person said they don't mind);
   - `excludedDoctorIds` (doctors not to show again: only IDs the backend itself showed,
     at most 20);
   - `notices` (the latest message's unsupported preferences, as codes).

   So each criterion is stated, inferred (`specialtyFromConcern`), removed (`removed`)
   or unresolved (`pendingChoice`).
3. **The turn, step by step:**
   1. normalise and screen (the emergency check runs first, ADR-0029);
   2. extract the form;
   3. reconcile with the state:
      - removals first, and a removal wins over an incidental mention in the same message;
      - a named doctor replaces the kind of doctor, and the reverse;
      - new values refine;
      - areas that no longer fit the kind of doctor go;
   4. if the concern fits several kinds of doctor and none is named, ask **one** question
      with tappable choices (and "any kind of doctor"), unless 2 questions were already
      asked in a row;
   5. otherwise search with every supported criterion, even with none (a broad
      recommendation is still useful);
   6. reply with a fixed template: the honest notices first ("I can't choose doctors by
      gender: HealthBridge doesn't record it."), then results, a genuine no-match with
      one way to widen it, or search unavailable.
4. **Choices are data, not text.** A `choice` card carries an allowed kind of doctor or
   "Any kind of doctor is fine". The backend drops any other value. Tapping a choice sends
   it as the person's next message, so it goes through the same screening and validation.
5. **Nothing new is allowed.** The same five read-only tools are used. Exclusions only
   hide doctors from a search, and the backend accepts only IDs it showed before. No
   message text is stored.

## Consequences

- A synthetic, hand-labelled evaluation (`ai-service/tests/test_clarify_eval.py`, 24
  conversations, 40 turns) measures clarification precision, unnecessary questions,
  criterion and correction accuracy, stale-criterion retention, routing and safety
  violations. It uses the rule-based fake model, so it checks the logic around the model,
  not language understanding. See `docs/evaluations/CLARIFICATION.md`.
- With a real model, the quality of the form (especially `specialtyOptions`) decides how
  often the assistant asks. The 2-question bound and the broad-search fallback limit the
  cost of a wrong guess.

## Alternatives considered

- **Free-text model replies:** these could invent filters or medical advice. Rejected;
  replies stay templates.
- **Asking for every missing criterion:** tiring, and unnecessary when a broad
  recommendation already helps.
- **A dialogue state machine in the frontend:** state would then be lost on reload and
  would diverge from the backend. It is kept server-side and structured instead.
