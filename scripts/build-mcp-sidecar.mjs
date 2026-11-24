#!/usr/bin/env node
// Build the `myne-mcp` sidecar and stage it where Tauri's `externalBin` expects
// it (external-mcp-connection task 1; myne-md/myne#923).
//
// `myne-mcp` is the MCP front-end: stdio to an external AI client, and (from a
// later task) the existing local door to the running, unlocked desktop. It is a
// Tauri `externalBin` rather than a separately distributed binary because the
// trust story depends on it shipping inside the same bundle, the same
// `Cargo.lock` and the same release; a binary that is separately distributed and
// absent from the lockfile earns none of that (docs/threat-model.md TB12).
//
// It never opens the vault and never listens. Read `mcp/src/lib.rs` for what
// this slice does and does not do.
//
// The staging mechanics (triple suffix, target-dir discovery, write-if-changed)
// are shared with the CLI and Tor sidecars and live in
// `scripts/lib/stage-sidecar.mjs`; read that file's header for the bundler
// failure they prevent. One script per sidecar is the pattern that header
// states, because each one carries its own reason to exist.
//
// Zero dependencies, hand-runnable:
//   node scripts/build-mcp-sidecar.mjs [--profile debug|release] [--target <triple>]

import { parseArgs, stageSidecar } from "./lib/stage-sidecar.mjs";

const SCRIPT = "build-mcp-sidecar";

stageSidecar({
  scriptName: SCRIPT,
  // `myne-mcp` is the `[[bin]] name` of the `myne-mcp` crate
  // (`mcp/Cargo.toml`); the `externalBin` entry is `binaries/myne-mcp`,
  // relative to `src-tauri/`.
  package: "myne-mcp",
  binName: "myne-mcp",
  args: parseArgs(process.argv.slice(2), SCRIPT),
});
