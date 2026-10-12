#!/usr/bin/env python3
"""Summarise latency-profile trials.

latency-summary.py RUN_DIR [...]                    per (variant, contention): median and every trial
latency-summary.py --compare BASE EXP RUN_DIR [...]  A/B per contention level, with an exact one-sided
                                                    permutation p-value (Mann-Whitney U) that EXP is lower
"""

import glob
import json
import math
import statistics
import sys
from collections import defaultdict

FIELDS = [
    ("onset p50", lambda r: r["onsetSameMachineMs"]["p50"]),
    ("onset p95", lambda r: r["onsetSameMachineMs"]["p95"]),
    ("onset p99", lambda r: r["onsetSameMachineMs"]["p99"]),
    ("pipeline p50", lambda r: r["analysis"]["pipeline"]["p50"]),
    ("pipeline p99", lambda r: r["analysis"]["pipeline"]["p99"]),
    ("buffer p50", lambda r: r["analysis"]["stages"]["buffer"]["p50"]),
    ("formation", lambda r: r["analysis"]["stages"]["formation"]["p50"]),
    ("captureToPage p50", lambda r: r["analysis"]["stages"]["captureToPage"]["p50"]),
    ("captureToPage p99", lambda r: r["analysis"]["stages"]["captureToPage"]["p99"]),
    ("transport p50", lambda r: r["analysis"]["stages"]["transport"]["p50"]),
    ("transport p99", lambda r: r["analysis"]["stages"]["transport"]["p99"]),
    (
        "encode+wait p99",
        lambda r: (
            r["analysis"]["stages"]["encodeWait"]["p99"]
            + r["analysis"]["stages"]["encode"]["p99"]
        ),
    ),
    (
        "decode+wait p99",
        lambda r: (
            r["analysis"]["stages"]["decodeWait"]["p99"]
            + r["analysis"]["stages"]["decode"]["p99"]
        ),
    ),
    ("pageToWorklet p50", lambda r: r["analysis"]["stages"]["pageToWorklet"]["p50"]),
    ("cushion min10s p50", lambda r: r["analysis"]["cushion"]["min10s"]["p50"]),
    ("cushion min", lambda r: min_or_nan(r["analysis"]["cushion"]["atArrival"])),
    ("target p50", lambda r: r["analysis"]["queues"]["targetMs"]["p50"]),
    (
        "worklet spread10s p50",
        lambda r: r["analysis"]["jitter"]["workletArrivalSpread10s"]["p50"],
    ),
    (
        "worklet spread10s max",
        lambda r: r["analysis"]["jitter"]["workletArrivalSpread10s"]["max"],
    ),
    (
        "listener spread10s p50",
        lambda r: r["analysis"]["jitter"]["listenerArrivalSpread10s"]["p50"],
    ),
    (
        "host spread10s p50",
        lambda r: r["analysis"]["jitter"]["hostCaptureSpread10s"]["p50"],
    ),
    (
        "interarrival dev p99",
        lambda r: r["analysis"]["jitter"]["interArrivalDev"]["p99"],
    ),
    ("bunched share", lambda r: r["analysis"]["jitter"]["bunchedShare"]),
    ("send queue max", lambda r: r["analysis"]["queues"]["sendQueueBlocks"]["max"]),
    ("decode queue max", lambda r: r["analysis"]["queues"]["decodeQueueBlocks"]["max"]),
    ("queue age max", lambda r: r["analysis"]["queues"]["oldestQueuedMs"]["max"]),
    ("outages (trace, window)", lambda r: r["analysis"]["outages"]["count"]),
    ("outage silence ms", lambda r: r["analysis"]["outages"]["totalMs"]),
    (
        "recovery max ms",
        lambda r: nan_if_none(r["analysis"]["outages"]["recoveryMs"]["max"]),
    ),
    ("outages (UI, whole run)", lambda r: float(r["listener"]["outages"] or "nan")),
    ("clock corrections", lambda r: float(r["listener"]["clockCorrections"] or "nan")),
    ("host interruptions", lambda r: float(r["host"]["interruptions"] or "nan")),
    ("never played", lambda r: r["analysis"]["blocks"]["neverPlayed"]),
    ("host long tasks", lambda r: r["analysis"]["longTasks"]["host"]["count"]),
    ("listener long tasks", lambda r: r["analysis"]["longTasks"]["listener"]["count"]),
    ("listener heap MB", lambda r: r["memory"]["listenerHeapMB"]),
    ("load1 after", lambda r: r["machine"]["loadAvg1After"]),
]


