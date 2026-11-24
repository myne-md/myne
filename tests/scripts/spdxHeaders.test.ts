// Injection tests for `check-spdx-headers.mjs`.
//
// Root `AGENTS.md`: verifying a guard means BREAKING it. The guard this file
// covers is the extraction of a rule that used to live as two hand-copied shell
// loops (the pre-commit hook, scoped to `protocol/*.rs`, and the CI backstop in
// `hooks-parity-check.sh`). The extraction is only worth anything if the rule
// still names the defects the loops caught, so each defect class is injected
// here rather than asserted by prose.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { missingHeader, SPDX_HEADER } from "../../scripts/check-spdx-headers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A `read` over an in-memory tree, so no fixture touches the filesystem. */
function readerFor(files: Record<string, string>) {
  return (path: string): string => {
    const text = files[path];
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    return text;
  };
}

describe("missingHeader", () => {
  it("passes a file whose first line is the header", () => {
    const read = readerFor({ "core/src/lib.rs": `${SPDX_HEADER}\n//! docs\n` });
    expect(missingHeader(["core/src/lib.rs"], read)).toEqual([]);
  });

  it("passes a file that is only the header", () => {
    // No trailing newline. The slice must not run off the end of the string.
    const read = readerFor({ "core/src/lib.rs": SPDX_HEADER });
    expect(missingHeader(["core/src/lib.rs"], read)).toEqual([]);
  });

  it("names a file with no header at all", () => {
    const read = readerFor({ "core/src/lib.rs": "//! docs\nfn main() {}\n" });
    expect(missingHeader(["core/src/lib.rs"], read)).toEqual(["core/src/lib.rs"]);
  });

  it("names a file whose header sits on line 2", () => {
    // The pre-commit loop used `head -1`, and this is the shape it caught: a
    // `#![no_std]` or a doc comment pushed the header down.
    const read = readerFor({ "core/src/lib.rs": `#![no_std]\n${SPDX_HEADER}\n` });
    expect(missingHeader(["core/src/lib.rs"], read)).toEqual(["core/src/lib.rs"]);
  });

  it("names a near-miss licence identifier", () => {
    // `AGPL-3.0` is the deprecated identifier and `AGPL-3.0-or-later` is a
    // different licence. A rule that accepted a prefix would let the app's own
    // licence be swapped for another AGPL variant without a word.
    const read = readerFor({
      "a.rs": "// SPDX-License-Identifier: AGPL-3.0-only\n",
      "b.rs": "// SPDX-License-Identifier: MIT\n",
      "c.rs": "//SPDX-License-Identifier: AGPL-3.0\n",
    });
    expect(missingHeader(["a.rs", "b.rs", "c.rs"], read)).toEqual(["b.rs", "c.rs"]);
  });

  it("fails closed when a path cannot be read", () => {
    // "I could not read it" is not evidence of compliance.
    const read = readerFor({});
    expect(missingHeader(["core/src/lib.rs"], read)).toEqual(["core/src/lib.rs"]);
  });
});

describe("the wired guard", () => {
  it("passes over the tracked tree and says how many files it read", () => {
    const out = execFileSync("node", ["scripts/check-spdx-headers.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("spdx-header: ok");
    // A count, so an accidentally-narrowed scan is visible in the output rather
    // than reading as a pass. The repository is Rust; the floor is the reason
    // the whole-tree mode treats an empty set as a failure.
    const count = Number(out.match(/ok \((\d+) Rust file/)?.[1] ?? "0");
    expect(count).toBeGreaterThan(500);
  });

  it("treats zero .rs among staged paths as fine, not as a failure", () => {
    // The asymmetry with the whole-tree mode: a docs-only commit stages no Rust
    // and the pre-commit hook still runs, so this must exit 0.
    const out = execFileSync("node", ["scripts/check-spdx-headers.mjs", "README.md"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("ok (0 Rust file(s) staged carry the AGPL-3.0-only header)");
  });
});
