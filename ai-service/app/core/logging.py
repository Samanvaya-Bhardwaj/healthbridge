"""Structured JSON logging with request-ID correlation.

Logs carry metadata only. Prompts, model outputs, document text and any other medical
content must never be passed to a logger (ADR-0008, ADR-0012).
"""

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

SERVICE_NAME = "healthbridge-ai"

request_id_ctx: ContextVar[str | None] = ContextVar("request_id", default=None)

# Third-party loggers that can emit request/response bodies at DEBUG level.
# They are pinned to WARNING regardless of LOG_LEVEL so prompts never reach logs.
_CONTENT_BEARING_LOGGERS = ("anthropic", "httpx", "httpx2", "httpcore", "openai")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname.lower(),
            "service": SERVICE_NAME,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        request_id = request_id_ctx.get()
        if request_id:
            payload["requestId"] = request_id
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            payload.update(fields)
        if record.exc_info and record.exc_info[0] is not None:
            payload["error"] = {
                "type": record.exc_info[0].__name__,
                "stack": self.formatException(record.exc_info),
            }
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())

    for name in _CONTENT_BEARING_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    # We emit our own access log line (path only, no query string).
    logging.getLogger("uvicorn.access").disabled = True


def log_event(logger: logging.Logger, level: int, msg: str, **fields: Any) -> None:
    """Log a message with structured metadata fields."""
    logger.log(level, msg, extra={"fields": fields})
