// `moveNote` — change a note's virtual folder by rewriting the `folder:`
// frontmatter field, plus `bulkMoveNotes` for multi-select moves.
//
// `folder:` is the 3rd Myne-managed canonical FM field (markdown-dialect
// §3.6.1); its write trigger is create (`createNote`) + move (here). Move
// reads the note, rewrites `folder:` via `patchFolderField` (set = states
// A/B/C; `null` = move-to-root = state D delete), bumps `updated:` (move is
// a modification), and re-encrypts via `noteUpdate`. Parallel to
// `renameNote.ts` (2026-05-15 src/notes orchestration discipline) — the only
// authorized post-create writer of `folder:`.
//
// Grill 2026-05-29 Q4 (folder-move is NOT correctness-critical for wikilink
// resolution → no transactional batch needed) + Q8 (bulk = N independent
// best-effort moves; partial-fail is benign, reuse the vault_delete
// 2026-05-26 one-shot-best-effort + remaining-count idiom).
//
// NOTE: `moveNote` reads the current on-disk bytes (the sidebar drag-move
// knows only the noteId + target). If the note is open in the editor with
// unsaved edits, the autosave window (≤1s idle) usually means disk is
// current; a move issued mid-edit before autosave settles would re-encrypt
// the last-saved body. Acceptable for v1.0 (rare; moving an actively-edited
// note); a future editor↔move coordination is a UI concern, not this helper's.

import { patchFolderField, patchUpdatedField } from "../dialect";
import { normalizeFolderPath } from "../dialect/folderPath";
import { noteRead } from "./readNote";
import { noteUpdate } from "./updateNote";
import { reindexNoteFromBody } from "./vaultIndices";
import { mutateDeliberateFolders } from "../lib/prefs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Move a note to `folder` (canonical or raw path — normalized here) or to the
 * vault root (`folder === null`). Reads the note, rewrites `folder:`, bumps
 * `updated:`, and re-encrypts. Rejects with whatever `noteRead` / `noteUpdate`
 * propagate (IPC error shapes).
 */
export async function moveNote(
  noteId: string,
  folder: string | null,
): Promise<void> {
  registerDestination([await moveNoteWithoutRegistering(noteId, folder)]);
}

/**
 * The move itself, with no folder registration. Callers that move MANY notes use
 * this and register once (see {@link registerDestination}).
 *
 * Returns the normalized destination, so the caller has the value to register
 * without re-normalizing it.
 */
async function moveNoteWithoutRegistering(
  noteId: string,
  folder: string | null,
): Promise<string | null> {
  const current = await noteRead(noteId);
  const norm = normalizeFolderPath(folder);
  const moved = patchFolderField(encoder.encode(current), norm);
  const stamped = patchUpdatedField(moved, new Date().toISOString());
  const next = decoder.decode(stamped);
  await noteUpdate(noteId, next);
  // MYND-31: the folder changed → re-index (live, decrypt-free) so
  // collision-disambiguation tracks the new folder. Best-effort.
  void reindexNoteFromBody(noteId, next);
  return norm;
}

/**
 * myne-md/myne#613: register a destination folder, once.
 *
 * ADD only and fire-and-forget: it can never claim a removal, so a failure costs
 * at most that the folder is not remembered yet. The folder a note LEFT is
 * deliberately not touched, because leaving is not deleting.
 *
 * Split out of {@link moveNote} so a bulk move pays ONE prefs write rather than
 * one per note. Each write re-encrypts the whole `vault.prefs` blob and bumps
 * the nonce, so fifty notes into one folder was fifty re-encrypts of a blob that
 * changes once.
 */
function registerDestination(folders: Array<string | null>): void {
  const unique = [...new Set(folders.filter((f): f is string => f !== null))];
  if (unique.length === 0) return;
  void mutateDeliberateFolders({ add: unique }).catch(() => {});
}

/** Outcome of a {@link bulkMoveNotes} call — moved IDs + per-note failures. */
export interface BulkMoveResult {
  /** Note IDs that moved successfully. */
  moved: string[];
  /** Note IDs that failed, with the propagated IPC error. */
  failed: Array<{ noteId: string; error: unknown }>;
}

/**
 * Move many notes to the same `folder` (or root). Each note is an independent
 * `moveNote` fired via `Promise.allSettled` — folder-move is not
 * correctness-critical (Q4), so a partial failure is benign: successful moves
 * stand, failures are reported for a retry prompt (no transactional rollback,
 * no batch journal). Never rejects; surfaces results via {@link BulkMoveResult}.
 */
export async function bulkMoveNotes(
  noteIds: string[],
  folder: string | null,
): Promise<BulkMoveResult> {
  const settled = await Promise.allSettled(
    noteIds.map((id) => moveNoteWithoutRegistering(id, folder)),
  );
  const moved: string[] = [];
  const failed: Array<{ noteId: string; error: unknown }> = [];
  const destinations: Array<string | null> = [];
  settled.forEach((outcome, i) => {
    const noteId = noteIds[i] ?? "";
    if (outcome.status === "fulfilled") {
      moved.push(noteId);
      destinations.push(outcome.value);
    } else {
      failed.push({ noteId, error: outcome.reason });
    }
  });
  // ONE write for the whole operation, and only for the notes that actually
  // landed: a bulk that failed entirely registers nothing (myne-md/myne#613
  // task 5). The destinations come from the fulfilled moves rather than from
  // the `folder` argument, so the registered path is the NORMALIZED one the
  // note now carries, which is the identity the sidebar reads back.
  registerDestination(destinations);
  return { moved, failed };
}
