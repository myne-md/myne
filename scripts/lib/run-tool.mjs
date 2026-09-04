#!/usr/bin/env node
// The one way scripts under this repo shell out to another tool (myne#528).
//
// # The failure this prevents
//
// Nine scripts ran external tools and handled "the tool could not run" nine
// different ways, six of them a bare `catch` returning a default — so a tool
// that could not run was indistinguishable from a tool that found nothing, and
// the guard was green while checking nothing. `check-npm-licenses.mjs` printed
// only `Command failed: pnpm licenses list --json` for months while the whole
// diagnosis sat in the discarded `err.stdout` (#515), and the same shape sat in
// five more scripts.
//
// # The two decisions this helper forces
//
// Every call site MUST pass `onToolFailure`, and the choice is the point: a
// helper that merely formatted the error well would still let the next bare
// `catch {}` through.
//
//   { onToolFailure: "fatal" }   — a tool that could not run fails the script.
//                                  The helper prints argv, exit status, BOTH
//                                  streams and the cwd, then throws. Nothing
//                                  legitimately-empty about it.
//   { onToolFailure: "empty", reason: "…" } — this failure IS a legitimate
//                                  empty result, and the written reason says
//                                  why (e.g. "the record has a first commit;
//                                  before it there was nothing to preserve").
//                                  The helper still prints the diagnostics to
//                                  stderr — a decision to tolerate an empty
//                                  result is not a decision to be silent about
//                                  how it came about — and returns null.
//
// # Why BOTH streams, unconditionally
//
// `pnpm` and `tsc` both write their diagnostics to STDOUT and leave stderr
// empty, so a helper that only surfaced stderr would be a new version of the
// same bug. The diagnostic block prints both. `tests/scripts/runTool.test.ts`
// injects a tool that fails on stdout only, which is the case that dies first.
//
// Zero dependencies, importable: `import { runTool } from "./lib/run-tool.mjs"`

import { spawnSync } from "node:child_process";

/** Thrown when `onToolFailure: "fatal"` arms fire; carries the full
 *  diagnostic block so an uncaught instance still prints it. */
export class ToolRunError extends Error {
  constructor(diagnostic) {
    super(diagnostic);
    this.name = "ToolRunError";
  }
}

export function formatDiagnostic({ argv, status, stdout, stderr, cwd, reason }) {
  const lines = [];
  if (reason) lines.push(`  tolerated as an empty result: ${reason}`);
  lines.push(`  command: ${argv.join(" ")}`);
  lines.push(`  exit: ${status === null ? "(killed / could not spawn)" : status}`);
  lines.push(`  cwd: ${cwd}`);
  lines.push(`  stdout: ${JSON.stringify(stdout)}`);
  lines.push(`  stderr: ${JSON.stringify(stderr)}`);
  return lines.join("\n");
}

/**
 * Run `argv[0]` with arguments `argv.slice(1)`, forcing the caller to decide
 * what a tool failure means.
 *
 * Returns `{ status, stdout, stderr }` on any exit status the caller asked to
 * see (`expectStatus`, default 0). Any other outcome is a tool failure and is
 * handled per `onToolFailure`. Spawning at all counts as running; a tool that
 * ran and found nothing exits 0.
 */
export function runTool(
  argv,
  { cwd = process.cwd(), onToolFailure, reason, expectStatus = 0, maxBuffer, spawner } = {},
) {
  if (onToolFailure !== "fatal" && onToolFailure !== "empty") {
    throw new Error(
      `runTool: onToolFailure is REQUIRED and must be "fatal" or "empty" — ` +
        `the choice is the point of this helper (myne#528). Command: ${argv.join(" ")}`,
    );
  }
  if (onToolFailure === "empty" && typeof reason !== "string") {
    throw new Error(
      `runTool: onToolFailure "empty" requires a written reason naming why a ` +
        `tool that could not run is a legitimate empty result. Command: ${argv.join(" ")}`,
    );
  }

  // Injectable for the spec (tests/scripts/runTool.test.ts): a helper whose
  // failure arms can only be exercised by spawning real tools gets tested by
  // nobody, which is how #515 shipped.
  const spawn = spawner ?? spawnSync;
  const r = spawn(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: maxBuffer ?? 64 * 1024 * 1024,
  });

  const diagnostic = formatDiagnostic({
    argv,
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    cwd,
    reason,
  });

  if (r.error !== undefined || r.status !== expectStatus) {
    if (r.error !== undefined) {
      console.error(`runTool: could not run (spawn error: ${r.error.message})\n${diagnostic}`);
    } else {
      console.error(`runTool: tool failed\n${diagnostic}`);
    }
    if (onToolFailure === "fatal") throw new ToolRunError(diagnostic);
    return null;
  }
  return r;
}
