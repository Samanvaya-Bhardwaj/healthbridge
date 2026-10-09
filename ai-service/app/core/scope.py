"""Per-request patient scope (ADR-0010, ADR-0022).

Every patient-data call carries, in addition to the service token, a backend-signed
scope token naming exactly one patient (and optionally the documents) the backend has
authorised for this purpose. The AI service runs its database work with that patient as
`ai.patient_id`, so RLS confines every read and write to the scope, and refuses requests
whose body names anything else.
"""

from dataclasses import dataclass, field
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import Depends, Header, Request

from app.core.errors import ProblemError

SCOPE_TOKEN_AUDIENCE = "healthbridge-ai-scope"  # noqa: S105 - claim identifier
SCOPE_TOKEN_ISSUER = "healthbridge-api"  # noqa: S105
MAX_SCOPE_LIFETIME_SECONDS = 300
PURPOSES = frozenset(
    {
        "document_analysis",
        "record_question",
        "doctor_brief",
        "follow_up_summary",
        # M13.1: the care assistant acting for this patient (self or a managed dependent).
        "care_assistant",
    }
)


@dataclass(frozen=True)
class PatientScope:
    patient_id: str
    purpose: str
    document_ids: frozenset[str] = field(default_factory=frozenset)

    def require_patient(self, patient_id: str) -> None:
        if patient_id != self.patient_id:
            raise _forbidden()

    def require_document(self, document_id: str) -> None:
        if document_id not in self.document_ids:
            raise _forbidden()


def _forbidden() -> ProblemError:
    return ProblemError(
        403, "out_of_scope", "Out of scope", "Request is outside the patient scope."
    )


def _invalid() -> ProblemError:
    return ProblemError(
        401, "invalid_scope", "Invalid scope", "Valid patient scope token required."
    )


def _uuid(value: object) -> str:
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError) as exc:
        raise _invalid() from exc


def verify_scope_token(token: str, secret: str) -> PatientScope:
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience=SCOPE_TOKEN_AUDIENCE,
            issuer=SCOPE_TOKEN_ISSUER,
            leeway=5,
            options={"require": ["exp", "iat", "iss", "aud", "pid", "purpose"]},
        )
    except jwt.PyJWTError as exc:
        raise _invalid() from exc
    if claims["exp"] - claims["iat"] > MAX_SCOPE_LIFETIME_SECONDS:
        raise _invalid()
    if claims.get("typ") != "patient_scope" or claims["purpose"] not in PURPOSES:
        raise _invalid()
    docs = claims.get("docs") or []
    if not isinstance(docs, list) or len(docs) > 200:
        raise _invalid()
    return PatientScope(
        patient_id=_uuid(claims["pid"]),
        purpose=claims["purpose"],
        document_ids=frozenset(_uuid(d) for d in docs),
    )


async def require_patient_scope(
    request: Request,
    x_patient_scope: Annotated[str | None, Header()] = None,
) -> PatientScope:
    if not x_patient_scope:
        raise _invalid()
    secret = request.app.state.settings.internal_service_secret.get_secret_value()
    return verify_scope_token(x_patient_scope, secret)


ScopeDep = Annotated[PatientScope, Depends(require_patient_scope)]
