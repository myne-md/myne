// `countBodyWords` — word count of a note body, frontmatter excluded
// (MYND-143). `extractFullText` strips the YAML frontmatter block +
// decoration syntax and collapses whitespace to single spaces, so a plain
// space-split yields the body word count. Empty body → 0 (a bare split
// would otherwise return `[""]`, miscounting as 1).
//
// Extracted from `Editor.tsx` so each `<PaneView>` (MYND-166 multi-pane)
// can count its own note independently.

import { extractFullText } from "../dialect";

export function countBodyWords(content: string): number {
  const text = extractFullText(content);
  return text.length === 0 ? 0 : text.split(" ").length;
}
