#!/usr/bin/env bash
# Bring up TWO independent Myne DESKTOP instances for manual sync testing (macOS).
#
# Why a second identifier is required, not optional: `tauri-plugin-single-instance`
# keys its lock on the app identifier (`/tmp/<identifier>_si.sock`,
# `tauri-plugin-single-instance/src/platform_impl/macos.rs`), and Tauri derives
# `app_data_dir` from the SAME identifier at COMPILE time (it is baked by
# `tauri::generate_context!` from the `TAURI_CONFIG` env the CLI sets when
# `--config` is passed, and `tauri-build` emits `rerun-if-env-changed=TAURI_CONFIG`
# so the top crate relinks when it changes). So a plain second `pnpm tauri dev`
# from this checkout only focuses the first window. Giving EACH instance its own
# identifier (neither the default) separates BOTH the lock and the data directory,
# which produces two independent apps with two independent vaults AND leaves the
# real `md.myne.desktop` vault untouched.
#
# Shared on purpose, all of them identifier-independent and hardcoded in the
# client, so they are caveats rather than bugs:
#   - the ONE Vite dev server on :1420 (a second one dies on `strictPort`)
#   - the macOS keychain services `md.myne.quickunlock` / `md.myne.vaultlabel`
#     (do NOT enable quick-unlock on both instances; they overwrite each other)
#   - the clipper relay socket, pinned to `md.myne.desktop`, so the browser
#     clipper only talks to instance A
#
# Usage: pnpm dev:two   (or: bash scripts/dev-two-desktop.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

APP_A_ID="md.myne.desktop.a"
APP_B_ID="md.myne.desktop.b"

# Job control: each background job gets its own process group, which is what lets
# cleanup kill the WHOLE tree (`pnpm dev` -> vite -> esbuild, `pnpm tauri dev` ->
# cargo -> the app binary) instead of orphaning them on Ctrl-C.
set -m

PIDS=()
cleanup() {
  echo
  echo "==> stopping instances"
  for pid in "${PIDS[@]}"; do
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> staging the CLI + Tor sidecars (once)"
pnpm sidecar

if nc -z localhost 1420 2>/dev/null; then
  echo "==> :1420 already serving; reusing the running Vite"
else
  echo "==> starting the shared Vite dev server on :1420"
  pnpm dev &
  PIDS+=("$!")
  sleep 3
fi

echo "==> instance A ($APP_A_ID)"
pnpm tauri dev --config "{\"identifier\":\"$APP_A_ID\",\"build\":{\"beforeDevCommand\":\"\"}}" &
PIDS+=("$!")

echo "==> instance B ($APP_B_ID)"
pnpm tauri dev --config "{\"identifier\":\"$APP_B_ID\",\"build\":{\"beforeDevCommand\":\"\"}}" &
PIDS+=("$!")

echo
echo "==> both instances are coming up. B relinks the desktop crate once with its own"
echo "    identifier, so it appears a little later. Ctrl-C stops both."
echo "    In each window: Settings -> Sync -> the same endpoint."
wait
