#!/usr/bin/env bash
# Run SEVERAL e2e spec files, EACH in its own vitest process (isolated — avoids
# full-suite contamination), inside ONE container session (amortizes container
# startup + toolchain sync). Pass bare spec names (no e2e/ prefix, no .e2e.ts).
#   ./scripts/e2e-batch.sh multi-cursor find-replace heading-list-folding
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=myne-e2e

# Build the in-container loop that runs each spec separately and tallies results.
#
# THREE buckets, not two. A spec that SELF-SKIPS — no binary, an unset env gate,
# a build variant missing the feature it needs — runs zero tests and exits 0,
# which the old two-bucket tally reported as PASS. That is the worst possible
# reading: it says "verified" about a scenario that never executed. It happened
# here: `ai-summarize` and `writing-assistant` were reported PASS by this script
# while both had skipped for want of the `local-inference-stub` build.
#
# The classification reads vitest's own summary line rather than the exit code,
# because the exit code cannot distinguish the two. `Test Files  N skipped (N)`
# with no `passed` on the line means every file in that run skipped.
INNER='set +e; PASS=""; FAIL=""; SKIP="";'
for spec in "$@"; do
  INNER+=" echo \"==== RUN ${spec} ====\";"
  # Redirect rather than pipe: a pipe would make \$? tee's status, not vitest's.
  INNER+=" xvfb-run -a pnpm exec vitest run --config vitest.e2e.config.ts e2e/${spec}.e2e.ts > /tmp/e2e-out 2>&1; RC=\$?; cat /tmp/e2e-out;"
  INNER+=" if [ \$RC -ne 0 ]; then FAIL=\"\$FAIL ${spec}\";"
  # Double quotes, not single: this whole string ends up inside `su -c '...'`,
  # where a single quote terminates the wrapper and the shell dies with
  # "unexpected end of file" before running anything.
  INNER+=" elif grep -qE \"Test Files.*skipped\" /tmp/e2e-out && ! grep -qE \"Test Files.*passed\" /tmp/e2e-out; then SKIP=\"\$SKIP ${spec}\";"
  INNER+=" else PASS=\"\$PASS ${spec}\"; fi;"
done
INNER+=' echo "________ BATCH SUMMARY ________"; echo "PASS:$PASS"; echo "FAIL:$FAIL";'
INNER+=' if [ -n "$SKIP" ]; then echo "SKIP (ran ZERO tests — NOT verified):$SKIP"; fi;'

RUN_FLAGS=(
  --rm
  -v "$(pwd):/work"
  -v myne-e2e-node-modules:/work/node_modules
  -v myne-e2e-target:/work/target
  -v myne-e2e-cargo-registry:/usr/local/cargo/registry
  -w /work
  --user root
)
E2E_ENV='export HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true npm_config_store_dir=/home/e2e/.pnpm-store'

# Point the multi-device sync specs at a LINUX myne-server binary if one has been
# cross-compiled (`e2e-local.sh` builds it; this script does not, to stay fast).
# Without it those specs self-skip on "not an ELF binary" — which this script's
# third bucket reports honestly, but a SKIP is not a verification, and running
# `./scripts/e2e-batch.sh sync-replication` and reading "no failures" is exactly
# the mistake the bucket exists to prevent. Nothing is built here; an absent
# binary keeps the previous behaviour.
for arch in arm64 amd64; do
  if [ -x "myne-server/myne-server-linux-$arch" ]; then
    E2E_ENV="$E2E_ENV MYNE_E2E_SERVER=/work/myne-server/myne-server-linux-$arch"
    break
  fi
done
FIX_PERMS='chown -R e2e:e2e /work/node_modules /work/target /usr/local/cargo/registry'

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $INNER
  '
"
