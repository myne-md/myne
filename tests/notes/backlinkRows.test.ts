// Backlinks-panel view-model: count + alphabetical + self-link hidden + untitled
// last (knowledge-graph-ux #1, grill Q1 occurrence-depth = count, Q self-link = hide).

import { describe, expect, it } from "vitest";

import {
  backlinkRows,
  backlinkRowsEqual,
  type BacklinkRow,
} from "../../src/notes/backlinkRows";
import type { BacklinkGroup } from "../../src/notes/vaultIndices";

function group(
  sourceUuid: string,
  sourceTitle: string | null,
  n: number,
): BacklinkGroup {
  return {
    sourceUuid,
    sourceTitle,
    // Occurrence shape is irrelevant to the row count; length is all that matters.
    occurrences: Array.from({ length: n }, () => ({}) as never),
  };
}

describe("backlinkRows", () => {
  it("carries the occurrence count per source", () => {
    const rows = backlinkRows([group("a", "Alpha", 3)], "open");
    expect(rows).toEqual([{ sourceUuid: "a", sourceTitle: "Alpha", count: 3 }]);
  });

  it("hides the open note's self-link", () => {
    const rows = backlinkRows(
      [group("open", "Self", 2), group("a", "Alpha", 1)],
      "open",
    );
    expect(rows.map((r) => r.sourceUuid)).toEqual(["a"]);
  });

  it("sorts alphabetically by source title (case-insensitive collation)", () => {
    const rows = backlinkRows(
      [group("c", "Charlie", 1), group("a", "alpha", 1), group("b", "Bravo", 1)],
      "open",
    );
    expect(rows.map((r) => r.sourceTitle)).toEqual(["alpha", "Bravo", "Charlie"]);
  });

  it("sorts untitled (null) sources last", () => {
    const rows = backlinkRows(
      [group("u", null, 1), group("a", "Alpha", 1)],
      "open",
    );
    expect(rows.map((r) => r.sourceTitle)).toEqual(["Alpha", null]);
  });
});

describe("backlinkRowsEqual (SYNC-5 reference-equal bail)", () => {
  const row = (uuid: string, title: string | null, count: number): BacklinkRow => ({
    sourceUuid: uuid,
    sourceTitle: title,
    count,
  });

  it("is true for value-equal lists in the same order", () => {
    expect(
      backlinkRowsEqual(
        [row("a", "Alpha", 2), row("b", "Bravo", 1)],
        [row("a", "Alpha", 2), row("b", "Bravo", 1)],
      ),
    ).toBe(true);
  });

  it("is false when a count changes", () => {
    expect(
      backlinkRowsEqual([row("a", "Alpha", 1)], [row("a", "Alpha", 2)]),
    ).toBe(false);
  });

  it("is false when length or membership differs", () => {
    expect(backlinkRowsEqual([row("a", "Alpha", 1)], [])).toBe(false);
    expect(
      backlinkRowsEqual([row("a", "Alpha", 1)], [row("b", "Alpha", 1)]),
    ).toBe(false);
  });

  it("is false when order differs", () => {
    expect(
      backlinkRowsEqual(
        [row("a", "Alpha", 1), row("b", "Bravo", 1)],
        [row("b", "Bravo", 1), row("a", "Alpha", 1)],
      ),
    ).toBe(false);
  });
});
