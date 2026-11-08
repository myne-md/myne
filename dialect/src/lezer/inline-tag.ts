// Spec: myne-agents/docs/spec/markdown-dialect.md §3.7. Grammar is a deny-list character
// class matching Obsidian's runtime regex (myne-agents/researches/
// 2026-05-09-obsidian-inline-tag-behavior.md), not the simpler positive
// allow-list in Obsidian's user-facing docs.
//
// Exclusion zones are handled **structurally** by lezer's nested-node parsing
// — once a wikilink, code block, or HTML embed consumes a range, parseInline
// isn't invoked there.

import type { MarkdownConfig } from "@lezer/markdown";
import { isWhitespace } from "./whitespace";

const CHAR_HASH = 35;

// ASCII portion of Obsidian's runtime deny-list (issue obsidian-help/#816).
const DENY_ASCII: ReadonlySet<number> = new Set([
  0x21, // !
  0x22, // "
  0x23, // #  (a `#` cannot appear inside a tag body)
  0x24, // $
  0x25, // %
  0x26, // &
  0x27, // '
  0x28, // (
  0x29, // )
  0x2a, // *
  0x2b, // +
  0x2c, // ,
  0x2e, // .
  0x3a, // :
  0x3b, // ;
  0x3c, // <
  0x3d, // =
  0x3e, // >
  0x3f, // ?
  0x40, // @
  0x5b, // [
  0x5c, // \
  0x5d, // ]
  0x5e, // ^
  0x60, // `
  0x7b, // {
  0x7c, // |
  0x7d, // }
  0x7e, // ~
]);

function isAllowedTagChar(charCode: number): boolean {
  if (DENY_ASCII.has(charCode)) return false;
  if (charCode >= 0x2000 && charCode <= 0x206f) return false;
  if (charCode >= 0x2e00 && charCode <= 0x2e7f) return false;
  if (isWhitespace(charCode)) return false;
  return true;
}

/**
 * Whether `text` is a legal inline-tag BODY (§3.7.2): one or more code points,
 * none of them denied. The `#` marker is not part of the body, so a caller
 * holding `#tag` must strip it first.
 *
 * Exported because a surface that PROPOSES a tag has to answer the same
 * question the tokenizer answers. The tag-suggestion band is the first: it used
 * to offer whatever the model emitted, so a one-line reply like
 * `(#Writing with Markdown, Tasks, …)` became five chips, two of them carrying a
 * parenthesis, and accepting one wrote a tag no inline `#tag` can ever match
 * (myne-md/myne#1025). Built on {@link isAllowedTagChar} rather than restated,
 * because a second spelling of one grammar is how a suggestion and the tag index
 * come to disagree (myne-md/myne#983).
 *
 * §3.7.3's numeric-only reject is NOT applied here: it keeps prose like "Suite
 * #200" from being read as a tag, which is a recognition concern, not a
 * statement that `1984` is an illegal tag value, and frontmatter has always
 * accepted one. Iterates UTF-16 code units exactly like the tokenizer's scan, so
 * the two cannot differ on a surrogate pair. Pure.
 */
export function isTagBody(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    if (!isAllowedTagChar(text.charCodeAt(i))) return false;
  }
  return true;
}

function isNumericOnly(tag: string): boolean {
  if (tag.length === 0) return false;
  for (let i = 0; i < tag.length; i++) {
    const c = tag.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

export const InlineTag: MarkdownConfig = {
  defineNodes: ["InlineTag"],
  parseInline: [
    {
      name: "InlineTag",
      parse(cx, next, pos) {
        if (next !== CHAR_HASH) return -1;
        // Scope-start counts as a boundary — reading `cx.char(pos - 1)` at
        // `cx.offset` returns a sentinel that fails the whitespace check.
        if (pos > cx.offset && !isWhitespace(cx.char(pos - 1))) return -1;
        let scan = pos + 1;
        while (scan < cx.end) {
          if (!isAllowedTagChar(cx.char(scan))) break;
          scan++;
        }
        if (scan === pos + 1) return -1;
        const tag = cx.slice(pos + 1, scan);
        if (isNumericOnly(tag)) return -1;
        return cx.addElement(cx.elt("InlineTag", pos, scan));
      },
    },
  ],
};
