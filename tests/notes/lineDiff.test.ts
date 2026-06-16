// Pure line-diff (MYND-97, SYNC-10): LCS-based add/del/same tagging + the
// coarse over-cap fallback + the changed-line counter. No IPC, no jsdom.

import { describe, it, expect } from "vitest";
import { lineDiff, changedLineCount, type DiffLine } from "../../src/notes/lineDiff";

const tag = (d: DiffLine) => `${d.type}:${d.text}`;

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
