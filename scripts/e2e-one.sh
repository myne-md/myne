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
  # Member node_modules MUST be volumes too (mirrors e2e-local.sh): the
  # container's pnpm install otherwise rewrites the bind-mounted members'
  # symlinks to container-side .pnpm hashes, breaking the HOST install
  # (symptom: host tsc "Cannot find module '@excalidraw/excalidraw'").
  -v myne-e2e-nm-dialect:/work/dialect/node_modules
  -v myne-e2e-nm-editor:/work/editor/node_modules
  -v myne-e2e-nm-copy:/work/copy/node_modules
  -v myne-e2e-target:/work/target
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
    xvfb-run -a pnpm exec vitest run --config vitest.e2e.config.ts e2e/${SPEC}.e2e.ts ${EXTRA}
  '
"
