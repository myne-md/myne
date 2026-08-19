#!/usr/bin/env bash
# One-command local E2E run from the macOS host (e2e-harness task 3).
#
#   ./scripts/e2e-local.sh                # build image if needed, build app, run suite
#   ./scripts/e2e-local.sh --skip-build   # reuse the existing app binary in the target volume
#   ./scripts/e2e-local.sh --shell        # drop into a shell inside the container instead
#
# The repo is bind-mounted; node_modules, the cargo target dir, and the
# cargo registry live in named Docker volumes so (a) macOS-native
# node_modules never leak into the Linux container and (b) re-runs are
# incremental. tauri-driver itself cannot run on macOS — this container
# IS the local Linux seat (docs/dev/e2e.md).
#
# THREE ENVIRONMENT KNOBS, all of them opt-in and all of them the difference
# between a run that verified something and a run that reported green having
# verified nothing:
#   MYNE_E2E_RETRIES=0    hunt flake. The vitest config retries twice, which is
#                         right for a gate and wrong for a measurement: a failing
#                         attempt is erased and the flake rate reads as zero.
#   MYNE_E2E_QUARANTINE=1 run ONLY the `describeE2E.flaky` specs. Without it a
#                         quarantined spec self-skips and this reports success.
#   MYNE_E2E_AI=1         run the inference suites. Needs the
#                         `local-inference-stub` build too: use e2e-ai-buildrun.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=myne-e2e
SKIP_BUILD=0
SHELL_MODE=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --shell) SHELL_MODE=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Cross-compile the LINUX myne-server binary the multi-device sync E2E spawns
# (MYND-428 task 5). The container needs a Linux server binary; the host's
# `myne-server/myne-server` is the dev OS's arch and won't exec in the container.
# Go on the host produces a static CGO_ENABLED=0 binary matching the container arch
# (same flags as the reproducible image, MYND-437). If Go is absent, the sync specs
# self-skip with an actionable reason rather than failing.
SERVER_BIN=""
if command -v go >/dev/null 2>&1; then
  case "$(docker info --format '{{.Architecture}}' 2>/dev/null)" in
    x86_64|amd64) GOARCH=amd64 ;;
    *) GOARCH=arm64 ;;
  esac
  SERVER_BIN="myne-server/myne-server-linux-$GOARCH"
  echo "e2e-local: cross-compiling $SERVER_BIN (linux/$GOARCH) for the sync harness ..."
  ( cd myne-server && CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" \
      go build -trimpath -ldflags="-buildid= -s -w" -o "myne-server-linux-$GOARCH" ./cmd/myne-server )
else
  echo "e2e-local: Go not on host — multi-device sync specs self-skip (no Linux server binary)." >&2
fi

docker build -t "$IMAGE" -f e2e/Dockerfile e2e

RUN_FLAGS=(
  --rm
  -v "$(pwd):/work"
  # Linux-only node_modules (pnpm refuses macOS artifacts and vice versa).
  -v myne-e2e-node-modules:/work/node_modules
  # Workspace-MEMBER node_modules need the same isolation: the members are
  # bind-mounted, so the container's `pnpm install` would otherwise rewrite
  # their symlinks to container-side .pnpm hashes and break the HOST install
  # (and vice versa). Latent until a member gained a real external dependency
  # (editor/ → @excalidraw); bites as `Cannot find module` on whichever side
  # ran `pnpm install` second.
  -v myne-e2e-nm-dialect:/work/dialect/node_modules
  -v myne-e2e-nm-editor:/work/editor/node_modules
  -v myne-e2e-nm-copy:/work/copy/node_modules
  -v myne-e2e-nm-ornaments:/work/ornaments/node_modules
  -v myne-e2e-nm-preview:/work/preview/node_modules
  # Incremental Rust builds across runs.
  -v myne-e2e-target:/work/target
  -v myne-e2e-cargo-registry:/usr/local/cargo/registry
  -w /work
  # Volumes are created root-owned; the container user is `e2e` (the
  # suites assert chmod-denial paths, which root would bypass).
  --user root
)

# `su` resets the environment, and login shells re-source /etc/profile
# (clobbering the rust image's PATH) — export explicitly, same idiom as
# .woodpecker.yml's cargo-test-tauri step.
E2E_ENV='export HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true npm_config_store_dir=/home/e2e/.pnpm-store'

# Forwarded HOST-side, because the container inherits neither and a spec gated on
# one of them SELF-SKIPS rather than failing: a run that verified nothing reports
# the same green as a run that verified everything. `MYNE_E2E_QUARANTINE=1` is
# the only way to reach a `describeE2E.flaky` spec from here; `MYNE_E2E_AI=1`
# needs the `local-inference-stub` build as well (see `e2e-ai-buildrun.sh`).
E2E_ENV="$E2E_ENV MYNE_E2E_QUARANTINE=${MYNE_E2E_QUARANTINE:-0} MYNE_E2E_AI=${MYNE_E2E_AI:-0}"
# `MYNE_E2E_RETRIES=0` is how `e2e/CLAUDE.md` says to hunt flake, and no runner
# used to offer it: with the config's default of 2, a failing attempt is erased
# from the report and the flake rate reads as zero however bad it is.
RETRY_FLAG=""
if [ -n "${MYNE_E2E_RETRIES:-}" ]; then
  RETRY_FLAG="--retry=${MYNE_E2E_RETRIES}"
fi
# Point the multi-device sync harness at the Linux server binary built above so it
# spawns the REAL server in-container instead of the host-arch one (MYND-428 task 5).
if [[ -n "$SERVER_BIN" ]]; then
  E2E_ENV="$E2E_ENV MYNE_E2E_SERVER=/work/$SERVER_BIN"
fi
FIX_PERMS='chown -R e2e:e2e /work/node_modules /work/dialect/node_modules /work/editor/node_modules /work/copy/node_modules /work/target /usr/local/cargo/registry'

if [[ "$SHELL_MODE" == 1 ]]; then
  exec docker run -it "${RUN_FLAGS[@]}" "$IMAGE" \
    bash -c "$FIX_PERMS && su e2e -s /bin/bash -c '$E2E_ENV && cd /work && exec bash -i'"
fi

# `--features voice-capture-stub` (myne#389 item D): the deterministic 440 Hz
# capture source is a COMPILE-time variant now, not an env knob, so the voice
# scenarios need it built in. Additive to the default features.
BUILD_CMD='pnpm install --frozen-lockfile && pnpm tauri build --no-bundle -- --features voice-capture-stub'
if [[ "$SKIP_BUILD" == 1 ]]; then
  BUILD_CMD='pnpm install --frozen-lockfile'
fi

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $BUILD_CMD &&
    xvfb-run -a pnpm test:e2e $RETRY_FLAG
  '
"
