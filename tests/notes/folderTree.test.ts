// deriveFolderTree — pure derivation of the sidebar folder tree from each
// note's `folder:` field ∪ the deliberate_folders set.
//
// Spec: markdown-dialect §3.7.4 (parent-chain derivation pushed to the
// consuming layer — same shape). Grill: 2026-05-29-folder-hierarchy Q3 (model
// B: tree = dedup_union(ancestor-expand(frontmatter) ∪ ancestor-expand(set)),
// implicit-vanish vs deliberate-persist) + Q5 (fold+NFC identity, display-case
// pick = deliberate wins else lexicographic-min).

import { describe, it, expect } from "vitest";
import { deriveFolderTree } from "../../src/notes/folderTree";
import type { FolderNode } from "../../src/notes/folderTree";

type Note = { noteUuid: string; folder: string | null };
const note = (noteUuid: string, folder: string | null): Note => ({
  noteUuid,
  folder,
});

// Find a node by canonical display path in a tree (depth-first).
function find(nodes: FolderNode[], path: string): FolderNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    const hit = find(n.children, path);
    if (hit) return hit;
  }
  return undefined;
}

describe("deriveFolderTree — basics", () => {
  it("returns empty tree for empty inputs", () => {
    expect(deriveFolderTree([], [])).toEqual({ roots: [], unfiledNoteIds: [] });
  });

  it("puts a note with no folder in the unfiled bucket", () => {
    const tree = deriveFolderTree([note("n1", null)], []);
    expect(tree.unfiledNoteIds).toEqual(["n1"]);
    expect(tree.roots).toEqual([]);
  });

  it("creates a single top-level folder with its note", () => {
    const tree = deriveFolderTree([note("n1", "Projects/")], []);
    expect(tree.roots).toHaveLength(1);
    const root = tree.roots[0]!;
    expect(root.path).toBe("Projects/");
    expect(root.name).toBe("Projects");
    expect(root.depth).toBe(1);
    expect(root.deliberate).toBe(false);
    expect(root.noteIds).toEqual(["n1"]);
  });
});

describe("deriveFolderTree — ancestor expansion", () => {
  it("creates ancestor nodes for a nested folder", () => {
    const tree = deriveFolderTree([note("n1", "Projects/Myne/")], []);
    const projects = find(tree.roots, "Projects/");
    const myne = find(tree.roots, "Projects/Myne/");
    expect(projects).toBeDefined();
    expect(myne).toBeDefined();
    expect(projects!.children.map((c) => c.path)).toContain("Projects/Myne/");
    // The note lives on the leaf, not the ancestor.
    expect(projects!.noteIds).toEqual([]);
    expect(myne!.noteIds).toEqual(["n1"]);
    expect(myne!.depth).toBe(2);
  });
});

// === MYND-370: folder-index note derivation ===
describe("deriveFolderTree — folder-index note (MYND-370)", () => {
  // Note variant carrying the `folder_index` flag.
  const idxNote = (
    noteUuid: string,
    folder: string | null,
    folderIndex: boolean,
  ) => ({ noteUuid, folder, folderIndex });

  it("leaves indexNoteId null and no conflict for a folder with no flagged note", () => {
    const tree = deriveFolderTree([note("n1", "Projects/")], []);
    const root = tree.roots[0]!;
    expect(root.indexNoteId).toBeNull();
    expect(root.indexConflictIds).toEqual([]);
  });

  it("identifies the single flagged note as the folder's index", () => {
    const tree = deriveFolderTree(
      [idxNote("n1", "Projects/", true), note("n2", "Projects/")],
      [],
    );
    const root = tree.roots[0]!;
    expect(root.indexNoteId).toBe("n1");
    expect(root.indexConflictIds).toEqual([]);
  });

  it("excludes the index note from noteIds (hidden from the sidebar tree)", () => {
    const tree = deriveFolderTree(
      [note("a-note", "Projects/"), idxNote("z-index", "Projects/", true)],
      [],
    );
    const root = tree.roots[0]!;
    // z-index is the index note → hidden from noteIds (opened by double-click).
    expect(root.indexNoteId).toBe("z-index");
    expect(root.noteIds).toEqual(["a-note"]);
    expect(root.noteIds).not.toContain("z-index");
  });

  it("a folder whose only note is its index note has empty noteIds but a set indexNoteId", () => {
    const tree = deriveFolderTree([idxNote("only", "Solo/", true)], []);
    const root = find(tree.roots, "Solo/")!;
    expect(root.indexNoteId).toBe("only");
    expect(root.noteIds).toEqual([]);
  });

  it("resolves a two-claim conflict to the smallest-uuid winner; only the winner is hidden", () => {
    const tree = deriveFolderTree(
      [
        idxNote("n-b", "Projects/", true),
        idxNote("n-a", "Projects/", true),
        idxNote("n-c", "Projects/", true),
      ],
      [],
    );
    const root = tree.roots[0]!;
    expect(root.indexNoteId).toBe("n-a");
    expect(root.indexConflictIds).toEqual(["n-b", "n-c"]);
    // Only the winner is excluded; the conflict losers stay visible rows so the
    // user can see and resolve the dupes.
    expect(root.noteIds).not.toContain("n-a");
    expect(root.noteIds.sort()).toEqual(["n-b", "n-c"]);
  });

  it("does not treat a root/unfiled note's folder_index flag as an index", () => {
    const tree = deriveFolderTree([idxNote("n1", null, true)], []);
    expect(tree.unfiledNoteIds).toEqual(["n1"]);
    expect(tree.roots).toEqual([]);
  });

  it("binds the index to the note's own folder (move follows the flag)", () => {
    // The same note, now living in Work/, indexes Work/ — not Projects/.
    const tree = deriveFolderTree(
      [idxNote("n1", "Work/", true), note("n2", "Projects/")],
      ["Projects/"],
    );
    expect(find(tree.roots, "Work/")!.indexNoteId).toBe("n1");
    expect(find(tree.roots, "Projects/")!.indexNoteId).toBeNull();
  });
});

