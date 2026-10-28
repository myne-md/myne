// Recover the source page's TITLE from a clipped body's leading `# ` heading
// (myne-md/myne#936).
//
// WHY THE TITLE IS IN THE BODY
// ----------------------------
// The handoff envelope has no `page_title` field and cannot grow one: the
// extension and the desktop ship on different clocks (the browser web store vs
// the app), the Rust struct is `#[serde(deny_unknown_fields)]`, and the envelope
// version is forward-incompatible by design (SYNC-10). An added field would be a
// hard `Malformed` reject for every user who updates the extension before the
// app, so the title rides where it always has: as the first line of
// `markdown_body`.
//
// Both producers emit it that way: the content capture (`captureClip`) prepends
// `# <document.title>` to the selection or article body, and the bookmark shape
// (`buildBookmarkEnvelope`) emits `# <tab title>` above the bare source URL. An
// empty page title emits NO heading at all, which is why "no heading" and "empty
// title" collapse to the same `""` here: the note then keeps the untitled
// placeholder, the correct degenerate.
//
// WHY IT IS LIFTED AT ALL
// -----------------------
// A note's title is read from frontmatter `title:` ONLY (`loadNoteBatch`'s
// `recordFromSlice`; decision 0139 dropped the first-`# H1` fallback on
// purpose), so a clip sealed with no managed `title:` renders as "Untitled" in
// every surface no matter what its body says. `assembleClip` lifts this string
// once and hands it to whichever composer the capture kind uses, so the title
// is derived in ONE place rather than once per composer.
//
// THE UNESCAPE, AND WHY IT IS A MIRROR RATHER THAN A SHARED HELPER
// ---------------------------------------------------------------
// The heading's text is page-controlled, so the extension escapes a leading
// markdown block marker before it emits it (`escapeLineStart` in
// `myne-clipper/src/lib/markdown-safe.ts`: `#`, `>`, `-`, `*`, `+`, or `N.` gains
// a leading backslash). Lifting the heading verbatim would put that backslash
// into the note's `title:`, which is a stray character in a name the user reads
// and renames. The rule is mirrored here rather than imported because the
// extension is a separate repository with its own supply chain (SYNC-5) and the
// desktop deliberately does not depend on it. The consequence of the mirror
// drifting is bounded and cosmetic: if the extension's marker set widens, the
// affected titles keep a leading backslash; no note is lost and no body byte
// moves.
//
// PURE: string in, string out. No IPC, no DOM, no React.

/** The leading-heading shape both producers emit: `# ` + the (escaped) title. */
const LEADING_HEADING = /^#\s+(.*)$/;

/**
 * One leading backslash in front of a markdown block marker: the inverse of the
 * extension's `escapeLineStart`. Anchored at the start of the line, so a
 * backslash anywhere else in a title is left alone.
 */
const ESCAPED_LINE_START = /^\\([#>\-*+]|\d+\.)/;

/**
 * The page title a clipped body carries, or `""` when it carries none.
 *
 * @param markdownBody the wire body (`envelope.markdownBody`), the RAW body,
 *   never the post-image / post-wikilink `resolvedBody`, because the heading is
 *   part of what the extension captured and the later transforms only touch
 *   content below it.
 * @returns the title with its escape character removed and surrounding space
 *   trimmed; `""` when the first line is not a heading (an empty page title).
 */
export function clipTitleFromMarkdownBody(markdownBody: string): string {
  // Only the FIRST line: the article's own `<h1>`s are captured below it and are
  // content, not the note's name. Split on a CRLF too, so a `\r` left by a body
  // assembled on another convention cannot stop the heading from matching (`.`
  // in the pattern below will not cross a `\r`, so it must be gone by then).
  const firstLine = markdownBody.split(/\r?\n/, 1)[0] ?? "";
  const heading = LEADING_HEADING.exec(firstLine);
  if (heading === null) return "";
  return (heading[1] ?? "").trim().replace(ESCAPED_LINE_START, "$1");
}
