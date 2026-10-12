"""Process-wide singletons wired through FastAPI dependencies (overridable in tests)."""

from functools import lru_cache

from app.config import get_settings
from app.security.rate_limit import SlidingWindowLimiter
from app.services.livekit_service import LiveKitService
from app.services.room_registry import RoomRegistry


@lru_cache
def get_registry() -> RoomRegistry:
    s = get_settings()
    return RoomRegistry(ttl_seconds=s.room_ttl_seconds, max_rooms=s.max_rooms)


@lru_cache
def get_livekit() -> LiveKitService:
    return LiveKitService(get_settings())


@lru_cache
def get_create_limiter() -> SlidingWindowLimiter:
    return SlidingWindowLimiter(get_settings().rate_limit_create_per_minute)


@lru_cache
def get_token_limiter() -> SlidingWindowLimiter:
    return SlidingWindowLimiter(get_settings().rate_limit_token_per_minute)
