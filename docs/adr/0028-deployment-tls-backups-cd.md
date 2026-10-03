# ADR-0028: Deployment, TLS, backups and continuous delivery

- **Status:** Accepted
- **Date:** 2026-10-03
- **Builds on:** ADR-0001 (modular monolith + AI service), ADR-0014 (Compose dev
  environment), ARCHITECTURE_PROPOSAL §16 (M12) and the stated production target (AWS
  `ap-south-1`: RDS PostgreSQL with pgvector, ElastiCache, S3, ECS Fargate).

## Context

The same images must run in CI, staging and production. Two deployment shapes are
needed:

- a **single host** (staging, small clinics, rehearsals), where the whole stack runs
  under Docker Compose;
- **managed AWS** for production at scale.

Both must:

- terminate TLS;
- refuse unsafe configuration;
- back up encrypted data and prove that restores work;
- deploy through a pipeline with a smoke test and rollback.

## Decision

### Images and configuration

- **One image per component:** `backend` (API, worker, migrations), `web` (Nginx + SPA),
  `ai`, plus the new `backup` image.
- **Build once:** CD builds each image once per `v*` tag, scans it with Trivy, and pushes
  it to GHCR with an SBOM and provenance. Production copies the **same digests** to ECR.
- **Start-up checks:** the application refuses unsafe settings at start-up:
  - fake providers, insecure cookies or demo data in production;
  - a missing clinical data key;
  - a non-https app URL in staging or production.
- **The web image adapts at start** (`40-healthbridge.sh`):
  - `HB_TLS=on` selects the TLS server (TLS 1.2/1.3, HSTS, HTTP→HTTPS redirect, ACME
    webroot);
  - `HB_STORAGE_PROXY=off` removes the same-origin MinIO proxy (S3 on AWS);
  - `HB_CSP_CONNECT_EXTRA` adds the bucket origin to the CSP after a character check;
  - `HB_RELOAD_HOURS` reloads Nginx periodically to pick up renewed certificates.
  - The app routes live in one snippet (`app.conf`) shared by the plain and TLS servers.
- **Managed-service TLS:**
  - `DB_SSL=require|verify-full` with an optional base64 CA bundle (`DB_SSL_CA`), for the
    API, worker, migrations and AI service;
  - `REDIS_TLS=true` for ElastiCache.
- **SMTP:**
  - relay credentials (`SMTP_USER`/`SMTP_PASSWORD`, or `SMTP_SECURE` for port 465);
  - STARTTLS is **required** in staging and production (TLS 1.2 or higher);
  - local Mailpit is the only plain-SMTP case.
- **S3:** static keys are optional. Without them the AWS SDK uses the ECS task role.
  MinIO still needs keys.

### Single-host Compose (`infra/deploy/compose.prod.yml`)

- **Images:** pulled by release tag (`HB_VERSION` is required), never built on the
  server.
- **Ports:** only 80 and 443 are public. Data services have no host ports, and the
  MinIO console is off. Bull Board is published on loopback only.
- **Containers:**
  - ClamAV is always on;
  - the API, worker and AI service run with read-only root filesystems and tmpfs `/tmp`;
  - every service has memory limits and log rotation.
- **TLS:** certificates come from `HB_TLS_DIR`. An optional `certbot` profile handles
  Let's Encrypt over HTTP-01.
- **Storage:** `storage-init` provisions this stack's MinIO bucket with versioning, using
  `STORAGE_BOOTSTRAP=self-hosted`. On AWS, infrastructure-as-code does this, and the
  application still refuses to.
- **Environment:** `infra/deploy/make-env.mjs` generates the environment file with fresh
  secrets. Provider credentials stay blank for an operator to fill in. Demo data is
  refused for production.
- **Rehearsal:** `compose.rehearsal.yml` lets the production stack run locally or in CI
  as a staging rehearsal. It adds Mailpit with STARTTLS and trust for a self-signed
  certificate, and is never used on a real server.

### AWS (`infra/deploy/ecs/*.json`)

- **Task definitions** (Fargate) for `api`, `worker`, `web`, `ai-service`, `clamav` and a
  one-off `migrate`:
  - secrets are referenced from Secrets Manager by ARN, never as values;
  - read-only root filesystems where possible, all Linux capabilities dropped, awslogs,
    health checks;
  - `DB_SSL=verify-full` and `REDIS_TLS=true`.
- **Rendering:** `render.mjs` fails on any missing value and refuses a plain-text secret.
- **Networking:** TLS terminates at the ALB (`TRUST_PROXY=2`), and services find each
  other through Service Connect aliases (`api`, `ai-service`, `clamav`).
