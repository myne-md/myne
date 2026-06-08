// IPC wrappers + lifecycle drivers for the attachment reference-graph
// reconcile (MYND-169 / MYND-170, SYNC-6).
//
// The TS half of the in-RAM `attachment-id → {referencing note-ids}`
// graph the Rust host owns (`plugins/attachments/reconcile.rs` +
// `reconcile_commands.rs`). Build-B, the same pattern as `vaultIndices.ts`:
// dialect extraction is TS-side via the SINGLE shared `extractAttachmentIds`
// tokenizer (`notes/attachmentRef.ts` — the twin of the Rust
// `extract_att_ids`, kept in lockstep per SYNC-6), so the host commands
// receive already-extracted ids and never parse markdown.
//
// Drives:
//   - `applyNoteAttachmentRefs(id, body)` — replace-on-apply a note's
//     referenced ids; called on the SAME lifecycle events that re-index
//     VaultIndices (rebuild-on-unlock sweep + save / create / rename-move),
//     piggybacked from `vaultIndices.ts` so the two indices stay coherent.
//   - `removeNoteAttachmentRefs(id)` — drop a hard-deleted note.
//   - `referencingNotes(attachmentId)` — the "used in N notes" query
//     (count = `.length`) + the delete-warning's note list.
//
// Best-effort, fire-and-forget at the lifecycle call sites: a reconcile
// hiccup must never affect a note save (it self-heals on the next
// rebuild-on-unlock sweep), exactly like the VaultIndices reindex calls.

import { invoke } from "@tauri-apps/api/core";
import { extractAttachmentIds } from "./attachmentRef";

/**
 * Replace the set of attachment-ids a note references (replace-on-apply).
 * Tokenizes `body` with the shared `extractAttachmentIds` (the lockstep
 * twin of the Rust `extract_att_ids`), then pushes the ids to the host.
 * Best-effort — a parse/IPC failure is swallowed and self-healed by the
 * next reconcile sweep.
 */
export async function applyNoteAttachmentRefs(
  noteId: string,
  body: string,
): Promise<void> {
  try {
    const attachmentIds = extractAttachmentIds(body);
    await invoke<void>("plugin:attachments|attachment_refs_apply", {
      noteId,
      attachmentIds,
    });
  } catch {
    // Best-effort — self-healed by a later apply / the next reconcile.
  }
}

/**
 * Drop a hard-deleted note from the reference graph (no-op if absent).
 * Trash does NOT route here — a trashed note's references stay in the graph
 * and are filtered TS-side via the live id-set, mirroring the VaultIndices
 * trash posture (`isTrashed`). Best-effort.
 */
export async function removeNoteAttachmentRefs(noteId: string): Promise<void> {
  try {
    await invoke<void>("plugin:attachments|attachment_refs_remove", { noteId });
  } catch {
    // Best-effort — self-healed by the next reconcile.
  }
}

/**
 * The note-ids referencing `attachmentId`, sorted for determinism. The
 * library reads `.length` for the "used in N notes" badge and renders the
 * array as the clickable referencing-note list; the delete-warning names
 * them. Returns `[]` when unreferenced (or on a host-side error — the
 * caller treats "unknown" as "no known references", erring toward showing
 * the warning's count as 0 rather than blocking).
 */
export async function referencingNotes(attachmentId: string): Promise<string[]> {
  try {
    return await invoke<string[]>(
      "plugin:attachments|attachment_refs_referencing",
      { attachmentId },
    );
  } catch {
    return [];
  }
}
