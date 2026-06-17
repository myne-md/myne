// Folder-management actions (MYND-144 Task 8): folder delete + rename.
//
// Folder delete soft-trashes its subtree (2026-06-09 — supersedes the
// 2026-05-29 "non-empty-folder-delete is blocked (no v0.1 trash)" pin). Now that
// vault-internal soft-trash exists (MYND-133, 2026-06-03), deleting a non-empty
// folder is no longer blocked: `planFolderDelete` collects every note in the
// target subtree so the caller can soft-trash them (recoverable from the Trash
// panel) and cascade-removes the matching deliberate_folders entries — a cold
// prefs-set write, no re-encrypt. Ancestors that were only ancestor-derived
// vanish naturally from the next tree derivation (they were never in the set).
// Deleting a note-empty folder yields an empty `noteIds`, so the caller skips
// the trash step and only trims the deliberate set — the pre-2026-06-09 path.

import { patchFolderField, patchUpdatedField } from "../dialect";
import { foldSegment, normalizeFolderPath } from "../dialect/folderPath";
import { setDeliberateFolders } from "../lib/prefs";
import {
  noteWriteBatchTransactional,
  type NoteBatchEntry,
} from "./noteWriteBatch";
import { noteRead } from "./readNote";
import { renameFlushHooks } from "./renameFlushHook";
import { applyInboundRewrites } from "./renameInbound";
import { planInboundFolderRewrites } from "./renameWikilinks";
import { reindexNoteFromBody } from "./vaultIndices";
import type { FolderNode, FolderTree } from "./folderTree";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type FolderDeletePlan = {
  /** Every note in the target subtree (itself + descendants) — to soft-trash. */
  noteIds: string[];
  /** The deliberate_folders set after dropping the target + deliberate descendants. */
  nextDeliberate: string[];
  /** The deliberate entries dropped (target + deliberate descendants). */
  removed: string[];
};

function findNode(nodes: readonly FolderNode[], key: string): FolderNode | null {
  for (const n of nodes) {
    if (n.key === key) return n;
    const hit = findNode(n.children, key);
    if (hit) return hit;
  }
  return null;
}

/** Every note in `node`'s subtree (itself + all descendants), pre-order. */
function collectSubtreeNoteIds(node: FolderNode): string[] {
  const ids = [...node.noteIds];
  for (const child of node.children) ids.push(...collectSubtreeNoteIds(child));
  return ids;
}

/**
 * Compute a folder delete. Pure — no IPC. Collects the target subtree's notes
 * (the caller soft-trashes them; an empty list = a note-empty folder) and
 * filters the deliberate set by folded-path prefix so the target and every
 * deliberate descendant drop in one pass, while siblings and deliberate
 * ancestors are preserved. Root (absent) is a no-op.
 */
export function planFolderDelete(
  targetPath: string,
  tree: FolderTree,
  deliberateFolders: readonly string[],
): FolderDeletePlan {
  const normalized = normalizeFolderPath(targetPath);
  // Root (absent) is not a deletable folder — no-op, nothing removed.
  if (normalized === null) {
    return { noteIds: [], nextDeliberate: [...deliberateFolders], removed: [] };
  }
  const targetKey = foldSegment(normalized); // trailing-slash folded form

  const node = findNode(tree.roots, targetKey);
  const noteIds = node ? collectSubtreeNoteIds(node) : [];

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
  return { noteIds, nextDeliberate, removed };
}

/**
 * Persist the trimmed deliberate set for a planned folder delete. Note-trashing
 * + cache-sync is the caller's job (it needs the sidebar cache); this helper
 * only writes the cold deliberate_folders set. Rejects with whatever
 * {@link setDeliberateFolders} propagates.
 */
export async function persistFolderDelete(
  plan: FolderDeletePlan,
): Promise<void> {
  await setDeliberateFolders(plan.nextDeliberate);
}

// ---- folder rename ----------------------------------------------------

