#!/usr/bin/env bash
# Capture the UI-pass review screenshots (myne-md/myne#772 and its lanes).
#
# Same container plumbing as `capture-userguide.sh` — that script is the
# reference and this is deliberately a sibling rather than a flag on it: the
# guide pass builds a demo vault and snaps ~60 frames over 10-14 minutes, and
# a per-PR review pass has to be cheap enough that somebody actually runs it.
#
# tauri-driver has no macOS support, so this container IS the Linux seat
# (docs/dev/e2e.md) — and capturing on the developer's own machine would
# photograph their real vault, which is the other reason it is not an option.
#
#   ./scripts/capture-ui-pass.sh                # build app + capture
#   ./scripts/capture-ui-pass.sh --skip-build   # reuse the built binary
#
# PNGs land in e2e/artifacts/ui-pass/ (bind-mounted to the host; gitignored).

set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/e2e-docker.sh
source scripts/lib/e2e-docker.sh

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
  -v "$E2E_TARGET_VOLUME":/work/target
  "${E2E_REGISTRY_MOUNT[@]}"
  # Per-member node_modules volumes, matching the three e2e runners. Without
  # them the container's `pnpm install` rewrites each bind-mounted workspace
  # member's symlinks and breaks the HOST install — the documented failure mode
  # (e2e/AGENTS.md). This script had never carried them; it got away with it
  # only because a capture run happens rarely.
  "${E2E_MEMBER_NM_VOLUMES[@]}"
  -w /work
  --user root
)

# `MYNE_UI_PASS_FRAMES` (and the scale knob above it) are forwarded by NAME
# rather than by value so an unset variable stays unset inside the container
# instead of arriving as an empty string, which the capture file reads as "no
# filter". Without this line the filter silently did nothing: the script runs
# vitest inside `docker run`, and an env var set on the host is not in the
# container's environment unless it is named here.
FRAME_ENV=""
if [[ -n "${MYNE_UI_PASS_FRAMES:-}" ]]; then
  FRAME_ENV="MYNE_UI_PASS_FRAMES=$MYNE_UI_PASS_FRAMES"
fi
E2E_ENV="export ${SCALE_ENV}HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true npm_config_store_dir=/home/e2e/.pnpm-store $FRAME_ENV"
# Chown ALL of /work (not just the volumes): on a native-Linux bind mount the
# repo root stays host-owned (root), so the unprivileged `e2e` build user can't
# create /work/dist and `vite build` fails with EACCES. (Docker Desktop on macOS
# masks this via ownership remapping; native Linux / CI does not.)
FIX_PERMS='chown -R e2e:e2e /work'

# **The AI stub is part of the build, not an optional extra** (issue #970). This
# command used to be a bare `pnpm tauri build --no-bundle`, so the binary had no
# `local-inference-stub` and every AI surface that gates on a resolved model was
# correctly absent: the chat panel opened degraded, so its privacy notice, its
# CTA and the whole reviewed-vault seed wizard could not be photographed at all,
# and four frames failed for a product that was behaving. `capture-userguide.sh`
# has always built with both stubs; the two lanes now build the same binary, so a
# frame that exists in one exists in the other.
BUILD_CMD='pnpm install --frozen-lockfile && touch src-tauri/src/lib.rs && pnpm tauri build --no-bundle -- --features voice-capture-stub,local-inference-stub'
if [[ "$SKIP_BUILD" == 1 ]]; then
  BUILD_CMD='pnpm install --frozen-lockfile'
fi

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $E2E_CARGO_HOME_CHOWN && $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $BUILD_CMD &&
    xvfb-run -a -s \"-screen 0 $SCREEN\" pnpm exec vitest run --config .config/vitest/ui-pass.config.ts
  '
"
