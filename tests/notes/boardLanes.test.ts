// @vitest-environment jsdom
//
// The board's lane derivation (myne-md/myne#922 task 4). Pure function, so the
// three rules the feature turns on are asserted directly: the declared order
// wins, an undeclared data value is appended rather than hidden, and a declared
// lane with no cards still comes back (it is the drop target that has to exist
// before anything is dropped into it).

import { describe, expect, it } from "vitest";
import { deriveLanes } from "../../src/notes/views/lanes";
import type { ViewRow } from "../../src/notes/queryEngine";

function row(noteId: string, title = noteId): ViewRow {
  return { noteId, title, folder: null, values: {} };
}

describe("deriveLanes", () => {
  it("puts declared lanes first, in the declared order", () => {
    const lanes = deriveLanes(
      [
        { key: "Done", rows: [row("d1")] },
        { key: "Backlog", rows: [row("b1"), row("b2")] },
        { key: "Doing", rows: [row("g1")] },
      ],
      ["Backlog", "Doing", "Done"],
    );
    expect(lanes.map((lane) => lane.value)).toEqual(["Backlog", "Doing", "Done"]);
    expect(lanes.map((lane) => lane.rows.length)).toEqual([2, 1, 1]);
  });

  it("appends a data value the declaration omits, in first-appearance order", () => {
    // A status somebody added on another device must show its cards rather than
    // vanish because this view's declaration has not caught up.
    const lanes = deriveLanes(
      [
        { key: "Doing", rows: [row("g1")] },
        { key: "New", rows: [row("n1")] },
        { key: "Blocked", rows: [row("x1")] },
      ],
      ["Doing"],
    );
    expect(lanes.map((lane) => lane.value)).toEqual(["Doing", "New", "Blocked"]);
  });

  it("keeps a declared lane that no card carries, with no rows", () => {
    // "Drop a card into Done" before anything is done is the reason a board
    // exists; an empty declared lane disappearing would remove that target.
    const lanes = deriveLanes([{ key: "Doing", rows: [row("g1")] }], [
      "Backlog",
      "Doing",
      "Done",
    ]);
    expect(lanes.map((lane) => lane.value)).toEqual(["Backlog", "Doing", "Done"]);
    expect(lanes[0]!.rows).toEqual([]);
    expect(lanes[2]!.rows).toEqual([]);
  });

  it("collapses a repeated declared value to its first position", () => {
    // The FORMAT preserves a repeated value verbatim (`lanes` is a sequence and
    // never deduplicated); a renderer that drew the same lane twice would be two
    // views of one value.
    const lanes = deriveLanes([{ key: "Doing", rows: [row("g1")] }], [
      "Doing",
      "Done",
      "Doing",
    ]);
    expect(lanes.map((lane) => lane.value)).toEqual(["Doing", "Done"]);
    expect(lanes[0]!.rows).toHaveLength(1);
  });

  it("collapses a duplicate note within one lane and never across lanes", () => {
    const lanes = deriveLanes(
      [
        { key: "epic", rows: [row("n1"), row("n1")] },
        { key: "desert", rows: [row("n1")] },
      ],
      [],
    );
    expect(lanes.map((lane) => lane.value)).toEqual(["epic", "desert"]);
    expect(lanes[0]!.rows.map((r) => r.noteId)).toEqual(["n1"]);
    expect(lanes[1]!.rows.map((r) => r.noteId)).toEqual(["n1"]);
  });

  it("derives one lane from the single ungrouped group", () => {
    // `group_by` unset: the engine hands over one group keyed "", which is a
    // lane like any other rather than a hidden bucket. The renderer states the
    // missing setting separately.
    const lanes = deriveLanes([{ key: "", rows: [row("a"), row("b")] }], []);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.value).toBe("");
    expect(lanes[0]!.rows).toHaveLength(2);
  });

  it("returns nothing for no groups, so the renderer can state the empty case", () => {
    expect(deriveLanes([], ["Backlog", "Done"])).toEqual([
      { value: "Backlog", rows: [] },
      { value: "Done", rows: [] },
    ]);
    expect(deriveLanes([], [])).toEqual([]);
  });
});
