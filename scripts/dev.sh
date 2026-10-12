#!/usr/bin/env bash
# Starts the whole stack natively for local development:
#   LiveKit SFU (dev keys) :7880, FastAPI :8000, Vite :5173
# Requires: livekit-server on PATH (or LIVEKIT_BIN), python venv with backend deps, node.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIVEKIT_BIN="${LIVEKIT_BIN:-livekit-server}"
PY="${PYTHON:-python3}"

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

"$LIVEKIT_BIN" --config "$ROOT/deploy/livekit.dev.yaml" & pids+=($!)
(cd "$ROOT/backend" && "$PY" -m uvicorn app.main:app --port 8000 --reload) & pids+=($!)
(cd "$ROOT/frontend" && npx vite --port 5173) & pids+=($!)

echo "MultiConnect Audio: http://localhost:5173  (Ctrl+C to stop)"
wait
