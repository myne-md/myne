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

# Must match `rust-toolchain.toml`'s `channel`. When it does not, every cargo
# invocation inside a container re-provisions the pinned toolchain from scratch
# (~2 min), and `scripts/check-e2e-toolchain.mjs` fails the commit that let them
# drift. This sat at 1.90.0 against a 1.96.0 pin.
FROM rust:1.96.0-slim

# Bake what the pin asks for beyond the base image. `rust:1.96.0-slim` ships
# cargo/rustc/rust-std and NOTHING else, so `rust-toolchain.toml`'s rustfmt,
# clippy and wasm32-unknown-unknown are fetched by the first cargo call in every
# container — "info: downloading 3 components", measured.
#
# That download is not merely slow, it is the failure mode: rustup's partial
# state is not crash-safe, and a run that raced it produced
#   error: failed to install component ... detected conflict
#   error: the 'cargo' binary ... is not applicable to the '1.96.0-…' toolchain
# after which `cargo build -p e2e-fixture-gen` failed inside each scenario's own
# budget. The suite then reported 255 FAILURES in 266 s — 245 of them the same
# infrastructure error wearing a test's name. Baking it makes the runtime step
# a no-op, which is the only version of it that cannot half-happen.
RUN rustup component add rustfmt clippy \
    && rustup target add wasm32-unknown-unknown

# Tauri build sysdeps (same list as .woodpecker/main.yml's tauri-compile step)
# + the E2E runtime additions: webkit2gtk-driver (WebKitWebDriver binary),
# xvfb + xauth (headless X server for the real window).
# libasound2-dev: ALSA dev headers required by cpal's alsa-sys backend
# (voice-notes, MYND-259) so the production binary links on Linux.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates xz-utils pkg-config libssl-dev \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
      libasound2-dev \
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

# xdotool + python3 — the only way this seat can drive the TOPLEVEL window.
#
# WebKitWebDriver accepts `POST /window/rect` and silently does nothing: the
# request returns 200 with the window's UNCHANGED rect, and `window.innerWidth`
# in the page confirms nothing moved (measured: asked 800, granted 1100, page
# 1100, with a 1280x1024 screen underneath — so it is not a ceiling, it is a
# no-op). A driver that accepts a command it does not implement is the worst
# shape a capability gap can take, because every caller reads success.
#
# xdotool talks to the X server directly, which under xvfb is the whole story —
# there is no window manager to arbitrate, so `windowsize` becomes a plain
# XConfigureWindow and `windowclose` a WM_DELETE_WINDOW ClientMessage. GTK turns
# the first into a reflow and the second into `delete-event`, which tao raises as
# `CloseRequested`: the exact chain the app listens on.
#
# python3 is named explicitly even though the base image already carries it.
# `e2e/support/wm-delete-window.py` needs it to send a real WM_DELETE_WINDOW
# ClientMessage (xdotool's `windowclose` is XDestroyWindow and never reaches the
# app's close handler — that file's header carries the measurement). Naming it
# here is also what puts it under `check-e2e-toolchain.mjs`'s seat comparison, so
# a CI step that lacks it fails by name instead of at a scenario's ENOENT.
#
# Placed AFTER `cargo install tauri-driver` on purpose. It is a two-package apt
# layer, and putting it up with the other apt line would invalidate the Node and
# tauri-driver layers on every image this line is edited in.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xdotool python3 \
    && rm -rf /var/lib/apt/lists/*

# The vault_unlock/vault_delete test suites assert UNIX permission-denial
# paths and chmod-based fault injection — root bypasses DAC, so the
# harness must run unprivileged (same rule as CI's cargo-test-tauri step).
RUN useradd -m e2e
USER e2e
ENV HOME=/home/e2e
WORKDIR /work
