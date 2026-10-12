from app.security.rate_limit import SlidingWindowLimiter
from app.services.room_registry import RoomLimitReached, RoomRegistry


def test_limiter_window_slides() -> None:
    lim = SlidingWindowLimiter(2, window_seconds=10)
    assert lim.allow("a", now=0)
    assert lim.allow("a", now=1)
    assert not lim.allow("a", now=2)
    assert lim.allow("b", now=2)
    assert lim.allow("a", now=10.5)


def test_limiter_memory_is_bounded() -> None:
    lim = SlidingWindowLimiter(1, window_seconds=10, max_keys=3)
    for i in range(10):
        lim.allow(f"k{i}", now=float(i))
    assert len(lim._hits) <= 3


def test_registry_expiry_and_capacity() -> None:
    reg = RoomRegistry(ttl_seconds=10, max_rooms=2)
    a, _ = reg.create("a", now=0)
    reg.create("b", now=0)
    try:
        reg.create("c", now=5)
        raise AssertionError("expected capacity error")
    except RoomLimitReached:
        pass
    assert reg.get(a.code, now=9) is not None
    assert reg.get(a.code, now=11) is None
    # Expired rooms are purged, freeing capacity.
    reg.create("d", now=11)


def test_registry_host_key() -> None:
    reg = RoomRegistry(ttl_seconds=10, max_rooms=5)
    room, key = reg.create("a")
    assert reg.is_host(room, key)
    assert not reg.is_host(room, key + "x")
    assert not reg.is_host(room, None)
    assert key not in room.host_key_hash
