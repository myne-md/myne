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
RETINA=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    # Retina (@2x) capture: drive WebKitGTK at device-scale-factor 2 so the
    # WebDriver /screenshot returns a 2200x1440 (vs 1100x720) frame — genuine
    # crispness, still fully automated. The xvfb screen must grow to fit the
    # doubled physical window. SPIKE: WebKitGTK's headless/offscreen path may
    # ignore GDK_SCALE and return 1100x720 anyway — verify the PNG dimensions.
    --retina) RETINA=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# xvfb screen + GTK scale are retina-gated. At 1x: 1280x800 fits the 1100x720
# window. At 2x: GDK_SCALE=2 makes the window 2200x1440 physical, so the screen
# grows to 2560x1600. GDK_DPI_SCALE=1 stops GTK counter-scaling the text.
SCREEN="1280x800x24"
SCALE_ENV=""
if [[ "$RETINA" == 1 ]]; then
  SCREEN="2560x1600x24"
  SCALE_ENV="GDK_SCALE=2 GDK_DPI_SCALE=1 "
fi

docker build -t "$IMAGE" -f e2e/Dockerfile e2e

RUN_FLAGS=(
  --rm
  -v "$(pwd):/work"
  -v myne-e2e-node-modules:/work/node_modules
  -v myne-e2e-target:/work/target
  -v myne-e2e-cargo-registry:/usr/local/cargo/registry
  # Per-member node_modules volumes, matching the three e2e runners. Without
  # them the container's `pnpm install` rewrites each bind-mounted workspace
  # member's symlinks and breaks the HOST install — the documented failure mode
  # (e2e/CLAUDE.md). This script had never carried them; it got away with it
  # only because a capture run happens rarely.
  -v myne-e2e-nm-dialect:/work/dialect/node_modules
  -v myne-e2e-nm-editor:/work/editor/node_modules
  -v myne-e2e-nm-copy:/work/copy/node_modules
  -v myne-e2e-nm-ornaments:/work/ornaments/node_modules
  -v myne-e2e-nm-preview:/work/preview/node_modules
  -w /work
  --user root
)

E2E_ENV="export ${SCALE_ENV}HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true npm_config_store_dir=/home/e2e/.pnpm-store"
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
    xvfb-run -a -s \"-screen 0 $SCREEN\" pnpm exec vitest run --config vitest.capture.config.ts
  '
"
