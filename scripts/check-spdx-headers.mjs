#!/usr/bin/env node
// Every tracked Rust source file carries `// SPDX-License-Identifier: AGPL-3.0-only`
// on line 1.
//
// **Why this is a script and not a shell loop in the hook.** It lived as an
// eight-line `for` over `{staged_files}` inside `lefthook.yml`, scoped to
// `protocol/*.rs`, with a second copy of the same loop inside
// `scripts/hooks-parity-check.sh` (the CI backstop that exists so
// `--no-verify` cannot slip a violation past the hook). Two copies of one rule
// is a rule with two chances to drift, and the drift is silent in both
// directions: widen the hook and not the backstop and CI stops covering the new
// directories, widen the backstop and not the hook and the failure is only
// visible in CI, on somebody else's push. So the rule lives here once and both
// callers invoke it: the hook with the staged paths as arguments, CI with none.
//
// **Why the whole tree rather than a directory roster.** The scope used to be
// `protocol/` because that is where the file-level claim started. The claim is
// actually about every AGPL-3.0-only crate, so a roster of directories is a second
// thing to keep in step with `Cargo.toml`, and the failure it produces is the
// one this repo records twice already: a guard blind to a whole client. Scoping
// to every tracked `.rs` means a new crate is covered by being Rust.
//
// **The two modes, and why zero candidates means different things.** With
// arguments (the pre-commit hook) zero `.rs` among them is fine: a docs-only
// commit stages no Rust and the hook still runs. With no arguments (the CI
// backstop, and a hand run) the candidate set comes from `git ls-files`, which
// cannot legitimately be empty in this repository, so an empty set is a
// failure by name rather than a green tick over nothing read.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The exact first line every Rust source file must carry. */
export const SPDX_HEADER = "// SPDX-License-Identifier: AGPL-3.0-only";

/** Paths from `paths` whose first line is not [`SPDX_HEADER`].
 *
 *  `read` is injected so the rule can be driven over a fixture without a
 *  filesystem. A path that cannot be read is returned as missing: the check
 *  fails closed, because "I could not read it" is not evidence of compliance. */
export function missingHeader(paths, read) {
  const missing = [];
  for (const path of paths) {
    let firstLine;
    try {
      const text = read(path);
      firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
    } catch {
      missing.push(path);
      continue;
    }
    if (firstLine !== SPDX_HEADER) missing.push(path);
  }
  return missing;
}

/** Every tracked `.rs` path, relative to the repo root. */
function trackedRustFiles() {
  return execFileSync("git", ["ls-files", "-z", "*.rs"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const wholeTree = args.length === 0;

  const candidates = wholeTree
    ? trackedRustFiles()
    : args.filter((p) => p.endsWith(".rs") && existsSync(join(ROOT, p)));

  if (wholeTree && candidates.length === 0) {
    console.error(
      "spdx-header: FAIL — `git ls-files '*.rs'` returned nothing. This repository " +
        "is Rust; an empty candidate set means the scan read no file at all, not " +
        "that every file complies.",
    );
    process.exit(1);
  }

  const missing = missingHeader(candidates, (p) => readFileSync(join(ROOT, p), "utf8"));

  if (missing.length > 0) {
    console.error(
      `spdx-header: FAIL — ${missing.length} Rust file(s) missing ` +
        `\`${SPDX_HEADER}\` on line 1:\n` +
        missing.map((p) => `  ${p}`).join("\n") +
        "\n  This header is the machine-readable anchor of the file-level licensing\n" +
        "  claim (root AGENTS.md \"License\", LICENSING.md). Fix: make it line 1.",
    );
    process.exit(1);
  }

  console.log(
    `spdx-header: ok (${candidates.length} Rust file(s)` +
      `${wholeTree ? " across the tracked tree" : " staged"} carry the AGPL-3.0-only header)`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("check-spdx-headers.mjs")) {
  main();
}
