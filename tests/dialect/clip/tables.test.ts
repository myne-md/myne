// Clip serializer — task 3 (capture-extraction): the fidelity-floor table
// construct (§5 "Tables: pipe-delimited with `|---|` alignment row …";
// PRD fidelity floor = faithful tables/code/math).
//
// A `Table` node emits as a faithful canonical GFM pipe table — header row, an
// alignment/delimiter row derived from the parsed per-column alignments, then
// body rows — REUSING the canonical single-space-padded serialization the
// editable-table precedent pins (`src/editor/decorations/table-model.ts`'s
// `serializeTable` / `parseDelimiterAlign` / `splitTableRow` / `fitRow`), so the
// clip serializer and the editor agree byte-for-byte on the canonical form. The
// emit is single-space padded (`| a | b |`), NOT re-padded to content width.
//
// Round-trip target is the canonical equivalent (the parser already drops
// content-width padding into the same `Table` shape), so already-canonical
// tables hold `assertCanonicalD1`; a content-width-padded source normalizes to
// the single-space canonical form (asserted via the rig's lower-level `shapeOf`
// + `serializeClipMarkdown`, without touching `_rig.ts`'s signature).

import { describe, expect, it } from "vitest";
import { serializeClipMarkdown } from "../../../src/dialect/clip";
import { serializeTable } from "../../../src/editor/decorations/table-model";
import { assertCanonicalD1, assertIdempotent, shapeOf } from "./_rig";

describe("clip serializer — faithful GFM tables", () => {
  it("round-trips an N×M data table (same columns, rows, cell text)", () => {
    const input = [
      "| h1 | h2 | h3 |",
      "| --- | --- | --- |",
      "| a | b | c |",
      "| d | e | f |",
      "",
    ].join("\n");
    const emitted = assertCanonicalD1(input);
    expect(emitted).toBe(
      ["| h1 | h2 | h3 |", "| --- | --- | --- |", "| a | b | c |", "| d | e | f |"].join("\n"),
    );
  });

  it("preserves every per-column alignment on emit (`:---`/`:---:`/`---:`/`---`)", () => {
    const input = [
      "| left | center | right | default |",
      "| :--- | :---: | ---: | --- |",
      "| 1 | 2 | 3 | 4 |",
      "",
    ].join("\n");
    const emitted = assertCanonicalD1(input);
    expect(emitted).toBe(
      [
        "| left | center | right | default |",
        "| :--- | :---: | ---: | --- |",
        "| 1 | 2 | 3 | 4 |",
      ].join("\n"),
    );
    // The delimiter row carries each alignment token verbatim.
    expect(emitted.split("\n")[1]).toBe("| :--- | :---: | ---: | --- |");
  });

  it("escapes a pipe inside cell content so the emitted table re-parses identically", () => {
    const input = ["| a | b |", "| --- | --- |", "| x \\| y | z |", ""].join("\n");
    const emitted = assertCanonicalD1(input);
    // The literal pipe in cell `x | y` stays escaped (`\|`) so it does not
    // forge a new column on re-parse.
    expect(emitted).toBe(
      ["| a | b |", "| --- | --- |", "| x \\| y | z |"].join("\n"),
    );
  });

  it("reuses the canonical single-space padding (not a content-width re-pad)", () => {
    // A content-width-padded source normalizes to the single-space canonical
    // form — byte-identical to what `table-model.ts::serializeTable` produces.
    const input = [
      "| name    | role      |",
      "| :------ | --------: |",
      "| Ada     | pioneer   |",
      "",
    ].join("\n");
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe(
      ["| name | role |", "| :--- | ---: |", "| Ada | pioneer |"].join("\n"),
    );
    // The exact bytes the editor's table model would emit for the same grid.
    expect(emitted).toBe(
      serializeTable({
        align: ["left", "right"],
        rows: [
          ["name", "role"],
          ["Ada", "pioneer"],
        ],
      }),
    );
    // Re-parses to the same table shape.
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("emits inline emphasis inside a header cell faithfully", () => {
    const input = ["| *a* | **b** |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    const emitted = assertCanonicalD1(input);
    expect(emitted).toBe(
      ["| *a* | **b** |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
    );
  });

  it("fits a short body row to the column count (missing cells empty)", () => {
    const input = ["| a | b | c |", "| --- | --- | --- |", "| 1 | 2 |", ""].join("\n");
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe(
      ["| a | b | c |", "| --- | --- | --- |", "| 1 | 2 |  |"].join("\n"),
    );
    expect(shapeOf(emitted)).toBe(shapeOf(emitted + "\n"));
  });

  it("is idempotent through table emission", () => {
    const input = [
      "| h |",
      "| :---: |",
      "| only |",
      "",
    ].join("\n");
    const emitted = assertIdempotent(input);
    expect(emitted).toBe(["| h |", "| :---: |", "| only |"].join("\n"));
  });

  it("round-trips a table embedded in a multi-construct clip", () => {
    const input = [
      "## Data",
      "",
      "| metric | value |",
      "| :--- | ---: |",
      "| count | 42 |",
      "",
      "Trailing paragraph.",
      "",
    ].join("\n");
    assertCanonicalD1(input);
  });
});
