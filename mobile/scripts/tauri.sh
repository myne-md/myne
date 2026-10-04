#!/usr/bin/env bash
# Wraps the Tauri CLI for the mobile client so the committed iOS project wiring
# (`scripts/ios-postinit.sh`) is re-applied on every iOS dev/build/run — the one
# code path that otherwise silently drops the widget + watch targets after a
# fresh `tauri ios init`. myne-md/myne#803.
#
# Wired as the package's `tauri` script, so BOTH `pnpm --filter myne-mobile
# tauri ...` and the release runbook's `cd mobile && pnpm tauri ios build ...`
# go through it. Non-iOS commands (android, dev, …) are passed straight through.
#
# `ios xcode-script` is deliberately NOT wrapped: the app target's "Build Rust
# Code" pre-build phase invokes it from inside the xcodebuild run, and running
# xcodegen there would regenerate the pbxproj mid-build.
set -euo pipefail
cd "$(dirname "$0")/.."

run_tauri() { exec pnpm exec tauri "$@"; }

if [ "${1:-}" != "ios" ]; then
  run_tauri "$@"
fi

case "${2:-}" in
  init)
    # Let init create the project, THEN overlay the committed spec.
    pnpm exec tauri "$@"
    bash scripts/ios-postinit.sh
    exit $?
    ;;
  dev|build|run)
    if [ -f src-tauri/gen/apple/project.yml ]; then
      bash scripts/ios-postinit.sh
    else
      echo "error: src-tauri/gen/apple/project.yml is missing — run 'pnpm tauri ios init' first" >&2
      exit 1
    fi
    # Xcode 27 + swift-rs 1.0.8: cargo never puts the tauri Swift package's
    # `-lTauri` on the final link, so the SRString symbols stay undefined. The
    # wrapper force-loads the archive for the final libmyne_mobile_lib link
    # only. Both triples are set so a device build and a simulator build each get
    # it. See mobile/scripts/ios-link.sh and ios-app-store-release.md §4b.
    export CARGO_TARGET_AARCH64_APPLE_IOS_LINKER="$PWD/scripts/ios-link.sh"
    export CARGO_TARGET_AARCH64_APPLE_IOS_SIM_LINKER="$PWD/scripts/ios-link.sh"
    run_tauri "$@"
    ;;
  *)
    run_tauri "$@"
    ;;
esac
