# ADR-0017: Patient-scoped authorization: relationships, clinic scope, interim consent, RLS

- **Status:** Accepted (implemented in M2)
- **Date:** 2026-10-01
- **Builds on:** ADR-0006 (three gates)

## Context

M2 introduces the first patient data: profiles, dependents and care relationships. The
three-gate model must become concrete. That means relationship types, clinic-scoped
roles, a consent basis before the M5 consent module exists, and database-level
enforcement that does not rely on the application.

## Decision

### 1. Relationship types (gate 2)

Resolved by `modules/care-access/relationships.js`:

| Relationship | Condition |
|---|---|
| `patient_self` | `patients.user_id` = actor, profile active |
| `guardian_dependent` | Active `patient_guardianships` row for actor → patient. Scope `manage` (read and write) or `view` (read only). |
| `treating_doctor` | Actor's doctor profile is **verified and active**, the user is active, and an **ACTIVE** care relationship exists. Pending, invited, paused or ended relationships give nothing. |
| `clinic_member` | Actor is an active member of an active clinic through which the patient has an active care relationship. It is recognised, but **carries no consent basis**. |
| `PLATFORM_ADMIN`, `SUPPORT` | **No relationship to patients.** These roles also lack patient permissions, so they fail at gate 1. |

Family relationships are recorded explicitly (`relationship_type`) but grant nothing by
themselves. Access comes only from an active guardianship with an explicit
`access_scope` and `basis`. In M2 the only way to create a guardianship is to create a
dependent (`basis = created_dependent`, scope `manage`). Delegation by an adult patient
with their own account uses the same model in a later milestone.

### 2. Consent (gate 3) before M5

`patient_self` and `guardian_dependent` need no consent. For everyone else the consent
resolver grants a basis only in one case:

- the relationship is `treating_doctor`, **and**
- the permission is `patients:read` (the profile).

The basis is `active_care_relationship`: the patient or their guardian explicitly
requested or accepted that relationship. Everything else is denied, including:
- `medical_records:*` for treating doctors;
- all access for clinic members.

M5 replaces this resolver with real consent records without changing callers. Every
decision records the consent basis in the audit log.

### 3. Clinic scope

- Roles have a `scope`. `CLINIC_ADMIN` is clinic-scoped and must have `user_roles.clinic_id`.
  A trigger rejects global grants of clinic roles and scoped grants of global roles. The
  deferred `clinic_id` foreign key now exists.
- A clinic-scoped grant is **in force** only while the matching `clinic_memberships` row is
  ACTIVE and the clinic is active (view `effective_role_grants`, the only source for
  principal loading).
- The principal carries global permissions plus a per-clinic permission map. Gate 1 checks
  a permission globally or for the clinic in scope. Account-level permissions (own account
  and sessions) apply globally whichever role grants them.
- **Answers to the M2 questions:**
  - A doctor **can** belong to many clinics.
  - A user **can** hold many roles, including administering several clinics.
  - Permissions **differ by clinic:** `clinic:manage` for clinic A does not apply to
    clinic B.
  - Clinic membership never grants access to patients.
- `DOCTOR` and clinic roles are **workflow-granted** only (ADR-0018). The generic
  role-grant endpoint and provisioning refuse them.

### 4. Row-level security (defence in depth)

- RLS is enabled on `patients`, `patient_guardianships` and `care_relationships`.
- Policies use the transaction-local setting `app.user_id`, set by `withActor()`
  (`set_config(..., true)`, which cannot leak through the connection pool). Without it, no
  rows are visible and no writes are accepted.
- Policy predicates are `SECURITY DEFINER` functions in schema `authz`. They are owned by
  the schema owner, so policies can consult other RLS tables without recursion. They return
  booleans only.
- There are **no DELETE policies**: patient-scoped rows cannot be deleted by the
  application.
- Repositories for these tables refuse to run outside an actor transaction
  (`assertActorTransaction`).

### 5. Independence of the layers

- The application resolvers use **their own SQL**, not the `authz.*` functions. Tests:
  1. call the application layer on the owner connection, which bypasses RLS, and show it
     denies on its own;
  2. call RLS through raw SQL as the app role with no application code, and show it denies
     on its own.
- If AccessPolicy allows but RLS hides a row, the request fails closed (404) and logs a
  "layers disagree" warning.

### 6. Denial semantics

- Gate 1 fails with 403.
- Gate 2 fails with 404, so existence is not revealed. Malformed IDs, guessed IDs and real
  but unrelated IDs are indistinguishable.
- Gate 3 fails with 403 `consent_required`.
- All denials concerning a patient are audited as `data_access` with `patient_id`.
  Allowed patient-data access is audited inside the transaction.

## Consequences

- Each patient-data request costs one relationship query, plus the RLS predicates on the
  rows it reads. This is acceptable at current scale; the queries are indexed.
- Patient-data repositories cannot be called from code paths without an actor, so
  background jobs (later milestones) will need an explicit, audited system context.
  Designing that context is deferred until the first job needs it.
- Two implementations of the relationship rules (SQL functions and application SQL) must
  be kept in step. Tests cover both.
