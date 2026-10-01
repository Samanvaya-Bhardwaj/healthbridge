# Database

PostgreSQL 17 with `pgcrypto`, `citext`, `btree_gist`, `pg_trgm` and `vector`. All schema
changes are Knex migrations in `backend/migrations/` (ADR-0003).

## Roles

| Role | Used by | Privileges |
|---|---|---|
| `hb_owner` | migrations only | owner of all objects |
| `hb_app` | backend | DML on `public` (subject to RLS on patient-scoped tables); SELECT/INSERT on `audit` and `ai`; EXECUTE on `authz` functions; no DDL, no RLS bypass |
| `hb_ai` | AI service | `ai` schema only; no access to `public` |

## Migrations

| Migration | Contents |
|---|---|
| `20261001000000_foundation` | extensions, `ai` and `audit` schemas, default privileges, `set_updated_at()` |
| `20261002000000_identity_rbac_audit` | `roles`, `permissions`, `role_permissions`, `users`, `user_roles`, `sessions`, `audit.audit_logs` + append-only triggers, RBAC seed |
| `20261003000000_patients_doctors_clinics` | `roles.scope`, 9 permissions, `clinics`, `clinic_memberships`, `user_roles.clinic_id` FK + scope trigger, `effective_role_grants`, `patients`, `patient_guardianships`, `doctors`, `doctor_verifications`, `care_relationships`, schema `authz`, RLS policies |

## Identity, RBAC and audit (M1)

```mermaid
erDiagram
  USERS ||--o{ USER_ROLES : has
  ROLES ||--o{ USER_ROLES : assigned
  ROLES ||--o{ ROLE_PERMISSIONS : grants
  PERMISSIONS ||--o{ ROLE_PERMISSIONS : included
  USERS ||--o{ SESSIONS : owns

  USERS {
    uuid id PK "UUIDv7 (app-generated)"
    citext email "unique among non-deleted"
    text full_name
    text password_hash "argon2id only (CHECK)"
    timestamptz password_changed_at
    text status "active | disabled"
    int failed_login_attempts
    timestamptz locked_until
    timestamptz last_login_at
    timestamptz email_verified_at
    timestamptz terms_accepted_at
    text terms_version
    boolean is_demo
    timestamptz deleted_at "soft delete"
  }
  ROLES {
    uuid id PK
    text code UK "PATIENT | DOCTOR | CLINIC_ADMIN | PLATFORM_ADMIN | SUPPORT"
  }
  PERMISSIONS {
    uuid id PK
    text code UK "resource:action"
  }
  ROLE_PERMISSIONS {
    uuid role_id PK
    uuid permission_id PK
  }
  USER_ROLES {
    uuid id PK
    uuid user_id FK
    uuid role_id FK
    uuid clinic_id "scope; FK added in M2"
    uuid granted_by FK
  }
  SESSIONS {
    uuid id PK
    uuid user_id FK
    text refresh_token_hash UK "sha256 hex"
    text previous_refresh_token_hash "replay detection"
    timestamptz rotated_at
    int rotation_count
    text csrf_token_hash
    timestamptz idle_expires_at
    timestamptz absolute_expires_at
    timestamptz revoked_at
    text revoked_reason
    inet ip
    text user_agent
  }
  AUDIT_LOGS {
    uuid id PK
    timestamptz occurred_at
    text category
    text action
    text outcome "success | failure | denied"
    text actor_type "user | anonymous | system"
    uuid actor_user_id "no FK by design"
    text_array actor_roles
    uuid session_id
    text resource_type
    text resource_id
    uuid patient_id
    text reason
    text request_id
    inet ip
    text user_agent
    jsonb metadata "sanitised, <= 8 KB"
  }
```

Notable constraints and indexes:
- `users_email_live_unique (email) WHERE deleted_at IS NULL`.
- `user_roles` is unique on `(user_id, role_id, COALESCE(clinic_id, nil))`.
- Session CHECKs: hash format, expiry ordering, consistent revocation, allowed revoke
  reasons.
- Partial index for active sessions per user.
- Audit indexes: BRIN on `occurred_at`; B-tree on actor, action, resource, patient and
  request ID.

## Patients, doctors, clinics and care relationships (M2)

