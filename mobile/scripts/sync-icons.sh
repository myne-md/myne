#!/usr/bin/env bash
# Syncs the committed Myne app-icon sets (src-tauri/icons/{ios,android}) into
# the regenerated platform projects (src-tauri/gen — git-ignored, re-stamped
# with stock Tauri icons by every `tauri [ios|android] init`). Runs on every
# `tauri … dev/build` via the beforeDevCommand/beforeBuildCommand hooks in
# src-tauri/tauri.conf.json, and from scripts/android-postinit.sh after a
# fresh init. Idempotent — safe to run repeatedly.
#
# A platform whose gen/ project doesn't exist yet is skipped (init not run);
# a missing committed icon SOURCE is a hard error.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC_IOS=src-tauri/icons/ios
SRC_ANDROID=src-tauri/icons/android
DEST_IOS=src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset
DEST_ANDROID=src-tauri/gen/android/app/src/main/res

for src in "$SRC_IOS" "$SRC_ANDROID"; do
  if [ ! -d "$src" ]; then
    echo "error: $src not found — the committed icon set is missing" >&2
    exit 1
  fi
done

# iOS: PNGs only — gen's Contents.json already references these exact
# filenames; the watch app's committed catalog (ios-watch/) is separate.
if [ -d "$DEST_IOS" ]; then
  count=0
  for f in "$SRC_IOS"/*.png; do
    cp "$f" "$DEST_IOS/"
    count=$((count + 1))
  done
  echo "sync-icons: iOS — $count PNGs → $DEST_IOS"
else
  echo "sync-icons: iOS skipped (no gen/apple — run 'pnpm tauri ios init' first)"
fi

# Android: mipmap PNGs + adaptive-icon XML (mipmap-anydpi-v26) + its
# @color/ic_launcher_background resource. File-by-file to merge into the
# existing res/ tree (cp -R on same-named dirs would nest, not merge).
if [ -d "$DEST_ANDROID" ]; then
  count=0
  while IFS= read -r rel; do
    mkdir -p "$DEST_ANDROID/$(dirname "$rel")"
    cp "$SRC_ANDROID/$rel" "$DEST_ANDROID/$rel"
    count=$((count + 1))
  done < <(cd "$SRC_ANDROID" && find . -type f | sed 's|^\./||')
  echo "sync-icons: Android — $count files → $DEST_ANDROID"
else
  echo "sync-icons: Android skipped (no gen/android — run 'pnpm tauri android init' first)"
fi
