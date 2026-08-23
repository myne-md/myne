#!/usr/bin/env bash
# Rebuild the production binary (product code changed), then run the given specs
# EACH isolated. Use after touching src/ or src-tauri/.
#   ./scripts/e2e-buildrun.sh wikilink-deep-links heading-list-folding
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=myne-e2e

# `--features voice-capture-stub`: see scripts/e2e-local.sh (myne#389 item D).
#
# The `touch` is load-bearing and cost an hour to find. The frontend is EMBEDDED
# in the binary at compile time, and a change confined to `src/` (or any other
# frontend tree) leaves every Rust source untouched, so cargo relinks nothing and
# the binary keeps whatever bundle it embedded when it was last compiled. With a
# shared `myne-e2e-target` volume that bundle can be ANOTHER WORKTREE's: this
# script rebuilt cleanly, `pnpm build` emitted a correct `dist/`, and the app
# under test loaded `main-CoKDUqv9.js` from `.claude/worktrees/554-…/dist`, whose
# host still dispatched the pre-fix event. The scenario failed and read as "the
# production fix does not work", which is the worst possible wrong answer from a
# green build. Touching the crate root forces the re-embed; it costs one link.
INNER='set -e; pnpm install --frozen-lockfile && touch src-tauri/src/lib.rs && pnpm tauri build --no-bundle -- --features voice-capture-stub; set +e; PASS=""; FAIL="";'
for spec in "$@"; do
  INNER+=" echo \"==== RUN ${spec} ====\";"
  INNER+=" xvfb-run -a pnpm exec vitest run --config vitest.e2e.config.ts e2e/${spec}.e2e.ts;"
  INNER+=" if [ \$? -eq 0 ]; then PASS=\"\$PASS ${spec}\"; else FAIL=\"\$FAIL ${spec}\"; fi;"
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
  # symlinks to container-side .pnpm hashes, breaking the HOST install
  # (symptom: host tsc "Cannot find module '@excalidraw/excalidraw'").
  -v myne-e2e-nm-dialect:/work/dialect/node_modules
  -v myne-e2e-nm-editor:/work/editor/node_modules
  -v myne-e2e-nm-copy:/work/copy/node_modules
  -v myne-e2e-nm-ornaments:/work/ornaments/node_modules
  -v myne-e2e-nm-preview:/work/preview/node_modules
  -v "myne-e2e-target-$TREE_KEY":/work/target
  -v myne-e2e-cargo-registry:/usr/local/cargo/registry
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
FIX_PERMS='chown -R e2e:e2e /work/node_modules /work/dialect/node_modules /work/editor/node_modules /work/copy/node_modules /work/target /usr/local/cargo/registry'

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $INNER
  '
"
