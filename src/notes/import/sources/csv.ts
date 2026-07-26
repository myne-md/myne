// CSV import source (importer-breadth epic, MYND-584).
//
// One picked `.csv` file → ONE note holding a GFM table. See `csv/toTable.ts` for
// why it is not one note per row (the `vision.md` no-databases commitment).
//
// The simplest of the four adapters, and the one that shows the seam's shape most
// plainly: a source with a single item and no directory structure at all.

import { csvToTableMarkdown } from "../csv/toTable";
import { emptyIgnoreCounts } from "../skipPredicate";
import type {
  ImportPlan,
  ImportPorts,
  ImportSource,
  LoadedItem,
} from "../source";

/** The note title derived from a picked file path (basename, extension dropped). */
export function csvNoteTitle(absPath: string): string {
  const base = absPath.split(/[/\\]/).pop() ?? absPath;
  return base.replace(/\.csv$/i, "");
}

/**
 * An `ImportSource` over one picked `.csv` file.
 *
 * `plan()` reads nothing — a single-file source knows its item count is 1 without
 * touching content, so `total` is determinate and the D3 rule is trivially held.
 */
export function createCsvSource(absPath: string, ports: ImportPorts): ImportSource {
  return {
    id: "csv",

    async plan(): Promise<ImportPlan> {
      return {
        items: [{ relPath: `${csvNoteTitle(absPath)}.md` }],
        dirs: [],
        ignore: emptyIgnoreCounts(),
      };
    },

    async load(): Promise<LoadedItem> {
      // The picked file IS the root here, so the read-seam's within-root check is
      // satisfied by passing it as both arguments.
      const text = await ports.readFile(absPath);
      const { markdown, lossy } = csvToTableMarkdown(text);
      return { markdown, lossy };
    },
  };
}
