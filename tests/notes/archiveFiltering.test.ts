// Two-axis filtering for note-archive (MYND-331 Q3/B). Archive is hidden from
// the working-set surfaces (folder tree, favorites display) but stays in the
// reference/discovery set (backlink resolution, graph, tag-browser) and in search.
//
// Covers: liveCache excludes archived; archivedRecords / archivedCount partition;
// resolverCache (and resolverNotesFromCache) KEEP archived; folder-tree exclusion;
// favorites preservation (render half drops it, persist half keeps it — Q4).

import { describe, expect, it } from "vitest";

import type { TitleRecord } from "../../src/notes/loadNoteBatch";
import {
  liveCache,
  resolverCache,
  archivedRecords,
  archivedCount,
  trashedRecords,
  type NoteId,
} from "../../src/notes/sidebarState";
import { resolverNotesFromCache } from "../../src/notes/resolverNotes";
import { deriveFolderTree } from "../../src/notes/folderTree";
import {
  buildFavoriteRows,
  pruneFavorites,
} from "../../src/notes/components/folderTreeRows";

function rec(p: Partial<TitleRecord> & { noteUuid: string }): TitleRecord {
  return {
    noteUuid: p.noteUuid,
    title: p.title ?? null,
    folder: p.folder ?? null,
    updatedAt: null,
    trashed: p.trashed ?? null,
    archived: p.archived ?? null,
    template: p.template ?? false,
    folderIndex: p.folderIndex ?? false,
  };
}

function cacheOf(records: TitleRecord[]): Map<NoteId, TitleRecord> {
  return new Map(records.map((r) => [r.noteUuid, r]));
}

const A1 = "2026-06-17T09:00:00Z";
const A2 = "2026-06-17T10:00:00Z";
const T1 = "2026-06-03T11:00:00Z";

describe("liveCache — excludes archived (working set)", () => {
  it("drops an archived note from the live working set", () => {
    const live = liveCache(
      cacheOf([
        rec({ noteUuid: "live" }),
        rec({ noteUuid: "arch", archived: A1 }),
      ]),
    );
    expect([...live.keys()]).toEqual(["live"]);
  });

  it("keeps excluding trashed and template alongside archived", () => {
    const live = liveCache(
      cacheOf([
        rec({ noteUuid: "live" }),
        rec({ noteUuid: "arch", archived: A1 }),
        rec({ noteUuid: "tr", trashed: T1 }),
        rec({ noteUuid: "tpl", template: true }),
      ]),
    );
    expect([...live.keys()]).toEqual(["live"]);
  });
});

describe("archivedRecords / archivedCount", () => {
  it("returns archived records newest-first, excluding live/trashed", () => {
    const out = archivedRecords(
      cacheOf([
        rec({ noteUuid: "old", archived: A1 }),
        rec({ noteUuid: "new", archived: A2 }),
        rec({ noteUuid: "live" }),
        rec({ noteUuid: "tr", trashed: T1 }),
      ]),
    );
    expect(out.map((r) => r.noteUuid)).toEqual(["new", "old"]);
  });

  it("counts only archived records", () => {
    expect(
      archivedCount(
        cacheOf([
          rec({ noteUuid: "a", archived: A1 }),
          rec({ noteUuid: "b", archived: A2 }),
          rec({ noteUuid: "c" }),
        ]),
      ),
    ).toBe(2);
  });

  it("an archived note is NOT counted as trashed (rafts are disjoint)", () => {
    const c = cacheOf([rec({ noteUuid: "a", archived: A1 })]);
    expect(trashedRecords(c)).toEqual([]);
  });
});

describe("resolverCache / resolverNotesFromCache — KEEP archived (discovery set)", () => {
  it("resolverCache includes archived but excludes trashed and template", () => {
    const out = resolverCache(
      cacheOf([
        rec({ noteUuid: "live" }),
        rec({ noteUuid: "arch", archived: A1 }),
        rec({ noteUuid: "tr", trashed: T1 }),
        rec({ noteUuid: "tpl", template: true }),
      ]),
    );
    expect([...out.keys()].sort()).toEqual(["arch", "live"]);
  });

  it("resolverNotesFromCache keeps an archived note resolvable (backlink target)", () => {
    const out = resolverNotesFromCache(
      cacheOf([
        rec({ noteUuid: "a", title: "Live" }),
        rec({ noteUuid: "b", title: "Archived", archived: A1 }),
        rec({ noteUuid: "c", title: "Trashed", trashed: T1 }),
      ]),
    );
    expect(out.map((n) => n.noteUuid).sort()).toEqual(["a", "b"]);
  });
});

describe("folder-tree exclusion", () => {
  it("an archived note does not appear in the derived folder tree", () => {
    const tree = deriveFolderTree(
      [
        ...liveCache(
          cacheOf([
            rec({ noteUuid: "live", folder: "Projects/", title: "Live" }),
            rec({
              noteUuid: "arch",
              folder: "Projects/",
              title: "Arch",
              archived: A1,
            }),
          ]),
        ).values(),
      ],
      [],
    );
    const ids = JSON.stringify(tree);
    expect(ids).toContain("live");
    expect(ids).not.toContain("arch");
  });
});

describe("favorites preservation through archive (Q4)", () => {
  it("render half (live) drops an archived favorite, persist half (full cache) keeps it", () => {
    const full = cacheOf([
      rec({ noteUuid: "fav-arch", title: "Fav", archived: A1 }),
      rec({ noteUuid: "fav-live", title: "Live" }),
    ]);
    const favorites = ["fav-arch", "fav-live"];

    // Render half: buildFavoriteRows is fed `live` (archived excluded) in NoteList.
    const rows = buildFavoriteRows(favorites, liveCache(full));
    expect(rows.map((r) => r.id)).toEqual(["fav-live"]);

    // Persist half: pruneFavorites runs against the FULL cache, so the archived
    // favorite's UUID survives → restore re-surfaces it as a favorite.
    expect(pruneFavorites(favorites, full)).toEqual(["fav-arch", "fav-live"]);
  });
});
