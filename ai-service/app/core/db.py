"""PostgreSQL access for the AI service (least-privilege role, `ai` schema only)."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Protocol

from psycopg.conninfo import make_conninfo
from psycopg_pool import AsyncConnectionPool

from app.core.config import Settings


class DatabaseLike(Protocol):
    async def open(self) -> None: ...
    async def close(self) -> None: ...
    async def ping(self) -> None: ...
    def patient_scope(self, patient_id: str) -> Any: ...


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
        )
        self._pool = AsyncConnectionPool(
            conninfo,
            min_size=1,
            max_size=settings.db_pool_max,
            open=False,
            kwargs={"autocommit": True},
        )

    async def open(self) -> None:
        # Do not block startup on the database; readiness reports it until reachable.
        await self._pool.open(wait=False)

    async def close(self) -> None:
        await self._pool.close()

    async def ping(self) -> None:
        async with self._pool.connection(timeout=2) as conn:
            await conn.execute("select 1")

    @asynccontextmanager
    async def patient_scope(self, patient_id: str) -> AsyncIterator[Any]:
        """A transaction confined to one patient: RLS reads `ai.patient_id` (ADR-0022)."""
        async with self._pool.connection() as conn, conn.transaction():
            await conn.execute("SELECT set_config('ai.patient_id', %s, true)", (patient_id,))
            yield conn
