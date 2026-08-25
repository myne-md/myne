# The CI base image for the Tauri-sysdeps steps.
#
# WHY THIS EXISTS. Four steps in `.woodpecker/main.yml` (`tauri-compile`,
# `cargo-test-tauri`, `sync-sim`, `mobile-compile`) and one in
# `.woodpecker/e2e.yml` (`e2e-compile`) each apt-installed the same eleven
# packages from scratch. `tauri-compile`'s own comment measured that install at
# 68 s and recorded that only ~22 s of it is the 220 MB download; the rest is
# dpkg unpacking 929 MB, which no download cache touches. Four of those five are
# on the push path, so it cost roughly 4.5 minutes of every pipeline.
#
# A shared apt archive cache was tried first and reverted after two pipelines
# (666 and 668) measured no change at all. Two causes stacked: Debian's images
# ship `/etc/apt/apt.conf.d/docker-clean` setting
# `Binary::apt::APT::Keep-Downloaded-Packages "false"`, so apt deletes every .deb
# after installing it wherever the archive path points; and files in
# `apt.conf.d` are read in LEXICAL order with later ones winning, so
# `docker-clean` overrode a `01`-prefixed override of that setting. That history
# is in `.woodpecker/main.yml`'s `tauri-compile` step, and it is why the answer
# is a baked image rather than a third cache attempt.
#
# WHY CI DOES NOT BUILD OR PUBLISH THIS. The pipelines verify and never publish
# (myne-md/myne#<A>). A step that published this image would also be the one
# case where CI rewrites its own input, which is worse than the general rule it
# would break. The procedure is `operations/runbooks/ci-base-image.md`, run by
# hand, and the workflows pin the result BY DIGEST rather than by tag so a
# republished tag cannot silently change what a gate ran on.
#
# WHY `ci-e2e-lane.sh` IS NOT ON THIS IMAGE. It installs a deliberately
# different, RUNTIME-only set (`webkit2gtk-driver`, `xvfb`, `xauth`, no -dev
# header chains) because it consumes a prebuilt binary. Folding those into this
# image would make every push pull xvfb and a webkit driver no push step uses,
# and that lane is manual and pre-release, so its install cost is paid a handful
# of times per release rather than on every push.
#
# EVERY VERSION BELOW IS PINNED SOMEWHERE ELSE IN THE REPO, and
# `scripts/check-ci-image.mjs` is what holds the two in step. Bump a version
# here and the guard names the file that disagrees.
FROM rust:1.96.0-slim

# The eleven Tauri sysdeps, plus `git` (cargo-deny's advisory-db fetch, the
# private-companion clones in `sync-sim`, and `mobile-compile`) and `file` (the
# hook-parity backstop). One layer, so the whole set is one cache entry.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      file \
      git \
      xz-utils \
      pkg-config \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libgtk-3-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libasound2-dev \
      mold \
    && rm -rf /var/lib/apt/lists/*

# Components and target that `rust-toolchain.toml` pins. Baked rather than added
# per step for the reason that file already states about targets: a gate that
# installs its own toolchain piece is a gate that silently does not run wherever
# the line was forgotten. `llvm-tools` is what `scripts/wasm-csprng-check.sh`
# reads the getrandom rlib's symbol table with.
RUN rustup component add rustfmt clippy llvm-tools \
    && rustup target add wasm32-unknown-unknown

# Node, from the same first-party origin and the same pinned version the steps
# fetched by hand. Pinned to `.nvmrc`.
ARG NODE_VERSION=25.9.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1

# pnpm, pinned to the root `package.json`'s `packageManager` field.
ARG PNPM_VERSION=11.8.0
RUN npm install -g "pnpm@${PNPM_VERSION}"

# Go, for `sync-sim`, which builds a real `myne-server` to run the cross-device
# sim suite against. Matches that step's pinned tarball.
ARG GO_VERSION=1.26.4
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
    | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"
