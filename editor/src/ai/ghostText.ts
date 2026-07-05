// Inline AI ghost-text (writing-assistant MYND-410 tasks 2/3/4). Mirrors
// `src/editor/decorations/spell.ts`: a StateEffect → StateField delivers the
// model's short completion, rendered as a **dimmed inline widget** at the cursor
// (never in the buffer until accept), a debounced ViewPlugin fires one blocking
// `infer` on a paused cursor and cancels any in-flight request on change, and a
// `Prec.highest` Tab keymap accepts the suggestion **only while one is showing**
// (otherwise it falls through to `indentWithTab`).
//
// Design (own, no Penpot frame): the suggestion is `--fg-3` dimmed, italic,
// non-interactive, `data-testid="ai.ghost-text"`; it sits directly after the
// cursor. Dismissed by Esc or any document edit; a stale result (cursor moved /
// doc changed) is dropped, never rendered. Plain markdown on accept
// (`ai.insert`, one undo step) — no new format. Gated on `ai_enabled` at compose
// time (`myneExtensions`), so an off / excluded note carries none of this.

import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { buildCompletionPrompt, infer } from "@myne/editor/host/lib/writing-assistant";

/** Paused-cursor debounce before a ghost request fires (ms). Longer than
 *  spell's 120ms scan — a completion is heavier + more interruptive. */
export const GHOST_DEBOUNCE_MS = 700;

/** The live ghost suggestion: the model text + the doc offset it applies at. */
export interface GhostValue {
  text: string;
  from: number;
}

/** Deliver a suggestion (from the debounced trigger). */
export const setGhostSuggestion = StateEffect.define<GhostValue>();
/** Drop the current suggestion (Esc / accept / cancel). */
export const clearGhostSuggestion = StateEffect.define<null>();

/** The dimmed inline widget. Non-interactive; never selectable/editable. */
class GhostWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ai-ghost";
    span.dataset.testid = "ai.ghost-text";
    span.setAttribute("aria-hidden", "true");
    span.style.color = "var(--fg-3)";
    span.style.fontStyle = "italic";
    span.style.pointerEvents = "none";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** Build the widget decoration set for a ghost value (empty when none). */
function buildGhostDeco(value: GhostValue | null): DecorationSet {
  if (value === null || value.text.length === 0) return Decoration.none;
  return Decoration.set([
    Decoration.widget({ widget: new GhostWidget(value.text), side: 1 }).range(value.from),
  ]);
}

/** The StateField holding the current suggestion + its rendered decoration.
 *  Any document edit clears it (the edit dismisses — including the accept
 *  itself), as does a selection move. */
export const ghostField = StateField.define<GhostValue | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGhostSuggestion)) return e.value;
      if (e.is(clearGhostSuggestion)) return null;
    }
    if (tr.docChanged) return null;
    if (tr.selection && value !== null) return null;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, buildGhostDeco),
});

/** Whether a ghost suggestion is currently showing. */
export function ghostShowing(view: EditorView): boolean {
  return view.state.field(ghostField, false) != null;
}

/** Accept the showing suggestion: insert it as plain markdown at its offset
 *  (`ai.insert`, one undo step) and clear the field. Returns `false` when none
 *  is showing so the keymap falls through to `indentWithTab`. Exported for the
 *  keymap + tests. */
export function acceptGhost(view: EditorView): boolean {
  const g = view.state.field(ghostField, false);
  if (g == null) return false;
  view.dispatch({
    changes: { from: g.from, insert: g.text },
    selection: { anchor: g.from + g.text.length },
    effects: clearGhostSuggestion.of(null),
    userEvent: "ai.insert",
  });
  return true;
}

/** Dismiss the showing suggestion (Esc). Falls through when none is showing.
 *  Exported for the keymap + tests. */
export function dismissGhost(view: EditorView): boolean {
  if (view.state.field(ghostField, false) == null) return false;
  view.dispatch({ effects: clearGhostSuggestion.of(null) });
  return true;
}

/** `Prec.highest` Tab-to-accept + Esc-to-dismiss — both no-op (fall through)
 *  when no suggestion is showing, so Tab still indents and Esc still does its
 *  usual job. */
export const ghostKeymap: Extension = Prec.highest(
  keymap.of([
    { key: "Tab", run: acceptGhost },
    { key: "Escape", run: dismissGhost },
  ]),
);

/** The debounced trigger: on a paused **bare cursor**, fire one blocking `infer`
 *  and deliver the result — unless the cursor moved / doc changed meanwhile (a
 *  stale result is dropped). Mirrors the `spell.ts` scanner ViewPlugin. */
const ghostTriggerPlugin = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private reqToken = 0;

    update(update: ViewUpdate): void {
      if (!update.docChanged && !update.selectionSet) return;
      // Any change cancels an in-flight request + a pending timer.
      this.reqToken++;
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const sel = update.state.selection.main;
      // Only a single bare cursor (no selection) schedules a completion.
      if (!sel.empty) return;
      const view = update.view;
      this.timer = setTimeout(() => void this.fire(view), GHOST_DEBOUNCE_MS);
    }

    private async fire(view: EditorView): Promise<void> {
      this.timer = null;
      const token = ++this.reqToken;
      const cursor = view.state.selection.main.head;
      const preceding = view.state.sliceDoc(0, cursor);
      if (preceding.trim().length === 0) return; // nothing to continue from
      let completion: string;
      try {
        completion = await infer(buildCompletionPrompt(preceding));
      } catch {
        return; // engine off / error — no ghost
      }
      // Stale-guard: the request is invalid if anything changed while awaiting.
      if (token !== this.reqToken) return;
      if (view.state.selection.main.head !== cursor) return;
      if (completion.length === 0) return;
      view.dispatch({ effects: setGhostSuggestion.of({ text: completion, from: cursor }) });
    }

    destroy(): void {
      if (this.timer !== null) clearTimeout(this.timer);
    }
  },
);

/** The full ghost-text bundle — composed into `myneExtensions` only when
 *  `ai_enabled` (so an off / excluded note carries none of it). */
export function ghostTextExtension(): readonly Extension[] {
  return [ghostField, ghostKeymap, ghostTriggerPlugin];
}
