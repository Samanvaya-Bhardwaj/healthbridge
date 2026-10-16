# Operations runbook

How to deploy, run, back up and recover HealthBridge
([ADR-0028](adr/0028-deployment-tls-backups-cd.md)).

> Real patient data requires the privacy, security and compliance review in
> [ADR-0008](adr/0008-llm-usage-and-phi-policy.md) **before** any of this is used with
> real people. Until then, deployments carry synthetic data only.

## 1. Single-host deployment (staging or small production)

**Server prerequisites:**

- Linux with Docker Engine 27+ and the Compose plugin;
- 4 vCPU and 8 GB RAM (ClamAV alone needs about 1.5–3 GB);
- a DNS name pointing at the host;
- ports 80 and 443 open, SSH restricted to administrators.

**First deployment:**

```bash
# 1. Backup key pair, created OFF the server. The identity (private key) stays offline.
age-keygen -o backup-identity.txt          # prints "public key: age1…"

# 2. Environment file with fresh secrets (on your workstation, then copy securely).
node infra/deploy/make-env.mjs --env staging --domain staging.example.org \
  --age-recipient age1… --version v1.0.0 > healthbridge.env
#    Fill in: SMTP_HOST/SMTP_USER/SMTP_PASSWORD (relay with STARTTLS), and for
#    production RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET (live), HB_ACME_EMAIL.
sudo install -m 600 -o root healthbridge.env /etc/healthbridge/healthbridge.env

# 3. Deployment definition on the server.
sudo mkdir -p /opt/healthbridge && sudo tar xzf infra.tgz -C /opt/healthbridge   # or git clone

# 4. TLS bootstrap: a temporary self-signed certificate lets Nginx start so that the
#    ACME HTTP-01 challenge can be served. Certbot then replaces it.
sudo mkdir -p /etc/healthbridge/tls
sudo openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
  -subj "/CN=staging.example.org" -keyout /etc/healthbridge/tls/privkey.pem \
  -out /etc/healthbridge/tls/fullchain.pem
C="docker compose -f infra/deploy/compose.prod.yml --env-file /etc/healthbridge/healthbridge.env"
$C up -d --wait
$C --profile acme up -d certbot && $C exec web nginx -s reload

# 5. Verify.
node infra/deploy/smoke.mjs https://staging.example.org --expect-version v1.0.0
```

**Settings that matter:**

- `APP_ENV=staging|production`. Production refuses demo data and fake providers.
- `PUBLIC_APP_URL` (https) is used for CORS, emailed links and presigned document URLs.
- The documents bucket is `healthbridge-documents`: the web container proxies that path.

**Operator access**, never public:

- Bull Board: `ssh -L 3010:127.0.0.1:3010 host`, then http://localhost:3010 (user `ops`,
  `BULL_BOARD_PASSWORD`).
- Metrics: `docker compose --profile observability` from the development stack layout,
  or scrape `api:9464`, `worker:9465` and `ai-service:8000/metrics` from a monitoring
  host on the private network.

## 2. Releases and rollback

- **Release:** push a `v*` tag. The CD pipeline builds and scans the images, deploys to
  staging, smoke-tests it (rolling back automatically on failure), then waits for
  production approval.
