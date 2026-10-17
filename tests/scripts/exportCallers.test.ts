// Injection suite for `scripts/check-export-callers.mjs`.
//
// The guard exists because a dead export is invisible to every other check in
// this repository: it compiles, it lints (this tree has no eslint, and an unused
// export is not lintable in principle), and it cannot fail a test, because nothing
// calls it. `check-unwired.mjs` sees the MODULE and `check-ipc-binding-callers.mjs`
// the BINDING; a single dead function inside a live module is below both.
//
// Both directions, per the repo rule. The ratchet's arms are driven through
// `analyse` (the world is injected, so no `git restore` and no half-restored tree),
// the matcher through the exported pure helpers, and the real record against the
// real tree — because a guard whose only test is synthetic can be green while the
// file it actually reads is empty.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EXEMPT,
  analyse,
  exportedFunctionNames,
  isReferenced,
  isTestPath,
  mentionIndex,
  recordFrom,
} from "../../scripts/check-export-callers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECORD_FILE = join(ROOT, "scripts", "export-callers.json");

type Io = Parameters<typeof analyse>[0];
const messages = (io: Io) => analyse(io).failures.join("\n");

/** A world whose record and measurement agree: one file, two dead exports. */
function healthy(): Io {
  return {
    record: { "src/lib/one.ts": 2 },
    found: new Map([["src/lib/one.ts", ["alpha", "beta"]]]),
    exempt: [],
  };
}

describe("the healthy baseline", () => {
  it("reports no failure", () => {
    expect(analyse(healthy()).failures).toEqual([]);
  });

  it("is not vacuous: it carries a real count", () => {
    expect(analyse(healthy()).stats).toMatchObject({ total: 2, files: 1 });
  });

  it("refuses to run at all without a record, rather than skipping the ratchet", () => {
    // The parameter-with-a-default trap: the default would be the arm that never
    // fires, excusing a future caller from the whole rule without anyone choosing it.
    const io = healthy() as Record<string, unknown>;
    delete io.record;
    expect(() => analyse(io as Io)).toThrow(/`record` is required/);
  });
});

describe("the ratchet, both directions", () => {
  it("names a file that is not on the record at all", () => {
    const io = healthy();
    io.found = new Map([
      ["src/lib/one.ts", ["alpha", "beta"]],
      ["src/lib/brand-new.ts", ["orphan1", "orphan2", "orphan3"]],
    ]);
    expect(messages(io)).toMatch(/src\/lib\/brand-new\.ts: 3 exported function\(s\)/);
    expect(messages(io)).toMatch(/A NEW file starts at zero/);
    // …and it NAMES the functions, because "3 of something" is not actionable.
    expect(messages(io)).toMatch(/orphan1, orphan2, orphan3/);
  });

  it("names a count that GREW, and says it may only shrink", () => {
    const io = healthy();
    io.found = new Map([["src/lib/one.ts", ["alpha", "beta", "gamma"]]]);
    expect(messages(io)).toMatch(/3 exported function\(s\).*up from a recorded 2/s);
    expect(messages(io)).toMatch(/may shrink; it may not grow/);
  });

  it("names a budget that is now larger than reality, and calls it stale", () => {
    const io = healthy();
    io.found = new Map([["src/lib/one.ts", ["alpha"]]]);
    expect(messages(io)).toMatch(/recorded 2, found 1/);
    expect(messages(io)).toMatch(/--record/);
  });

  it("names a record entry whose file has no unreferenced export left", () => {
    const io = healthy();
    io.found = new Map();
    expect(messages(io)).toMatch(/recorded 2, found 0/);
  });
});

