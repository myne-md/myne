// Obsidian importer — title leg of the path→note mapping.
//
// Sub-feature 1 of the obsidian-importer epic (MYND-51), task 2.
//
// The filename (minus exactly one trailing `.md`) is the note's title as a
// READ-TIME DEFAULT only; a frontmatter `title:` already present in the file
// overrides it. The importer NEVER writes a `title:` field into the composed
// plaintext — injecting one is a silent body rewrite (C1) and would resurrect
// the dropped filename-as-title behavior (`decisions.md` 2026-05-28). A file
// with no FM `title:` correctly reads as "Untitled" downstream until renamed.
// The read-time title is used for the importer's identity key (conflict /
// dedup, sub-feature 2) and the import summary — not for persistence.

import { filenameToTitle } from "../../dialect/folderPath";

/** The final path segment (the filename, with extension) of a relative path. */
export function importBasename(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? relativePath : relativePath.slice(i + 1);
}

/**
 * Read-time title for an imported file: a present frontmatter `title:` wins;
 * otherwise the filename minus exactly one trailing `.md` (so the `.md`
 * discriminator round-trips — `Foo.md.md` → "Foo.md", `report.md` → "report").
 * Never injected into the note's plaintext.
 */
export function deriveImportTitle(
  relativePath: string,
  frontmatterTitle: string | null,
): string {
  if (frontmatterTitle !== null) return frontmatterTitle;
  return filenameToTitle(importBasename(relativePath));
}
