#!/usr/bin/env bash
# Stage the built Tauri Swift module into `gen/apple/Externals/arm64/<cfg>/` so the
# APP TARGET can `import Tauri`.
#
# WHY THIS EXISTS. `mobile/src-tauri/ios/project.yml` compiles the
# `ios-watch/Receiver` directory as loose sources inside the `myne-mobile_iOS`
# app target, and one of those files (`WCMeetingReceiver.swift`) subclasses
# Tauri's `Plugin`, so it needs `import Tauri`. A Tauri plugin resolves that
# module because it lives in its own SwiftPM package, which declares a dependency
# on the Tauri package; the app target has no such package dependency, so the
# Swift compiler cannot resolve it even though the LINK force-loads
# `libTauri.globalized.a` (force-loading supplies symbols to the linker, not the
# module interface to the compiler). The `tauri-<hash>` build dir is not
# addressable from the pbxproj, so this copies the module to the same stable path
# the archive is staged at, and the app target's SWIFT_INCLUDE_PATHS points there.
# myne-md/myne#840.
#
# Runs as the "Stage Tauri Swift Module" pre-build phase in project.yml, ordered
# AFTER "Build Rust Code" (which produces the module). It is deliberately a
# separate phase rather than folded into `ios-link.sh`: the link wrapper only
# runs when cargo actually relinks, so on an incremental build it can be skipped
# and the module would never be staged.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GEN_EXTERNALS="$REPO_ROOT/mobile/src-tauri/gen/apple/Externals/arm64"

case "${PLATFORM_NAME:-iphoneos}" in
  *simulator*) TRIPLE="aarch64-apple-ios-sim"; PRODUCTS="Release-iphonesimulator" ;;
  *) TRIPLE="aarch64-apple-ios"; PRODUCTS="Release-iphoneos" ;;
esac

# swift-rs always builds the Tauri package in the release profile (the archive
# `ios-link.sh` force-loads is `.../Tauri/release/libTauri.a` regardless of the
# app configuration), so the module path is profile-independent.
SRC=$(ls -td "$REPO_ROOT"/target/"$TRIPLE"/release/build/tauri-*/out/swift-rs/Tauri/out/Products/"$PRODUCTS" 2>/dev/null | head -1)
if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "ios-stage-tauri-module: no Tauri Products dir for $TRIPLE ($PRODUCTS); nothing staged" >&2
  exit 0
fi

# Stage under both config dirs: a release build compiles with CONFIGURATION=release,
# a dev/simulator build with debug, and SWIFT_INCLUDE_PATHS uses $(CONFIGURATION).
for cfg in release debug; do
  dest="$GEN_EXTERNALS/$cfg"
  mkdir -p "$dest"
  for mod in "$SRC"/*.swiftmodule; do
    [ -d "$mod" ] || continue
    rm -rf "$dest/$(basename "$mod")"
    cp -Rf "$mod" "$dest/"
  done
done

echo "ios-stage-tauri-module: staged $(ls "$SRC"/*.swiftmodule 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
