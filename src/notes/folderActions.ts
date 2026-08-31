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
import { mutateDeliberateFolders, type SetMutation } from "../lib/prefs";
import { isBatchCommitted } from "../types/note-batch-error";
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
  /**
   * The folded, trailing-slash key the plan matched on, or `null` for a root
   * no-op.
   *
   * Carried rather than recomputed, because `persistFolderDelete` hands it to
   * the core as a prefix verb and has to match on exactly the key the planner
   * used. Deciding the fold in two places is how a prefix match starts
   * disagreeing with the set it is filtering.
   *
   * **`null` rather than `""` for the root case, and that is the fix rather than
   * the style.** This field was an empty string, and the disk-side filter that
   * consumed it did `foldSegment(norm).startsWith(plan.removedKey)`.
   * `String.prototype.startsWith("")` is true for every input, so the sentinel
   * meant to match NOTHING matched EVERYTHING: a root plan sent a removal for
   * the entire stored set, and since `deliberate_folders` syncs, every empty
   * folder in the vault would have gone on every device. Only the caller's habit
   * of passing a `FolderNode.path` kept it latent. `null` makes the case
   * unrepresentable instead of relying on a reader to notice.
   */
  removedKey: string | null;
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
/**
 * Every note id under `node`, INCLUDING each folder's own folder note.
 *
 * MYND-599: `FolderNode.noteIds` deliberately EXCLUDES `indexNoteId` — the
 * folder note is hidden from the sidebar so it does not render as a row inside
 * its own folder. Walking `noteIds` alone therefore collected everything except
 * the one note that keeps the folder alive: the delete soft-trashed the
 * subtree, the folder note stayed, the folder still had a note, and the derived
 * tree re-materialised it. To the user, "delete the folder → confirm → nothing
 * happens; the folder stays" — which is why archive-then-trash was the only
 * path that worked.
 *
 * Conflict claimants that LOST the index tiebreak are already in `noteIds`
 * (only the winner is hidden), so `indexNoteId` is the sole addition.
 */
function collectSubtreeNoteIds(node: FolderNode): string[] {
  const ids = [...node.noteIds];
  if (node.indexNoteId !== null) ids.push(node.indexNoteId);
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
    return {
      noteIds: [],
      nextDeliberate: [...deliberateFolders],
      removed: [],
      removedKey: null,
    };
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
  return { noteIds, nextDeliberate, removed, removedKey: targetKey };
}

/**
 * Persist the trimmed deliberate set for a planned folder delete. Note-trashing
 * + cache-sync is the caller's job (it needs the sidebar cache); this helper
 * only writes the deliberate_folders set. Rejects with whatever
 * {@link mutateDeliberateFolders} propagates.
 *
 * **The removal is stated as a PREFIX and resolved by the core**, not derived
 * here. The planner's `removed` is computed from the caller's React state, and
 * that state stopped being authoritative when myne#613 gave `deliberate_folders`
 * four fire-and-forget writers (a note created into a folder, a note moved into
 * one, a bulk move, the boot back-fill). The hook catches up only through a
 * nonce bump, so a delete issued inside that window states no removal for the
 * just-registered entry: the registration survives on disk and the folder the
 * user deleted comes back, empty and permanent, at the next unlock, and it comes
 * back on EVERY device, because the surviving entry carries a newer add clock
 * than the removal. That is this issue's own defect inverted.
 *
 * An earlier fix re-read `prefsRead()` here and filtered it. That was better and
 * still wrong in two ways the review named: the read and the write are two IPC
 * round trips, so an at-fill add landing between them survives the delete; and
 * it has to be written once per client per operation, which is four copies of a
 * prefix rule and the twin drift that comes with them. The core resolves the
 * prefix inside the prefs write mutex, once, for both clients.
 *
 * `plan.removed` is still the right value for the OPTIMISTIC state the sidebar
 * renders; it is only the write that must not trust it.
 *
 * A root plan carries `removedKey: null` and writes nothing. It is not expressed
 * as an empty prefix, because an empty prefix is a prefix of everything.
 */
export async function persistFolderDelete(
  plan: FolderDeletePlan,
): Promise<void> {
  if (plan.removedKey === null) return;
  await mutateDeliberateFolders({ removePrefix: [plan.removedKey] });
}

// ---- folder archive (folder-archive) ----------------------------------
//
// Folder-archive is a pure `archived_folders` prefs-set mutation — NO note
// frontmatter is rewritten (unlike delete, which soft-trashes the subtree, or
// note-archive, which patches each note's `archived:` marker). These planners
// keep the archived-set transform ISOLATED from `planFolderDelete` /
// `planFolderRenameBatch` (whose signatures + vectors stay stable); the caller
// composes them with delete/rename in `useFolderManagement`.

