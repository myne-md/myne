// Unit tests for the take-theirs prefs uuid-migration (MYND-452, task 1).
// Pure data transform — no IPC, no DOM. Covers: swap in favorites, swap in
// item_order preserving index, the no-op when the source uuid is absent, and the
// no-duplicate guarantee when the target already appears.

import { describe, expect, it } from "vitest";
import { migrateNoteUuidInPrefs } from "@myne/dialect/conflictMigratePrefs";

const ORIG = "11111111-1111-1111-1111-111111111111";
const COPY = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";

describe("migrateNoteUuidInPrefs", () => {
  it("swaps the source uuid to the target in favorites, preserving membership", () => {
    const r = migrateNoteUuidInPrefs(
      { favorites: [OTHER, ORIG], itemOrder: [] },
      ORIG,
      COPY,
    );
    expect(r.favorites).toEqual([OTHER, COPY]);
    expect(r.changed).toBe(true);
  });

  it("swaps the source uuid in item_order preserving its index, leaving folders untouched", () => {
    const r = migrateNoteUuidInPrefs(
      { favorites: [], itemOrder: [OTHER, "Projects/", ORIG, "Archive/"] },
      ORIG,
      COPY,
    );
    // Index 2 (ORIG) becomes COPY; folder paths and other notes keep position.
    expect(r.itemOrder).toEqual([OTHER, "Projects/", COPY, "Archive/"]);
    expect(r.changed).toBe(true);
  });

  it("is a no-op when the source uuid is absent from both lists", () => {
    const r = migrateNoteUuidInPrefs(
      { favorites: [OTHER], itemOrder: [OTHER, "Projects/"] },
      ORIG,
      COPY,
    );
    expect(r.favorites).toEqual([OTHER]);
    expect(r.itemOrder).toEqual([OTHER, "Projects/"]);
    expect(r.changed).toBe(false);
  });

  it("does not duplicate the target when it already appears, keeping the source's slot", () => {
    const r = migrateNoteUuidInPrefs(
      { favorites: [COPY, OTHER, ORIG], itemOrder: [COPY, ORIG] },
      ORIG,
      COPY,
    );
    // Pre-existing COPY dropped; migrated slot (where ORIG was) holds COPY once.
    expect(r.favorites).toEqual([OTHER, COPY]);
    expect(r.favorites.filter((x) => x === COPY)).toHaveLength(1);
    expect(r.itemOrder).toEqual([COPY]);
    expect(r.itemOrder.filter((x) => x === COPY)).toHaveLength(1);
    expect(r.changed).toBe(true);
  });
});
