// `.base` import summary tally (Saved Views #6, MYND-276, task 5).
//
// Folds the structured `BaseImportWarning[]` from the adapter (`mapParsedBase`)
// plus the surviving view count into the shared importer DTO's `.base` sub-tally
// (`BaseImportTally` in engine.ts). One shared shape — no parallel model. This
// is the surface #4's trigger UI reads to show what came across and what didn't.

import type { BaseImportTally } from "../engine";
import type { BaseImportWarning } from "./mapBase";

/** Sum the numeric `detail` of every warning of `kind` (the section-drop
 *  warnings carry a count string; a non-numeric detail counts as 0). */
function sumDetail(warnings: ReadonlyArray<BaseImportWarning>, kind: string): number {
  let total = 0;
  for (const w of warnings) {
    if (w.kind !== kind) continue;
    const n = Number.parseInt(w.detail, 10);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

/** Count the warnings of `kind`. */
function countKind(warnings: ReadonlyArray<BaseImportWarning>, kind: string): number {
  return warnings.reduce((n, w) => (w.kind === kind ? n + 1 : n), 0);
}

/**
 * Build the {@link BaseImportTally} from the adapter's warnings + the count of
 * surviving (mapped) views. Skipped views = unsupported-view-type (e.g. `map`)
 * PLUS entire-filter-drop skips (SYNC-12). Dropped filter clauses = the
 * per-clause `unsupported-clause` warnings (SYNC-7/9). The section drops sum
 * their counted `detail`.
 */
export function tallyBaseImport(
  importedViews: number,
  warnings: ReadonlyArray<BaseImportWarning>,
): BaseImportTally {
  return {
    importedViews,
    skippedViews:
      countKind(warnings, "unsupported-view-type") +
      countKind(warnings, "view-skipped-empty-filter"),
    droppedUnsupportedFilters: countKind(warnings, "unsupported-clause"),
    droppedFormulas: sumDetail(warnings, "dropped-formulas"),
    droppedSummaries: sumDetail(warnings, "dropped-summaries"),
    droppedPropertiesDisplay: sumDetail(warnings, "dropped-properties-display"),
  };
}
