import pytest
from pydantic import ValidationError

from tests.conftest import make_settings


def test_valid_development_settings() -> None:
    settings = make_settings()
    assert settings.llm_provider == "fake"
    assert not settings.llm_is_external


def test_rejects_short_internal_secret() -> None:
    with pytest.raises(ValidationError, match="INTERNAL_SERVICE_SECRET"):
        make_settings(internal_service_secret="short")


def test_claude_requires_an_api_key() -> None:
    with pytest.raises(ValidationError, match="ANTHROPIC_API_KEY"):
        make_settings(llm_provider="claude", anthropic_api_key="")


def test_production_blocks_external_llm_without_explicit_approval() -> None:
    with pytest.raises(ValidationError, match="LLM_EXTERNAL_PROCESSING_APPROVED"):
        make_settings(app_env="production", llm_provider="claude", anthropic_api_key="sk-test")


def test_production_allows_external_llm_after_approval() -> None:
    settings = make_settings(
        app_env="production",
        llm_provider="claude",
        anthropic_api_key="sk-test",
        llm_external_processing_approved=True,
    )
    assert settings.llm_is_external


def test_production_rejects_fake_provider() -> None:
    with pytest.raises(ValidationError, match="not allowed in production"):
        make_settings(app_env="production", llm_provider="fake")


def test_secrets_are_not_exposed_in_repr() -> None:
    settings = make_settings(llm_provider="claude", anthropic_api_key="sk-very-secret")
    assert "sk-very-secret" not in repr(settings)
    assert "t" * 48 not in repr(settings)


def test_database_tls_parameters() -> None:
    import base64

    from app.core.db import ssl_params

    assert ssl_params(make_settings()) == {"sslmode": "disable"}
    assert ssl_params(make_settings(db_ssl="require")) == {"sslmode": "require"}
    pem = b"-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n"
    params = ssl_params(
        make_settings(db_ssl="verify-full", db_ssl_ca=base64.b64encode(pem).decode())
    )
    assert params["sslmode"] == "verify-full"
    with open(params["sslrootcert"], "rb") as handle:
        assert handle.read() == pem