export type FolderArchivePlan = {
  /** The archived_folders set after adding the target (folded-subsumed). */
  nextArchived: string[];
  /** Every note in the target subtree — for the caller's deselect-if-open UX
   *  ONLY. Folder-archive writes NO note frontmatter. */
  noteIds: string[];
};

/**
 * Compute a folder archive. Pure — no IPC. Adds the target's canonical path to
 * the archived_folders set and drops any existing entry subsumed by it (a
 * descendant of the target). A no-op set-change if an archived ancestor (or the
 * target itself) already covers the target. Root (absent) is a no-op.
 */
export function planFolderArchive(
  targetPath: string,
  tree: FolderTree,
  archivedFolders: readonly string[],
): FolderArchivePlan {
  const normalized = normalizeFolderPath(targetPath);
  if (normalized === null) {
    return { nextArchived: [...archivedFolders], noteIds: [] };
  }
  const targetKey = foldSegment(normalized); // trailing-slash folded form

  const node = findNode(tree.roots, targetKey);
  const noteIds = node ? collectSubtreeNoteIds(node) : [];

  // Already covered by the target itself or an archived ancestor → set unchanged.
  const covered = archivedFolders.some((f) => {
    const norm = normalizeFolderPath(f);
    const key = norm === null ? "" : foldSegment(norm);
    return key.length > 0 && targetKey.startsWith(key);
  });
  if (covered) {
    return { nextArchived: [...archivedFolders], noteIds };
  }

  // Keep every entry that is NOT a descendant of the target (subsume descendants),
  // then add the target. targetKey ends with "/", so `startsWith` is sibling-safe.
  const next: string[] = [];
  for (const f of archivedFolders) {
    const norm = normalizeFolderPath(f);
    const key = norm === null ? "" : foldSegment(norm);
    if (!key.startsWith(targetKey)) next.push(f);
  }
  next.push(normalized);
  return { nextArchived: next, noteIds };
}

/**
 * Remove `targetPath` and every archived descendant from the archived_folders
 * set (folded-prefix cascade). Pure. Used by folder RESTORE (Archive panel) and
 * by folder DELETE (a deleted folder's archived entries go with it). Root
 * (absent) is a no-op.
 */
export function planFolderUnarchive(
  targetPath: string,
  archivedFolders: readonly string[],
): string[] {
  const normalized = normalizeFolderPath(targetPath);
  if (normalized === null) return [...archivedFolders];
  const targetKey = foldSegment(normalized);
  return archivedFolders.filter((f) => {
    const norm = normalizeFolderPath(f);
    const key = norm === null ? "" : foldSegment(norm);
    return !key.startsWith(targetKey);
  });
}

/**
 * Re-root the archived_folders set for a folder rename `oldPath` → `newPath`
 * (folded-prefix, the SAME subtree selection as the deliberate re-root in
 * {@link planFolderRenameBatch}). Pure. Returns the rewritten set + the count
 * changed (0 → the caller skips the write). Without this, renaming an ancestor
 * of an archived folder would leave a stale entry → the subtree silently
 * un-archives.
 */
export function rerootArchivedFolders(
  oldPath: string,
  newPath: string,
  archivedFolders: readonly string[],
): { next: string[]; rewritten: number } {
  const oldNorm = normalizeFolderPath(oldPath);
  const newNorm = normalizeFolderPath(newPath);
  if (oldNorm === null || newNorm === null || oldNorm === newNorm) {
    return { next: [...archivedFolders], rewritten: 0 };
  }
  const oldKey = foldSegment(oldNorm);
  let rewritten = 0;
  const next = archivedFolders.map((f) => {
    const norm = normalizeFolderPath(f);
    if (norm !== null && foldSegment(norm).startsWith(oldKey)) {
      rewritten++;
      return newNorm + norm.slice(oldNorm.length);
    }
    return f;
  });
  return { next, rewritten };
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
  /**
   * The `deliberate_folders` write failed, AFTER the rename committed.
   *
   * Reported as a value for the same reason the post-commit batch case is: past
   * the commit, throwing tells the caller a rename that is on disk did not
   * happen, and it skips the decoration and `archived_folders` re-rooting that
   * still have to run. Those live in `vault.prefs` and nothing reconciles them
   * later, so the subtree silently un-archives at the next unlock. The caller
   * finishes the re-rooting and reports THIS separately.
   */
  deliberateWriteFailed?: boolean;
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
      /**
       * The deliberate-set change this rename makes, as ONE prefix verb the core
       * resolves against the stored set.
       *
       * It used to be `mutationFrom(deliberateFolders, nextDeliberate)`, a delta
       * over the caller's own React copy, and the review found the same hole the
       * delete had: an entry one of the four fire-and-forget at-fill writers put
       * on disk, or one a peer landed, is in neither side, so it is neither
       * re-rooted nor removed and stays under the OLD path. The renamed-away
       * folder then reappears empty at the next unlock, which this file's own
       * retry loop already describes as "an empty folder that reappears under
       * the old name at every unlock and that no rename can clear".
       *
       * As one verb it is also atomic under the byte budget. As a remove plus an
       * add it could half-apply, landing the removals, stamping each as a
       * deletion that propagates to every device, and refusing the additions,
       * which turns a rename into a synchronised delete.
       */
      deliberateMutation: SetMutation;
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

  return {
    batch,
    movedIds,
    inboundIds,
    nextDeliberate,
    deliberateRewritten,
    // A no-op rename states nothing. Everything else states the subtree once and
    // lets the core resolve it against what is actually stored.
    deliberateMutation:
      oldNorm === newNorm
        ? {}
        : { renamePrefix: [{ from: oldKey, to: newNorm }] },
  };
}

