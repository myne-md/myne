#!/usr/bin/env bash
# Run ONE lane of the desktop tauri-driver E2E suite inside a CI container.
#
#   scripts/ci-e2e-lane.sh stable
#   scripts/ci-e2e-lane.sh quarantine
#
# WHY THIS IS A COMMITTED SCRIPT AND NOT INLINE YAML. `.woodpecker/e2e.yml`'s
# two suite steps differ in exactly one thing, which environment variables the
# unprivileged run gets, and were otherwise byte-identical: the same apt set,
# the same Node tarball, the same pnpm pin, the same `cargo install
# tauri-driver`, the same `useradd`/`chown`, the same server export, and the
# same ~500-character `su ci -c '…'` line. That duplication has already cost
# coverage once: the quarantine lane was missing the `MYNE_E2E_SERVER` export
# that the stable lane had, so it silently self-skipped the device-names,
# sync-replication, prefs-sync and sync-attachments scenarios while the lane
# beside it ran them. A lane that quietly covers less than its sibling is the
# exact shape `check-e2e-floor.mjs` exists to notice, and no floor is recorded
# for the quarantine lane.
#
# The repo rule this follows is `scripts/wasm-repro-check.sh`'s: a non-trivial
# shell block lives in a committed script rather than inline in the CI config,
# because Woodpecker runs an envsubst pass over the YAML before any step runs
# and a mistake there errors the WHOLE pipeline rather than the step. It is also
# the only form a person can read, lint (`bash -n`) and run.
#
# WHAT IT DELIBERATELY DOES NOT DO. It does not touch the cargo cache
# configuration. The root scope here has no `RUSTC_WRAPPER`/`CARGO_HOME`, so
# `cargo install tauri-driver` compiles from source once per lane and is not
# cached. That is inherited rather than introduced, and pointing root at
# `/cache/cargo` is the cross-UID trap that cost pipeline #167: root fills the
# shared cache with 0750 directories and the unprivileged `ci` user then cannot
# read it (`Permission denied (os error 13)`, exit 101). The split that fixed it
# is what the inner environment below preserves: root uses the image's cargo
# home, `ci` uses `/cache/cargo/ci` + `/cache/sccache/ci`.

set -euo pipefail

