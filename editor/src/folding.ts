// CodeMirror 6 folding for the Myne editor (heading-list-folding / MYND-300,
// tasks 1+2). Compose `myneFolding()` into `myneExtensions()`.
//
// Three pieces, all from the already-pinned `@codemirror/language@6.12.3` (NO
// new dependency — adding one is a security decision per CLAUDE.md):
//   1. `codeFolding()` — the fold state machine + the collapsed-range
//      placeholder. We supply a custom `placeholderDOM` so the folded line shows
//      a clear, clickable Myne-styled placeholder (data-testid for E2E).
//   2. `foldGutter()` — the gutter affordance. HOVER-REVEAL (story 6): the
//      "can fold" arrow is invisible until the gutter/editor is hovered (CSS in
//      theme.ts). A line that IS folded keeps its marker visible regardless of
//      hover, so the user can always find + unfold it. Custom `markerDOM`
//      carries `data-testid` + a `data-fold-open` boolean for E2E.
//   3. `listFoldService()` — the one custom fold service (nested lists,
//      children-only). Heading-SECTION fold ranges already exist in editor state
//      (lang-markdown composes a `headerIndent` foldService), so mounting the
//      above SURFACES them with no custom heading fold logic.
//
// Fold state is EPHEMERAL by design — no persistence (no vault.workspace /
// vault.prefs field). CM6 loses fold state on unmount, which is exactly the
// note-switch / lock / quit reset the PRD specifies.

import { EditorView } from "@codemirror/view";
import { codeFolding, foldGutter } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { listFoldService } from "./list-fold";
import i18n from "@myne/editor/i18n";

// E2E observability (SYNC-8). `<screen>.<element>` naming.
const GUTTER_MARKER_TESTID = "editor.fold-gutter-marker";
const PLACEHOLDER_TESTID = "editor.fold-placeholder";

/** The gutter fold arrow. `open` = the line CAN be folded (shows a ⌄ that
 *  hover-reveals); `!open` = the line IS folded (shows a › that stays visible
 *  so it can be clicked to unfold). */
function foldMarker(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = "cm-fold-marker";
  span.setAttribute("data-testid", GUTTER_MARKER_TESTID);
  span.setAttribute("data-fold-open", String(open));
  span.setAttribute("aria-hidden", "true");
  // Triangles drawn as glyphs; CSS (theme.ts) handles color + hover-reveal.
  span.textContent = open ? "⌄" : "›";
  return span;
}

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
 *  lang-markdown's foldService) + nested-list folding + the hover-reveal gutter
 *  + the inline placeholder. */
export function myneFolding(): Extension {
  return [
    codeFolding({ placeholderDOM: foldPlaceholder }),
    foldGutter({ markerDOM: foldMarker }),
    listFoldService(),
  ];
}
