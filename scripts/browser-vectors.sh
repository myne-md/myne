#!/usr/bin/env bash
# Run the `myne-test-vectors` fixtures inside a real browser
# (phase3-web-client task 15).
#
#   scripts/browser-vectors.sh              # headless Chrome, release build
#   CHROMEDRIVER=/path/to/chromedriver scripts/browser-vectors.sh
#
# # Why a browser and not `cargo test --target wasm32-...`
#
# Cross-implementation agreement is a property of compiled code **on its
# execution target**. The desktop client's target is aarch64/x86_64 and the
# native run covers it. The web client's is a browser's wasm engine, which is a
# different compiler backend, a different memory model (32-bit, 4 GiB address
# space) and a different float/SIMD story — and no amount of native green says
# anything about it. `wasm_bindgen_test_configure!(run_in_browser)` in
# `protocol/tests/vectors.rs` is what puts the module in the browser; this script
# is what supplies the driver and the fixtures.
#
# The runners themselves are the SAME SOURCE the native lane runs. That is the
# load-bearing part: a second copy of 34 runners would agree with the first one
# right up until somebody edited one of them.
set -euo pipefail

cd "$(dirname "$0")/.."

VECTORS_DIR="myne-test-vectors"
CACHE_DIR="${BROWSER_VECTORS_CACHE:-${TMPDIR:-/tmp}/myne-browser-vectors}"

# ── the fixtures ─────────────────────────────────────────────────────────────
#
# Hard failure, deliberately unlike the native lane. `cargo test --test vectors`
# SKIPS when the companion is absent, which is right for a contributor who has
# not cloned it — but this script exists only to run the gate, so "no fixtures"
# means the gate did not run, and a gate that reports success without running is
# the one failure mode worth preventing outright.
if [ ! -d "$VECTORS_DIR/vectors" ]; then
  echo "browser-vectors: the myne-test-vectors companion is not checked out at ./$VECTORS_DIR" >&2
  echo "" >&2
  echo "  ./workspace/setup.sh          # clones every companion from workspace/manifest.txt" >&2
  echo "" >&2
  echo "Without it there is nothing to verify — this script does not skip, because" >&2
  echo "a cross-implementation gate that passes with no vectors is worse than none." >&2
  exit 1
fi

# ── the test runner ──────────────────────────────────────────────────────────
#
# Version-locked to the `wasm-bindgen` in the shared `Cargo.lock`, read rather
# than hardcoded, for the same reason `build-wasm.sh` does it: the runner and the
# library must match exactly — the glue the runner drives encodes the ABI the
# library was compiled against.
WASM_BINDGEN_VERSION="$(
  awk '/^name = "wasm-bindgen"$/{getline; gsub(/version = |"/,""); print; exit}' Cargo.lock
)"
if [ -z "$WASM_BINDGEN_VERSION" ]; then
  echo "browser-vectors: could not read the wasm-bindgen version from Cargo.lock" >&2
  exit 1
fi

runner_version() {
  command -v wasm-bindgen-test-runner >/dev/null 2>&1 &&
    wasm-bindgen-test-runner --version 2>/dev/null | awk '{print $2}'
}

if [ "$(runner_version || true)" != "$WASM_BINDGEN_VERSION" ]; then
  # The prebuilt release, not `cargo install`: building the CLI from source costs
  # minutes on every CI run, and this binary is a test harness rather than
  # anything that ships — its provenance is the same GitHub release
  # `wasm-bindgen-cli` is published from.
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) TRIPLE="x86_64-unknown-linux-musl" ;;
    Darwin-arm64) TRIPLE="aarch64-apple-darwin" ;;
    Darwin-x86_64) TRIPLE="x86_64-apple-darwin" ;;
    *)
      echo "browser-vectors: no prebuilt wasm-bindgen for $(uname -s)-$(uname -m)." >&2
      echo "  cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked" >&2
      exit 1
      ;;
  esac
  PKG="wasm-bindgen-${WASM_BINDGEN_VERSION}-${TRIPLE}"
  mkdir -p "$CACHE_DIR"
  if [ ! -x "$CACHE_DIR/$PKG/wasm-bindgen-test-runner" ]; then
    echo "== fetching wasm-bindgen-test-runner ${WASM_BINDGEN_VERSION} (${TRIPLE})"
    curl -fsSL \
      "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/${PKG}.tar.gz" \
      | tar -xz -C "$CACHE_DIR"
  fi
  PATH="$CACHE_DIR/$PKG:$PATH"
  export PATH
  if [ "$(runner_version || true)" != "$WASM_BINDGEN_VERSION" ]; then
    echo "browser-vectors: wasm-bindgen-test-runner ${WASM_BINDGEN_VERSION} is still not on PATH" >&2
    exit 1
  fi
fi

# ── the driver ───────────────────────────────────────────────────────────────
#
# `wasm-bindgen-test-runner` picks its browser from whichever driver it is given.
# Chrome is the default here because it is the one every CI image can install
# (`chromium-driver` on Debian); Firefox works identically via GECKODRIVER, and
# the Phase 0 spike already measured all three engines deriving byte-identical
# keys, so the choice is about availability rather than coverage.
if [ -z "${CHROMEDRIVER:-}" ] && [ -z "${GECKODRIVER:-}" ] && [ -z "${SAFARIDRIVER:-}" ]; then
  if command -v chromedriver >/dev/null 2>&1; then
    CHROMEDRIVER="$(command -v chromedriver)"
    export CHROMEDRIVER
  else
    echo "browser-vectors: no WebDriver found." >&2
    echo "" >&2
    echo "Set one of CHROMEDRIVER / GECKODRIVER / SAFARIDRIVER, or install a driver:" >&2
    echo "  Debian/CI : apt-get install -y chromium chromium-driver" >&2
    echo "  macOS dev : npx @puppeteer/browsers install chromedriver@\$(chrome --version)" >&2
    echo "" >&2
    echo "The driver's major version must match the installed browser's." >&2
    exit 1
  fi
fi

# ── run ──────────────────────────────────────────────────────────────────────
#
# `--features browser-vectors` is what bakes the fixtures into the binary (a
# browser cannot read `myne-test-vectors/` at run time). It is passed explicitly
# and NOT defaulted on, because `include_str!` of an absent companion is a
# compile error — the default has to stay off so the crate builds without it.
# `protocol/tests/vectors.rs` carries a test that fails if this lane ever runs
# without the feature, so a forgotten flag cannot present as 34 quiet passes.
#
# `--release`: the Argon2id vectors run the real 256 MiB parameters, and a debug
# wasm build turns a 5-second suite into minutes.
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner
exec cargo test -p protocol --test vectors \
  --target wasm32-unknown-unknown \
  --features browser-vectors \
  --release "$@"
