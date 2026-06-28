#!/usr/bin/env bash
# Rebuild the production binary (product code changed), then run the given specs
# EACH isolated. Use after touching src/ or src-tauri/.
#   ./scripts/e2e-buildrun.sh wikilink-deep-links heading-list-folding
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=myne-e2e

INNER='set -e; pnpm install --frozen-lockfile && pnpm tauri build --no-bundle; set +e; PASS=""; FAIL="";'
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
  -v myne-e2e-target:/work/target
  -v myne-e2e-cargo-registry:/usr/local/cargo/registry
  -w /work
  --user root
)
E2E_ENV='export HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true npm_config_store_dir=/home/e2e/.pnpm-store'
FIX_PERMS='chown -R e2e:e2e /work/node_modules /work/target /usr/local/cargo/registry'

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    $INNER
  '
"
