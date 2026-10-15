"""PostgreSQL access for the AI service (least-privilege role, `ai` schema only)."""

import base64
import os
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Protocol

from psycopg.conninfo import make_conninfo
from psycopg_pool import AsyncConnectionPool

from app.core.config import Settings


class DatabaseLike(Protocol):
    async def open(self) -> None: ...
    async def close(self) -> None: ...
    async def ping(self) -> None: ...
    def patient_scope(self, patient_id: str) -> Any: ...
    async def spend_since(self, since: datetime) -> float: ...


def ssl_params(settings: Settings) -> dict[str, str]:
    """libpq TLS parameters; the CA bundle is written to a private temp file."""
    if settings.db_ssl == "disable":
        return {"sslmode": "disable"}
    params = {"sslmode": settings.db_ssl}
    if settings.db_ssl_ca:
        fd, path = tempfile.mkstemp(prefix="db-ca-", suffix=".pem")
        with os.fdopen(fd, "wb") as handle:
            handle.write(base64.b64decode(settings.db_ssl_ca.get_secret_value()))
        params["sslrootcert"] = path
    return params


class Database:
    def __init__(self, settings: Settings) -> None:
        conninfo = make_conninfo(
            host=settings.db_host,
            port=settings.db_port,
            dbname=settings.postgres_db,
            user=settings.db_ai_user,
            password=settings.db_ai_password.get_secret_value(),
            application_name="healthbridge-ai",
            connect_timeout=5,
            options="-c statement_timeout=15000",
            **ssl_params(settings),
        )
        self._pool = AsyncConnectionPool(
            conninfo,
            min_size=1,
            max_size=settings.db_pool_max,
            open=False,
            kwargs={"autocommit": True},
            # A pooled connection is checked before use, so a database restart costs a
            # reconnect instead of failing the next request.
            check=AsyncConnectionPool.check_connection,
        )

    async def open(self) -> None:
        # Do not block startup on the database; readiness reports it until reachable.
        await self._pool.open(wait=False)

    async def close(self) -> None:
        await self._pool.close()

    async def ping(self) -> None:
        async with self._pool.connection(timeout=2) as conn:
            await conn.execute("select 1")

    async def spend_since(self, since: datetime) -> float:
        """Estimated model spend of every run since `since` (ADR-0036): one total only."""
        async with self._pool.connection(timeout=2) as conn:
            cur = await conn.execute("SELECT ai.spend_since(%s)", (since,))
            row = await cur.fetchone()
        return float(row[0]) if row else 0.0

    @asynccontextmanager
    async def patient_scope(self, patient_id: str) -> AsyncIterator[Any]:
        """A transaction confined to one patient: RLS reads `ai.patient_id` (ADR-0022)."""
        async with self._pool.connection() as conn, conn.transaction():
            await conn.execute("SELECT set_config('ai.patient_id', %s, true)", (patient_id,))
            yield conn
