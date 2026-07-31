// Pure line-diff (MYND-97, SYNC-10): LCS-based add/del/same tagging + the
// coarse over-cap fallback + the changed-line counter. No IPC, no jsdom.

import { describe, it, expect } from "vitest";
import {
  lineDiff,
  diffWithSegments,
  changedLineCount,
  type DiffLine,
  type DiffSegment,
} from "../../src/dialect/diff";

const tag = (d: DiffLine) => `${d.type}:${d.text}`;
const segTag = (s: DiffSegment) => `${s.type}:${s.text}`;

describe("lineDiff", () => {
  it("identical text → every line is `same` (no add/del)", () => {
    const out = lineDiff("a\nb\nc", "a\nb\nc");
    expect(out.map(tag)).toEqual(["same:a", "same:b", "same:c"]);
    expect(changedLineCount(out)).toBe(0);
  });

  it("a single empty string compares as one same empty line", () => {
    // "".split("\n") === [""], so two empty texts are one identical empty line.
    expect(lineDiff("", "")).toEqual([{ type: "same", text: "" }]);
  });

  it("pure addition appended at the end", () => {
    const out = lineDiff("a", "a\nb");
    expect(out.map(tag)).toEqual(["same:a", "add:b"]);
    expect(changedLineCount(out)).toBe(1);
  });

  it("pure removal at the end", () => {
    const out = lineDiff("a\nb", "a");
    expect(out.map(tag)).toEqual(["same:a", "del:b"]);
    expect(changedLineCount(out)).toBe(1);
  });

  it("a changed middle line is a del followed by an add (not a `same`)", () => {
    const out = lineDiff("a\nb\nc", "a\nB\nc");
    expect(out.map(tag)).toEqual(["same:a", "del:b", "add:B", "same:c"]);
    expect(changedLineCount(out)).toBe(2);
  });

  it("everything replaced (no common subsequence) → all dels then all adds", () => {
    const out = lineDiff("x\ny", "p\nq");
    // del side is emitted before the add side when nothing matches.
    expect(out.map(tag)).toEqual(["del:x", "del:y", "add:p", "add:q"]);
  });

  it("inserting a block in the middle keeps the surrounding lines `same`", () => {
    const out = lineDiff("a\nc", "a\nb\nc");
    expect(out.map(tag)).toEqual(["same:a", "add:b", "same:c"]);
  });

  it("treats whitespace-only differences as a real change (no trimming)", () => {
    const out = lineDiff("a", "a ");
    // "a" !== "a " — the diff is byte-exact, so this is a del + add, not same.
    expect(out.map(tag)).toEqual(["del:a", "add:a "]);
  });

  it("a moved line resolves to a del + add pair, never a phantom `same`", () => {
    // a\nb → b\na : the LCS is one line (either a or b); the other moves.
    const out = lineDiff("a\nb", "b\na");
    expect(out.filter((d) => d.type === "same").length).toBe(1);
    expect(changedLineCount(out)).toBe(2);
    // Output must be reconstructable: dropping adds yields the old text,
    // dropping dels yields the new text.
    expect(out.filter((d) => d.type !== "add").map((d) => d.text)).toEqual(["a", "b"]);
    expect(out.filter((d) => d.type !== "del").map((d) => d.text)).toEqual(["b", "a"]);
  });

  it("over the LCS line cap → coarse fallback (whole old del, whole new add)", () => {
    const old = Array.from({ length: 5001 }, (_, i) => `o${i}`).join("\n");
    const neu = "n0\nn1";
    const out = lineDiff(old, neu);
    // No `same` lines at all in the coarse path, even though no line repeats.
    expect(out.some((d) => d.type === "same")).toBe(false);
    expect(out.filter((d) => d.type === "del").length).toBe(5001);
    expect(out.filter((d) => d.type === "add").length).toBe(2);
    // del block precedes add block.
    expect(out[0]).toEqual({ type: "del", text: "o0" });
    expect(out[out.length - 1]).toEqual({ type: "add", text: "n1" });
  });

  it("changedLineCount ignores `same`, counts add+del", () => {
    const diff: DiffLine[] = [
      { type: "same", text: "x" },
      { type: "add", text: "y" },
      { type: "del", text: "z" },
      { type: "add", text: "w" },
    ];
    expect(changedLineCount(diff)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Word-level intra-line refinement (MYND-334 task 2).
// ---------------------------------------------------------------------------

/** `segments` only exists on the add/del arms of the union. */
const segs = (d: DiffLine): DiffSegment[] | undefined =>
  "segments" in d ? d.segments : undefined;

describe("diffWithSegments", () => {
  it("line-level output is identical to lineDiff (task-1 consumers unaffected)", () => {
    const old = "a\nb\nc\nlong line here";
    const neu = "a\nB\nc\nlong line there";
    expect(diffWithSegments(old, neu).map(tag)).toEqual(lineDiff(old, neu).map(tag));
  });

  it("lineDiff itself never attaches segments (no breaking change)", () => {
    expect(lineDiff("the quick fox", "the slow fox").every((d) => segs(d) === undefined)).toBe(
      true,
    );
  });

  it("`same` lines carry no segments", () => {
    const out = diffWithSegments("keep\nold", "keep\nnew");
    expect(segs(out[0])).toBeUndefined();
  });

  it("a one-word change yields same/del/same and same/add/same, not a whole-line swap", () => {
    const out = diffWithSegments("the quick brown fox", "the slow brown fox");
    expect(out.map((d) => d.type)).toEqual(["del", "add"]);
    expect(segs(out[0])!.map(segTag)).toEqual([
      "same:the ",
      "del:quick",
      "same: brown fox",
    ]);
    expect(segs(out[1])!.map(segTag)).toEqual([
      "same:the ",
      "add:slow",
      "same: brown fox",
    ]);
  });

  it("every line's segments concatenate back to that line's text", () => {
    const out = diffWithSegments(
      "# Title\nalpha beta gamma\ntrailing",
      "# Title\nalpha BETA gamma delta\ntrailing",
    );
    for (const d of out) {
      const s = segs(d);
      if (s) expect(s.map((x) => x.text).join("")).toBe(d.text);
    }
  });

  it("a del line's segments never contain `add` (and vice versa)", () => {
    const out = diffWithSegments("one two three", "one four three");
    expect(segs(out[0])!.some((s) => s.type === "add")).toBe(false);
    expect(segs(out[1])!.some((s) => s.type === "del")).toBe(false);
  });

  it("a fully-replaced line yields a single del and a single add segment", () => {
    // "alpha beta" / "gamma delta" share only the space token — a whitespace-only
    // overlap is not a meaningful match, so the whole line reads as replaced.
    const out = diffWithSegments("alpha beta", "gamma delta");
    expect(segs(out[0])!.map(segTag)).toEqual(["del:alpha beta"]);
    expect(segs(out[1])!.map(segTag)).toEqual(["add:gamma delta"]);
  });

  it("punctuation is its own token, so `word,` → `word.` highlights just the mark", () => {
    const out = diffWithSegments("hello, world", "hello. world");
    expect(segs(out[0])!.map(segTag)).toEqual(["same:hello", "del:,", "same: world"]);
    expect(segs(out[1])!.map(segTag)).toEqual(["same:hello", "add:.", "same: world"]);
  });

  it("only del/add lines in an adjacent run are paired; the surplus carries no segments", () => {
    // Two removed lines, one added line → the first pairs, the second does not.
    const out = diffWithSegments("one two\nthree four\nkeep", "one 2\nkeep");
    const dels = out.filter((d) => d.type === "del");
    const adds = out.filter((d) => d.type === "add");
    expect(dels.length).toBe(2);
    expect(adds.length).toBe(1);
    expect(segs(dels[0])).toBeDefined();
    expect(segs(dels[1])).toBeUndefined();
  });

  it("an empty line on either side of a pair is left unrefined", () => {
    const out = diffWithSegments("", "added text");
    expect(out.every((d) => segs(d) === undefined)).toBe(true);
  });

  it("a pathologically long line falls back coarsely (no segments, no LCS table)", () => {
    const long = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(" ");
    const longer = `${long} tail`;
    const out = diffWithSegments(long, longer);
    expect(out.map((d) => d.type)).toEqual(["del", "add"]);
    expect(out.every((d) => segs(d) === undefined)).toBe(true);
  });

  it("the coarse LINE-cap fallback carries no segments at all", () => {
    const old = Array.from({ length: 5001 }, (_, i) => `o${i}`).join("\n");
    const out = diffWithSegments(old, "o0 changed\no1 changed");
    expect(out.every((d) => segs(d) === undefined)).toBe(true);
    expect(out.filter((d) => d.type === "del").length).toBe(5001);
  });

  it("changedLineCount is unaffected by refinement", () => {
    const old = "a\nb c\nd";
    const neu = "a\nb C\nd";
    expect(changedLineCount(diffWithSegments(old, neu))).toBe(
      changedLineCount(lineDiff(old, neu)),
    );
  });
});
