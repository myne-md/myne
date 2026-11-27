#!/usr/bin/env bash
# The guard battery that gates both the PR lane and the full battery.
#
# `ci.yml` and `ci-full.yml` both call this file, so the two lanes cannot drift
# apart. Guards that need a private companion, a built artifact, macOS, a
# registry or a store credential are deliberately not here; the `Fires in`
# column in scripts/repo-guards.md is the authority for those.
#
# Keep this list in step with the rows in scripts/repo-guards.md that say they
# run in CI. A guard added to that roster as CI-gated but missing here is a bug.
set -u

fail=0

run() {
  printf '== %s\n' "$*"
  if ! "$@"; then
    fail=1
  fi
}

# The original ci-full guard set.
run node scripts/check-platform-seam.mjs
run node scripts/check-plain-surface-imports.mjs
run node scripts/check-core-task-seam.mjs
run node scripts/check-core-io-seam.mjs
run node scripts/check-version-routing.mjs
run node scripts/check-crypto-registries.mjs
run node scripts/check-prefs-nonce.mjs
run node scripts/check-device-actor.mjs
run node scripts/check-sync-authority.mjs
run node scripts/check-datetime-display-publisher.mjs
run node scripts/check-clipboard-feedback.mjs
run node scripts/check-unwired.mjs
run node scripts/check-ipc-binding-callers.mjs
run node scripts/check-export-callers.mjs
run node scripts/check-tracing-discipline.mjs
run node scripts/check-comment-density.mjs
run node scripts/check-copy-membership.mjs
run node scripts/check-private-path-refs.mjs
run node scripts/check-fdroid-metadata.mjs
run bash scripts/hooks-parity-check.sh

# Guards that were left only in lefthook's local battery. All of these are
# public-tree-safe and were verified against a clean checkout.
run node scripts/check-mcp-tool-surface.mjs
run node scripts/check-story-catalogue.mjs
run node scripts/check-ignored-tests.mjs
run node scripts/check-test-typecheck.mjs
run node scripts/check-icons.mjs
run node scripts/check-ornament-vocabulary.mjs
run node scripts/check-token-parity.mjs
run node scripts/check-token-adoption.mjs
run node scripts/check-primitive-adoption.mjs
run node scripts/check-hex-helpers.mjs
run node scripts/check-story-coverage.mjs
run node scripts/check-foundations-coverage.mjs
run node scripts/check-twin-inventory.mjs
run node scripts/check-twin-drift-ratchet.mjs
run node scripts/check-npm-license-mirror.mjs

exit "$fail"
