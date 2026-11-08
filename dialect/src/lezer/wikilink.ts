// Spec: myne-agents/docs/spec/wikilink.md §2 (forms 1–9). Registered `before: "Link"`
// per §2.2 so `[[…]]` and `![[…]]` outrank standard `[text](url)` parsing.

import type { MarkdownConfig } from "@lezer/markdown";

const CHAR_BANG = 33; // !
const CHAR_LBRACKET = 91; // [
const CHAR_RBRACKET = 93; // ]
const CHAR_PIPE = 124; // |
const CHAR_HASH = 35; // #
const CHAR_CARET = 94; // ^
const CHAR_NEWLINE = 10; // \n

export const Wikilink: MarkdownConfig = {
  defineNodes: [
    "Wikilink",
    "WikilinkMark",
    "WikilinkTarget",
    "WikilinkAlias",
    "WikilinkHeading",
    "WikilinkBlockId",
  ],
  parseInline: [
    {
      name: "Wikilink",
      before: "Link",
      parse(cx, next, pos) {
        let openLen: number;
        if (next === CHAR_BANG) {
          if (
            cx.char(pos + 1) !== CHAR_LBRACKET ||
            cx.char(pos + 2) !== CHAR_LBRACKET
          ) {
            return -1;
          }
          openLen = 3;
        } else if (next === CHAR_LBRACKET) {
          if (cx.char(pos + 1) !== CHAR_LBRACKET) {
            return -1;
          }
          openLen = 2;
        } else {
          return -1;
        }

        const start = pos;
        const contentStart = pos + openLen;

        let scan = contentStart;
        while (scan < cx.end - 1) {
          const ch = cx.char(scan);
          if (ch === CHAR_NEWLINE) return -1;
          if (
            ch === CHAR_RBRACKET &&
            cx.char(scan + 1) === CHAR_RBRACKET
          ) {
            break;
          }
          scan++;
        }
        if (scan >= cx.end - 1) return -1;
        if (
          cx.char(scan) !== CHAR_RBRACKET ||
          cx.char(scan + 1) !== CHAR_RBRACKET
        ) {
          return -1;
        }

        const contentEnd = scan;
        const closeStart = scan;
        const closeEnd = scan + 2;

        let pipePos = -1;
        for (let i = contentStart; i < contentEnd; i++) {
          if (cx.char(i) === CHAR_PIPE) {
            pipePos = i;
            break;
          }
        }
        const targetEnd = pipePos === -1 ? contentEnd : pipePos;

        // First `#` or `^` wins; the other becomes a literal of the heading
        // or block-id. Spec §2.1.
        let headingDelim = -1;
        let blockIdDelim = -1;
        for (let i = contentStart; i < targetEnd; i++) {
          const ch = cx.char(i);
          if (ch === CHAR_HASH) {
            headingDelim = i;
            break;
          }
          if (ch === CHAR_CARET) {
            blockIdDelim = i;
            break;
          }
        }

        let bareTargetEnd = targetEnd;
        if (headingDelim !== -1) bareTargetEnd = headingDelim;
        else if (blockIdDelim !== -1) bareTargetEnd = blockIdDelim;

        const children = [];
        children.push(cx.elt("WikilinkMark", start, contentStart));

        if (bareTargetEnd > contentStart) {
          children.push(
            cx.elt("WikilinkTarget", contentStart, bareTargetEnd),
          );
        }

        if (headingDelim !== -1) {
          children.push(
            cx.elt("WikilinkMark", headingDelim, headingDelim + 1),
          );
          if (targetEnd > headingDelim + 1) {
            children.push(
              cx.elt("WikilinkHeading", headingDelim + 1, targetEnd),
            );
          }
        } else if (blockIdDelim !== -1) {
          children.push(
            cx.elt("WikilinkMark", blockIdDelim, blockIdDelim + 1),
          );
          if (targetEnd > blockIdDelim + 1) {
            children.push(
              cx.elt("WikilinkBlockId", blockIdDelim + 1, targetEnd),
            );
          }
        }

        if (pipePos !== -1) {
          children.push(cx.elt("WikilinkMark", pipePos, pipePos + 1));
          if (contentEnd > pipePos + 1) {
            children.push(
              cx.elt("WikilinkAlias", pipePos + 1, contentEnd),
            );
          }
        }

        children.push(cx.elt("WikilinkMark", closeStart, closeEnd));

        return cx.addElement(
          cx.elt("Wikilink", start, closeEnd, children),
        );
      },
    },
  ],
};