export type FolderRenameResult = {
  moved: string[];
  failed: Array<{ noteId: string; error: unknown }>;
  deliberateRewritten: number;
  /** The deliberate_folders set after the rename — for the UI to refresh local state. */
  nextDeliberate: string[];
  /** True when the rename was rejected before any work (root source/target). */
  invalid?: boolean;
};

/** A note with its decrypted body — the input the transactional rename planner
 *  needs to rewrite inbound folder-target links (MYND-370). */
export interface FolderRenameNote {
  noteUuid: string;
  folder: string | null;
  body: string;
}

export type FolderRenameBatchPlan =
  | { invalid: true }
  | {
      /** Notes whose plaintext changed (folder-move and/or inbound rewrite),
       *  ready for the all-or-nothing transactional write. */
      batch: NoteBatchEntry[];
      /** Notes whose `folder:` was re-rooted under the new prefix. */
      movedIds: string[];
      /** Notes whose body carried inbound `[[Old/]]` links that were rewritten. */
      inboundIds: string[];
      nextDeliberate: string[];
      deliberateRewritten: number;
    };

/**
 * Plan the FULL transactional batch for renaming `oldPath` → `newPath` (MYND-370,
 * grill Q7): the per-note `folder:` re-rooting **and** the inbound folder-target
 * (`[[Old/]]`) wikilink rewrites, combined into one all-or-nothing batch. Pure —
 * no IPC; the caller reads bodies, writes the batch, and persists the deliberate
 * set. Unlike the legacy best-effort folder-move model (Q4: folder moves are not
 * correctness-critical), folder-target links DO break on rename — the
 * folder path IS their resolution key — so this path lifts folder rename to the
 * same transactional parity note-title rename already has (WL-7/WL-8).
 *
 * For each note: inbound links are rewritten first (on the original body, so the
 * lezer offsets stay valid), then the `folder:` move + `updated:` bump are applied
 * to the rewritten text (frontmatter surgery is offset-independent). A note that
 * neither moves nor carries an inbound link is omitted from the batch.
 */
export function planFolderRenameBatch(
  oldPath: string,
  newPath: string,
  notes: ReadonlyArray<FolderRenameNote>,
  deliberateFolders: readonly string[],
  nowIso: string,
): FolderRenameBatchPlan {
  const oldNorm = normalizeFolderPath(oldPath);
  const newNorm = normalizeFolderPath(newPath);
  if (oldNorm === null || newNorm === null) return { invalid: true };

  const oldKey = foldSegment(oldNorm);
  const batch: NoteBatchEntry[] = [];
  const movedIds: string[] = [];
  const inboundIds: string[] = [];

  // A no-op rename (source === target) changes nothing but is not invalid.
  if (oldNorm !== newNorm) {
    for (const n of notes) {
      let text = n.body;

      // 1. Inbound folder-target rewrites (on the original body — offsets valid).
      const inbound = planInboundFolderRewrites(text, {
        oldFolder: oldNorm,
        newFolder: newNorm,
      });
      const inboundChanged = inbound.length > 0;
      if (inboundChanged) {
        text = applyInboundRewrites(text, inbound);
        inboundIds.push(n.noteUuid);
      }

      // 2. `folder:` re-root for notes in the renamed subtree (+ updated: bump).
      const norm = normalizeFolderPath(n.folder);
      const moved = norm !== null && foldSegment(norm).startsWith(oldKey);
      if (moved) {
        const newFolder = newNorm + norm!.slice(oldNorm.length);
        let bytes = patchFolderField(encoder.encode(text), newFolder);
        bytes = patchUpdatedField(bytes, nowIso);
        text = decoder.decode(bytes);
        movedIds.push(n.noteUuid);
      }

      if (inboundChanged || moved) {
        batch.push({ noteId: n.noteUuid, plaintext: text });
      }
    }
  }

  // Prefix-rewrite the deliberate set (same folded-prefix subtree selection).
  // A no-op rename (handled above) leaves the set untouched.
  let deliberateRewritten = 0;
  const nextDeliberate: string[] = [];
  for (const f of deliberateFolders) {
    const norm = normalizeFolderPath(f);
    if (oldNorm !== newNorm && norm !== null && foldSegment(norm).startsWith(oldKey)) {
      deliberateRewritten++;
      nextDeliberate.push(newNorm + norm.slice(oldNorm.length));
    } else {
      nextDeliberate.push(f);
    }
  }

  return { batch, movedIds, inboundIds, nextDeliberate, deliberateRewritten };
}

