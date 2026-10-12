import os

os.environ.setdefault("LIVEKIT_ROOM_ADMIN", "false")

import pytest
from fastapi.testclient import TestClient

from app.dependencies import get_create_limiter, get_registry, get_token_limiter
from app.main import app


@pytest.fixture()
def client() -> TestClient:
    get_registry.cache_clear()
    get_create_limiter.cache_clear()
    get_token_limiter.cache_clear()
    return TestClient(app)


@pytest.fixture()
def room(client: TestClient) -> dict:
    res = client.post("/api/rooms", json={"name": "Test room"})
    assert res.status_code == 201
    return res.json()
