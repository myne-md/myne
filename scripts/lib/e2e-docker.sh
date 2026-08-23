# Shared docker-volume naming for every script that runs this repo inside the
# e2e container. Sourced, never executed; each caller has already done
# `cd "$(dirname "$0")/.."`, so the path below is repo-relative.
#
#   source scripts/lib/e2e-docker.sh
#   RUN_FLAGS=( ... -v "$E2E_TARGET_VOLUME":/work/target ... )
#
# The cargo target volume is PER TREE, and that is a correctness requirement
# rather than tidiness. Every tree is bind-mounted at the same in-container
# path, `/work`, so two checkouts of this repo are indistinguishable to cargo:
# same package name, same version, same absolute source path. With one shared
# volume a build here happily reuses an rlib compiled from a DIFFERENT tree, and
# the only symptom is a compile error in code the diff never touched. Measured:
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
#
# It lives here rather than in each script because the key has to be BYTE
# IDENTICAL across all of them: two scripts that hash the same tree differently
# get two volumes, and the second one rebuilds from scratch every time while
# looking like a cache. The copies were also how three call sites
# (`e2e-batch.sh`, `capture-theme-preview.sh`, `capture-userguide.sh`) kept the
# shared volume the change was made to remove, and how a fourth
# (`e2e-local.sh`) landed the assignment INSIDE its `RUN_FLAGS=( … )` array
# literal, where bash reads it as an element rather than an assignment: the
# subshell ran, nothing was assigned, and `set -u` then aborted the script on
# the next line.
E2E_TREE_KEY=$(pwd | shasum | cut -c1-12)
E2E_TARGET_VOLUME="myne-e2e-target-$E2E_TREE_KEY"

# Workspace-MEMBER node_modules need their own volumes: the members are
# bind-mounted, so the container's `pnpm install` would otherwise rewrite their
# symlinks to container-side .pnpm hashes and break the HOST install (and vice
# versa). Latent until a member gained a real external dependency
# (editor/ -> @excalidraw); bites as `Cannot find module` on whichever side ran
# `pnpm install` second.
E2E_MEMBER_NM_VOLUMES=(
  -v myne-e2e-nm-dialect:/work/dialect/node_modules
  -v myne-e2e-nm-editor:/work/editor/node_modules
  -v myne-e2e-nm-copy:/work/copy/node_modules
  -v myne-e2e-nm-ornaments:/work/ornaments/node_modules
  -v myne-e2e-nm-preview:/work/preview/node_modules
)

# The crates.io registry cache, at `$CARGO_HOME/registry` and NOT at the image's
# `/usr/local/cargo/registry`.
#
# Every runner sets `CARGO_HOME=/home/e2e/.cargo` in its `E2E_ENV`, so that is
# the only registry path cargo reads or writes; a volume mounted anywhere else
# is a cache nothing consults. Six of the seven runners mounted it at the image
# default, so each re-downloaded the crates.io index and every crate source on
# EVERY invocation, threw the result away with `--rm`, and spent minutes doing it
# before the first line of the build appeared. Nothing reports that: the run is
# green, only slow, which is why it survived. Measured: the volume held 574 MB of
# registry content that no run had read since `CARGO_HOME` was overridden, and
# `/home/e2e/.cargo` does not exist in the image at all.
#
# `e2e-ai-buildrun.sh` found it first and fixed itself, recording that the four
# siblings were still wrong and that fixing them was a change with its own claim
# to verify. This is that change, and it lives here so the seventh runner cannot
# get it wrong again.
E2E_REGISTRY_MOUNT=(-v myne-e2e-cargo-registry:/home/e2e/.cargo/registry)

# Docker creates the mount's PARENT root-owned, and cargo needs to write its lock
# files (`.package-cache`, `.global-cache`) at the `CARGO_HOME` root as user
# `e2e`. One directory, NOT `-R`: the volume's contents are already e2e-owned and
# recursing over 574 MB of registry files costs more than the download it saves.
E2E_CARGO_HOME_CHOWN='chown e2e:e2e /home/e2e/.cargo'
