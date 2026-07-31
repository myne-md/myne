import { describe, it, expect } from "vitest";
import {
  buildConflictCopyContent,
  clearConflictMarkers,
  createConflictCopy,
  applyConflictVersion,
  undoConflictVersion,
  type ConflictCopyHost,
} from "@myne/dialect/conflictCopy";

const CONFLICT = /conflict:\s*true/;
const CONFLICT_OF = /conflict_of:\s*orig/;

/** A recording mock host: an in-memory note store + prefs, logging the call order. */
function mockHost(initial: Record<string, string> = {}) {
  const notes = new Map<string, string>(Object.entries(initial));
  const calls: string[] = [];
  let nextId = 100;
  const prefs = {
    favorites: ["orig"] as string[],
    item_order: { "": ["a", "orig", "b"] } as Record<string, string[]>,
  };
  const host: ConflictCopyHost = {
    async noteRead(id) {
      calls.push(`read:${id}`);
      return notes.get(id) ?? "";
    },
    async noteUpdate(id, content) {
      calls.push(`update:${id}`);
      notes.set(id, content);
    },
    async noteCreate(plaintext) {
      const id = `n${nextId++}`;
      calls.push(`create:${id}`);
      notes.set(id, plaintext);
      return id;
    },
    async deleteNoteRouted(uuid) {
      calls.push(`delete:${uuid}`);
    },
    async prefsRead() {
      return { favorites: prefs.favorites, item_order: prefs.item_order };
    },
    async setFavorites(f) {
      calls.push("setFavorites");
      prefs.favorites = f;
    },
    async setItemOrder(o) {
      calls.push("setItemOrder");
      prefs.item_order = o;
    },
  };
  return { host, notes, calls, prefs };
}

describe("conflict-copy pure builders", () => {
  it("buildConflictCopyContent adds conflict + conflict_of frontmatter", () => {
    const out = buildConflictCopyContent("hello body", "orig");
    expect(out).toMatch(CONFLICT);
    expect(out).toMatch(CONFLICT_OF);
    expect(out).toContain("hello body");
  });

  it("clearConflictMarkers removes both markers (round-trip)", () => {
    const cleared = clearConflictMarkers(buildConflictCopyContent("body", "orig"));
    expect(cleared).not.toMatch(CONFLICT);
    expect(cleared).not.toMatch(/conflict_of:/);
    expect(cleared).toContain("body");
  });
});

describe("conflict-copy orchestrators over injected IO", () => {
  it("createConflictCopy creates one note carrying the markers", async () => {
    const { host, notes } = mockHost();
    const id = await createConflictCopy(host, "remote body", "orig");
    expect(notes.get(id)!).toMatch(CONFLICT);
    expect(notes.get(id)!).toMatch(CONFLICT_OF);
  });

  it("applyConflictVersion promotes the copy THEN trashes the original (order)", async () => {
    const { host, notes, calls } = mockHost({
      copy: buildConflictCopyContent("winning body", "orig"),
      orig: "losing body",
    });
    await applyConflictVersion(host, "copy", "orig");
    // The copy is de-conflicted (promoted to an ordinary note)...
    expect(notes.get("copy")!).not.toMatch(CONFLICT);
    // ...and the original is tombstoned LAST (never a window with both gone).
    const updateIdx = calls.indexOf("update:copy");
    const deleteIdx = calls.indexOf("delete:orig");
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(updateIdx);
    // Prefs membership migrated (orig was a favorite + in item_order → copy now is).
    expect(calls).toContain("setFavorites");
    expect(calls).toContain("setItemOrder");
    expect(notes.get("copy")).toBeDefined();
  });

  it("undoConflictVersion re-marks the copy as a conflict + un-tombstones", async () => {
    const { host, notes, calls } = mockHost({
      copy: "promoted body",
      orig: "---\ntrashed: true\n---\nbody",
    });
    await undoConflictVersion(host, "copy", "orig");
    // The copy is a conflict copy again.
    expect(notes.get("copy")!).toMatch(CONFLICT);
    expect(notes.get("copy")!).toMatch(CONFLICT_OF);
    // Both notes were updated (original un-tombstoned + copy re-marked).
    expect(calls).toContain("update:orig");
    expect(calls).toContain("update:copy");
  });
});
