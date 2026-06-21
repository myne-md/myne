// url-bookmark task 3 — desktop bookmark body + provenance composition
// (MYND-447, browser-extension epic, sub-feature 5 `url-bookmark`).
//
// WHAT THIS IS
// ------------
// The PURE composer that turns a captured bookmark's `{ url, title, clippedDate }`
// into the PLAINTEXT of a new ROOT note ready to hand to the EXISTING
// `note_create`. It is the SYNC-16 sibling of `composeClipPlaintext`: a bookmark
// is a CONTENT-LIGHT note, so the only difference from a clip is the composition
// shape — there is NO new ingest path, NO new backend command, NO new crypto /
// format / magic / capability. It plugs INTO the shared `assembleClip` routine as
// the caller-supplied composer (`composePlaintext`), swapping ONLY the compose
// step; the validate → images → wikilinks → seal logic is identical.
//
// THE SYNC-16 BOOKMARK NOTE SHAPE
// -------------------------------
//   - BODY = the source URL as a BARE AUTOLINK (a bare URL on its own line — the
//     `welcomeNote` / `myne.md` precedent). A bare URL (and `<angle>` autolink)
//     is the ONLY click-to-open form in the editor (`editor/decorations/
//     autolink.ts`); a `[text](url)` link renders but is NOT clickable. So the
//     body is the raw URL, NOT a markdown link — click-to-open with no new
//     affordance. No leading `# H1`: the title chip already shows the name, so a
//     duplicate heading would just be noise (same discipline as `welcomeNote`).
//   - `title:` = the page title, written via the MANAGED canonical-title surgery
//     `patchTitleField` — so the bookmark has a REAL name in every Myne surface
//     instead of landing "Untitled" (notes derive their title from FM `title:`
//     ONLY, never a body `# H1`). This is the one Myne-managed field a bookmark
//     carries; it is NOT new — `patchTitleField` is the same writer `welcomeNote`
//     / `renameNote` / templates use.
//   - `source:` (the URL) + `clipped:` (the RFC-3339 date) = UNMANAGED, preserved
//     provenance frontmatter, written via the GENERIC arbitrary-frontmatter
//     injector `patchFrontmatterField` (SYNC-14/SYNC-16). The closed 7-field
//     Myne-managed canonical set is NOT extended. Unlike a clip (`composeClip
//     Plaintext`), a bookmark emits NO `url:` key — that redundant clip-only key
//     is not part of the SYNC-16 bookmark shape (`title:` + `source:` +
//     `clipped:` only).
//
// SYNC-15 — ROOT-ONLY
// -------------------
// A bookmark lands at the vault ROOT. The composer builds onto
// `buildInitialPlaintext(null)` (=== `""`, no `folder:` line) — the host never
// sources vault structure.
//
// PURE: no React, no IPC, no I/O. `({ url, title, clippedDate }) -> string`.
// Fully unit-testable.

import { buildInitialPlaintext, patchFrontmatterField, patchTitleField } from "../dialect";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** The content-light bookmark inputs: the source URL, the page title (the note's
 *  name), and the RFC-3339 capture date. The title + URL are derived caller-side
 *  from the envelope (the title folds into `markdown_body` over the wire; the URL
 *  is `envelope.sourceUrl`) — see {@link ClipDispatchListener}. */
export interface BookmarkComposeInput {
  /** The source page URL — body bare autolink AND the `source:` provenance key. */
  readonly url: string;
  /** The page title — the note's managed `title:` (a real name, not "Untitled"). */
  readonly title: string;
  /** The RFC-3339 capture timestamp — the `clipped:` provenance key. */
  readonly clippedDate: string;
}

/**
 * Compose the plaintext of a new ROOT bookmark note (SYNC-16): the source URL as
 * a bare-autolink body, the page title as the managed `title:`, and `source:` /
 * `clipped:` as unmanaged, preserved provenance frontmatter.
 *
 * The surgery is the SAME in-memory chain `composeClipPlaintext` uses, only the
 * key set differs:
 *   - {@link patchTitleField} writes the MANAGED canonical `title:` (so the note
 *     has a real name) — the one Myne-managed field a bookmark carries;
 *   - {@link patchFrontmatterField} writes `source:` + `clipped:` through the
 *     GENERIC arbitrary-frontmatter path (the same injector `setNoteCover` uses
 *     for an unmanaged property), YAML-scalar-escaping each value and never
 *     touching the closed managed-canonical field set.
 *
 * @param input the captured bookmark `{ url, title, clippedDate }`
 * @returns the composed note plaintext, ready for `note_create`
 */
export function composeBookmarkPlaintext(input: BookmarkComposeInput): string {
  // Body = the bare-autolink URL on its own line (SYNC-16, the welcomeNote
  // precedent). Built onto the ROOT base (SYNC-15): `buildInitialPlaintext(null)`
  // is `""`, so prepending it is a no-op that documents the root-only intent.
  const base = buildInitialPlaintext(null) + input.url + "\n";

  // (1) The MANAGED canonical title — a real name in every surface. Chained into
  //     `const`s (not a reassigned `let`) so the narrowed `Uint8Array` buffer
  //     type round-trips cleanly through each surgery call.
  const withTitle = patchTitleField(utf8Encoder.encode(base), input.title);

  // (2) The UNMANAGED, preserved provenance keys via the generic arbitrary-FM
  //     injector — merged into the title FM block (preserving it). A bookmark
  //     emits `source:` + `clipped:` only (NO `url:` — that is a clip-only key).
  const withSource = patchFrontmatterField(withTitle, "source", input.url);
  const withClipped = patchFrontmatterField(withSource, "clipped", input.clippedDate);

  return utf8Decoder.decode(withClipped);
}
