#!/usr/bin/env bash
# CI backstop for pre-commit checks that otherwise live ONLY in the lefthook
# pre-commit set (lefthook.yml) and are therefore bypassable with --no-verify /
# LEFTHOOK=0 / a clone that never ran `lefthook install`. CLAUDE.md's model is
# "hooks are the local net, CI is the remote gate" — but these had no remote
# gate at all. This script provides it. Git-only (no cargo/node), so it stays
# cheap and runs in any image with git + file installed.
#
# Deliberately NOT covered here:
#   - i18n-catalog  -> checked in the `pnpm-build` CI step (needs node).
#   - damm32 table  -> VALUE drift is already caught by `cargo test -p protocol`
#                      (damm32_table_matches_runtime_construction, a normal
#                      #[test]); only the hook's TEXTUAL sentinel-block sync is
#                      hook-exclusive, and that low-stakes formatting check is
#                      not worth porting the generator+diff into a CI image.
#
# Kept in lockstep with lefthook.yml: the exclusion lists below MUST match the
# eof-newline / whitespace hooks there.
set -u
fail=0

echo "== SPDX header on every tracked protocol/ source file =="
while IFS= read -r f; do
  [ -f "$f" ] || continue
  if ! head -1 "$f" | grep -q 'SPDX-License-Identifier: AGPL-3.0'; then
    echo "  missing SPDX header: $f"
    fail=1
  fi
done < <(git ls-files -- 'protocol' | grep '\.rs$')
[ "$fail" -eq 0 ] && echo "  ok"

echo "== EOF newline (tracked tree; hook exclusions) =="
eof_fail=0
while IFS= read -r f; do
  case "$f" in
    docs/design/icons/*|docs/design/assets/*|docs/design/preview/*) continue ;;
    src-tauri/icons/*|public/*.svg) continue ;;
    src-tauri/resources/dictionaries/*) continue ;;
    src-tauri/resources/models/*) continue ;;
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
  if git diff --check "$base" "$tip" -- ':(exclude)src-tauri/resources/dictionaries/**' ':(exclude)src-tauri/resources/models/**'; then
    echo "  ok"
  else
    fail=1
  fi
else
  echo "  no resolvable commit range -> skipped (pre-commit hook covers staged diffs)"
fi

exit $fail
