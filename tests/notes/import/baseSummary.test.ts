// Unit tests for the `.base` import summary tally (Saved Views #6, MYND-276,
// task 5). Folds adapter warnings + surviving-view count into the shared
// `BaseImportTally` sub-field of the importer DTO.

import { describe, expect, it } from "vitest";
import { tallyBaseImport } from "../../../src/notes/import/base/baseSummary";
import { mapParsedBase } from "../../../src/notes/import/base/mapBase";
import type { BaseImportWarning } from "../../../src/notes/import/base/mapBase";

describe("tallyBaseImport", () => {
  it("counts skipped views (unsupported type + entire-filter-drop) and dropped clauses", () => {
    const warnings: BaseImportWarning[] = [
      { kind: "unsupported-view-type", detail: "map" },
      { kind: "view-skipped-empty-filter", detail: "AllDropped" },
      { kind: "unsupported-clause", detail: "list.map(x => x)" },
      { kind: "unsupported-clause", detail: 'file.mtime > "2026"' },
      { kind: "dropped-formulas", detail: "2" },
      { kind: "dropped-summaries", detail: "1" },
      { kind: "dropped-properties-display", detail: "3" },
    ];
    expect(tallyBaseImport(4, warnings)).toEqual({
      importedViews: 4,
      skippedViews: 2,
      droppedUnsupportedFilters: 2,
      droppedFormulas: 2,
      droppedSummaries: 1,
      droppedPropertiesDisplay: 3,
    });
  });

  it("is all-zero (besides importedViews) for a clean import", () => {
    expect(tallyBaseImport(3, [])).toEqual({
      importedViews: 3,
      skippedViews: 0,
      droppedUnsupportedFilters: 0,
      droppedFormulas: 0,
      droppedSummaries: 0,
      droppedPropertiesDisplay: 0,
    });
  });

  it("populates every field from a mixed mapParsedBase result (end-to-end)", () => {
    const { views, warnings } = mapParsedBase(
      {
        formulas: { a: "x", b: "y" },
        summaries: { s: "sum" },
        views: [
          { type: "cards", name: "Good", filters: { and: ['file.inFolder("X")'] } },
          { type: "map", name: "MapSkip" },
          {
            type: "table",
            name: "AllDropped",
            filters: { and: ["list.map(x => x)"] },
          },
          {
            type: "cards",
            name: "PartialDrop",
            filters: { and: ['file.inFolder("Y")', 'file.mtime > "2026"'] },
          },
        ],
      },
      () => "id",
    );
    const tally = tallyBaseImport(views.length, warnings);
    expect(tally.importedViews).toBe(2); // Good + PartialDrop survive
    expect(tally.skippedViews).toBe(2); // MapSkip + AllDropped
    expect(tally.droppedUnsupportedFilters).toBe(2); // list.map + file.mtime
    expect(tally.droppedFormulas).toBe(2);
    expect(tally.droppedSummaries).toBe(1);
  });
});
