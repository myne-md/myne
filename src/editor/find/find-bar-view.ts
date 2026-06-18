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

import { ICON_PATHS, type IconName } from "../../lib/icons";

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
}

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

const PLACEHOLDER = "Find in note";
const REPLACE_PLACEHOLDER = "Replace with";
const NO_MATCH_LABEL = "No matches";
const REPLACE_ALL_LABEL = "Replace all";
const REPLACE_ONE_LABEL = "Replace";

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

  // Replace-row expand/collapse toggle (chevron). Sits at the lead edge so the
  // two rows align under one disclosure control (Obsidian/VS Code pattern).
  const toggleBtn = makeButton(
    "cm-find-bar-toggle",
    "Toggle replace",
    svgIcon("chevron-right", 16),
    "find.toggle-replace",
  );

  // Lead search icon.
  const lead = document.createElement("span");
  lead.className = "cm-find-bar-lead";
  lead.setAttribute("aria-hidden", "true");
  lead.appendChild(svgIcon("search", 16));

  // Query input.
  const input = document.createElement("input");
  input.type = "text";
  input.className = "cm-find-bar-input";
  input.placeholder = PLACEHOLDER;
  input.setAttribute("aria-label", PLACEHOLDER);
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
  const caseBtn = makeButton("cm-find-bar-case", "Match case", caseGlyph);
  caseBtn.setAttribute("aria-pressed", String(initial.caseSensitive));

  // Prev / next navigation.
  const prevBtn = makeButton("cm-find-bar-prev", "Previous match", svgIcon("chevron-up", 16));
  const nextBtn = makeButton("cm-find-bar-next", "Next match", svgIcon("chevron-down", 16));

  // Close.
  const closeBtn = makeButton("cm-find-bar-close", "Close find", svgIcon("x", 14));

  // Visually-hidden polite live region: the visible count ("3/12") is terse and
  // monospace, so screen readers get a clearer spoken form here ("3 of 12" / "No
  // matches") that re-announces as you type or step through matches (MYND-175 a11y).
  const live = document.createElement("span");
  live.className = "cm-find-bar-a11y";
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");

  findRow.append(
    toggleBtn,
    lead,
    input,
    status,
    makeDivider(),
    caseBtn,
    prevBtn,
    nextBtn,
    makeDivider(),
    closeBtn,
    live,
  );

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
  replaceInput.placeholder = REPLACE_PLACEHOLDER;
  replaceInput.setAttribute("aria-label", REPLACE_PLACEHOLDER);
  replaceInput.setAttribute("data-testid", "find.replace-input");
  replaceInput.spellcheck = false;
  replaceInput.autocomplete = "off";
  replaceInput.value = initial.replace;

  const replaceOneBtn = document.createElement("button");
  replaceOneBtn.type = "button";
  replaceOneBtn.className = "cm-find-bar-action";
  replaceOneBtn.setAttribute("data-testid", "find.replace-one");
  replaceOneBtn.textContent = REPLACE_ONE_LABEL;

  const replaceAllBtn = document.createElement("button");
  replaceAllBtn.type = "button";
  replaceAllBtn.className = "cm-find-bar-action";
  replaceAllBtn.setAttribute("data-testid", "find.replace-all");
  replaceAllBtn.textContent = REPLACE_ALL_LABEL;

  // A spacer keeps the replace input aligned with the find input above (no lead
  // search-icon slot on the replace row; the toggle column + replace glyph do).
  replaceRow.append(replaceLead, replaceInput, replaceOneBtn, replaceAllBtn);

  dom.append(findRow);

  function render(state: FindBarState): void {
    if (input.value !== state.query) input.value = state.query;

    let liveText: string;
    if (state.status === "matches" && state.match) {
      status.textContent = `${state.match.current}/${state.match.total}`;
      status.className = "cm-find-bar-status cm-find-bar-status--count";
      liveText = `${state.match.current} of ${state.match.total}`;
    } else if (state.status === "no-match") {
      status.textContent = NO_MATCH_LABEL;
      status.className = "cm-find-bar-status cm-find-bar-status--nomatch";
      liveText = NO_MATCH_LABEL;
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

    // Replace row (MYND-302). Attach/detach on the expand toggle so the DOM
    // reflects the state exactly (no hidden-but-present row), and reflect the
    // disclosure on the toggle itself.
    toggleBtn.classList.toggle("cm-find-bar-btn-active", state.expanded);
    toggleBtn.setAttribute("aria-expanded", String(state.expanded));
    if (state.expanded) {
      if (replaceRow.parentNode === null) dom.append(replaceRow);
      if (replaceInput.value !== state.replace) replaceInput.value = state.replace;

      // Count-aware "Replace all (N)" — reuses the SAME live match total the find
      // count renders (k/N). No matches → bare "Replace all" (nothing to count).
      replaceAllBtn.textContent = hasMatches
        ? `${REPLACE_ALL_LABEL} (${state.match!.total})`
        : REPLACE_ALL_LABEL;

      // Replace acts on the current/all matches — only meaningful with live hits.
      replaceOneBtn.disabled = !hasMatches;
      replaceAllBtn.disabled = !hasMatches;
    } else if (replaceRow.parentNode !== null) {
      replaceRow.remove();
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
