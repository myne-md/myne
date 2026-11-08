#!/usr/bin/env bash
# Capture the user-guide screenshots from the macOS host (guide-golive,
# MYND-252 gate #7). Mirrors scripts/e2e-local.sh's container plumbing
# but runs the CAPTURE config (e2e/capture/*.capture.ts) instead of the
# E2E suite. tauri-driver has no macOS support, so this container IS the
# Linux seat (myne-agents/docs/dev/e2e.md). PNGs land in e2e/artifacts/userguide/
# (bind-mounted to the host repo; gitignored).
#
#   ./scripts/capture-userguide.sh                # build app + capture
#   ./scripts/capture-userguide.sh --skip-build   # reuse the built binary
#   ./scripts/capture-userguide.sh --userguide-only # skip unrelated preview capture
#
# The xvfb screen is sized 1280x800 so the 1100x720 Tauri window fits
# with margin (1280x800 is the reference desktop frame — DESIGN.json breakpoints).

set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/e2e-docker.sh
source scripts/lib/e2e-docker.sh

IMAGE=myne-e2e
SKIP_BUILD=0
RETINA=0
USERGUIDE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --userguide-only) USERGUIDE_ONLY=1 ;;
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
  # Passed through for the marketing re-shoot: the capture sets the app's theme
  # before its first content frame, and the two runs (dark, light) are the same
  # script with this variable changed. Unset means light, which is what the user
  # guide's canon asks for (`myne-website/src/content/user-guide/_authoring.md`);
  # the marketing pass sets CAPTURE_THEME=dark explicitly.
  -e CAPTURE_THEME
)

E2E_ENV="export ${SCALE_ENV}HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true npm_config_store_dir=/home/e2e/.pnpm-store"
# Host-side append, NOT inside the quoted literal above: that string is passed
# through to the container's bash, where `$E2E_CARGO_JOBS` is unset and would
# expand to nothing. See scripts/lib/e2e-docker.sh.
#
# This script built its own `E2E_ENV` and dropped the variable, so the job cap
# `e2e/AGENTS.md` documents as the fix for `rustc … (signal: 9, SIGKILL)` on
# `myne_desktop_lib` was unreachable from the one runner that does a full
# release build as its normal job — `e2e-local.sh` had it, this did not.
E2E_ENV="$E2E_ENV $E2E_CARGO_JOBS $E2E_CARGO_CODEGEN_UNITS $E2E_CARGO_OPT_LEVEL $E2E_SIDECAR_FEATURES"
# Chown ALL of /work (not just the volumes): on a native-Linux bind mount the
# repo root stays host-owned (root), so the unprivileged `e2e` build user can't
# create /work/dist and `vite build` fails with EACCES. (Docker Desktop on macOS
# masks this via ownership remapping; native Linux / CI does not.)
FIX_PERMS='chown -R e2e:e2e /work'

# `touch src-tauri/src/lib.rs`: the frontend is EMBEDDED at compile time, so a
# diff confined to `src/` relinks nothing and `tauri build` reports success while
# the binary keeps whatever `dist/` it was last compiled against (`e2e/AGENTS.md`,
# the myne-md/myne#520 trap). Every other runner here does this; this one was the
# only build-capable script that did not, so a frontend-only change produced
# screenshots of the PREVIOUS frontend with no sign anywhere that it had.
# `--features …`: the same stub list `scripts/e2e-local.sh` builds with, and for
# the same reason. Bare defaults pull the real Candle engine into `myne-desktop`,
# and that rustc is the one the OOM killer takes (`myne_desktop_lib …
# signal: 9`), which then reads on screen as a compile error in a tree nobody
# touched. `.woodpecker/e2e.yml` builds this feature set, so the screenshots come
# from a binary of the same shape CI verifies. The clipper-host sidecar gets the
# list through `MYNE_SIDECAR_FEATURES` (scripts/lib/e2e-docker.sh) because the
# `beforeBuildCommand` runs in a child process that never hears about this flag.
BUILD_CMD='pnpm install --frozen-lockfile && touch src-tauri/src/lib.rs && pnpm tauri build --no-bundle -- --features voice-capture-stub,local-inference-stub'
if [[ "$SKIP_BUILD" == 1 ]]; then
  BUILD_CMD='pnpm install --frozen-lockfile'
fi
CAPTURE_TEST_ARGS=""
if [[ "$USERGUIDE_ONLY" == 1 ]]; then
  CAPTURE_TEST_ARGS="e2e/capture/userguide.capture.ts"
fi

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $E2E_CARGO_HOME_CHOWN && $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $BUILD_CMD &&
    xvfb-run -a -s \"-screen 0 $SCREEN\" pnpm exec vitest run --config .config/vitest/capture.config.ts $CAPTURE_TEST_ARGS
  '
"
