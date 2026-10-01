"""Problem-details (RFC 9457) error responses, consistent with the Node backend."""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import request_id_ctx

logger = logging.getLogger(__name__)

PROBLEM_MEDIA_TYPE = "application/problem+json"


class ProblemError(Exception):
    def __init__(self, status: int, code: str, title: str, detail: str | None = None) -> None:
        super().__init__(detail or title)
        self.status = status
        self.code = code
        self.title = title
        self.detail = detail


def problem_response(
    request: Request,
    status: int,
    code: str,
    title: str,
    detail: str | None = None,
    **extensions: object,
) -> JSONResponse:
    body = {
        "type": f"https://healthbridge.dev/problems/{code}",
        "title": title,
        "status": status,
        "detail": detail or title,
        "instance": request.url.path,
        "code": code,
        "requestId": request_id_ctx.get(),
        **extensions,
    }
    headers = {"WWW-Authenticate": "Bearer"} if status == 401 else None
    return JSONResponse(body, status_code=status, media_type=PROBLEM_MEDIA_TYPE, headers=headers)


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ProblemError)
    async def _problem(request: Request, exc: ProblemError) -> JSONResponse:
        return problem_response(request, exc.status, exc.code, exc.title, exc.detail)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Field locations and messages only; input values are not echoed (may contain PHI).
        errors = [
            {"path": ".".join(str(p) for p in err["loc"]), "message": err["msg"]}
            for err in exc.errors()
        ]
        return problem_response(
            request, 422, "validation_failed", "Validation failed", errors=errors
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = "not_found" if exc.status_code == 404 else f"http_{exc.status_code}"
        return problem_response(request, exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled error")
        return problem_response(
            request, 500, "internal_error", "Internal server error", "An unexpected error occurred."
        )
