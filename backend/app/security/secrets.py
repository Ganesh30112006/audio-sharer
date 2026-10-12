"""Secret generation and constant-time verification for host keys."""

import hashlib
import hmac
import secrets

# Unambiguous alphabet (no 0/O, 1/I) so codes are easy to read aloud.
ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ROOM_CODE_LENGTH = 6


def new_room_code() -> str:
    return "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(ROOM_CODE_LENGTH))


def new_host_key() -> str:
    return secrets.token_urlsafe(32)


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def verify_secret(candidate: str | None, expected_hash: str) -> bool:
    if not candidate:
        return False
    return hmac.compare_digest(hash_secret(candidate), expected_hash)


def new_identity(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(6)}"
