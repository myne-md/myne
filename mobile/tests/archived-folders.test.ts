// MYND-470 — unit coverage for the folder-archive helpers (mobile port of the
// desktop `src/notes/archivedFolders.ts`). Pure functions over canonical
// trailing-slash folder paths + the folded `folderKey` identity; no Tauri.

import { describe, expect, it } from "vitest";
import {
  archivedFolderKeys,
  isNoteFolderArchived,
  topLevelArchivedFolders,
  removeFolderFromArchive,
  collectSubtreeNoteIds,
} from "../src/lib/archivedFolders";
import { deriveTree } from "../src/lib/folders";

describe("archivedFolderKeys", () => {
  it("folds, dedups, and drops empties", () => {
    const keys = archivedFolderKeys(["Projects/", "projects/", "", "Old Drafts/"]);
    // "Projects/" and "projects/" fold to the same key → one entry.
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.endsWith("/"))).toBe(true);
  });
});

describe("isNoteFolderArchived", () => {
  const keys = archivedFolderKeys(["Projects/"]);

  it("matches the folder itself and its descendants", () => {
    expect(isNoteFolderArchived("Projects/", keys)).toBe(true);
    expect(isNoteFolderArchived("Projects/Myne/", keys)).toBe(true);
  });

  it("does NOT match a name-prefix sibling", () => {
    expect(isNoteFolderArchived("ProjectsX/", keys)).toBe(false);
  });

  it("never archives a root note or an empty key set", () => {
    expect(isNoteFolderArchived(null, keys)).toBe(false);
    expect(isNoteFolderArchived("Projects/", [])).toBe(false);
  });

  it("is case-insensitive (folded identity)", () => {
    expect(isNoteFolderArchived("projects/myne/", keys)).toBe(true);
  });
});

describe("topLevelArchivedFolders", () => {
  it("folds a nested archived folder under its archived ancestor", () => {
    const top = topLevelArchivedFolders(["Projects/", "Projects/Myne/", "Old/"]);
    expect(top).toEqual(["Old/", "Projects/"]); // sorted by folded key
  });

  it("keeps independent archived folders", () => {
    const top = topLevelArchivedFolders(["A/", "B/"]);
    expect(top.sort()).toEqual(["A/", "B/"]);
  });
});

describe("removeFolderFromArchive", () => {
  it("removes the folder AND its nested archived descendants", () => {
    const next = removeFolderFromArchive(["Projects/", "Projects/Myne/", "Old/"], "Projects/");
    expect(next).toEqual(["Old/"]);
  });

  it("leaves the set unchanged for a non-member / root path", () => {
    expect(removeFolderFromArchive(["A/"], "B/")).toEqual(["A/"]);
    expect(removeFolderFromArchive(["A/"], "")).toEqual(["A/"]);
  });
});

// The regression this file could not have caught before: it tested only the pure
// helpers, and the defect was that the TREE never consulted them
// (myne-md/myne-mobile#39). Mobile archived a folder's notes but kept the folder
// itself as an empty shell, because `filterVisibleDeliberate` was never ported and
// the derivation got the raw deliberate set. These drive `deriveTree` — the
// wrapper the app actually calls.
describe("deriveTree — an archived folder leaves the tree entirely", () => {
  const rootPaths = (t: ReturnType<typeof deriveTree>) =>
    t.roots.map((r) => r.path).sort();

  it("removes an archived folder that is also deliberate", () => {
    const fo = new Map<string, string | null>([["n1", "Projects/"]]);
    expect(rootPaths(deriveTree(fo, ["Projects/"], ["Projects/"]))).toEqual([]);
  });

  it("removes the folder even when a deliberate DESCENDANT would rebuild it", () => {
    // Ancestors are materialized from the leaf, so a deliberate `Projects/Myne/`
    // used to re-create `Projects/` right after it was archived.
    const fo = new Map<string, string | null>();
    expect(rootPaths(deriveTree(fo, ["Projects/Myne/"], ["Projects/"]))).toEqual(
      [],
    );
  });

  it("keeps a name-prefix sibling (`ProjectsX/`)", () => {
    const fo = new Map<string, string | null>([
      ["n1", "Projects/"],
      ["n2", "ProjectsX/"],
    ]);
    expect(rootPaths(deriveTree(fo, [], ["Projects/"]))).toEqual(["ProjectsX/"]);
  });

  it("restoring the folder brings it back (prefs-only, notes untouched)", () => {
    const fo = new Map<string, string | null>([["n1", "Projects/"]]);
    const archived = ["Projects/"];
    expect(rootPaths(deriveTree(fo, ["Projects/"], archived))).toEqual([]);
    const restored = removeFolderFromArchive(archived, "Projects/");
    expect(rootPaths(deriveTree(fo, ["Projects/"], restored))).toEqual([
      "Projects/",
    ]);
  });
});

describe("collectSubtreeNoteIds", () => {
  const folderOf = new Map<string, string | null>([
    ["n1", "Projects/"],
    ["n2", "Projects/Myne/"],
    ["n3", "ProjectsX/"], // sibling — must NOT be collected
    ["n4", null], // root
  ]);

  it("collects every note at/under the archived key, excluding siblings + root", () => {
    const ids = collectSubtreeNoteIds(folderOf, "projects/"); // folded key
    expect(ids.sort()).toEqual(["n1", "n2"]);
  });

  it("returns nothing for an empty key", () => {
    expect(collectSubtreeNoteIds(folderOf, "")).toEqual([]);
  });
});
