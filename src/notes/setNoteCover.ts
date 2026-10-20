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
import { flushBeforeFrontmatterWrite } from "./flushBeforeFrontmatterWrite";
import { noteRead } from "./readNote";
import { noteUpdate } from "./updateNote";
import { reindexNoteFromBody } from "./vaultIndices";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Byte equality, so a no-op patch is detected without decoding twice. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Set the note's cover-image property `propertyKey` to a form-C embed of the
 * given attachment, or delete it when `attachment === null` (remove cover).
 * Flushes every dirty pane first (see `flushBeforeFrontmatterWrite`), then
 * reads the note, rewrites the property, bumps `updated:`, re-encrypts, and
 * re-indexes. Rejects with whatever the flush / `noteRead` / `noteUpdate`
 * propagate.
 */
export async function setNoteCover(
  noteId: string,
  propertyKey: string,
  attachment: { id: string; filename: string } | null,
): Promise<void> {
  // Before the read, not after it (myne-md/myne#520). This is read-patch-write
  // against disk on a note that may be open and dirty in a pane, and the pane's
  // autosave is a second writer of the same bytes.
  await flushBeforeFrontmatterWrite();
  const current = await noteRead(noteId);
  const value =
    attachment === null
      ? null
      : emitAttachmentEmbed(attachment.id, attachment.filename);
  const patched = patchFrontmatterField(encoder.encode(current), propertyKey, value);
  // A patch that changed nothing is not written, and that is a correctness
  // guard rather than an optimisation. "Remove cover" is offered
  // unconditionally, on the reasoning that clearing an absent field is a
  // harmless no-op. It is not: `patchFrontmatterField` returns the source
  // unchanged when the key is absent, and `patchUpdatedField` then runs anyway
  // and PREPENDS a whole frontmatter block to a note that had none. So
  // "Remove cover" on a plain note used to inject `---\nupdated: ...\n---` into
  // the user's text, and on a note that has frontmatter it bumped `updated:`,
  // re-encrypted and pushed a sync version for nothing.
  if (bytesEqual(patched, encoder.encode(current))) return;
  const stamped = patchUpdatedField(patched, new Date().toISOString());
  const next = decoder.decode(stamped);
  await noteUpdate(noteId, next, undefined, current);
  // The cover property changed → re-index (live, decrypt-free) so the view's
  // property lookup — and the rendered card — picks it up. Best-effort.
  void reindexNoteFromBody(noteId, next);
}
