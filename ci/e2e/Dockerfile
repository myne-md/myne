# The CI base image for the E2E lane (`scripts/ci-e2e-lane.sh`).
#
# WHY THIS EXISTS, AND WHY IT IS A SECOND IMAGE RATHER THAN MORE OF THE FIRST.
# `ci/Dockerfile` carries the eleven Tauri -dev packages for the steps that
# BUILD the app. The E2E lane consumes a prebuilt binary and needs a
# deliberately different, RUNTIME-only set (`webkit2gtk-driver`, `xvfb`, `xauth`,
# `xdotool`, `python3`) plus `tauri-driver` compiled from source. Folding those
# into the push-path image would make every push pull xvfb and a WebKit driver
# no push step uses; `ci/Dockerfile`'s header already says so. So the split is
# deliberate: one image for the steps that compile, one for the lane that drives
# the compiled binary.
#
# WHAT IT BUYS, MEASURED. `ci-e2e-lane.sh` used to pay, on every run: an
# `apt-get install` of that runtime set (the push-path sibling was measured at
# 68 s for a comparable set, of which only ~22 s is download), a Node tarball
# fetch, `npm install -g pnpm`, and `cargo install tauri-driver --locked` — a
# from-source build of the WebDriver. Pipeline 946's log shows those four blocks
# at the head of the step; together they are the 5-8 minutes the owner asked to
# get back. On this image all four are already present and the lane's install
# guards turn into no-ops.
#
# WHY IT IS SAFE TO ADOPT LATE. Every install in `ci-e2e-lane.sh` is guarded with
# `command -v` / `dpkg -s`, so the lane runs correctly on this image AND on the
# old one it uses today. Publishing is therefore not a flag day: the digest is
# bumped in the workflow when the image exists, and an old runner keeps working
# (slower) until it does. That is the opposite of the usual prebuilt-image trap,
# where a workflow edit and an image push have to land in the same instant or the
# gate goes red for a reason that is not about the product.
#
# WHAT THIS IMAGE DELIBERATELY DOES NOT BAKE. The `e2e-fixture-gen` binary and
# the app itself: those are built from the commit under test, and baking them
# would verify an older tree (the failure `check-web-wasm-freshness.mjs` exists
# for). The Rust toolchain is inherited rather than re-pinned; see below.
#
# EVERY VERSION HERE IS PINNED SOMEWHERE ELSE, and `scripts/check-ci-image.mjs`
# holds the base image's pins to the repo. This file adds no version of its own
# except the driver, which `ci-e2e-lane.sh` also names: bump both together.
#
# BASE. The pinned digest of the image `ci/Dockerfile` produces, so this image
# inherits the rust/node/pnpm pins instead of restating them (a second copy of a
# pin is a second thing to forget). Bump in step with `ci/image.json`.
FROM ghcr.io/myne-md/myne-ci@sha256:99fbe08624fd824de91a9615202439fceb4d696e2bb911e175f4624096131b67

# The E2E lane's runtime-only package set. `-dev` header chains are unnecessary
# here because the lane never compiles against WebKit; `webkit2gtk-driver` drags
# the runtime libraries transitively. `mold` is inherited from the base image.
# `xauth` is Xvfb's business, `xdotool` and `python3` are the toplevel-window
# levers (`e2e/support/xwindow.ts`).
RUN apt-get update && apt-get install -y --no-install-recommends \
      webkit2gtk-driver \
      xvfb \
      xauth \
      xdotool \
      python3 \
      libayatana-appindicator3-1 \
    && rm -rf /var/lib/apt/lists/*

# The WebDriver. Pinned to the version `scripts/ci-e2e-lane.sh` installs, and
# baked for the reason the header states: this is a from-source build, and it was
# the largest single fixed cost of the lane after the apt install.
ARG TAURI_DRIVER_VERSION=2.0.6
RUN cargo install tauri-driver --locked --version "${TAURI_DRIVER_VERSION}"
