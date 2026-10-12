# MultiConnect Audio

Real-time audio sharing in the browser: one host streams music, a browser tab or
a microphone to many listeners through a WebRTC SFU, and any device can play one
source on several output devices at once.

- **Frontend** — React 19 + TypeScript (strict) + Vite, plain CSS, Lucide icons.
- **Media transport** — [LiveKit](https://livekit.io) SFU (open-source, self-hosted
  native binary or LiveKit Cloud) with the `livekit-client` SDK.
- **Control plane** — FastAPI: rooms, host authorization, short-lived media tokens.
  Audio never passes through it and is never stored.

No containers are required: everything runs as native processes (see
[Deployment](#deployment)).

---

## Contents

1. [Quick start (local)](#quick-start-local)
2. [Architecture](#architecture)
3. [Audio quality](#audio-quality)
4. [Latency](#latency)
5. [Resource usage](#resource-usage)
6. [Connection reliability](#connection-reliability)
7. [Multi-device output (Bluetooth etc.)](#multi-device-output)
8. [Browser and OS compatibility](#browser-and-os-compatibility)
9. [Environment variables](#environment-variables)
10. [Testing](#testing)
11. [Performance measurements](#performance-measurements)
12. [Bandwidth and cost model](#bandwidth-and-cost-model)
13. [Deployment](#deployment)
14. [Security](#security)
15. [Known limitations](#known-limitations)
16. [Future optimization opportunities](#future-optimization-opportunities)

---

<!-- SECTIONS -->
