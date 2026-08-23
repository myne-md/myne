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
# shellcheck source=scripts/lib/e2e-docker.sh
source scripts/lib/e2e-docker.sh
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

RUN_FLAGS=(
  --rm
  -v "$(pwd):/work"
  -v myne-e2e-node-modules:/work/node_modules
  # Member node_modules MUST be volumes too (mirrors e2e-local.sh): the
  # container's pnpm install otherwise rewrites the bind-mounted members'
  # symlinks to container-side .pnpm hashes, breaking the HOST install.
  "${E2E_MEMBER_NM_VOLUMES[@]}"
  -v "$E2E_TARGET_VOLUME":/work/target
  # At `$CARGO_HOME/registry`, and the reason is in `scripts/lib/e2e-docker.sh`.
  # This runner found it and fixed itself while recording that the four siblings
  # were still mounting the volume where nothing reads it; that divergence is
  # closed, and the mount lives in the include so a seventh runner inherits it.
  "${E2E_REGISTRY_MOUNT[@]}"
  -w /work
  --user root
)
E2E_ENV='export HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true MYNE_E2E_AI=1 npm_config_store_dir=/home/e2e/.pnpm-store'

FIX_PERMS='chown -R e2e:e2e /work/node_modules /work/dialect/node_modules /work/editor/node_modules /work/copy/node_modules /work/ornaments/node_modules /work/preview/node_modules /work/target'

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $E2E_CARGO_HOME_CHOWN && $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $INNER
  '
"
