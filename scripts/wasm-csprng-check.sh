#!/usr/bin/env bash
# wasm32 target gate for the `protocol` crate (phase3-web-client task 9).
#
# Two things this asserts, and the second is the one that matters.
#
# 1. `cargo build -p protocol --target wasm32-unknown-unknown` succeeds, so the
#    target cannot rot between web-client tasks.
#
# 2. The CSPRNG hook is UNRESOLVED, i.e. the build fails loudly rather than
#    silently linking with no entropy source.
#
#    `getrandom`'s `custom` feature declares `__getrandom_custom` as an
#    `extern "Rust"` hook that the embedder registers. Nothing in `protocol`
#    registers it — registration belongs to the Worker host (task 81) — and an
#    rlib link never resolves undefined symbols, so `cargo build` for wasm32
#    passes with no entropy source at all. That is the trap: "wasm32 builds
#    green" is not evidence that the randomness path works, and a check that
#    stopped at (1) would be checking nothing about randomness.
#
#    So we look at the symbol directly: `__getrandom_custom` must be present
#    and UNDEFINED in the wasm build of the getrandom rlib. Undefined means the
#    final link (the cdylib the Worker host produces) MUST resolve it or fail —
#    which is exactly the loud failure the design wants. If it were ever
#    DEFINED here, something in the graph had quietly supplied a backend, and
#    the "one explicit, auditable entropy decision at the boundary" property
#    would be gone without anyone noticing.
#
# 3. And a forward guard: `getrandom` 0.3+ replaced the `custom` hook with a
#    `--cfg getrandom_backend="wasm_js"` RUSTFLAG that requires wasm-bindgen.
#    The workspace lock already carries 0.2.17, 0.3.4 and 0.4.2 (the newer ones
#    pulled by other crates), so the day one reaches `protocol`'s shipped graph
#    the entropy story changes silently. Fail then, not later.
#
# Runs in the web CI lane. Native builds are untouched: the `custom` feature is
# declared under `[target.'cfg(target_arch = "wasm32")'.dependencies]`, and the
# native getrandom rlib carries no such symbol at all.

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

echo "== protocol builds for wasm32-unknown-unknown =="
# `--message-format=json` so the getrandom rlib is read from THIS build's
# artifact record rather than found on disk. A `find` would happily pick a stale
# rlib left by an earlier build with different features — which makes the whole
# gate pass for the wrong binary. (Observed: switching `custom` to `js` and
# re-running still reported "ok", because the previous `custom` rlib was still
# sitting in deps/.)
BUILD_LOG="$(mktemp)"
if ! cargo build -p protocol --target wasm32-unknown-unknown \
      --message-format=json-render-diagnostics > "$BUILD_LOG"; then
  echo "  FAIL: wasm32 build of the protocol crate broke."
  cat "$BUILD_LOG" >&2
  rm -f "$BUILD_LOG"
  exit 1
fi
echo "  ok"

echo "== getrandom's custom hook is present and UNRESOLVED =="
GETRANDOM_RLIB="$(grep '"name":"getrandom"' "$BUILD_LOG" \
  | grep -o '"filenames":\[[^]]*\]' \
  | tr ',' '\n' | tr -d '[]"' | sed 's/^filenames://' \
  | grep 'libgetrandom-.*\.rlib$' | tail -1)"
rm -f "$BUILD_LOG"
if [ -z "$GETRANDOM_RLIB" ] || [ ! -f "$GETRANDOM_RLIB" ]; then
  echo "  FAIL: this build produced no getrandom rlib — the dependency left protocol's wasm"
  echo "        graph, which means the entropy source is no longer where this gate can see it."
  exit 1
fi

# llvm-nm ships with the llvm-tools component; fall back to a plain nm.
NM="$(find "$(rustc --print sysroot)" -name 'llvm-nm' 2>/dev/null | head -1)"
[ -n "$NM" ] || NM="$(command -v llvm-nm || command -v nm || true)"
if [ -z "$NM" ]; then
  echo "  FAIL: no nm available (install the llvm-tools rustup component)."
  exit 1
fi

SYM_LINE="$("$NM" "$GETRANDOM_RLIB" 2>/dev/null | grep '__getrandom_custom' | head -1)"
if [ -z "$SYM_LINE" ]; then
  echo "  FAIL: __getrandom_custom is absent from the wasm getrandom rlib."
  echo "        Either the 'custom' feature is no longer enabled for wasm32 (check the"
  echo "        [target.'cfg(target_arch = \"wasm32\")'.dependencies] block in protocol/Cargo.toml),"
  echo "        or getrandom moved to a backend that needs no embedder hook — in which case"
  echo "        the entropy source changed and this gate must be rewritten, not deleted."
  fail=1
