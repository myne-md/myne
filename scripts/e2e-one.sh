#!/usr/bin/env bash
# Run a SINGLE e2e spec file in the container (isolated — avoids full-suite
# contamination). Reuses the existing built binary (no rebuild).
#   ./scripts/e2e-one.sh folder-notes            # runs e2e/folder-notes.e2e.ts
#   ./scripts/e2e-one.sh folder-notes -t fn1     # vitest -t name filter too
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
  -v myne-e2e-nm-ornaments:/work/ornaments/node_modules
  -v myne-e2e-nm-preview:/work/preview/node_modules
  -v myne-e2e-target:/work/target
  # Mounted where cargo actually LOOKS, which is `$CARGO_HOME/registry` — and
  # `E2E_ENV` below sets `CARGO_HOME=/home/e2e/.cargo`. At
  # `/usr/local/cargo/registry` nothing in this container reads it, so every
  # `--rm` run re-downloaded the whole crate set (measured live: 528 MB written
  # to the container-local path while the persisted volume held 59 MB
  # untouched). `e2e-ai-buildrun.sh` already had it right.
  -v myne-e2e-cargo-registry:/home/e2e/.cargo/registry
  -w /work
  --user root
)
E2E_ENV='export HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true npm_config_store_dir=/home/e2e/.pnpm-store'

# Forwarded HOST-side, because the container inherits neither and a spec gated on
# one of them SELF-SKIPS rather than failing: a run that verified nothing reports
# the same green as a run that verified everything. `MYNE_E2E_QUARANTINE=1` is
# the only way to reach a `describeE2E.flaky` spec from here; `MYNE_E2E_AI=1`
# needs the `local-inference-stub` build as well (see `e2e-ai-buildrun.sh`).
E2E_ENV="$E2E_ENV MYNE_E2E_QUARANTINE=${MYNE_E2E_QUARANTINE:-0} MYNE_E2E_AI=${MYNE_E2E_AI:-0}"
# `MYNE_E2E_RETRIES=0` is how `e2e/CLAUDE.md` says to hunt flake, and no runner
# used to offer it: with the config's default of 2, a failing attempt is erased
# from the report and the flake rate reads as zero however bad it is.
RETRY_FLAG=""
if [ -n "${MYNE_E2E_RETRIES:-}" ]; then
  RETRY_FLAG="--retry=${MYNE_E2E_RETRIES}"
fi

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
FIX_PERMS='chown -R e2e:e2e /work/node_modules /work/dialect/node_modules /work/editor/node_modules /work/copy/node_modules /work/target /home/e2e/.cargo'

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    xvfb-run -a pnpm exec vitest run $RETRY_FLAG --config vitest.e2e.config.ts e2e/${SPEC}.e2e.ts ${EXTRA}
  '
"
