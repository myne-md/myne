// Presentational view for the in-note find bar (MYND-175, Task 1).
//
// Vanilla DOM builder, matching the editor's existing chrome convention:
// `src/editor/slash/plugin.ts` and `src/editor/toolbar/plugin.ts` are vanilla
// DOM ViewPlugins — there is NO React anywhere in the editor chrome. CodeMirror's
// `search({ createPanel })` hook hands back a raw DOM node, so a vanilla builder
// is the natural mount target; Task 2 wires this view to the @codemirror/search
// engine (query state, decorations, findNext/findPrevious + wrap, Esc-close).
//
// This is a pure view: it renders from `FindBarState` and emits user intent via
// `FindBarHandlers`. It owns no match state and talks to no engine — so its three
// states (idle / matches / no-match) can be exercised in isolation.
//
// Styles live in `../floating-styles.ts` (`.cm-find-bar*`), the established place
// for editor-chrome CSS that needs :hover / :focus / ::placeholder — none of which
// inline styles can express. Token mapping is verbatim from the approved Penpot
// frame (page "4 — Desktop UI Kit", board `find-bar--states`).

import { ICON_PATHS, type IconName } from "@myne/editor/host/lib/icons";
import i18n from "@myne/editor/i18n";

export type FindBarStatus = "idle" | "matches" | "no-match";

export interface FindBarState {
  /** Current query text. */
  query: string;
  /** Whether the case-sensitivity toggle is engaged. */
  caseSensitive: boolean;
  /**
   * - `idle`     — empty query: no count, no decorations (never "0/0").
   * - `matches`  — non-empty query with hits: show "k/N".
   * - `no-match` — non-empty query with zero hits: muted "No matches" (not an error).
   */
  status: FindBarStatus;
  /** 1-based ordinal + total; present only when `status === "matches"`. */
  match: { current: number; total: number } | null;
  /**
   * Whether the replace row is revealed (MYND-302). The bar opens as one
   * compact find row; the toggle expands a second row carrying the replace
   * input + the Replace / Replace-all buttons. In-memory only — never persisted.
   */
  expanded: boolean;
  /** Current replacement text (the replace input value). */
  replace: string;
  /**
   * The STORED form actually being searched, when the typed text found nothing
   * and was read back as a date (myne-md/myne#609). `null` on every ordinary
   * search, which is nearly all of them.
   *
   * It drives two things, and the second is not cosmetic. The bar says which
   * text produced the matches, because a search that silently looks for
   * something other than what was typed is a result nobody can explain. And
   * Replace is turned OFF while it is set: the matched bytes are the stored
   * `YYYY-MM-DD`, so a replacement typed in the reader's own format would be
   * written over them literally, `parseTaskInstant` would refuse the result, and
   * the task would drop out of every dated view. Replace All does that to every
   * task in the note at once.
   */
  dateFallback: string | null;
}

/** The id `aria-describedby` on the two Replace buttons points at, so the
 *  reason they are disabled is part of their accessible description rather
 *  than a `title` a disabled control never shows. */
const FALLBACK_ROW_ID = "cm-find-bar-date-fallback";

export interface FindBarHandlers {
  onQueryChange(query: string): void;
  onNext(): void;
  onPrev(): void;
  onToggleCase(): void;
  onClose(): void;
  /** Toggle the replace row open/closed (MYND-302). */
  onToggleReplace(): void;
  /** The replace input changed. */
  onReplaceChange(replace: string): void;
  /** Replace the current match and advance (replaceNext). */
  onReplaceOne(): void;
  /** Replace every match in one undoable transaction (replaceAll). */
  onReplaceAll(): void;
}

