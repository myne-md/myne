#!/usr/bin/env bash
# Rebuild the production binary (product code changed), then run the given specs
# EACH isolated. Use after touching src/ or src-tauri/.
#   ./scripts/e2e-buildrun.sh wikilink-deep-links heading-list-folding
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/e2e-docker.sh
source scripts/lib/e2e-docker.sh
IMAGE=myne-e2e

# `--features voice-capture-stub`: see scripts/e2e-local.sh (myne#389 item D).
#
# `--features local-inference-stub` is the second half of that list and its
# absence here was a defect, not a default. Every other lane builds with it:
# `.woodpecker/e2e.yml`'s release binary, `main.yml`'s `tauri-compile` (so the
# stub arms cannot bit-rot), and `scripts/e2e-local.sh`, whose own comment names
# this exact consequence. Bare defaults pull the real Candle engine, the final
# `myne_desktop_lib` rustc then instantiates candle + tokenizers generic code on
# top of tauri, webkit and the app, and that single invocation does not fit a
# constrained VM: measured 2026-10-12 at 145 MiB free against an 11.9 GiB colima VM
# with an unrelated 4 GiB container stack running, which is what produced a
# `(signal: 9, SIGKILL)` on that crate that reads as a compile error and is the
# OOM killer (e2e/AGENTS.md). The stub keeps the `local-inference` feature and its
# deps ENABLED while compiling the stub body, so the binary matches the one CI
# tests and the `MYNE_E2E_AI=1` suites work here rather than reaching for a model
# no runner has. Nothing on this runner wants the Candle engine.
#
# The `touch` is load-bearing and cost an hour to find. The frontend is EMBEDDED
# in the binary at compile time, and a change confined to `src/` (or any other
# frontend tree) leaves every Rust source untouched, so cargo relinks nothing and
# the binary keeps whatever bundle it embedded when it was last compiled. It was
# found in its cross-tree form, back when the cargo target volume was shared:
# this script rebuilt cleanly, `pnpm build` emitted a correct `dist/`, and the app
# under test loaded `main-CoKDUqv9.js` from `.worktrees/554-…/dist`, whose
# host still dispatched the pre-fix event. The scenario failed and read as "the
# production fix does not work", which is the worst possible wrong answer from a
# green build. `scripts/lib/e2e-docker.sh` now keys that volume per tree, so the
# stale bundle can only be THIS tree's; the `touch` is still what stops that one,
# and it costs one link.
# `MYNE_E2E_RETRIES=0` is how `e2e/AGENTS.md` says to hunt flake, and this
# runner used to be the one that silently ignored it: the config's default of 2
# erased every failing first attempt from the report. Same wiring as
# e2e-one.sh / e2e-batch.sh / e2e-local.sh.
RETRY_FLAG=""
if [ -n "${MYNE_E2E_RETRIES:-}" ]; then
  RETRY_FLAG="--retry=${MYNE_E2E_RETRIES}"
fi

INNER='set -e; pnpm install --frozen-lockfile && touch src-tauri/src/lib.rs && pnpm tauri build --no-bundle -- --features voice-capture-stub,local-inference-stub; set +e; PASS=""; FAIL="";'
for spec in "$@"; do
  INNER+=" echo \"==== RUN ${spec} ====\";"
  INNER+=" xvfb-run -a pnpm exec vitest run $RETRY_FLAG --config .config/vitest/e2e.config.ts e2e/${spec}.e2e.ts;"
  INNER+=" if [ \$? -eq 0 ]; then PASS=\"\$PASS ${spec}\"; else FAIL=\"\$FAIL ${spec}\"; fi;"
done
INNER+=' echo "________ BATCH SUMMARY ________"; echo "PASS:$PASS"; echo "FAIL:$FAIL";'

RUN_FLAGS=(
  --rm
  -v "$(pwd):/work"
  -v myne-e2e-node-modules:/work/node_modules
  # Member node_modules MUST be volumes too (mirrors e2e-local.sh): the
  # container's pnpm install otherwise rewrites the bind-mounted members'
  # symlinks to container-side .pnpm hashes, breaking the HOST install
  # (symptom: host tsc "Cannot find module '@excalidraw/excalidraw'").
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
E2E_ENV="$E2E_ENV $E2E_CARGO_JOBS $E2E_CARGO_CODEGEN_UNITS $E2E_CARGO_OPT_LEVEL $E2E_SIDECAR_FEATURES $E2E_LANE_ENV"

# The multi-device sync specs need a LINUX myne-server binary inside the
# container (the host binary is the dev OS's arch) — same wiring as
# e2e-local.sh. Missing binary => the sync specs self-skip with a reason.
case "$(docker info --format '{{.Architecture}}' 2>/dev/null)" in
  x86_64|amd64) SRVARCH=amd64 ;;
  *) SRVARCH=arm64 ;;
esac
if [[ -f "myne-server/myne-server-linux-$SRVARCH" ]]; then
  E2E_ENV="$E2E_ENV MYNE_E2E_SERVER=/work/myne-server/myne-server-linux-$SRVARCH"
fi

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $E2E_CARGO_HOME_CHOWN && $E2E_FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $INNER
  '
"