def nan_if_none(x):
    return float("nan") if x is None else x


def min_or_nan(d):
    return d.get("min", float("nan"))


def main():
    files = [f for d in sys.argv[1:] for f in sorted(glob.glob(f"{d}/*.json"))]
    groups = defaultdict(list)
    for f in files:
        with open(f) as fh:
            r = json.load(fh)
        groups[(r["variant"], r["contention"])].append(r)
    for (variant, c), rs in sorted(groups.items()):
        print(f"\n== {variant}, contention {c}: {len(rs)} trials ==")
        for name, get in FIELDS:
            vals = []
            for r in rs:
                try:
                    vals.append(float(get(r)))
                except (KeyError, TypeError, ValueError):
                    vals.append(float("nan"))
            ok = [v for v in vals if not math.isnan(v)]
            med = statistics.median(ok) if ok else float("nan")
            print(
                f"  {name:24s} median {med:8.2f}   trials {' '.join(f'{v:.2f}' for v in vals)}"
            )


COMPARE = [
    "onset p50",
    "onset p95",
    "onset p99",
    "pipeline p50",
    "pipeline p99",
    "buffer p50",
    "cushion min",
    "outages (trace, window)",
    "outage silence ms",
    "recovery max ms",
    "clock corrections",
    "listener heap MB",
    "decode+wait p99",
    "encode+wait p99",
]


def exact_p_lower(a, b):
    """One-sided exact permutation p-value that values in b are lower than in a
    (Mann-Whitney U, all relabellings enumerated)."""
    from itertools import combinations

    pooled = a + b

    def u(xs, ys):
        return sum((y < x) + 0.5 * (y == x) for x in xs for y in ys)

    observed = u(a, b)
    idx = range(len(pooled))
    count = total = 0
    for comb in combinations(idx, len(b)):
        bb = [pooled[i] for i in comb]
        aa = [pooled[i] for i in idx if i not in comb]
        total += 1
        count += u(aa, bb) >= observed
    return count / total


def compare(dirs, base, exp):
    files = [f for d in dirs for f in sorted(glob.glob(f"{d}/*.json"))]
    groups = defaultdict(list)
    for f in files:
        with open(f) as fh:
            r = json.load(fh)
        groups[(r["variant"], r["contention"])].append(r)
    getters = dict(FIELDS)
    for c in sorted({k[1] for k in groups}):
        A, B = groups.get((base, c), []), groups.get((exp, c), [])
        print(f"\n== contention {c}: {base} n={len(A)} vs {exp} n={len(B)} ==")
        for name in COMPARE:

            def vals(rs, get=getters[name]):
                out = []
                for r in rs:
                    try:
                        out.append(float(get(r)))
                    except (KeyError, TypeError, ValueError):
                        pass
                return [v for v in out if not math.isnan(v)]

            a, b = vals(A), vals(B)
            if not a or not b:
                print(f"  {name:24s} (no data)")
                continue
            ma, mb = statistics.median(a), statistics.median(b)
            p = exact_p_lower(a, b) if len(a) + len(b) <= 16 else float("nan")
            print(
                f"  {name:24s} {ma:8.2f} -> {mb:8.2f}  ({mb - ma:+7.2f})  p(lower)={p:.3f}"
            )


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--compare":
        compare(sys.argv[4:], sys.argv[2], sys.argv[3])
    else:
        main()
