#!/usr/bin/env bash
# Builds the Myne Apple Watch app (+ its complication) under the real watchOS SDK
# and stages it at gen/apple/watch-build/MyneWatch.app for embedding.
#
# WHY THIS EXISTS (myne-md/myne#803): `tauri ios build` archives the
# myne-mobile_iOS scheme under `-sdk iphoneos`. That command-line `-sdk` overrides
# a target's own SDKROOT, so when MyneWatch is a normal target dependency of the
# app it compiles against the iOS SDK — and every watchOS WidgetKit API in the
# complication fails ("'AccessoryWidgetBackground' is only available in iOS 16.0
# or newer"), killing the whole archive before the app is even built. The fix is
# to build the watch OUT of that archive, with an explicit `-sdk watchos`, and
# copy the result into Myne.app/Watch/ (Apple requires that exact path).
#
# This runs from a script phase INSIDE the app's xcodebuild, so it inherits the
# outer build's signing identity through the environment (EXPANDED_CODE_SIGN_
# IDENTITY etc.). Reusing that identity is REQUIRED: the watch app is embedded
# into the iOS app, and xcodebuild refuses "Embedded binary is not signed with
# the same certificate as the parent app" otherwise.
set -euo pipefail

# A SIMULATOR build embeds no watch companion, and cannot: watchOS apps are
# built for device arm64_32 and installed by a paired phone, not by an iOS
# simulator. Building one here asked for a provisioning profile for
# `md.myne.mobile.watchkitapp.ext` and failed the whole app build on any machine
# without one (myne-md/myne#918 task 6 found it; CI never builds iOS, so nothing
# had ever run this phase for the simulator). Skip rather than weaken the signing
# rules for the device path, which is the one that ships.
if [ "${PLATFORM_NAME:-}" = "iphonesimulator" ]; then
  echo "ios-watch-build: skipped (simulator build embeds no watch companion)"
  exit 0
fi

GEN_DIR="${SRCROOT:-$(cd "$(dirname "$0")/../src-tauri/gen/apple" && pwd)}"
cd "$GEN_DIR"

CONFIG="${CONFIGURATION:-Release}"

SIGN_ARGS=()
if [ -n "${MYNE_IOS_NO_SIGN:-}" ]; then
  SIGN_ARGS=(CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO)
else
  # Inherit the outer archive's signing, so the embedded watch matches the app.
  [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ] && SIGN_ARGS+=(EXPANDED_CODE_SIGN_IDENTITY="$EXPANDED_CODE_SIGN_IDENTITY")
  [ -n "${CODE_SIGN_IDENTITY:-}" ] && SIGN_ARGS+=(CODE_SIGN_IDENTITY="$CODE_SIGN_IDENTITY")
  TEAM="${DEVELOPMENT_TEAM:-${APPLE_DEVELOPMENT_TEAM:-}}"
  [ -n "$TEAM" ] && SIGN_ARGS+=(DEVELOPMENT_TEAM="$TEAM")
  [ -n "${PROVISIONING_PROFILE_SPECIFIER:-}" ] && SIGN_ARGS+=(PROVISIONING_PROFILE_SPECIFIER="$PROVISIONING_PROFILE_SPECIFIER")
  SIGN_ARGS+=(CODE_SIGN_STYLE=Automatic)
fi

echo "ios-watch-build: building MyneWatch under watchos SDK ($CONFIG)"
xcodebuild \
  -project myne-mobile.xcodeproj \
  -target MyneWatch \
  -configuration "$CONFIG" \
  -sdk watchos \
  -destination generic/platform=watchOS \
  "${SIGN_ARGS[@]}" \
  CONFIGURATION_BUILD_DIR="$GEN_DIR/watch-build" \
  build

if [ ! -d watch-build/MyneWatch.app ]; then
  echo "error: MyneWatch.app was not produced under watchos SDK" >&2
  exit 1
fi
echo "ios-watch-build: staged watch-build/MyneWatch.app"
