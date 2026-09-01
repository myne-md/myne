// Self-contained transient toast for editor-side flows (attachment insert /
// paste / drop / `/attach` / convert, vim `:w`, wikilink convert, palette
// failures). Vanilla DOM appended to `document.body`, because those paths live
// INSIDE CodeMirror plugins + commands with no React context and no prop bridge
// to `Editor.tsx`.
//
// Shares the `.myne-toast` visual language (leading status icon, variant rail,
// slide in/out, dismiss ×) with the React `<Toast>` (src/components/Toast.tsx)
// via the styles in the app's `tokens.css`, so both toast paths look identical
// (#238). The legacy `cm-attach-toast` class is kept as a test/hook alias.
//
// `showAttachmentToast(message, variant?)` is the single entry point. Setting a
// new message replaces the previous one. Pure-ish: a no-op when `document` is
// undefined (test/node env without jsdom), so the import flows stay testable.

import { hasDom } from "./styles";
import { ICON_PATHS, type IconName } from "../host/lib/icons";
import i18n from "../i18n";

const DEFAULT_DURATION_MS = 3200;

/** Exit-slide duration before removal. Matches `--duration-base` (tokens.css)
 *  and the React `<Toast>`'s EXIT_MS. Removal is timer-driven, never
 *  transitionend-driven, so reduced motion (transition zeroed) still removes. */
const EXIT_MS = 180;

/** Semantic flavour → status icon + rail tint. `neutral` shows no icon. */
export type AttachmentToastVariant = "neutral" | "success" | "error" | "info";

const VARIANT_ICON: Record<AttachmentToastVariant, IconName | null> = {
  neutral: null,
  success: "circle-check",
  error: "circle-alert",
  info: "info",
};

/** Sink into the app's central toast store (#238). The app registers this at
 *  startup (src/editor-host.ts) so editor toasts join the shared <Toaster>
 *  stack. When unset — standalone editor / unit tests — we fall back to the
 *  self-contained pinned DOM toast below. */
type ToastSink = (message: string, variant: AttachmentToastVariant, durationMs: number) => void;
let toastSink: ToastSink | null = null;
export function setAttachmentToastSink(sink: ToastSink | null): void {
  toastSink = sink;
}

let activeEl: HTMLDivElement | null = null;
let dismissTimer: number | null = null;
let removeTimer: number | null = null;

function clearTimers(): void {
  if (dismissTimer !== null) {
    window.clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  if (removeTimer !== null) {
    window.clearTimeout(removeTimer);
    removeTimer = null;
  }
}

/** Dismiss button's accessible label. Guarded: the editor host (which backs
 *  `i18n.t`) may be unset in a bare test env — fall back to English rather than
 *  throwing inside a toast. */
function dismissLabel(): string {
  try {
    return i18n.t("common.dismiss");
  } catch {
    return "Dismiss";
  }
}

/** Inline SVG markup for one of our own icon paths — trusted, static data. */
function svgMarkup(name: IconName, size: number): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`
  );
}

/**
 * Show a transient toast pinned to the inline-end bottom corner (auto-dismiss).
 * Replaces any currently-visible toast. No-op without a DOM (node test env).
 */
export function showAttachmentToast(
  message: string,
  variant: AttachmentToastVariant = "neutral",
  durationMs: number = DEFAULT_DURATION_MS,
): void {
  // Preferred path: hand off to the app's central store so this toast joins the
  // shared stack. Only the fallback below needs a DOM.
  if (toastSink !== null) {
    toastSink(message, variant, durationMs);
    return;
  }
  if (!hasDom()) return;

  clearTimers();
  if (activeEl !== null) {
    activeEl.remove();
    activeEl = null;
  }

  const el = document.createElement("div");
  // `myne-toast` drives the shared styling (tokens.css); `--pinned` positions
  // this standalone fallback (the store-backed path uses the <Toaster> instead);
  // `cm-attach-toast` is the legacy test/hook alias.
  el.className = `myne-toast myne-toast--pinned myne-toast--${variant} cm-attach-toast`;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("data-testid", "attachment-toast");
  el.setAttribute("data-toast-state", "entering");

  const iconName = VARIANT_ICON[variant];
  if (iconName !== null) {
    const icon = document.createElement("span");
    icon.className = "myne-toast__icon";
    icon.innerHTML = svgMarkup(iconName, 16);
    el.appendChild(icon);
  }

  // The message is the ONLY text node in the toast — icon + dismiss are
  // text-free SVGs — so `el.textContent` stays exactly the message (E2E and the
  // attachment/coverPicker unit specs assert this).
  const msg = document.createElement("span");
  msg.className = "myne-toast__msg";
  msg.textContent = message;
  el.appendChild(msg);

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "myne-toast__dismiss";
  dismiss.setAttribute("aria-label", dismissLabel());
  dismiss.setAttribute("data-testid", "attachment-toast-dismiss");
  dismiss.innerHTML = svgMarkup("x", 14);
  dismiss.addEventListener("click", () => hideActive());
  el.appendChild(dismiss);

  document.body.appendChild(el);
  activeEl = el;

  // Next frame: flip to the visible state so the enter transition runs.
  requestAnimationFrame(() => {
    if (activeEl === el) el.setAttribute("data-toast-state", "visible");
  });

  dismissTimer = window.setTimeout(() => hideActive(), durationMs);
}

/** Play the exit slide on the active toast, then remove it. */
function hideActive(): void {
  if (activeEl === null) return;
  const el = activeEl;
  if (dismissTimer !== null) {
    window.clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  el.setAttribute("data-toast-state", "leaving");
  removeTimer = window.setTimeout(() => {
    el.remove();
    if (activeEl === el) activeEl = null;
    removeTimer = null;
  }, EXIT_MS);
}

/** Immediately remove any visible toast (test cleanup + cancel paths). */
export function dismissAttachmentToast(): void {
  clearTimers();
  if (activeEl !== null) {
    activeEl.remove();
    activeEl = null;
  }
}
