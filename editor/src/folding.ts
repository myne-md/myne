// CodeMirror 6 folding for the Myne editor (heading-list-folding / MYND-300,
// tasks 1+2). Compose `myneFolding()` into `myneExtensions()`.
//
// Three pieces, all from the already-pinned `@codemirror/language@6.12.3` (NO
// new dependency — adding one is a security decision per AGENTS.md):
//   1. `codeFolding()` — the fold state machine + the collapsed-range
//      placeholder. We supply a custom `placeholderDOM` so the folded line shows
//      a clear, clickable Myne-styled placeholder (data-testid for E2E).
//   2. `inlineFoldMarkers()` — the affordance, and the one custom piece here.
//   3. `listFoldService()` — the one custom fold service (nested lists,
//      children-only). Heading-SECTION fold ranges already exist in editor state
//      (lang-markdown composes a `headerIndent` foldService), so mounting the
//      above SURFACES them with no custom heading fold logic.
//
// Fold state is EPHEMERAL by design — no persistence (no vault.workspace /
// vault.prefs field). CM6 loses fold state on unmount, which is exactly the
// note-switch / lock / quit reset the PRD specifies.
//
// ## Why the marker is inline and not a gutter (myne#952)
//
// It used to be `foldGutter()`: a fixed column at the editor's left edge. That
// column cannot follow the text, so on every indented row — a nested bullet, a
// checklist item, a list two levels deep — the arrow sat a long way left of the
// line it folded, and further away the deeper the row. The affordance has to be
// attached to its own row or it reads as chrome floating over the document.
//
// So the marker is now a WIDGET at the line's first non-whitespace character,
// drawn with a negative inline margin: it takes no horizontal space (the document
// does not reflow when a line becomes foldable) and it sits immediately left of
// the bullet or task checkbox, moving with the indent. The gutter is gone
// entirely, because a marker that hugs the content plus a gutter that reserves a
// column would say the same thing twice.

import { EditorView, ViewPlugin, WidgetType, Decoration } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import {
  codeFolding,
  foldable,
  foldedRanges,
  foldEffect,
  unfoldEffect,
} from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { listFoldService } from "./list-fold";
import i18n from "@myne/editor/i18n";

// E2E observability (SYNC-8). `<screen>.<element>` naming. Renamed from
// `editor.fold-gutter-marker` in the same change that removed the gutter: the
// old name described a placement that no longer exists, and every consumer
// (e2e/heading-list-folding.e2e.ts, agent-tooling/docs/dev/userguide-screenshots.md) moved
// with it.
const MARKER_TESTID = "editor.fold-marker";
const PLACEHOLDER_TESTID = "editor.fold-placeholder";

/** A foldable line's arrow. `open` = the line CAN be folded (a ⌄ that
 *  hover-reveals); `!open` = the line IS folded (a › that stays visible so it
 *  can be clicked to unfold). */
class FoldMarker extends WidgetType {
  constructor(
    readonly open: boolean,
    readonly range: { from: number; to: number },
  ) {
    super();
  }

  override eq(other: FoldMarker): boolean {
    return (
      other.open === this.open &&
      other.range.from === this.range.from &&
      other.range.to === this.range.to
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-fold-marker";
    span.setAttribute("data-testid", MARKER_TESTID);
    span.setAttribute("data-fold-open", String(this.open));
    span.setAttribute("aria-hidden", "true");
    // The glyph itself is drawn by CSS from `data-fold-open` (theme.ts), not
    // written as a text node. This marker lives INSIDE `.cm-line` now, so a text
    // node here would join the line's `textContent` — every reader, every copy of
    // a line, and every test that asserts a line's text would carry a ⌄ that is
    // not in the document. The attribute is the state; the stylesheet is the
    // picture.
    span.addEventListener("mousedown", (e) => {
      // Without this the click moves the caret into the line first, which can
      // scroll the fold target into view and make the placeholder jump.
      e.preventDefault();
    });
    span.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        effects: (this.open ? foldEffect : unfoldEffect).of(this.range),
      });
    });
    return span;
  }

  /** Inline: never contributes height. */
  override get estimatedHeight(): number {
    return -1;
  }
}

/** The fold range each FOLDED line owns, keyed by line number. */
function foldedLines(state: EditorState): ReadonlySet<number> {
  const out = new Set<number>();
  foldedRanges(state).between(0, state.doc.length, (from) => {
    out.add(state.doc.lineAt(from).number);
  });
  return out;
}

function buildMarkers(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const state = view.state;
  const folded = foldedLines(state);
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      const range = foldable(state, line.from, line.to);
      if (range !== null) {
        // First non-whitespace character: the marker hugs the bullet / checkbox
        // / heading text instead of sitting in a column of its own.
        const indent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
        builder.add(
          line.from + indent,
          line.from + indent,
          Decoration.widget({
            widget: new FoldMarker(!folded.has(line.number), range),
            side: -1,
          }),
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** Fold/unfold changes move no text, so they arrive as an EFFECT with no
 *  `docChanged` flag — without this the arrows would keep saying "open" on a
 *  section that is already collapsed. */
function touchedFolds(update: ViewUpdate): boolean {
  return update.transactions.some((tr) =>
    tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)),
  );
}

const inlineMarkers = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMarkers(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        touchedFolds(update)
      ) {
        this.decorations = buildMarkers(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** The collapsed-section placeholder shown inline where text was folded. */
function foldPlaceholder(_view: EditorView, onclick: (event: Event) => void): HTMLElement {
  const el = document.createElement("span");
  el.className = "cm-foldPlaceholder";
  el.setAttribute("data-testid", PLACEHOLDER_TESTID);
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", i18n.t("editor.folding.unfold"));
  el.title = i18n.t("editor.folding.clickToUnfold");
  el.textContent = "⋯";
  el.addEventListener("click", onclick);
  return el;
}

/** The composed folding extension — heading-section folding (free, via
 *  lang-markdown's foldService) + nested-list folding + the inline
 *  hover-reveal arrows + the inline placeholder. */
export function myneFolding(): import("@codemirror/state").Extension {
  return [
    codeFolding({ placeholderDOM: foldPlaceholder }),
    inlineMarkers,
    listFoldService(),
  ];
}
