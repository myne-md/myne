# E2E harness container — Linux runtime for tauri-driver (e2e-harness task 3).
#
# Why a container at all: tauri-driver has NO macOS support (Linux/Windows
# only — upstream WebKitWebDriver gap), the dev machine is macOS, and the
# CI runner is Linux (decisions.md 2026-05-01, Woodpecker). This image is
# the shared "Linux seat": locally via `scripts/e2e-local.sh`, in CI as the
# E2E step's environment. See docs/dev/e2e.md.
#
# Base matches CI (`rust:1.90.0-slim` — rust-toolchain.toml pin); Node
# matches .nvmrc (25.9.0). tauri-driver is exact-pinned (2.0.6). The image
# carries build deps + the WebDriver runtime (webkit2gtk-driver, xvfb);
# the repo itself is bind-mounted at run time, never baked in.

FROM rust:1.90.0-slim

# Tauri build sysdeps (same list as .woodpecker.yml's tauri-compile step)
# + the E2E runtime additions: webkit2gtk-driver (WebKitWebDriver binary),
# xvfb + xauth (headless X server for the real window).
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates xz-utils pkg-config libssl-dev \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
      webkit2gtk-driver xvfb xauth \
    && rm -rf /var/lib/apt/lists/*

# Node 25.9.0 (.nvmrc pin), arch-aware (the dev Mac builds linux/arm64,
# CI is linux/amd64) + pnpm 9 (CI convention: npm install, no corepack).
RUN ARCH="$(uname -m)" \
    && case "$ARCH" in \
         x86_64) NODE_ARCH=x64 ;; \
         aarch64) NODE_ARCH=arm64 ;; \
         *) echo "unsupported arch: $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL "https://nodejs.org/dist/v25.9.0/node-v25.9.0-linux-${NODE_ARCH}.tar.xz" \
       | tar -xJ -C /usr/local --strip-components=1 \
    && npm install -g pnpm@9

# tauri-driver — exact pin (a new version is a deliberate bump here +
# docs/dev/e2e.md note, not a drive-by).
RUN cargo install tauri-driver --locked --version 2.0.6

# The vault_unlock/vault_delete test suites assert UNIX permission-denial
# paths and chmod-based fault injection — root bypasses DAC, so the
# harness must run unprivileged (same rule as CI's cargo-test-tauri step).
RUN useradd -m e2e
USER e2e
ENV HOME=/home/e2e
WORKDIR /work
