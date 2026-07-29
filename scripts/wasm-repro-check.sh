#!/usr/bin/env bash
# Reproducible-wasm gate for CI (phase3-web-client task 16).
#
# Installs the pinned `wasm-bindgen-cli`, then runs the double-build check.
# Lives in a committed script rather than inline in `.woodpecker.yml` for the
# reason that file already documents twice: Woodpecker's config-compile runs env
# substitution over the YAML, and a shell expansion there can error the whole
# pipeline config rather than the step.
#
# Why this belongs in CI and not only on a developer's machine: CI is a
# DIFFERENT machine. Different user, different checkout path, a Linux container
# rather than macOS — so a path remap that happens to work on one box fails
# here. That cross-machine difference is most of the value. A same-machine run
# can only prove independence from the target directory.
#
# `threat-model.md` §6 makes reproducible signed builds the credible substitute
# for the missing third-party audit; A15/TB11 makes the published bundle hash the
# web client's only defence against hostile code delivery. A hash nobody else can
# reproduce is a number the publisher asserts about itself.
set -euo pipefail

cd "$(dirname "$0")/.."

# The version is READ FROM THE LOCK, never hardcoded — the CLI and the library
# must match exactly (the glue encodes the ABI the library compiled against), so
# a `cargo update` must not be able to leave this stale.
version="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/version = |"/,""); print; exit}' Cargo.lock)"
if [ -z "$version" ]; then
  echo "could not read the wasm-bindgen version from Cargo.lock" >&2
  exit 1
fi

# `cargo install` puts binaries in `$CARGO_HOME/bin`, and that directory is on
# PATH only when CARGO_HOME is the default. CI overrides it to a cache volume,
# so without this the script installs the CLI and then cannot find the thing it
# just installed — `cargo install` reports "already installed" (the cache holds
# it) while `command -v` reports "none", and the two readings never meet.
#
# Exported before the detection below rather than after the install, so the
# already-cached case is recognised instead of re-installing every run.
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"

have=""
if command -v wasm-bindgen >/dev/null 2>&1; then
  have="$(wasm-bindgen --version | awk '{print $2}')"
fi
if [ "$have" != "$version" ]; then
  echo "== installing wasm-bindgen-cli ${version} (found: ${have:-none}) =="
  cargo install wasm-bindgen-cli --version "$version" --locked
fi

# `node` is needed by build-wasm.sh to read cargo's JSON artefact record.
if ! command -v node >/dev/null 2>&1; then
  echo "node is required (build-wasm.sh parses cargo's --message-format=json)" >&2
  exit 1
fi

exec bash scripts/build-wasm.sh --verify