LANE="${1:-}"
case "$LANE" in
  stable)
    # THE GATE. No `MYNE_E2E_AI=1`: the sixteen AI-gated spec files moved to the
    # `ai` lane below, because inference scenarios are the slowest tests in the
    # suite and a release gate that spends a fifth of its wall clock proving the
    # model runner still answers is a gate people stop running. They are still
    # run, on their own lane, on a schedule; what changed is that the gate no
    # longer waits for them.
    # MYNE_E2E_AI=1 pairs with the `local-inference-stub` feature the build step
    # compiles: without BOTH, nine AI scenarios stay `describe.skip`.
    #
    # TWO shards, and three was tried and reverted. Pipeline 668: 125 spec files
    # summed to 2063 s of file time against a 1032 s step on two shards, i.e.
    # 100 % parallel efficiency, which was read as "the host is not the limit".
    # It is not evidence of that, and pipeline 672 is why: on three shards the
    # step took 1627 s, LONGER than on two, and the floor guard reported 22
    # failures against a ceiling of 0. Efficiency at N says only that no time is
    # lost to SCHEDULING at N; the work itself expands under contention. The
    # reading that would justify raising it is a run at N+1 whose SUMMED FILE
    # TIME is unchanged from N.
    # **ONE shard, not two, since 2026-10-25.** Two shards put two WebKit apps on
    # one host that is also running other branches' pipelines, and the result was
    # a rotating set of ~1 % failures that changed identity on every run and every
    # one of which passed in isolation: pipeline 936 read folder-notes /
    # search-casefold / typewriter-anchor / vim-mode, 944 read
    # code-block-typography / editor-vertical-caret / state-machine /
    # unsynced-marker / wikilink-hover, 946 read version-diff /
    # wikilink-deep-links (19 in total, after doubling every wait budget made the
    # cascade longer rather than shorter).
    #
    # The measurement that settles the axis: a 90 s `waitForElement` expiring means
    # the thing never rendered, not that it rendered late, so no budget fixes it.
    # What does is removing the second concurrent app. The cost is wall clock —
    # the suite's summed file time is around 3000-4400 s, so a single-shard run is
    # 50-75 minutes — and that is the right trade for a gate whose whole job is
    # to be believed: this lane runs by hand before a release, and a release is
    # rare, while a gate nobody trusts sends people to re-roll the dice.
    #
    # `MYNE_E2E_SHARDS` still overrides for anyone measuring throughput: that is a
    # measurement, not a gate.
    LANE_ENV='MYNE_E2E_LANE=stable MYNE_E2E_SHARDS=1'
    ;;
  ai)
    # The inference suites, alone. `MYNE_E2E_AI=1` pairs with the
    # `local-inference-stub` feature the build step compiles: without BOTH, the
    # AI specs stay `describe.skip`.
    #
    # The file list is DERIVED, not typed: every spec that reads `MYNE_E2E_AI` is
    # an AI spec by definition, so a new one joins this lane the moment it lands
    # and none can be forgotten here.
    LANE_ONLY="$(grep -rl 'MYNE_E2E_AI' e2e/*.e2e.ts | sed 's#^e2e/##; s#\.e2e\.ts$##' | tr '\n' ' ')"
    LANE_ENV='MYNE_E2E_LANE=ai MYNE_E2E_AI=1 MYNE_E2E_SHARDS=1'
    ;;
  quarantine)
    # MYNE_E2E_QUARANTINE=1 flips `e2e/support/scenario.ts`'s gate to run ONLY
    # the `describeE2E.flaky` specs, which the stable lane skips.
    LANE_ENV='MYNE_E2E_LANE=quarantine MYNE_E2E_QUARANTINE=1'
    ;;
  *)
    echo "ci-e2e-lane: expected 'stable', 'ai' or 'quarantine', got '${LANE}'" >&2
    exit 2
    ;;
esac

# Runtime-only set: this consumes a PREBUILT binary, so the GTK -dev header
# chains are unnecessary (webkit2gtk-driver drags the runtime libs
# transitively); pkg-config/libssl-dev stay for the tauri-driver cargo install.
# `xdotool` + `python3` are the TOPLEVEL-window levers, and they are here
# rather than in the base image on purpose. WebKitWebDriver accepts
# `POST /window/rect` and silently does nothing, and `xdotool windowclose`
# is `XDestroyWindow`, so neither drives the app's close handler; the
# graceful close is a real `WM_DELETE_WINDOW` ClientMessage sent by
# `e2e/support/wm-delete-window.py` (myne-md/myne#577). They belong in
# `ghcr.io/myne-md/myne-ci` beside the rest of this set, and that is a
# by-hand republish (`runbook/runbooks/ci-base-image.md`) which
# `check-ci-image.mjs` refuses to let a source edit anticipate: editing
# `ci/Dockerfile` without republishing makes its recorded digest describe
# an image the file no longer produces. Installed here until that lands,
# so this seat matches `e2e/Dockerfile`'s.
#
# `libayatana-appindicator3-1` is the one entry here that is a RUNTIME lib with
# no build-time counterpart on this seat, and it is load-bearing in a way that
# is easy to miss. `libappindicator-sys` does not link it: it dlopens
# `libayatana-appindicator3.so.1` (then `libappindicator3.so.1`) through
# `libloading`, and PANICS when neither loads. The desktop binary reaches that
# crate from exactly one place, the tray, whose only runtime caller is
# `meeting_session_start` — so `mn1`/`mn2` are the only two scenarios that can
# observe its absence, and on pipeline #697 they both died 8 s in with
# `[invalid session id] session deleted because of page crash or hang` while
# passing in the local `myne-e2e` image, which carries the library via
# `libayatana-appindicator3-dev`.
#
# Measured, not reasoned (2026-10-18): `rust:1.96.0-slim` plus this exact list
# has `libasound.so.2` and `libgtk-3.so.0` present (webkit2gtk-driver pulls both)
# and `libayatana-appindicator3.so.1` absent.
#
# `check-e2e-toolchain.mjs` deliberately does NOT require this: its rule is
# "subtract whatever tauri-compile installs", and `libayatana-appindicator3-dev`
# IS a build sysdep, so the subtraction hides the runtime half. That is the
# guard's stated scope rather than a defect in it, but it means this line has no
# machine check and the comment above is the record.
# **Every install below is GUARDED, so this lane runs on either image.** The
# intended home for these packages is `ci/e2e/Dockerfile` (a dedicated image,
# published by hand per `runbook/runbooks/ci-base-image.md`'s procedure), and on
# that image all four commands are no-ops. Until it is published — and after, on
# any runner still pointed at the old one — they install what is missing.
# `command -v` / `dpkg -s` rather than a version probe: the question is "is this
# already here", and a probe that answers "here but old" would reinstall anyway.
need_apt=0
for pkg in webkit2gtk-driver xvfb xauth xdotool python3 mold libayatana-appindicator3-1 \
           libssl-dev pkg-config xz-utils ca-certificates curl; do
  dpkg -s "$pkg" >/dev/null 2>&1 || need_apt=1
