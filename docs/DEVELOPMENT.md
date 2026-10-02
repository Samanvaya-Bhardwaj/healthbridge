# Local development

## Prerequisites

- Node.js 24 (`.nvmrc`)
- Docker Desktop with the WSL2 backend (on Windows)
- Optional: [uv](https://docs.astral.sh/uv/) and Python 3.12, to run the AI service outside
  Docker
- Clone **outside** OneDrive or Dropbox folders (ADR-0014), e.g. `C:\dev\healthbridge`

## First run

```bash
npm ci
node scripts/generate-env.mjs        # .env with random secrets; remaps busy host ports
docker compose up -d --build --wait  # full stack
```

`generate-env` prints the web URL. It is `http://localhost:8080` unless that port is
already in use, in which case it picks the next free port (e.g. 8081).

To use Claude instead of the offline fake LLM, set `LLM_PROVIDER=claude` and
`ANTHROPIC_API_KEY=...` in `.env`, then run `docker compose up -d ai-service`.
**Use synthetic data only** (ADR-0008).

## Services

| Service | Host URL / port | Notes |
|---|---|---|
| Web (Nginx + SPA) | `http://localhost:${HOST_PORT_WEB}` | proxies `/api/` |
| API | `http://localhost:${HOST_PORT_API}` | `/health/live`, `/health/ready`, `/api/v1/*` |
| AI service | not published | internal only; `docker compose exec api …` to reach it |
| PostgreSQL | `localhost:${HOST_PORT_POSTGRES}` | owner `hb_owner`; runtime roles `hb_app`, `hb_ai` |
| Redis | `localhost:${HOST_PORT_REDIS}` | password-protected, AOF, `noeviction` |
| MinIO | API `:${HOST_PORT_MINIO}`, console `:${HOST_PORT_MINIO_CONSOLE}` | bucket `healthbridge-documents`, versioned |
| Mailpit | UI `:${HOST_PORT_MAILPIT_UI}`, SMTP `:${HOST_PORT_SMTP}` | captures all outgoing email (worker notifications) |
| Worker | not published (`:9465` inside the network) | outbox relay, BullMQ workers, hold and reminder sweeps; `npm run worker -w backend` on the host |

All published ports bind to `127.0.0.1`.

## Accounts (synthetic only)

```bash
npm run seed:demo -w backend    # one synthetic account per role (@demo.healthbridge.local)
```

All demo accounts use `DEMO_USER_PASSWORD` from `.env`. Public registration creates
PATIENT accounts only. Staff accounts are provisioned by a platform admin, or with:

```bash
BOOTSTRAP_PASSWORD='…' npm run user:create -w backend -- \
  --email admin@example.org --name "Platform Admin" --role PLATFORM_ADMIN
```

After pulling changes that add environment variables, run
`node scripts/generate-env.mjs --update`. It appends only the missing variables and
never rotates existing secrets.

## Day-to-day

```bash
# Data services in Docker, apps on the host (hot reload)
docker compose up -d --wait postgres redis minio mailpit
npm run migrate:latest -w backend
npm run storage:bootstrap -w backend
npm run seed:demo -w backend      # optional
npm run dev -w backend               # http://localhost:4000
npm run dev -w frontend              # http://localhost:5173 (proxies /api → :4000)

# AI service on the host
cd ai-service && uv sync && uv run uvicorn app.main:create_app --factory --reload --port 8000
```

When running the backend on the host, the AI service must also be reachable at
`AI_SERVICE_URL`. Otherwise readiness reports it as `degraded`, which is non-critical.

## Tests and quality

```bash
npm run lint && npm run format:check
npm run test -w backend              # unit
npm run test:integration -w backend  # needs postgres, redis, minio + migrations; stop the worker first:
                                     #   docker compose stop worker   (tests refuse to run alongside one)
npm run test -w frontend
cd ai-service && uv run ruff check . && uv run ruff format --check . && uv run pytest
# or, without local Python:
docker build --target dev -t healthbridge-ai:dev ai-service && docker run --rm healthbridge-ai:dev
```

## Database migrations

```bash
npm run migrate:make -w backend -- <name>   # new migration in backend/migrations
npm run migrate:latest -w backend
npm run migrate:rollback -w backend
npm run migrate:status -w backend           # exits 2 if migrations are pending
```

Migrations run as the owner role. Runtime roles get privileges through default
privileges set in the foundation migration, so new tables are automatically accessible
to `hb_app` (in `public`) and `hb_ai` (in `ai` only).

## Resetting

```bash
docker compose down -v                    # removes all local data volumes
node scripts/generate-env.mjs --force     # new secrets (requires the reset above)
```

## Troubleshooting

- **Port already allocated / access forbidden:** another local service (e.g. PostgreSQL
  on 5432 or Apache on 8080) holds the port. Re-run `generate-env --force` after
  `docker compose down -v`, or edit the `HOST_PORT_*` values.
- **CRLF errors in shell scripts:** `.gitattributes` enforces LF. Re-checkout if your
  editor converted line endings.

## Payments in development

`PAYMENT_PROVIDER=fake` (the default) moves no money. On the payment page, **Simulate
successful/failed payment** makes the server emit a signed test webhook through the real
verification path. Refunds settle automatically: the worker emulates the provider's
`refund.processed` webhook.

To try Razorpay's test mode, set `PAYMENT_PROVIDER=razorpay` with `rzp_test_…` keys and the
webhook secret. Live keys are refused outside production. Webhooks need a public URL
(for example a tunnel) pointing at `/api/v1/webhooks/payments/razorpay`.

## Medical documents in development

- Uploads and downloads go through Nginx at `/healthbridge-documents/…` using presigned
  URLs signed for `http://localhost:${HOST_PORT_WEB}`. Open the app on `localhost`, not
  `127.0.0.1`: the host is part of the signature.
- `DOCUMENT_SCANNER=fake` (default) is deterministic and provides **no protection**:
  - files containing the EICAR test string are rejected as infected;
  - the marker `HB-FAKE-SCANNER-FAILURE` simulates a scanner outage.
- For real scanning, run `docker compose --profile scanner up -d clamav` and set
  `DOCUMENT_SCANNER=clamav` and `CLAMAV_HOST=clamav`.
- Use synthetic files only. Never upload real medical documents.

## Document intelligence in development

- `LLM_PROVIDER=fake` (default) uses deterministic rule-based handlers. They read synthetic
  lab reports in the format `Analyte: value unit (ref low-high)` and quote the source.
- `EMBEDDING_PROVIDER=hashing` (default) is offline.
- Opt in from Health Records ("Read my documents…"), upload a synthetic PDF, and open
  "Extracted values".
- AI service database tests run on the compose network:
  `docker run --rm --network healthbridge_private -e AI_DB_TESTS=1 -e DB_HOST=postgres … healthbridge-ai:dev pytest`.
