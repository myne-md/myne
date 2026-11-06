#!/usr/bin/env bash
# Reset the TWO dev instances `pnpm start` brings up, so a manual sync test can
# start from zero: both app-data dirs, the in-repo sync server store, the stale
# single-instance sockets, and the per-vault Keychain keys of the dev vaults.
#
# WHY a sibling script and not a flag on `pnpm start`: that command is a long-lived
# foreground process whose whole job is to hold these files open, so a reset can
# only run after it exits — and the dev vault ids have to be read out of those
# directories BEFORE they are deleted, because the Keychain accounts are keyed by
# them. It is also not a keypress in that menu, deliberately: one stray character
# must not delete a vault.
#
# WHY it is narrow. `pnpm start` exists to keep a manual sync test off the user's
# own vault, and a reset that "cleans everything" is the one thing that would
# undo that:
#   - `md.myne.desktop` — the real app and the real vault — is NEVER touched.
#   - The Keychain SERVICE names are shared, not per-instance: a
#     `md.myne.quickunlock` item's account is `<account_number_hash>:<vault_id>`
#     (`core/src/plugins/quick_unlock/device_secret.rs`) and a `md.myne.vaultlabel`
#     item's account is the bare `<vault_id>` (`core/src/vault_label/key.rs`).
#     So each match is against the vault ids read from the dev dirs, never by
#     service alone — deleting by service would strand the real vault's key.
#   - `md.myne.captures` / `md.myne.shareimport` hold ONE device-GLOBAL item each
#     (not one per vault) and are mobile-only, so both are left alone.
#
# WebView data (`~/Library/WebKit/<id>`) and caches are left alone too: the
# desktop client keeps no vault state there, so they are not part of the state a
# reset is for.
#
# macOS only, matching `pnpm start`'s keychain-backed instances: the app-data
# layout, and every Keychain-backed secret in this app (`core/src/vault_label`,
# `core/src/plugins/quick_unlock`), is Apple-only. Another platform exits rather
# than guess at a path.
#
# Usage:
#   pnpm dev:reset          # prints the plan, then asks
#   pnpm dev:reset --yes    # no prompt (scripted teardown)
set -euo pipefail
cd "$(dirname "$0")/.."

APP_IDS=(md.myne.desktop.a md.myne.desktop.b)
# A dev session whose sync port was taken runs with a suffixed store, so the reset has
# to match every store this checkout has ever created, not just the default. Built with
# an explicit loop rather than `nullglob`, and read only behind a length check, for the
# same reason `VAULT_IDS` below is: macOS bash 3.2 refuses `"${arr[@]}"` on an empty
# array under `set -u`.
SYNC_STORES=()
for store in "$PWD"/.opencode/dev-sync-store*; do
  [ -d "$store" ] && SYNC_STORES+=("$store")
done

usage() { echo "usage: pnpm dev:reset [--yes]"; }

ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "!! dev:reset is a macOS workflow and this reset only knows the macOS layout." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Refuse while an instance is live. The plugin's single-instance socket is
# `/tmp/<identifier with . and - as _>_si.sock` and is held open by the process
# for its whole life, so `lsof -U` is a read-only answer to "is it running" —
# unlike connecting to it, which the plugin would read as a second launch.
# ---------------------------------------------------------------------------
if command -v lsof >/dev/null 2>&1; then
  LIVE="$(lsof -U 2>/dev/null | grep -E '/tmp/md_myne_desktop_[ab]_si\.sock' || true)"
  if [ -n "$LIVE" ]; then
    echo "!! a dev instance is still running:" >&2
    echo "$LIVE" >&2
    echo "!! stop 'pnpm start' (q or Ctrl-C) and re-run." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Read the dev vault ids BEFORE deleting the directories that name them: every
