#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Provision the two tools the pipeline EXECUTES, at pinned versions whose bytes
# this repository checks (myne-md/myne#758, security-audit lead NV02).
#
#   scripts/ci-pinned-tools.sh sccache cargo-nextest
#
# # The defect this closes
#
# Fourteen CI invocations ran `/cache/bin/sccache` and `/cache/bin/cargo-nextest`
# straight off a host-provided mount that no line in this repository provisions,
# pins or checksums (`RUSTC_WRAPPER` at eight sites, `cargo-nextest` at three
# verdicts plus the E2E lane). Every push therefore compiled with a compiler
# wrapper of unknown version chosen by whatever `/srv/wp-cache` on the CI box
# held, and nothing would have noticed a substituted binary. The contrast was in
# the same file: `cargo-deny` a few lines above downloads a pinned prebuilt
# release and verifies it with an inline `sha256sum -c`.
#
# # What it does, and why it is idempotent
#
# For each named tool: if `$TOOLS_DIR/<tool>` already hashes to the pinned
# binary digest, do nothing (one sha256 over the file, ~0.1 s). Otherwise
# download the pinned release tarball, verify ITS digest, extract the member,
# verify the member's digest against the pinned one, and publish it atomically
# with `install` + `mv` so concurrent steps provisioning the same tool cannot
# leave a torn binary behind.
#
# # Why the tools moved off `/cache/bin`
#
# The first pipeline to run this script failed in under a second with
# `install: cannot create regular file '/cache/bin/.sccache.11': Read-only file
# system`: `/cache/bin` is a READ-ONLY mount, and that is a defence worth
# keeping, because nothing a step runs can put a compiler wrapper there.
#
# So the provisioned tools live at `/cache/tools/bin`, beside the cargo and
# sccache caches that are the writable half of the same volume, and every
# reference in the workflows and in the E2E lane script names that path. What
# makes a binary trustworthy is the digest check on every step, not the mount:
# a placeholder dropped on a writable cache volume fails the same `sha256sum -c`
# that a pinned upstream download passes.
#
# # Two costs, both stated rather than hidden
#
# * `curl` is missing from `rust:1.96.0-slim` (measured: Debian 13 trixie, no
#   curl and no wget), so this bootstraps it with apt when it has to. That is a
#   few seconds in the steps that need a download, and it is the price of not
#   trusting an unverified binary.
# * Bumping a version here changes the bytes, not the cache key, so the first
#   pipeline after a bump compiles cold through sccache once. That is the same
#   trade the `cargo-deny` line above already makes.
#
# Nothing else in the repository needs to know: `check-pinned-ci-tools.mjs`
# holds these two versions to the paths the workflows use, so a step that keeps
# a hardcoded `/cache/tools/bin/<tool>` path still resolves to a provisioned
# binary, and a step that reaches back for `/cache/bin/<tool>` fails the guard
# with the read-only mount as its reason.
set -euo pipefail

# NOT `/cache/bin`. That path is a READ-ONLY mount on the CI host, and the first
# pipeline to run this script said so: `install: cannot create regular file
# '/cache/bin/.sccache.11': Read-only file system`. The read-only mount is a
# defence worth keeping (nothing running in a step can put a compiler wrapper
# there), so the provisioned tools live beside the cargo and sccache caches
# instead, which are the writable half of the same volume. Verification, not the
# mount, is what makes the binary trustworthy: every step hashes the installed
# file against the pin below before it executes it.
TOOLS_DIR="${MYNE_CI_TOOLS_DIR:-/cache/tools/bin}"

# Both pins are x86_64 Linux assets. Say so once, loudly, rather than exec a
# wrong-architecture binary and let the failure surface as a cryptic linker or
# exec error three steps later.
if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "ci-pinned-tools: pinned assets are Linux x86_64; this host is $(uname -s) $(uname -m)." >&2
  echo "  A non-x86_64 runner needs new pins here, not a bypass." >&2
  exit 1
fi

