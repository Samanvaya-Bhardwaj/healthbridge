# ADR-0040: General health information in the assistant

- **Status:** Accepted (implemented). Production use needs clinically reviewed articles.
- **Date:** 2026-10-18
- **Refines:** ADR-0029 (no clinical role), ADR-0032 (recommendations).
- **Builds on:** ADR-0008 (LLM policy), ADR-0010 and ADR-0024 (grounded, cited answers),
  ADR-0012 (AI execution records), ADR-0039 (answers beside the planner).

## Context

People describe a problem to the assistant rather than a kind of doctor: "I am having
acidity for past 3 days, I took Unienzyme but nothing changes." The assistant found the
right doctors, but said nothing about the problem. People expect what a good health
information service gives: what it is often linked with, what may help, when to see a
doctor and which signs need urgent help, with a clear note that this is not a diagnosis.

A small local model (ADR-0037) asked for causes and remedies from its own knowledge would
sometimes invent them, name medicines or reassure wrongly. ADR-0029 rules out diagnosing,
prescribing and judging urgency.

## Decision

1. **A health library, not the model's own knowledge.** General information on common
   complaints is a set of Markdown articles in the AI service (`app/health/articles`),
   written for patients and versioned with the code. Each article has match words
   (English and common Hinglish), an overview, and four lists: often linked with, what may
   help, see a doctor if, get urgent help if. The lists contain no medicine names or
   doses; they send people to a pharmacist or doctor for medicines.
2. **Code picks the article.** The words in the message choose it (negations such as
   "no fever" are ignored), so a message about something the library doesn't cover gets
   no information and no model call.
3. **The model only summarises it.** It writes 2 to 4 short sentences for the message,
   citing the article's passages. Validation keeps a sentence only if it cites passages
   it was given, takes its numbers from them, uses mostly their words, and has no
   diagnostic or prescribing wording, no medicine, nothing about seriousness or urgency,
   and no detail from the person's message that the article doesn't contain (such as a
   medicine they took). Urgent warning signs are never given to the model.
4. **Fixed text around it.** The card shows the article's lists word for word, the
   warning signs with "call 112", and a fixed note: "I'm an AI assistant, not a doctor.
   This is general information, not a diagnosis." It is labelled general health
   information, apart from the AI summary inside it. The doctors who can help follow, as
   before.
5. **When.** Only on doctor-search turns from the person's own words (not taps), after
   the planner step and the backend's emergency screening, as for record answers
   (ADR-0039). The planner never sees the article.
6. **Privacy.** The message reaches the AI service with the backend's keyed digest; the
   run keeps the digest only (`health_info` joins the free-text workflows of ADR-0012).
   Nothing is stored in the session or the audit log beyond the card count; logs carry
   counts only, not the topic.
7. **A deadline for slow models.** The summary has a deadline that grows with
   `AI_SERVICE_TIMEOUT_SCALE`. Past it, the lists come back without a summary.
8. **Clinical review before production.** Every article starts as `review: draft`. In
   production only `review: approved` articles, with `reviewed_by` and `reviewed_on`, are
   served; with none approved, the assistant gives no general information there. The
   card shows which: "draft for testing, not yet reviewed by a clinician", or the
   reviewer and date.

## Consequences

- A described concern gets useful, conservative information and the right doctors in
  one reply, with sources a person can check.
- The information is only as good as the library: 18 common complaints to start
  (acidity, indigestion, stomach ache, constipation, loose motions, cold, cough, fever,
  sore throat, headache, back pain, joint pain, itching and rashes, acne, nasal
  allergies, sleep, period pain, burning when passing urine). They were written from
  general public-health guidance and need a doctor's review before real patients see
  them.
- Matching by words misses phrasings the article doesn't list; those get doctors only.
- With a local model on a laptop CPU, the summary adds about 30 to 60 seconds to the
  turn.

## Alternatives considered

- **Letting the model answer from its own knowledge with a disclaimer:** the disclaimer
  doesn't make a wrong cause or a named medicine safe. Rejected.
- **Showing only the fixed lists, with no model:** safe and fast, but not tailored to the
  message. The lists are always shown; the summary adds the fit.
- **Vector search over the library:** the library is small and the match words are
  precise; vectors would add false matches (any message is "nearest" to some article).
