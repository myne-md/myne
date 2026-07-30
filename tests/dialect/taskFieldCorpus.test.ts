// Fixture corpus and byte-stability (MYND-611, task 4).
//
// Two guarantees, both about files Myne did not write:
//
//   1. An imported file that is never edited comes back byte-identical. The
//      recognizer emits nodes and touches no bytes (§6 C1), so recognition alone
//      can never rewrite a user's vault.
//   2. Nothing in the corpus throws. Malformed values surface as unparsed rather
//      than as exceptions — an imported vault must not be able to crash the parser.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parser } from "../../src/dialect/lezer/parser";
import { parse } from "../../src/dialect/parse";
import { parseTaskFields } from "../../src/dialect/taskFields";
import { planTaskFieldWrite } from "../../src/dialect/taskFieldWriter";
import { fixtureDir } from "./_helpers";

const CORPUS = [
  "emoji-dialect.md",
  "dataview-dialect.md",
  "myne-dialect.md",
  "mixed-dialects.md",
  "unsupported-and-malformed.md",
];

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixtureDir("task-fields"), name), "utf-8");
}

/** Task lines of a fixture — the lines a consumer would feed the field parser. */
function taskLines(source: string): string[] {
  return source.split("\n").filter((l) => /^\s*[-*+]\s+\[[ xX]\]/.test(l));
}

describe("corpus covers all three dialects and mixed files", () => {
  it("every fixture exists and carries task lines", () => {
    for (const name of CORPUS) {
      expect(taskLines(readFixture(name)).length).toBeGreaterThan(0);
    }
  });

  it("the three single-dialect fixtures express the same task identically", () => {
    const pick = (name: string, needle: string) =>
      parseTaskFields(taskLines(readFixture(name)).find((l) => l.includes(needle))!);

    const emoji = pick("emoji-dialect.md", "pay the rent");
    const dataview = pick("dataview-dialect.md", "pay the rent");
    const myne = pick("myne-dialect.md", "pay the rent");

    expect(emoji.due).toEqual({ date: "2026-08-01" });
    expect(dataview).toEqual(emoji);
    expect(myne).toEqual(emoji);
  });

  it("reads a completion date from all three dialects", () => {
    const pick = (name: string) =>
      parseTaskFields(taskLines(readFixture(name)).find((l) => l.includes("ship the release"))!);
    expect(pick("emoji-dialect.md").done).toEqual({ date: "2026-07-27" });
    expect(pick("dataview-dialect.md").done).toEqual({ date: "2026-07-27" });
    expect(pick("myne-dialect.md").done).toEqual({ date: "2026-07-27" });
  });

  it("reads both dialects off a single line in the mixed fixture", () => {
    const line = taskLines(readFixture("mixed-dialects.md")).find((l) =>
      l.includes("one of each"),
    )!;
    const r = parseTaskFields(line);
    expect(r.due).toEqual({ date: "2026-08-01" });
    expect(r.priority).toBe("high");
  });
});

describe("an untouched imported file round-trips byte-identically", () => {
  it("parsing changes nothing, for every fixture", () => {
    for (const name of CORPUS) {
      const source = readFixture(name);
      const tree = parser.parse(source);
      expect(tree.length).toBe(source.length);
      // `parse()` is a read; it returns data, never bytes. The guarantee is that
      // no code path here has an opportunity to rewrite the source.
      expect(() => parse(source)).not.toThrow();
    }
  });

  it("the writer proposes no edit for a line already in Myne's form", () => {
    for (const line of taskLines(readFixture("myne-dialect.md"))) {
      const current = parseTaskFields(line);
      // A line Myne itself would have written must be a fixed point: re-writing
      // it produces no change, so opening a vault cannot dirty every task line.
      expect(planTaskFieldWrite(line, current)).toBeNull();
    }
  });

  it("the extended Obsidian-shaped fixture still round-trips", () => {
    const source = fs.readFileSync(
      path.join(fixtureDir("integration"), "obsidian-export.md"),
      "utf-8",
    );
    expect(parser.parse(source).length).toBe(source.length);
    expect(() => parse(source)).not.toThrow();
  });
});

describe("malformed values surface as unparsed, never as exceptions", () => {
  const source = readFixture("unsupported-and-malformed.md");

  it("no line in the malformed fixture throws", () => {
    for (const line of taskLines(source)) {
      expect(() => parseTaskFields(line)).not.toThrow();
    }
  });

  it("every refused due value lands in malformed rather than typed", () => {
    const refusals = [
      "half-written date",
      "impossible date",
      "out-of-range time",
      "a Z offset",
      "a numeric offset",
    ];
    for (const needle of refusals) {
      const line = taskLines(source).find((l) => l.includes(needle))!;
      const r = parseTaskFields(line);
      expect(r.due, `"${needle}" must not type`).toBeUndefined();
      expect(r.malformed.map((f) => f.key)).toContain("due");
    }
  });

  it("unsupported keys are preserved, and onCompletion carries no meaning", () => {
    const line = taskLines(source).find((l) => l.includes("obsidian's other keys"))!;
    expect(parseTaskFields(line).preserved.map((f) => f.key)).toEqual([
      "scheduled",
      "start",
      "cancelled",
      "created",
      "id",
      "dependsOn",
    ]);

    const action = taskLines(source).find((l) => l.includes("never runs"))!;
    const r = parseTaskFields(action) as Record<string, unknown>;
    expect(r.onCompletion).toBeUndefined();
    expect(parseTaskFields(action).preserved[0]).toMatchObject({ key: "onCompletion" });
  });

  it("code spans and fences produce no fields", () => {
    const inCode = taskLines(source).find((l) => l.includes("inside a code span"))!;
    expect(parseTaskFields(inCode)).toEqual({ preserved: [], malformed: [] });

    // The fenced block is not a task line, so check it through the whole file.
    const fields: string[] = [];
    parser.parse(source).iterate({
      enter: (n) => {
        if (n.name === "TaskField") fields.push(source.slice(n.from, n.to));
      },
    });
    expect(fields.join("\n")).not.toContain("2026-08-02");
  });
});

describe("uppercase [X] markers survive untouched", () => {
  it("parses fields on an uppercase-marker line", () => {
    const line = taskLines(readFixture("mixed-dialects.md")).find((l) =>
      l.includes("uppercase marker with fields"),
    )!;
    expect(line).toContain("[X]");
    const r = parseTaskFields(line);
    expect(r.due).toEqual({ date: "2026-07-30" });
    expect(r.priority).toBe("medium");
  });

  it("a write to such a line leaves the uppercase marker alone", () => {
    const line = taskLines(readFixture("mixed-dialects.md")).find((l) =>
      l.includes("uppercase marker with fields"),
    )!;
    const current = parseTaskFields(line);
    const edit = planTaskFieldWrite(line, { ...current, priority: "low" })!;
    const out = line.slice(0, edit.range.start) + edit.text + line.slice(edit.range.end);
    expect(out).toContain("- [X]");
    expect(out).toContain("[priority:: low]");
  });
});
