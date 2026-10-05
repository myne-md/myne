#!/usr/bin/env bash
# Copies the staged Apple Watch app into Myne.app/Watch/ during the iOS app's
# post-compile phase. Apple requires the watch app at exactly `Watch/` inside the
# iOS bundle; `MyneWatchComplications.appex` is already inside
# MyneWatch.app/PlugIns/ (built by the watch target's own dependency).
#
# Pair of ios-watch-build.sh; see that file for why the watch is built out of the
# Tauri archive (myne-md/myne#803).
set -euo pipefail

GEN_DIR="${SRCROOT:-$(cd "$(dirname "$0")/../src-tauri/gen/apple" && pwd)}"
SRC="$GEN_DIR/watch-build/MyneWatch.app"
DEST="${TARGET_BUILD_DIR:-$GEN_DIR/build/Debug-iphoneos}/${WRAPPER_NAME:-Myne.app}/Watch"

if [ ! -d "$SRC" ]; then
  echo "error: $SRC missing — ios-watch-build.sh did not stage the watch app" >&2
  exit 1
fi

mkdir -p "$DEST"
rm -rf "$DEST/MyneWatch.app"
cp -R "$SRC" "$DEST/MyneWatch.app"
echo "ios-watch-embed: Myne.app/Watch/MyneWatch.app"