export interface FindBarView {
  /** Root element to mount (Task 2 inserts this into the CodeMirror panel DOM). */
  readonly dom: HTMLElement;
  /** The query input — exposed so Task 2 can attach Enter/Shift+Enter/Esc keydown. */
  readonly input: HTMLInputElement;
  /** The replace input — exposed so the extension can attach Enter/Esc keydown (MYND-302). */
  readonly replaceInput: HTMLInputElement;
  /** Re-render from a new state (count, no-match caption, toggle pressed, nav enablement). */
  update(state: FindBarState): void;
  /** Focus the query input and select its contents (open / re-open per browser parity). */
  focus(): void;
  /** Detach all listeners and remove the DOM. Call on panel destroy. */
  destroy(): void;
}

function svgIcon(name: IconName, size: number): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  // ICON_PATHS values are static, build-time string constants — no user input.
  svg.innerHTML = ICON_PATHS[name];
  return svg;
}

function makeButton(
  className: string,
  label: string,
  child: Node,
  testId?: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `cm-find-bar-btn ${className}`;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  if (testId !== undefined) btn.setAttribute("data-testid", testId);
  btn.appendChild(child);
  return btn;
}

function makeDivider(): HTMLSpanElement {
  const div = document.createElement("span");
  div.className = "cm-find-bar-divider";
  div.setAttribute("aria-hidden", "true");
  return div;
}

/**
 * A field: the input plus its decorative lead icon, which is positioned INSIDE
 * the input's own box rather than in a column beside it (myne#952).
 *
 * Why the wrapper rather than a sibling: the bar's row starts at its left edge
 * with the input, so an icon in front of it would be the one thing standing
 * between the reader and the field. Inside the field the glyph survives, the
 * input still owns the edge, and both rows (find and replace) put their text at
 * the same x, which is what made the old two-row alignment arithmetic
 * ("the toggle column plus the replace glyph line up") necessary in the first
 * place.
 */
function field(input: HTMLInputElement, icon: HTMLSpanElement): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = "cm-find-bar-field";
  wrap.append(icon, input);
  return wrap;
}

/**
 * Build the find-bar view. Presentational only — no engine, no match-finding.
 * The caller supplies the current `initial` state and the intent `handlers`.
 */
