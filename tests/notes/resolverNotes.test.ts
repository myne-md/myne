// SYNC-1: the canonical resolver note-set is the live (non-trashed, non-template)
// cache projected to {noteUuid, title, folder, folderIndex, isDrawing}. Covers the
// projection + exclusion + the drawing-notes SF2 `isDrawing` projection (MYND-499).

import { describe, expect, it } from "vitest";

import { resolverNotesFromCache } from "../../src/notes/resolverNotes";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";
import type { NoteId } from "../../src/notes/sidebarState";

function rec(p: Partial<TitleRecord> & { noteUuid: string }): TitleRecord {
  return {
    noteUuid: p.noteUuid,
    title: p.title ?? null,
    folder: p.folder ?? null,
    updatedAt: null,
    trashed: p.trashed ?? null,
    template: p.template ?? false,
    kind: p.kind ?? null,
  };
}

function cache(records: TitleRecord[]): Map<NoteId, TitleRecord> {
  return new Map(records.map((r) => [r.noteUuid, r]));
}

describe("resolverNotesFromCache", () => {
  it("maps live records to the ResolverNote shape", () => {
    const out = resolverNotesFromCache(
      cache([rec({ noteUuid: "a", title: "Alpha", folder: "f/" })]),
    );
    expect(out).toEqual([
      { noteUuid: "a", title: "Alpha", folder: "f/", isDrawing: false },
    ]);
  });

  it("excludes trashed and template records (live-set only)", () => {
    const out = resolverNotesFromCache(
      cache([
        rec({ noteUuid: "a", title: "Live" }),
        rec({ noteUuid: "b", title: "Trashed", trashed: "2026-01-01T00:00:00Z" }),
        rec({ noteUuid: "c", title: "Template", template: true }),
      ]),
    );
    expect(out.map((n) => n.noteUuid)).toEqual(["a"]);
  });

  it("carries null title/folder for untitled, unfiled notes", () => {
    const out = resolverNotesFromCache(cache([rec({ noteUuid: "a" })]));
    expect(out).toEqual([
      { noteUuid: "a", title: null, folder: null, isDrawing: false },
    ]);
  });

  it("projects isDrawing:true for a kind:drawing note (SF6 embed picks widget vs chip)", () => {
    const out = resolverNotesFromCache(
      cache([
        rec({ noteUuid: "d", title: "Sketch", kind: "drawing" }),
        rec({ noteUuid: "n", title: "Note" }),
      ]),
    );
    expect(out.find((n) => n.noteUuid === "d")?.isDrawing).toBe(true);
    expect(out.find((n) => n.noteUuid === "n")?.isDrawing).toBe(false);
  });
});
