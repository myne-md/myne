// Obsidian importer — title leg of the path→note mapping.
//
// Sub-feature 1 of the obsidian-importer epic (MYND-51), task 2.
//
// The filename (minus exactly one trailing `.md`) is the note's title; a
// frontmatter `title:` already present in the file overrides it. `mapping.ts`
// INJECTS this value into the Myne-managed `title:` field when the file has none
// — a SANCTIONED import transform (the SYNC-9 C1 allowlist, beside `folder:`
// injection), NOT the dropped read-time filename-as-title fallback (`decisions.md`
// 2026-05-28): it materializes Obsidian's filename-as-title into the canonical
// frontmatter field so the note isn't "Untitled" in Myne's frontmatter-only-title
// model. The derived title is also the importer's identity key (conflict / dedup,
// sub-feature 2) and feeds the import summary.

import { filenameToTitle } from "../../dialect/folderPath";

/** The final path segment (the filename, with extension) of a relative path. */
export function importBasename(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? relativePath : relativePath.slice(i + 1);
}

/**
 * Title for an imported file: a present frontmatter `title:` wins; otherwise the
 * filename minus exactly one trailing `.md` (so the `.md` discriminator
 * round-trips — `Foo.md.md` → "Foo.md", `report.md` → "report"). When the file
 * has no FM `title:`, `mapping.ts` injects this value into the `title:` field.
 */
export function deriveImportTitle(
  relativePath: string,
  frontmatterTitle: string | null,
): string {
  if (frontmatterTitle !== null) return frontmatterTitle;
  return filenameToTitle(importBasename(relativePath));
}
