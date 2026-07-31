// Shared "⋯" overflow action menu for resolved-attachment widgets
// (generic file-card + audio player, MYND-173 / MYND-259).
//
// The menu is body-mounted (portaled out of the editor so `.cm-scroller`
// overflow can't clip it) and positioned with fixed viewport coordinates in
// JS — so its styles live in the global stylesheet (`./styles.ts`), reusing
// the `.cm-attachment-file-card-menu*` classes. The in-card "⋯" button reuses
// the `.cm-attachment-file-card-menubtn` class (editor-scoped, in `theme.ts`).
//
// Extracted from `AttachmentFileCardWidget.buildMenu` so the audio-player
// widget shares one menu implementation rather than a second copy. All visible
// text is set via `textContent` (never `innerHTML`) per TB2.

import i18n from "@myne/editor/i18n";
import { ensureAttachmentInsertStyles } from "./styles";

/** One row of the overflow menu. */
export interface OverflowAction {
  readonly label: string;
  /** `data-testid` for the menu item (E2E observability, SYNC-8). */
  readonly testid: string;
  readonly run: () => void;
  /** OPTIONAL — render the row DISABLED (greyed, non-activating) but NOT omitted
   *  (disabled-not-hidden discipline; MYND-552 Transcribe row when AI is off /
   *  the folder is excluded). The real label is kept; `run` never fires. */
  readonly disabled?: boolean;
  /** OPTIONAL — why the row is disabled, surfaced as the row's `title` + aria so
   *  the reason is discoverable (e.g. "Enable AI in Settings → Labs → AI"). */
  readonly disabledReason?: string;
}

export interface OverflowMenuOptions {
  /** `data-testid` for the "⋯" toggle button. */
  readonly buttonTestId: string;
  /** `data-testid` for the portaled menu container. */
  readonly menuTestId: string;
}

/**
 * Build a "⋯" overflow button plus its toggle-on-click, body-mounted action
 * menu. Returns the `wrap` element to append into the widget and a `teardown`
 * to call from the widget's `destroy()` so a menu left open cannot outlive the
 * widget DOM (its document `mousedown` listener would otherwise leak).
 */
export function buildOverflowMenu(
  actions: ReadonlyArray<OverflowAction> | (() => ReadonlyArray<OverflowAction>),
  opts: OverflowMenuOptions,
): { wrap: HTMLElement; teardown: () => void } {
  const wrap = document.createElement("span");
  wrap.className = "cm-attachment-file-card-menuwrap";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-attachment-file-card-menubtn";
  button.setAttribute("data-testid", opts.buttonTestId);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", i18n.t("editor.attachment.menu.actionsAria"));
  button.textContent = "⋯";
  wrap.appendChild(button);

  let menu: HTMLElement | null = null;
  const onDocPointerDown = (e: MouseEvent) => {
    const t = e.target as Node;
    if (menu !== null && !menu.contains(t) && !wrap.contains(t)) closeMenu();
  };
  // The body-mounted menu does not track the editor on scroll; close it on
  // scroll / resize (the library AttachmentActionMenu discipline).
  const onReflow = () => closeMenu();
  const closeMenu = () => {
    menu?.remove();
    menu = null;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onDocPointerDown, true);
    window.removeEventListener("scroll", onReflow, true);
    window.removeEventListener("resize", onReflow);
  };
  const openMenu = () => {
    ensureAttachmentInsertStyles(); // body-mounted → global styles, not the theme
    menu = document.createElement("div");
    menu.className = "cm-attachment-file-card-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-testid", opts.menuTestId);

    // Resolve per-open: a provider fn lets a widget re-read live editor state
    // (e.g. the transcription facet, MYND-592) each time the menu opens rather
    // than freezing the row set at widget `toDOM` time — the widget is not
    // re-created when a compartment reconfigures, so a frozen list goes stale.
    const items = typeof actions === "function" ? actions() : actions;
    for (const action of items) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cm-attachment-file-card-menuitem";
      item.setAttribute("role", "menuitem");
      item.setAttribute("data-testid", action.testid);
      item.textContent = action.label;
      if (action.disabled === true) {
        // Disabled-not-hidden: keep the real label, block activation, and surface
        // the reason (title + aria-disabled). No click handler is attached.
        item.disabled = true;
        item.setAttribute("aria-disabled", "true");
        item.classList.add("cm-attachment-file-card-menuitem-disabled");
        if (action.disabledReason !== undefined) item.title = action.disabledReason;
      } else {
        item.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeMenu();
          action.run();
        });
      }
      menu.appendChild(item);
    }

    // Body-mounted (portaled) so the editor's `.cm-scroller` overflow can't
    // clip it. `position: fixed` is set BEFORE measuring so the menu shrinks to
    // its content width — a block-flow `<div>` would otherwise measure as the
    // full body width and throw the right-alignment math off-screen. Then:
    // viewport-clamped FIXED coordinates — right-aligned to the button, flipped
    // above when there's no room below, clamped horizontally.
    document.body.appendChild(menu);
    menu.style.position = "fixed";
    menu.style.zIndex = "1200";
    const btn = button.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(
      margin,
      Math.min(btn.right - m.width, window.innerWidth - m.width - margin),
    );
    const top =
      btn.bottom + m.height + margin > window.innerHeight
        ? Math.max(margin, btn.top - m.height - 4)
        : btn.bottom + 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    button.setAttribute("aria-expanded", "true");
    // The dismiss listener is on `mousedown` while the toggle is on `click`, so
    // the opening interaction's mousedown has already passed — no deferral.
    document.addEventListener("mousedown", onDocPointerDown, true);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
  };

  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (menu !== null) closeMenu();
    else openMenu();
  });

  return { wrap, teardown: () => closeMenu() };
}