# ─── The pins ───────────────────────────────────────────────────────────────
# TARBALL_SHA256 is what protects the DOWNLOAD; BIN_SHA256 is what protects the
# INSTALLED file, and it is the one re-checked on every run, because that is the
# bytes the compiler wrapper and the test runner actually execute.
#
# Both are the upstream release assets' own digests, computed from the downloaded
# archives rather than copied from a `.sha256` sibling, because a sibling fetched
# from the same origin proves nothing about the origin.

ensure_tool() {
  local tool="$1" version url tarball_sha bin_sha member
  case "$tool" in
    sccache)
      version="0.19.0"
      url="https://github.com/mozilla/sccache/releases/download/v${version}/sccache-v${version}-x86_64-unknown-linux-musl.tar.gz"
      tarball_sha="aa73c7270c997894038c0d8f0d297865f57569e1687883322bc431713d4bb9dd"
      member="sccache-v${version}-x86_64-unknown-linux-musl/sccache"
      bin_sha="0b44834be857e21b026f7db49a7762023fedb5eb5ed60725a66f698d8d79a34b"
      ;;
    cargo-nextest)
      version="0.9.151"
      url="https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-${version}/cargo-nextest-${version}-x86_64-unknown-linux-musl.tar.gz"
      tarball_sha="6b284d6fde9670dfb6ee10ea9d9abbc85f95643d3f592472d420d82e257b3a6c"
      # This archive is flat: the binary IS the top-level member.
      member="cargo-nextest"
      # The musl build rather than the gnu one: it is statically linked, so the
      # same bytes run on the Debian build image and on the E2E image, and a
      # future base-image move cannot turn the test runner into a glibc error.
      bin_sha="559f38665a6fbb6a18900d7172cf7e9c9155d96916452209b91cdd9d30c80f4d"
      ;;
    *)
      echo "ci-pinned-tools: unknown tool '$tool' (known: sccache, cargo-nextest)" >&2
      exit 2
      ;;
  esac

  local dest="$TOOLS_DIR/$tool"
  if [ -x "$dest" ] && printf '%s  %s\n' "$bin_sha" "$dest" | sha256sum -c --status -; then
    echo "ci-pinned-tools: $tool $version verified at $dest" >&2
    return 0
  fi

  echo "ci-pinned-tools: provisioning $tool $version -> $dest" >&2
  if ! command -v curl >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y --no-install-recommends curl ca-certificates >/dev/null
  fi

  local tmp
  tmp="$(mktemp -d)"
  # `trap` on RETURN would fire on every function return in older bashes; an
  # explicit cleanup at the end of the happy path plus the `set -e` exit path is
  # enough, and the temp dir is under the container's /tmp either way.
  curl -fsSL "$url" -o "$tmp/tool.tgz"
  printf '%s  %s\n' "$tarball_sha" "$tmp/tool.tgz" | sha256sum -c -
  tar -xzf "$tmp/tool.tgz" -C "$tmp" "$member"
  printf '%s  %s\n' "$bin_sha" "$tmp/$member" | sha256sum -c -

  if ! mkdir -p "$TOOLS_DIR" 2>/dev/null || [ ! -w "$TOOLS_DIR" ]; then
    echo "ci-pinned-tools: $TOOLS_DIR is not writable, so $tool $version cannot be provisioned." >&2
    echo "  The cache mounts as this container sees them:" >&2
    mount 2>/dev/null | grep -E " /cache" >&2 || true
    echo "  To fix it, run this ONCE on the CI host against the mounted directory:" >&2
    echo "    sudo MYNE_CI_TOOLS_DIR=/srv/wp-cache/tools/bin $0 $tool" >&2
    echo "  or point this run somewhere writable with MYNE_CI_TOOLS_DIR." >&2
    rm -rf "$tmp"
    exit 1
  fi
  # Publish atomically: several steps provision in parallel on the same mount,
  # and a half-written compiler wrapper is worse than a cold cache.
  install -m0755 "$tmp/$member" "$TOOLS_DIR/.$tool.$$"
  mv -f "$TOOLS_DIR/.$tool.$$" "$dest"
  rm -rf "$tmp"
}

if [ "$#" -eq 0 ]; then
  set -- sccache cargo-nextest
fi
for tool in "$@"; do
  ensure_tool "$tool"
done
