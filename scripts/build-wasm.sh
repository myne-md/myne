#!/usr/bin/env bash
# Build the web client's wasm entry surface (phase3-web-client task 11).
#
#   scripts/build-wasm.sh              # release (what the bundle ships)
#   scripts/build-wasm.sh --dev        # debug — faster, much larger, keeps names
#   scripts/build-wasm.sh --verify     # build TWICE into separate target dirs
#                                      # and fail unless the digests match
#
# Two steps, and the second is not optional: `cargo build` emits a `.wasm` whose
# exports are raw wasm ABI (i32 pointers, no strings, no promises), and
# `wasm-bindgen` is what turns that into an ES module with the typed surface the
# Worker imports. A `.wasm` without the glue is unusable, not merely awkward.
#
# Output lands in `web/wasm/pkg/`, which is GITIGNORED — it is a build artefact
# derived entirely from `web/wasm/src/` plus the pinned toolchain.
set -euo pipefail

cd "$(dirname "$0")/.."

# Kept in lockstep with the `wasm-bindgen` version resolved in `Cargo.lock`. The
# CLI and the library must match EXACTLY — wasm-bindgen refuses a mismatched
# pair, and it is right to: the glue it emits encodes the ABI the library
# compiled against. Read from the lock rather than hardcoded, so a `cargo update`
# cannot leave this stale.
WASM_BINDGEN_VERSION="$(
  awk '/^name = "wasm-bindgen"$/{getline; gsub(/version = |"/,""); print; exit}' Cargo.lock
)"
if [ -z "$WASM_BINDGEN_VERSION" ]; then
  echo "could not read the wasm-bindgen version from Cargo.lock" >&2
  exit 1
fi

have_version=""
if command -v wasm-bindgen >/dev/null 2>&1; then
  have_version="$(wasm-bindgen --version | awk '{print $2}')"
fi
if [ "$have_version" != "$WASM_BINDGEN_VERSION" ]; then
  echo "wasm-bindgen CLI ${WASM_BINDGEN_VERSION} is required (found: ${have_version:-none})." >&2
  echo "Install it with:" >&2
  echo "  cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked" >&2
  exit 1
fi

PROFILE="release"
CARGO_PROFILE_FLAG="--release"
if [ "${1:-}" = "--dev" ]; then
  PROFILE="debug"
  CARGO_PROFILE_FLAG=""
fi

# `--verify` re-enters this script twice with separate target directories and
# compares the digests. Two SEPARATE target dirs, not two runs in one: a rebuild
# in the same directory reuses cached artefacts and would pass without proving
# anything, which is the obvious way to write a reproducibility check that never
# fails.
#
# What it does NOT prove is cross-MACHINE reproducibility: same `$HOME`, same
# toolchain install, same OS. It proves the build is independent of the target
# directory and of incremental state, and that the path remaps hold. The
# cross-machine half is what CI adds — a different user, a different checkout
# path, a Linux container — and task 56 is where the published hash makes it a
# claim anyone can check.
#
# What neither half proves is cross-ARCHITECTURE reproducibility, and that gap
# is not one more machine away — it is structural (myne-md/myne#228). Cargo
# hashes `rustc -vV`, whose `host:` line names the build machine's triple, into
# every crate's `-C metadata`; rustc folds that into `StableCrateId`, and symbol
# names are inputs to codegen-unit partitioning. Same commit, same pinned rustc,
# same wasm32 target, two hosts: the `code`, `data`, `export`, `elem`,
# `function` and name sections all differ. `-C symbol-mangling-version=v0` does
# not close it (it swaps the legacy hash suffix for the same StableCrateId as a
# disambiguator), and no stable-toolchain flag removes the `rustc -vV` input.
# The published hash is therefore defined against a reference build environment
# rather than against every host: `docs/web-bundle-hashes.md`.
if [ "${1:-}" = "--verify" ]; then
  echo "== reproducibility check: two cold builds, separate target dirs =="
  tmp_a="$(mktemp -d)"
  tmp_b="$(mktemp -d)"
  trap 'rm -rf "$tmp_a" "$tmp_b"' EXIT
  CARGO_TARGET_DIR="$tmp_a" "$0" >/dev/null
  digest_a="$(awk '/^combined /{print $2}' web/wasm/pkg/artefact-hashes.txt)"
  CARGO_TARGET_DIR="$tmp_b" "$0" >/dev/null
  digest_b="$(awk '/^combined /{print $2}' web/wasm/pkg/artefact-hashes.txt)"
  echo "   build A: ${digest_a}"
  echo "   build B: ${digest_b}"
  if [ "$digest_a" != "$digest_b" ]; then
    echo "NOT REPRODUCIBLE — the same source produced two different artefacts." >&2
    echo "A published hash is worthless if it cannot be reproduced; see" >&2
    echo "threat-model.md A15/TB11." >&2
    exit 1
  fi
  echo "   ok — identical"
  exit 0
