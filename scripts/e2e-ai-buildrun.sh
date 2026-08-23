#!/usr/bin/env bash
# `e2e-buildrun.sh`, but for the AI-feature build variant.
#
# The AI scenarios need TWO things that the ordinary runner does not supply, and
# BOTH or neither: the binary must be built `--features local-inference-stub`
# (so `StubEngine` answers instead of a missing model), and the suite must run
# with `MYNE_E2E_AI=1` (so `aiDescribe` is not `describe.skip`). CI pairs them in
# `.woodpecker.yml`; locally there was no way to get them at all, which is how a
# whole family of specs came to be written without ever being run once.
#
#   ./scripts/e2e-ai-buildrun.sh agent-run
#   ./scripts/e2e-ai-buildrun.sh agent-run agent-run agent-run   # the 3x gate
#
# Repeating a spec runs it that many times in the SAME warm container, which is
# how `e2e/CLAUDE.md` says to prove the 3x-consecutive gate: a fresh container
# per run re-provisions the pinned toolchain and flakes the boot, so a loop of
# single runs measures the harness rather than the scenario.
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=myne-e2e

# `voice-capture-stub` is what `e2e-buildrun.sh` passes and the rest of the
# suite expects; `local-inference-stub` is this runner's reason to exist.
# The `touch` forces the frontend re-embed; scripts/e2e-buildrun.sh says why.
INNER='set -e; pnpm install --frozen-lockfile && touch src-tauri/src/lib.rs && pnpm tauri build --no-bundle -- --features voice-capture-stub,local-inference-stub; set +e; PASS=""; FAIL="";'
i=0
for spec in "$@"; do
  i=$((i + 1))
  INNER+=" echo \"==== RUN ${i}: ${spec} ====\";"
  INNER+=" xvfb-run -a pnpm exec vitest run --config vitest.e2e.config.ts e2e/${spec}.e2e.ts;"
  INNER+=" if [ \$? -eq 0 ]; then PASS=\"\$PASS ${i}:${spec}\"; else FAIL=\"\$FAIL ${i}:${spec}\"; fi;"
done
INNER+=' echo "________ BATCH SUMMARY ________"; echo "PASS:$PASS"; echo "FAIL:$FAIL";'

# The target volume is PER TREE, and that is a correctness requirement rather
# than tidiness. Every tree is bind-mounted at the same in-container path,
# `/work`, so two checkouts of this repo are indistinguishable to cargo: same
# package name, same version, same absolute source path. With one shared volume
# a build here happily reuses an rlib compiled from a DIFFERENT tree, and the
# only symptom is a compile error in code the diff never touched. Measured:
# `myne-desktop` refused with `run_probe` taking 2 arguments and `ProbeProgress`
# unresolved, while `core/src/plugins/agent/probe.rs` in this tree declared 3 and
# defined the struct. rustc's own note pointed at line 164, and line 164 of
# `.claude/worktrees/554-manual-test-debt/core/src/plugins/agent/probe.rs` is
# exactly that function. Worktrees live under `.claude/worktrees/` by
# convention, so they are inside the bind mount and this is the normal case, not
# an exotic one.
#
# The cost is one full rebuild per tree, once. That is what the sharing was
# buying, at the price of results that describe another tree.
TREE_KEY=$(pwd | shasum | cut -c1-12)
RUN_FLAGS=(
  --rm
  -v "$(pwd):/work"
  -v myne-e2e-node-modules:/work/node_modules
  # Member node_modules MUST be volumes too (mirrors e2e-local.sh): the
  # container's pnpm install otherwise rewrites the bind-mounted members'
  # symlinks to container-side .pnpm hashes, breaking the HOST install.
  -v myne-e2e-nm-dialect:/work/dialect/node_modules
  -v myne-e2e-nm-editor:/work/editor/node_modules
  -v myne-e2e-nm-copy:/work/copy/node_modules
  -v myne-e2e-nm-ornaments:/work/ornaments/node_modules
  -v myne-e2e-nm-preview:/work/preview/node_modules
  -v "myne-e2e-target-$TREE_KEY":/work/target
  # **At `$CARGO_HOME/registry`, not `/usr/local/cargo/registry`.** `E2E_ENV`
  # below sets `CARGO_HOME=/home/e2e/.cargo`, so that is the only registry path
  # cargo reads or writes; a volume mounted anywhere else is a cache nothing
  # consults. Mounted at the image's default path, this runner re-downloaded the
  # crates.io index and every crate source on EVERY invocation, threw the result
  # away with `--rm`, and spent ~15 min doing it before the first line of the
  # build appeared. Nothing reports that: the run is green, only slow, which is
  # why it survived.
  #
  # The four sibling runners (`e2e-buildrun.sh`, `e2e-local.sh`, `e2e-one.sh`,
  # `e2e-batch.sh`) still mount it at the unused path. This file was copied from
  # them, so the defect is theirs first; fixing them is a change with its own
  # claim to verify and does not belong in myne-md/myne#529. Deliberate
  # divergence, recorded here rather than left to read as a typo.
  -v myne-e2e-cargo-registry:/home/e2e/.cargo/registry
  -w /work
  --user root
)
E2E_ENV='export HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true MYNE_E2E_AI=1 npm_config_store_dir=/home/e2e/.pnpm-store'

FIX_PERMS='chown -R e2e:e2e /work/node_modules /work/dialect/node_modules /work/editor/node_modules /work/copy/node_modules /work/ornaments/node_modules /work/preview/node_modules /work/target /home/e2e/.cargo/registry'

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $INNER
  '
"
