# MultiConnect Audio

Real-time audio sharing in the browser. One host streams music, a browser tab
or a microphone to many listeners through a WebRTC SFU, and any device can
play one source on several output devices at once.

- **Frontend**: React 19 + TypeScript (strict) + Vite, plain CSS, Lucide icons.
- **Media transport**: [LiveKit](https://livekit.io) SFU (open source; native
  binary or LiveKit Cloud) with the `livekit-client` SDK.
- **Control plane**: FastAPI. It handles rooms, host authorization and
  short-lived media tokens. Audio never passes through it and is never stored.

No containers are needed: every piece runs as a native process.

---

## Quick start (local)

Requirements: Node 22+, Python 3.11+, and the
[LiveKit server binary](https://github.com/livekit/livekit/releases) (v1.12.0
tested) on your `PATH`.

```bash
# 1. dependencies
cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt && cd ..
cd frontend && npm ci && cd ..

# 2. run everything (LiveKit :7880, API :8000, web :5173)
PYTHON=backend/.venv/bin/python ./scripts/dev.sh

# Same, reachable from phones/laptops on your Wi-Fi (advertises your LAN IP):
LAN=1 PYTHON=backend/.venv/bin/python ./scripts/dev.sh
```

Open http://localhost:5173, click **Create room**, add an audio file, and click
**Go live**. Open the invite link in another browser or device to listen.

> Browsers only allow microphone or tab capture and output-device selection on
> `https://` pages or `localhost`. Other devices on your LAN therefore need
> HTTPS. Put a reverse proxy with a certificate in front of the app, as in
> `deploy/nginx.conf`, or use a tunnelling tool.

---

## Broadcast modes

| Mode                   | What listeners get                                                                             | Latency (measured, localhost) | Bandwidth per listener                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| **Lossless** (default) | The source's exact integer samples, up to **24-bit / 192 kHz**. Verified bit-exact end to end. | ~116 ms median                | ~1.0 Mbps (CD) to ~7.4 Mbps (192/24); depends on content |
| **Studio** (Opus)      | Opus at its 510 kbps maximum, 48 kHz stereo. Perceptually transparent but lossy.               | ~45 ms median                 | ~510 kbps                                                |
| High / Standard (Opus) | 128 / 64 kbps Opus, with optional loss protection (RED)                                        | ~45–60 ms                     | ~260 / 130 kbps with RED                                 |

**Lossless** sends PCM blocks over LiveKit's reliable, ordered data channel.
They are compressed with a FLAC-style codec: fixed linear prediction, mid/side
stereo and Rice coding. It is **not** the FLAC file format. WAV and FLAC
sources keep their native sample rate and bit depth, so nothing is resampled.
Lossy sources (MP3, AAC) are carried as the browser decodes them, at 24-bit.

What "lossless" guarantees, and what it doesn't:

- Every frame that is delivered is bit-exact. When continuity can't be kept
  (overload, network stall, restart), the stream reports an **explicit
  interruption** and playback restarts cleanly. Audio is never silently
  dropped, and playback never splices across a gap.
- The listener's playback buffer follows the listener's device clock. At
  typical clock differences it repeats or skips a single frame every few
  seconds. Each of these corrections is counted.
- Output devices, the OS mixer and **Bluetooth** (which re-encodes with
  SBC/AAC/LDAC) sit outside the browser, so lossless can't extend through
  them.

---

## Architecture

```
Host browser                                  LiveKit SFU                 Listener browser
────────────                                  ───────────                 ────────────────
file ─► <audio> ─► Web Audio tap ──┬─ Opus track ──────────► forwards ───► <audio> per output
mic / tab capture ─────────────────┤                                       (setSinkId, delay)
                                   └─ capture worklet ─► codec worker ─►
                                      (int PCM blocks)   (encode)   data channel ─► codec worker ─► playback worklet
                                                                    (reliable)       (decode)       (jitter buffer)
FastAPI: create room · host key · short-lived role-scoped tokens   (no media)
```

