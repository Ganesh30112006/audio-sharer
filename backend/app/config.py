"""Application settings loaded from environment variables (see backend/.env.example)."""

from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_API_KEY = "devkey"
DEV_API_SECRET = "devsecret-not-for-production-0123456789"  # noqa: S105 - LiveKit --dev default, rejected in production


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = Field(default="development", description="development | production")

    # LiveKit SFU. The URL is handed to clients; the key/secret never leave the backend.
    livekit_url: str = "ws://localhost:7880"
    livekit_api_url: str | None = Field(
        default=None, description="Server-to-server URL for RoomService; defaults to livekit_url."
    )
    livekit_api_key: str = DEV_API_KEY
    livekit_api_secret: str = DEV_API_SECRET
    livekit_room_admin: bool = Field(
        default=True, description="Use LiveKit RoomService to pre-create rooms and close them."
    )

    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    host_token_ttl_seconds: int = 600
    listener_token_ttl_seconds: int = 300
    room_ttl_seconds: int = 6 * 3600
    room_idle_timeout_seconds: int = 300
    max_rooms: int = 1000
    max_listeners_per_room: int = 100

    rate_limit_create_per_minute: int = 10
    rate_limit_token_per_minute: int = 60
    trust_proxy_headers: bool = False

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"

    @model_validator(mode="after")
    def _check_production(self) -> "Settings":
        if self.is_production:
            if self.livekit_api_key == DEV_API_KEY or self.livekit_api_secret == DEV_API_SECRET:
                raise ValueError("Development LiveKit credentials are not allowed in production")
            if len(self.livekit_api_secret) < 32:
                raise ValueError("LIVEKIT_API_SECRET must be at least 32 characters in production")
            if not self.livekit_url.startswith("wss://"):
                raise ValueError("LIVEKIT_URL must use wss:// in production")
            if any(o.startswith("http://") for o in self.cors_origins):
                raise ValueError("CORS origins must use https:// in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
