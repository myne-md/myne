#!/usr/bin/env bash
# `myne-core` wasm32 dependency-graph gate (phase3-web-client task 78).
#
# What this asserts is narrower than "myne-core builds for wasm", and that is
# deliberate. On the pre-change tree `cargo check -p myne-core --target
# wasm32-unknown-unknown` stopped in the DEPENDENCY GRAPH — at `uuid`, before a
# single line of core code compiled — with three more walls behind it (`tokio`'s
# `rt-multi-thread` compile_error, `rustls`+`ring` with no wasm backend,
# `getrandom 0.2` with no wasm arm). Task 78 removes those four walls. It does
# NOT remove core's 445 Tauri type references; that is task 79, and until it
# lands the check still fails — but it fails INSIDE core, which is the pass
# condition here.
#
# So the gate is: the graph resolves, and the failure (if any) is core's own
# code rather than a dependency refusing to build for the target. Written as a
# check rather than left to a human reading build output, because the difference
# between "stopped at uuid" and "stopped at core/src/plugins/sync/commands.rs"
# is invisible in a red CI badge, and a regression that puts the wall back would
# otherwise look identical to the expected failure.
#
# When task 79 lands, `cargo check` here goes green and the "expected: core's own
# errors" arm below becomes dead — that is the signal to tighten this script to a
# plain success assertion.

set -uo pipefail
cd "$(dirname "$0")/.."

echo "== myne-core's wasm32 dependency graph resolves =="

LOG="$(mktemp)"
cargo check -p myne-core --target wasm32-unknown-unknown > "$LOG" 2>&1
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  echo "  ok — the whole crate checks for wasm32 (task 79 has landed; tighten this gate)"
  rm -f "$LOG"
  exit 0
fi

# A dependency refusing the target announces itself with its own compile_error!
# text. These are the four walls task 78 removed, by name — a regression
# reintroducing any of them must be loud, not absorbed into "core doesn't build
# for wasm yet, we know".
WALLS='specify a source of randomness|Only features sync,macros,io-util,rt,time are supported|not supported by default|no wasm32 backend|could not compile `(uuid|tokio|rustls|getrandom|ring)`'
if grep -qE "$WALLS" "$LOG"; then
  echo "  FAIL: a dependency refused wasm32 — the graph no longer resolves."
  grep -E "$WALLS" "$LOG" | head -5
  echo
  echo "  Fix the target arms in core/Cargo.toml ([target.'cfg(target_arch = \"wasm32\")'.dependencies]"
  echo "  and its cfg(not(...)) sibling). This is NOT the expected 'core still references tauri'"
  echo "  failure — that one names files under core/src."
  rm -f "$LOG"
  exit 1
fi

# Expected until task 79: core's own code fails to compile because it still
# imports tauri. Confirm that is actually what happened rather than assuming it.
if grep -qE 'unresolved import `tauri`|cannot find (module|crate) `tauri`' "$LOG"; then
  echo "  ok — graph resolves; the check now reaches core's own code and stops at its"
  echo "       remaining tauri references, which is task 79's scope."
  rm -f "$LOG"
  exit 0
fi

echo "  FAIL: wasm32 check failed for an unrecognised reason — neither a dependency"
echo "        refusing the target nor core's known tauri references:"
tail -30 "$LOG"
rm -f "$LOG"
exit 1
