// Folder-management actions (MYND-144 Task 8): folder delete.
//
// Grill 2026-05-29 Q8: v0.1 has no soft-trash, so a folder-delete must NEVER
// touch a note. Deleting a folder whose subtree holds any note is **blocked**
// ("move or delete the notes first"); deleting a note-empty folder (necessarily
// a deliberate folder and/or its derived ancestors) cascade-removes the matching
// deliberate_folders entries — a cold prefs-set write, no re-encrypt. Ancestors
// that were only ancestor-derived vanish naturally from the next tree
// derivation (they were never in the set).

import { foldSegment, normalizeFolderPath } from "../dialect/folderPath";
import { setDeliberateFolders } from "../lib/prefs";
import { moveNote } from "./moveNote";
import type { FolderNode, FolderTree } from "./folderTree";

export type FolderDeletePlan =
  | { blocked: true; reason: "non-empty"; noteCount: number }
  | { blocked: false; nextDeliberate: string[]; removed: string[] };

function findNode(nodes: readonly FolderNode[], key: string): FolderNode | null {
  for (const n of nodes) {
    if (n.key === key) return n;
    const hit = findNode(n.children, key);
    if (hit) return hit;
  }
  return null;
}

/** Total notes in `node`'s subtree (itself + all descendants). */
function countSubtreeNotes(node: FolderNode): number {
  let total = node.noteIds.length;
  for (const child of node.children) total += countSubtreeNotes(child);
  return total;
}

/**
 * Decide whether `targetPath` can be deleted and, if so, compute the next
 * deliberate_folders set. Pure — no IPC. The target subtree's note count gates
 * the decision; the deliberate set is filtered by folded-path prefix so the
 * target and every deliberate descendant are removed in one pass, while
 * siblings and deliberate ancestors are preserved.
 */
export function planFolderDelete(
  targetPath: string,
  tree: FolderTree,
  deliberateFolders: readonly string[],
): FolderDeletePlan {
  const normalized = normalizeFolderPath(targetPath);
  // Root (absent) is not a deletable folder — no-op, nothing removed.
  if (normalized === null) {
    return { blocked: false, nextDeliberate: [...deliberateFolders], removed: [] };
  }
  const targetKey = foldSegment(normalized); // trailing-slash folded form

  const node = findNode(tree.roots, targetKey);
  const noteCount = node ? countSubtreeNotes(node) : 0;
  if (noteCount > 0) {
    return { blocked: true, reason: "non-empty", noteCount };
  }

  // targetKey ends with "/", so `startsWith` matches the target itself and any
  // descendant but never a name-prefix sibling (`projectsx/` ⊀ `projects/`).
  const removed: string[] = [];
  const nextDeliberate: string[] = [];
  for (const f of deliberateFolders) {
    const norm = normalizeFolderPath(f);
    const key = norm === null ? "" : foldSegment(norm);
    if (key.startsWith(targetKey)) removed.push(f);
    else nextDeliberate.push(f);
  }
  return { blocked: false, nextDeliberate, removed };
}

/**
 * Delete `targetPath`. Returns the plan; persists the trimmed deliberate set
 * via {@link setDeliberateFolders} only when the delete is not blocked. Never
 * touches a note blob. Rejects with whatever `setDeliberateFolders` propagates.
 */
export async function deleteFolder(
  targetPath: string,
  tree: FolderTree,
  deliberateFolders: readonly string[],
): Promise<FolderDeletePlan> {
  const plan = planFolderDelete(targetPath, tree, deliberateFolders);
  if (!plan.blocked) {
    await setDeliberateFolders(plan.nextDeliberate);
  }
  return plan;
}

// ---- folder rename ----------------------------------------------------

export type FolderRenamePlan =
  | { invalid: true }
  | {
      /** Per-note folder rewrites (note's old folder → new folder under the new prefix). */
      moves: Array<{ noteId: string; newFolder: string }>;
      /** The deliberate_folders set after prefix-rewriting matching entries. */
      nextDeliberate: string[];
      /** How many deliberate entries were prefix-rewritten. */
      deliberateRewritten: number;
    };