- **Provisioning:** VPC, ALB, RDS, ElastiCache, S3 (SSE-KMS, versioning, CORS for the app
  origin), Secrets Manager entries, IAM roles and the ECS services are provisioned by
  infrastructure-as-code. They are listed in OPERATIONS.md, not created by this
  repository.

### Backups (`infra/deploy/backup`)

- **Snapshot:** each backup holds one REPEATABLE READ transaction and exports its
  snapshot. `pg_dump --snapshot` and the **row-count manifest** come from that same
  snapshot, so a restore must reproduce the manifest exactly. The manifest covers the
  schema version, key tables, RLS-enabled tables and triggers, never row contents.
- **Encryption:** dumps are encrypted with **age** to a recipient public key. The private
  key is not on the server; it is mounted only for drills and restores. Checksums are
  stored alongside each dump.
- **Documents:** objects are copied incrementally through **rclone crypt** (encrypted
  names and contents), locally and, optionally, off-site (`BACKUP_REMOTE`).
- **Retention:** a 48-hour hourly window plus 14 daily backups.
- **Restore drill** (`backup drill`): verify the checksum, decrypt, restore into a
  scratch database, require an exact manifest match and the presence of the audit guard
  triggers, then drop the scratch database. CI runs the drill on every build.
- **Disaster recovery** (`backup restore ID --confirm`): restores only into an empty
  database, verifies the manifest, then restores the document objects.
- **Recovery targets:** the Compose stack's RPO equals the backup interval (default one
  hour). The production target of RPO ≤ 15 minutes needs managed point-in-time recovery
  (RDS PITR) on AWS, which this ADR assumes; the dump-based backups add portable,
  off-site copies.

### Continuous delivery (`.github/workflows/cd.yml`)

- **On a `v*` tag:**
  1. images are built, scanned and pushed;
  2. **staging** is deployed over SSH with a pinned host key:
     - only `infra/` is shipped (secrets live in the host's environment file);
     - `compose pull && up --wait`, then the **smoke test**;
     - **automatic rollback** to the previous version on failure;
  3. **production** deploys to ECS, gated by the GitHub `production` environment's
     reviewers, using AWS **OIDC** (no stored cloud keys):
     - copy the images to ECR;
     - render and register the task definitions;
     - run migrations as a one-off task that must exit 0;
     - update the services (circuit-breaker rollback), wait until they are stable, then
       run the smoke test.
- **Manual runs:** `workflow_dispatch` redeploys an existing version to one environment,
  which also serves as a rollback.
- **Unconfigured repositories:** deploy jobs run only when the environment's variables
  exist. Forks and unconfigured repositories only build and scan.

### Local operation and live video

- **One command:** `npm start` (`scripts/start.mjs`, Node built-ins only) runs the whole
  application from a fresh clone:
  1. creates or updates `.env`;
  2. builds and starts every service, waiting until they are healthy;
  3. seeds the synthetic demo;
  4. prints the URLs and accounts.
- **Other commands:** `npm stop`, `npm run logs` and `npm run reset` manage the stack.
- **Verification:** `npm run check` (`scripts/check.mjs`) runs every quality gate,
  including the e2e journeys and a backup/restore drill (`scripts/backup-drill.mjs`).
- **Live video** (`--video`):
  - starts a local LiveKit server (Compose profile `video`) and switches the API to
    `VIDEO_PROVIDER=livekit`;
  - the web container allows camera and microphone for its own origin (`HB_MEDIA=on`) and
    adds the LiveKit signalling origin to the CSP. Without video, camera and microphone
    stay disabled;
  - the browser joins with `livekit-client`, loaded on demand, using the backend's
    short-lived room token;
  - media never passes through HealthBridge, and nothing is recorded;
  - staging and production require a `wss://` LiveKit URL.

### Smoke test (`infra/deploy/smoke.mjs`)

- It is read-only.
- It checks:
  - TLS and the HTTP→HTTPS redirect;
  - the SPA and its security headers (HSTS, CSP without placeholders, `nosniff`, no
    version disclosure);
  - the API through the edge, with the expected version;
  - 401 for anonymous callers;
  - rejection of unsigned webhooks;
  - that internal surfaces are not exposed.

## Consequences

- The production stack was rehearsed on one machine with real TLS, ClamAV, STARTTLS
  SMTP, read-only containers, backups, a restore drill and a full disaster recovery.
  The results are recorded in OPERATIONS.md.
- The AWS path is defined and its manifests are tested, but it has **not been deployed**
  from this repository. It requires the provisioned resources listed in OPERATIONS.md.
- Only one database dump is kept per backup interval. A tighter RPO on a single host
  would need WAL archiving (for example WAL-G), which is not included.
- The single-host stack uses the MinIO root credentials for the application. On AWS the
  task role is scoped to the bucket.
