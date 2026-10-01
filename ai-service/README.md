# HealthBridge AI service

Internal FastAPI service for document intelligence, patient-scoped retrieval and bounded
agent workflows. **Not exposed publicly**: only the backend calls it, with a short-lived
service JWT.

Invariant (ADR-0004): **AI proposes → backend validates → backend commits.** This service
writes only AI artifacts (`ai` schema) and never modifies clinical records.

```bash
uv sync                      # install (Python 3.12)
uv run pytest                # tests (offline; uses FakeLLMProvider)
uv run ruff check . && uv run ruff format --check .
uv run uvicorn app.main:create_app --factory --reload --port 8000
```

See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) and ADR-0007/0008/0012 for the LLM
provider abstraction, PHI policy and AI execution records.
