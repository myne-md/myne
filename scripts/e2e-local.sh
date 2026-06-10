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

docker build -t "$IMAGE" -f e2e/Dockerfile e2e

RUN_FLAGS=(
  --rm
  -v "$(pwd):/work"
  # Linux-only node_modules (pnpm refuses macOS artifacts and vice versa).
  -v myne-e2e-node-modules:/work/node_modules
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
FIX_PERMS='chown -R e2e:e2e /work/node_modules /work/target /usr/local/cargo/registry'

if [[ "$SHELL_MODE" == 1 ]]; then
  exec docker run -it "${RUN_FLAGS[@]}" "$IMAGE" \
    bash -c "$FIX_PERMS && su e2e -s /bin/bash -c '$E2E_ENV && cd /work && exec bash -i'"
fi

BUILD_CMD='pnpm install --frozen-lockfile && pnpm tauri build --no-bundle'
if [[ "$SKIP_BUILD" == 1 ]]; then
  BUILD_CMD='pnpm install --frozen-lockfile'
fi

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $BUILD_CMD &&
    xvfb-run -a pnpm test:e2e
  '
"