export type FolderRenameResult = {
  moved: string[];
  failed: Array<{ noteId: string; error: unknown }>;
  deliberateRewritten: number;
  /** The deliberate_folders set after the rename — for the UI to refresh local state. */
  nextDeliberate: string[];
  /** True when the rename was rejected before any work (root source/target). */
  invalid?: boolean;
};

/**
 * Compute the per-note folder rewrites + the prefix-rewritten deliberate set
 * for renaming `oldPath` → `newPath`. Pure — no IPC. Folded-prefix match (with
 * trailing slash) selects the subtree; the descendant suffix is preserved and
 * re-rooted under the normalized new prefix. Root source/target → invalid;
 * source === target → no-op.
 */
export function planFolderRename(
  oldPath: string,
  newPath: string,
  notes: ReadonlyArray<{ noteUuid: string; folder: string | null }>,
  deliberateFolders: readonly string[],
): FolderRenamePlan {
  const oldNorm = normalizeFolderPath(oldPath);
  const newNorm = normalizeFolderPath(newPath);
  if (oldNorm === null || newNorm === null) return { invalid: true };
  if (oldNorm === newNorm) {
    return {
      moves: [],
      nextDeliberate: [...deliberateFolders],
      deliberateRewritten: 0,
    };
  }
  const oldKey = foldSegment(oldNorm);

  const moves: Array<{ noteId: string; newFolder: string }> = [];
  for (const n of notes) {
    if (n.folder === null) continue;
    const norm = normalizeFolderPath(n.folder);
    if (norm === null || !foldSegment(norm).startsWith(oldKey)) continue;
    moves.push({ noteId: n.noteUuid, newFolder: newNorm + norm.slice(oldNorm.length) });
  }

  let deliberateRewritten = 0;
  const nextDeliberate: string[] = [];
  for (const f of deliberateFolders) {
    const norm = normalizeFolderPath(f);
    if (norm !== null && foldSegment(norm).startsWith(oldKey)) {
      deliberateRewritten++;
      nextDeliberate.push(newNorm + norm.slice(oldNorm.length));
    } else {
      nextDeliberate.push(f);
    }
  }
  return { moves, nextDeliberate, deliberateRewritten };
}

/**
 * Rename `oldPath` → `newPath`. Bulk-moves every note under the old prefix
 * (best-effort, `Promise.allSettled` — folder-move is not correctness-critical
 * per Q4, so a partial failure is reported, not rolled back) and prefix-rewrites
 * the deliberate_folders set in a single prefs write (only when something
 * matched). Never blocks; reports moved/failed.
 */
export async function renameFolder(
  oldPath: string,
  newPath: string,
  notes: ReadonlyArray<{ noteUuid: string; folder: string | null }>,
  deliberateFolders: readonly string[],
): Promise<FolderRenameResult> {
  const plan = planFolderRename(oldPath, newPath, notes, deliberateFolders);
  if ("invalid" in plan) {
    return {
      moved: [],
      failed: [],
      deliberateRewritten: 0,
      nextDeliberate: [...deliberateFolders],
      invalid: true,
    };
  }

  const settled = await Promise.allSettled(
    plan.moves.map((m) => moveNote(m.noteId, m.newFolder)),
  );
  const moved: string[] = [];
  const failed: Array<{ noteId: string; error: unknown }> = [];
  settled.forEach((outcome, i) => {
    const noteId = plan.moves[i]?.noteId ?? "";
    if (outcome.status === "fulfilled") moved.push(noteId);
    else failed.push({ noteId, error: outcome.reason });
  });

  if (plan.deliberateRewritten > 0) {
    await setDeliberateFolders(plan.nextDeliberate);
  }

  return {
    moved,
    failed,
    deliberateRewritten: plan.deliberateRewritten,
    nextDeliberate: plan.nextDeliberate,
  };
}
