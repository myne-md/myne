// Injection tests for `scripts/check-copy-membership.mjs` (audit R0.1,
// 2026-10-19).
//
// The guard exists because `copy/src/index.ts`'s header claimed its literals
// were "byte-identical across clients by construction" while eighteen of them
// — including both non-distinguishing banners `recovery-flow.md` §3.4/§7.3 pins
// — were declared in `src/lib/load-bearing-copy.ts` AND
// `mobile/src/lib/load-bearing-copy.ts` at the same time.
//
// Both directions are asserted, because a guard that stops checking is green by
// definition: the defect class must FIRE, and the fix that removes it (a
// re-export) must NOT be reported. The third case is the one nobody writes: a
// scan whose denominator has gone empty passes every rule inside it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  exportedNames,
  redefinitions,
  stripComments,
  unconsumed,
} from "../../scripts/check-copy-membership.mjs";

const COPY_NAMES = new Set([
  "UNLOCK_NON_DISTINGUISHING_BANNER",
  "RECOVERY_NON_DISTINGUISHING_BANNER",
  "CLIP_NOTICE_ROOT_MESSAGE",
]);

describe("exportedNames", () => {
  it("reads every declaration form the package uses", () => {
    const src = [
      'export const A = "a";',
      "export function b(): string { return \"b\"; }",
      "export type C = string;",
      "export interface D { x: number }",
      // The local re-export form: `B as C` exports `C`, `A` exports `A`.
      "export { A, B as Cnym };",
    ].join("\n");
    expect([...exportedNames(src)].sort()).toEqual(["A", "C", "Cnym", "D", "b"]);
  });

  it("does not read a `from`-re-export as a declaration, which is the FIX", () => {
    // If it did, the guard would report the corrected tree — the shape that made
    // the whole class invisible in the first place one step further on.
    expect([...exportedNames('export { X } from "@myne/copy";')]).toEqual([]);
  });

  it("finds nothing in an empty denominator", () => {
    expect([...exportedNames("// nothing here")]).toEqual([]);
  });
});

describe("redefinitions — the defect class (must fire)", () => {
  it("names a client file that declares a name @myne/copy already exports", () => {
    // The exact shape of all eighteen: a second `export const` with the same
    // name and, on the day it was found, the same bytes.
    const files = [
      [
        "src/lib/load-bearing-copy.ts",
        'export const UNLOCK_NON_DISTINGUISHING_BANNER =\n  "Wrong password or vault file is corrupted.";',
      ],
    ];
    expect(redefinitions(files, COPY_NAMES)).toEqual([
      ["src/lib/load-bearing-copy.ts", "UNLOCK_NON_DISTINGUISHING_BANNER"],
    ]);
  });

  it("names the mobile twin too, which is the pair the header overclaimed", () => {
    const files = [
      ["mobile/src/lib/load-bearing-copy.ts", 'export const CLIP_NOTICE_ROOT_MESSAGE = "Clipped to your vault root.";'],
    ];
    expect(redefinitions(files, COPY_NAMES)).toEqual([
      ["mobile/src/lib/load-bearing-copy.ts", "CLIP_NOTICE_ROOT_MESSAGE"],
    ]);
  });
});

describe("redefinitions — the fix (must NOT fire)", () => {
  it("passes a re-export from @myne/copy", () => {
    const files = [
      [
        "src/lib/load-bearing-copy.ts",
        'export {\n  UNLOCK_NON_DISTINGUISHING_BANNER,\n  RECOVERY_NON_DISTINGUISHING_BANNER,\n} from "@myne/copy";',
      ],
    ];
    expect(redefinitions(files, COPY_NAMES)).toEqual([]);
  });

  it("passes a name the package does not export — a client's own surface copy", () => {
    const files = [["src/lib/load-bearing-copy.ts", 'export const AI_CHAT_HONESTY_NOTE = "…";']];
    expect(redefinitions(files, COPY_NAMES)).toEqual([]);
  });

  it("passes a private helper that happens to be named after an export", () => {
    // Only EXPORTED bindings count. `copy` exporting a name does not license a
    // rule against a client's own local constant with the same spelling.
    const files = [
      ["src/lib/other.ts", 'const UNLOCK_NON_DISTINGUISHING_BANNER = "local";\nexport function f() { return UNLOCK_NON_DISTINGUISHING_BANNER; }'],
    ];
    expect(redefinitions(files, COPY_NAMES)).toEqual([]);
  });
});

