"""Small in-process sliding-window rate limiter.

Adequate for a single backend instance. For horizontal scaling, replace with a
shared store (e.g. Redis) or enforce limits at the reverse proxy.
"""

import time
from collections import deque
from threading import Lock

from fastapi import HTTPException, Request, status

from app.config import get_settings


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float = 60.0, max_keys: int = 10_000) -> None:
        self.limit = limit
        self.window = window_seconds
        self.max_keys = max_keys
        self._hits: dict[str, deque[float]] = {}
        self._lock = Lock()

    def allow(self, key: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        cutoff = now - self.window
        with self._lock:
            hits = self._hits.get(key)
            if hits is None:
                if len(self._hits) >= self.max_keys:
                    self._evict(cutoff)
                hits = self._hits.setdefault(key, deque())
            while hits and hits[0] <= cutoff:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True

    def _evict(self, cutoff: float) -> None:
        # Bounded memory: drop idle keys first, then the oldest key if still full.
        for k in [k for k, h in self._hits.items() if not h or h[-1] <= cutoff]:
            del self._hits[k]
        if len(self._hits) >= self.max_keys:
            del self._hits[next(iter(self._hits))]

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


def client_key(request: Request) -> str:
    if get_settings().trust_proxy_headers:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def enforce(limiter: SlidingWindowLimiter, request: Request) -> None:
    if not limiter.allow(client_key(request)):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many requests, slow down")
