"""Decode (without verifying) a JWT payload for assertions."""

import base64
import json


def decode(token: str) -> dict:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))
