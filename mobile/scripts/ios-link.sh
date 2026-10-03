#!/usr/bin/env bash
# iOS link wrapper for the Xcode 27 + swift-rs 1.0.8 linker trap.
#
# WHY THIS EXISTS. Under Xcode 27's SwiftPM layout, `swift-rs` cannot promote the
# tauri Swift package's `@_cdecl` exports (`_string_from_bytes`, `_data_from_bytes`,
# `_retain_object`, `_release_object`), and — the part the objcopy workaround misses —
# cargo does not put the Swift package's `-lTauri` on the final link at all: the link
# command carries `-L .../swift-rs/Tauri/release` but no `-lTauri`, so the symbols stay
# undefined even after `llvm-objcopy --globalize-symbol` marks them `T` in `libTauri.a`.
# Result: `Undefined symbols for architecture arm64: _string_from_bytes ...` at the
# `libmyne_mobile_lib` link.
#
# WHAT IT DOES. Injects `-Wl,-force_load,<newest libTauri.a>` into the link, restricted
# to the FINAL `libmyne_mobile_lib` output. Applying it to intermediate links (e.g. the
# `rten` lib) drags the Swift symbols into a context with no Swift runtime and breaks
# them, so the guard on the `-o` output name is load-bearing.
#
# HOW IT IS WIRED. `mobile/scripts/tauri.sh` exports
# CARGO_TARGET_AARCH64_APPLE_IOS_LINKER / ..._IOS_SIM_LINKER to this script for
# `ios dev|build|run`, so `pnpm tauri ios build` needs no manual env. When it is not
# wired (a bare `cargo build`), set it by hand:
#   CARGO_TARGET_AARCH64_APPLE_IOS_LINKER=mobile/scripts/ios-link.sh cargo build ...
#
# Upstream has no released fix (swift-rs 1.0.8 is the latest). Remove this wrapper when
# one lands. See `operations/runbooks/ios-app-store-release.md` §4b.
set -u

REAL_LD="${MYNE_IOS_REAL_LD:-/usr/bin/clang}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

out=""; prev=""; sim=0
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in *simulator*) sim=1 ;; esac
  prev="$a"
done

case "$out" in
  *myne_mobile_lib*)
    if [ "$sim" = "1" ]; then TRIPLE="aarch64-apple-ios-sim"; else TRIPLE="aarch64-apple-ios"; fi
    TAURI=$(ls -t "$REPO_ROOT/target/$TRIPLE/release/build/tauri-*/out/swift-rs/Tauri/release/libTauri.a" 2>/dev/null | head -1)
    if [ -n "$TAURI" ]; then
      exec "$REAL_LD" "$@" -Wl,-force_load,"$TAURI"
    fi
    ;;
esac

exec "$REAL_LD" "$@"
