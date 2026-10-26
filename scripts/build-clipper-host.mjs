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

/**
 * The app's feature list has to reach THIS build, and it did not.
 *
 * `pnpm tauri build --features voice-capture-stub,local-inference-stub` applies
 * those to the app's own cargo invocation. `beforeBuildCommand` runs this script
 * in a child process that never hears about them, so `myne-clipper-host` was
 * compiled with DEFAULT features — the real Candle engine — and the containerised
 * E2E build died inside it: `myne_desktop_lib … (signal: 9, SIGKILL)`, twice on
 * 2026-10-24 at `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=4`, on a binary whose whole
 * job is to open a socket. The app build alone fits; the clipper host's copy of
 * it did not.
 *
 * The list comes from `MYNE_SIDECAR_FEATURES`, which `scripts/lib/e2e-docker.sh`
 * sets for the container runners. Unset — every `pnpm tauri dev`, every release
 * build — the cargo command line is byte-identical to what it was.
 *
 * Only this caller sets it, on purpose: `myne` and `myne-tor` are their own
 * crates and declare none of these features, so cargo refuses the build outright
 * when handed one (`the package 'myne-cli' does not contain these features`).
 */
function featuresFromEnv() {
  return (process.env.MYNE_SIDECAR_FEATURES ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f !== "");
}

stageSidecar({
  scriptName: "build-clipper-host",
  package: "myne-desktop",
  binName: "myne-clipper-host",
  args: { ...parseArgs(process.argv.slice(2), "build-clipper-host"), features: featuresFromEnv() },
});