# Keychain account below is derived from a vault id, and once the app-data dir
# is gone the id is unrecoverable.
# ---------------------------------------------------------------------------
VAULT_IDS=()
for id in "${APP_IDS[@]}"; do
  vdir="$HOME/Library/Application Support/$id/vaults"
  [ -d "$vdir" ] || continue
  for v in "$vdir"/*/; do
    if [ -d "$v" ]; then VAULT_IDS+=("$(basename "$v")"); fi
  done
done

# ---------------------------------------------------------------------------
# Plan, then confirm. The default is NO, and it stays no on EOF, so a
# non-interactive run without --yes aborts instead of deleting.
# ---------------------------------------------------------------------------
echo "This will remove:"
for id in "${APP_IDS[@]}"; do
  echo "  app data    ~/Library/Application Support/$id"
done
echo "  sync stores"
if [ "${#SYNC_STORES[@]}" -gt 0 ]; then
  for store in "${SYNC_STORES[@]}"; do echo "              $store"; done
else
  echo "              (none found)"
fi
echo "  sockets     /tmp/md_myne_desktop_{a,b}_si.sock (stale ones only)"
if [ "${#VAULT_IDS[@]}" -gt 0 ]; then
  echo "  keychain    dev-vault keys for: ${VAULT_IDS[*]}"
else
  echo "  keychain    (no dev vaults found; nothing to match)"
fi
echo
echo "The real md.myne.desktop vault is not in this list and will not be touched."

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Proceed? [y/N] '
  read -r reply || reply=""
  case "$reply" in
    [yY] | [yY][eE][sS]) ;;
    *)
      echo "aborted; nothing removed."
      exit 0
      ;;
  esac
fi

echo "==> removing app data"
for id in "${APP_IDS[@]}"; do
  dir="$HOME/Library/Application Support/$id"
  if [ -d "$dir" ]; then
    rm -rf "$dir"
    echo "    removed $dir"
  else
    echo "    absent  $dir"
  fi
done

echo "==> removing the local sync server store"
if [ "${#SYNC_STORES[@]}" -eq 0 ]; then
  echo "    absent  (none found)"
else
  for store in "${SYNC_STORES[@]}"; do
    rm -rf "$store"
    echo "    removed $store"
  done
fi

# A socket left by a hard kill (the plugin only unlinks it on a clean
# RunEvent::Exit) would be handled on the next launch anyway; removing it keeps
# the reset's own claim true.
echo "==> clearing stale single-instance sockets"
for id in "${APP_IDS[@]}"; do
  sock="/tmp/${id//[.-]/_}_si.sock"
  if [ -e "$sock" ]; then
    rm -f "$sock"
    echo "    removed $sock"
  else
    echo "    absent  $sock"
  fi
done

echo "==> removing dev-vault Keychain keys (best-effort)"
if [ "${#VAULT_IDS[@]}" -eq 0 ]; then
  echo "    no dev vaults found; nothing to match"
elif ! command -v security >/dev/null 2>&1; then
  echo "    'security' not found; skipping (stale keys are inert: a new vault"
  echo "    mints a new id, so nothing reads them again)"
else
  # The label item's account IS the vault id, so it is addressed directly.
  for vid in "${VAULT_IDS[@]}"; do
    if security delete-generic-password -s md.myne.vaultlabel -a "$vid" >/dev/null 2>&1; then
      echo "    removed md.myne.vaultlabel / $vid"
    fi
  done

  # A quick-unlock item's account is `<account_number_hash>:<vault_id>`, and the
  # hash half is not recoverable from disk (vault.meta is sealed). So enumerate
  # the service's accounts once and keep the ones whose vault half matches.
  # `dump-keychain` prints ATTRIBUTES only (no secrets); every item record starts
  # at a `keychain:` line, which is what the awk splits on.
  quick_accounts="$(
    security dump-keychain </dev/null 2>/dev/null | awk '
      /^keychain:/ { if (have && svce == "md.myne.quickunlock") print acct; svce = ""; acct = ""; have = 1; next }
      /^[[:space:]]+"svce"<blob>=/ { s = $0; sub(/.*<blob>=/, "", s); gsub(/^"|"$/, "", s); svce = s }
      /^[[:space:]]+"acct"<blob>=/ { a = $0; sub(/.*<blob>=/, "", a); gsub(/^"|"$/, "", a); acct = a }
      END { if (have && svce == "md.myne.quickunlock") print acct }
    ' || true
  )"
  for vid in "${VAULT_IDS[@]}"; do
    while IFS= read -r acct; do
      [ -n "$acct" ] || continue
      case "$acct" in
        *":$vid")
          if security delete-generic-password -s md.myne.quickunlock -a "$acct" >/dev/null 2>&1; then
            echo "    removed md.myne.quickunlock / $acct"
          fi
          ;;
      esac
    done <<<"$quick_accounts"
  done
fi

echo
echo "==> reset done. 'pnpm start' brings up a fresh, unenrolled pair."
