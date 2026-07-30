#!/usr/bin/env node
// Build the `myne` CLI and stage it where Tauri's `externalBin` expects it
// (cli-thin-client task 11; MYND-490).
//
// The failure this prevents: `bundle.externalBin` in `src-tauri/tauri.conf.json`
// names `binaries/myne`, and Tauri resolves that to
// `src-tauri/binaries/myne-<target-triple>[.exe]` — a file no cargo build ever
// produces on its own (cargo emits `<target-dir>/<profile>/myne`, with no triple
// suffix). Without this staging step the bundler stops with "Failed to copy
// external binaries" and the desktop bundle ships with no CLI at all, which is
// the one thing task 11 exists to deliver. The triple suffix is also the reason
// this cannot be a plain `cp` in a Makefile: the name is host-dependent, so it
// has to be read from `rustc -vV` rather than written down.
//
// Wired into BOTH Tauri lifecycle hooks (`beforeDevCommand` / `beforeBuildCommand`)
// so `pnpm tauri dev` and `pnpm tauri build` both stage it — the dev copy is what
// puts a sidecar next to the dev binary, which is what makes the runtime PATH shim
// (`src-tauri/src/cli_bridge/path_shim.rs`) resolve to something in a dev session.
//
// Zero dependencies, hand-runnable:
//   node scripts/build-cli-sidecar.mjs [--profile debug|release] [--target <triple>]
//
// Gotcha worth knowing before you debug it: after a `tauri build`, Tauri copies the
// staged file back into the cargo target dir with the triple STRIPPED — i.e. onto
// `<target-dir>/<profile>/myne`, which is also where cargo puts the `myne-cli`
// binary. So a `tauri build` (release-staged) leaves `target/debug/myne` holding
// release bytes, and cargo will not consider that a reason to rebuild. Harmless
// (same source either way, and this script re-copies from cargo's own path), but
// the byte sizes will not match your expectations if you go looking.
//
// The staged binary is a build artefact and is gitignored (`src-tauri/binaries/`),
// exactly like `web/wasm/pkg/`: committing it would put a multi-MB binary in every
// diff and make the bundle's contents depend on whoever last ran the script.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `myne`, the `[[bin]] name` of the `myne-cli` crate (`cli/Cargo.toml`). */
const BIN_NAME = "myne";
/** The `externalBin` entry is `binaries/myne`, relative to `src-tauri/`. */
const STAGE_DIR = join(repoRoot, "src-tauri", "binaries");

function parseArgs(argv) {
  const args = { profile: "release", target: null, build: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      args.profile = argv[(i += 1)];
    } else if (arg === "--target") {
      args.target = argv[(i += 1)];
    } else if (arg === "--no-build") {
      // Stage an already-built binary (used by the guard's own smoke check).
      args.build = false;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (args.profile !== "debug" && args.profile !== "release") {
    fail(`--profile must be "debug" or "release" (got ${JSON.stringify(args.profile)})`);
  }
  return args;
}

function fail(message) {
  console.error(`build-cli-sidecar: ${message}`);
  process.exit(1);
}

function run(command, commandArgs) {
  return execFileSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** The host target triple, read from `rustc -vV`'s `host:` line. */
function hostTriple() {
  const out = run("rustc", ["-vV"]);
  const line = out.split("\n").find((l) => l.startsWith("host: "));
  if (!line) fail("could not read the host triple from `rustc -vV`");
  return line.slice("host: ".length).trim();
}

/**
 * Cargo's target directory. Read from `cargo metadata` rather than assumed to be
 * `<repo>/target`: this repo's contributors set `build.target-dir` globally (see
 * `src-tauri/CLAUDE.md` "Gotchas" — the shared-target staleness note), so a
 * hardcoded path would stage a stale binary or none at all.
 */
function targetDir() {
  const meta = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--no-deps"]));
  if (!meta.target_directory) fail("`cargo metadata` returned no target_directory");
  return meta.target_directory;
}

const args = parseArgs(process.argv.slice(2));
const triple = args.target ?? hostTriple();
const exeSuffix = triple.includes("windows") ? ".exe" : "";

if (args.build) {
  const cargoArgs = ["build", "-p", "myne-cli"];
  if (args.profile === "release") cargoArgs.push("--release");
  if (args.target) cargoArgs.push("--target", args.target);
  // Inherit stdout too: a cargo build is slow enough that silence reads as a hang.
  execFileSync("cargo", cargoArgs, { cwd: repoRoot, stdio: "inherit" });
}

const builtPath = join(
  targetDir(),
  ...(args.target ? [args.target] : []),
  args.profile,
  `${BIN_NAME}${exeSuffix}`,
);
if (!existsSync(builtPath)) {
  fail(`built binary not found at ${builtPath} — run without --no-build`);
}

const stagedName = `${BIN_NAME}-${triple}${exeSuffix}`;
const stagedPath = join(STAGE_DIR, stagedName);
const bytes = readFileSync(builtPath);

mkdirSync(STAGE_DIR, { recursive: true });
// Write-if-changed: the bundler only needs the bytes to be right, and a needless
// rewrite churns the file's mtime on every `tauri dev` restart.
if (existsSync(stagedPath) && readFileSync(stagedPath).equals(bytes)) {
  console.log(`build-cli-sidecar: ${stagedName} already current (${args.profile})`);
} else {
  writeFileSync(stagedPath, bytes);
  console.log(`build-cli-sidecar: staged ${stagedName} (${args.profile})`);
}
if (exeSuffix === "") chmodSync(stagedPath, 0o755);
