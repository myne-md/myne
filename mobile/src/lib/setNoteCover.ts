// Set or clear a note's cover (mobile) — myne-md/myne#410.
//
// Byte-exact with desktop by construction: the same `emitAttachmentEmbed` form-C
// emitter, the same generic `patchFrontmatterField`, the same `COVER_FIELD_KEY`,
// all reached through the shared `@myne/dialect` and `@myne/editor` sources. A
// cover set on a phone reads identically on desktop and vice versa, which is the
// whole reason this is a thin orchestrator rather than a second implementation.
//
// Unlike desktop this takes no `propertyKey`: mobile has no saved-view `image`
// override to serve, so the canonical field is the only target.

import { COVER_FIELD_KEY, patchFrontmatterField, patchUpdatedField } from "../dialect/surgery";
import { emitAttachmentEmbed } from "../lib/attachmentRef";
import { noteRead, noteUpdate } from "./notes";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The minimal attachment shape a caller needs to write a cover. */
export interface CoverChoice {
  id: string;
  filename: string;
}

/** Byte equality, so a no-op patch is detected without decoding twice. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Write the note's `cover:` field, or delete it when `choice === null`.
 *
 * `patchFrontmatterField` with a `null` value is the delete-field case, so
 * removing a cover leaves no `cover: ` line behind rather than a falsy value.
 * `updated:` is bumped because changing a cover IS a content edit to the note's
 * bytes, matching what desktop's writer does.
 */
export async function setNoteCover(
  noteId: string,
  choice: CoverChoice | null,
): Promise<void> {
  const current = await noteRead(noteId);
  const value = choice === null ? null : emitAttachmentEmbed(choice.id, choice.filename);
  const patched = patchFrontmatterField(enc.encode(current), COVER_FIELD_KEY, value);
  // A patch that changed nothing is not written. `patchFrontmatterField`
  // returns the source unchanged when the key is absent, and `patchUpdatedField`
  // then PREPENDS a whole frontmatter block to a note that had none, so a
  // remove on a note with no cover used to inject `---` into the user's text.
  // Byte-identical to desktop's guard, which is the property this file claims.
  if (bytesEqual(patched, enc.encode(current))) return;
  const stamped = patchUpdatedField(patched, new Date().toISOString());
  await noteUpdate(noteId, dec.decode(stamped));
}