- **Repository configuration:**
  - **Staging variables:** `STAGING_HOST`, `STAGING_DOMAIN`, `STAGING_SSH_USER`.
  - **Staging secrets:** `STAGING_SSH_KEY` and `STAGING_SSH_KNOWN_HOSTS` (the output of
    `ssh-keyscan`, verified out of band).
  - **Production variables:** `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `ECS_CLUSTER`,
    `ECS_PRIVATE_SUBNETS`, `ECS_TASK_SECURITY_GROUP`, `DB_HOST`, `REDIS_HOST`,
    `S3_BUCKET_DOCUMENTS`, `MAIL_FROM`, `PRODUCTION_URL`, `RAZORPAY_KEY_ID`, and
    optionally `VIDEO_PROVIDER`, `LIVEKIT_URL` and `LLM_PROVIDER`.
  - **Production protection:** the `production` environment must have required
    reviewers.
- **Manual rollback:** run the CD workflow with `environment` and a previous `version`.
  On a single host you can also run:

  ```bash
  HB_VERSION=v1.0.0 $C up -d --wait
  ```

- **Schema changes:** migrations are forward-only in production. Every migration has a
  tested `down`, but rolling the database back is a restore decision, not a deployment
  step.

## 3. AWS production (ECS Fargate)

Provisioned by infrastructure-as-code (not part of this repository). The task
definitions in `infra/deploy/ecs/` expect:

| Resource | Requirements |
|---|---|
| VPC | Private subnets for tasks and data; public subnets for the ALB only |
| ALB | HTTPS listener (ACM certificate, TLS 1.2+ policy), HTTP→HTTPS redirect, target group → `web:8080`, health check `/healthz` |
| ECS | Cluster with Service Connect namespace; services `healthbridge-production-{api,worker,web,ai-service,clamav}` with deployment circuit breaker + rollback; aliases `api:4000`, `ai-service:8000`, `clamav:3310` |
| RDS | PostgreSQL 17 with `pgvector`, Multi-AZ, encrypted (KMS), **PITR enabled (RPO ≤ 15 min)**, `rds.force_ssl=1`; roles created by `infra/postgres/init/01-roles.sh` logic |
| ElastiCache | Redis 7, in-transit encryption + AUTH token, `noeviction` |
| S3 | `healthbridge-production-documents`: SSE-KMS, versioning, Block Public Access, CORS allowing the app origin (`POST`, `GET`), lifecycle for abandoned quarantine objects |
| Secrets Manager | `healthbridge/production` JSON with every key referenced in the task definitions (empty strings allowed for unused optional ones) |
| IAM | `healthbridge-production-execution` (pull from ECR, read the secret, write logs); task roles `…-api`, `…-worker` (S3 bucket only), `…-ai-service` (none); GitHub OIDC deploy role (ECR push, ECS register/run/update, `iam:PassRole` for these roles only) |
| SES | Verified domain; SMTP credentials stored in the secret |
| ECR | Repositories `healthbridge-{backend,web,ai}` with scan-on-push |

## 4. Backups

- **Schedule:** the `backup` service runs hourly (`BACKUP_INTERVAL_MINUTES`).
- **Each run produces:**
  - an age-encrypted `pg_dump`;
  - a row-count manifest taken in the same snapshot as the dump;
  - SHA-256 checksums;
  - an incremental rclone-crypt copy of the documents.
- **Off-site copies:** with `BACKUP_REMOTE=offsite:bucket/path` and the
  `BACKUP_OFFSITE_*` credentials, dumps and objects are also copied off the host.
- **Retention:** 48 hourly dumps plus 14 daily dumps locally.

**Commands:**

```bash
$C run --rm backup backup                                   # one backup now
$C run --rm -v /secure/backup-identity.txt:/run/secrets/backup-identity.txt:ro \
  backup drill                                              # restore drill (latest)
