#!/usr/bin/env bash
# Capture the user-guide screenshots from the macOS host (guide-golive,
# MYND-252 gate #7). Mirrors scripts/e2e-local.sh's container plumbing
# but runs the CAPTURE config (e2e/capture/*.capture.ts) instead of the
# E2E suite. tauri-driver has no macOS support, so this container IS the
# Linux seat (docs/dev/e2e.md). PNGs land in e2e/artifacts/userguide/
# (bind-mounted to the host repo; gitignored).
#
#   ./scripts/capture-userguide.sh                # build app + capture
#   ./scripts/capture-userguide.sh --skip-build   # reuse the built binary
#
# The xvfb screen is sized 1280x800 so the 1100x720 Tauri window fits
# with margin (Penpot's desktop frames are 1280x800).

set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=myne-e2e
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

docker build -t "$IMAGE" -f e2e/Dockerfile e2e

RUN_FLAGS=(
  --rm
  -v "$(pwd):/work"
  -v myne-e2e-node-modules:/work/node_modules
  -v myne-e2e-target:/work/target
  -v myne-e2e-cargo-registry:/usr/local/cargo/registry
  -w /work
  --user root
)

E2E_ENV='export HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true npm_config_store_dir=/home/e2e/.pnpm-store'
# Chown ALL of /work (not just the volumes): on a native-Linux bind mount the
# repo root stays host-owned (root), so the unprivileged `e2e` build user can't
# create /work/dist and `vite build` fails with EACCES. (Docker Desktop on macOS
# masks this via ownership remapping; native Linux / CI does not.)
FIX_PERMS='chown -R e2e:e2e /work /usr/local/cargo/registry'

BUILD_CMD='pnpm install --frozen-lockfile && pnpm tauri build --no-bundle'
if [[ "$SKIP_BUILD" == 1 ]]; then
  BUILD_CMD='pnpm install --frozen-lockfile'
fi

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $BUILD_CMD &&
    xvfb-run -a -s \"-screen 0 1280x800x24\" pnpm exec vitest run --config vitest.capture.config.ts
  '
"
