// The landing shape of a photo-to-note capture (myne-md/myne#926 task 5).
//
// Pure, so the shape the note receives is testable without a phone: the flow
// that imports the image and the sheet that edits the text both hand their
// result here, and this is the one place that decides what bytes hit the note.
//
// # Why the image stays
//
// The text is a DERIVED reading of the photograph, produced by an extractor at
// a specific `extractor_version` (`protocol.md` § 9.15). A better engine can only
// re-read an original that is still in the vault, so dropping the image to keep
// the note "clean" would quietly forfeit the upgrade path the decision entry
// promises. The image goes first and the text immediately below it: one block,
// one reading, one source.

/** A leading `---` line is a frontmatter fence wherever it lands at byte 0.
 *
 *  In the composed block the embed is always first, so a photograph of a
 *  horizontal rule cannot currently open a frontmatter block. This guard is
 *  here anyway, and deliberately, because that safety is a property of the
 *  CALL ORDER rather than of the text: a future caller that inserts the text
 *  alone would inherit the hole silently, and a note whose frontmatter moved is
 *  a note that changed folder, views and AI-exclusion status without anyone
 *  asking. One newline is the whole fix.
 */
function neutralizeLeadingRule(text: string): string {
  return text.startsWith("---") ? `\n${text}` : text;
}

/**
 * Compose the block a committed capture lands in the note: the form-C embed,
 * a blank line, the corrected text.
 *
 * `text` is the user's edited draft, never the cached original. Empty text is a
 * legitimate outcome (a blank page, or a read the user chose to skip) and yields
 * the embed alone rather than an empty paragraph.
 */
export function buildPhotoNoteBlock(embed: string, text: string): string {
  // Trailing whitespace and leading blank lines are dropped so the block never
  // lands with a gap the user has to delete by hand. Interior blank lines stay:
  // they are the paragraph structure the reading produced.
  const body = text.replace(/^\n+/u, "").replace(/\s+$/u, "");
  if (body.length === 0) return embed;
  return `${embed}\n\n${neutralizeLeadingRule(body)}`;
}

/**
 * The title for a note created from a capture: the first non-empty line of the
 * corrected text, stripped of the markdown that would read as syntax in a title
 * (`#`, `>`, a bullet, an ordered-list marker).
 *
 * `fallback` is supplied by the caller rather than built here, because it is a
 * translated string and this module is pure. A photograph with no text at all
 * has no line to derive from, and inventing one in English would put an
 * untranslatable title in a Turkish vault.
 */
export function photoNoteTitle(text: string, fallback: string): string {
  const firstLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const stripped = firstLine
    .replace(/^#{1,6}(?:\s+|$)/u, "")
    .replace(/^>\s*/u, "")
    .replace(/^(?:[-*+]|\d+[.)])(?:\s+|$)/u, "")
    .trim();
  if (stripped.length === 0) return fallback;
  // Grapheme-blind but code-point aware: a byte- or UTF-16-unit cut would split
  // an emoji or a surrogate pair and leave a broken title, and a note title is
  // shown in lists, search hits and the PDF export header.
  const chars = Array.from(stripped);
  return chars.length > 80 ? chars.slice(0, 80).join("").trimEnd() : stripped;
}

/**
 * Today in the DEVICE's timezone, as `YYYY-MM-DD`, for the fallback title of a
 * note made from a photo with no text.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day, and this string is a
 * note TITLE: east of UTC a capture between local midnight and the offset would
 * be titled with yesterday, in the one string a user reads to identify the note.
 * `now` is a parameter so the offset case can be asserted without waiting for a
 * particular wall clock.
 */
export function localDateStamp(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Whether a discarded draft should delete its attachment.
 *
 * Three conditions, and each one has cost somebody something:
 *
 *  - `id === null` means the import is still running. There is nothing to delete
 *    yet, and the caller's post-import branch is what undoes it.
 *  - `committed` means a note already embeds this id. Deleting it would leave
 *    every embed dangling.
 *  - `deduplicated` means `attachment_import` returned an entry the vault ALREADY
 *    had, so the attachment is the user's, not this flow's. Deleting it would
 *    break other notes and push a tombstone to every device.
 *
 * Pure so the rule is testable without a phone, and shared by the cancel path and
 * the unmount teardown, which must agree.
 */
export function shouldDiscardPhotoDraft(
  draft: { id: string | null; deduplicated: boolean },
  committed: boolean,
): boolean {
  return draft.id !== null && !committed && !draft.deduplicated;
}
