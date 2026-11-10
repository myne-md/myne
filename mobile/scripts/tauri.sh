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

# `tauri ios dev` PROMPTS for a device index when it is given none, and a prompt whose
# stdin is not a terminal (the dev menu's, a pipe) reads EOF and reprints "Not to be
# pushy, but you need to pick a device." until it is killed - measured at 1.3 million
# lines in five minutes, which reads as tool spam and never starts the app. So a device
# is named HERE, once, for every entry point: MYNE_IOS_DEVICE when set, else a booted
# simulator, else the first available iPhone.
# Xcode treats a `-force_load` path as a REQUIRED build input: the file has to exist
# before xcodebuild starts. The real archive is produced DURING the build, by the Rust
# link (`ios-link.sh` globalizes the swift-rs symbols and stages a copy), so a build
# whose cache is cold fails with `error: Build input file cannot be found:
# .../Externals/arm64/debug/sim/libTauri.globalized.a`. A valid empty archive is the
# 8-byte `!<arch>` magic; the Rust link replaces it with the real one before the app
# link runs, and an empty one links as a no-op rather than as a wrong-platform object.
stage_ios_link_placeholder() {
  for cfg in debug release; do
    for plat in sim ios; do
      dest="$PWD/src-tauri/gen/apple/Externals/arm64/$cfg/$plat/libTauri.globalized.a"
      [ -f "$dest" ] && continue
      mkdir -p "$(dirname "$dest")" 2>/dev/null || true
      printf '!<arch>\n' > "$dest" 2>/dev/null || true
    done
  done
}

pick_ios_device() {
  if [ -n "${MYNE_IOS_DEVICE:-}" ]; then
    printf '%s\n' "$MYNE_IOS_DEVICE"
    return 0
  fi
  local name
  # `simctl` pads every line with trailing spaces, so the state is matched with ` *$`.
  name=$(xcrun simctl list devices booted 2>/dev/null | sed -n 's/^ *\(.*\) ([0-9A-F-]\{36\}) (Booted) *$/\1/p' | head -1)
  if [ -z "$name" ]; then
    name=$(xcrun simctl list devices available 2>/dev/null | sed -n 's/^ *\(iPhone.*\) ([0-9A-F-]\{36\}) (.*) *$/\1/p' | head -1)
  fi
  [ -n "$name" ] || return 1
  printf '%s\n' "$name"
}

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
    # A device is a positional BEFORE `--`: after it, tauri hands the argument to the
    # runner instead, which is how `pnpm mobile:ios -- "iPhone 18 Pro"` reached the CLI
    # as runtime args and still prompted.
    stage_ios_link_placeholder
    if [ -z "${3:-}" ] || [ "${3:-}" = "--" ]; then
      case "${2:-}" in
        dev|run)
          device=$(pick_ios_device || true)
          if [ -n "$device" ]; then
            if [ "${3:-}" = "--" ]; then set -- "$1" "$2" "$device" "${@:3}"; else set -- "$1" "$2" "$device"; fi
          else
            echo "error: no iOS simulator found - open one in Xcode, or set MYNE_IOS_DEVICE" >&2
            exit 1
          fi
          ;;
      esac
    fi
    run_tauri "$@"
    ;;
  *)
    run_tauri "$@"
    ;;
esac
