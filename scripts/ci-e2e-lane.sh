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
    LANE_ENV='MYNE_E2E_SHARDS=2 MYNE_E2E_AI=1'
    ;;
  quarantine)
    # MYNE_E2E_QUARANTINE=1 flips `e2e/support/scenario.ts`'s gate to run ONLY
    # the `describeE2E.flaky` specs, which the stable lane skips.
    LANE_ENV='MYNE_E2E_QUARANTINE=1'
    ;;
  *)
    echo "ci-e2e-lane: expected 'stable' or 'quarantine', got '${LANE}'" >&2
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
# by-hand republish (`operations/runbooks/ci-base-image.md`) which
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
apt-get update
apt-get install -y --no-install-recommends \
  curl ca-certificates xz-utils pkg-config libssl-dev webkit2gtk-driver xvfb xauth xdotool python3 mold \
  libayatana-appindicator3-1

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
curl -fsSL https://nodejs.org/dist/v25.9.0/node-v25.9.0-linux-x64.tar.xz \
  | tar -xJ -C /usr/local --strip-components=1
npm install -g pnpm@11.8.0
cargo install tauri-driver --locked --version 2.0.6

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
INNER="$INNER"' RUSTFLAGS="-C link-arg=-fuse-ld=mold" RUSTC_WRAPPER=/cache/bin/sccache'
INNER="$INNER"' SCCACHE_DIR=/cache/sccache/ci SCCACHE_CACHE_SIZE=20G CARGO_INCREMENTAL=0'
# fd soft limit -> hard cap (EMFILE guard): the Tauri app plus parallel cargo
# codegen open enough fds to hit the runner's low default.
INNER="$INNER"' ; ulimit -n $(ulimit -Hn) 2>/dev/null || true'
INNER="$INNER"' ; pnpm install --frozen-lockfile --store-dir /cache/cargo/ci/pnpm-store'
INNER="$INNER"' && cargo build --release -p e2e-fixture-gen'
INNER="$INNER"' && xvfb-run -a pnpm test:e2e'

echo "ci-e2e-lane: running the ${LANE} lane"
su ci -c "$INNER"
