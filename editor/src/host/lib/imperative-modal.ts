// `openModal` — the shared skeleton for the vanilla-DOM (non-React) modals that
// mount to `document.body`: the text prompt (`promptForText` / `renamePrompt`),
// the attachment diff-preview + wikilink converter (`diff-preview` /
// `convert-command`), and the attachment lightbox. Each of those hand-rolled the
// SAME four pieces — a fixed full-screen backdrop, backdrop-click + Esc
// dismissal, a focus trap (MYND-93), and idempotent teardown — differing only in
// the content they append and whether Enter commits. This centralises that
// skeleton so the four guarantees are defined once.
//
// The caller builds its own content into `backdrop` (styled by class or inline),
// calls `installTrap` once the content is in place, and calls `close()` (or lets
// Esc / backdrop-click fire `onDismiss`) to tear down. `close()` releases the
// trap, removes the document keydown listener, and removes the backdrop — it is
// idempotent, so a caller's own `finish`/`cleanup` may call it freely.

import { trapFocus } from "./imperative-focus-trap";

export interface OpenModalOptions {
  /** className for the backdrop (CSS-class modals: diff/convert/lightbox). */
  readonly backdropClass?: string;
  /** Inline styles merged onto the backdrop (inline-style modals: the prompts). */
  readonly backdropStyle?: Partial<CSSStyleDeclaration>;
  /** Fired on Esc or a click on the backdrop itself (not its children). */
  readonly onDismiss: () => void;
  /** Fired on Enter, receiving the event so the caller owns whether to consume
   *  it (`preventDefault`/`stopPropagation`) — Enter-commit is conditional and
   *  per-modal (unconditional for the prompts, gated on a static rewrite count
   *  for diff-preview, on a live `disabled` flag for the converter). Omit for
   *  surfaces with no primary commit (the lightbox). */
  readonly onEnter?: (e: KeyboardEvent) => void;
}

export interface OpenModal {
  /** The backdrop element — append the dialog/content to it. */
  readonly backdrop: HTMLDivElement;
  /** Install the focus trap on `root` (call after content is appended). The
   *  lightbox traps on the backdrop itself; the card modals trap on the inner
   *  dialog so a backdrop click still lands the dismissal. */
  readonly installTrap: (root: HTMLElement, initialFocus?: HTMLElement | null) => void;
  /** Release the trap, remove the keydown listener, and remove the backdrop.
   *  Idempotent — safe to call from the caller's own teardown and again on Esc. */
  readonly close: () => void;
}

/**
 * Create + mount a modal backdrop wired for Esc / backdrop-click dismissal and
 * (optionally) Enter commit. Returns the backdrop to fill, an `installTrap`
 * hook, and an idempotent `close`. Caller must guard for a DOM itself (node test
 * env) — this touches `document` unconditionally.
 */
export function openModal(options: OpenModalOptions): OpenModal {
  const { backdropClass, backdropStyle, onDismiss, onEnter } = options;

  const backdrop = document.createElement("div");
  if (backdropClass !== undefined) backdrop.className = backdropClass;
  if (backdropStyle !== undefined) Object.assign(backdrop.style, backdropStyle);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) onDismiss();
  });

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    } else if (e.key === "Enter" && onEnter !== undefined) {
      // The caller decides whether to consume Enter — it may be a no-op when
      // there is nothing to commit (in which case Enter must keep propagating).
      onEnter(e);
    }
  };

  let releaseTrap: (() => void) | null = null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    releaseTrap?.();
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  };

  document.body.appendChild(backdrop);
  document.addEventListener("keydown", onKey, true);

  const installTrap = (
    root: HTMLElement,
    initialFocus?: HTMLElement | null,
  ): void => {
    releaseTrap = trapFocus(root, { initialFocus });
  };

  return { backdrop, installTrap, close };
}
