// Command scope / "when" context model for the window-level keybind engine
// (hotkeys epic, MYND-304; SYNC-2). Reconstructs a single context object from
// signals that already exist in the app (CommandContext's stageName +
// selectedNoteId, the focused DOM element, the active modal) — NO new state —
// and decides whether a given binding is active in that context + how to order
// competing bindings (precedence: most-specific active scope first, then global).
//
// This is the model the dispatcher (sibling task) gates on. The capture-vs-bubble
// PHASE distinction (SYNC-8, the Cmd-[/] CodeMirror-shadowing case) is a separate
// per-binding property handled by the dispatcher, not part of this scope model.

import type { AppStageName } from "./registry";

export type FocusKind = "cm-editor" | "plain-input" | "other";

export interface WhenContext {
  stageName: AppStageName;
  /** The kind of element with focus — drives the "stand down in plain inputs" rule. */
  focusKind: FocusKind;
  /** Whether a note is currently selected (per-note commands gate on this). */
  hasSelectedNote: boolean;
  /** The open modal id, or null. Window shortcuts stand down while a modal is open. */
  activeModal: string | null;
}

/**
 * The activation scope a binding declares (kept minimal — the v1-floor window
 * commands are editor-stage-scoped). All fields optional with safe defaults.
 */
export interface BindingScope {
  /** Stage the binding is active in. `undefined` ≡ active in every stage. */
  stage?: AppStageName;
  /** The binding requires a selected note (a per-note command). Default false. */
  requiresNote?: boolean;
  /**
   * The binding fires even while a plain `<input>`/`<textarea>` is focused.
   * Default false — almost every window shortcut stands down so the user can
   * type in a rename/search box (the "plain-input stand-down" rule).
   */
  allowInPlainInput?: boolean;
  /**
   * The binding fires even while a modal (Settings / palette / switcher) is
   * open. Default false — window shortcuts stand down under a modal.
   */
  allowInModal?: boolean;
}

/**
 * Classify a DOM focus target. The CM6 editor surface (`.cm-content`) is NOT a
 * plain input — window shortcuts stay live there; a bare `<input>`/`<textarea>`
 * is `plain-input`. The single focus classifier shared by the scope gate and
 * the Ctrl+Tab inline handler in Editor.tsx.
 */
export function focusKindOf(target: EventTarget | null): FocusKind {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return "other";
  }
  if (target.classList.contains("cm-content")) return "cm-editor";
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") return "plain-input";
  return "other";
}

/** Build the "when" context from the existing app signals — no new state. */
export function deriveWhenContext(
  source: { stageName: AppStageName; selectedNoteId: unknown },
  target: EventTarget | null,
  activeModal: string | null,
): WhenContext {
  return {
    stageName: source.stageName,
    focusKind: focusKindOf(target),
    hasSelectedNote: source.selectedNoteId != null,
    activeModal,
  };
}

/**
 * Whether a binding with the given scope is active in the given context. The
 * gate, in order: a focused plain input stands shortcuts down (unless
 * `allowInPlainInput`); an open modal stands shortcuts down (unless
 * `allowInModal`); a per-note binding needs a selected note; a stage-scoped
 * binding needs that stage.
 */
export function isBindingActive(scope: BindingScope, ctx: WhenContext): boolean {
  if (ctx.focusKind === "plain-input" && !scope.allowInPlainInput) return false;
  if (ctx.activeModal !== null && !scope.allowInModal) return false;
  if (scope.requiresNote && !ctx.hasSelectedNote) return false;
  if (scope.stage !== undefined && scope.stage !== ctx.stageName) return false;
  return true;
}

/**
 * Specificity score for precedence — higher wins when several active bindings
 * match one chord. A per-note binding and a stage-scoped binding are more
 * specific than a global one (SYNC-2: most-specific active scope first).
 */
export function scopeSpecificity(scope: BindingScope): number {
  let score = 0;
  if (scope.requiresNote) score += 2;
  if (scope.stage !== undefined) score += 1;
  return score;
}