```mermaid
erDiagram
  USERS ||--o| PATIENTS : "owns (optional)"
  USERS ||--o{ PATIENT_GUARDIANSHIPS : "guards"
  PATIENTS ||--o{ PATIENT_GUARDIANSHIPS : "is guarded by"
  USERS ||--o| DOCTORS : "has professional profile"
  DOCTORS ||--o{ DOCTOR_VERIFICATIONS : "is verified by cases"
  CLINICS ||--o{ CLINIC_MEMBERSHIPS : has
  USERS ||--o{ CLINIC_MEMBERSHIPS : "member of"
  CLINICS ||--o{ USER_ROLES : "scopes"
  PATIENTS ||--o{ CARE_RELATIONSHIPS : trusts
  DOCTORS ||--o{ CARE_RELATIONSHIPS : treats
  CLINICS ||--o{ CARE_RELATIONSHIPS : "context (optional)"

  PATIENTS {
    uuid id PK
    uuid user_id FK "unique; NULL for dependents without login"
    text full_name
    text preferred_name
    date date_of_birth
    text sex "optional"
    text phone_e164
    text address "city, state, postal code, country"
    text emergency_contact "name and phone both or neither"
    text status "active | archived"
    uuid created_by_user_id FK "creator; immutable"
    boolean is_demo
  }
  PATIENT_GUARDIANSHIPS {
    uuid id PK
    uuid patient_id FK "the dependent"
    uuid guardian_user_id FK "the actor"
    text relationship_type "parent, child, spouse, ..."
    text access_scope "manage | view"
    text basis "created_dependent | patient_delegation | legal_authority"
    text status "pending | active | ended"
  }
  DOCTORS {
    uuid id PK
    uuid user_id FK "unique"
    text professional_name
    text registration_number "unique per council"
    text registration_council
    smallint registration_year
    text primary_specialization
    jsonb qualifications
    text_array languages
    text profile_status "draft | active | suspended"
    text verification_status "unverified ... verified | rejected | suspended"
  }
  DOCTOR_VERIFICATIONS {
    uuid id PK
    uuid doctor_id FK
    text status "pending | under_review | verified | rejected | suspended | withdrawn"
    text registration_snapshot "as reviewed"
    uuid reviewer_user_id FK
    uuid decided_by_user_id FK
    text decision_reason_code
    text decision_notes "internal only"
  }
  CLINICS {
    uuid id PK
    text name
    text registration_number "unique when set"
    text status "active | inactive"
  }
  CLINIC_MEMBERSHIPS {
    uuid id PK
    uuid clinic_id FK
    uuid user_id FK
    text member_role "CLINIC_ADMIN | DOCTOR"
    text status "invited | active | suspended | ended"
  }
  CARE_RELATIONSHIPS {
    uuid id PK
    uuid patient_id FK
    uuid doctor_id FK
    uuid clinic_id FK "optional context"
    text status "invited | pending | active | paused | ended"
    text initiated_by "patient | doctor"
    text patient_display_name "shared with doctor before access"
    text end_reason
  }
```

### Invariants enforced by the database

| Invariant | Mechanism |
|---|---|
| Clinic roles always have a clinic; global roles never do | `roles.scope` + trigger `user_roles_scope` |
| Clinic roles count only with an active membership in an active clinic | view `effective_role_grants` |
| One open membership per (clinic, user, role); one open care relationship per (patient, doctor); one open guardianship per (patient, guardian); one open verification case per doctor | partial unique indexes |
| A doctor profile is active only if verified | `doctors_active_requires_verified` |
| Care relationships start PENDING (patient-initiated) or INVITED (doctor-initiated); ended ⇔ `ended_at` | CHECK constraints |
| Patient ownership (`user_id`, `created_by_user_id`) never changes | trigger + CHECK |
| Patient-scoped rows visible/writable only by related actors; never deletable | RLS (below) |

### Row-level security

`withActor()` sets `app.user_id` for the transaction. Predicates live in schema `authz`
(SECURITY DEFINER, boolean-only). Clinic membership never satisfies any policy.

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `patients` | self, any active guardian, treating doctor | creator = actor and (`user_id` = actor or NULL) | self or `manage` guardian | none |
| `patient_guardianships` | the guardian, or the patient themself | guardian = creator = actor, for a dependent the actor created | guardian or patient | none |
| `care_relationships` | patient side (self/guardian) or the doctor party | patient-initiated by a patient manager, or doctor-initiated by the doctor; requester = actor | patient manager or doctor party | none |