describe("--record may answer a stale budget and nothing else", () => {
  it("leaves a stale budget out of the blocking set, so the shrink can be locked in", () => {
    // The deadlock this split exists for: a stale budget IS the shrink signal, so a
    // `--record` that refused on every failure could never run — the command the
    // failure message suggests would be the one command that cannot answer it.
    const io = healthy();
    io.found = new Map([["src/lib/one.ts", ["alpha"]]]);
    const r = analyse(io);
    expect(r.failures.join("\n")).toMatch(/recorded 2, found 1/);
    expect(r.blocking).toEqual([]);
  });

  it("blocks on a new or grown count, and on a defective exemption", () => {
    const grown = healthy();
    grown.found = new Map([["src/lib/one.ts", ["alpha", "beta", "gamma"]]]);
    expect(analyse(grown).blocking.join("\n")).toMatch(/may shrink; it may not grow/);

    const fresh = healthy();
    fresh.found = new Map([["src/lib/brand-new.ts", ["a"]]]);
    expect(analyse(fresh).blocking.join("\n")).toMatch(/A NEW file starts at zero/);

    const badExempt = healthy();
    badExempt.exempt = [{ file: "src/lib/one.ts", reason: "later" }];
    expect(analyse(badExempt).blocking.join("\n")).toMatch(/shorter than 40 characters/);
  });
});

describe("--record only ever locks in a shrink", () => {
  it("writes the measured counts when nothing grew", () => {
    const { grown, next } = recordFrom({ "src/lib/one.ts": 2 }, new Map([["src/lib/one.ts", ["alpha"]]]));
    expect(grown).toEqual([]);
    expect(next).toEqual({ "src/lib/one.ts": 1 });
  });

  it("REFUSES to bless a new file, naming it", () => {
    const { grown, next } = recordFrom({}, new Map([["src/lib/brand-new.ts", ["a", "b"]]]));
    expect(next).toBeNull();
    expect(grown).toEqual([{ file: "src/lib/brand-new.ts", was: 0, now: 2 }]);
  });

  it("REFUSES to bless a grown count, and drops entries that reached zero", () => {
    const { grown } = recordFrom({ "src/lib/one.ts": 1 }, new Map([["src/lib/one.ts", ["a", "b"]]]));
    expect(grown).toEqual([{ file: "src/lib/one.ts", was: 1, now: 2 }]);
    // A file whose exports all found callers leaves the record entirely rather
    // than sitting at 0, or the record describes a tree with no debt in it.
    const { next } = recordFrom({ "src/lib/one.ts": 2 }, new Map([["src/lib/one.ts", ["a"]]]));
    expect(next).toEqual({ "src/lib/one.ts": 1 });
  });
});

describe("EXEMPT: the one shape that may keep a dead-in-repo export", () => {
  it("excuses a file with the reasoned consumer named", () => {
    const io = healthy();
    io.found = new Map([
      ["src/lib/one.ts", ["alpha", "beta"]],
      ["ornaments/src/public-api.ts", ["published"]],
    ]);
    io.exempt = [
      { file: "ornaments/src/public-api.ts", reason: "imported by myne-website's theme builder as @myne/ornaments" },
    ];
    // Excused: the ratchet does not see it, and the record has nothing to say
    // about the file either.
    expect(analyse(io).failures).toEqual([]);
    expect(analyse(io).stats).toMatchObject({ total: 2, files: 1, exempt: 1 });
    // …and the other direction: without the exemption it IS named, in this file.
    io.exempt = [];
    expect(messages(io)).toMatch(/ornaments\/src\/public-api\.ts: 1 exported function\(s\)/);
  });

  it("refuses a reason too short to name a consumer", () => {
    const io = healthy();
    io.exempt = [{ file: "src/lib/one.ts", reason: "we might need it later" }];
    expect(messages(io)).toMatch(/reason is shorter than 40 characters/);
  });

  it("refuses an exemption whose file has no unreferenced export, as stale", () => {
    const io = healthy();
    io.record = {};
    io.found = new Map();
    io.exempt = [
      { file: "src/lib/clean.ts", reason: "a file whose every export already has a caller in this tree" },
    ];
    expect(messages(io)).toMatch(/EXEMPT\[src\/lib\/clean\.ts\] is stale/);
  });

  it("is empty today, and says why an entry would be legitimate", () => {
    // Non-vacuity on the REAL list: if it ever grows, the reason has to name a
    // consumer this guard cannot see, and this case is where that is stated.
    expect(EXEMPT).toEqual([]);
  });
});

