#!/usr/bin/env bash
# Capture the /themes hero carousel from the running desktop app.
#
# Sibling of scripts/capture-theme-preview.sh: same container plumbing, one more
# step: the frames become the carousel's stills on the HOST (the image has no
# ffmpeg, and adding an image encoder to the E2E image would buy one asset and
# slow every run).
#
#   ./scripts/capture-theme-demo.sh                # build app + capture + build stills
#   ./scripts/capture-theme-demo.sh --skip-build   # reuse the built binary
#   ./scripts/capture-theme-demo.sh --skip-capture # rebuild stills from existing frames
#
# Output lands in e2e/artifacts/theme-demo/ (bind-mounted to the host repo;
# gitignored): the raw frames, meta.json, and out/stills/ (one JPEG per
# frame). Promote them into the site with the command the builder prints
# (myne-website/public/themes/demo/).
#
# The stills exist because the marketing page had no picture of the app being
# customised, and the only honest source for one is the app. tauri-driver cannot
# record, so the capture takes a screenshot per step and the host turns each one
# into the carousel image.

set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/e2e-docker.sh
source scripts/lib/e2e-docker.sh

IMAGE=myne-e2e
SKIP_BUILD=0
SKIP_CAPTURE=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-capture) SKIP_CAPTURE=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

SCREEN="1280x800x24"

# The capture records which commit it was taken at, and the container has no git
# (that path is a bind mount, not a checkout). Read it here and pass it in.
PREVIEW_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

if [[ "$SKIP_CAPTURE" == 0 ]]; then
  docker build -t "$IMAGE" -f e2e/Dockerfile e2e

  RUN_FLAGS=(
    --rm
    -v "$(pwd):/work"
    -v myne-e2e-node-modules:/work/node_modules
    -v "$E2E_TARGET_VOLUME":/work/target
    "${E2E_REGISTRY_MOUNT[@]}"
    # Per-member node_modules volumes: the container's `pnpm install` rewrites a
    # bind-mounted workspace member's symlinks and breaks the host install
    # otherwise. One per member; `ornaments` + `preview` are members too.
    "${E2E_MEMBER_NM_VOLUMES[@]}"
    -w /work
    --user root
  )

  E2E_ENV="export HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true npm_config_store_dir=/home/e2e/.pnpm-store MYNE_PREVIEW_COMMIT=$PREVIEW_COMMIT"
  FIX_PERMS='chown -R e2e:e2e /work'

  BUILD_CMD='pnpm install --frozen-lockfile && touch src-tauri/src/lib.rs && pnpm tauri build --no-bundle'
  if [[ "$SKIP_BUILD" == 1 ]]; then
    BUILD_CMD='pnpm install --frozen-lockfile'
  fi

  docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
    $E2E_CARGO_HOME_CHOWN && $FIX_PERMS && su e2e -s /bin/bash -c '
      $E2E_ENV &&
      cd /work &&
      $BUILD_CMD &&
      xvfb-run -a -s \"-screen 0 $SCREEN\" pnpm exec vitest run --config .config/vitest/capture.config.ts e2e/capture/theme-demo.capture.ts
    '
  "
fi

node scripts/build-theme-demo-stills.mjs