Key frontend modules (`frontend/src`):

| Area                    | Files                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audio engine (no React) | `audio/LocalFilePlayer.ts`, `audio/MultiOutputPlayer.ts`, `audio/driftCorrector.ts`, `audio/capabilities.ts`, `audio/outputDevices.ts`, `audio/sourcePolicy.ts`                                                   |
| Lossless transport      | `audio/lossless/codec.ts`, `captureAssembler.ts`, `captureLifecycle.ts`, `captureWorklet.ts`, `playbackWorklet.ts`, `codecWorker.ts`, `pipeline.ts`, `flowControl.ts`, `LosslessSender.ts`, `LosslessReceiver.ts` |
| Room / WebRTC           | `services/roomConnection.ts` (idempotent connect, in-place track replacement), `services/hostSession.ts`, `services/listenerSession.ts`                                                                           |
| Sync                    | `services/syncService.ts`, `services/syncProtocol.ts`, `utils/clock.ts` (NTP-style server-clock offset)                                                                                                           |
| UI                      | `pages/*`, `components/*`. Playback time and meters are written straight to the DOM through refs, so playing audio doesn't re-render React.                                                                       |

### Lossless pipeline guarantees

- **Bounded queues** (`flowControl.ts`). Encode, send and decode queues are
  each limited by block count, bytes and age of the oldest block (50 blocks,
  2 MB and 750 ms by default). Going over a limit starts an explicit
  interruption, which ends once the queue drains to 25% of its limit. These
  capacities haven't been tuned yet; see _Future work_.
- **Continuity metadata** (block header v2): `seq`, a `firstFrame` position on
  the AudioContext timeline, `captureMs` on the shared server clock (ms, mod
  2³²; error is bounded by the clock-sync uncertainty shown in diagnostics),
  and a `discontinuity` flag. Receivers reject duplicate, stale and reordered
  blocks, and treat any unannounced gap as a break in continuity.
- **Generation safety** (`captureLifecycle.ts`). There is one long-lived
  capture worklet per AudioContext, and start/stop run as generations on it.
  Async starts that were superseded never attach. Blocks from a stale
  generation are refused and recorded, and late worker replies are ignored.
- **Frame accounting**, reconciled exactly in the integration tests:
  - Sender: captured + capture-gap = sent + interrupted.
  - Network: sent = received + receiver-interrupted.
  - Receiver: received = decoded.
  - Playback: decoded = played + skipped + buffered.

---

## Environment variables

Backend (`backend/.env`; see `backend/.env.example`):

| Variable                                                                               | Default               | Meaning                                                                                     |
| -------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `APP_ENV`                                                                              | `development`         | `production` requires `wss://`, `https` CORS origins and a non-dev secret of 32+ characters |
| `LIVEKIT_URL`                                                                          | `ws://localhost:7880` | Public SFU URL given to browsers                                                            |
| `LIVEKIT_API_URL`                                                                      | = `LIVEKIT_URL`       | Server-to-server URL for RoomService                                                        |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`                                               | dev values            | Kept on the backend only                                                                    |
| `LIVEKIT_ROOM_ADMIN`                                                                   | `true`                | Pre-create rooms (participant limit, idle timeout) and close them via RoomService           |
| `CORS_ORIGINS`                                                                         | localhost:5173        | JSON list                                                                                   |
| `HOST_TOKEN_TTL_SECONDS` / `LISTENER_TOKEN_TTL_SECONDS`                                | 600 / 300             | Token lifetime; LiveKit refreshes tokens on live connections                                |
| `ROOM_TTL_SECONDS`, `ROOM_IDLE_TIMEOUT_SECONDS`, `MAX_ROOMS`, `MAX_LISTENERS_PER_ROOM` | 21600, 300, 1000, 100 | Limits                                                                                      |
| `RATE_LIMIT_CREATE_PER_MINUTE`, `RATE_LIMIT_TOKEN_PER_MINUTE`                          | 10, 60                | Per-IP limits (in-process)                                                                  |
| `TRUST_PROXY_HEADERS`                                                                  | `false`               | Use `X-Forwarded-For`; enable only behind a trusted proxy                                   |

Frontend (`frontend/.env`): `VITE_API_BASE_URL`. Leave it empty to use the
same origin; the Vite dev server proxies `/api`.

---

## Testing

```bash
cd backend && pytest -q && ruff check . && ruff format --check .
cd frontend && npm run lint && npm run typecheck && npm test   # 126 unit tests
cd frontend && npm run bench:codec                                # codec benchmark → bench/results/*.json

