#!/usr/bin/env bash
# Interleaved lossless latency trials (manual benchmark).
#
#   scripts/latency-trials.sh ROUNDS "VARIANTS" "CONTENTION_LEVELS" [SECONDS]
#   e.g. scripts/latency-trials.sh 3 "baseline experiment" "0 2" 120
#
# Every round runs each contention level with every variant. The variant order
# alternates between rounds (A B, B A, ...) so slow drift in machine
# conditions affects all variants alike. One production build serves every
# trial; the variant reaches the app as localStorage 'mc.experiment'.
# Raw JSON per trial: frontend/bench/latency/results/<run id>/.
# Summarise with: python3 scripts/latency-summary.py <run dir>
set -euo pipefail
ROUNDS="${1:?rounds}"
read -r -a VARIANTS <<<"${2:?variants}"
read -r -a LEVELS <<<"${3:-0}"
SECONDS_PER_TRIAL="${4:-120}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$ROOT/frontend/bench/latency/results/$RUN"
mkdir -p "$OUT"
echo "run $RUN -> $OUT"
cd "$ROOT/frontend"
for ((r = 0; r < ROUNDS; r++)); do
  order=("${VARIANTS[@]}")
  if ((r % 2 == 1)); then
    order=()
    for ((i = ${#VARIANTS[@]} - 1; i >= 0; i--)); do order+=("${VARIANTS[i]}"); done
  fi
  for c in "${LEVELS[@]}"; do
    for v in "${order[@]}"; do
      PROFILE_SECONDS="$SECONDS_PER_TRIAL" PROFILE_VARIANT="$v" PROFILE_CONTENTION="$c" \
        PROFILE_OUT="$OUT" npx playwright test e2e/latency-profile.spec.ts --workers=1 \
        2>&1 | grep -E '\[profile\]|failed|Error' || echo "trial failed: $v c$c (round $r)"
    done
  done
done
echo "done $OUT"
