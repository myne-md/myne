#!/usr/bin/env bash
# Run a SINGLE e2e spec file in the container (isolated — avoids full-suite
# contamination). Reuses the existing built binary (no rebuild).
#   ./scripts/e2e-one.sh folder-notes            # runs e2e/folder-notes.e2e.ts
#   ./scripts/e2e-one.sh folder-notes -t fn1     # vitest -t name filter too
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=myne-e2e
SPEC="$1"; shift || true
EXTRA="$*"

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
    xvfb-run -a pnpm exec vitest run --config vitest.e2e.config.ts e2e/${SPEC}.e2e.ts ${EXTRA}
  '
"