elif ! echo "$SYM_LINE" | grep -qE '^[[:space:]]*U[[:space:]]|[[:space:]]U[[:space:]]+__getrandom_custom'; then
  echo "  FAIL: __getrandom_custom is DEFINED, not undefined:"
  echo "        $SYM_LINE"
  echo "        Something in the shipped graph supplies a CSPRNG backend implicitly. The web"
  echo "        client's entropy source must be one explicit registration in the Worker host"
  echo "        (task 81), never an implicit default."
  fail=1
else
  echo "  ok — undefined, so the final wasm link must resolve it or fail"
fi

echo "== no wasm-bindgen in protocol's shipped wasm graph =="
# The `custom` vs `js` choice is recorded in protocol/Cargo.toml as deliberate:
# `js` drags wasm-bindgen and a codegen step into a `#![no_std]` primitive
# crate. Asserting wasm-bindgen's ABSENCE is what keeps that a decision rather
# than a default someone flips back without noticing.
if cargo tree -p protocol -e normal --target wasm32-unknown-unknown 2>/dev/null \
     | grep -q 'wasm-bindgen'; then
  echo "  FAIL: wasm-bindgen reached protocol's shipped wasm graph."
  echo "        The crate is #![no_std] and deliberately has no build-tool dependency; the"
  echo "        entropy backend is the embedder-registered 'custom' hook, not getrandom's"
  echo "        'js' feature. Changing that is a dependency decision (root AGENTS.md)."
  fail=1
else
  echo "  ok"
fi

echo "== no getrandom 0.3+ in protocol's shipped wasm graph without an explicit backend =="
NEWER="$(cargo tree -p protocol -e normal --target wasm32-unknown-unknown 2>/dev/null \
          | grep -oE 'getrandom v[0-9]+\.[0-9]+\.[0-9]+' | grep -vE 'getrandom v0\.2\.' || true)"
if [ -n "$NEWER" ]; then
  if echo "${RUSTFLAGS:-}" | grep -q 'getrandom_backend="wasm_js"'; then
    echo "  ok — $NEWER present, RUSTFLAGS carries getrandom_backend=\"wasm_js\""
  else
    echo "  FAIL: $NEWER reached protocol's shipped wasm graph."
    echo "        getrandom 0.3+ drops the 'custom' hook; a wasm build needs"
    echo "        RUSTFLAGS='--cfg getrandom_backend=\"wasm_js\"' (and therefore wasm-bindgen),"
    echo "        which is a dependency decision, not a lockfile side effect. Record it in the"
    echo "        pinned reproducible wasm build before allowing it."
    fail=1
  fi
else
  echo "  ok — 0.2 only"
fi

# `myne-core` is the other half, and it DOES resolve getrandom 0.4 — deliberately
# (phase3-web-client task 81). `uuid`'s `rng-getrandom` reaches it, and 0.3+
# dropped the embedder hook in favour of a `wasm_js` backend.
#
# The property to hold is not "0.4 is absent" — it is that the backend selection
# is part of the PINNED BUILD rather than of the operator's environment. Turned
# on by a Cargo FEATURE (`getrandom_v04 = { features = ["wasm_js"] }`), it is in
# the manifest and the lock, so the reproducible-build check reproduces it. Left
# to a `RUSTFLAGS='--cfg getrandom_backend="wasm_js"'`, it is an env var: the
# same source tree would build with a different entropy path depending on who ran
# it, and the published hash would stop meaning one artefact.
#
# So this fails if the RUSTFLAG is what is carrying it, even though the build
# would work — a build that only works with the right environment is not a
# reproducible one.
echo "== myne-core's getrandom 0.4 backend is pinned by MANIFEST, not by RUSTFLAGS =="
CORE_HAS_04="$(cargo tree -p myne-core -e normal --target wasm32-unknown-unknown 2>/dev/null \
                | grep -oE 'getrandom v0\.[34]\.[0-9]+' | head -1 || true)"
if [ -z "$CORE_HAS_04" ]; then
  echo "  ok — no getrandom 0.3+ in core's wasm graph"
elif grep -q 'getrandom_v04 = { package = "getrandom", version = "0.4", features = \["wasm_js"\] }' core/Cargo.toml; then
  if echo "${RUSTFLAGS:-}" | grep -q 'getrandom_backend'; then
    echo "  FAIL: $CORE_HAS_04 is present AND RUSTFLAGS carries getrandom_backend."
    echo "        Two selectors for one decision. The manifest feature is the pinned one;"
    echo "        drop the RUSTFLAG so the artefact does not depend on the environment."
    fail=1
  else
    echo "  ok — $CORE_HAS_04, backend enabled by the manifest feature (in the lock, reproducible)"
  fi
else
  echo "  FAIL: $CORE_HAS_04 is in core's wasm graph with no manifest-pinned backend."
  echo "        getrandom 0.3+ needs \`wasm_js\`. Enable it as a CARGO FEATURE in"
  echo "        core/Cargo.toml, not as a RUSTFLAG — a RUSTFLAG makes the entropy path a"
  echo "        property of whoever ran the build, and the published bundle hash then"
  echo "        stops meaning one artefact."
  fail=1
fi

exit $fail
