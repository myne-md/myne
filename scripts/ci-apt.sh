#!/usr/bin/env bash
# `apt-get install` with a SHARED download cache, and a fallback that makes a
# contended cache slow instead of red.
#
# WHAT THIS IS FOR. `tauri-compile` and `cargo-test-tauri` install an identical
# set of webkit/gtk/mold packages on `rust:1.96.0-slim`, and each pays 67-68 s
# for it (measured, pipeline 661). Both are ALONE in their Woodpecker stage, so
# every one of those seconds is on the pipeline's critical path. Pointing apt's
# archive directory at the shared `/cache` volume — the same one that already
# holds `sccache`, `CARGO_HOME` and the pnpm store — turns the second install of
# a package set into an unpack from local disk.
#
# WHY IT IS A SCRIPT. `.woodpecker.yml` states the rule twice for its own
# reasons: Woodpecker runs env substitution over that file, and a shell
# expansion in a step (or even in a comment) errors the WHOLE pipeline config
# rather than the step. The fallback below is a `||` with a brace group, which
# is exactly the shape that belongs out of the YAML.
#
# THE HAZARD THIS HANDLES, which is the whole reason for the fallback.
# **apt takes an EXCLUSIVE lock inside its archive directory.** Two apt
# processes sharing one archive path do not run slowly, they fail:
#
#   E: Could not get lock /cache/apt/archives/lock
#
# Two steps in the same stage would collide, so only steps in different stages
# share this path. But a second PIPELINE can still be running (the agent pool
# has capacity for more than one), and nothing orders steps across pipelines.
# That window is small and it is not zero, and a CI step that goes red for an
# infrastructure reason is the failure class this repository has been bitten by
# repeatedly: it wears the name of whatever it was gating.
#
# So a failure with the shared cache is retried WITHOUT it, against the
# container-local default. The cost of losing the race is the 68 s this saves,
# never a red pipeline.
#
# USAGE
#   bash scripts/ci-apt.sh <package> [<package> …]
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "ci-apt: no packages given" >&2
  exit 2
fi

CACHE_CONF=/etc/apt/apt.conf.d/01myne-apt-cache
SHARED=/cache/apt/archives

install_now() {
  apt-get update && apt-get install -y --no-install-recommends "$@"
}

# `partial/` is apt's staging directory and it creates neither it nor its parent.
if mkdir -p "$SHARED/partial" 2>/dev/null; then
  printf 'Dir::Cache::archives "%s";\n' "$SHARED" > "$CACHE_CONF"
  if install_now "$@"; then
    exit 0
  fi
  echo "ci-apt: shared cache install failed (likely a concurrent pipeline holding the archive lock); retrying container-local" >&2
  rm -f "$CACHE_CONF"
else
  echo "ci-apt: /cache is not writable here; using the container-local cache" >&2
fi

install_now "$@"
