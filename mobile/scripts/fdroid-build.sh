#!/usr/bin/env bash
# Build one F-Droid ABI artefact in a dev checkout.
#
# WHY THIS EXISTS. F-Droid builds Myne from source on its own buildserver, from
# the recipe in `mobile/fdroid/md.myne.mobile.yml`. That recipe is the only thing
# that can prove the app is still buildable by somebody who is not us, and it is
# also the slowest thing in the world to iterate on: every attempt costs a
# container boot plus a `cargo install tauri-cli`, and a failure comes back as a
# gzipped log. This script is the same build, one ABI, in this checkout, so a
# broken step is reproduced in minutes rather than in a build cycle.
#
# It is NOT a replacement for the recipe, and it deliberately diverges in two
# places (both marked `DIVERGENCE` below): it does not strip `packageManager`
# from the manifests, and it does not run the recipe's `sudo:` toolchain
# install. Everything else is the same sequence in the same order, which is the
# point: if this goes green and the container goes red, the difference is the
# container's toolchain, not the build.
#
# One thing it CANNOT do, and the difference matters when reading its output:
# the recipe declares `output:` as `app-<abi>-release-unsigned.apk`, which is
# what Gradle writes on a machine with no `keystore.properties`. This machine has
# one, so the same build emits `app-<abi>-release.apk`, already signed with the
# release key. The script accepts either and says which it found.
#
# The one step that is NOT optional and that nothing else re-applies is
# `scripts/android-postinit.sh`. `gen/android` is git-ignored and regenerated
# whole by `tauri android init`, so the `:myne-widgets` gradle module lives in a
# committed script rather than in the generated tree. Skip it and the build
# fails at manifest merge on `@xml/myne_shortcuts`, because `src-tauri/build.rs`
# injects that `<meta-data>` on every Android build while the resource it names
# ships in `mobile/android-widgets/`.
#
# USAGE
#   ANDROID_HOME=… NDK_HOME=… mobile/scripts/fdroid-build.sh --abi armv7
#   mobile/scripts/fdroid-build.sh --abi all
#
# Run it from anywhere; it resolves the repo root from its own path.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOBILE="$REPO_ROOT/mobile"
GEN_GRADLE_REL="src-tauri/gen/android/app/build.gradle.kts"

ABI=""
SKIP_INSTALL=0

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --abi) ABI="${2:-}"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

[ -n "$ABI" ] || { echo "error: --abi is required (armv7|arm64|x86|x86_64|all)" >&2; exit 1; }

# Map one ABI to the four things that differ between recipe build blocks: the
# cargo/tauri target name, the APK output directory Tauri writes, and the
# versionCode multiplier digit. The digit order is F-Droid's, not ours: a client
# installs the highest versionCode its device can run, so armeabi-v7a must sort
# below arm64-v8a. See the recipe for the full arithmetic.
abi_target() {
  case "$1" in
    armv7) echo "armv7" ;;
    arm64) echo "aarch64" ;;
    x86) echo "i686" ;;
    x86_64) echo "x86_64" ;;
    *) echo "error: unknown abi '$1'" >&2; return 1 ;;
  esac
}
abi_outdir() {
  case "$1" in
    armv7) echo "arm" ;;
    arm64) echo "arm64" ;;
    x86) echo "x86" ;;
    x86_64) echo "x86_64" ;;
  esac
}
abi_digit() {
  case "$1" in
    armv7) echo 1 ;;
    arm64) echo 2 ;;
    x86) echo 3 ;;
    x86_64) echo 4 ;;
  esac
}

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is not on PATH${2:+ ($2)}" >&2; exit 1; }
}

preflight() {
  need node "install Node 25.9.0, see .nvmrc"
  need pnpm "corepack enable, or npm i -g pnpm@11.8.0"
  need cargo "see rust-toolchain.toml"
  [ -n "${ANDROID_HOME:-}" ] || { echo "error: ANDROID_HOME is unset (the Android SDK)" >&2; exit 1; }
  [ -n "${NDK_HOME:-}${ANDROID_NDK_HOME:-}" ] || { echo "error: NDK_HOME is unset (e.g. \$ANDROID_HOME/ndk/29.0.13846066)" >&2; exit 1; }
  export NDK_HOME="${NDK_HOME:-${ANDROID_NDK_HOME:-}}"

  # THE LFS TRAP, checked rather than assumed. fdroidserver has no git-lfs
  # handling at all (verified: no `lfs` reference in scanner.py, build.py or
  # common.py), so a clone without the LFS objects bundles 130-byte pointer
  # files instead of a 42 MB model and the app ships with transcription that
  # silently does nothing. The recipe compensates with an explicit
  # `git lfs pull`; this is the same check, earlier and louder.
  local model="$REPO_ROOT/src-tauri/resources/models/whisper-tiny/model.gguf"
  if [ -f "$model" ] && head -c 40 "$model" | grep -q '^version https://git-lfs'; then
    echo "error: $model is a Git LFS pointer, not the model." >&2
    echo "       run: git lfs install --local && git lfs pull" >&2
    exit 1
  fi
}

