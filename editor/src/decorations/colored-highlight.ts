// Colored-highlight clean reveal (MYND-637). Colored highlights are stored as
// embedded HTML `<mark class="hl-*">…</mark>` (MYND-285). Rendering them through
// `embedded-html.ts`'s full-replace widget leaked the RAW HTML tags on cursor
// (the ticket's complaint #2) and placed the caret erratically (#1). Instead
// treat a colored highlight exactly like the `==` highlight: paint the inner
// text (`.cm-highlight` + a colour class), hide the `<mark …>` / `</mark>` tags
// off-cursor, and reveal a clean `==` SKIN on cursor — so it reads `==text==`
// painted, never the HTML.
//
// Storage is untouched: the `==` is a render-only decoration; the doc bytes stay
// `<mark class="hl-*">` (the settled `hl-*` allowlist / XSS boundary,
// `decisions.md` 2026-06-15 / 2026-07-29). `embedded-html.ts` SKIPS
// `<mark class="hl-*">` (this owns them); every other inline HTML — `<kbd>`,
// `<sub>`, `<sup>`, `<abbr>`, a bare `<mark>` — stays on its path.
//
// Design: myne-agents/sessions/design/2026-07-31-highlight-edit-behaviour.md.

import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { MARK_HL_RE, isOwnedHighlightClass } from "../html/sanitize";
import { isInCode, isInsideRange } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

/** The `==` skin shown at a colored highlight's tag positions ON cursor, so it
 *  reads `==text==` exactly like a yellow `==` highlight instead of raw HTML.
 *  Display-only — the doc bytes underneath stay `<mark …>`. */
class EqSkinWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "cm-hl-eq";
    s.textContent = "==";
    // Decorative (myne-md/myne#728, task 10). This is the `==` SYNTAX, drawn
    // back in only while the cursor sits on the span; it says nothing about
    // the note. Read aloud it is two equals signs interrupting the sentence
    // the highlight is part of.
    s.setAttribute("aria-hidden", "true");
    return s;
  }
}

// The two tag decorations, hoisted to module scope: a `Decoration` value is
// position-independent (re-`.range()`'d at every span) and `EqSkinWidget` is
// stateless, so one shared instance of each serves the whole document.
const HIDE = Decoration.replace({}); // off-cursor: tags collapse to nothing
const EQ_SKIN = Decoration.replace({ widget: new EqSkinWidget() }); // on-cursor

function buildColoredHighlightDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    MARK_HL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARK_HL_RE.exec(text)) !== null) {
      const cls = m[1].toLowerCase(); // hl-blue
      if (!isOwnedHighlightClass(cls)) continue; // unknown class → embedded-html sanitizes it
      const start = from + m.index;
      const end = start + m[0].length;
      if (isInCode(view.state, start)) continue; // literal inside a code span/fence
      const openEnd = start + m[0].indexOf(">") + 1; // just past `<mark class="hl-X">`
      const closeStart = end - "</mark>".length;
      if (openEnd >= closeStart) continue; // empty highlight — nothing to paint
      const revealed = isInsideRange(view, start, end);
      // Paint the WHOLE span with the shared highlight class + its colour, so the
      // `==` skins (below) sit INSIDE the single painted region — exactly like a
      // yellow `==text==` where the delimiters share the wash. Mirrors the
      // `inline-typography.ts` mark-over-node + replace-the-delimiter structure.
      decorations.push(
        Decoration.mark({ class: `cm-highlight cm-${cls}` }).range(start, end),
      );
      // Tags: hidden off-cursor; a clean `==` skin on-cursor (never raw HTML).
      const tagDeco = revealed ? EQ_SKIN : HIDE;
      decorations.push(tagDeco.range(start, openEnd));
      decorations.push(tagDeco.range(closeStart, end));
    }
  }
  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    if (a.to !== b.to) return a.to - b.to;
    return (a.value.spec.side ?? 0) - (b.value.spec.side ?? 0);
  });
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function coloredHighlightDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildColoredHighlightDecorations);
}
