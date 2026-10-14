# ADR-0031: Doctor search (M13.2)

- **Status:** Accepted. Metadata and full-text search are implemented; vector ranking
  is added on top, in the same milestone.
- **Date:** 2026-10-16
- **Builds on:**
  - ADR-0029: agentic care assistant;
  - ADR-0030: one eligibility rule;
  - ADR-0002: PostgreSQL with pgvector.

## Context

The assistant could search only by an exact specialty string, a name or a language, by
filtering the paged directory in JavaScript. Doctors write their specialisation as free
text ("Consultant Dermatologist", "OB/GYN"), so an exact match missed most of them. City
and consultation mode were extracted from the patient's message but never applied.
Nothing distinguished "nobody matches" from "the search failed".

## Decision

1. **A shared, controlled vocabulary** (`@healthbridge/shared` doctorSearch.js):
   - **Canonical specialties and the terms doctors use for them.** A database trigger
     keeps each doctor's canonical `specialties` in step with the profile text, using
     whole-word matching after punctuation becomes spaces.
   - **About 60 areas of practice.** A doctor may list up to 8. Each area names the
     kinds of doctor that usually cover it. Areas describe the doctor's practice, never
     a patient's condition.

   The vocabulary is copied into tables by its migration, and an integration test fails
   if the shared copy and the tables ever differ.
2. **One search service** (`doctors/searchService.js`): a single SQL query over public
   profile data.
   - **Hard filters:**
     - the eligibility rule (ADR-0030);
     - canonical specialty;
     - city (an open practice site there);
     - language (case-insensitive);
     - consultation mode (an active rule of that mode at an open site, in that city
       when one is given);
     - name: names containing the text, else close matches (trigram word similarity
       ≥ 0.7, marked approximate).

     Areas without a specialty narrow results to the kinds of doctor that cover them.
   - **Ranking:** in order, matching listed areas, then full-text relevance of a
     weighted profile document to the specialty and area names, then the patient's care
     team, then experience. Ties break by name and ID. The ranking text is built from
     controlled vocabulary only, never from the patient's words.
   - **Reasons:** each result says which criteria it meets, from the data matched
     (specialty, area, city, language, mode, name, care team).
   - **Outcomes:** `status: 'no_match'` when nobody matches. A failure is thrown and
     reported as `search_unavailable`, so the two are never confused.
3. **The assistant** passes every supported criterion to the search (specialty, areas,
   city, language, mode, name). The model may choose only listed area codes that fit the
   specialty, and changing the specialty drops areas that no longer fit. Replies are fixed
   templates:
   - results summarise what was searched for;
   - "no match" names one concrete way to widen the search;
   - "search unavailable" is a distinct fallback.
4. **`GET /doctors/search`** exposes the same criteria and reasons to the app.

## Consequences

- Search quality depends on doctors' profile text and listed areas. A doctor who writes
  only "Physician" has no canonical specialty: the bare term is ambiguous ("Chest
  Physician" is pulmonology), so it is deliberately not mapped.
- Changing the vocabulary is a migration, which is reviewable and testable.
- Criteria that the data does not hold (for example a doctor's gender) cannot be
  searched. The assistant says so instead of pretending to filter.

## Alternatives considered

- **Free-text specialties with ILIKE:** misses synonyms and matches unrelated text.
- **Ranking by the patient's own words:** sends patient text into ranking and logs, for
  little gain over controlled areas. It also invites diagnosis-like matching.
- **Making areas a hard filter:** most doctors list few areas, so this would hide most
  relevant doctors.
