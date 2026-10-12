"""Room control plane: create rooms, look them up, mint media tokens, close rooms."""

import re
import time
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Request, Response, status

from app.config import Settings, get_settings
from app.dependencies import get_create_limiter, get_livekit, get_registry, get_token_limiter
from app.schemas.rooms import (
    ROOM_CODE_PATTERN,
    CreateRoomRequest,
    CreateRoomResponse,
    RoomInfo,
    TimeResponse,
    TokenRequest,
    TokenResponse,
)
from app.security import rate_limit
from app.security.rate_limit import SlidingWindowLimiter
from app.security.secrets import new_identity
from app.services.livekit_service import HOST_IDENTITY, LiveKitService
from app.services.room_registry import Room, RoomLimitReached, RoomRegistry

router = APIRouter(prefix="/api")

Registry = Annotated[RoomRegistry, Depends(get_registry)]
LiveKit = Annotated[LiveKitService, Depends(get_livekit)]
AppSettings = Annotated[Settings, Depends(get_settings)]
RoomCode = Annotated[str, Path(min_length=6, max_length=6)]

_CODE_RE = re.compile(ROOM_CODE_PATTERN)


def _load_room(registry: RoomRegistry, code: str) -> Room:
    code = code.upper()
    room = registry.get(code) if _CODE_RE.match(code) else None
    if room is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Room not found or expired")
    return room


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/time", response_model=TimeResponse)
def server_time(response: Response) -> TimeResponse:
    """Wall-clock reference used by clients to estimate clock offset (NTP-style)."""
    response.headers["Cache-Control"] = "no-store"
    return TimeResponse(server_time_ms=time.time() * 1000)


@router.post("/rooms", response_model=CreateRoomResponse, status_code=status.HTTP_201_CREATED)
def create_room(
    body: CreateRoomRequest,
    request: Request,
    registry: Registry,
    limiter: Annotated[SlidingWindowLimiter, Depends(get_create_limiter)],
) -> CreateRoomResponse:
    rate_limit.enforce(limiter, request)
    try:
        room, host_key = registry.create(body.name)
    except RoomLimitReached:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Room capacity reached") from None
    return CreateRoomResponse(
        code=room.code, name=room.name, host_key=host_key, expires_at=int(room.expires_at)
    )


@router.get("/rooms/{code}", response_model=RoomInfo)
def get_room(code: RoomCode, registry: Registry, settings: AppSettings) -> RoomInfo:
    room = _load_room(registry, code)
    return RoomInfo(
        code=room.code,
        name=room.name,
        created_at=int(room.created_at),
        expires_at=int(room.expires_at),
        max_listeners=settings.max_listeners_per_room,
    )


@router.post("/rooms/{code}/token", response_model=TokenResponse)
async def issue_token(
    code: RoomCode,
    body: TokenRequest,
    request: Request,
    registry: Registry,
    livekit: LiveKit,
    settings: AppSettings,
    limiter: Annotated[SlidingWindowLimiter, Depends(get_token_limiter)],
) -> TokenResponse:
    rate_limit.enforce(limiter, request)
    room = _load_room(registry, code)
    if body.role == "host":
        if not registry.is_host(room, body.host_key):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid host key")
        # A fixed identity means a second host connection replaces the first
        # (LiveKit disconnects duplicates) instead of creating two publishers.
        identity = HOST_IDENTITY
        await livekit.ensure_room(room)
    else:
        identity = new_identity("listener")
    token, expires_at = livekit.issue_token(room, body.role, identity, body.display_name)
    return TokenResponse(
        token=token,
        url=settings.livekit_url,
        identity=identity,
        room=room.sfu_room_name,
        role=body.role,
        expires_at=expires_at,
    )


@router.delete("/rooms/{code}", status_code=status.HTTP_204_NO_CONTENT)
async def close_room(
    code: RoomCode,
    registry: Registry,
    livekit: LiveKit,
    x_host_key: Annotated[str | None, Header(max_length=128)] = None,
) -> Response:
    room = _load_room(registry, code)
    if not registry.is_host(room, x_host_key):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid host key")
    registry.delete(room.code)
    await livekit.close_room(room)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
