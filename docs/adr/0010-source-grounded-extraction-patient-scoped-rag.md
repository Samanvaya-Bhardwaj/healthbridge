# ADR-0010: Source-grounded extraction and patient-scoped retrieval

- **Status:** Accepted (implemented in M6/M8)
- **Date:** 2026-10-01

## Context

LLMs can fabricate values, citations and records. In healthcare an ungrounded statement
is worse than no statement.

## Decision

**Document extraction**

- Every extracted field contains:
  - the extracted value;
  - the source document ID;
  - the source quote or text span;
  - its extraction confidence or validation status.
- The validator checks that the quote is actually present in the document text. A value
  that **cannot be grounded is not stored as a trusted extracted value**. It is dropped or
  flagged, and it is never "corrected" by the model.
- The original document is always preserved. Extracted data is stored separately and
  versioned.
- **Handwritten prescriptions:** the original is stored, the extraction is marked
  `needs_clinician_review`, and OCR output is never treated as authoritative.

**Retrieval (RAG)**

- Retrieval is always **patient-scoped**. There is no global medical-record search in
  which patient boundaries could accidentally cross.
- Pipeline:
  1. authorisation (AccessPolicy plus consent);
  2. patient scope (signed scope token);
  3. hybrid retrieval (pgvector plus full-text, under an RLS-enforced role);
  4. reranking;
  5. source validation;
  6. LLM generation;
  7. source citations.
- Every generated claim must cite a retrieved, in-scope source. Uncited claims are
  removed.
- If there is not enough evidence, the response is exactly: **"Insufficient information.
  Please consult the doctor."**

## Consequences

- Some true values will be dropped when OCR is poor. The design accepts lower recall in
  exchange for no fabrication.
- Retrieval needs per-patient filtering, which suits small per-patient corpora with exact
  vector search.
