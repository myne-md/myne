#!/usr/bin/env bash
# One-command local run of the web E2E lane (MYND-574 task 105).
#
#   ./scripts/e2e-web-local.sh                 # build the bundle, start a driver, run the lane
#   ./scripts/e2e-web-local.sh --skip-build    # reuse the existing web/dist
#   MYNE_WEB_E2E_BROWSER=firefox ./scripts/e2e-web-local.sh
#   MYNE_WEB_E2E_HEADED=1 ./scripts/e2e-web-local.sh
#
# # Why this runs on the HOST and `e2e-local.sh` runs in a container
#
# The desktop lane needs a container because tauri-driver cannot run on macOS at
# all — the container IS the Linux seat. Nothing here has that problem: Chrome
# and Firefox run natively on every dev machine, and the Safari seat only exists
# on macOS. Putting this in a container would remove the one browser that cannot
# be tested any other way.
#
# # Why the driver is started here and not by the harness
#
# `e2e-web/support/session.ts` deliberately does not spawn one:
# `MYNE_WEB_E2E_DRIVER_PORT` is an OPT-IN meaning "a driver is listening", and a
# harness that spawned one would make that flag a lie — re-opening the bug where
# the lane opened its gate on a machine with no chromedriver and then FAILED
# where it should have skipped. So the runner owns the driver's lifetime, which
# is also the right place for it: one driver serves every worker slot.

set -uo pipefail
cd "$(dirname "$0")/.."

SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

BROWSER="${MYNE_WEB_E2E_BROWSER:-chrome}"
case "$BROWSER" in
  chrome)  DRIVER_BIN=chromedriver ;;
  firefox) DRIVER_BIN=geckodriver ;;
  safari)
    DRIVER_BIN=safaridriver
    if [ "$(uname -s)" != "Darwin" ]; then
      echo "the Safari seat needs a macOS host — it is a manual per-release gate," >&2
      echo "never a CI lane (docs/decisions.md 2026-07-27: the runner is Linux-only)." >&2
      exit 2
    fi
    ;;
  *) echo "MYNE_WEB_E2E_BROWSER must be chrome | firefox | safari (got: $BROWSER)" >&2; exit 2 ;;
esac

if ! command -v "$DRIVER_BIN" >/dev/null 2>&1; then
  # One actionable line, matching the harness gate's discipline: name the missing
  # thing AND its fix. "Install it from a pinned source" is not pedantry — the
  # repo installs `cargo-deny` from a sha256-verified prebuilt and `tauri-driver`
  # with `--locked --version`, and a browser driver is a downloaded binary that
  # runs on a machine holding vault fixtures.
  echo "$DRIVER_BIN is not on PATH." >&2
  echo "Install it from a PINNED source (a versioned release archive whose hash you" >&2
  echo "check, or your distro's package), not an unpinned installer script:" >&2
  echo "  chrome  → https://googlechromelabs.github.io/chrome-for-testing/" >&2
  echo "  firefox → https://github.com/mozilla/geckodriver/releases" >&2
  echo "  safari  → ships with macOS; run 'safaridriver --enable' once" >&2
  exit 2
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "== building the web bundle (the lane refuses to run without one) =="
  pnpm web:build || exit 1
fi

# ONE DRIVER PER SHARD, at the port band `e2e-web/support/worker-ports.ts`
# computes for that vitest slot (4544 + (slot-1)*100).
#
# This used to start a single driver on 4544 with a comment saying "W3C drivers
# are multi-session, one serves them all". The first two-spec run disproved it:
# slot 2 asked for :4644 and got ECONNREFUSED. The claim is half true and the
# half that is false is the one that matters — **chromedriver is multi-session,
# geckodriver is not**. geckodriver serves one session per process, so a shared
# driver would serialise the Firefox lane at best and deadlock it at worst.
#
# Starting one per shard is correct for both and costs a process. The count must
# match `MYNE_WEB_E2E_SHARDS`, which is what vitest passes to `maxWorkers`, so
# the two are read from the same variable here rather than hard-coded apart.
SHARDS="${MYNE_WEB_E2E_SHARDS:-2}"
BASE_DRIVER_PORT=4544
DRIVER_PIDS=()
# Kill every driver however this script exits — including a failing test run,
# where a leaked driver would hold its port and make the NEXT run fail for the
# wrong reason.
trap 'for p in "${DRIVER_PIDS[@]:-}"; do kill "$p" 2>/dev/null; done' EXIT

for slot in $(seq 1 "$SHARDS"); do
  port=$(( BASE_DRIVER_PORT + (slot - 1) * 100 ))
  echo "== starting $DRIVER_BIN for slot $slot on :$port =="
  "$DRIVER_BIN" --port="$port" >"/tmp/myne-web-e2e-driver-$slot.log" 2>&1 &
  DRIVER_PIDS+=("$!")
done

for slot in $(seq 1 "$SHARDS"); do
  port=$(( BASE_DRIVER_PORT + (slot - 1) * 100 ))
  up=0
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$port/status" >/dev/null 2>&1; then up=1; break; fi
    sleep 0.25
  done
  if [ "$up" -ne 1 ]; then
    echo "$DRIVER_BIN did not come up on :$port — see /tmp/myne-web-e2e-driver-$slot.log" >&2
    exit 1
  fi
done

DRIVER_PORT="$BASE_DRIVER_PORT"

export MYNE_WEB_E2E_DRIVER_PORT="$DRIVER_PORT"
export MYNE_WEB_E2E_BROWSER="$BROWSER"
pnpm test:e2e:web
