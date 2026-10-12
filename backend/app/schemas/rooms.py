"""Request/response schemas for the room control plane."""

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

ROOM_CODE_PATTERN = r"^[A-HJ-NP-Z2-9]{6}$"
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def _clean_text(value: str) -> str:
    value = _CONTROL_CHARS.sub("", value).strip()
    return re.sub(r"\s+", " ", value)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_max_length=200)


class CreateRoomRequest(StrictModel):
    name: str = Field(default="Listening room", min_length=1, max_length=60)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = _clean_text(v)
        if not v:
            raise ValueError("name must not be blank")
        return v


class CreateRoomResponse(BaseModel):
    code: str
    name: str
    host_key: str = Field(
        description="Secret proving host ownership. Shown once; store client-side only."
    )
    expires_at: int


class RoomInfo(BaseModel):
    code: str
    name: str
    created_at: int
    expires_at: int
    max_listeners: int


class TokenRequest(StrictModel):
    role: Literal["host", "listener"]
    display_name: str = Field(default="Listener", min_length=1, max_length=40)
    host_key: str | None = Field(default=None, max_length=128)

    @field_validator("display_name")
    @classmethod
    def _display_name(cls, v: str) -> str:
        v = _clean_text(v)
        if not v:
            raise ValueError("display_name must not be blank")
        return v


class TokenResponse(BaseModel):
    token: str
    url: str
    identity: str
    room: str
    role: Literal["host", "listener"]
    expires_at: int


class TimeResponse(BaseModel):
    server_time_ms: float
