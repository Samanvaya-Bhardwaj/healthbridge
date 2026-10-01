# Database

PostgreSQL 17 with `pgcrypto`, `citext`, `btree_gist`, `pg_trgm` and `vector`. All schema
changes are Knex migrations in `backend/migrations/` (ADR-0003).

## Roles

| Role | Used by | Privileges |
|---|---|---|
| `hb_owner` | migrations only | owner of all objects |
| `hb_app` | backend | DML on `public`; SELECT/INSERT on `audit` and `ai`; no DDL, no RLS bypass |
| `hb_ai` | AI service | `ai` schema only; no access to `public` |

## Migrations

| Migration | Contents |
|---|---|
| `20261001000000_foundation` | extensions, `ai` and `audit` schemas, default privileges, `set_updated_at()` |
| `20261002000000_identity_rbac_audit` | `roles`, `permissions`, `role_permissions`, `users`, `user_roles`, `sessions`, `audit.audit_logs` + append-only triggers, RBAC seed |

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