fi

# ── Reproducibility: strip machine-specific paths (task 16) ──────────────────
#
# A release build embeds ABSOLUTE source paths in its panic locations. Measured
# on this very artefact before the change: **37 occurrences of `/Users/omer`**,
# across 19 distinct `$CARGO_HOME/registry/...` paths from dependencies
# (argon2, blake2, cipher, js-sys, …). Those differ per machine — different
# `$HOME`, different checkout directory — so two people building the same commit
# got different hashes.
#
# That is not cosmetic. `threat-model.md` §6 makes reproducible signed builds the
# credible substitute for the missing third-party audit, and A15/TB11 makes the
# published bundle hash the web client's only defence against hostile code
# delivery. A hash nobody else can reproduce is a number the publisher asserts
# about itself.
#
# **Cargo's own `profile.release.trim-paths` would be the tidier mechanism and is
# NOT usable here**: it is still nightly-gated in cargo 1.96, the version this
# workspace pins. Tried first, rejected by cargo, recorded so the next person
# does not spend the same attempt. Revisit when the pinned toolchain stabilises
# it — at that point this block becomes two lines in `Cargo.toml` and applies to
# hand-run `cargo build`s too, which this does not.
#
# THREE prefixes, computed at run time rather than hardcoded, because their
# values are exactly the machine-specific part:
#
#   $CARGO_HOME   — dependency sources (argon2, blake2, js-sys, …)
#   rustc sysroot — the STANDARD LIBRARY's own panic locations. Easy to miss:
#                   after remapping the first two, four `~/.rustup/toolchains/
#                   <triple>/lib/rustlib/src/rust/library/{core,alloc,std}/...`
#                   paths were still embedded, and they carry `$HOME` and the
#                   host triple. Found by re-scanning the artefact rather than
#                   by assuming the first two were enough.
#   $(pwd)        — this checkout.
#
# A single remap per root; an earlier draft also remapped `$CARGO_HOME/registry`
# separately "because order matters". It does not matter the way that assumed —
# rustc applied the LATER prefix, and the registry entry was dead weight.
# Verified by reading the resulting strings out of the artefact.
CARGO_HOME_RESOLVED="${CARGO_HOME:-$HOME/.cargo}"
SYSROOT="$(rustc --print sysroot)"
REMAP="--remap-path-prefix=${CARGO_HOME_RESOLVED}=/cargo-home"
REMAP="${REMAP} --remap-path-prefix=${SYSROOT}=/rust-sysroot"
REMAP="${REMAP} --remap-path-prefix=$(pwd)=/myne"
export RUSTFLAGS="${RUSTFLAGS:-} ${REMAP}"
echo "== reproducible-path remaps active =="
echo "   ${CARGO_HOME_RESOLVED} -> /cargo-home"
echo "   ${SYSROOT} -> /rust-sysroot"
echo "   $(pwd) -> /myne"

