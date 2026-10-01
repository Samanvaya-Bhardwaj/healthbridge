"""Service configuration, validated at startup (fail fast, never echo secret values)."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

AppEnv = Literal["development", "test", "staging", "production"]
LLMProviderName = Literal["claude", "fake"]

# Providers that send data outside HealthBridge infrastructure.
EXTERNAL_LLM_PROVIDERS: frozenset[str] = frozenset({"claude"})
MIN_SECRET_LENGTH = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    app_env: AppEnv = "development"
    log_level: str = "INFO"
    service_version: str = "0.1.0"

    db_host: str
    db_port: int = 5432
    postgres_db: str
    db_ai_user: str
    db_ai_password: SecretStr
    db_pool_max: int = Field(default=5, ge=1, le=50)

    internal_service_secret: SecretStr

    llm_provider: LLMProviderName = "fake"
    anthropic_api_key: SecretStr | None = None
    llm_model_default: str = "claude-opus-5-5"
    llm_model_fast: str = "claude-haiku-4-5"
    llm_timeout_seconds: float = Field(default=60.0, gt=0, le=600)
    llm_max_retries: int = Field(default=2, ge=0, le=5)
    llm_refusal_fallback: bool = True
    llm_external_processing_approved: bool = False

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def llm_is_external(self) -> bool:
        return self.llm_provider in EXTERNAL_LLM_PROVIDERS

    @model_validator(mode="after")
    def _validate(self) -> "Settings":
        if len(self.internal_service_secret.get_secret_value()) < MIN_SECRET_LENGTH:
            raise ValueError(f"INTERNAL_SERVICE_SECRET must be at least {MIN_SECRET_LENGTH} chars")

        if self.llm_provider == "claude" and not (
            self.anthropic_api_key and self.anthropic_api_key.get_secret_value()
        ):
            raise ValueError("ANTHROPIC_API_KEY is required when LLM_PROVIDER=claude")

        if self.is_production:
            if self.llm_provider == "fake":
                raise ValueError("LLM_PROVIDER=fake is not allowed in production")
            # ADR-0008: an external LLM may only process data in production after an explicit
            # privacy/security/compliance review and contractual/provider controls are in place.
            if self.llm_is_external and not self.llm_external_processing_approved:
                raise ValueError(
                    "External LLM processing in production requires "
                    "LLM_EXTERNAL_PROCESSING_APPROVED=true (see ADR-0008)"
                )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # populated from environment
