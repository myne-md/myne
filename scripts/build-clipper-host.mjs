#!/usr/bin/env node
// Stage the browser clipper's native-messaging host where Tauri's `externalBin`
// expects it (browser-clipper epic, TB10).
//
// The launcher's whole reason is in `src-tauri/src/bin/clipper_host.rs`: a
// browser launches a manifest's `path` with NO arguments and host mode needs one,
// so Windows gets a real executable instead of a shell wrapper. It has to sit
// beside the app binary, which is exactly where an `externalBin` lands — so it is
// staged and listed the same way the `myne` CLI is.
//
// The staging mechanics (triple suffix, target-dir discovery, write-if-changed)
// are shared and live in `scripts/lib/stage-sidecar.mjs`.
//
// ── The bootstrap, on a fresh clone ────────────────────────────────────────
//
// `src-tauri/build.rs` refuses to compile the package while an `externalBin`
// entry is missing from disk, and this script's own `cargo build` is inside that
// package: the first run on a fresh checkout fails on the file it is about to
// produce. Bootstrap it once, by hand:
//
//   touch src-tauri/binaries/myne-clipper-host-<host triple>
//   node scripts/build-clipper-host.mjs
//
// The staged file is gitignored build output, so this happens once per clone.
// `myne` and `myne-tor` do not have the problem: they live in crates of their
// own, so nothing about them is needed to compile this package.
//
// Zero dependencies, hand-runnable:
//   node scripts/build-clipper-host.mjs [--profile debug|release] [--target <triple>]

import { parseArgs, stageSidecar } from "./lib/stage-sidecar.mjs";

stageSidecar({
  scriptName: "build-clipper-host",
  package: "myne-desktop",
  binName: "myne-clipper-host",
  args: parseArgs(process.argv.slice(2), "build-clipper-host"),
});