export function createFindBarView(
  initial: FindBarState,
  handlers: FindBarHandlers,
): FindBarView {
  const controller = new AbortController();
  const { signal } = controller;

  const dom = document.createElement("div");
  dom.className = "cm-find-bar";
  dom.setAttribute("role", "search");

  // The bar is a column: a compact find row by default, with the replace row
  // appended on demand (MYND-302). The find row carries the same flex chrome the
  // single-row bar had, so MYND-175 styling is unchanged.
  const findRow = document.createElement("div");
  findRow.className = "cm-find-bar-row cm-find-bar-find-row";

  // Replace-row expand/collapse toggle. A stacked chevron pair rather than a
  // single chevron (myne#952): a lone glyph next to Previous/Next sat two
  // identical down-chevrons side by side, one meaning "next match" and one
  // meaning "show the replace row", which is a coin flip for the reader. It
  // stays last among the controls so the input still owns the left edge.
  const toggleBtn = makeButton(
    "cm-find-bar-toggle",
    i18n.t("editor.find.toggleReplace"),
    svgIcon("chevrons-up-down", 16),
    "find.toggle-replace",
  );

  // Lead search icon, INSIDE the field (myne#952). The bar reads left to right
  // from the input now, so a standalone icon column in front of it pushed the
  // input off the edge the reader starts from. As a positioned prefix it still
  // says "this is a search box" without owning a column of its own.
  const lead = document.createElement("span");
  lead.className = "cm-find-bar-lead";
  lead.setAttribute("aria-hidden", "true");
  lead.appendChild(svgIcon("search", 16));

  // Query input.
  const input = document.createElement("input");
  input.type = "text";
  input.className = "cm-find-bar-input";
  const findPlaceholder = i18n.t("editor.find.placeholder");
  input.placeholder = findPlaceholder;
  input.setAttribute("aria-label", findPlaceholder);
  input.setAttribute("data-testid", "find.input");
  input.spellcheck = false;
  input.autocomplete = "off";
  input.value = initial.query;

  // Status slot — "k/N" (matches) | "No matches" (no-match) | hidden (idle).
  const status = document.createElement("span");
  status.className = "cm-find-bar-status";

  // Case-sensitivity toggle (text "Aa" glyph, matching the toolbar's glyph
  // convention and the approved frame; Lucide `case-sensitive` deferred).
  const caseGlyph = document.createElement("span");
  caseGlyph.textContent = "Aa";
  const caseBtn = makeButton("cm-find-bar-case", i18n.t("editor.find.matchCase"), caseGlyph);
  caseBtn.setAttribute("aria-pressed", String(initial.caseSensitive));

  // Prev / next navigation.
  const prevBtn = makeButton("cm-find-bar-prev", i18n.t("editor.find.previousMatch"), svgIcon("chevron-up", 16));
  const nextBtn = makeButton("cm-find-bar-next", i18n.t("editor.find.nextMatch"), svgIcon("chevron-down", 16));

  // Close.
  const closeBtn = makeButton("cm-find-bar-close", i18n.t("editor.find.close"), svgIcon("x", 14));

  // Visually-hidden polite live region: the visible count ("3/12") is terse and
  // monospace, so screen readers get a clearer spoken form here ("3 of 12" / "No
  // matches") that re-announces as you type or step through matches (MYND-175 a11y).
  const live = document.createElement("span");
  live.className = "cm-find-bar-a11y";
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");

  findRow.append(
    field(input, lead),
    status,
    makeDivider(),
    caseBtn,
    prevBtn,
    nextBtn,
    // The replace row's disclosure sits with the other controls rather than at
    // the lead edge (myne#952): the input owns the left edge, so a disclosure
    // glyph in front of it would be the one thing between the reader and the
    // field they opened the bar for. It still reads as a control pair with the
    // close button, which stays last.
    toggleBtn,
    makeDivider(),
    closeBtn,
    live,
  );

  // Date-fallback notice (myne-md/myne#609). Built once, attached only while a
  // fallback is live, so the ordinary bar is exactly what it was. It says which
  // text produced the matches, because after myne#609 a chip prints the reader's
  // format while the document holds the stored one, so typing what is on screen
  // finds nothing until the second pass runs. A silent second pass would leave
  // the user with a result they cannot account for.
  const fallbackRow = document.createElement("div");
  fallbackRow.className = "cm-find-bar-row cm-find-bar-fallback-row";
  fallbackRow.setAttribute("data-testid", "find.date-fallback");
  fallbackRow.id = FALLBACK_ROW_ID;
  // `status`, so the notice is ANNOUNCED rather than merely rendered. Without
  // it a screen-reader user hears the match count, arrives at a Replace button
  // that is disabled, and is never told the search ran against a different
  // string. Being told is the entire job of this row, so for that user the row
  // was doing nothing at all. `polite` because it lands mid-typing and must not
  // interrupt what the reader is composing.
  fallbackRow.setAttribute("role", "status");
  fallbackRow.setAttribute("aria-live", "polite");
  // Attached once and hidden, never inserted on demand. See the update below.
  fallbackRow.hidden = true;

  // Replace row (MYND-302). Built once and attached/detached from `dom` on the
  // expand toggle — the leading replace glyph lines up under the toggle column,
  // the replace input mirrors the find input, and the two action buttons sit on
  // the trailing edge. The "Replace all (N)" label tracks the live match total.
  const replaceRow = document.createElement("div");
  replaceRow.className = "cm-find-bar-row cm-find-bar-replace-row";

  const replaceLead = document.createElement("span");
  replaceLead.className = "cm-find-bar-lead cm-find-bar-replace-lead";
  replaceLead.setAttribute("aria-hidden", "true");
  replaceLead.appendChild(svgIcon("replace", 16));

  const replaceInput = document.createElement("input");
  replaceInput.type = "text";
  replaceInput.className = "cm-find-bar-input cm-find-bar-replace-input";
  const replacePlaceholder = i18n.t("editor.find.replacePlaceholder");
  replaceInput.placeholder = replacePlaceholder;
  replaceInput.setAttribute("aria-label", replacePlaceholder);
  replaceInput.setAttribute("data-testid", "find.replace-input");
  replaceInput.spellcheck = false;
  replaceInput.autocomplete = "off";
  replaceInput.value = initial.replace;

  const replaceOneBtn = document.createElement("button");
  replaceOneBtn.type = "button";
  replaceOneBtn.className = "cm-find-bar-action";
  replaceOneBtn.setAttribute("data-testid", "find.replace-one");
  replaceOneBtn.textContent = i18n.t("editor.find.replaceOne");

  const replaceAllBtn = document.createElement("button");
  replaceAllBtn.type = "button";
  replaceAllBtn.className = "cm-find-bar-action";
  replaceAllBtn.setAttribute("data-testid", "find.replace-all");
  replaceAllBtn.textContent = i18n.t("editor.find.replaceAll");

  // A spacer keeps the replace input aligned with the find input above (no lead
  // search-icon slot on the replace row; the toggle column + replace glyph do).
  replaceRow.append(field(replaceInput, replaceLead), replaceOneBtn, replaceAllBtn);
  // Mounted ONCE, always, and animated between open and closed (myne#952). It
  // used to be appended on expand and removed on collapse, which cannot be
  // animated: a removed element has nothing to transition from. What the removal
  // was really buying was "the collapsed row is unreachable", and `inert` says
  // exactly that — out of the tab order and out of the accessibility tree —
  // while the element keeps a box the stylesheet can animate. The initial state
  // is collapsed until the first `render` says otherwise.
  replaceRow.dataset.expanded = "false";
  replaceRow.setAttribute("inert", "");

  dom.append(findRow);
  // Attached here, once. The notice is a live region, so it must be present
  // before the text that must be announced arrives; the update below only
  // rewrites its text and toggles `hidden`. It sits between the find row and
  // the replace row, so the explanation for the disabled Replace buttons is
  // directly above them.
  dom.append(fallbackRow);
  dom.append(replaceRow);

  function render(state: FindBarState): void {
    if (input.value !== state.query) input.value = state.query;

    let liveText: string;
    if (state.status === "matches" && state.match) {
      status.textContent = `${state.match.current}/${state.match.total}`;
      status.className = "cm-find-bar-status cm-find-bar-status--count";
      liveText = i18n.t("editor.find.matchCount", {
        current: state.match.current,
        total: state.match.total,
      });
    } else if (state.status === "no-match") {
      const noMatch = i18n.t("editor.find.noMatches");
      status.textContent = noMatch;
      status.className = "cm-find-bar-status cm-find-bar-status--nomatch";
      liveText = noMatch;
    } else {
      status.textContent = "";
      status.className = "cm-find-bar-status cm-find-bar-status--hidden";
      liveText = "";
    }
    // Only rewrite the live region when it actually changes — re-assigning the
    // same text re-fires the screen-reader announcement on every cursor move.
    if (live.textContent !== liveText) live.textContent = liveText;

    caseBtn.classList.toggle("cm-find-bar-btn-active", state.caseSensitive);
    caseBtn.setAttribute("aria-pressed", String(state.caseSensitive));

    // Navigation only meaningful when there's a current match to step from.
    const hasMatches = state.status === "matches" && state.match !== null;
    prevBtn.disabled = !hasMatches;
    nextBtn.disabled = !hasMatches;

    // The date-fallback notice, and the row order it implies: the notice sits
    // between the find row and the replace row, so the explanation for the
    // disabled buttons is directly above them.
    //
    // The row is ATTACHED for the panel's lifetime and toggled with `hidden`,
    // rather than inserted and removed. A live region that enters the document
    // already carrying its text is not reliably announced: the announcement
    // comes from a mutation INSIDE a region that was already present, which is
    // why the match count one screen up is a persistent node whose text is
    // rewritten. Built the other way first, so the row that exists to tell a
    // screen-reader user why Replace is off told them nothing at all.
    const onFallback = state.dateFallback !== null;
    const fallbackText = onFallback
      ? i18n.t("editor.find.dateFallback", { stored: state.dateFallback })
      : "";
    // Same guard as the status line: re-assigning identical text re-fires the
    // announcement on every cursor move.
    if (fallbackRow.textContent !== fallbackText) fallbackRow.textContent = fallbackText;
    fallbackRow.hidden = !onFallback;

    // Replace row (MYND-302). The row is mounted for the panel's lifetime and
    // its open/closed state lives in two attributes: `data-expanded`, which the
    // stylesheet animates between zero and full height, and `inert`, which is
    // what "unreachable while closed" means now that the element is not removed
    // (see the note where the row is appended). The toggle carries the same
    // disclosure for assistive tech.
    toggleBtn.classList.toggle("cm-find-bar-btn-active", state.expanded);
    toggleBtn.setAttribute("aria-expanded", String(state.expanded));
    if (replaceRow.dataset.expanded !== String(state.expanded)) {
      replaceRow.dataset.expanded = String(state.expanded);
      if (state.expanded) replaceRow.removeAttribute("inert");
      else replaceRow.setAttribute("inert", "");
    }
    if (state.expanded) {
      if (replaceInput.value !== state.replace) replaceInput.value = state.replace;

      // Count-aware "Replace all (N)" — reuses the SAME live match total the find
      // count renders (k/N). No matches → bare "Replace all" (nothing to count).
      replaceAllBtn.textContent = hasMatches
        ? i18n.t("editor.find.replaceAllCount", { total: state.match!.total })
        : i18n.t("editor.find.replaceAll");

      // Replace acts on the current/all matches, so it is only meaningful with live
      // hits, and OFF entirely while the matches came from the date fallback.
      // The matched bytes are then the stored `YYYY-MM-DD`, so a replacement
      // written in the reader's own format lands on them literally and the field
      // stops parsing. It costs the user nothing: opening this panel reveals the
      // chips as raw text, so the correct string to type is already on screen.
      const canReplace = hasMatches && !onFallback;
      replaceOneBtn.disabled = !canReplace;
      replaceAllBtn.disabled = !canReplace;
      // The REASON is carried by the visible notice above and by
      // `aria-describedby`, not by a `title`. A browser dispatches no hover
      // events to a disabled control, so a `title` there never appears; it was
      // written that way first, and the E2E scenario then asserted the fix by
      // reading an attribute no user can reach.
      for (const btn of [replaceOneBtn, replaceAllBtn]) {
        if (onFallback) btn.setAttribute("aria-describedby", FALLBACK_ROW_ID);
        else btn.removeAttribute("aria-describedby");
      }
    } else {
      // Nothing to remove and nothing to disable by hand: the row collapses to
      // zero height through the stylesheet and is already `inert` above.
    }
  }

  input.addEventListener("input", () => handlers.onQueryChange(input.value), { signal });
  caseBtn.addEventListener("click", () => handlers.onToggleCase(), { signal });
  prevBtn.addEventListener("click", () => handlers.onPrev(), { signal });
  nextBtn.addEventListener("click", () => handlers.onNext(), { signal });
  closeBtn.addEventListener("click", () => handlers.onClose(), { signal });
  toggleBtn.addEventListener("click", () => handlers.onToggleReplace(), { signal });
  replaceInput.addEventListener(
    "input",
    () => handlers.onReplaceChange(replaceInput.value),
    { signal },
  );
  replaceOneBtn.addEventListener("click", () => handlers.onReplaceOne(), { signal });
  replaceAllBtn.addEventListener("click", () => handlers.onReplaceAll(), { signal });

  render(initial);

  return {
    dom,
    input,
    replaceInput,
    update: render,
    focus() {
      input.focus();
      input.select();
    },
    destroy() {
      controller.abort();
      dom.remove();
    },
  };
}
