"""Step 10: the daily ceiling on estimated model spend (ADR-0036)."""

from datetime import UTC, datetime, timedelta

import pytest

from app.llm.base import LLMError, LLMErrorKind, LLMMessage, LLMRequest, ModelTier
from app.llm.budget import SpendGuard, utc_day_start
from app.llm.instrumented import InstrumentedLLMProvider
from app.llm.providers.fake import FakeLLMProvider


class Clock:
    def __init__(self) -> None:
        self.seconds = 0.0
        self.at = datetime(2026, 10, 15, 22, 0, tzinfo=UTC)

    def advance(self, seconds: float) -> None:
        self.seconds += seconds
        self.at += timedelta(seconds=seconds)


class Ledger:
    """Stands in for `ai.spend_since()`: what every replica has recorded per day."""

    def __init__(self) -> None:
        self.by_day: dict[datetime, float] = {}
        self.reads: list[datetime] = []

    async def read(self, since: datetime) -> float:
        self.reads.append(since)
        return self.by_day.get(since, 0.0)


def guard_with(limit: float, ledger: Ledger, clock: Clock) -> SpendGuard:
    return SpendGuard(
        limit, ledger.read, refresh_seconds=30, clock=lambda: clock.seconds, now=lambda: clock.at
    )


def request(workflow: str = "care_assistant_intent") -> LLMRequest:
    return LLMRequest(
        workflow=workflow,
        tier=ModelTier.FAST,
        messages=[LLMMessage(role="user", content="synthetic")],
    )


async def test_calls_pass_under_the_ceiling_and_stop_at_it() -> None:
    clock, ledger = Clock(), Ledger()
    ledger.by_day[utc_day_start(clock.at)] = 9.0
    guard = guard_with(10.0, ledger, clock)
    await guard.check("w", "claude")  # 9.00 of 10.00
    guard.record(0.6)
    await guard.check("w", "claude")  # 9.60: still under
    guard.record(0.5)
    with pytest.raises(LLMError) as raised:
        await guard.check("w", "claude")  # 10.10: this replica's own spend counts at once
    assert raised.value.kind is LLMErrorKind.BUDGET_EXHAUSTED
    assert raised.value.retryable  # a passing condition: callers defer, never store it
    assert len(ledger.reads) == 1  # within the refresh interval: no extra query


async def test_other_replicas_count_after_a_refresh_and_a_new_day_starts_over() -> None:
    clock, ledger = Clock(), Ledger()
    today = utc_day_start(clock.at)
    guard = guard_with(10.0, ledger, clock)
    await guard.check("w", "claude")
    ledger.by_day[today] = 12.0  # other replicas spent meanwhile
    await guard.check("w", "claude")  # not refreshed yet
    clock.advance(31)
    with pytest.raises(LLMError):
        await guard.check("w", "claude")
    clock.advance(2 * 3600)  # past midnight UTC
    await guard.check("w", "claude")
    assert ledger.reads[-1] == today + timedelta(days=1)


async def test_the_provider_is_not_called_once_the_ceiling_is_reached() -> None:
    clock, ledger = Clock(), Ledger()
    ledger.by_day[utc_day_start(clock.at)] = 10.0
    inner = FakeLLMProvider()
    llm = InstrumentedLLMProvider(inner, guard_with(10.0, ledger, clock))
    with pytest.raises(LLMError) as raised:
        await llm.generate(request())
    assert raised.value.kind is LLMErrorKind.BUDGET_EXHAUSTED
    assert inner.calls == []


async def test_without_a_guard_nothing_changes() -> None:
    inner = FakeLLMProvider()
    response = await InstrumentedLLMProvider(inner).generate(request())
    assert response.text
    assert len(inner.calls) == 1
