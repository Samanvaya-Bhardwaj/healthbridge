import pytest
from fastapi.testclient import TestClient

from tests.conftest import make_token


def test_meta_requires_a_token(client: TestClient) -> None:
    response = client.get("/v1/meta")
    assert response.status_code == 401
    assert response.json()["code"] == "unauthenticated"
    assert response.headers["www-authenticate"] == "Bearer"


def test_meta_accepts_a_valid_service_token(client: TestClient) -> None:
    response = client.get("/v1/meta", headers={"Authorization": f"Bearer {make_token()}"})
    assert response.status_code == 200
    body = response.json()
    assert body["caller"] == "healthbridge-api"
    assert body["llm"]["provider"] == "fake"


@pytest.mark.parametrize(
    ("description", "token"),
    [
        ("wrong secret", make_token(secret="x" * 48)),
        ("wrong audience", make_token(aud="some-other-service")),
        ("wrong issuer", make_token(iss="attacker")),
        ("expired", make_token(ttl=-120)),
        ("too long-lived", make_token(ttl=3600)),
        ("missing subject", make_token(sub=None)),
        ("not a jwt", "not-a-jwt"),
    ],
)
def test_meta_rejects_invalid_tokens(client: TestClient, description: str, token: str) -> None:
    response = client.get("/v1/meta", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401, description


def test_rejects_unsigned_alg_none_tokens(client: TestClient) -> None:
    import jwt

    token = jwt.encode(
        {"iss": "healthbridge-api", "aud": "healthbridge-ai", "sub": "x", "iat": 0, "exp": 9e9},
        key=None,
        algorithm="none",
    )
    response = client.get("/v1/meta", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
