"""LiveKit token issuance and room administration.

Media never passes through this service: clients connect to the SFU directly
with the short-lived tokens minted here.
"""

import logging
import time
from datetime import timedelta

from livekit import api

from app.config import Settings
from app.services.room_registry import Room

log = logging.getLogger(__name__)

HOST_IDENTITY = "host"


class LiveKitService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def issue_token(
        self, room: Room, role: str, identity: str, display_name: str
    ) -> tuple[str, int]:
        is_host = role == "host"
        ttl = (
            self.settings.host_token_ttl_seconds
            if is_host
            else self.settings.listener_token_ttl_seconds
        )
        grants = api.VideoGrants(
            room_join=True,
            room=room.sfu_room_name,
            can_subscribe=True,
            can_publish=is_host,
            # Only the host broadcasts playback state; listeners are receive-only.
            can_publish_data=is_host,
            can_publish_sources=["microphone", "screen_share_audio"] if is_host else [],
            can_update_own_metadata=False,
        )
        token = (
            api.AccessToken(self.settings.livekit_api_key, self.settings.livekit_api_secret)
            .with_identity(identity)
            .with_name(display_name)
            .with_grants(grants)
            .with_ttl(timedelta(seconds=ttl))
            .with_attributes({"role": role})
            .to_jwt()
        )
        return token, int(time.time()) + ttl

    def _client(self) -> api.LiveKitAPI:
        url = self.settings.livekit_api_url or self.settings.livekit_url
        url = url.replace("wss://", "https://").replace("ws://", "http://")
        return api.LiveKitAPI(url, self.settings.livekit_api_key, self.settings.livekit_api_secret)

    async def ensure_room(self, room: Room) -> None:
        """Pre-create the SFU room so participant limits and idle timeouts apply.

        Failure is non-fatal: LiveKit auto-creates rooms on first join.
        """
        if not self.settings.livekit_room_admin:
            return
        try:
            async with self._client() as lk:
                await lk.room.create_room(
                    api.CreateRoomRequest(
                        name=room.sfu_room_name,
                        empty_timeout=self.settings.room_idle_timeout_seconds,
                        max_participants=self.settings.max_listeners_per_room + 1,
                    )
                )
        except Exception as exc:  # noqa: BLE001 - admin API is best-effort
            log.warning("LiveKit create_room failed for %s: %s", room.sfu_room_name, exc)

    async def close_room(self, room: Room) -> None:
        if not self.settings.livekit_room_admin:
            return
        try:
            async with self._client() as lk:
                await lk.room.delete_room(api.DeleteRoomRequest(room=room.sfu_room_name))
        except Exception as exc:  # noqa: BLE001
            log.warning("LiveKit delete_room failed for %s: %s", room.sfu_room_name, exc)
