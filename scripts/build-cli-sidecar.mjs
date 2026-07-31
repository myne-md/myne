#!/usr/bin/env node
// Build the `myne` CLI and stage it where Tauri's `externalBin` expects it
// (cli-thin-client task 11; MYND-490).
//
// The CLI is the terminal half of the desktop app: it drives the running,
// unlocked desktop over its local command socket. The dev-profile staging is
// what puts a sidecar next to the dev binary, which is what makes the runtime
// PATH shim (`src-tauri/src/cli_bridge/path_shim.rs`) resolve to something in a
// dev session — so this runs from BOTH Tauri lifecycle hooks
// (`beforeDevCommand` / `beforeBuildCommand`).
//
// The staging mechanics (triple suffix, target-dir discovery, write-if-changed)
// are shared with the arti sidecar and live in `scripts/lib/stage-sidecar.mjs`;
// read that file's header for the bundler failure they prevent.
//
// Zero dependencies, hand-runnable:
//   node scripts/build-cli-sidecar.mjs [--profile debug|release] [--target <triple>]

import { parseArgs, stageSidecar } from "./lib/stage-sidecar.mjs";

const SCRIPT = "build-cli-sidecar";

stageSidecar({
  scriptName: SCRIPT,
  // `myne` is the `[[bin]] name` of the `myne-cli` crate (`cli/Cargo.toml`);
  // the `externalBin` entry is `binaries/myne`, relative to `src-tauri/`.
  package: "myne-cli",
  binName: "myne",
  args: parseArgs(process.argv.slice(2), SCRIPT),
});
