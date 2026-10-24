// Shared staging machinery for Tauri `externalBin` sidecars.
//
// The failure this prevents: `bundle.externalBin` in `src-tauri/tauri.conf.json`
// names e.g. `binaries/myne`, and Tauri resolves that to
// `src-tauri/binaries/myne-<target-triple>[.exe]` — a file no cargo build ever
// produces on its own (cargo emits `<target-dir>/<profile>/myne`, with no triple
// suffix). Without a staging step the bundler stops with "Failed to copy
// external binaries" and the desktop bundle ships without that sidecar. The
// triple suffix is also the reason this cannot be a plain `cp` in a Makefile:
// the name is host-dependent, so it has to be read from `rustc -vV` rather than
// written down.
//
// Two sidecars rode on this first — `myne` (the CLI thin client, MYND-490) and
// `myne-tor` (the arti SOCKS5 proxy, MYND-650); `myne-mcp` (the MCP front-end,
// myne-md/myne#923) makes three. They differ only in crate/bin name, so the
// mechanics live here and each `scripts/build-*-sidecar.mjs` keeps its own
// header explaining what its binary is for.
//
// Gotcha worth knowing before you debug it: after a `tauri build`, Tauri copies
// the staged file back into the cargo target dir with the triple STRIPPED — i.e.
// onto `<target-dir>/<profile>/<bin>`, which is also where cargo puts the built
// binary. So a `tauri build` (release-staged) leaves `target/debug/<bin>` holding
// release bytes, and cargo will not consider that a reason to rebuild. Harmless
// (same source either way, and this script re-copies from cargo's own path), but
// the byte sizes will not match your expectations if you go looking.
//
// Staged binaries are build artefacts and are gitignored (`src-tauri/binaries/`),
// exactly like `web/wasm/pkg/`: committing one would put a multi-MB binary in
// every diff and make the bundle's contents depend on whoever last ran a script.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTool } from "./run-tool.mjs";

/** Repo root, from this file's location (`<root>/scripts/lib/`). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The `externalBin` entries are `binaries/<bin>`, relative to `src-tauri/`. */
const STAGE_DIR = join(repoRoot, "src-tauri", "binaries");

/**
 * Parse the shared CLI surface: `[--profile debug|release] [--target <triple>]
 * [--no-build]`. `scriptName` only shapes the error messages.
 */
export function parseArgs(argv, scriptName) {
  const fail = (message) => {
    console.error(`${scriptName}: ${message}`);
    process.exit(1);
  };
  const args = { profile: "release", target: null, build: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      args.profile = argv[(i += 1)];
    } else if (arg === "--target") {
      args.target = argv[(i += 1)];
    } else if (arg === "--no-build") {
      // Stage an already-built binary (used by the guards' own smoke checks).
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

// FATAL on a tool failure (myne#528): this used to shell out with NO catch, so
// a `rustc`/`cargo` that could not run died as a bare stack trace whose
// diagnosis sat in the error nobody printed. Same verdict, but the helper
// prints argv, exit, BOTH streams and the cwd first — `cargo` writes its
// build errors to stderr while `cargo metadata` fails on stdout.
function run(command, commandArgs) {
  const r = runTool([command, ...commandArgs], {
    cwd: repoRoot,
    onToolFailure: "fatal",
  });
  return r.stdout;
}

/** The host target triple, read from `rustc -vV`'s `host:` line. */
function hostTriple(fail) {
  const out = run("rustc", ["-vV"]);
  const line = out.split("\n").find((l) => l.startsWith("host: "));
  if (!line) fail("could not read the host triple from `rustc -vV`");
  return line.slice("host: ".length).trim();
}

/**
 * Cargo's target directory. Read from `cargo metadata` rather than assumed to be
 * `<repo>/target`: this repo's contributors set `build.target-dir` globally (see
 * `src-tauri/AGENTS.md` "Gotchas" — the shared-target staleness note), so a
 * hardcoded path would stage a stale binary or none at all.
 */
function targetDir(fail) {
  const meta = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--no-deps"]));
  if (!meta.target_directory) fail("`cargo metadata` returned no target_directory");
  return meta.target_directory;
}

/**
 * Build `package`'s `binName` binary and copy it to
 * `src-tauri/binaries/<binName>-<triple>[.exe]`.
 *
 * @param {{scriptName: string, package: string, binName: string, args: ReturnType<typeof parseArgs>}} opts
 */
export function stageSidecar({ scriptName, package: pkg, binName, args }) {
  const fail = (message) => {
    console.error(`${scriptName}: ${message}`);
    process.exit(1);
  };

  const triple = args.target ?? hostTriple(fail);
  const exeSuffix = triple.includes("windows") ? ".exe" : "";

  if (args.build) {
    const cargoArgs = ["build", "-p", pkg, "--bin", binName];
    if (args.profile === "release") cargoArgs.push("--release");
    if (args.target) cargoArgs.push("--target", args.target);
    // FATAL (myne#528). A cargo build is slow enough that silence reads as a
    // hang, so the diagnostics are what make the wait legible, not noise.
    runTool(["cargo", ...cargoArgs], { cwd: repoRoot, onToolFailure: "fatal" });
  }

  const builtPath = join(
    targetDir(fail),
    ...(args.target ? [args.target] : []),
    args.profile,
    `${binName}${exeSuffix}`,
  );
  if (!existsSync(builtPath)) {
    fail(`built binary not found at ${builtPath} — run without --no-build`);
  }

  const stagedName = `${binName}-${triple}${exeSuffix}`;
  const stagedPath = join(STAGE_DIR, stagedName);
  const bytes = readFileSync(builtPath);

  mkdirSync(STAGE_DIR, { recursive: true });
  // Write-if-changed: the bundler only needs the bytes to be right, and a needless
  // rewrite churns the file's mtime on every `tauri dev` restart.
  if (existsSync(stagedPath) && readFileSync(stagedPath).equals(bytes)) {
    console.log(`${scriptName}: ${stagedName} already current (${args.profile})`);
  } else {
    writeFileSync(stagedPath, bytes);
    console.log(`${scriptName}: staged ${stagedName} (${args.profile})`);
  }
  if (exeSuffix === "") chmodSync(stagedPath, 0o755);
}
