import time
from collections.abc import Iterator
from contextlib import asynccontextmanager

import jwt
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.security import SERVICE_TOKEN_AUDIENCE, SERVICE_TOKEN_ISSUER
from app.llm.fake_handlers import DEFAULT_HANDLERS
from app.llm.instrumented import InstrumentedLLMProvider
from app.llm.providers.fake import FakeLLMProvider
from app.main import create_app

SECRET = "t" * 48


def make_settings(**overrides) -> Settings:
    values = {
        "app_env": "test",
        "db_host": "localhost",
        "postgres_db": "healthbridge",
        "db_ai_user": "hb_ai",
        "db_ai_password": "test",
        "internal_service_secret": SECRET,
        "llm_provider": "fake",
        "anthropic_api_key": None,
    }
    values.update(overrides)
    return Settings(**values)


class _Cursor:
    def __init__(self, row) -> None:
        self._row = row

    async def fetchone(self):
        return self._row


class FakeConnection:
    """Records SQL and parameters; answers the few reads the AI store makes."""

    def __init__(self, db: "FakeDatabase", patient_id: str) -> None:
        self.db = db
        self.patient_id = patient_id

    async def execute(self, sql: str, params=()):
        self.db.statements.append((self.patient_id, " ".join(sql.split()), params))
        if "max(version)" in sql:
            versions = [e["version"] for e in self.db.extractions if e["document_id"] == params[0]]
            return _Cursor((max(versions, default=0) + 1,))
        if sql.lstrip().startswith("SELECT id, version"):
            doc, input_hash, prompt = params
            for e in reversed(self.db.extractions):
                if (e["document_id"], e["input_sha256"], e["prompt_version"]) == (
                    doc,
                    input_hash,
                    prompt,
                ):
                    keys = [
                        "id",
                        "version",
                        "status",
                        "text_source",
                        "classification",
                        "fields",
                        "dropped_field_count",
                        "injection_flags",
                        "run_id",
                    ]
                    return _Cursor(tuple(e[k] for k in keys))
            return _Cursor(None)
        if "INSERT INTO ai.document_extractions" in sql:
            import json

            (
                id_,
                pid,
                doc,
                _dtype,
                version,
                run,
                input_hash,
                prompt,
                status,
                source,
                cls,
                fields,
                dropped,
                flags,
            ) = params
            self.db.extractions.append(
                {
                    "id": id_,
                    "patient_id": pid,
                    "document_id": doc,
                    "version": version,
                    "run_id": run,
                    "input_sha256": input_hash,
                    "prompt_version": prompt,
                    "status": status,
                    "text_source": source,
                    "classification": json.loads(cls),
                    "fields": json.loads(fields),
                    "dropped_field_count": dropped,
                    "injection_flags": flags,
                }
            )
        return _Cursor(None)


class FakeDatabase:
    def __init__(self, healthy: bool = True) -> None:
        self.healthy = healthy
        self.opened = False
        self.closed = False
        self.statements: list = []
        self.extractions: list = []
        self.scopes: list[str] = []

    @asynccontextmanager
    async def patient_scope(self, patient_id: str):
        self.scopes.append(patient_id)
        yield FakeConnection(self, patient_id)

    async def open(self) -> None:
        self.opened = True

    async def close(self) -> None:
        self.closed = True

    async def ping(self) -> None:
        if not self.healthy:
            raise ConnectionRefusedError("database unreachable")


def make_scope_token(
    patient_id: str,
    documents: list[str] | None = None,
    purpose: str = "document_analysis",
    secret: str = SECRET,
    ttl: int = 60,
    **overrides,
) -> str:
    now = int(time.time())
    claims = {
        "iss": "healthbridge-api",
        "aud": "healthbridge-ai-scope",
        "typ": "patient_scope",
        "pid": patient_id,
        "docs": documents or [],
        "purpose": purpose,
        "iat": now,
        "exp": now + ttl,
    }
    claims.update(overrides)
    return jwt.encode(claims, secret, algorithm="HS256")


def make_token(secret: str = SECRET, ttl: int = 60, **overrides) -> str:
    now = int(time.time())
    claims = {
        "iss": SERVICE_TOKEN_ISSUER,
        "aud": SERVICE_TOKEN_AUDIENCE,
        "sub": "healthbridge-api",
        "iat": now,
        "exp": now + ttl,
    }
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, secret, algorithm="HS256")


@pytest.fixture
def database() -> FakeDatabase:
    return FakeDatabase()


@pytest.fixture
def client(database: FakeDatabase) -> Iterator[TestClient]:
    app = create_app(
        make_settings(),
        database=database,
        llm_provider=InstrumentedLLMProvider(FakeLLMProvider(dict(DEFAULT_HANDLERS))),
    )
    with TestClient(app) as test_client:
        yield test_client
