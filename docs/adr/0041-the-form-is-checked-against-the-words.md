# ADR-0041: The model's form is checked against the person's words

- **Status:** Accepted (implemented).
- **Date:** 2026-10-31
- **Refines:** ADR-0029 (the planner), ADR-0033 (clarification), ADR-0037 (small models).
- **Amends:** ADR-0024 (the order and dates of sources), ADR-0026 (escalation from a note).

## Context

A functionality audit ran the assistant with `llama3.2` instead of the offline fake. The
fake only returns what its keyword rules find, so the tests had never met a model that
over-fills the form. The real model did, on most messages:

| Message | What the model returned | What the person got |
|---|---|---|
| "I think I am having a heart attack" | a booking intent | five cardiologists, no emergency guidance |
| "a dermatologist in Bangalore who speaks Hindi, online" | `doctorName: "a dermatologist"`, no city, area `acne` | "I couldn't find a doctor named a dermatologist" |
| "Book Dr. Meera" | no name | five unrelated doctors |
| "I have acidity for 3 days" | intent `unsupported` | no doctors and no health information |
| "not today, a dermatologist on Friday morning" | area `psoriasis` | "doctors who list Psoriasis", which nobody mentioned |

ADR-0037 had started correcting single words. The problem is wider: a value that passes
the form's schema can still have nothing to do with the message.

Three other gaps came out of the same audit. Emergency wording missed common phrases, so
"heart attack" never reached the safety rule. Record answers had no idea which document
was newest, so "my last HbA1c" gave a value from June although October's report was on
file. A message about records also changed the doctor search under way.

## Decision

1. **Every field except the kind of doctor must be supported by the message.**
   `_explicit_cues` reads what the message states and drops what it doesn't: day, mode,
   time window, clock time, city, language, doctor's name, areas of practice, position in
   a list, "show others", and what the person no longer minds. The word tables are in
   `care_words.py`, shared with the fake model. Only the kind of doctor may be inferred,
   from a described concern, and a message of scheduling words alone infers nothing.
   This applies to every provider, so a better model gains nothing here but loses little:
   it can still infer the kind of doctor, and a missed area only changes the ranking.
2. **A described concern is a request.** A kind of doctor, an area or a doctor's name
   turns `unsupported` or `greeting` into `find_doctor`.
3. **Only search intents change the search.** A question about records or appointments
   leaves the criteria, candidates and choice as they were.
4. **A chosen doctor stays chosen.** Online or in clinic changes which times are offered,
   not who. "The second one" picks a time when times are on offer, and a doctor otherwise.
5. **A clock time reaches the lookup.** `findAvailableSlots` takes `time` and returns the
   closest slots, so "at 4 pm" is never refused from the morning's first six. Free on
   several days, it asks which one. Not free, it says so and offers the nearest.
6. **The time asked for lifts doctors.** `searchDoctors` takes the day and window. They
   filter nobody, but doctors free then get +2, so the first doctor shown has times.
7. **A proposal matches the checked state.** A booking card is built only for the doctor
   and time in the sanitised state. If the time has gone, the state forgets it, so the next
   turn looks again instead of offering it once more. A tap on a time no longer offered
   gets a fresh look (`staleChoice`), so the cards shown are real.
8. **Search finds a place or language by any of its names** (`cityNames`, `languageNames`):
   Bangalore is Bengaluru, Bangla is Bengali. "Dr" and "Doctor" are not part of a name.
9. **Recommendations reach beyond the search's top ten.** Doctors the patient knows, and
   doctors near them, are added to the candidates before scoring. Without this, a broad
   request from Pune returned Jaipur and Delhi, and continuity never applied.
10. **Emergency wording** gains heart attack, breathing difficulty in its usual phrasings,
    wanting to die, vomiting blood, severe allergic reactions, not waking and paralysis, in
    English and common Hinglish. "Food poisoning" no longer counts as poisoning. The same
    rule now reads a follow-up's note, so a warning sign written instead of ticked is urgent.
11. **Record answers know the date.** Documents are ordered by the date on the document,
    then the upload. Each chunk carries that date in the text the model and validator read,
    and sources reach the model newest first.
12. **Retrieval matches any term, and everyday words.** The text query used to need every
    term, so "last" could empty it. Plurals and a small table map everyday words to what
    reports call them ("kidneys" finds creatinine), for finding sources only.
13. **Validation takes two things out of a sentence.** The labels it cites, whose digits
    would otherwise fail the number check, and an interpretation added to a fact after a
    comma ("..., indicating prediabetes"). A sentence with diagnostic wording, or whose main
    verb says what a result means, is dropped whole.
14. **A short prompt for record answers.** A long list of rules made `llama3.2` return no
    sentences at all. The prompt now asks for one to three sentences, says the sources are
    newest first, and reserves an empty answer for when no source mentions the question.
15. **Greetings and one's own medicines are read by code,** as the model called "hello" a
    booking and "what medicines am I on?" unsupported.

## Consequences

- With `llama3.2`, these conversations now reach the right doctors and times. The fake
  model's tests pin each case with the model's real answers
  (`ai-service/tests/test_form_grounding.py`).
- A kind of doctor inferred from a concern is still the model's guess, and there is no
  kidney specialty in the vocabulary, so "my kidneys hurt" may reach the wrong kind of
  doctor. The person sees which kind was searched for, and can change it.
- The word tables need maintaining. Wording they miss loses a preference, never invents
  one: the failure is a broader search, not a wrong one.
- A smarter hosted model gets less credit for reading between the lines ("my skin keeps
  breaking out" names no listed word for acne). That is the right trade for a form that
  drives a booking flow.
- Emergency wording matches a mention, so "I had a heart attack last year" also gets the
  guidance, as "stroke" always has. Over-warning is the safer error, and the person can
  ask again in other words. It is still not triage, and Hindi in Devanagari script is
  not covered.
- A brief or answer can only be as dated as the extraction: documents with no date on
  record sort last.

## Alternatives considered

- **A larger model:** better answers, but a minute or more per message on a laptop, and no
  guarantee. A value that drives a booking should be checked whichever model produced it.
- **Asking the model again when a value looks wrong:** slower, and it has no way to know
  it was wrong.
- **Removing "heart attack" style wording from the booking flow by a model:** emergencies
  must not depend on a model at all (ADR-0029).
