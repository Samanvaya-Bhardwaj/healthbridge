from fastapi.testclient import TestClient

from tests.conftest import FakeDatabase


def test_live_is_ok_and_unauthenticated(client: TestClient) -> None:
    response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_ready_when_database_is_up(client: TestClient) -> None:
    response = client.get("/health/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["checks"]["database"]["status"] == "up"
    assert body["checks"]["llm"]["provider"] == "fake"


def test_not_ready_when_database_is_down(client: TestClient, database: FakeDatabase) -> None:
    database.healthy = False
    response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json()["checks"]["database"] == {
        "status": "down",
        "error": "ConnectionRefusedError",
        "latencyMs": response.json()["checks"]["database"]["latencyMs"],
    }


def test_request_id_is_propagated_or_generated(client: TestClient) -> None:
    upstream = "0192b6f0a1b2c3d4e5f60718293a4b5c"
    assert (
        client.get("/health/live", headers={"X-Request-Id": upstream}).headers["x-request-id"]
        == upstream
    )
    generated = client.get("/health/live", headers={"X-Request-Id": "bad id"}).headers[
        "x-request-id"
    ]
    assert generated != "bad id"
    assert len(generated) == 32


def test_unknown_route_returns_problem_json(client: TestClient) -> None:
    response = client.get("/nope")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "not_found"


def test_lifespan_opens_and_closes_database(database: FakeDatabase) -> None:
    from app.main import create_app
    from tests.conftest import make_settings

    with TestClient(create_app(make_settings(), database=database)):
        assert database.opened
    assert database.closed
