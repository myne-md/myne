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

import {
  ancestorPaths,
  foldSegment,
  normalizeFolderPath,
} from "@myne/dialect/folderPath";
import {
  archivedFolderKeys,
  filterVisibleDeliberate,
  isNoteFolderArchived,
} from "./archivedFolders";

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
  /**
   * The note ID of this folder's **index note** (MYND-370) — the in-folder note
   * carrying `folder_index: true`, or `null` if the folder has none. **Excluded
   * from `noteIds`**: the index note is hidden from the sidebar folder tree (no
   * separate row), opened instead by double-clicking the folder. It stays in
   * `liveCache` so search / backlinks / graph / saved views still enumerate it —
   * the hiding is sidebar-tree-only (2026-06-27 decision). When more than one
   * in-folder note claims the flag, the deterministic winner (smallest `noteUuid`)
   * is chosen and the rest land in {@link indexConflictIds} (they DO stay in
   * `noteIds` — only the winner is hidden).
   */
  indexNoteId: string | null;
  /**
   * Index-flag claimants in this folder that LOST the deterministic tiebreak
   * (every claimant except {@link indexNoteId}). Non-empty only on a conflict;
   * the UI surfaces a "folder already has an index" warning for these.
   */
  indexConflictIds: string[];
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
  /** True when the note carries the value-strict `folder_index: true` flag
   *  (MYND-370). Optional so existing callers that don't track it still type-check;
   *  absent / false means "ordinary note". */
  folderIndex?: boolean;
}

interface Builder {
  /** Candidate raw display forms contributed for this folded key. */
  candidates: string[];
  /** Display form forced by deliberate-set membership (wins the tiebreak). */
  deliberateDisplay: string | null;
  deliberate: boolean;
  noteIds: string[];
  /** Note IDs in this folder that claim `folder_index: true` (any number). */
  indexClaimantIds: string[];
}

function lastSegment(canonical: string): string {
  const segs = canonical.split("/").filter((s) => s.length > 0);
  return segs[segs.length - 1] ?? "";
}

/**
 * The deterministic folder-index winner among `folder_index: true` claimants in a
 * single folder: the smallest `noteUuid` by locale-independent code-unit order
 * (MYND-370). The ONE definition of the tiebreak — `resolveWikilink`'s folder-
 * target path calls this too, so the sidebar badge and the `[[Projects/]]`
 * resolution can never point at different notes (`wikilink.md` §5.5). Returns
 * `null` for no claimants.
 */
export function pickIndexNote(claimantUuids: readonly string[]): string | null {
  return [...claimantUuids].sort()[0] ?? null;
}

/**
 * Build the folder tree from notes (each carrying a normalized-or-raw `folder:`),
 * the deliberate_folders set and the archived_folders set. Folder values are
 * normalized + ancestor-expanded; nodes are deduped by folded identity; the
 * display form is chosen deterministically (deliberate wins, else
 * lexicographic-min).
 *
 * `archivedFolders` is REQUIRED, and the folder-archive filter is applied HERE
 * rather than by the caller (myne-md/myne-mobile#39). Hiding an archived folder
 * takes two steps that must agree — drop its notes, and drop its deliberate entry
 * so it can't re-surface as an empty node — and leaving either to the caller made
 * it a step a client could forget. It was forgotten: mobile derived the tree from
 * the raw deliberate set, so archived folders survived as empty shells while
 * desktop hid them from the same synced prefs. A filtered `string[]` and an
 * unfiltered one are the same type, so nothing caught it. Passing the set makes
 * the requirement a compile error instead of a silent wrong answer; a caller that
 * genuinely wants archived folders INCLUDED (vault export) passes `[]` and says so
 * by doing it.
 */
export function deriveFolderTree(
  notes: ReadonlyArray<NoteLike>,
  deliberateFolders: ReadonlyArray<string>,
  archivedFolders: ReadonlyArray<string>,
): FolderTree {
  const byKey = new Map<string, Builder>();
  const unfiledNoteIds: string[] = [];
  // Folded once for the whole derivation; empty set → both helpers early-return,
  // so an unarchived vault pays nothing.
  const archivedKeys = archivedFolderKeys(archivedFolders);

  const ensure = (path: string): Builder => {
    const key = foldSegment(path);
    let b = byKey.get(key);
    if (b === undefined) {
      b = {
        candidates: [],
        deliberateDisplay: null,
        deliberate: false,
        noteIds: [],
        indexClaimantIds: [],
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
      // A root/unfiled note cannot be a folder index — there is no folder to
      // index — so its `folder_index` flag (if any) is silently inert here.
      unfiledNoteIds.push(n.noteUuid);
      continue;
    }
    // Skipped BEFORE `register`, not after: registering would materialize the
    // folder (and its ancestors) as nodes, so an archived subtree would keep its
    // folder rows even with every note filtered out of them.
    if (isNoteFolderArchived(norm, archivedKeys)) continue;
    const leaf = register(norm, false);
    leaf.noteIds.push(n.noteUuid);
    if (n.folderIndex === true) leaf.indexClaimantIds.push(n.noteUuid);
  }

  for (const raw of filterVisibleDeliberate(deliberateFolders, archivedKeys)) {
    const norm = normalizeFolderPath(raw);
    if (norm === null) continue;
    register(norm, true);
  }

  // Resolve the display form per key and materialize nodes.
  const nodeByKey = new Map<string, FolderNode>();
  for (const [key, b] of byKey) {
    const displayPath =
      b.deliberateDisplay ?? [...b.candidates].sort()[0] ?? "";

    // Index-note selection (MYND-370). Multiple in-folder notes may claim
    // `folder_index: true`; pick the deterministic winner (smallest noteUuid,
    // stable across reloads) and report the rest as conflicts. The winner is
    // REMOVED from `noteIds` so it does not render as a sidebar row — the folder
    // note is hidden from the folder tree and opened by double-clicking the
    // folder (2026-06-27 decision, supersedes the original "pinned + visible"
    // behaviour). It stays in `liveCache`, so search / backlinks / graph / saved
    // views still enumerate it — the hiding is sidebar-tree-only. Conflict losers
    // are NOT removed (only the winner is hidden) so legacy multi-claimant dupes
    // stay visible for the user to resolve.
    const indexNoteId = pickIndexNote(b.indexClaimantIds);
    const indexConflictIds =
      indexNoteId === null
        ? []
        : [...b.indexClaimantIds].sort().filter((id) => id !== indexNoteId);
    const orderedNoteIds =
      indexNoteId === null
        ? b.noteIds
        : b.noteIds.filter((id) => id !== indexNoteId);

    nodeByKey.set(key, {
      path: displayPath,
      key,
      name: lastSegment(displayPath),
      depth: displayPath.split("/").filter((s) => s.length > 0).length,
      deliberate: b.deliberate,
      noteIds: orderedNoteIds,
      indexNoteId,
      indexConflictIds,
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

  // Structural ordering only: sort each sibling group by folded name for a
  // deterministic tree shape. The user-visible DISPLAY order — which
  // interleaves folders with notes per the unified `item_order` prefs sequence
  // (MYND-183) — is applied later in `flattenVisibleRows`, the single source of
  // truth for render order. This baseline sort is overridden at render time and
  // exists only to keep `deriveFolderTree`'s output deterministic.
  const sortRec = (nodes: FolderNode[]): void => {
    nodes.sort((a, b) => foldSegment(a.name).localeCompare(foldSegment(b.name)));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);

  return { roots, unfiledNoteIds };
}
