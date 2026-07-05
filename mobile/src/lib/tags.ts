// Client-side `#tag` index — the mobile stand-in for the desktop TagBrowser /
// tag-filter layer (which reads the persisted MYI1 structured index). Here we
// scan the already-decrypted note bodies (same pattern as the Graph + Search
// tabs). Nested tags (`#area/topic`) are supported; a leading `#` followed by a
// space is a Markdown heading, NOT a tag, so it is not matched.

import { foldSegment } from "../dialect/folderPath";
import { pushMap } from "./util";

/** Extract `#tag` tokens from note text. A tag starts at line-start or after
 *  whitespace, begins with an alnum/underscore (so `# Heading` is excluded), and
 *  may nest with `/` (e.g. `#area/topic`). Returns tags in first-seen order,
 *  with duplicates preserved (the caller dedupes). */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

export interface TagIndex {
  /** All tags, most-used first (ties broken alphabetically). Display form is the
   *  first-seen casing; counts are per-note (a note with `#a #a` counts once). */
  tags: { tag: string; count: number }[];
  /** folded tag (lowercase) → note ids carrying it. */
  byTag: Map<string, string[]>;
  /** note id → its unique tags (display form). */
  noteTags: Map<string, string[]>;
}

/** Build the tag index over a set of notes. Tags fold case-insensitively; the
 *  displayed casing is the first occurrence across the vault (deterministic in
 *  note order). */
export function buildTagIndex(
  notes: readonly { id: string }[],
  bodies: Map<string, string>,
): TagIndex {
  const byTag = new Map<string, string[]>();
  const noteTags = new Map<string, string[]>();
  const display = new Map<string, string>();

  for (const n of notes) {
    const seen = new Set<string>();
    const perNote: string[] = [];
    for (const t of parseTags(bodies.get(n.id) ?? "")) {
      const folded = foldSegment(t);
      if (!display.has(folded)) display.set(folded, t);
      if (seen.has(folded)) continue;
      seen.add(folded);
      perNote.push(display.get(folded)!);
      pushMap(byTag, folded, n.id);
    }
    if (perNote.length > 0) noteTags.set(n.id, perNote);
  }

  const tags = [...byTag.entries()]
    .map(([folded, ids]) => ({ tag: display.get(folded) as string, count: ids.length }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return { tags, byTag, noteTags };
}