done
if [ "$need_apt" = 1 ]; then
  apt-get update
  apt-get install -y --no-install-recommends \
    curl ca-certificates xz-utils pkg-config libssl-dev webkit2gtk-driver xvfb xauth xdotool python3 mold \
    libayatana-appindicator3-1
fi

# The Node tarball is version-pinned and fetched over TLS from the first-party
# distribution origin, and it is NOT sha256-pinned. `.woodpecker/e2e.yml` states
# the stricter form of this rule two files away, where it rules geckodriver out
# of the web lane: no unpinned RELEASE-ARCHIVE download in a gating step, and a
# pinned version WITH its sha256 for the binaries this repo fetches by hand
# (cargo-deny, sccache). This line is neither of those. It is the same fetch
# every Node-using step in `.woodpecker/main.yml` has always made, seven copies
# of it, and pinning the hash here alone would leave the others unpinned while
# implying they were covered. Recorded as shared debt on myne-md/myne#579 rather
# than half-fixed.
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://nodejs.org/dist/v25.9.0/node-v25.9.0-linux-x64.tar.xz \
    | tar -xJ -C /usr/local --strip-components=1
fi
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@11.8.0
# `cargo install tauri-driver` is a from-source build of the driver, and it was
# the single largest fixed cost of this lane after the apt install. Baked into
# `ci/e2e/Dockerfile`; skipped here when present.
command -v tauri-driver >/dev/null 2>&1 || cargo install tauri-driver --locked --version 2.0.6

# chmod-based fault-injection scenarios require an unprivileged runner, because
# root bypasses DAC. Same rule `cargo-test-tauri` follows in the push pipeline.
#
# `/usr/local/cargo/registry` in the chown is inherited from the inline version
# and is almost certainly dead work: the inner shell sets
# `CARGO_HOME=/cache/cargo/ci`, so the crates it resolves come from there rather
# than from the image's cargo home. It is kept because this lane cannot be run
# outside CI to prove the removal safe, and a chown that does nothing costs
# seconds while a missing one costs a release-time failure. Named here so the
# next person tuning the cache does not read it as load-bearing.
useradd -m ci
chown -R ci:ci . /usr/local/cargo/registry

# The binary `myne-server-build` produced. Exported only when it EXISTS: an
# absent path would be worse than none, since the harness reports "server
# missing" either way but a wrong path reads like a bug in the harness rather
# than an unprovisioned secret. When it is absent the sync scenarios self-skip,
# and the drop in executed count is what `check-e2e-floor.mjs` is there to
# notice.
SERVER_BIN="${CI_WORKSPACE:-$PWD}/myne-server-e2e"
if [ -x "$SERVER_BIN" ]; then
  MYNE_E2E_SERVER="$SERVER_BIN"
else
  echo "ci-e2e-lane: no myne-server binary at ${SERVER_BIN} -> sync scenarios self-skip"
  MYNE_E2E_SERVER=""
fi

