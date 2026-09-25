// `ModalShell` — the shared chrome for the desktop modal carve-out
// (`decisions.md` 2026-05-08): backdrop, Esc-dismiss, backdrop-click-dismiss,
// the `role="dialog"` wrapper, focus trap + focus restore (via `useFocusTrap`,
// MYND-93 — so `aria-modal="true"` is truthful), and the header (title + close
// button). Callers supply the body as children.
//
// Used by the note-templates modals (`TemplatesManager`,
// `NewNoteFromTemplateModal`). NOT retrofitted onto `SettingsModal` /
// `CommandPalette`: those carry extra keyboard behavior (in-flight dismissal
// gating, arrow-key rail nav) that doesn't fit a generic unconditional-dismiss
// shell — forcing them in would couple unrelated concerns. If a future modal
// needs gated dismissal, add an optional `canDismiss?: () => boolean` here
// rather than re-hand-rolling the shell.

import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useOverlayInert } from "../../hooks/useOverlayInert";
import { ornamentRole } from "@myne/ornaments";

interface ModalShellProps {
  open: boolean;
  /** Header title (may change across steps). */
  title: ReactNode;
  /** Dismiss handler — fired by Esc, backdrop click, and the close button. */
  onClose: () => void;
  /** `id` linking the dialog to its title for `aria-labelledby`. */
  labelId: string;
  /** Fixed modal width in px (default 480). */
  width?: number;
  /** Optional fixed modal height in px; omit for content-sized height. */
  height?: number;
  /** Accessible label for the close button (default "Close"). */
  closeLabel?: string;
  /**
   * `data-testid` for the backdrop root — the element whose presence means
   * "this dialog is up". Optional because most callers put their testids on
   * the controls inside; the consent dialogs need it because their E2E waits
   * on the surface itself.
   */
  testId?: string;
  /**
   * Stacking level for the backdrop. Defaults to the shared modal level, which
   * is correct for anything the user opened themselves — those are opened one
   * at a time, by an owner that closes the previous one first.
   *
   * Raise it only for a surface that can appear UNSOLICITED over whatever is
   * already open (MYND-567's deep-link install confirmation is the first).
   * Such a surface at the shared level paints *under* the command palette
   * (1500) and quick picker (1600) while the focus trap — which stacks by open
   * order, not by z-index — still hands it focus: an invisible dialog holding
   * the keyboard.
   */
  zIndex?: number;
  children: ReactNode;
}

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  // Smooth entry (shared with SettingsModal). Reduced-motion zeroes it globally.
  animation: "settings-backdrop-in var(--duration-fast) var(--ease-standard)",
};

/** Above the command palette (1500) and quick picker (1600) — for a surface
 *  that can appear without the user having opened it. */
export const UNSOLICITED_MODAL_Z = 1700;

const HEADER_STYLE: CSSProperties = {
  height: 56,
  padding: "0 var(--space-5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  borderBottom: "1px solid var(--line-1)",
  flex: "0 0 auto",
};

const TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-xl)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "var(--tracking-tight)",
  color: "var(--fg-1)",
  margin: 0,
};

const CLOSE_BUTTON_STYLE: CSSProperties = {
  background: "none",
  border: 0,
  color: "var(--fg-3)",
  cursor: "pointer",
  padding: 6,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "var(--radius-1)",
};

const BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

export function ModalShell({
  open,
  title,
  onClose,
  labelId,
  width = 480,
  height,
  closeLabel = "Close",
  zIndex,
  testId,
  children,
}: ModalShellProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // Trap + restore focus while open so `aria-modal="true"` is truthful (MYND-93).
  const modalRef = useRef<HTMLDivElement>(null);
  // And make the rest of the page INERT while it is open (myne-md/myne#728).
  // The trap contains Tab; it does not stop a screen reader's virtual cursor
  // from reading the page behind the dialog, and `aria-modal` is an assertion
  // some assistive technology ignores. The BACKDROP is registered, not the
  // card: the backdrop is the whole overlay, and inerting the card's own
  // siblings would inert the backdrop it sits in.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, open);
  useFocusTrap(modalRef, { enabled: open });

  if (!open) return null;

  const modalStyle: CSSProperties = {
    width,
    maxWidth: "calc(100vw - var(--space-7))",
    ...(height !== undefined ? { height } : {}),
    maxHeight: "calc(100vh - var(--space-7))",
    background: "var(--bg-2)",
    border: "1px solid var(--line-1)",
    borderRadius: "var(--radius-2)",
    boxShadow: "var(--shadow-3)",
    display: "flex",
    flexDirection: "column",
    fontFamily: "var(--font-sans)",
    color: "var(--fg-1)",
    overflow: "hidden",
    // Smooth entry (rise + fade), shared with SettingsModal.
    animation: "settings-modal-in var(--duration-base) var(--ease-standard)",
  };

  return (
    <div
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
      data-testid={testId}
      style={zIndex === undefined ? BACKDROP_STYLE : { ...BACKDROP_STYLE, zIndex }}
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        // The modal card is a SURFACE for ornament purposes (myne#394). Marked
        // on the card rather than the backdrop: a themed dialog should wear the
        // theme, while the dimmed page behind it should not.
        {...ornamentRole("surface")}
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={HEADER_STYLE}>
          <h2 id={labelId} style={TITLE_STYLE}>
            {title}
          </h2>
          <button
            type="button"
            aria-label={closeLabel}
            // Namespaced from the caller's `testId` so a shared primitive does
            // not publish one global name for every modal's close button; the
            // bare `modal-close` remains the default for callers without one.
            data-testid={testId === undefined ? "modal-close" : `${testId}-close`}
            onClick={onClose}
            style={CLOSE_BUTTON_STYLE}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={BODY_STYLE}>{children}</div>
      </div>
    </div>
  );
}
