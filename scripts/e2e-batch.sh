#!/usr/bin/env bash
# Run SEVERAL e2e spec files, EACH in its own vitest process (isolated — avoids
# full-suite contamination), inside ONE container session (amortizes container
# startup + toolchain sync). Pass bare spec names (no e2e/ prefix, no .e2e.ts).
#   ./scripts/e2e-batch.sh multi-cursor find-replace heading-list-folding
#
# THREE ENVIRONMENT KNOBS, all of them opt-in and all of them the difference
# between a run that verified something and a run that reported green having
# verified nothing:
#   MYNE_E2E_RETRIES=0    hunt flake. The vitest config retries twice, which is
#                         right for a gate and wrong for a measurement: a failing
#                         attempt is erased and the flake rate reads as zero.
#   MYNE_E2E_QUARANTINE=1 run ONLY the `describeE2E.flaky` specs. Without it a
#                         quarantined spec self-skips and this reports success.
#   MYNE_E2E_AI=1         run the inference suites. Needs the
#                         `local-inference-stub` build too: use e2e-ai-buildrun.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/e2e-docker.sh
source scripts/lib/e2e-docker.sh
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
# **`MYNE_E2E_RETRIES=0` is how you hunt flake, and until now no runner offered
# it.** `e2e/AGENTS.md` says so in as many words: with retries on, a failing
# attempt is erased from the report and the flake rate reads as zero no matter
# how bad it is. The config's own default is 2, which is right for a gate and
# exactly wrong for a measurement.
RETRY_FLAG=""
if [ -n "${MYNE_E2E_RETRIES:-}" ]; then
  RETRY_FLAG="--retry=${MYNE_E2E_RETRIES}"
fi

INNER='set +e; PASS=""; FAIL=""; SKIP="";'
for spec in "$@"; do
  INNER+=" echo \"==== RUN ${spec} ====\";"
  # Redirect rather than pipe: a pipe would make \$? tee's status, not vitest's.
  INNER+=" xvfb-run -a pnpm exec vitest run $RETRY_FLAG --config vitest.e2e.config.ts e2e/${spec}.e2e.ts > /tmp/e2e-out 2>&1; RC=\$?; cat /tmp/e2e-out;"
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
  "${E2E_MEMBER_NM_VOLUMES[@]}"
  -v "$E2E_TARGET_VOLUME":/work/target
  "${E2E_REGISTRY_MOUNT[@]}"
  -w /work
  --user root
)
E2E_ENV='export HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true npm_config_store_dir=/home/e2e/.pnpm-store'
# Host-side append, NOT inside the single-quoted literal above: that string is
# passed through to the container's bash, where `$E2E_CARGO_JOBS` and
# `$E2E_CARGO_CODEGEN_UNITS` are unset and would expand to nothing. See
# scripts/lib/e2e-docker.sh.
E2E_ENV="$E2E_ENV $E2E_CARGO_JOBS $E2E_CARGO_CODEGEN_UNITS"

# **Forward the quarantine gate, or a quarantined spec SELF-SKIPS and this
# script reports SKIP for a run you believed verified something.** That is not
# hypothetical: it happened while releasing `tp1`, and only the three-bucket
# tally below turned "PASS" into "ran ZERO tests". `describeE2E.flaky` inverts on
# this variable, so a quarantined spec is unreachable from here without it.
# Expanded HOST-side on purpose: the container has no such variable to inherit.
E2E_ENV="$E2E_ENV MYNE_E2E_QUARANTINE=${MYNE_E2E_QUARANTINE:-0}"
# The AI suites need this AND the `local-inference-stub` build; without the pair
# they `describe.skip`. Forwarded for the same reason as above rather than
# supplied, since only `e2e-ai-buildrun.sh` produces the matching binary.
E2E_ENV="$E2E_ENV MYNE_E2E_AI=${MYNE_E2E_AI:-0}"

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

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $E2E_CARGO_HOME_CHOWN && $E2E_FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $INNER
  '
"