# ─── One E2E suite per runner at a time ──────────────────────
#
# The measurement behind this whole file's recent history is that a second
# concurrent WebKit app is what turns a green suite into a rotating set of reds.
# Within one run that is the shard count; ACROSS runs it is two branches reaching
# this lane at once, which happens whenever a release gate and a push-driven
# rerun overlap on a single agent.
#
# `flock` on the shared `/cache` mount serialises them rather than interleaving
# them. It is deliberately permissive: no `flock`, no writable `/cache`, or a
# full wait budget expiring all degrade to "run anyway", because a gate that
# refuses to run is worse than a gate that runs beside a neighbour. What it must
# never do is run SILENTLY beside one while pretending the number it produced is
# clean, so a lock it could not take says so on stdout.
E2E_LOCK="${E2E_LOCK:-/cache/myne-e2e.lock}"

# The compiler wrapper this lane passes into the container is provisioned and
# hash-verified first (myne-md/myne#758, audit lead NV02); `/cache/tools/bin/sccache`
# had no line anywhere in this repository that put it there. Guarded on the mount
# because that is the only place the binary comes from: outside CI there is none
# to verify, and a developer running this by hand is not the defect.
if [ -d /cache ]; then
  bash "$(dirname "$0")/ci-pinned-tools.sh" sccache cargo-nextest
fi
E2E_LOCK_WAIT="${MYNE_E2E_LOCK_WAIT:-1800}"
if command -v flock >/dev/null 2>&1 && [ -w "$(dirname "$E2E_LOCK")" ]; then
  echo "ci-e2e-lane: acquiring ${E2E_LOCK} (wait up to ${E2E_LOCK_WAIT}s)"
  exec 9>"$E2E_LOCK" || true
  if ! flock -w "$E2E_LOCK_WAIT" 9; then
    echo "ci-e2e-lane: WARNING: another E2E run holds ${E2E_LOCK}; running beside it, expect contention"
  fi
else
  echo "ci-e2e-lane: no flock or no writable $(dirname "$E2E_LOCK"); running without the E2E lock"
fi

# Build the inner command as a string because `su` resets the environment, so
# every variable the run needs has to be set inside it. Quoting rules, since
# this is where the original inline version was hardest to read:
#   - single quotes keep `$PATH` and `$(ulimit -Hn)` for the INNER shell;
#   - double quotes interpolate MYNE_E2E_SERVER and LANE_ENV from THIS shell.
INNER='export HOME=/home/ci CARGO_HOME=/cache/cargo/ci RUSTUP_HOME=/usr/local/rustup'
INNER="$INNER"' PATH=/usr/local/cargo/bin:/usr/local/bin:$PATH CI=true'
INNER="$INNER ${LANE_ENV}"
INNER="$INNER MYNE_E2E_SERVER=\"${MYNE_E2E_SERVER}\""
# `su` resets the environment, so a variable the STEP sets never reaches the
# suite unless it is named here — and an unset scale is silently 1, which is the
# number a loaded runner cannot honour. Passed through rather than hardcoded so a
# developer running this script by hand keeps their own value.
INNER="$INNER MYNE_E2E_TIMEOUT_SCALE=\"${MYNE_E2E_TIMEOUT_SCALE:-1}\""
INNER="$INNER MYNE_E2E_LANE=\"${LANE}\""
INNER="$INNER"' RUSTFLAGS="-C link-arg=-fuse-ld=mold" RUSTC_WRAPPER=/cache/tools/bin/sccache'
INNER="$INNER"' SCCACHE_DIR=/cache/sccache/ci SCCACHE_CACHE_SIZE=20G CARGO_INCREMENTAL=0'
# fd soft limit -> hard cap (EMFILE guard): the Tauri app plus parallel cargo
# codegen open enough fds to hit the runner's low default.
INNER="$INNER"' ; ulimit -n $(ulimit -Hn) 2>/dev/null || true'
INNER="$INNER"' ; pnpm install --frozen-lockfile --store-dir /cache/cargo/ci/pnpm-store'
INNER="$INNER"' && cargo build --release -p e2e-fixture-gen'
INNER="$INNER"' && xvfb-run -a pnpm test:e2e '"${LANE_ONLY:-}"

echo "ci-e2e-lane: running the ${LANE} lane"
su ci -c "$INNER"
