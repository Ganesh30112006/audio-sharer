"""In-memory room registry (control-plane state only — never media).

Rooms are short-lived and reconstructable, so they are not persisted. A
multi-instance deployment should move this to a shared store with the same
interface.
"""

import time
from dataclasses import dataclass
from threading import Lock

from app.security.secrets import hash_secret, new_host_key, new_room_code, verify_secret


@dataclass(frozen=True)
class Room:
    code: str
    name: str
    host_key_hash: str
    created_at: float
    expires_at: float

    @property
    def sfu_room_name(self) -> str:
        return f"mc-{self.code}"


class RoomLimitReached(Exception):
    pass


class RoomRegistry:
    def __init__(self, ttl_seconds: int, max_rooms: int) -> None:
        self.ttl = ttl_seconds
        self.max_rooms = max_rooms
        self._rooms: dict[str, Room] = {}
        self._lock = Lock()

    def create(self, name: str, now: float | None = None) -> tuple[Room, str]:
        now = time.time() if now is None else now
        host_key = new_host_key()
        with self._lock:
            self._purge(now)
            if len(self._rooms) >= self.max_rooms:
                raise RoomLimitReached()
            code = new_room_code()
            while code in self._rooms:
                code = new_room_code()
            room = Room(code, name, hash_secret(host_key), now, now + self.ttl)
            self._rooms[code] = room
        return room, host_key

    def get(self, code: str, now: float | None = None) -> Room | None:
        now = time.time() if now is None else now
        with self._lock:
            room = self._rooms.get(code)
            if room and room.expires_at <= now:
                del self._rooms[code]
                return None
            return room

    def is_host(self, room: Room, host_key: str | None) -> bool:
        return verify_secret(host_key, room.host_key_hash)

    def delete(self, code: str) -> bool:
        with self._lock:
            return self._rooms.pop(code, None) is not None

    def __len__(self) -> int:
        return len(self._rooms)

    def _purge(self, now: float) -> None:
        for code in [c for c, r in self._rooms.items() if r.expires_at <= now]:
            del self._rooms[code]