describe("the matcher", () => {
  it("reads both declaration forms", () => {
    expect(exportedFunctionNames("export function a() {}\n")).toEqual(["a"]);
    expect(exportedFunctionNames("export async function b() {}\n")).toEqual(["b"]);
    expect(exportedFunctionNames("export const c = () => {};\n")).toEqual(["c"]);
    expect(exportedFunctionNames("export const d = async (x: number) => x;\n")).toEqual(["d"]);
  });

  it("leaves types, interfaces and non-function consts out of scope", () => {
    // Deliberately out of scope, and the reason is in the guard's header: a type
    // is erased at build time, and a const is as likely to be a table a consumer
    // indexes by name. Widening this is how the record would reach thousands.
    expect(exportedFunctionNames("export type T = string;\n")).toEqual([]);
    expect(exportedFunctionNames("export interface I { a: number }\n")).toEqual([]);
    expect(exportedFunctionNames("export const TABLE = { a: 1 };\n")).toEqual([]);
  });

  it("does not read a non-exported function, or one indented in a namespace", () => {
    expect(exportedFunctionNames("function private() {}\n")).toEqual([]);
    expect(exportedFunctionNames("  export function indented() {}\n")).toEqual([]);
  });

  it("counts a reference in another file and never the definer's own text", () => {
    const definer = ["src/lib/a.ts", "export function shared() {}\nconst k = shared;\n"];
    // The definer's own text is its declaration AND its internal call, and neither
    // is a caller. A guard that counted them would report nothing, ever.
    expect(isReferenced(mentionIndex([definer]), "shared", "src/lib/a.ts")).toBe(false);
    const withCaller = [definer, ["src/lib/b.ts", "import { shared } from './a';\n"]];
    expect(isReferenced(mentionIndex(withCaller), "shared", "src/lib/a.ts")).toBe(true);
  });

  it("does not match a longer identifier that merely contains the name", () => {
    const universe = [["src/lib/b.ts", "const sharedThing = 1;\n"]];
    expect(isReferenced(mentionIndex(universe), "shared", "src/lib/a.ts")).toBe(false);
  });

  it("counts a name mentioned only inside a STRING, which is the safe direction", () => {
    // Stated in the guard's header: a dead export reported live is a smaller failure
    // than a live export reported dead, so a string mention counts.
    const universe = [["src/lib/b.ts", 'const label = "shared";\n']];
    expect(isReferenced(mentionIndex(universe), "shared", "src/lib/a.ts")).toBe(true);
  });

  it("answers from two files, so a third mention cannot change the answer", () => {
    const index = mentionIndex([
      ["src/lib/a.ts", "export function k() {}\n"],
      ["src/lib/b.ts", "k();\n"],
      ["src/lib/c.ts", "k();\n"],
    ]);
    expect(index.get("k")).toEqual(["src/lib/a.ts", "src/lib/b.ts"]);
    expect(isReferenced(index, "k", "src/lib/a.ts")).toBe(true);
    expect(isReferenced(index, "k", "src/lib/b.ts")).toBe(true);
    expect(isReferenced(index, "k", "src/lib/c.ts")).toBe(true);
  });
});

describe("the committed record", () => {
  it("describes the tree it is checked in beside", () => {
    // The real file, read for real. A guard whose only cases are synthetic can be
    // perfectly green while the record it gates is empty or stale.
    const record = JSON.parse(readFileSync(RECORD_FILE, "utf8")) as Record<string, number>;
    const files = Object.keys(record);
    expect(files.length).toBeGreaterThan(0);
    for (const [file, count] of Object.entries(record)) {
      expect(count, `${file} must carry a positive count`).toBeGreaterThan(0);
      expect(isTestPath(file), `${file} is a test path and cannot be in the exporter record`).toBe(false);
    }
  });
});