build_one() {
  local abi="$1" target outdir digit gradle out apk
  target="$(abi_target "$abi")"
  outdir="$(abi_outdir "$abi")"
  digit="$(abi_digit "$abi")"
  gradle="$MOBILE/$GEN_GRADLE_REL"

  echo "== myne f-droid build: abi=$abi target=$target versionCode digit=$digit =="

  if [ "$SKIP_INSTALL" -eq 0 ]; then
    echo "== pnpm install --frozen-lockfile (repo root: one lock for every workspace) =="
    ( cd "$REPO_ROOT" && pnpm install --frozen-lockfile )
  fi

  if [ ! -f "$MOBILE/src-tauri/gen/android/settings.gradle" ]; then
    echo "== tauri android init (gen/android is git-ignored and regenerated whole) =="
    ( cd "$MOBILE" && pnpm exec tauri android init )
  else
    echo "== tauri android init skipped: gen/android already exists =="
    echo "   (delete mobile/src-tauri/gen/android to regenerate it from scratch)"
  fi

  echo "== scripts/android-postinit.sh (re-applies what a fresh init clobbers) =="
  ( cd "$MOBILE" && bash scripts/android-postinit.sh )

  # DIVERGENCE 1: the recipe strips `packageManager` from package.json, because
  # its container installs pnpm globally at the pinned version and corepack
  # would otherwise fire and fetch its own. Locally corepack works, so this
  # script leaves the manifests alone. `git status` stays clean either way
  # except for the generated gradle below, which is git-ignored.
  #
  # The versionCode patch is per-ABI and is the recipe's, not an addition: four
  # APKs sharing one versionCode means F-Droid keeps only the highest and the
  # other three architectures silently disappear from the repo.
  echo "== versionCode: * 10 + $digit (per-ABI, F-Droid ordering) =="
  sed -i.bak -e "s|\.toInt()\$|.toInt() * 10 + $digit|" "$gradle"
  rm -f "$gradle.bak"

  echo "== cargo tauri android build --apk --split-per-abi --target $target =="
  ( cd "$MOBILE" && pnpm exec tauri android build --apk --split-per-abi --target "$target" )

  # Two possible names, and which one appears is not a detail. F-Droid's
  # buildserver has no `keystore.properties`, so Gradle emits
  # `app-<abi>-release-unsigned.apk` and F-Droid signs it. A developer machine
  # usually DOES have one (mode 600, git-ignored), so the same command emits
  # `app-<abi>-release.apk`, already signed. Asserting the unsigned name was this
  # script's first real bug: it built the APK successfully and then reported
  # failure because it looked for the other file.
  apk=""
  for cand in "app-$outdir-release-unsigned.apk" "app-$outdir-release.apk"; do
    candidate="$MOBILE/src-tauri/gen/android/app/build/outputs/apk/$outdir/release/$cand"
    if [ -f "$candidate" ]; then apk="$candidate"; break; fi
  done
  if [ -z "$apk" ]; then
    echo "error: no APK under $MOBILE/src-tauri/gen/android/app/build/outputs/apk/$outdir/release/" >&2
    exit 1
  fi

  out="$(du -h "$apk" | cut -f1)"
  echo
  echo "OK  $apk  ($out)"
  if command -v shasum >/dev/null 2>&1; then echo "    sha256 $(shasum -a 256 "$apk" | cut -d' ' -f1)"; fi
  # Version facts, read off the artefact rather than trusted: the per-ABI
  # versionCode is the whole reason the four build blocks exist.
  aapt2_bin="$(ls "$ANDROID_HOME"/build-tools/*/aapt2 2>/dev/null | tail -1)"
  if [ -n "$aapt2_bin" ]; then
    "$aapt2_bin" dump badging "$apk" 2>/dev/null | grep -E "^package:" || true
  fi
  case "$apk" in
    *-unsigned.apk)
      echo "    unsigned: this is the artefact the F-Droid recipe declares." ;;
    *)
      echo "    SIGNED, because mobile/src-tauri/gen/android/keystore.properties exists."
      echo "    F-Droid's buildserver has no keystore and emits the -unsigned name."
      echo "    This artefact is therefore NOT what the recipe outputs, so a hash from"
      echo "    it is not comparable with an F-Droid build." ;;
  esac
}

if [ "$ABI" = "all" ]; then
  preflight
  for a in armv7 arm64 x86 x86_64; do
    build_one "$a"
  done
else
  preflight
  build_one "$ABI"
fi
