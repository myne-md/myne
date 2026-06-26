#!/usr/bin/env bash
#
# clipper-dev-install.sh — DEV-ONLY native-messaging host installer (macOS).
#
# A browser launches the Myne clipper host by reading a native-messaging
# *manifest* (`md.myne.clipper.json`) from a fixed per-browser directory; the
# manifest's `path` is run as a child process whose stdin/stdout ARE the
# native-messaging pipes. Two things are needed and neither ships yet (the
# production per-OS installer is future work — see
# `src-tauri/src/clipper/manifest.rs`):
#
#   1. a LAUNCH WRAPPER — browsers run the manifest `path` with NO arguments,
#      but the Myne binary only enters host (relay) mode when given
#      `--native-messaging-host` (`clipper::host::NATIVE_MESSAGING_ARG`). So the
#      manifest points at a tiny wrapper that re-execs the binary with the flag.
#   2. the MANIFEST itself — JSON naming the host, the wrapper path, and the
#      allowlist (Chrome: the exact `chrome-extension://<id>/` origin; Firefox:
#      the gecko id `clipper@myne.md`).
#
# This script writes both. It mirrors the host name + install locations
# documented in `src-tauri/src/clipper/manifest.rs` — keep it in step if those
# change. The manifest carries NO secret (a host name, a binary path, public
# extension ids) — it is config, not key material.
#
# Reliability note: the host process resolves the relay socket from the HARDCODED
# bundle id `md.myne.desktop` (`lib.rs::host_mode_app_data_dir`), so the GUI app
# it talks to must use that same app-data dir. A PRODUCTION bundle
# (`pnpm tauri build`, run `Myne.app`) is the reliable target; a `pnpm tauri dev`
# GUI may resolve a different app-data dir and the relay then won't connect.
#
# Usage:
#   scripts/clipper-dev-install.sh --browser firefox
#   scripts/clipper-dev-install.sh --browser chrome --ext-id <unpacked-id>
#   scripts/clipper-dev-install.sh --browser all --ext-id <unpacked-id> --binary <path>
#   scripts/clipper-dev-install.sh --uninstall [--browser all]
#
set -euo pipefail

HOST_NAME="md.myne.clipper"
BUNDLE_ID="md.myne.desktop"
GECKO_ID="clipper@myne.md"   # Firefox stable id (myne-clipper/src/manifest.json)

APP_DATA_DIR="$HOME/Library/Application Support/$BUNDLE_ID"
WRAPPER="$APP_DATA_DIR/clipper-host-launch.sh"

# Per-browser NativeMessagingHosts dirs (macOS), keyed by the host name.
declare -A NMH_DIR=(
  [chrome]="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  [edge]="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
  [firefox]="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
)

BROWSER=""
EXT_ID=""
BINARY=""
UNINSTALL=0

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --browser) BROWSER="${2:-}"; shift 2 ;;
    --ext-id)  EXT_ID="${2:-}"; shift 2 ;;
    --binary)  BINARY="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[[ "$(uname)" == "Darwin" ]] || die "this dev helper is macOS-only (Linux/Windows: see manifest.rs install locations)"

# Resolve the browser list. Match the RAW `$BROWSER` (not a `:-firefox` default)
# so the empty/no-flag case hits the `""` arm → `BROWSERS=(firefox)`. Defaulting
# in the `case` word would route an empty `$BROWSER` into the `firefox` arm and
# then set `BROWSERS=("$BROWSER")` to a single EMPTY string — an empty
# associative-array key downstream (`NMH_DIR[""]` → "bad array subscript").
case "$BROWSER" in
  all) BROWSERS=(firefox chrome edge) ;;
  firefox|chrome|edge) BROWSERS=("$BROWSER") ;;
  "") BROWSERS=(firefox) ;;
  *) die "unknown --browser: $BROWSER (chrome|edge|firefox|all)" ;;
esac

# --- uninstall --------------------------------------------------------------
if [[ "$UNINSTALL" == 1 ]]; then
  for b in "${BROWSERS[@]}"; do
    f="${NMH_DIR[$b]}/$HOST_NAME.json"
    if [[ -f "$f" ]]; then rm -f "$f"; echo "removed  $f"; fi
  done
  if [[ -f "$WRAPPER" ]]; then rm -f "$WRAPPER"; echo "removed  $WRAPPER"; fi
  echo "uninstalled."
  exit 0
fi

# --- resolve the binary -----------------------------------------------------
if [[ -z "$BINARY" ]]; then
  # Cargo WORKSPACE layout: the target dir is at the repo root (`target/`), not
  # `src-tauri/target/`. Prefer the bundled binary (the one run as the GUI),
  # then the bare release, then debug; `src-tauri/target/` is a non-workspace
  # fallback. The bundled binary is `Myne.app/Contents/MacOS/myne-desktop`
  # (named after the bin, not the productName).
  for cand in \
    "target/release/bundle/macos/Myne.app/Contents/MacOS/myne-desktop" \
    "target/release/myne-desktop" \
    "target/debug/myne-desktop" \
    "src-tauri/target/release/myne-desktop" \
    "src-tauri/target/debug/myne-desktop"; do
    if [[ -x "$cand" ]]; then BINARY="$(cd "$(dirname "$cand")" && pwd)/$(basename "$cand")"; break; fi
  done
fi
[[ -n "$BINARY" ]] || die "no Myne binary found. Build first (\`pnpm tauri build\` → release, or \`cargo build -p myne-desktop\` → debug), or pass --binary <path>"
[[ -x "$BINARY" ]] || die "binary is not executable: $BINARY"

# --- write the launch wrapper ----------------------------------------------
mkdir -p "$APP_DATA_DIR"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
# Generated by scripts/clipper-dev-install.sh — re-execs the Myne binary in
# native-messaging host (relay) mode. The browser runs THIS with no args; the
# flag is what selects host mode. stdin/stdout are the native-messaging pipes.
exec "$BINARY" --native-messaging-host "\$@"
EOF
chmod +x "$WRAPPER"
echo "wrote    $WRAPPER  ->  $BINARY"

# --- write the per-browser manifest(s) -------------------------------------
write_manifest() {
  local browser="$1" dir allow_block
  dir="${NMH_DIR[$browser]}"
  mkdir -p "$dir"
  if [[ "$browser" == "firefox" ]]; then
    allow_block="\"allowed_extensions\": [\"$GECKO_ID\"]"
  else
    [[ -n "$EXT_ID" ]] || die "$browser needs --ext-id (the unpacked extension id from chrome://extensions or edge://extensions)"
    allow_block="\"allowed_origins\": [\"chrome-extension://$EXT_ID/\"]"
  fi
  cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Myne keyless web clipper host (dev)",
  "path": "$WRAPPER",
  "type": "stdio",
  $allow_block
}
EOF
  echo "wrote    $dir/$HOST_NAME.json  ($browser)"
}

for b in "${BROWSERS[@]}"; do write_manifest "$b"; done

echo
echo "done. Next:"
echo "  1. Run the Myne desktop app (the relay holder). Reliable: \`pnpm tauri build\` then open \`Myne.app\`."
echo "  2. Build + load the extension (myne-clipper: \`pnpm build\` → load dist/ unpacked)."
echo "  3. Assign a shortcut to the 'pair-myne' command (chrome://extensions/shortcuts or Firefox manage-shortcuts), press it, and Accept in the desktop dialog."
echo "  4. Click the toolbar icon to clip the current page."