describe("deriveFolderTree — union + dedup", () => {
  it("merges a note folder and a deliberate folder into one node", () => {
    const tree = deriveFolderTree([note("n1", "Projects/")], ["Projects/"]);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.deliberate).toBe(true);
    expect(tree.roots[0]!.noteIds).toEqual(["n1"]);
  });

  it("collapses case-only-distinct folders to one node (lex-min display)", () => {
    const tree = deriveFolderTree(
      [note("n1", "Projects/"), note("n2", "projects/")],
      [],
    );
    expect(tree.roots).toHaveLength(1);
    const root = tree.roots[0]!;
    // 'P' (0x50) < 'p' (0x70) → "Projects/" is the lexicographic-min display.
    expect(root.path).toBe("Projects/");
    expect(root.noteIds.sort()).toEqual(["n1", "n2"]);
  });

  it("lets the deliberate-set form win the display-case tiebreak", () => {
    const tree = deriveFolderTree([note("n1", "Projects/")], ["projects/"]);
    expect(tree.roots).toHaveLength(1);
    const root = tree.roots[0]!;
    expect(root.path).toBe("projects/"); // deliberate form wins over lex-min
    expect(root.deliberate).toBe(true);
    expect(root.noteIds).toEqual(["n1"]);
  });
});

describe("deriveFolderTree — implicit vanish vs deliberate persist", () => {
  it("does not include an implicit folder once no note carries it", () => {
    // No records, no deliberate entries → folder is gone.
    expect(deriveFolderTree([], []).roots).toEqual([]);
  });

  it("keeps an empty deliberate folder", () => {
    const tree = deriveFolderTree([], ["Empty/"]);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.path).toBe("Empty/");
    expect(tree.roots[0]!.deliberate).toBe(true);
    expect(tree.roots[0]!.noteIds).toEqual([]);
  });

  it("expands a deliberate nested path; only the leaf is deliberate", () => {
    const tree = deriveFolderTree([], ["Projects/Myne/Sub/"]);
    const projects = find(tree.roots, "Projects/");
    const myne = find(tree.roots, "Projects/Myne/");
    const sub = find(tree.roots, "Projects/Myne/Sub/");
    expect(projects).toBeDefined();
    expect(myne).toBeDefined();
    expect(sub).toBeDefined();
    expect(sub!.deliberate).toBe(true);
    expect(projects!.deliberate).toBe(false);
    expect(myne!.deliberate).toBe(false);
  });
});

describe("deriveFolderTree — sibling sort", () => {
  it("sorts sibling folders by folded name", () => {
    const tree = deriveFolderTree(
      [note("n1", "Beta/"), note("n2", "Alpha/")],
      [],
    );
    expect(tree.roots.map((r) => r.path)).toEqual(["Alpha/", "Beta/"]);
  });
});