/**
 * Rename `oldPath` → `newPath`. Reads every note's body, plans the combined
 * folder-move + inbound folder-target rewrite batch ({@link planFolderRenameBatch}),
 * and commits it **all-or-nothing** via the transactional write primitive
 * (MYND-370 / WL-7) — so a folder-target link (`[[Old/]]`) can never be left
 * dangling by a half-applied rename. On any batch failure the vault is unchanged
 * and the failure is reported (the helper itself never throws). Then prefix-
 * rewrites the deliberate set and best-effort re-indexes the moved notes.
 *
 * `notes` carries every note (id + folder) — all bodies are scanned because an
 * inbound `[[Old/]]` link may live in ANY note, not only the moved ones.
 */
export async function renameFolder(
  oldPath: string,
  newPath: string,
  notes: ReadonlyArray<{ noteUuid: string; folder: string | null }>,
  deliberateFolders: readonly string[],
): Promise<FolderRenameResult> {
  if (normalizeFolderPath(oldPath) === null || normalizeFolderPath(newPath) === null) {
    return {
      moved: [],
      failed: [],
      deliberateRewritten: 0,
      nextDeliberate: [...deliberateFolders],
      invalid: true,
    };
  }

  // WL-8 open-dirty pre-flight (parity with note-title rename, `renameInbound.ts`).
  // The transactional batch reads bodies from DISK and writes them back, so every
  // open pane with unsaved edits MUST be flushed first — otherwise a note open
  // while its folder (or a folder it links to) is renamed would be read stale and
  // its in-memory edits silently clobbered by the commit. The folder path reads
  // EVERY note (an inbound `[[Old/]]` can live anywhere), so this gate matters
  // more here than for title rename, not less.
  await renameFlushHooks().flushOpenPanes();

  // Read every note body (best-effort): a note that fails to read is skipped —
  // it simply does not participate in the rewrite, never aborting the rename.
  const withBodies: FolderRenameNote[] = [];
  await Promise.all(
    notes.map(async (n) => {
      try {
        withBodies.push({ ...n, body: await noteRead(n.noteUuid) });
      } catch {
        /* unreadable note — excluded from the batch */
      }
    }),
  );

  const plan = planFolderRenameBatch(
    oldPath,
    newPath,
    withBodies,
    deliberateFolders,
    new Date().toISOString(),
  );
  if ("invalid" in plan) {
    return {
      moved: [],
      failed: [],
      deliberateRewritten: 0,
      nextDeliberate: [...deliberateFolders],
      invalid: true,
    };
  }

  const changedIds = [...new Set([...plan.movedIds, ...plan.inboundIds])];

  if (plan.batch.length > 0) {
    try {
      await noteWriteBatchTransactional(plan.batch);
    } catch (error) {
      // All-or-nothing: the vault is unchanged, so report the whole set as
      // failed and write nothing else (deliberate set, re-index) — keeping the
      // rename atomic at the orchestrator level too.
      return {
        moved: [],
        failed: changedIds.map((noteId) => ({ noteId, error })),
        deliberateRewritten: 0,
        nextDeliberate: [...deliberateFolders],
      };
    }
  }

  if (plan.deliberateRewritten > 0) {
    await setDeliberateFolders(plan.nextDeliberate);
  }

  // The folder changed on the moved notes → re-index (live, decrypt-free) so
  // collision-disambiguation tracks the new folder. Best-effort, post-commit.
  const movedSet = new Set(plan.movedIds);
  for (const entry of plan.batch) {
    if (movedSet.has(entry.noteId)) {
      void reindexNoteFromBody(entry.noteId, entry.plaintext);
    }
  }

  return {
    moved: changedIds,
    failed: [],
    deliberateRewritten: plan.deliberateRewritten,
    nextDeliberate: plan.nextDeliberate,
  };
}
