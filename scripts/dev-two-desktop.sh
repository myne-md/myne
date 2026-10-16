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
# Reset: pnpm dev:two:reset   (wipes both instances' data + the sync store; run
#        it only while this script is NOT running)
#
# It ALSO builds and starts a LOCAL myne-server on http://127.0.0.1:8787 (override
# with MYNE_DEV_SYNC_PORT) and seeds that endpoint + the beta-terms acceptance
# into both instances, so one command brings up everything a manual sync test
# needs. The store lives under `.opencode/dev-sync-store` and survives restarts.
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

# ---------------------------------------------------------------------------
# Local sync server, so ONE command brings up everything a manual sync test
# needs. A fixed loopback port (overridable with MYNE_DEV_SYNC_PORT) so both
# instances share it, and a stable data dir under `.opencode/` (ignored) so the
# accounts and vaults survive a restart.
#
# `MYNE_STORAGE_BACKEND=fs` is set alongside the path because the server's default
# is `mem` (`myne-server/internal/httpapi/config.go`): with `mem` the accounts and
# vaults live in RAM, the directory below stays empty, and the restart promised in
# the sentence above loses the account with nothing said. `pnpm web:local`
# (`scripts/dev-web.sh`) sets both as well and shares this store, so the two
# commands cannot disagree about whether it is on disk.
# ---------------------------------------------------------------------------
SYNC_PORT="${MYNE_DEV_SYNC_PORT:-8787}"
SYNC_ENDPOINT="http://127.0.0.1:${SYNC_PORT}"
SYNC_STORE="$(pwd)/.opencode/dev-sync-store"
SERVER_BIN="myne-server/myne-server"

if command -v go >/dev/null 2>&1; then
  echo "==> building myne-server (host binary)"
  if ! ( cd myne-server && go build -o myne-server ./cmd/myne-server ); then
    echo "!! could not build myne-server. Starting WITHOUT a sync server;" >&2
    echo "!! set Settings -> Sync manually in each window." >&2
    SERVER_BIN=""
  fi
else
  echo "!! Go not found; assuming $SERVER_BIN is already a host binary"
fi

if [ -n "$SERVER_BIN" ]; then
  mkdir -p "$SYNC_STORE"
  echo "==> starting the local sync server on $SYNC_ENDPOINT (store: $SYNC_STORE)"
  MYNE_SERVER_ADDR="127.0.0.1:${SYNC_PORT}" MYNE_STORAGE_BACKEND=fs \
    MYNE_STORAGE_PATH="$SYNC_STORE" \
    "$SERVER_BIN" &
  PIDS+=("$!")
  for _ in $(seq 1 40); do
    nc -z 127.0.0.1 "$SYNC_PORT" 2>/dev/null && break
    sleep 0.3
  done

  # Point BOTH instances at it BEFORE they boot: `sync-config.json` is the SYNC-14
  # endpoint surface and `legal-consent.json` the beta-terms acceptance, so no
  # in-app Settings step is needed. macOS app-config dir is Application Support/<id>.
  for id in "$APP_A_ID" "$APP_B_ID"; do
    cfg="$HOME/Library/Application Support/$id"
    mkdir -p "$cfg"
    printf '{\n  "endpoint_url": "%s"\n}\n' "$SYNC_ENDPOINT" > "$cfg/sync-config.json"
    printf '{\n  "beta_terms_version": "1"\n}\n' > "$cfg/legal-consent.json"
  done
  echo "==> both instances pre-pointed at $SYNC_ENDPOINT"
fi

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
if [ -n "${SERVER_BIN:-}" ] && [ -n "${SYNC_ENDPOINT:-}" ]; then
  echo "    Sync endpoint (already seeded into both): $SYNC_ENDPOINT"
  echo "    In each window: Settings -> Sync -> Enroll to the same account, then"
  echo "    open the SAME note on both and watch the live cursor and roster."
else
  echo "    In each window: Settings -> Sync -> the same endpoint."
fi
wait
