# ADR-0039: Patients ask about their own records

- **Status:** Accepted (implemented)
- **Date:** 2026-10-17
- **Amends:**
  - ADR-0024: who may ask a record question (the patient side, too);
  - ADR-0036 §3: record questions were kept on the Health Records page; the assistant
    now answers them as well.
- **Refines:** ADR-0037 (vectors of a new embedding model for existing chunks).

## Context

Testing the assistant showed a gap. A patient could ask a doctor, but not the app, "How
has my HbA1c changed?" or "What did my echo show?", although their documents were
already read and indexed for the doctors they had consented to. The assistant only
pointed to Health Records.

The patient-scoped RAG of ADR-0024 already gives cited, validated answers. It only ever
asked who the reader is in order to choose the documents: for a doctor, RLS limits them
to the consented types. For the patient side (the patient, or a guardian for a
dependent), RLS shows all of the patient's own documents, so no consent applies.

Switching the embedding model (ADR-0037) left existing chunks with vectors of the old
model. Retrieval then found them only by words, not by meaning, until the documents were
analysed again.

## Decision

1. **The patient side may ask** on `POST /patients/:patientId/record-questions`.
   - The backend decides the side per request: `medical_records:read` with a
     `patient_self` or `guardian_dependent` relationship is the patient side. Anyone
     else follows ADR-0024 unchanged (`ai_assist:use`, treating doctor, consent).
   - The patient's own opt-in to AI reading of documents is still required (`409
     ai_processing_disabled`, worded for the patient).
   - The documents are the patient's available documents (RLS); the facts are the
     verified lab values. The scope token names exactly those documents, as before.
   - The same validation applies (citations, numbers present in the sources, supported
     wording, no diagnosis or treatment language), and so does the exact fallback.
   - The audit row records `side: patient` and counts only. The question is never
     stored, logged or audited, as before.
2. **Health Records** shows "Ask about your documents" when AI reading is on and there
   are documents.
3. **In the assistant**, an `ask_records` turn is answered by that same workflow, after
   the planner step and with the person's own message:
   - The planner (the model choosing the intent) still never sees the record. The
     answer comes from the record-question workflow, as a `record_answer` card with
     `source: 'ai_generated'` and its citations, labelled as an AI summary.
   - AI reading off: the reply points to Privacy & Access and Health Records, and
     nothing is sent.
   - Any other error: the planner's own reply stands (a link to Health Records).
   - No new tool and no write path: the five assistant tools stay as approved.
4. **Vectors of the current model for existing chunks.** Chunks stay append-only.
   - `ai.chunk_vectors (chunk_id, patient_id, model, embedding)` holds a vector of
     another model beside the chunk. The AI role may only select and insert, under the
     same patient-scope RLS as the chunks. A composite key ties each row to its chunk's
     patient. The application role has no access.
   - `POST /v1/documents/reembed` (purpose `document_analysis`; the patient and each
     document in scope) adds vectors for chunks of the latest extraction that have none
     of the current model. At most 400 per call, with `more` when there are further
     chunks. No text leaves the AI service; it returns counts.
   - Retrieval ranks by the chunk's own vector when it is of the current model, else by
     an added vector of that model. Full-text ranking still covers every chunk.
   - The worker runs `records-reembed` once at every start (a model switch takes effect
     on restart), for opted-in patients' available documents. `npm run records:reembed
     -w backend` does the same on demand.

## Consequences

- Patients can ask about their own documents in the app, with sources. With a local
  model (ADR-0037) the text stays on the machine.
- With an external provider, the patient's own document text reaches that provider for
  these questions. That is already the case for a doctor's questions and for document
  analysis. The same gates hold: the patient's opt-in, and in production
  `LLM_EXTERNAL_PROCESSING_APPROVED` after the review of ADR-0008.
- An answer is a summary, not advice: the page and the assistant say to ask the doctor
  about anything worrying.
- A model switch now costs one embedding pass over the existing chunks, not a new
  analysis of every document.

## Alternatives considered

- **Letting the assistant's model read the record (a sixth tool):** the planner would
  see clinical text on every turn. Rejected, as in ADR-0036.
- **Re-analysing documents after a model switch:** it repeats the extraction (slow with
  a local model) and creates new versions, though the text has not changed.
- **Updating the chunks' vectors in place:** chunks are append-only AI history (ADR-0022),
  and the AI role has no UPDATE on them. A side table keeps that guarantee.