# Browser tests need a LiveKit server (dev keys):
livekit-server --config deploy/livekit.dev.yaml &
cd frontend && npx playwright test e2e/streaming.spec.ts e2e/lossless.spec.ts e2e/harness.spec.ts
```

Main suites:

| Suite                                            | What it proves                                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/losslessCodec`, `bitio`              | Bit-exact round trips (silence, impulses, extremes, noise, 1–8 channels, 16/24-bit), protocol validation, a 2,000-case garbage fuzz |
| `tests/unit/captureAssembler`                    | Channel-layout changes and timeline gaps at every offset within a block; no lost or mixed frames                                    |
| `tests/unit/captureLifecycle`                    | Start/stop races driven by deferred promises: no stale attach, at most one producer                                                 |
| `tests/unit/losslessPipeline`                    | Deterministic overload simulations: slow encoder, slow or stalled network, slow decoder, restarts; checks exact accounting          |
| `e2e/streaming`                                  | Real LiveKit: audible Opus delivery, join/leave leaks, duplicate-host takeover, Studio reaches 510 kbps                             |
| `e2e/lossless`                                   | Real LiveKit: bit-exact delivery at 44.1/16, 96/24 and 192/24                                                                       |
| `e2e/harness`                                    | Real worker and worklets with a controllable link: stall, slow link, restarts, reordering, lifecycle soak                           |
| `e2e/latency`, `perf`, `cpu`, `hires-throughput` | Benchmarks, run manually (not in CI)                                                                                                |

---

## Performance measurements

All numbers were measured in a cloud Linux container with headless Chromium
(Playwright) and LiveKit 1.12.0 on localhost. Real networks, phones and
Bluetooth will differ. Re-run the specs to measure your own setup.

| Metric                     | Result                                                                                  | How                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Initial JS (gzip)          | ~101 KB of 250 KB budget; LiveKit SDK (~141 KB) loads lazily                            | `npm run build && npm run size`                                                                  |
| Opus pipeline latency      | median ~45 ms (Studio, 'interactive' tap) vs ~68 ms with 'playback' (3 runs each)       | `e2e/latency.spec.ts`: onset detection on a click track, host pre-encode to listener post-decode |
| Lossless latency           | median ~116 ms clean, ~138 ms at 3% loss, 0 underruns                                   | same                                                                                             |
| Loss protection            | at 3% packet loss, concealment events 46 → 0 with RED (128 kbps)                        | same, CDP packet-loss emulation                                                                  |
| Host uplink vs listeners   | flat (~256–261 kbps Opus High) for 1, 4 and 8 listeners                                 | `e2e/perf.spec.ts`                                                                               |
| Lossless 192/24 throughput | ~7.4 Mbps sustained for 30 s, steady ~125 ms buffer, 0 underruns                        | `e2e/hires-throughput.spec.ts`                                                                   |
| Codec (192/24 music)       | encode ~11 ms / decode ~12 ms per second of audio (was 116 / 72); identical compression | `npm run bench:codec`, baseline in `bench/results/baseline.json`                                 |
| Codec allocations          | 1 typed array per block (the output)                                                    | same                                                                                             |

---

## Bandwidth and cost model

The SFU forwards one copy per listener, so **host upload stays constant** while
**SFU egress grows linearly** with listeners:

