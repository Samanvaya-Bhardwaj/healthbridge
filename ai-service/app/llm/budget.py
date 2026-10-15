"""Daily ceiling on estimated model spend (ADR-0036).

The total for the current UTC day comes from `ai.spend_since()` (every replica's recorded
runs) and is refreshed at most every `refresh_seconds`. Calls this replica made since the
last refresh are added locally, so the ceiling holds between refreshes as well. It is a
soft ceiling: calls already in flight when it is reached still finish.
"""

import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from app.core.metrics import LLM_BUDGET_EXHAUSTED, LLM_SPEND_TODAY
from app.llm.base import LLMError, LLMErrorKind


def utc_day_start(at: datetime) -> datetime:
    return at.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)


class SpendGuard:
    def __init__(
        self,
        limit_usd: float,
        read_spent: Callable[[datetime], Awaitable[float]],
        *,
        refresh_seconds: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.limit_usd = limit_usd
        self._read_spent = read_spent
        self._refresh_seconds = refresh_seconds
        self._clock = clock
        self._now = now
        self._day: datetime | None = None
        self._recorded = 0.0  # spend recorded in the database at the last refresh
        self._local = 0.0  # this replica's spend since then
        self._refreshed_at: float | None = None

    async def _refresh(self) -> None:
        day = utc_day_start(self._now())
        stale = (
            self._refreshed_at is None
            or self._clock() - self._refreshed_at >= self._refresh_seconds
            or day != self._day
        )
        if not stale:
            return
        self._recorded = float(await self._read_spent(day))
        self._local = 0.0
        self._day = day
        self._refreshed_at = self._clock()

    @property
    def spent_usd(self) -> float:
        return self._recorded + self._local

    async def check(self, workflow: str, provider: str) -> None:
        """Raises `budget_exhausted` once today's spend has reached the ceiling."""
        await self._refresh()
        LLM_SPEND_TODAY.set(self.spent_usd)
        if self.spent_usd >= self.limit_usd:
            LLM_BUDGET_EXHAUSTED.labels(workflow).inc()
            raise LLMError(
                LLMErrorKind.BUDGET_EXHAUSTED, "daily model budget reached", provider=provider
            )

    def record(self, cost_usd: float | None) -> None:
        if cost_usd:
            self._local += cost_usd
            LLM_SPEND_TODAY.set(self.spent_usd)
