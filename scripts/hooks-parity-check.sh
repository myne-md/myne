#!/usr/bin/env bash
# CI backstop for pre-commit checks that otherwise live ONLY in the lefthook
# pre-commit set (lefthook.yml) and are therefore bypassable with --no-verify /
# LEFTHOOK=0 / a clone that never ran `lefthook install`. AGENTS.md's model is
# "hooks are the local net, CI is the remote gate" — but these had no remote
# gate at all. This script provides it. It needs THREE tools, and the list is
# not incidental: `git` (candidate set), `file` (the binary sniff that skips
# vendored blobs in the EOF-newline scan), and `node` — the SPDX half is
# `scripts/check-spdx-headers.mjs`, one file shared with the pre-commit hook,
# NOT the shell loop it used to be. The CI step installs all three.
#
# Deliberately NOT covered here:
#   - i18n-catalog  -> checked in the `pnpm-build` CI step (needs node).
#   - platform-seam -> checked in the `pnpm-build` CI step (needs node), same
#                      reason as i18n-catalog. It IS remotely gated; it is just
#                      gated there rather than here.
#   - core-task-seam -> same: `pnpm-build` CI step, needs node.
#   - web-command-coverage -> same: `pnpm-build` CI step, needs node.
#   - core-io-seam  -> same: `pnpm-build` CI step, needs node.
#   - web-capabilities -> same: `pnpm-build` CI step, needs node.
#   - clippy-wasm   -> a pre-PUSH hook, and it already has a remote gate: the
#                      same `cargo clippy -p myne-core -p protocol --target
#                      wasm32-unknown-unknown -- -D warnings` runs in the
#                      `wasm-protocol` CI step (phase3-web-client task 77). Listed
#                      here anyway, because "not in this script" and "not gated
#                      remotely" are different facts and only one of them is a
#                      hole — the point of this list is that a reader can tell
#                      which.
#   - damm32 table  -> VALUE drift is already caught by `cargo test -p protocol`
#                      (damm32_table_matches_runtime_construction, a normal
#                      #[test]); only the hook's TEXTUAL sentinel-block sync is
#                      hook-exclusive, and that low-stakes formatting check is
#                      not worth porting the generator+diff into a CI image.
#   - protected-branch -> a pre-PUSH hook, and the one entry on this list with no
#                      remote gate available AT ALL, by construction. The gate
#                      would be server-side branch protection, and the org's plan
#                      does not offer it for private repos (403 from both the
#                      branch-protection and the rulesets API on every repo); a CI
#                      check cannot stand in, because CI runs after the push has
#                      already landed. Recorded here rather than ported.
#
#                      It is also the only hook in this repo hand-copied into ten
#                      OTHER repos, with nothing holding the copies identical.
#                      That is deliberate and not a factoring waiting to happen:
#                      they are separate git repos, `scripts/` ships only in this
#                      one, and a comparison script here could inspect only the
#                      clones that happen to be on the machine running it, which
#                      is a check that skips on missing input, and that reads as a
#                      pass. The copies are compared by hand at review. #592.
#
# Kept in lockstep with lefthook.yml: the exclusion lists below MUST match the
# eof-newline / whitespace hooks there.
set -u
fail=0

echo "== SPDX header on every tracked Rust source file =="
if ! node scripts/check-spdx-headers.mjs; then
  fail=1
fi

echo "== EOF newline (tracked tree; hook exclusions) =="
eof_fail=0
while IFS= read -r f; do
  case "$f" in
    agent-tooling/docs/design/icons/*|agent-tooling/docs/design/assets/*|agent-tooling/docs/design/preview/*) continue ;;
    src-tauri/icons/*|public/*.svg) continue ;;
    src-tauri/resources/dictionaries/*) continue ;;
    src-tauri/resources/models/*) continue ;;
    */permissions/schemas/schema.json) continue ;;
  esac
  [ -f "$f" ] || continue
  if file --mime "$f" | grep -q 'charset=binary'; then continue; fi
  if [ -n "$(tail -c1 "$f")" ]; then
    echo "  missing EOF newline: $f"
    eof_fail=1
  fi
done < <(git ls-files)
if [ "$eof_fail" -ne 0 ]; then fail=1; else echo "  ok"; fi

echo "== trailing whitespace (diff-scoped, matches the pre-commit hook) =="
# The pre-commit hook is `git diff --cached --check` — diff-scoped by design, so
# it never flags intentional trailing whitespace (e.g. markdown hard-break test
# fixtures). A whole-tree scan WOULD flag those, so mirror the diff scope here
# using the CI commit range. If the range can't be resolved (shallow clone,
# first push), skip cleanly — the pre-commit hook already covers staged diffs.
base="${CI_PREV_COMMIT_SHA:-}"
tip="${CI_COMMIT_SHA:-HEAD}"
if [ -n "$base" ] && git rev-parse -q --verify "${base}^{commit}" >/dev/null 2>&1; then
  # Exclusions mirror lefthook.yml's `whitespace` job, which carries the
  # rationale for each: vendored upstream data, and the captured theme-preview
  # snapshot (generated, do-not-hand-edit).
  if git diff --check "$base" "$tip" -- ':(exclude)src-tauri/resources/dictionaries/**' ':(exclude)src-tauri/resources/models/**' ':(exclude)preview/src/preview.html' ':(exclude)preview/src/preview.css'; then
    echo "  ok"
  else
    fail=1
  fi
else
  echo "  no resolvable commit range -> skipped (pre-commit hook covers staged diffs)"
fi

exit $fail
