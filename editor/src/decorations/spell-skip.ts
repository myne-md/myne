// Shared "is this position spell-checkable prose?" predicate (SYNC-3,
// spell-checker epic, MYND-264).
//
// The single source of truth for which document ranges the spell checker
// touches — consumed by BOTH the squiggle decorations (MYND-264) and the
// correction menu (MYND-265), so the two can never disagree about where a
// misspelling can appear.
//
// Skipped (NOT spell-checked): machine tokens, not human prose —
//   - code: fenced / indented / inline (via `isInCode`)
//   - YAML frontmatter block (line-1-anchored; not a Lezer node, located via
//     `cachedLocateFrontmatter`)
//   - wikilink MACHINE parts: `WikilinkMark` `[[`/`]]`/`|`, `WikilinkTarget`,
//     `WikilinkHeading`, `WikilinkBlockId` — identifiers, not prose
//   - `InlineTag` (`#tag`)
//   - `URL` / `Autolink` — link addresses
//
// Spell-checked (human prose): everything else, INCLUDING `WikilinkAlias`
// (the `[[target|Display]]` display text) and link display text — the user
// wrote those, so they want typos flagged (SYNC-3 decision). This is why the
// skip set names the wikilink machine-part children, NOT the enclosing
// `Wikilink` node: a position inside `WikilinkAlias` walks up through
// `Wikilink` (not skipped) and stays spell-checkable.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { isInCode } from "./cursor-aware";
import { cachedLocateFrontmatter } from "../frontmatter-cache";

/**
 * Lezer node names whose spans are machine tokens, not prose. A position
 * inside any of these (walking ancestors) is NOT spell-checked. Deliberately
 * excludes `Wikilink` (the container) and `WikilinkAlias` / `Link` display
 * text so alias + link prose stays checkable.
 */
const SKIP_NODE_NAMES = new Set([
  "WikilinkMark",
  "WikilinkTarget",
  "WikilinkHeading",
  "WikilinkBlockId",
  "InlineTag",
  "URL",
  "Autolink",
  // Inline task fields (MYND-614 task 11). Without these, a recurrence rule made
  // of ordinary dictionary words — `every 3 days` — gets underlined as prose.
  // Visible in source mode, which is where a vim user lives by default.
  //
  // The whole `TaskField` is skipped rather than only its key: the key is a
  // machine token, and the value is a date or a rule expression, neither of
  // which is prose either. One entry covers both the squiggle layer and the
  // correction menu, since both consume `isSpellable`.
  "TaskField",
  "TaskFieldKey",
  "TaskFieldValue",
  "TaskFieldMark",
]);

/**
 * True if `pos` sits in spell-checkable prose: not inside code, not inside the
 * frontmatter block, and not inside a machine-token node (wikilink target,
 * `#tag`, URL, …). `WikilinkAlias` and link display text return `true`.
 */
export function isSpellable(state: EditorState, pos: number): boolean {
  // Frontmatter: a line-1-anchored block is not a Lezer node, so check it
  // explicitly against the cached range. The whole block (delimiters + body)
  // is skipped.
  const fm = cachedLocateFrontmatter(state.doc);
  if (fm !== null && pos >= fm.blockStart && pos < fm.blockEnd) return false;

  // Code (fenced / indented / inline) — reuse the shared predicate.
  if (isInCode(state, pos)) return false;

  // Machine-token nodes: walk ancestors from the resolved inner node.
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  for (; node; node = node.parent) {
    if (SKIP_NODE_NAMES.has(node.name)) return false;
  }
  return true;
}
