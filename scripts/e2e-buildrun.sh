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
# The `touch` is load-bearing and cost an hour to find. The frontend is EMBEDDED
# in the binary at compile time, and a change confined to `src/` (or any other
# frontend tree) leaves every Rust source untouched, so cargo relinks nothing and
# the binary keeps whatever bundle it embedded when it was last compiled. It was
# found in its cross-tree form, back when the cargo target volume was shared:
# this script rebuilt cleanly, `pnpm build` emitted a correct `dist/`, and the app
# under test loaded `main-CoKDUqv9.js` from `.claude/worktrees/554-…/dist`, whose
# host still dispatched the pre-fix event. The scenario failed and read as "the
# production fix does not work", which is the worst possible wrong answer from a
# green build. `scripts/lib/e2e-docker.sh` now keys that volume per tree, so the
# stale bundle can only be THIS tree's; the `touch` is still what stops that one,
# and it costs one link.
INNER='set -e; pnpm install --frozen-lockfile && touch src-tauri/src/lib.rs && pnpm tauri build --no-bundle -- --features voice-capture-stub; set +e; PASS=""; FAIL="";'
for spec in "$@"; do
  INNER+=" echo \"==== RUN ${spec} ====\";"
  INNER+=" xvfb-run -a pnpm exec vitest run --config vitest.e2e.config.ts e2e/${spec}.e2e.ts;"
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
# The member `node_modules` paths come from the include, derived from the very
# array that mounts them, so a volume cannot be mounted without being chowned.
FIX_PERMS="chown -R e2e:e2e /work/node_modules /work/target$E2E_MEMBER_NM_PATHS"

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $E2E_CARGO_HOME_CHOWN && $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $INNER
  '
"
