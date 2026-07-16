// Unit tests for the shared saved-view layout helpers (MYND-277/278) — pure, no
// React/DOM. Covers within-group dedupe + cross-group fan-out, the group stream
// shape, the cover-image column exclusion, and the table grid geometry.

import { describe, expect, it } from "vitest";
import {
  TABLE_COL_MIN,
  TABLE_NAME_MIN,
  buildViewStream,
  dedupeRowsByNote,
  displayColumns,
  tableGridTemplate,
} from "../../src/notes/views/viewLayout";
import type { ViewResult, ViewRow } from "../../src/notes/queryEngine";

const row = (noteId: string, title: string | null = null): ViewRow => ({
  noteId,
  title,
  folder: null,
  values: {},
});

describe("dedupeRowsByNote", () => {
  it("keeps the first occurrence and preserves order", () => {
    const out = dedupeRowsByNote([row("a"), row("b"), row("a"), row("c")]);
    expect(out.map((r) => r.noteId)).toEqual(["a", "b", "c"]);
  });
  it("empty in → empty out", () => {
    expect(dedupeRowsByNote([])).toEqual([]);
  });
});

describe("buildViewStream", () => {
  it("emits one heading per group followed by its rows; total = deduped rows", () => {
    const result: ViewResult = {
      groups: [
        { key: "A", type: "string", rows: [row("n1"), row("n2")] },
        { key: "", type: "none", rows: [row("n3")] },
      ],
    };
    const { stream, total } = buildViewStream(result, "No value");
    expect(total).toBe(3);
    expect(stream.map((i) => i.kind)).toEqual([
      "heading",
      "row",
      "row",
      "heading",
      "row",
    ]);
    const headings = stream.filter((i) => i.kind === "heading");
    expect(headings[0]).toMatchObject({ label: "A", count: 2 });
    // the implicit empty-key group renders the calm no-value label
    expect(headings[1]).toMatchObject({ label: "No value", count: 1 });
  });

  it("dedupes WITHIN a group but preserves cross-group fan-out with unique keys", () => {
    const result: ViewResult = {
      groups: [
        { key: "A", type: "string", rows: [row("n1"), row("n1")] }, // dupe within A
        { key: "B", type: "string", rows: [row("n1")] }, // same note fanned into B
      ],
    };
    const { stream, total } = buildViewStream(result, "No value");
    expect(total).toBe(2); // A→1 (deduped) + B→1 (fan-out preserved)
    const rowKeys = stream.filter((i) => i.kind === "row").map((i) => i.key);
    expect(rowKeys).toEqual(["r:A:n1", "r:B:n1"]);
    expect(new Set(rowKeys).size).toBe(rowKeys.length); // all unique
  });
});

describe("displayColumns", () => {
  it("returns the columns unchanged when there is no cover image", () => {
    expect(displayColumns({ columns: ["a", "b"] })).toEqual(["a", "b"]);
  });
  it("excludes the cover-image column (matches cards)", () => {
    expect(
      displayColumns({ columns: ["a", "cover", "b"], image: "cover" }),
    ).toEqual(["a", "b"]);
  });
  it("no columns → []", () => {
    expect(displayColumns({})).toEqual([]);
  });
});

describe("tableGridTemplate", () => {
  it("0 columns → a single Name track; minWidth = nameMin", () => {
    const { template, minWidth } = tableGridTemplate(0);
    expect(template).toBe(`minmax(${TABLE_NAME_MIN}px, 1fr)`);
    expect(minWidth).toBe(TABLE_NAME_MIN);
  });
  it("N columns → Name track + N property tracks; minWidth = nameMin + N*colMin", () => {
    const { template, minWidth } = tableGridTemplate(3);
    expect(template).toBe(
      `minmax(${TABLE_NAME_MIN}px, 1.5fr) repeat(3, minmax(${TABLE_COL_MIN}px, 1fr))`,
    );
    expect(minWidth).toBe(TABLE_NAME_MIN + 3 * TABLE_COL_MIN);
  });
  it("honours nameMin/colMin overrides (mobile compact tuning)", () => {
    const { minWidth } = tableGridTemplate(2, { nameMin: 100, colMin: 50 });
    expect(minWidth).toBe(100 + 2 * 50);
  });
});
