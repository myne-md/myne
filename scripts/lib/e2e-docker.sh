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
# `.worktrees/554-manual-test-debt/core/src/plugins/agent/probe.rs` is
# exactly that function. Worktrees live under `.worktrees/` by
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
# ONE list, from which both the mounts and the chown paths below are built. Two
# hand-kept lists is what the include exists to stop, and building the second by
# string-splitting the first back apart was the same thing wearing a loop.
E2E_MEMBERS=(dialect editor copy ornaments preview)

E2E_MEMBER_NM_VOLUMES=()
for _e2e_m in "${E2E_MEMBERS[@]}"; do
  E2E_MEMBER_NM_VOLUMES+=(-v "myne-e2e-nm-$_e2e_m:/work/$_e2e_m/node_modules")
done
unset _e2e_m

# The crates.io registry cache, at `$CARGO_HOME/registry` and NOT at the image's
# `/usr/local/cargo/registry`.
#
# Every runner sets `CARGO_HOME=/home/e2e/.cargo` in its `E2E_ENV`, so that is
# the only registry path cargo reads or writes; a volume mounted anywhere else
# is a cache nothing consults. Six of the seven runners then extant mounted it at the image
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
#
# Measured on `e2e-buildrun.sh`, before and after: 789 `Downloaded <crate>` lines
# and a full `Updating crates.io index` on the run before this fix, zero of
# either on the run after it, same tree, same volume.
E2E_REGISTRY_MOUNT=(-v myne-e2e-cargo-registry:/home/e2e/.cargo/registry)

# Ownership, DERIVED from the mounts above rather than hand-listed beside them.
#
# Docker creates a named volume's root and its mountpoint's parent `root:root`,
# and everything in the container runs as `e2e`, so a volume that is mounted and
# not chowned is a directory the build cannot write. The mounts moved into this
# file and the chown half stayed hand-copied in every runner, which reproduced
# the drift the include exists to end: the seven disagreed three ways, with
# `e2e-batch.sh` mounting five member `node_modules` volumes and chowning none of
# them. Both halves are built from `E2E_MEMBERS` above, and the whole chown STEP
# is `E2E_FIX_PERMS` below rather than a string each runner interpolates, because
# exporting only the paths still left every runner free not to use them.
E2E_MEMBER_NM_PATHS=""
for _e2e_m in "${E2E_MEMBERS[@]}"; do
  E2E_MEMBER_NM_PATHS="$E2E_MEMBER_NM_PATHS /work/$_e2e_m/node_modules"
done
unset _e2e_m

# The registry mountpoint AND its parent. The parent is where cargo writes its
# lock files (`.package-cache`, `.global-cache`) at the `CARGO_HOME` root; the
# mountpoint is the volume root, which is `root:root 0755` the first time the
# volume is created and which cargo has to write `index/` into.
#
# Both non-recursively, and that is the whole point of naming two paths rather
# than one `-R`. A warm volume holds 574 MB of already-correct files, and walking
# them costs more than the download the cache saves. An earlier version chowned
# only the parent, which worked on this machine and only because the volume had
# already been recursively chowned by the code being removed. That is the "green
# afterwards is not evidence" case. Measured on a fresh volume: the mountpoint
# comes up `root:root 0755`, `chown` of the parent alone leaves
# `mkdir /home/e2e/.cargo/registry/index` refused as `e2e`, and naming both paths
# makes it succeed.
E2E_CARGO_HOME_CHOWN='chown e2e:e2e /home/e2e/.cargo /home/e2e/.cargo/registry'

# The whole ownership step, not just the paths.
#
# Exporting the paths and leaving each runner to interpolate them was still seven
# people remembering, only of a shorter string: nothing forces a runner to use
# the variable, so "mounted implies chowned" was a claim rather than a property.
#
# The SIX runners that need it run `$E2E_CARGO_HOME_CHOWN && $E2E_FIX_PERMS` verbatim, so
# both live here and a runner that mounts the volumes gets the ownership with
# them. The two capture runners deliberately do not: they `chown -R e2e:e2e
# /work`, the whole bind mount, because they write generated artefacts back into
# the tree rather than only into volumes. That covers the member mountpoints as
# a side effect, so they are correct and they are the reason this says five
# rather than seven. It is still a convention rather than a property, and the
# honest version of that sentence is this one.
E2E_FIX_PERMS="chown -R e2e:e2e /work/node_modules /work/target$E2E_MEMBER_NM_PATHS"

