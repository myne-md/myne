// Derive the sidebar folder tree from each note's `folder:` field unioned with
// the deliberate_folders set. Pure function — no persistent tree state.
//
// Spec / grill: 2026-05-29-folder-hierarchy-sidebar.md Q3 (model B —
// `tree = dedup_union(ancestor-expand(frontmatter folder paths) ∪
// ancestor-expand(deliberate_folders set))`; implicit folders vanish when their
// last note leaves, deliberate folders persist when empty) + Q5 (fold+NFC
// identity; display-case pick = deliberate form wins, else lexicographic-min).
// Same shape as markdown-dialect §3.7.4 (parent-chain derivation lives in the
// consuming layer, not the parser).

import { foldSegment, normalizeFolderPath } from "../dialect/folderPath";

/** A folder node in the derived sidebar tree. */
export interface FolderNode {
  /** Canonical display path with trailing slash, e.g. "Projects/Myne/". */
  path: string;
  /** Case-folded + NFC identity key (the dedup key). */
  key: string;
  /** Last path segment, for display, e.g. "Myne". */
  name: string;
  /** Number of path segments (1 = top-level). */
  depth: number;
  /** True when this exact path is in the deliberate_folders set (persists empty). */
  deliberate: boolean;
  /** Note IDs whose folder resolves exactly to this path (not descendants). */
  noteIds: string[];
  /** Child folders, sorted by folded name. */
  children: FolderNode[];
}

export interface FolderTree {
  /** Top-level folders, sorted by folded name. */
  roots: FolderNode[];
  /** Note IDs with no `folder:` (root / unfiled). */
  unfiledNoteIds: string[];
}

interface NoteLike {
  noteUuid: string;
  folder: string | null;
}

interface Builder {
  /** Candidate raw display forms contributed for this folded key. */
  candidates: string[];
  /** Display form forced by deliberate-set membership (wins the tiebreak). */
  deliberateDisplay: string | null;
  deliberate: boolean;
  noteIds: string[];
}

// "Projects/Myne/Sub/" → ["Projects/", "Projects/Myne/", "Projects/Myne/Sub/"].
function ancestorPaths(canonical: string): string[] {
  const segs = canonical.split("/").filter((s) => s.length > 0);
  const out: string[] = [];
  let acc = "";
  for (const s of segs) {
    acc += s + "/";
    out.push(acc);
  }
  return out;
}

function lastSegment(canonical: string): string {
  const segs = canonical.split("/").filter((s) => s.length > 0);
  return segs[segs.length - 1] ?? "";
}

/**
 * Build the folder tree from notes (each carrying a normalized-or-raw `folder:`)
 * and the deliberate_folders set. Folder values are normalized + ancestor-
 * expanded; nodes are deduped by folded identity; the display form is chosen
 * deterministically (deliberate wins, else lexicographic-min).
 */
export function deriveFolderTree(
  notes: ReadonlyArray<NoteLike>,
  deliberateFolders: ReadonlyArray<string>,
): FolderTree {
  const byKey = new Map<string, Builder>();
  const unfiledNoteIds: string[] = [];

  const ensure = (path: string): Builder => {
    const key = foldSegment(path);
    let b = byKey.get(key);
    if (b === undefined) {
      b = {
        candidates: [],
        deliberateDisplay: null,
        deliberate: false,
        noteIds: [],
      };
      byKey.set(key, b);
    }
    b.candidates.push(path);
    return b;
  };

  // Register a canonical path and all its ancestors. `deliberate` marks ONLY
  // the leaf — ancestors of a deliberate path exist because the leaf does, but
  // are not themselves "deliberate" unless separately listed.
  const register = (canonical: string, deliberate: boolean): Builder => {
    const ancestors = ancestorPaths(canonical);
    let leaf: Builder | null = null;
    for (let i = 0; i < ancestors.length; i++) {
      const path = ancestors[i]!;
      const b = ensure(path);
      if (i === ancestors.length - 1) {
        leaf = b;
        if (deliberate) {
          b.deliberate = true;
          b.deliberateDisplay = path;
        }
      }
    }
    return leaf!;
  };

  for (const n of notes) {
    const norm = normalizeFolderPath(n.folder);
    if (norm === null) {
      unfiledNoteIds.push(n.noteUuid);
      continue;
    }
    register(norm, false).noteIds.push(n.noteUuid);
  }

  for (const raw of deliberateFolders) {
    const norm = normalizeFolderPath(raw);
    if (norm === null) continue;
    register(norm, true);
  }

  // Resolve the display form per key and materialize nodes.
  const nodeByKey = new Map<string, FolderNode>();
  for (const [key, b] of byKey) {
    const displayPath =
      b.deliberateDisplay ?? [...b.candidates].sort()[0] ?? "";
    nodeByKey.set(key, {
      path: displayPath,
      key,
      name: lastSegment(displayPath),
      depth: displayPath.split("/").filter((s) => s.length > 0).length,
      deliberate: b.deliberate,
      noteIds: b.noteIds,
      children: [],
    });
  }

  // Link children to parents (ancestor expansion guarantees parents exist).
  const roots: FolderNode[] = [];
  for (const node of nodeByKey.values()) {
    if (node.depth <= 1) {
      roots.push(node);
      continue;
    }
    const segs = node.path.split("/").filter((s) => s.length > 0);
    const parentPath = segs.slice(0, -1).join("/") + "/";
    const parent = nodeByKey.get(foldSegment(parentPath));
    if (parent) parent.children.push(node);
    else roots.push(node); // defensive — should not happen
  }

  const sortRec = (nodes: FolderNode[]): void => {
    nodes.sort((a, b) => foldSegment(a.name).localeCompare(foldSegment(b.name)));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);

  return { roots, unfiledNoteIds };
}
