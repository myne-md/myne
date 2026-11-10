#!/usr/bin/env bash
# iOS link wrapper for the Xcode 27 + swift-rs 1.0.8 linker trap.
#
# WHY THIS EXISTS. Under Xcode 27's SwiftPM layout, the tauri Swift package is
# emitted as a single member `merged.o`, and `swift-rs 1.0.8`'s
# `globalize_cdecl_symbols` only promotes `@_cdecl` exports when the member is
# named `<package>.o`. So the four C ABI symbols the Swift side defines
# (`_string_from_bytes`, `_data_from_bytes`, `_retain_object`, `_release_object`)
# stay LOCAL (`t`) in `libTauri.a`'s `SwiftRs.o`. The Rust side (`swift_rs` crate)
# references them as UNDEFINED externals, and:
#
#   - cargo never puts `-lTauri` on the final link (only `-L .../swift-rs/Tauri/release`),
#     so the archive is not pulled in at all; AND
#   - even `-Wl,-force_load,<libTauri.a>` does NOT resolve an UNDEFINED external
#     against a LOCAL definition: force-loading pulls the archive's members into
#     the link, but a local `t` definition is invisible to the symbol resolver.
#
# Both halves are required, and the second one is the half a plain force-load
# misses. Measured on 2026-10-05: with force-load alone the link still fails with
# `Undefined symbols for architecture arm64: _string_from_bytes ...`.
#
# WHAT IT DOES. Copies `libTauri.a` to a per-archive cache path, GLOBALIZES the
# four symbols in the copy with `llvm-objcopy --globalize-symbol`, then injects
# `-Wl,-force_load,<globalized copy>` into the link. Restricted to the FINAL
# `libmyne_mobile_lib` output: applying it to an intermediate link (e.g. the
# `rten` lib) drags the Swift symbols into a context with no Swift runtime and
# breaks them, so the guard on the `-o` output name is load-bearing.
#
# The copy, never the original: mutating cargo's own `libTauri.a` in place would
# change its mtime/content and trip cargo's fingerprint, forcing a rebuild loop.
#
# `llvm-objcopy` is a BUILD-HOST tool, not a repo dependency. Install it with
# `brew install llvm` (it lands at /opt/homebrew/opt/llvm/bin/llvm-objcopy).
# If it is absent, the wrapper falls back to a bare force-load (which is the
# state this wrapper was in until 2026-10-05) and says so on stderr, so a link
# failure names the real missing piece instead of reading as a code error.
#
# HOW IT IS WIRED. `mobile/scripts/tauri.sh` exports
# CARGO_TARGET_AARCH64_APPLE_IOS_LINKER / ..._IOS_SIM_LINKER to this script for
# `ios dev|build|run`, so `pnpm tauri ios build` needs no manual env. When it is
# not wired (a bare `cargo build`), set it by hand:
#   CARGO_TARGET_AARCH64_APPLE_IOS_LINKER=mobile/scripts/ios-link.sh cargo build ...
#
# Upstream has no released fix (swift-rs 1.0.8 is the latest). Remove this
# wrapper when one lands. See `operations/runbooks/ios-app-store-release.md` §4b.
set -u

REAL_LD="${MYNE_IOS_REAL_LD:-/usr/bin/clang}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so a host with llvm elsewhere still works; the Homebrew default is
# what `brew install llvm` produces.
OBJCOPY="${MYNE_IOS_OBJCOPY:-/opt/homebrew/opt/llvm/bin/llvm-objcopy}"

out=""; prev=""; sim=0
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in *simulator*) sim=1 ;; esac
  prev="$a"
done

case "$out" in
  *myne_mobile_lib*)
    if [ "$sim" = "1" ]; then TRIPLE="aarch64-apple-ios-sim"; else TRIPLE="aarch64-apple-ios"; fi
    # The glob MUST be unquoted, or bash leaves the `*` literal and the `ls`
    # finds nothing (the wrapper then silently falls through to a bare link with
    # no force-load at all). This was the actual defect behind the 2026-10-05
    # `Undefined symbols` failure: the wrapper ran, matched its `-o` guard, and
    # then found no archive to force-load.
    TAURI=$(ls -t "$REPO_ROOT"/target/"$TRIPLE"/release/build/tauri-*/out/swift-rs/Tauri/release/libTauri.a 2>/dev/null | head -1)
    if [ -n "$TAURI" ]; then
      if [ -x "$OBJCOPY" ]; then
        # Cache the globalized copy beside the archive, keyed on its contents so
        # a rebuilt libTauri.a produces a fresh copy. `stat -f %m` is the macOS
        # mtime; the archive's path already identifies the tauri build hash.
        FIXED="${TAURI%.a}.globalized.a"
        if [ ! -f "$FIXED" ] || [ "$TAURI" -nt "$FIXED" ]; then
          cp -f "$TAURI" "$FIXED"
          "$OBJCOPY" \
            --globalize-symbol=_string_from_bytes \
            --globalize-symbol=_data_from_bytes \
            --globalize-symbol=_retain_object \
            --globalize-symbol=_release_object \
            "$FIXED" 2>/dev/null || true
        fi
        if nm "$FIXED" 2>/dev/null | grep -q ' T _string_from_bytes'; then
          # Also stage the globalized archive where the APP-level link can
          # force-load it. The Rust static lib ('libapp.a') keeps swift_rs's
          # references as UNDEFINED into the app link, so the app link needs the
          # same globalized definitions; `project.yml`'s OTHER_LDFLAGS
          # force-loads this staged copy by a STABLE path (the tauri-<hash>
          # build dir is not addressable from the pbxproj). $(CONFIGURATION) is
          # `release` for a release build; both are staged so either config
          # resolves.
          # Stage under a PER-PLATFORM directory (`sim/` or `ios/`), because a
          # device build and a simulator build are both arm64 and both stage into
          # `Externals/arm64/<config>/`: with one path, whichever ran last won and the
          # next link of the other kind failed with `ld: building for 'iOS-simulator',
          # but linking in object file ... built for 'iOS'`. `project.yml` force-loads
          # the matching one through `OTHER_LDFLAGS[sdk=...]`.
          if [ "$sim" = "1" ]; then plat="sim"; else plat="ios"; fi
          for cfg in release debug; do
            dest="$REPO_ROOT/mobile/src-tauri/gen/apple/Externals/arm64/$cfg/$plat/libTauri.globalized.a"
            # Drop the OLD shared path if a previous run left one: it is a wrong
            # platform archive for one of the two links, and nothing references it.
            rm -f "$REPO_ROOT/mobile/src-tauri/gen/apple/Externals/arm64/$cfg/libTauri.globalized.a" 2>/dev/null || true
            mkdir -p "$(dirname "$dest")" 2>/dev/null || true
            cp -f "$FIXED" "$dest" 2>/dev/null || true
          done
          exec "$REAL_LD" "$@" -Wl,-force_load,"$FIXED"
        fi
        echo "ios-link: warning: $OBJCOPY did not globalize the swift-rs symbols; falling back to force-load only" >&2
      else
        echo "ios-link: warning: $OBJCOPY not found (brew install llvm); force-load alone will not resolve the local swift-rs symbols" >&2
      fi
      exec "$REAL_LD" "$@" -Wl,-force_load,"$TAURI"
    fi
    ;;
esac

exec "$REAL_LD" "$@"