# The cargo job cap, opt-in from the host, and the reason it needs a home here.
#
# `e2e/AGENTS.md` records `rustc … (signal: 9, SIGKILL)` on `myne_desktop_lib` as
# the OOM killer rather than a compile error, and names the fix in one line:
# `CARGO_BUILD_JOBS=3`. No runner exposed it. Every one of them builds its
# `E2E_ENV` as a fixed `export …` string that `docker run` cannot be told to
# extend, so the documented fix was unreachable from a developer machine, which
# is the same shape this directory already recorded for `MYNE_E2E_RETRIES` and
# `MYNE_E2E_QUARANTINE`: a knob written down in prose and wired to nothing.
#
# Measured on a 16 GB host with an 8 GB colima VM: the release build of
# `myne-desktop` is killed at the `myne_desktop_lib` link with eight concurrent
# `opt-level=3` jobs, on a tree that compiles fine on the host, and the message
# names neither memory nor a line. Capping at 3 costs wall clock and changes
# nothing about the artifact, so a run under the cap still proves what the
# green-3x gate asks.
#
# Opt-in rather than a default: on a machine with room, capping is pure lost
# time, and a default that silently halves everyone's build to rescue one
# configuration is the wrong trade. Unset on the host, this expands to nothing
# and the command line is byte-identical to what it was.
E2E_CARGO_JOBS=""
if [[ -n "${CARGO_BUILD_JOBS:-}" ]]; then
  E2E_CARGO_JOBS="CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS"
fi

# The intra-crate half of the same problem, and on this tree it is the half that
# bites. `CARGO_BUILD_JOBS` caps how many CRATES build at once; it says nothing
# about how many codegen units ONE crate splits itself into, and no
# `[profile.release]` overrides rustc's default, so `myne_desktop_lib` compiles
# at 16 units — one `rustc` process holding 16 `opt-level=3` units' peak at once.
#
# Measured on a 16 GB host with a Docker VM already running unrelated containers
# (11.66 GB, ~3.7 GB of it in use): `CARGO_BUILD_JOBS=2` and then `=1` each ended
# in the same `… myne_desktop_lib … (signal: 9, SIGKILL)`, because the peak is
# inside one process rather than across processes. Capping the units is what
# lowers it.
#
# Opt-in, same reasoning as the cap above: unset on the host, the command line is
# byte-identical to what it was.
E2E_CARGO_CODEGEN_UNITS=""
if [[ -n "${CARGO_PROFILE_RELEASE_CODEGEN_UNITS:-}" ]]; then
  E2E_CARGO_CODEGEN_UNITS="CARGO_PROFILE_RELEASE_CODEGEN_UNITS=$CARGO_PROFILE_RELEASE_CODEGEN_UNITS"
fi

# The third and last member of the same family, and the only one that actually
# made the build fit.
#
# `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=4` alone still ended in
# `myne_desktop_lib … (signal: 9, SIGKILL)` on an 11.66 GiB VM (measured
# 2026-10-24, twice). `CARGO_PROFILE_RELEASE_OPT_LEVEL=1` built the whole
# workspace in 4m 33s on the same VM, peak RSS under 4.1 GiB.
#
# Read what that trades. `opt-level` is a code-generation setting: the sources,
# the features, the cfg flags and every behaviour under test are identical, and
# the binary is slower. So a local run is evidence about BEHAVIOUR and not about
# the shipped artefact — which is exactly the split the release lane needs, since
# the tag is built on CI and the E2E suite is what a developer is trying to make
# green. Do not use this to produce an artefact anybody ships.
#
# Opt-in like the other two: unset on the host, the command line is
# byte-identical to what it was, so a machine with room still builds at
# opt-level 3.
# The lane name the vitest config keys its report filename on
# (`.config/vitest/e2e.config.ts`), forwarded into the container so a local run
# writes the same file the CI step of that lane would. Without this a local
# `MYNE_E2E_LANE=ai` run quietly wrote `stable.json` and the floor guard read a
# report from the wrong lane.
E2E_LANE_ENV="MYNE_E2E_LANE=${MYNE_E2E_LANE:-stable}"

E2E_CARGO_OPT_LEVEL=""
if [[ -n "${CARGO_PROFILE_RELEASE_OPT_LEVEL:-}" ]]; then
  E2E_CARGO_OPT_LEVEL="CARGO_PROFILE_RELEASE_OPT_LEVEL=$CARGO_PROFILE_RELEASE_OPT_LEVEL"
fi

# The app's feature list, forwarded to the SIDECAR builds as well.
#
# `pnpm tauri build --features a,b` applies the list to the app's own cargo
# invocation only. The `beforeBuildCommand` sidecar stagers run in a child
# process that never hears about it, so `myne-clipper-host` (a bin inside the
# `myne-desktop` package, built by `scripts/build-clipper-host.mjs`) was compiled
# with DEFAULT features — the real Candle engine — and that is the invocation the
# OOM killer has been taking: `myne_desktop_lib … (signal: 9, SIGKILL)`, twice on
# 2026-10-24 at `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=4`. Forwarding the same list
# makes the container build the artifact CI builds, at a fraction of the peak.
#
# Kept beside the other two caps because the three are one story: the release
# build of this tree does not fit a container VM unless the stub features reach
# every cargo invocation in it.
E2E_SIDECAR_FEATURES="MYNE_SIDECAR_FEATURES=voice-capture-stub,local-inference-stub"
