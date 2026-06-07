// `ModalShell` — the shared chrome for the desktop modal carve-out
// (`decisions.md` 2026-05-08): backdrop, Esc-dismiss, backdrop-click-dismiss,
// the `role="dialog"` wrapper, and the header (title + close button). Callers
// supply the body as children.
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
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";

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
};

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
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
      style={BACKDROP_STYLE}
      onClick={handleBackdropClick}
    >
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={HEADER_STYLE}>
          <h2 id={labelId} style={TITLE_STYLE}>
            {title}
          </h2>
          <button
            type="button"
            aria-label={closeLabel}
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
