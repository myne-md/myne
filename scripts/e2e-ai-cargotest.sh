#!/usr/bin/env bash
# Run ONE cargo test filter inside the E2E container, against the warm volumes.
#
# Why this exists rather than `cargo test` on the host: `src-tauri`'s build.rs
# needs both `externalBin` sidecars staged, which a fresh worktree does not have
# (`private-companion/reference/worktrees.md`), so a host run costs two sidecar builds
# before it compiles a line. The container already has the target volume the E2E
# runners warmed, so a filtered test here is minutes rather than a rebuild.
#
#   ./scripts/e2e-ai-cargotest.sh engine::tests::the_note_id
#
# The feature list matches `e2e-ai-buildrun.sh`, because a stub-engine test that
# ran without `local-inference-stub` would be testing code the binary under test
# does not contain.
#
# **`--release`, and that is not a preference.** The E2E runners build release,
# so the release tree is already warm and a debug run compiles the whole
# dependency graph a SECOND time into a second tree. Measured: 8.3 GB of debug
# next to 3.8 GB of release, which overran the Docker VM's 19 GB disk and failed
# at the link step with `No space left on device`, a message that reads like a
# broken build and is a full disk.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/e2e-docker.sh
source scripts/lib/e2e-docker.sh
IMAGE=myne-e2e

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
E2E_ENV='export HOME=/home/e2e CARGO_HOME=/home/e2e/.cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin CI=true'

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" bash -c "
  $E2E_CARGO_HOME_CHOWN && $E2E_FIX_PERMS && su e2e -s /bin/bash -c '
    $E2E_ENV &&
    cd /work &&
    cargo test --release -p myne-desktop --features voice-capture-stub,local-inference-stub -- ${*:-} --nocapture
  '
"
