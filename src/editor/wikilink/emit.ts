// WL-4 (wikilink-backlink epic): the SINGLE canonical §3 wikilink emitter.
// The `[[` picker (#3), R2 conversion (#4), and rename auto-update (#5) all emit
// note links through THIS function so their output is byte-identical. Mirrors
// the `attachmentRef.ts` SYNC-4 "one emitter" discipline.
//
// Canonical form (`wikilink.md` §3): `[[<folder>/<title>.md|<Display>]]`, with
// the folder segment ALWAYS baked (WL-4, ratified #3 grill) — a root note emits
// `[[<title>.md|<title>]]`. Baking the folder deterministically populates the
// §5.3 disambiguator so a later same-title note can't silently make the link
// ambiguous.

import { titleToFilename } from "../../dialect/folderPath";

/**
 * Emit the canonical §3 path-with-alias wikilink for a note.
 * @param folder the note's `folder:` frontmatter — carries its trailing `/`
 *               (e.g. `"Projects/"`); `null` / `""` = vault root.
 * @param title  the note's title (its filename is `title + ".md"`).
 * @param display optional display alias; defaults to the title.
 */
export function emitNoteWikilink(
  folder: string | null,
  title: string,
  display?: string,
): string {
  const path = (folder ?? "") + titleToFilename(title);
  return `[[${path}|${display ?? title}]]`;
}

/**
 * Emit a folder-target wikilink (MYND-370) — the trailing-slash form
 * `[[Projects/]]` that {@link resolveWikilink} routes to the folder's index
 * note. No alias is baked: unlike a note link there is no title/disambiguator
 * to populate, and the trailing `/` is the load-bearing signal `isFolderTarget`
 * keys on.
 * @param path the folder's canonical trailing-slash path (e.g. `"Projects/Myne/"`).
 */
export function emitFolderWikilink(path: string): string {
  return `[[${path}]]`;
}
