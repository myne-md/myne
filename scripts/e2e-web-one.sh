#!/usr/bin/env bash
# Run a SINGLE web-E2E spec file (MYND-574 task 105) — the browser lane's
# counterpart to `e2e-one.sh`.
#
#   ./scripts/e2e-web-one.sh smoke                  # runs e2e-web/smoke.e2e.ts
#   ./scripts/e2e-web-one.sh smoke -t "headers"     # vitest -t name filter too
#
# # Why a single-file runner exists at all
#
# The desktop lane learned it the expensive way: a full suite CONTAMINATES —
# scenarios share a data dir, a port band and a driver, and a failure in file 3
# changes what file 11 sees. Isolating one file is how you find out whether a
# failure is the scenario's or the suite's. That reasoning transfers here
# unchanged, and the shared thing is more dangerous: an ORIGIN, which is what
# OPFS keys a vault by.
#
# Reuses whatever `web/dist` is already built. Rebuild deliberately
# (`pnpm web:build`) when the product changed — a silent stale-bundle run is the
# other expensive lesson from the desktop lane.

set -uo pipefail
cd "$(dirname "$0")/.."

SPEC="${1:-}"
if [ -z "$SPEC" ]; then
  echo "usage: $0 <spec-name> [vitest args…]   # e.g. $0 smoke -t headers" >&2
  exit 2
fi
shift

if [ ! -f "e2e-web/${SPEC}.e2e.ts" ]; then
  echo "no such spec: e2e-web/${SPEC}.e2e.ts" >&2
  echo "available:" >&2
  ls e2e-web/*.e2e.ts 2>/dev/null | sed 's#e2e-web/#  #; s#\.e2e\.ts##' >&2
  exit 2
fi

BROWSER="${MYNE_WEB_E2E_BROWSER:-chrome}"
case "$BROWSER" in
  chrome)  DRIVER_BIN=chromedriver ;;
  firefox) DRIVER_BIN=geckodriver ;;
  safari)  DRIVER_BIN=safaridriver ;;
  *) echo "MYNE_WEB_E2E_BROWSER must be chrome | firefox | safari (got: $BROWSER)" >&2; exit 2 ;;
esac

if ! command -v "$DRIVER_BIN" >/dev/null 2>&1; then
  echo "$DRIVER_BIN is not on PATH — see ./scripts/e2e-web-local.sh for pinned install sources." >&2
  exit 2
fi
if [ ! -f "web/dist/index.html" ]; then
  echo "no built bundle at web/dist — run 'pnpm web:build' first." >&2
  exit 2
fi

DRIVER_PORT=4544
"$DRIVER_BIN" --port="$DRIVER_PORT" >/tmp/myne-web-e2e-driver.log 2>&1 &
DRIVER_PID=$!
trap 'kill "$DRIVER_PID" 2>/dev/null' EXIT

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$DRIVER_PORT/status" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

export MYNE_WEB_E2E_DRIVER_PORT="$DRIVER_PORT"
export MYNE_WEB_E2E_BROWSER="$BROWSER"
# One worker, and it is NOT optional here: this runner starts exactly ONE driver,
# on one port, while `worker-ports.ts` offsets the driver port into each slot's
# band. A second slot would look for a driver that was never started. A single
# file has nothing to parallelise anyway.
#
# Set through the lane's own knob rather than a CLI flag, for two reasons. It is
# the variable `.config/vitest/web-e2e.config.ts` already reads into `maxWorkers`, so the
# runner and the config cannot disagree about the shard count — the same
# same-variable reasoning `e2e-web-local.sh` uses to keep its driver count
# honest. And it does not depend on a CLI spelling: this line previously passed
# `--poolOptions.threads.maxThreads=1`, which vitest 4 removed, so the script
# died with `CACError: Unknown option --poolOptions` before running anything.
export MYNE_WEB_E2E_SHARDS=1
pnpm exec vitest run --config .config/vitest/web-e2e.config.ts "e2e-web/${SPEC}.e2e.ts" "$@"