echo "== cargo build -p myne-web-wasm --target wasm32-unknown-unknown (${PROFILE}) =="
#
# ONE build, `--message-format=json-render-diagnostics`: JSON records on stdout,
# human-readable errors and warnings on stderr. So a compile failure still reads
# normally while the artefact path comes from cargo itself.
#
# The path is read rather than assembled from a guessed target directory because
# `CARGO_TARGET_DIR` is commonly set to a shared directory in this project (root
# CLAUDE.md gotchas: "Cargo shared-target collision"). A hardcoded `target/…`
# path silently picks up a STALE `.wasm` from an earlier build — a mistake
# already made once in `scripts/wasm-csprng-check.sh`, and the reason that script
# now reads the path the same way.
#
# Matched on `package_id`, not `target.name`: cargo underscores the lib target
# name (`myne_web_wasm`), so matching the package name verbatim silently finds
# nothing.
# shellcheck disable=SC2086  # deliberate word-splitting of the (possibly empty) profile flag
WASM="$(
  cargo build -p myne-web-wasm --target wasm32-unknown-unknown ${CARGO_PROFILE_FLAG} \
    --message-format=json-render-diagnostics \
  | node -e '
      let buf = "";
      process.stdin.on("data", (d) => (buf += d));
      process.stdin.on("end", () => {
        for (const line of buf.split("\n")) {
          if (!line.trim()) continue;
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.reason !== "compiler-artifact") continue;
          if (!(m.package_id ?? "").includes("myne-web-wasm")) continue;
          const f = (m.filenames ?? []).find((p) => p.endsWith(".wasm"));
          if (f) { console.log(f); return; }
        }
        process.exit(1);
      });
    '
)"
if [ ! -f "$WASM" ]; then
  echo "cargo reported no .wasm artefact for myne-web-wasm" >&2
  exit 1
fi
echo "   $WASM"

OUT="web/wasm/pkg"
echo "== wasm-bindgen --target web -> ${OUT} =="
# `--target web` emits a plain ES module that runs in a Worker with
# `type: "module"`. NOT `--target no-modules` (a global-script shape a module
# Worker cannot use) and NOT `--target bundler` (which emits bare `import`s of
# the `.wasm`, leaving instantiation to bundler-specific magic — `--target web`
# fetches it by URL, which Vite rewrites correctly and a plain static server
# serves as-is).
#
# `--no-typescript`: the Worker's own `.d.ts` for this module is HAND-WRITTEN
# (`web/src/worker/wasm-module.d.ts`) so that `tsc` type-checks the boundary even
# on a clean clone where `pkg/` does not exist yet. A generated `.d.ts` would
# make the typecheck depend on having run this script first.
rm -rf "$OUT"
wasm-bindgen "$WASM" --out-dir "$OUT" --target web --no-typescript

ls -la "$OUT"

# ── the artefact hash (task 16 acceptance criterion 3) ──────────────────────
#
# Emitted for BOTH files, because the thing a user runs is the pair: the `.wasm`
# alone is inert without the glue that instantiates it, and the glue alone would
# happily load a different `.wasm`. Publishing one hash of two artefacts would
# leave half the delivery unverified.
#
# `shasum -a 256` on macOS, `sha256sum` on Linux — the same digest either way.
echo "== artefact hashes (sha256) =="
if command -v sha256sum >/dev/null 2>&1; then
  HASHER="sha256sum"
else
  HASHER="shasum -a 256"
fi
# shellcheck disable=SC2086  # $HASHER is a deliberate two-word command
$HASHER "$OUT"/myne_web_wasm_bg.wasm "$OUT"/myne_web_wasm.js

# One combined digest over both, so there is a single value to publish and
# compare (task 56). Computed over the hashes rather than the concatenated
# bytes so it does not depend on file order or on how the files are read.
# shellcheck disable=SC2086
COMBINED="$($HASHER "$OUT"/myne_web_wasm_bg.wasm "$OUT"/myne_web_wasm.js | awk '{print $1}' | sort | $HASHER | awk '{print $1}')"
echo "== combined artefact digest =="
echo "   sha256:${COMBINED}"

# Machine-readable sibling, so CI and the verification story (tasks 53-57) read a
# file rather than scrape stdout. Gitignored with the rest of `pkg/`.
cat > "$OUT/artefact-hashes.txt" <<EOF
# myne-web-wasm artefact digests (scripts/build-wasm.sh)
# Reproducible: paths remapped, toolchain pinned by rust-toolchain.toml.
# Verify with: scripts/build-wasm.sh && cat web/wasm/pkg/artefact-hashes.txt
combined sha256:${COMBINED}
EOF
# shellcheck disable=SC2086
$HASHER "$OUT"/myne_web_wasm_bg.wasm "$OUT"/myne_web_wasm.js >> "$OUT/artefact-hashes.txt"

echo "ok"
