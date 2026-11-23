// @vitest-environment jsdom
//
// Where the selection band is allowed to paint (myne-md/myne#1062, symptom 3).
//
// CodeMirror's own layer stretches every row whose line break is selected to the
// content column's right edge, and collapses the rows in between into one
// full-width slab. The band is now built from these spans instead, so what the
// reader sees is decided here: it must stop at the last character of the line,
// never carry the line break, and never paint a line that holds no text.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { bandRanges, coversRange } from "@myne/editor/selection-band";

const state = (doc: string, from: number, to: number) =>
  EditorState.create({
    doc,
    selection: { anchor: from, head: to },
  });

const text = (doc: string, r: { from: number; to: number }) => doc.slice(r.from, r.to);

describe("bandRanges", () => {
  it("stops at the last character of an intermediate line, not the line end", () => {
    const doc = "alpha\nbeta\ngamma";
    // From mid "alpha" to mid "gamma": the middle line is wholly inside.
    const ranges = bandRanges(state(doc, 2, 14), 0, doc.length);
    expect(ranges.map((r) => text(doc, r))).toEqual(["pha", "beta", "gam"]);
  });

  it("never includes the line break", () => {
    const doc = "alpha\nbeta";
    const ranges = bandRanges(state(doc, 0, 10), 0, doc.length);
    expect(ranges.map((r) => doc.slice(r.from, r.to))).toEqual(["alpha", "beta"]);
    expect(ranges.some((r) => doc.slice(r.from, r.to).includes("\n"))).toBe(false);
  });

  it("paints nothing for a line with no text", () => {
    // An empty line, and the line a block widget occupies: nothing to mark. A
    // selected image is the widget's own job (myne-md/myne#1063).
    const doc = "alpha\n\ngamma";
    const ranges = bandRanges(state(doc, 0, doc.length), 0, doc.length);
    expect(ranges.map((r) => text(doc, r))).toEqual(["alpha", "gamma"]);
  });

  it("paints nothing for a caret", () => {
    expect(bandRanges(state("alpha", 3, 3), 0, 5)).toEqual([]);
  });

  it("clips to the visible window, so a huge selection stays a small set", () => {
    const doc = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const ranges = bandRanges(state(doc, 0, doc.length), 100, 140);
    expect(ranges.length).toBeLessThanOrEqual(8);
    for (const r of ranges) {
      expect(r.from).toBeGreaterThanOrEqual(100);
      expect(r.to).toBeLessThanOrEqual(140);
    }
  });
});

describe("coversRange", () => {
  it("is true when a non-empty selection overlaps the range", () => {
    const state = EditorState.create({ doc: "alpha\nbeta", selection: { anchor: 1, head: 4 } });
    expect(coversRange(state.selection, 0, 6)).toBe(true);
    expect(coversRange(state.selection, 6, 10)).toBe(false);
  });

  it("is false for a caret inside the range", () => {
    // A caret paints no band, so it must not claim the widget either.
    const state = EditorState.create({ doc: "alpha", selection: { anchor: 2 } });
    expect(coversRange(state.selection, 0, 5)).toBe(false);
  });
});
