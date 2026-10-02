// Unit tests for the `.base` import entry point (Saved Views #6, MYND-276,
// task 6): map → persist → summary over injected deps (no IPC). Verifies views
// persist via the injected prefs path, the summary tally, and a clean persist
// failure (MYP1 cap) with no swallow.

import { describe, expect, it, vi } from "vitest";
import {
  BaseImportPersistError,
  importBaseSource,
  runBaseImport,
} from "../../../src/notes/import/base/importBase";
import type { SavedView } from "../../../src/lib/prefs";

const makeId = (() => {
  let n = 0;
  return () => `v${++n}`;
})();

const SOURCE = `
formulas:
  pricePerDay: x / y
views:
  - type: cards
    name: Books
    filters:
      and:
        - file.inFolder("Books")
  - type: cards
    name: Movies
    filters:
      and:
        - file.inFolder("Movies")
  - type: map
    name: Skipped
`;

describe("runBaseImport / importBaseSource", () => {
  it("persists every surviving view via the injected prefs path", async () => {
    const persisted: SavedView[] = [];
    const summary = await importBaseSource(SOURCE, {
      persistView: async (v) => void persisted.push(v),
      makeId: (() => {
        let n = 0;
        return () => `id${++n}`;
      })(),
    });
    expect(persisted.map((v) => v.name)).toEqual(["Books", "Movies"]); // map skipped
    expect(persisted.every((v) => v.view_type === "cards")).toBe(true);
    expect(summary.importedViews).toBe(2);
    expect(summary.skippedViews).toBe(1); // the map view
    expect(summary.droppedFormulas).toBe(1);
  });

  it("returns a tally that matches what was persisted", async () => {
    const persist = vi.fn(async () => {});
    const summary = await importBaseSource(SOURCE, { persistView: persist, makeId });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(summary.importedViews).toBe(2);
  });

  it("wraps a persist failure (MYP1 cap) in BaseImportPersistError, no swallow", async () => {
    const persistView = (() => {
      let c = 0;
      return async () => {
        c++;
        if (c === 2) throw new Error("prefs blob exceeds 64 KiB cap");
      };
    })();
    // `.then(ok, err)` rather than a `catch` inside the test body: a
    // non-throwing implementation would resolve, `err` would not be an
    // instance, and this fails. The old second half read `persistedCount` only
    // inside a catch block, so a resolving implementation never consulted it.
    const err = await importBaseSource(SOURCE, { persistView, makeId }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BaseImportPersistError);
    // The first view persisted before the cap hit (partial-import model).
    expect((err as BaseImportPersistError).persistedCount).toBe(1);
  });

  it("runBaseImport over a parsed-empty .base persists nothing, zero tally", async () => {
    const persist = vi.fn(async () => {});
    const summary = await runBaseImport(
      { views: [] },
      { persistView: persist, makeId },
    );
    expect(persist).not.toHaveBeenCalled();
    expect(summary.importedViews).toBe(0);
  });
});
