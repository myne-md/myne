import { describe, expect, it } from "vitest";

import {
  analyse,
  CLIENT_SHEETS,
  SHARED_SHEET,
  tokensIn,
} from "../../scripts/check-token-parity.mjs";

// Injection suite for `scripts/check-token-parity.mjs`.
//
// Per `AGENTS.md`: verifying a guard means BREAKING it, not running it. Each
// defect the guard claims to catch is injected here against a synthetic file
// set, never against `src/` or `mobile/src/`, so a crashed run cannot leave a
// production stylesheet corrupted, and the guard must NAME it.
//
// The interaction rows matter as much as the isolated ones. This guard ships
// four failing checks; proving each alone is necessary and not sufficient,
// because the failure this repo has actually shipped is a guard whose later edit
// closed one blind spot and opened another one line away, green throughout
// (myne-md/myne#411).

/** A minimal tree: the shared sheet, two client sheets, one consumer. */
function tree(over: Record<string, string> = {}): Record<string, string> {
  return {
    "client-core/src/tokens.css": ":root { --paper: #fff; --accent: #123; }",
    "src/styles/tokens.css": ":root { --toast-accent: #456; }",
    "mobile/src/styles/tokens.css": ":root { --m-touch: 44px; }",
    "mobile/src/styles/mobile.css": ":root { --glass-tint: rgba(0,0,0,.2); }",
    "src/app.tsx": `const s = { background: "var(--paper)", color: "var(--accent)" };`,
    ...over,
  };
}

type Finding = { token: string; sheet?: string; files?: string[] };
type Result = {
  fatal?: string;
  oneSided: Finding[];
  staleOverrides: string[];
  undeclared: { token: string; files: string[] }[];
  staleRuntime: string[];
  missingSheets: string[];
};

// `analyse` is imported from a `.mjs` with no type declarations, so its return
// type is inferred as a union with the `{ fatal }` early exit. Annotating here
// rather than at every call site: `tests/` is outside `tsconfig.json`'s
// `include`, so `check-test-typecheck.mjs` is the only thing that would report
// the resulting `possibly undefined` noise, and a ratchet is not the place to
// learn about it.
function run(files: Record<string, string>): Result {
  return analyse({
    sharedSheet: "client-core/src/tokens.css",
    clientSheets: [
      "src/styles/tokens.css",
      "mobile/src/styles/tokens.css",
      "mobile/src/styles/mobile.css",
    ],
    consumerFiles: Object.keys(files).filter(
      (f) => !f.endsWith("tokens.css") && !f.endsWith("mobile.css"),
    ),
    read: (p: string) => files[p] ?? null,
  }) as Result;
}