```
egress ≈ listeners × per-listener rate
Opus Studio 510 kbps   → 100 listeners ≈ 51 Mbps ≈ 23 GB/hour
Opus High + RED ~260   → 100 listeners ≈ 26 Mbps ≈ 12 GB/hour
Lossless CD ~1.0 Mbps  → 100 listeners ≈ 100 Mbps ≈ 45 GB/hour
Lossless 192/24 ~7 Mbps→ 100 listeners ≈ 700 Mbps ≈ 315 GB/hour
```

Multiply by your provider's egress price per GB. Listeners relayed through TURN
roughly double the traffic on the TURN server (in and out).

---

## Browser and OS compatibility

The app detects each capability at runtime and shows what's available on the
Settings page. The table below reflects vendor documentation. In this project
only **desktop Chromium on Linux** was actually tested.

| Feature                            | Chrome/Edge desktop                             | Firefox desktop  | Safari macOS      | Android Chrome | iOS/iPadOS (all browsers) |
| ---------------------------------- | ----------------------------------------------- | ---------------- | ----------------- | -------------- | ------------------------- |
| Listen (Opus)                      | yes                                             | yes              | yes               | yes            | yes (tap "Start audio")   |
| Listen (Lossless)                  | yes                                             | yes (untested)   | likely (untested) | yes (untested) | likely (untested)         |
| Choose output device (`setSinkId`) | yes                                             | yes (via picker) | no                | limited        | no (system output only)   |
| Multi-output playback              | yes                                             | yes              | no                | limited        | no                        |
| Tab audio capture                  | yes                                             | no               | no                | no             | no                        |
| System audio capture               | Windows/ChromeOS; macOS only on recent versions | no               | no                | no             | no                        |
| Microphone                         | yes                                             | yes              | yes               | yes            | yes                       |

---

## Deployment (no containers)

1. **LiveKit**: use LiveKit Cloud, or self-host with `deploy/livekit.service` and
   a config based on `deploy/livekit.prod.example.yaml`. Open UDP 50000–60000
   and TCP 7881, and configure TURN.
2. **API**: create a venv in `/srv/multiconnect/venv`, put the `.env` in
   `backend/`, then install and enable `deploy/multiconnect-api.service`. Use a
   single worker, because the room registry and rate limiter live in-process.
3. **Frontend**: run `cd frontend && npm ci && npm run build`, then serve
   `dist/` with `deploy/nginx.conf` plus `deploy/nginx-security-headers.conf`
   (HTTPS, CSP, `/api` proxy).

---

## Security

- Host keys are random (256-bit), stored server-side only as a hash and
  compared in constant time. The browser keeps them in the tab's
  `sessionStorage`, never in URLs.
- Listener tokens can't publish media or data. Host tokens are limited to
  microphone and screen-share-audio sources. All tokens are short-lived and
  scoped to one room.
- Rate limiting, strict request schemas (unknown fields rejected), sanitized
  names, and security headers are in place. Production configuration
  validation refuses development secrets and insecure URLs.
- No audio is recorded or stored. Uploaded files never leave the host's device.
- The lossless decoder rejects malformed or oversized blocks, unknown
  versions and flags, and bad lengths.

---

## Known limitations

- All measurements come from localhost in headless Chromium. Behaviour on real
  networks, mobile devices, Safari, Firefox and Bluetooth hasn't been measured.
- Lossless needs 1–8 Mbps per listener and has about 70 ms more latency than
  Opus. Under sustained congestion it interrupts (announced) instead of
  degrading quality.
- In one browser-integration run, a stale render quantum appeared right after
  a capture restart. The current defense is that each capture generation
  discards its first two render quanta and the source stays connected; this
  is covered by the restart soak tests.
- The room registry and rate limiter live in-process, so the API runs on a
  single instance.
- Multiple outputs are aligned only through manual delay sliders; browsers
  don't expose Bluetooth latency.

## Future work

- Tune lossless queue capacities from measured overload data (queue age,
  recovery time, interruption frequency).
- Move the room registry to Redis for horizontal scaling.
- WebAssembly codec, only if profiling on low-end devices shows JavaScript is
  too slow.
- A real FLAC bitstream option for interoperability.
