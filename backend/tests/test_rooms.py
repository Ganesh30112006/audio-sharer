from fastapi.testclient import TestClient

from app.config import Settings
from tests import jwt_helper


def test_health(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok"}


def test_time_is_not_cached(client: TestClient) -> None:
    res = client.get("/api/time")
    assert res.headers["cache-control"] == "no-store"
    assert res.json()["server_time_ms"] > 1_600_000_000_000


def test_create_and_get_room(client: TestClient, room: dict) -> None:
    assert len(room["code"]) == 6
    assert len(room["host_key"]) >= 32
    info = client.get(f"/api/rooms/{room['code']}").json()
    assert info["name"] == "Test room"
    assert "host_key" not in info
    # Codes are case-insensitive for people typing them.
    assert client.get(f"/api/rooms/{room['code'].lower()}").status_code == 200


def test_room_name_is_sanitised(client: TestClient) -> None:
    res = client.post("/api/rooms", json={"name": "  Party\x00\n  room  "})
    assert res.json()["name"] == "Party room"
    assert client.post("/api/rooms", json={"name": "   "}).status_code == 422
    assert client.post("/api/rooms", json={"name": "x", "extra": 1}).status_code == 422


def test_unknown_room(client: TestClient) -> None:
    assert client.get("/api/rooms/ZZZZZZ").status_code == 404
    assert client.get("/api/rooms/../../x").status_code == 404
    assert client.get("/api/rooms/O0O0O0").status_code == 404


def test_listener_token_is_receive_only(client: TestClient, room: dict) -> None:
    res = client.post(
        f"/api/rooms/{room['code']}/token", json={"role": "listener", "display_name": "Ann"}
    )
    assert res.status_code == 200
    body = res.json()
    claims = jwt_helper.decode(body["token"])
    grant = claims["video"]
    assert grant["room"] == f"mc-{room['code']}"
    assert grant["roomJoin"] is True
    assert grant.get("canPublish") is False
    assert grant.get("canPublishData") is False
    assert grant["canSubscribe"] is True
    assert claims["sub"].startswith("listener-")
    assert claims["name"] == "Ann"
    assert claims["exp"] - claims["nbf"] <= 300 + 5


def test_listener_identities_are_unique(client: TestClient, room: dict) -> None:
    ids = {
        client.post(f"/api/rooms/{room['code']}/token", json={"role": "listener"}).json()[
            "identity"
        ]
        for _ in range(5)
    }
    assert len(ids) == 5


def test_host_token_requires_host_key(client: TestClient, room: dict) -> None:
    url = f"/api/rooms/{room['code']}/token"
    assert client.post(url, json={"role": "host"}).status_code == 403
    assert client.post(url, json={"role": "host", "host_key": "wrong"}).status_code == 403
    res = client.post(url, json={"role": "host", "host_key": room["host_key"]})
    assert res.status_code == 200
    claims = jwt_helper.decode(res.json()["token"])
    assert claims["sub"] == "host"
    assert claims["video"]["canPublish"] is True
    assert claims["video"]["canPublishData"] is True
    assert set(claims["video"]["canPublishSources"]) == {"microphone", "screen_share_audio"}


def test_host_key_from_other_room_rejected(client: TestClient, room: dict) -> None:
    other = client.post("/api/rooms", json={"name": "Other"}).json()
    res = client.post(
        f"/api/rooms/{room['code']}/token", json={"role": "host", "host_key": other["host_key"]}
    )
    assert res.status_code == 403


def test_close_room(client: TestClient, room: dict) -> None:
    url = f"/api/rooms/{room['code']}"
    assert client.delete(url).status_code == 403
    assert client.delete(url, headers={"X-Host-Key": "nope"}).status_code == 403
    assert client.delete(url, headers={"X-Host-Key": room["host_key"]}).status_code == 204
    assert client.get(url).status_code == 404
    assert client.post(f"{url}/token", json={"role": "listener"}).status_code == 404


def test_create_rate_limited(client: TestClient) -> None:
    codes = [client.post("/api/rooms", json={}).status_code for _ in range(12)]
    assert codes.count(201) == 10
    assert codes[-1] == 429


def test_security_headers(client: TestClient) -> None:
    res = client.get("/api/health")
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["referrer-policy"] == "no-referrer"


def test_production_rejects_dev_credentials() -> None:
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Settings(app_env="production")
    ok = Settings(
        app_env="production",
        livekit_url="wss://sfu.example.com",
        livekit_api_key="key",
        livekit_api_secret="x" * 40,
        cors_origins=["https://app.example.com"],
    )
    assert ok.is_production
