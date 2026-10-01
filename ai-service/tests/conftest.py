import time
from collections.abc import Iterator

import jwt
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.security import SERVICE_TOKEN_AUDIENCE, SERVICE_TOKEN_ISSUER
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


class FakeDatabase:
    def __init__(self, healthy: bool = True) -> None:
        self.healthy = healthy
        self.opened = False
        self.closed = False

    async def open(self) -> None:
        self.opened = True

    async def close(self) -> None:
        self.closed = True

    async def ping(self) -> None:
        if not self.healthy:
            raise ConnectionRefusedError("database unreachable")


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
        llm_provider=InstrumentedLLMProvider(FakeLLMProvider()),
    )
    with TestClient(app) as test_client:
        yield test_client