```

**Restore drill:** run it at least monthly and after every schema change. CI runs one on
every build. A drill passes only if the restored database reproduces the manifest
exactly: same migration, same row counts, same RLS tables and triggers, and the audit
guard triggers present.

## 5. Disaster recovery (single host)

1. Provision a fresh host (section 1, steps 2–3) with the **same** environment file.
2. Start only the data services:

   ```bash
   $C up -d --wait postgres minio
   ```

   The init scripts create the database roles.
3. Make sure the backups are present: either the `backups` volume survived, or the
   restore fetches them from `BACKUP_REMOTE`.
4. Restore:

   ```bash
   $C run --rm --no-deps -v /secure/backup-identity.txt:/run/secrets/backup-identity.txt:ro \
     backup restore <BACKUP_ID> --confirm          # add "--objects-from offsite" if needed
   ```

   It refuses a database that already has tables, verifies the manifest, then restores
   the documents.
5. Start everything (migrations find nothing pending), then run the smoke test:

   ```bash
   $C up -d --wait
   ```

On AWS, restore RDS by point-in-time recovery to a new instance and repoint `DB_HOST`.
Restore S3 from versioning or replication.

## 6. Key rotation

| Key | Procedure |
|---|---|
| `AUTH_JWT_PRIVATE_KEY` | Generate a new Ed25519 key. Move the old **public** key (SPKI PEM, base64) to `AUTH_JWT_PREVIOUS_PUBLIC_KEYS`, deploy, and remove it after one access-token TTL (10 min). |
| `CLINICAL_DATA_KEY` | Add a new key with a new `CLINICAL_DATA_KEY_ID`. Keep the old one in `CLINICAL_DATA_PREVIOUS_KEYS` (`keyId:base64`) so existing records still decrypt, and prescription and audit seals made with it still verify. New records and seals use the new key. Never delete a previous key while records or seals made with it exist. |
| `AI_INPUT_DIGEST_KEY` | Generate a new key (base64, 32 bytes) with a new `AI_INPUT_DIGEST_KEY_ID` and deploy the API and worker. No previous key is kept: these digests are telemetry, so runs before and after the rotation simply can't be compared. Never give this key to the AI service. **Upgrade note (M13.1):** add it to the production `.env` (compose) or Secrets Manager (`healthbridge/<env>`) before deploying; the API, worker and migrate task refuse to start without it outside development/test. |
| `PAYMENT_WEBHOOK_SECRET` | Rotate in the provider dashboard and in the secret at the same time. Webhooks are retried by the provider. |
| Database, Redis and MinIO passwords | Change in the service, then in the secret or env file. Restart the dependants. |
| Backup key | Create a new age key pair and update `BACKUP_AGE_RECIPIENT`. **Keep the old identity** for as long as backups encrypted with it are retained. |
| `BULL_BOARD_PASSWORD`, `GRAFANA_ADMIN_PASSWORD` | Change and restart the worker or Grafana. |

## 7. Incident basics

- **Is it up?** Run `smoke.mjs`, check the Prometheus alerts (ADR-0027), and check
  `docker compose ps` or the ECS service events.
- **Jobs stuck?** Check Admin → Operations (outbox, queues, dead letters, with audited
  retry). Bull Board is read-only.
- **Suspected account compromise:**
  - Admin → Users: disable the account (revokes every session) or sign it out
    everywhere.
  - Rotate the affected keys.
  - Review the audit log, filtered by actor or patient.
- **Never** copy production data to development. Use the synthetic demo data instead.

## 8. Rehearsal results (2026-10-03, this machine, synthetic data)

These were measured on a single machine (Docker Desktop, 8 GB), not on AWS. The AWS
path has not been deployed from this repository.

| Check | Result |
|---|---|
| Production stack as staging (`APP_ENV=staging`, TLS, ClamAV, STARTTLS SMTP, read-only containers, backups) | 12 containers: 10 healthy; `migrate` and `storage-init` completed. About 60 s |
| Smoke test (`smoke.mjs`) | 7/7 checks passed |
| Playwright journeys over HTTPS (patient, password reset through STARTTLS mail, admin, edge security) | 8/8 passed |
| Documents through presigned uploads, real ClamAV and the TLS edge | Clean PDF promoted. EICAR rejected before the scan by content validation. ClamAV adapter verified directly (`Eicar-Test-Signature`). Consented download bytes match. |
| Backup → restore drill | Pass: manifest identical (12 migrations, row counts, RLS tables, triggers, audit guard) |
| Tampered backup | Rejected by the checksum before restore |
| Full disaster recovery (data volumes deleted, restored from the encrypted backup alone) | Manifest verified, all 5 documents byte-identical, smoke 7/7. **71 s** recovery time for this small dataset (not an RTO for production volumes) |

**Defects found by the rehearsal and fixed:**

- Overriding the web container's command bypassed the Nginx entrypoint scripts, so TLS
  mode never switched on.
- The first scheduled backup ran before the bucket existed.
- The storage bootstrap refused to run in staging on self-hosted MinIO.
- An empty `S3_ENDPOINT` was rejected instead of treated as unset.

## 9. Practice eligibility (ADR-0030)

- **What happens on a closure:** when a clinic is made inactive, a doctor's membership ends, a doctor is suspended, or an account is disabled, the change records `practice.changed` in its own transaction. The appointments worker then withdraws the affected future bookings: party `system`, a full refund, and the patient notice "Appointment cancelled: please book another time".
- **Safety net:** the `eligibility-sweep` maintenance job (at the hold-sweep interval) runs the same withdrawal for anything missed, for example a status changed directly in the database.
- **Check:** `SELECT count(*) FROM appointments a WHERE a.status IN ('pending_payment','confirmed') AND a.starts_at > now() AND (NOT authz.doctor_is_bookable(a.doctor_id) OR NOT authz.practice_site_open(a.doctor_id, a.clinic_id));` should be 0 shortly after a change.
- **Reopening:** making a clinic active again does not restore withdrawn bookings. Patients book again.

## 10. Doctor search index (M13.2, ADR-0031)

- **Job:** `records-reembed` (once at worker start, 20 s after it) adds vectors of the current embedding model for opted-in patients' existing document chunks, and logs `document chunks re-embedded` with counts when it added any. `npm run records:reembed -w backend` (or `docker compose exec api node scripts/reembed-records.js`) runs it now (ADR-0039).
- **Job:** `doctor-search-index` (every 5 minutes, and once at worker start) embeds public doctor-profile text through the AI service. It re-embeds a doctor only when the profile text changes.
- **Without it:** search keeps working and ranks by text only. `GET /doctors/search` reports `meta.ranking: "lexical"` instead of `"hybrid"`.
- **Changing the embedding provider:** vectors from different models are not comparable. Run `DELETE FROM doctor_profile_embeddings;` and let the job rebuild the index. It is small: one row per doctor.
- **Changing the search vocabulary** (specialty terms or areas of practice) needs a migration, because a test compares `@healthbridge/shared` with `specialty_terms` and `practice_areas`.

## 11. Care assistant (M13.1)

- **Metrics:** API and worker `/metrics` now include:
  - `healthbridge_agent_runs_total{intent,outcome}`;
  - `healthbridge_agent_tool_calls_total{tool,outcome}`;
  - `healthbridge_agent_failures_total{kind}`;
  - `healthbridge_agent_latency_seconds`;
  - `healthbridge_agent_tool_latency_seconds`.

  The AI service adds `ai_agent_steps_total`; model spend appears under workflow `care_assistant_intent`.
- **What to watch:** a rising `healthbridge_agent_failures_total{kind="ai_unavailable"}` means the AI service or the model provider is down. The rest of the platform keeps working, and the assistant answers with a My Doctors fallback.
- **Retention:** the `records-housekeeping` maintenance job (every minute) deletes expired `agent_sessions` (24 h).
- **Daily model budget (step 10, ADR-0036):**
  - `LLM_DAILY_BUDGET_USD` (default 20) caps estimated spend per UTC day across all AI-service replicas. It is required with an external provider, and the AI service refuses to start without it.
  - Watch `ai_llm_spend_today_usd` and `ai_llm_budget_exhausted_total{workflow}`; the `LlmDailyBudgetReached` alert fires when calls are refused.
  - While refused, the assistant, briefs and record questions show their "unavailable" fallbacks, and emergency guidance is unaffected.
  - Raising the ceiling takes effect after an AI-service restart. Otherwise service resumes at 00:00 UTC.
- **Deferred document analysis:** during an AI outage, or with the budget reached, analysis answers 503 and nothing is stored. The `document.available` job retries with backoff (`JOB_MAX_ATTEMPTS`, `JOB_BACKOFF_MS`). After a long outage, retry the dead-lettered jobs from Admin → Operations.

## 12. Audit log integrity (step 9, ADR-0035)

- **Sealing:** the `audit-seal` maintenance job runs every 5 minutes. It seals entries older than 10 minutes into `audit.audit_seals` and logs `audit range sealed` with the seal number, end time, row count and chain value. Keep those log lines (CloudWatch or the compose log driver): they are the copy of the chain outside the database.
- **Checking:**
  - Admin → Audit log → **Check integrity** recomputes the latest 96 seals. Each check is audited.
  - `npm run audit:verify -w backend` (or `docker compose run --rm api node scripts/verify-audit.js`) checks the whole chain. It prints one JSON line and exits 1 on failure. Run it after every restore drill, and before and after any maintenance with owner access.
- **Metrics:** `healthbridge_audit_seals_written_total` should rise at least hourly. `healthbridge_audit_seal_verification_failures_total{problem}` should stay at 0.
- **If a check fails:**
  1. Treat it as a security incident (section 7). Do not "fix" the seal or the rows.
  2. Take a snapshot or backup of the database as it is now, for investigation.
  3. The failure names the seal and its time range. Compare that range with the most recent backup taken before it was sealed, and with the `audit range sealed` log lines.
  4. `rows_changed` means entries in that range differ from when they were sealed. `seal_altered` and `seal_missing` mean the seal table itself was edited. `key_unavailable` means a previous `CLINICAL_DATA_KEY` was removed from `CLINICAL_DATA_PREVIOUS_KEYS`; restore it.
  5. Restoring a database from backup restores its seals too. Verify again after the restore.
- **First deploy of step 9:** the first runs seal the existing history from the epoch in pieces of about 20,000 entries (up to 20 seals per run), so a large log catches up within a few runs.

## 13. Before every release (step 12)

Follow the checklist in [DEPLOYMENT_READINESS.md §2](DEPLOYMENT_READINESS.md):

1. Green gates and CI.
2. `node infra/deploy/preflight.mjs --env-file … --backend-image … --ai-image …`. It renders the deployment with Compose, validates each service's configuration inside its release image, and checks policy (external AI approval and spend ceiling, HTTPS, no demo data in production, distinct secrets, off-site backups). It prints names only and exits 1 on failure.
3. A backup, then `migrate status`.
4. Deploy.
5. The smoke test, `verify-audit.js`, and quiet alerts.

Production also needs the owner decisions listed in DEPLOYMENT_READINESS.md §1.
