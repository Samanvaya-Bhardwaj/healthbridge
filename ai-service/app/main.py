"""HealthBridge AI service application factory.

Run: uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
"""

import logging
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response

from app.api import assist, documents, health, internal
from app.core.config import Settings, get_settings
from app.core.db import Database, DatabaseLike
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging, log_event, request_id_ctx
from app.embeddings import EmbeddingProvider, HashingEmbeddingProvider, VoyageEmbeddingProvider
from app.llm.base import LLMProvider
from app.llm.factory import build_llm_provider

logger = logging.getLogger("healthbridge.ai")

_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9-]{16,64}$")


def create_app(
    settings: Settings | None = None,
    *,
    database: DatabaseLike | None = None,
    llm_provider: LLMProvider | None = None,
    embedding_provider: EmbeddingProvider | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    expose_docs = settings.app_env in ("development", "test")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db = database or Database(settings)
        await db.open()
        llm = llm_provider or build_llm_provider(settings)
        embedder = embedding_provider or (
            VoyageEmbeddingProvider(
                api_key=settings.voyage_api_key.get_secret_value(),
                model=settings.voyage_model,
                timeout_seconds=settings.llm_timeout_seconds,
            )
            if settings.embedding_provider == "voyage" and settings.voyage_api_key
            else HashingEmbeddingProvider()
        )
        app.state.db = db
        app.state.llm = llm
        app.state.embedder = embedder
        log_event(
            logger,
            logging.INFO,
            "ai service started",
            appEnv=settings.app_env,
            llmProvider=llm.name,
        )
        try:
            yield
        finally:
            await llm.aclose()
            await embedder.aclose()
            await db.close()

    app = FastAPI(
        title="HealthBridge AI service (internal)",
        version=settings.service_version,
        lifespan=lifespan,
        docs_url="/docs" if expose_docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if expose_docs else None,
    )
    app.state.settings = settings

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        incoming = request.headers.get("x-request-id")
        request_id = incoming if incoming and _SAFE_REQUEST_ID.match(incoming) else uuid.uuid4().hex
        token = request_id_ctx.set(request_id)
        started = time.perf_counter()
        try:
            response = await call_next(request)
            response.headers["X-Request-Id"] = request_id
            if not request.url.path.startswith("/health"):
                log_event(
                    logger,
                    logging.INFO,
                    "request completed",
                    method=request.method,
                    path=request.url.path,  # never the query string
                    status=response.status_code,
                    durationMs=round((time.perf_counter() - started) * 1000),
                )
            return response
        finally:
            request_id_ctx.reset(token)

    register_exception_handlers(app)
    app.include_router(health.router)
    app.include_router(internal.router)
    app.include_router(documents.router)
    app.include_router(assist.router)
    return app
