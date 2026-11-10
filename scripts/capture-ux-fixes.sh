#!/usr/bin/env bash
# Capture this branch's review evidence (myne-md/myne#1049), one tree at a time.
#
# Same container plumbing as `capture-ui-pass.sh`, and a sibling rather than a
# flag on it for the reason that script gives: the include glob is what keeps a
# capture pass runnable on its own, and this pass photographs a different branch's
# surfaces. Deliberately identical everywhere else, including the AI stub in the
# build: a surface that gates on a resolved model is otherwise correctly absent
# and the frame photographs its absence.
#
#   ./scripts/capture-ux-fixes.sh               # build the app + capture
#   ./scripts/capture-ux-fixes.sh --skip-build  # reuse the built binary
#
# PNGs land in e2e/artifacts/ux-fixes/ (bind-mounted to the host; gitignored).

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

docker build -t "$IMAGE" -f e2e/Dockerfile e2e >/dev/null

RUN_FLAGS=(
  --rm
  -v "$(pwd):/work"
  -v myne-e2e-node-modules:/work/node_modules
  -v "$E2E_TARGET_VOLUME":/work/target
  "${E2E_REGISTRY_MOUNT[@]}"
  "${E2E_MEMBER_NM_VOLUMES[@]}"
  -w /work
  --user root
)

BUILD_COMMIT_ENV="MYNE_BUILD_COMMIT=$(git rev-parse --short=9 HEAD 2>/dev/null || echo unknown)"
E2E_ENV="export HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true npm_config_store_dir=/home/e2e/.pnpm-store $BUILD_COMMIT_ENV"
FIX_PERMS='chown -R e2e:e2e /work'

BUILD_CMD='pnpm install --frozen-lockfile && touch src-tauri/src/lib.rs && pnpm tauri build --no-bundle -- --features voice-capture-stub,local-inference-stub'
if [[ "$SKIP_BUILD" == 1 ]]; then
  BUILD_CMD='pnpm install --frozen-lockfile'
fi

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $E2E_CARGO_HOME_CHOWN && $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $BUILD_CMD &&
    xvfb-run -a -s \"-screen 0 $SCREEN\" pnpm exec vitest run --config .config/vitest/ux-fixes-capture.config.ts
  '
"
