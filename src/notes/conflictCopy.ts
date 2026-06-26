// Conflict-copy materialization (MYND-424 task 7 / MYND-427) — the TS side of
// the engine's keep-both resolution (SYNC-11). When the engine decides two
// concurrent body edits both survive, the *remote* revision is materialized as a
// new `.myn` note carrying the managed frontmatter `conflict: true` +
// `conflict_of: <original-uuid>`. The original note is left untouched; both
// survive. MYND-427's Conflicts view groups copies by `conflict_of:`.
//
// TS orchestrator over the generic `patchFrontmatterField` surgery + the existing
// `note_create` IPC — exactly like `trashNote`/`archiveNote` (no backend command,
// no ACL change; the markers ride the existing `.myn` envelope).

import { patchFrontmatterField } from "../dialect";
import { invoke } from "@tauri-apps/api/core";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Build the conflict-copy content: the remote body with `conflict: true` +
 * `conflict_of: <originalUuid>` added to its frontmatter (composing onto any
 * frontmatter the body already carries). Pure — unit-tested.
 */
export function buildConflictCopyContent(remoteBody: string, originalUuid: string): string {
  const withConflict = patchFrontmatterField(encoder.encode(remoteBody), "conflict", "true");
  const withBoth = patchFrontmatterField(withConflict, "conflict_of", originalUuid);
  return decoder.decode(withBoth);
}

/**
 * Materialize a keep-both conflict copy as a new note (the engine's
 * `ConflictCopyPlan` executed): create a fresh `.myn` carrying the remote body +
 * the conflict markers. Returns the new note id. The original note is untouched.
 */
export async function createConflictCopy(
  remoteBody: string,
  originalUuid: string,
): Promise<string> {
  const content = buildConflictCopyContent(remoteBody, originalUuid);
  return invoke<string>("plugin:notes|note_create", { plaintext: content });
}

/**
 * Resolve a conflict copy by clearing its `conflict:` markers ("keep both as
 * separate notes" — the copy becomes an ordinary note). Returns the cleared
 * content for the caller to `note_update`.
 */
export function clearConflictMarkers(content: string): string {
  const noConflict = patchFrontmatterField(encoder.encode(content), "conflict", null);
  const cleared = patchFrontmatterField(noConflict, "conflict_of", null);
  return decoder.decode(cleared);
}
