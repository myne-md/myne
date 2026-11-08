#!/usr/bin/env bash
# Capture the theme-preview snapshot from the running desktop app (myne#394).
# Sibling of scripts/capture-userguide.sh — same container plumbing, different
# capture file. tauri-driver has no macOS support, so this container IS the
# Linux seat (agent-tooling/docs/dev/e2e.md).
#
#   ./scripts/capture-theme-preview.sh                # build app + capture
#   ./scripts/capture-theme-preview.sh --skip-build   # reuse the built binary
#
# Output lands in e2e/artifacts/theme-preview/ (bind-mounted to the host repo;
# gitignored). Promote it into the shared package with:
#
#   cp e2e/artifacts/theme-preview/{preview.html,preview.css,meta.json} preview/src/
#   node scripts/check-preview-freshness.mjs --record
#
# The second line is not optional bookkeeping: the freshness guard compares a
# hash of the depicted surfaces, and a promoted capture with a stale hash reads
# as drift on every run afterwards.
#
# No --retina flag, unlike the user-guide pass: this capture produces a DOM and a
# stylesheet, not a raster, so device scale factor changes nothing about it. The
# xvfb screen still has to fit the window — a clipped viewport would capture a
# collapsed responsive layout.

set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/e2e-docker.sh
source scripts/lib/e2e-docker.sh

IMAGE=myne-e2e
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

SCREEN="1280x800x24"

# The capture records which commit it was taken at, and the container has no git
# — /work is a bind mount, not a checkout. Read it here and pass it in.
PREVIEW_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

docker build -t "$IMAGE" -f e2e/Dockerfile e2e

RUN_FLAGS=(
  --rm
  -v "$(pwd):/work"
  -v myne-e2e-node-modules:/work/node_modules
  -v "$E2E_TARGET_VOLUME":/work/target
  "${E2E_REGISTRY_MOUNT[@]}"
  # Per-member node_modules volumes: the container's `pnpm install` rewrites a
  # bind-mounted workspace member's symlinks and breaks the host install
  # otherwise. One per member, and `ornaments` + `preview` are members too.
  "${E2E_MEMBER_NM_VOLUMES[@]}"
  -w /work
  --user root
)

E2E_ENV="export HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true npm_config_store_dir=/home/e2e/.pnpm-store MYNE_PREVIEW_COMMIT=$PREVIEW_COMMIT"
FIX_PERMS='chown -R e2e:e2e /work'

BUILD_CMD='pnpm install --frozen-lockfile && pnpm tauri build --no-bundle'
if [[ "$SKIP_BUILD" == 1 ]]; then
  BUILD_CMD='pnpm install --frozen-lockfile'
fi

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $E2E_CARGO_HOME_CHOWN && $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $BUILD_CMD &&
    xvfb-run -a -s \"-screen 0 $SCREEN\" pnpm exec vitest run --config .config/vitest/capture.config.ts e2e/capture/theme-preview.capture.ts
  '
"
