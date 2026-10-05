// `applyCacheUpdate` identity preservation (the long-note save flicker).
//
// A successful autosave stamps `updated:` on disk and the pane refreshes its
// own row (`PaneView` → `ctx.refreshOne(savedId)`). Before this the refresh
// allocated a fresh cache Map + state object even when nothing the sidebar
// renders had changed, so every sidebar consumer re-rendered once per autosave.
//
// The seam is pure, so this pins the property directly: an unchanged record
// returns the SAME state object (no new Map), a changed one returns a new one.

import { describe, expect, it } from "vitest";

import {
  applyCacheUpdate,
  type SidebarState,
} from "../../src/notes/sidebarState";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";

function record(over: Partial<TitleRecord> = {}): TitleRecord {
  return {
    noteUuid: "n1",
    title: "Note",
    folder: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    trashed: null,
    deleted: null,
    archived: null,
    template: false,
    folderIndex: false,
    conflict: false,
    conflictOf: null,
    hasSource: false,
    kind: null,
    done: null,
    ...over,
  };
}

function state(cache: Map<string, TitleRecord>): SidebarState {
  return { cache } as SidebarState;
}

describe("applyCacheUpdate identity preservation", () => {
  it("returns the same state when only updatedAt's identity differs but value matches", () => {
    const prev = record();
    // A fresh Date instance with the same instant, as a re-read produces.
    const next = record({ updatedAt: new Date("2026-01-01T00:00:00Z") });
    const before = state(new Map([["n1", prev]]));
    const after = applyCacheUpdate(before, "n1", next);
    // The whole point: no new Map, no new state, no re-render.
    expect(after).toBe(before);
  });

  it("returns new state when a visible field changed", () => {
    const before = state(new Map([["n1", record({ title: "Old" })]]));
    const after = applyCacheUpdate(before, "n1", record({ title: "New" }));
    expect(after).not.toBe(before);
    expect(after.cache.get("n1")?.title).toBe("New");
  });

  it("returns new state when the note's updatedAt actually moved", () => {
    const before = state(new Map([["n1", record()]]));
    const after = applyCacheUpdate(
      before,
      "n1",
      record({ updatedAt: new Date("2026-02-02T00:00:00Z") }),
    );
    expect(after).not.toBe(before);
  });

  it("inserts a record for a note not yet cached", () => {
    const before = state(new Map());
    const after = applyCacheUpdate(before, "n1", record());
    expect(after).not.toBe(before);
    expect(after.cache.get("n1")?.title).toBe("Note");
  });
});
