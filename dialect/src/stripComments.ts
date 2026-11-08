// Canonical `%%…%%` comment strip primitive (MYND-315, editor-comments).
//
// The dialect-level recognize-strip over the parsed tree: removes every
// recognized `%%…%%` comment node's byte range from the source, leaving all
// other bytes verbatim. This is the SINGLE definition of "what a lossy
// projection drops" — the same `DialectComment` / `DialectCommentBlock` parser
// nodes that `emitNoteHtml`, `emitNoteText`, and the `extractBodyText`
// document-statistics projection each omit in their own walk. It is exposed
// here as the cross-client reference of the strip OUTPUT (pinned by the
// `markdown-comment` golden vectors); the per-surface emitters do not re-derive
// the rule — they omit the same nodes.
//
// Recognize-and-render-only: an UNTERMINATED `%%` is not a comment (no node),
// so it is not stripped (§3.1 / §3.2 / §6 inert rule). The `.md` export is
// byte-verbatim and never calls this (SYNC-2) — only lossy projections strip.
// Spec: myne-agents/docs/spec/markdown-dialect.md §6.

import { parser } from "./lezer/parser";

const COMMENT_NODE_NAMES: ReadonlySet<string> = new Set([
  "DialectComment",
  "DialectCommentBlock",
]);

/**
 * Remove every recognized `%%…%%` comment span from `source`, returning the
 * source with those byte ranges deleted (all other bytes verbatim). Pure — does
 * not mutate the input. An unterminated `%%` is left untouched (it is inert, not
 * a comment).
 */
export function stripDialectComments(source: string): string {
  if (source.length === 0) return "";
  const ranges: Array<[number, number]> = [];
  parser.parse(source).iterate({
    enter: (node) => {
      if (COMMENT_NODE_NAMES.has(node.name)) {
        ranges.push([node.from, node.to]);
        return false; // do not descend into the comment
      }
      return undefined;
    },
  });
  if (ranges.length === 0) return source;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [from, to] of ranges) {
    if (cursor < from) out += source.slice(cursor, from);
    if (to > cursor) cursor = to;
  }
  out += source.slice(cursor);
  return out;
}

/** Whether `source` contains at least one recognized `%%…%%` comment node. */
export function hasDialectComment(source: string): boolean {
  let found = false;
  parser.parse(source).iterate({
    enter: (node) => {
      if (COMMENT_NODE_NAMES.has(node.name)) found = true;
    },
  });
  return found;
}
