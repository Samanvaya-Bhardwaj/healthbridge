"""Keyed input digests computed by the backend (ADR-0012, ADR-0029).

An AI run record keeps a digest of its input instead of the input. For free-text inputs
(a care-assistant message, a record question, a follow-up check-in) the backend sends an
HMAC-SHA256 under its own key, with the ID of that key. This service never holds the key
and never hashes free text itself: it validates the shape and stores both values.
"""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


class InputDigest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    keyId: Annotated[str, Field(pattern=r"^[a-z0-9_-]{1,32}$")]
    value: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
