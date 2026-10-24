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
// Zero dependencies, hand-runnable:
//   node scripts/build-clipper-host.mjs [--profile debug|release] [--target <triple>]

import { parseArgs, stageSidecar } from "./lib/stage-sidecar.mjs";

stageSidecar({
  scriptName: "build-clipper-host",
  package: "myne-desktop",
  binName: "myne-clipper-host",
  args: parseArgs(process.argv.slice(2), "build-clipper-host"),
});