/**
 * Rename `oldPath` → `newPath`. Reads every note's body, plans the combined
 * folder-move + inbound folder-target rewrite batch ({@link planFolderRenameBatch}),
 * and commits it **all-or-nothing** via the transactional write primitive
 * (MYND-370 / WL-7) — so a folder-target link (`[[Old/]]`) can never be left
 * dangling by a half-applied rename. On a PRE-commit batch failure the vault is
 * unchanged and the failure is reported (the helper itself never throws); a
 * post-commit one (`CommittedPendingPublish`) is treated as the success it is,
 * because the backend finishes publishing at the next vault open (myne#300).
 * Then prefix-rewrites the deliberate set and best-effort re-indexes the moved
 * notes.
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
      // myne#300 — "the vault is unchanged" is true for every rejection EXCEPT
      // a post-commit one. Past the `.rename-journal` marker the batch is
      // committed and the backend publishes the remainder at the next vault
      // open, so reporting the whole set as failed here would (a) tell the user
      // a folder rename that is on disk did not happen, and (b) skip the
      // deliberate-folder rewrite and the re-index, leaving those two out of
      // step with the notes for good — the recovery pass republishes blobs, it
      // does not rerun this function.
      if (!isBatchCommitted(error)) {
        // All-or-nothing: the vault is unchanged, so report the whole set as
        // failed and write nothing else (deliberate set, re-index) — keeping
        // the rename atomic at the orchestrator level too.
        return {
          moved: [],
          failed: changedIds.map((noteId) => ({ noteId, error })),
          deliberateRewritten: 0,
          nextDeliberate: [...deliberateFolders],
        };
      }
    }
  }

  // Past the commit, so a failure here is REPORTED rather than thrown. The
  // rename is on disk; the caller still owes the decoration and
  // `archived_folders` re-rooting, and a throw would skip both while telling the
  // user nothing happened.
  let deliberateWriteFailed = false;
  if (plan.deliberateRewritten > 0) {
    // Retried ONCE before it is reported, and the retry is the difference
    // between a recoverable state and a permanent one. A second rename cannot
    // fix this later: `planFolderRenameBatch` keys its rewrite off the folder's
    // CURRENT path, and after a relaunch the stale entry is under the OLD one,
    // so `deliberateRewritten` comes back 0 and this block does not even run.
    // The residue is an empty folder that reappears under the old name at every
    // unlock and that no rename can clear.
    //
    // The refusal count this returns is not read, and that is now sound rather
    // than an oversight: the mutation is a single `renamePrefix`, the byte
    // budget refuses only ADDITIONS, and a re-root adds nothing. It was NOT
    // sound while this passed a remove-plus-add pair, where a refusal dropped
    // the additions, landed the removals, and left `deliberateWriteFailed`
    // false, so the user was told nothing at all.
    try {
      await mutateDeliberateFolders(plan.deliberateMutation);
    } catch {
      try {
        await mutateDeliberateFolders(plan.deliberateMutation);
      } catch {
        // A flag, not the error. Nothing downstream reads it, the sentence the
        // caller renders is fixed, and `unknown` invited a reader to think
        // otherwise. It also made the discriminator `!== undefined`, which
        // reports SUCCESS for a rejection carrying `undefined`.
        deliberateWriteFailed = true;
      }
    }
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
    deliberateWriteFailed,
  };
}
