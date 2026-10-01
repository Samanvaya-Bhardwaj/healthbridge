"""Internal service authentication: only the HealthBridge backend may call this service.

The backend signs a short-lived HS256 JWT (iss=healthbridge-api, aud=healthbridge-ai).
Per-request patient scope tokens are layered on top when patient-data endpoints arrive.
"""

from dataclasses import dataclass
from typing import Annotated

import jwt
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.errors import ProblemError

# Token claim identifiers, not credentials.
SERVICE_TOKEN_ISSUER = "healthbridge-api"  # noqa: S105
SERVICE_TOKEN_AUDIENCE = "healthbridge-ai"  # noqa: S105
MAX_TOKEN_LIFETIME_SECONDS = 300
CLOCK_SKEW_SECONDS = 5

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class ServicePrincipal:
    subject: str


def _unauthorized() -> ProblemError:
    return ProblemError(401, "unauthenticated", "Unauthenticated", "Valid service token required.")


def verify_service_token(token: str, secret: str) -> ServicePrincipal:
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience=SERVICE_TOKEN_AUDIENCE,
            issuer=SERVICE_TOKEN_ISSUER,
            leeway=CLOCK_SKEW_SECONDS,
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise _unauthorized() from exc
    # Reject long-lived tokens even if correctly signed.
    if claims["exp"] - claims["iat"] > MAX_TOKEN_LIFETIME_SECONDS:
        raise _unauthorized()
    return ServicePrincipal(subject=claims["sub"])


async def require_service_token(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> ServicePrincipal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _unauthorized()
    secret = request.app.state.settings.internal_service_secret.get_secret_value()
    return verify_service_token(credentials.credentials, secret)
