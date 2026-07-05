// Folder-archive pure helpers + planners (folder-archive). Covers the queryable
// set helpers (`archivedFolders.ts`) and the folder-archive planners in
// `folderActions.ts` — folded-prefix identity, sibling-prefix safety, nesting
// subsumption, cascade removal, and rename re-root.

import { describe, expect, it } from "vitest";

import type { TitleRecord } from "../../src/notes/loadNoteBatch";
import type { NoteId } from "../../src/notes/sidebarState";
import {
  archivedFolderKeys,
  collectSubtreeNoteIdsFromCache,
  filterVisibleDeliberate,
  isNoteFolderArchived,
  topLevelArchivedFolders,
} from "../../src/notes/archivedFolders";
import {
  planFolderArchive,
  planFolderUnarchive,
  rerootArchivedFolders,
} from "../../src/notes/folderActions";
import { deriveFolderTree, type FolderTree } from "../../src/notes/folderTree";

function rec(p: Partial<TitleRecord> & { noteUuid: string }): TitleRecord {
  return {
    noteUuid: p.noteUuid,
    title: p.title ?? null,
    folder: p.folder ?? null,
    updatedAt: null,
    trashed: p.trashed ?? null,
    deleted: p.deleted ?? null,
    archived: p.archived ?? null,
    template: p.template ?? false,
    folderIndex: p.folderIndex ?? false,
    conflict: p.conflict ?? false,
    conflictOf: p.conflictOf ?? null,
    hasSource: p.hasSource ?? false,
  };
}

function cacheOf(records: TitleRecord[]): Map<NoteId, TitleRecord> {
  return new Map(records.map((r) => [r.noteUuid, r]));
}

function treeOf(records: TitleRecord[]): FolderTree {
  return deriveFolderTree(
    records.map((r) => ({ noteUuid: r.noteUuid, folder: r.folder })),
    [],
  );
}

describe("archivedFolderKeys", () => {
  it("folds (NFC + case), drops empties/root, dedupes", () => {
    expect(archivedFolderKeys(["Projects/", "projects/", "", "Café/"])).toEqual([
      "projects/",
      "café/",
    ]);
  });
});

describe("isNoteFolderArchived", () => {
  const keys = archivedFolderKeys(["Projects/"]);

  it("matches the folder itself and any descendant", () => {
    expect(isNoteFolderArchived("Projects/", keys)).toBe(true);
    expect(isNoteFolderArchived("Projects/Myne/", keys)).toBe(true);
  });

  it("is sibling-prefix safe (trailing slash)", () => {
    expect(isNoteFolderArchived("ProjectsX/", keys)).toBe(false);
  });

  it("is case/diacritic-insensitive and root-safe", () => {
    expect(isNoteFolderArchived("projects/", keys)).toBe(true);
    expect(isNoteFolderArchived(null, keys)).toBe(false);
    expect(isNoteFolderArchived("Other/", keys)).toBe(false);
  });

  it("empty set matches nothing", () => {
    expect(isNoteFolderArchived("Projects/", [])).toBe(false);
  });
});

describe("filterVisibleDeliberate", () => {
  it("drops deliberate folders at/under an archived folder, keeps the rest", () => {
    const keys = archivedFolderKeys(["Projects/"]);
    expect(
      filterVisibleDeliberate(["Projects/", "Projects/Myne/", "Other/"], keys),
    ).toEqual(["Other/"]);
  });
});

describe("topLevelArchivedFolders", () => {
  it("folds a nested archived folder under its archived ancestor", () => {
    expect(topLevelArchivedFolders(["Projects/Myne/", "Projects/"])).toEqual([
      "Projects/",
    ]);
  });

  it("keeps independent archived folders, sorted by folded key", () => {
    expect(topLevelArchivedFolders(["Zeta/", "Alpha/"])).toEqual([
      "Alpha/",
      "Zeta/",
    ]);
  });
});

describe("collectSubtreeNoteIdsFromCache", () => {
  it("collects the subtree by prefix, excluding trashed/deleted", () => {
    const cache = cacheOf([
      rec({ noteUuid: "a", folder: "Projects/" }),
      rec({ noteUuid: "b", folder: "Projects/Myne/" }),
      rec({ noteUuid: "sib", folder: "ProjectsX/" }),
      rec({ noteUuid: "tr", folder: "Projects/", trashed: "2026-01-01T00:00:00Z" }),
      rec({ noteUuid: "del", folder: "Projects/", deleted: "2026-01-01T00:00:00Z" }),
    ]);
    expect(
      collectSubtreeNoteIdsFromCache(cache, "projects/").sort(),
    ).toEqual(["a", "b"]);
  });
});

describe("planFolderArchive", () => {
  it("adds the target and collects its live subtree note ids", () => {
    const records = [
      rec({ noteUuid: "a", folder: "Projects/" }),
      rec({ noteUuid: "b", folder: "Projects/Myne/" }),
    ];
    const plan = planFolderArchive("Projects/", treeOf(records), []);
    expect(plan.nextArchived).toEqual(["Projects/"]);
    expect(plan.noteIds.sort()).toEqual(["a", "b"]);
  });

  it("subsumes an already-archived descendant when the ancestor is archived", () => {
    const plan = planFolderArchive("Projects/", treeOf([]), ["Projects/Myne/"]);
    expect(plan.nextArchived).toEqual(["Projects/"]);
  });

  it("is a no-op set-change when an archived ancestor already covers it", () => {
    const plan = planFolderArchive("Projects/Myne/", treeOf([]), ["Projects/"]);
    expect(plan.nextArchived).toEqual(["Projects/"]);
  });
});

describe("planFolderUnarchive", () => {
  it("cascade-removes the target and its archived descendants", () => {
    expect(
      planFolderUnarchive("Projects/", [
        "Projects/",
        "Projects/Myne/",
        "Other/",
      ]),
    ).toEqual(["Other/"]);
  });

  it("leaves the set unchanged when nothing is archived under the path", () => {
    expect(planFolderUnarchive("Nope/", ["Other/"])).toEqual(["Other/"]);
  });
});

describe("rerootArchivedFolders", () => {
  it("re-roots the folded-prefix subtree onto the new path", () => {
    const out = rerootArchivedFolders("Old/", "New/", [
      "Old/",
      "Old/Sub/",
      "Keep/",
    ]);
    expect(out.rewritten).toBe(2);
    expect(out.next).toEqual(["New/", "New/Sub/", "Keep/"]);
  });

  it("is a no-op for a same-path or root rename", () => {
    expect(rerootArchivedFolders("A/", "A/", ["A/"]).rewritten).toBe(0);
  });
});
