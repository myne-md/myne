#!/usr/bin/env node
// Build the `myne-tor` arti sidecar and stage it where Tauri's `externalBin`
// expects it (desktop Tor routing, MYND-650, task 1).
//
// `myne-tor` is arti — the Rust Tor implementation — run as a standalone
// loopback SOCKS5 proxy in its own process. The desktop host spawns it when the
// device-local Tor routing option is on; it is never linked into
// `myne-desktop`, which is what keeps arti out of the audited no-egress closure
// (see `tor-sidecar/src/main.rs`).
//
// The staging mechanics (triple suffix, target-dir discovery, write-if-changed)
// are shared with the CLI sidecar and live in `scripts/lib/stage-sidecar.mjs`;
// read that file's header for the bundler failure they prevent.
//
// Expect the FIRST run to be slow: arti brings ~250 crates that nothing else in
// the workspace needs. Subsequent runs are a cargo no-op, which is why this is
// wired into both Tauri lifecycle hooks rather than left as a manual step —
// a bundle whose `externalBin` entry has no file behind it fails the build, and
// a dev session with no staged sidecar makes the Tor toggle silently unusable.
//
// Zero dependencies, hand-runnable:
//   node scripts/build-tor-sidecar.mjs [--profile debug|release] [--target <triple>]

import { parseArgs, stageSidecar } from "./lib/stage-sidecar.mjs";

const SCRIPT = "build-tor-sidecar";

stageSidecar({
  scriptName: SCRIPT,
  // `myne-tor` is the `[[bin]] name` of the `myne-tor-sidecar` crate
  // (`tor-sidecar/Cargo.toml`); the `externalBin` entry is `binaries/myne-tor`,
  // relative to `src-tauri/`.
  package: "myne-tor-sidecar",
  binName: "myne-tor",
  args: parseArgs(process.argv.slice(2), SCRIPT),
});
