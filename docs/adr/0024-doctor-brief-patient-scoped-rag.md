# ADR-0024: Doctor brief and patient-scoped retrieval

- **Status:** Accepted
- **Date:** 2026-10-03
- **Refines:** ADR-0010 (patient-scoped RAG, insufficient-information fallback), ADR-0011

## Context

Treating doctors want to ask questions about a consented patient's records and to see a
short brief before a consultation. Wrong or uncited statements, data leaking across
patients, or anything resembling a diagnosis would be harmful.

## Decision

### 1. Authorisation (backend, per request)

All of these must hold:

- the doctor holds `ai_assist:use`;
- the doctor is the patient's treating doctor with an active `medical_documents` consent;
- the patient has opted in to AI processing.

A brief additionally requires the doctor's **own** appointment.

The backend then computes the reader's view:

- the documents that RLS shows this doctor (the consented document types);
- the verified lab values in that view, as facts. Unverified proposals, intake reasons
  and other patients' data are never included.

The AI service receives a patient-scope token (purpose `record_question` or
`doctor_brief`) naming exactly those document IDs. It rejects any other document.

### 2. Retrieval (AI service, RLS-scoped)

- **Hybrid search:** pgvector cosine plus full-text, fused by reciprocal rank. It runs over
  `ai.document_chunks`, limited by RLS to the scoped patient and by SQL to the authorised
  documents and their latest extraction.
- **Deterministic lexical rerank.**
- **Relevance gate:** if no source shares a content term with the question, the agent
  returns the **exact fallback** "Insufficient information. Please consult the doctor."
  **without** calling a model.

### 3. Generation and validation (LangGraph, no tools)

- Prompts carry the sources as delimited, untrusted data with labels: `S#` for document
  chunks and `F#` for verified facts.
- A sentence survives only if it:
  - cites at least one provided label, and cites no unknown label;
  - contains no number absent from its cited sources;
  - has at least 60% of its content words supported by its cited sources;
  - contains no diagnostic, prescribing or treatment-changing language.
- Sentences are removed, never rewritten. If none survive, the answer is the fallback.
- **Briefs** contain only sections with surviving sentences:
  - "Recent verified lab values", from facts;
  - "Documents on file", from the first chunk of each authorised document.

### 4. Records

- Every run creates an `ai.ai_runs` row (validation status `citations_valid` or
  `insufficient_evidence`) and `ai.ai_sources` rows for the cited sources.
- **Questions are never stored or logged.** Only their hash, the counts and the status are
  kept. The audit records `record.question_answered` with counts only.
- `ai.doctor_briefs` stores validated sections. RLS lets the application read a brief only
  as its doctor and only while consent lasts.
- Briefs are cached for 12 hours and can be refreshed.
- `brief_feedback` records one rating per doctor and brief (helpful or not, with an issue
  code).
- **Rate limit:** 60 assistance calls per doctor per hour.

## Consequences

- Answers are extractive and conservative. The deterministic fake provider makes the
  validation path testable offline; quality with real models is governed by the same
  validators.
- The lexical-support rule may remove legitimate paraphrases. We accept that: removing a
  correct sentence is safer than keeping an unsupported one.
- Patients cannot query their own records through AI yet. That would be a separate
  decision on patient-facing AI wording and safety.