describe("stripComments — prose about the name is not a declaration", () => {
  it("ignores a doc comment that writes the name", () => {
    const src = [
      "/** Unlock A8b `InvalidCredentialOrVault` banner — §7.3 compound form. */",
      "// export const UNLOCK_NON_DISTINGUISHING_BANNER = \"…\";",
      "export const OTHER = 1;",
    ].join("\n");
    expect([...exportedNames(stripComments(src))]).toEqual(["OTHER"]);
  });
});

describe("unconsumed — the other direction, and it is a warning by design", () => {
  it("names an export nothing outside copy/ mentions", () => {
    expect(unconsumed(new Set(["A", "B"]), "const x = A;")).toEqual(["B"]);
  });

  it("accepts a mention anywhere, including a test asserting the literal", () => {
    expect(unconsumed(new Set(["A"]), "expect(A).toBe(…);")).toEqual([]);
  });

  it("does not match a name as a substring of a longer identifier", () => {
    // `\b` on both sides: `A` must not be satisfied by `Ab`.
    expect(unconsumed(new Set(["A"]), "const Ab = 1;")).toEqual(["A"]);
  });
});

describe("the real tree", () => {
  it("declares every name @myne/copy exports in exactly one place", () => {
    // The integration half: this is the run that would have found all eighteen
    // on the day they were written. It fails by naming the file, not by count.
    const copySource = readFileSync("copy/src/index.ts", "utf8");
    const names = exportedNames(stripComments(copySource));
    const files = [
      ["src/lib/load-bearing-copy.ts", readFileSync("src/lib/load-bearing-copy.ts", "utf8")],
      [
        "mobile/src/lib/load-bearing-copy.ts",
        readFileSync("mobile/src/lib/load-bearing-copy.ts", "utf8"),
      ],
    ];
    expect(redefinitions(files, names)).toEqual([]);
  });

  it("carries the eighteen literals R0.1 moved", () => {
    const copySource = readFileSync("copy/src/index.ts", "utf8");
    const names = exportedNames(stripComments(copySource));
    for (const name of [
      "UNLOCK_NON_DISTINGUISHING_BANNER",
      "RECOVERY_NON_DISTINGUISHING_BANNER",
      "LOST_BOTH_SECRETS_SENTENCE",
      "EXPORT_PLAIN_MARKDOWN_SENTENCE",
      "VAULT_EXPORT_PLAIN_TREE_SENTENCE",
      "EXPORT_ATTACHMENTS_PLACEMENT_SUBLABEL",
      "EXPORT_PDF_PLAIN_SENTENCE",
      "EXPORT_PDF_EXCLUSION_SENTENCE",
      "EXPORT_PLAIN_HTML_SENTENCE",
      "EXPORT_PLAIN_TEXT_SENTENCE",
      "BACKUP_SCHEDULE_FAILED_TOAST",
      "CLIP_NOTICE_ROOT_MESSAGE",
      "CLIP_NOTICE_VIEW_ACTION",
      "clipOmittedTallyLine",
      "CONNECTED_EXTENSIONS_TITLE",
      "CONNECTED_EXTENSIONS_HELPER",
      "CONNECTED_EXTENSIONS_EMPTY",
      "CONNECTED_EXTENSIONS_REVOKE_LABEL",
      "CONNECTED_EXTENSIONS_REPAIR_HINT",
    ]) {
      expect(names.has(name), `${name} is not exported by @myne/copy`).toBe(true);
    }
  });
});
