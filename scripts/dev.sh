#!/usr/bin/env bash
# Starts the whole stack natively for local development:
#   LiveKit SFU (dev keys) :7880, FastAPI :8000, Vite :5173
# Requires: livekit-server on PATH (or LIVEKIT_BIN), a Python with the backend
# dependencies (PYTHON, default python3), and Node with frontend deps installed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIVEKIT_BIN="${LIVEKIT_BIN:-livekit-server}"
PY="${PYTHON:-python3}"
# Resolve a relative interpreter path before changing directories.
case "$PY" in */*) PY="$(cd "$(dirname "$PY")" && pwd)/$(basename "$PY")" ;; esac

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# The SFU advertises this machine's network IP (auto-detected), so the app works
# at http://localhost:5173 and from other devices on the same network. Override
# the advertised address with NODE_IP=1.2.3.4 if detection picks the wrong one.
lk_args=(--config "$ROOT/deploy/livekit.dev.yaml")
if [ -n "${NODE_IP:-}" ]; then lk_args+=(--node-ip "$NODE_IP"); fi
"$LIVEKIT_BIN" "${lk_args[@]}" &
pids+=($!)

(cd "$ROOT/backend" && "$PY" -m uvicorn app.main:app --port 8000 --reload) &
pids+=($!)
(cd "$ROOT/frontend" && npx vite --host 0.0.0.0 --port 5173) &
pids+=($!)

echo "MultiConnect Audio: http://localhost:5173  (Ctrl+C to stop)"
wait
