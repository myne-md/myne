// Copy a note's markdown to the clipboard (MYND-643).
//
// The sibling of the export flow, for the far commoner case: the text is going
// straight into another app, so a save dialog and then opening the file is a
// long way round.
//
// **Threat-model posture (TB3).** This is deliberate, user-initiated plaintext
// egress, the same class `docs/threat-model.md` §5 records for the `.md` export,
// so it needs no new spec exception. It is worth naming as a distinct surface
// rather than a shortcut for the existing one: unlike a file, the clipboard is
// readable by any local app and the user does not choose where it lands. A
// clipboard is also not a place attachment bytes can go, so this copies text
// only — there is no include-attachments question to ask.
//
// **Frontmatter is stripped.** The managed block (`title`, `folder`, `updated`,
// `tags`…) is Myne's bookkeeping, not the user's prose: pasting a raw `---`
// block into a chat message is noise, and it leaks the note's internal shape to
// wherever it lands. The body is what "copy this note" means. Exporting a FILE
// still keeps frontmatter, because there the round-trip back into a vault is the
// point.

import { locateFrontmatter } from "@myne/dialect/lezer/frontmatter";
import { writeText } from "../platform/clipboardManager";
import { noteRead } from "./readNote";

/** The note body with any leading frontmatter block removed. */
export function bodyWithoutFrontmatter(plaintext: string): string {
  const fm = locateFrontmatter(plaintext);
  if (fm === null) return plaintext;
  // `locateFrontmatter` reports the inner span; the closing fence and its
  // newline follow it, so skip to the first line after the block ends.
  const afterClose = plaintext.indexOf("\n", plaintext.indexOf("---", fm.bodyEnd));
  if (afterClose === -1) return "";
  // Drop only the SINGLE separator blank line between the block and the body,
  // not `^\n+`: blank lines the body itself opens with are the user's prose and
  // must survive the copy.
  return plaintext.slice(afterClose + 1).replace(/^\n/, "");
}

/**
 * Read `noteId` and put its body on the clipboard.
 *
 * Throws on a read or clipboard failure so the caller can surface it — a silent
 * failure is the worst outcome here, because a clipboard write has no visible
 * result and the user would paste stale content believing it worked.
 */
export async function copyNoteMarkdown(noteId: string): Promise<void> {
  const plaintext = await noteRead(noteId);
  await writeText(bodyWithoutFrontmatter(plaintext));
}
