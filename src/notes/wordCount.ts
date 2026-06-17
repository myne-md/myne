// `countBodyWords` — word count of a note body, frontmatter excluded
// (MYND-143). `extractFullText` strips the YAML frontmatter block +
// decoration syntax and collapses whitespace to single spaces, so a plain
// space-split yields the body word count. Empty body → 0 (a bare split
// would otherwise return `[""]`, miscounting as 1).
//
// Extracted from `Editor.tsx` so each `<PaneView>` (MYND-166 multi-pane)
// can count its own note independently.
//
// NOTE (MYND-339): the live bottom-bar readout now uses `computeDocStats`
// (`documentStats.ts`), so this is no longer the production word counter. It is
// retained as the **parity oracle** that pins `computeDocStats(...).words` to
// the original word-count definition (`tests/notes/documentStats.test.ts`).

import { extractFullText } from "../dialect";

export function countBodyWords(content: string): number {
  const text = extractFullText(content);
  return text.length === 0 ? 0 : text.split(" ").length;
}
