// `setNoteCover` — set (or clear) a note's cover-image frontmatter property
// without opening it in the editor.
//
// Mirrors `moveNote.ts` exactly (the canonical "patch one FM field on a closed
// note" orchestration, `decisions.md` 2026-05-15): read the note, rewrite the
// target property via `patchFrontmatterField`, bump `updated:`, re-encrypt via
// `noteUpdate`, then `reindexNoteFromBody` so the live property index — and any
// open cards view reading it — refreshes (the reindex chokepoint bumps the
// index nonce; `useViewResult` re-runs and the card's cover appears at once).
//
// This writes TWO things through one parameterised path, and the difference
// matters to the reader:
//
//   - `propertyKey === "cover"` (the `COVER_FIELD_KEY` constant) is the
//     Myne-managed CANONICAL field, `markdown-dialect.md` §3.6.1, which names
//     this file as its writer. Its read is value-strict (`readCoverValue`).
//   - any other key is the saved view's own `image` property, an ordinary user
//     property, read leniently by `resolveCoverAttachmentId` (viewLayout.ts).
//
// The two grammars are deliberately different and §3.6.1 records why: Myne is
// strict about what it writes and lenient about what the user points it at.
// Both store a form-C attachment embed (`![[att:<id>|name]]`), the same shape
// the editor writes on paste/drop.
//
// The value is emitted through `formatYamlScalar`, so it lands double-quoted on
// disk (a leading `!` forces quoting). That is what keeps it valid YAML to a
// foreign reader.

import { patchFrontmatterField, patchUpdatedField } from "../dialect";
import { emitAttachmentEmbed } from "./attachmentRef";
import { noteRead } from "./readNote";
import { noteUpdate } from "./updateNote";
import { reindexNoteFromBody } from "./vaultIndices";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Set the note's cover-image property `propertyKey` to a form-C embed of the
 * given attachment, or delete it when `attachment === null` (remove cover).
 * Reads the note, rewrites the property, bumps `updated:`, re-encrypts, and
 * re-indexes. Rejects with whatever `noteRead` / `noteUpdate` propagate.
 */
export async function setNoteCover(
  noteId: string,
  propertyKey: string,
  attachment: { id: string; filename: string } | null,
): Promise<void> {
  const current = await noteRead(noteId);
  const value =
    attachment === null
      ? null
      : emitAttachmentEmbed(attachment.id, attachment.filename);
  const patched = patchFrontmatterField(encoder.encode(current), propertyKey, value);
  const stamped = patchUpdatedField(patched, new Date().toISOString());
  const next = decoder.decode(stamped);
  await noteUpdate(noteId, next);
  // The cover property changed → re-index (live, decrypt-free) so the view's
  // property lookup — and the rendered card — picks it up. Best-effort.
  void reindexNoteFromBody(noteId, next);
}