describe("check-token-parity", () => {
  it("passes on a tree with no defect", () => {
    const r = run(tree());
    expect(r.fatal).toBeUndefined();
    expect(r.oneSided).toEqual([]);
    expect(r.undeclared).toEqual([]);
    expect(r.missingSheets).toEqual([]);
  });

  it("fires when a client sheet overrides a shared token without a record", () => {
    // The two-AMOLED-greys shape: one name, two values, neither side aware.
    const r = run(tree({ "src/styles/tokens.css": ":root { --paper: #eee; }" }));
    expect(r.oneSided.map((o) => o.token)).toContain("--paper");
  });

  it("fires when two client sheets declare the same name independently", () => {
    // The 105-token shape one file over: two clients answering one question.
    const r = run(
      tree({
        "src/styles/tokens.css": ":root { --card-bg: #eee; }",
        "mobile/src/styles/tokens.css": ":root { --card-bg: #ddd; }",
      }),
    );
    expect(r.oneSided.map((o) => o.token)).toContain("--card-bg");
  });

  it("leaves a token only ONE client declares alone", () => {
    // `--toast-accent` is desktop chrome and `--m-touch` is a phone metric.
    // A rule that fired on these would be a rule nobody could keep.
    const r = run(tree());
    expect(r.oneSided).toEqual([]);
  });

  it("fires on a fallback-less var() naming a token nothing declares", () => {
    // The `--paper-1` shape: resolves to nothing, looks like flat design.
    const r = run(tree({ "src/app.tsx": `const s = { background: "var(--paper-1)" };` }));
    expect(r.undeclared.map((u) => u.token)).toEqual(["--paper-1"]);
    expect(r.undeclared[0].files).toEqual(["src/app.tsx"]);
  });

  it("does NOT fire when the same reference carries a fallback", () => {
    // A stated fallback is a choice, not silence. This is the line between the
    // two, and it is the reason the rule can be a gate at all.
    const r = run(tree({ "src/app.tsx": `const s = { background: "var(--paper-1, #fff)" };` }));
    expect(r.undeclared).toEqual([]);
  });

  it("catches the toolbar's cssVar shape, where the var() is built later", () => {
    // `editor/src/toolbar/plugin.ts` holds the token NAME as a string and
    // injects `var(${name})` at render. A scanner that only saw `var(` would
    // have missed all thirteen swatches, which is where this started.
    const r = run(tree({ "src/app.tsx": `const sw = [{ cssVar: "--highlight-teal" }];` }));
    expect(r.undeclared.map((u) => u.token)).toEqual(["--highlight-teal"]);
  });

  it("fires on a recorded override whose token no longer exists", () => {
    // `OVERRIDES` names the two AMOLED greys. Neither appears in this synthetic
    // tree, so both must come back as stale, a record that outlives its subject
    // describes nothing.
    const r = run(tree());
    expect(r.staleOverrides).toEqual(["--_paper-2-amoled", "--_paper-3-amoled"]);
  });

  it("fires on a recorded runtime token nothing references", () => {
    const r = run(tree());
    expect(r.staleRuntime).toEqual([
      "--editor-font-family",
      "--editor-text-size",
      "--editor-line-spacing",
    ]);
  });

  it("does not count a recorded runtime token as undeclared", () => {
    const r = run(tree({ "src/app.tsx": `const s = { font: "var(--editor-font-family)" };` }));
    expect(r.undeclared).toEqual([]);
    expect(r.staleRuntime).not.toContain("--editor-font-family");
  });

  it("fires when a rostered sheet is gone", () => {
    const files = tree();
    delete files["mobile/src/styles/mobile.css"];
    expect(run(files).missingSheets).toEqual(["mobile/src/styles/mobile.css"]);
  });

  it("fails outright when the shared sheet is gone", () => {
    const files = tree();
    delete files["client-core/src/tokens.css"];
    expect(run(files).fatal).toMatch(/shared token sheet is missing/);
  });

  it("names every defect at once rather than stopping at the first", () => {
    const r = run(
      tree({
        "src/styles/tokens.css": ":root { --paper: #eee; }",
        "src/app.tsx": `const s = { background: "var(--nope)" };`,
      }),
    );
    expect(r.oneSided.map((o) => o.token)).toContain("--paper");
    expect(r.undeclared.map((u) => u.token)).toContain("--nope");
    expect(r.staleOverrides.length).toBeGreaterThan(0);
  });

  it("ignores tokens named inside comments, in CSS and in TypeScript", () => {
    // The measuring pass that opened this issue reported `----group-rose` and
    // `--_token-dark` as undeclared references. Both were prose: one in a
    // comment warning about the double-prefix trap, one in a comment sketching
    // `--token: var(--_token-dark)`. A guard that reads comments as code
    // produces findings nobody can act on, which is how a guard gets ignored.
    expect(tokensIn("a.css", "/* --ghost: 1; */ :root { --real: 2; }").declared).toEqual(
      new Set(["--real"]),
    );
    expect(tokensIn("a.css", "/* var(--ghost) */ a { color: var(--real); }").referenced).toEqual(
      new Set(["--real"]),
    );
    expect(tokensIn("a.ts", `// var(--ghost)\nconst x = "var(--real)";`).referenced).toEqual(
      new Set(["--real"]),
    );
    expect(tokensIn("a.ts", `/* var(--ghost) */ const x = "var(--real)";`).referenced).toEqual(
      new Set(["--real"]),
    );
  });

  it("does not mistake a URL for a comment", () => {
    // The private line-stripper this replaced dropped every line whose trimmed
    // form began `//`, and kept a trailing `// …` in place. Neither is what a
    // comment is. `stripComments` from `check-twin-inventory.mjs` walks
    // characters and knows a string literal, which is why it is imported rather
    // than re-written, the token here survives inside a URL, and the one after
    // a trailing comment marker does not.
    expect(tokensIn("a.ts", `const u = "https://x/var(--real)";`).referenced).toEqual(
      new Set(["--real"]),
    );
    expect(tokensIn("a.ts", `const n = 1; // var(--ghost)`).referenced).toEqual(new Set());
  });

  it("skips a file with no `--` in it at all", () => {
    // The prefilter: only 412 of the tree's 1330 files contain `--`, and the
    // strip is the expensive half. Asserted so the shortcut cannot start
    // skipping a file that does have one.
    expect(tokensIn("a.ts", "const x = 1;")).toEqual({
      declared: new Set(),
      referenced: new Set(),
    });
    expect(tokensIn("a.ts", `const x = "var(--real)";`).referenced).toEqual(new Set(["--real"]));
  });

  it("drives the guard's own roster rather than a copy of it", () => {
    // The roster constants are exported; the test used to hardcode the same
    // four paths, so a sheet added to `CLIENT_SHEETS` would have left this
    // silently checking the old set.
    expect(SHARED_SHEET).toBe("client-core/src/tokens.css");
    expect(CLIENT_SHEETS).toContain("mobile/src/styles/tokens.css");
    expect(CLIENT_SHEETS.length).toBeGreaterThanOrEqual(3);
  });
});
