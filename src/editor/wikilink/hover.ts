// Wikilink hover-tooltip R1 (`wikilink.md` §6.2). Hovering any non-embed chip
// shows where it resolves: "Display → vault/relative/path.md", or the
// "(N matches)" / "(no match)" hint. Render-only — never mutates the doc, and
// the path/title NEVER lands in a `data-*` attribute (AS4 / SYNC-7 leak budget);
// it lives only in the tooltip's text node, which is torn down on lock with the
// editor. Resolution uses the one WL-5 note-set + the §5.3 resolver (WL-2/WL-3).

import { hoverTooltip, type Tooltip } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { chipDisplayText, parseWikilinkParts } from "./chip-widget";
import { readNoteSet } from "./note-set";
import { chipHoverText } from "./resolve-chip";

function enclosingWikilink(node: SyntaxNode | null): SyntaxNode | null {
  for (let n = node; n !== null; n = n.parent) {
    if (n.name === "Wikilink") return n;
  }
  return null;
}

export function wikilinkHoverExtension(): Extension {
  return hoverTooltip(
    (view, pos): Tooltip | null => {
      const tree = syntaxTree(view.state);
      // Resolve at both sides so a hover at the chip's edge still finds it.
      const wl =
        enclosingWikilink(tree.resolveInner(pos, -1)) ??
        enclosingWikilink(tree.resolveInner(pos, 1));
      if (wl === null) return null;

      const parts = parseWikilinkParts(view.state, wl.from, wl.to);
      const text = chipHoverText(
        chipDisplayText(parts),
        parts,
        readNoteSet(view.state),
      );
      if (text === null) return null; // embeds / empty → no tooltip

      return {
        pos: wl.from,
        end: wl.to,
        above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "cm-wikilink-hover";
          dom.textContent = text;
          return { dom };
        },
      };
    },
    { hoverTime: 300 },
  );
}
