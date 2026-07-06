// Self-contained transient toast for editor-side attachment flows
// (epic MYND-164, sub-feature attachment-insert).
//
// WHY a private toast rather than the Editor's React `<Toast>`: the insert
// paths (paste / drop / `/attach` / import-&-convert) all live INSIDE
// CodeMirror plugins + commands, with no React context and no prop bridge to
// `Editor.tsx` (owned by the library agent — out of bounds for this feature).
// So this mirrors the slash menu's posture: a vanilla-DOM surface appended to
// `document.body`, styled by the shared floating-styles sheet, auto-dismissing.
//
// `showAttachmentToast(message)` is the single entry point. Setting a new
// message replaces the previous one. Pure-ish: a no-op when `document` is
// undefined (test/node env without jsdom), so the import flows stay testable.

import { ensureAttachmentInsertStyles, hasDom } from "./styles";

const DEFAULT_DURATION_MS = 3200;

let activeEl: HTMLDivElement | null = null;
let dismissTimer: number | null = null;

/**
 * Show a transient toast pinned bottom-right (auto-dismiss). Replaces any
 * currently-visible toast. No-op without a DOM (node test env).
 */
export function showAttachmentToast(
  message: string,
  durationMs: number = DEFAULT_DURATION_MS,
): void {
  if (!hasDom()) return;
  ensureAttachmentInsertStyles();

  if (dismissTimer !== null) {
    window.clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  if (activeEl !== null) {
    activeEl.remove();
    activeEl = null;
  }

  const el = document.createElement("div");
  el.className = "cm-attach-toast";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.textContent = message;
  document.body.appendChild(el);
  activeEl = el;

  dismissTimer = window.setTimeout(() => {
    el.remove();
    if (activeEl === el) activeEl = null;
    dismissTimer = null;
  }, durationMs);
}

/** Immediately remove any visible toast (test cleanup + cancel paths). */
export function dismissAttachmentToast(): void {
  if (dismissTimer !== null) {
    if (typeof window !== "undefined") window.clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  if (activeEl !== null) {
    activeEl.remove();
    activeEl = null;
  }
}
