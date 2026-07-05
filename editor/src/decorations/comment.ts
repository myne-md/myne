// Dialect comment (`%%…%%`) decorations (MYND-315, editor-comments task 2).
//
// `%%…%%` is an editor-only comment: it is **dimmed (de-emphasized)** in the
// editor — always VISIBLE as a clearly-a-comment span — and stripped from the
// rendered output + lossy exports (HTML/PDF/TXT) and from document statistics by
// the dialect strip (SYNC-1), NOT by this decoration.
//
// Design note (2026-06-17 UX revision): the original cut FULLY HID the comment
// off-cursor (replace + line-collapse, revealed on-cursor). That tested fine but
// is bad UX — a comment you've written becomes invisible the moment the caret
// leaves it, so you can't see your own notes-to-self while editing. Myne's editor
// IS the live surface (no separate reading view yet, MYND-299), so "hidden in
// render" can only mean hidden in the EXPORT/output — in the editor the comment
// is shown dimmed (Obsidian Live-Preview behavior). One `Decoration.mark` over
// the whole node handles both inline `%%…%%` and the multi-line block form
// (a mark may span lines from a ViewPlugin — only replacing/block decorations
// that cross line boundaries need a StateField). Recognize-and-render-only — the
// decoration never mutates the buffer (§6 C1); the source `%%` bytes survive a
// `.md` export verbatim.

import { syntaxTree } from "@codemirror/language";
import {
  type Extension,
  type Range,
  RangeSetBuilder,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { isInCode } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

const COMMENT_NODE_NAMES = new Set(["DialectComment", "DialectCommentBlock"]);

/** A mark (style-only) decoration — `.cm-comment` dims the span (theme.ts). */
const commentMark = Decoration.mark({ class: "cm-comment" });

function buildCommentDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (!COMMENT_NODE_NAMES.has(node.name)) return undefined;
        if (isInCode(view.state, node.from)) return false; // defensive (§3.7.5)
        decorations.push(commentMark.range(node.from, node.to));
        return false;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => a.from - b.from);
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function commentDecorations(): readonly Extension[] {
  return [makeCursorAwareDecorationPlugin(buildCommentDecorations)];
}
