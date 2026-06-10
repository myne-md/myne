// `<DeleteConfirmModal>` — destructive confirmation for note delete.
//
// Design canon: Penpot `screen------delete-confirm-modal` (id
// `01376058-0c2f-8002-8008-0662574a8abb`), `flow--notes-sidebar` board.
// Pattern reuses the `<SettingsModal>` backdrop+modal envelope.
//
// Per Q14 d1 (modal confirmation, destructive irreversible) +
// `decisions.md` 2026-05-07 "Note delete cryptographic erase" (hard-
// delete; no soft-trash until MYND-133 / v0.2).
//
// PRD stories 35-38:
// - Title "Delete this note?" + body `"{title}"` + warning "This cannot be undone."
// - Cancel (default focus, safer) + Delete (destructive `var(--warning)` fill).
// - Esc → Cancel; Enter on focused Delete → Confirm; backdrop click → Cancel.

import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";

// Shared modal backdrop envelope — also imported by `<TrashPanel>` so the two
// trash-related modals don't re-declare the same fixed-inset dim layer.
export const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const MODAL_STYLE: CSSProperties = {
  width: 380,
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3)",
  boxShadow: "var(--shadow-3)",
  padding: "var(--space-5)",
  fontFamily: "var(--font-sans)",
};

const TITLE_STYLE: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "var(--fg-1)",
  margin: 0,
  marginBottom: 12,
};

const BODY_TITLE_STYLE: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: "var(--fg-2)",
  margin: 0,
  marginBottom: 4,
  wordBreak: "break-word",
};

const BODY_WARNING_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  margin: 0,
  marginBottom: 20,
};

const BUTTON_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};

const BUTTON_BASE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  padding: "8px 14px",
  borderRadius: 6,
  cursor: "pointer",
  border: "1px solid transparent",
};

const CANCEL_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_BASE_STYLE,
  background: "var(--paper-2)",
  color: "var(--fg-1)",
  border: "1px solid var(--line-2)",
};

const DELETE_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_BASE_STYLE,
  background: "var(--warning)",
  color: "var(--accent-on)",
  border: "1px solid var(--warning)",
};

export type DeleteConfirmModalProps = {
  /**
   * Single-note mode: the note title (or null → "Untitled"), rendered quoted
   * as the body line. Omit when supplying a custom `body` (e.g. empty-trash).
   */
  noteTitle?: string | null;
  /** Heading override. Default: "Delete this note?". */
  title?: string;
  /** Body line override (shown above the warning). Default: the quoted note title. */
  body?: string;
  /**
   * Warning line override (shown below the body, muted). Default:
   * "This cannot be undone." Pass a softer line for recoverable actions (e.g.
   * a folder delete that only soft-trashes its notes).
   */
  warning?: string;
  /** Confirm-button label override. Default: "Delete". */
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteConfirmModal(props: DeleteConfirmModalProps) {
  const { noteTitle, title, body, warning, confirmLabel, onCancel, onConfirm } =
    props;
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Default-focus on Cancel (safer destructive UX).
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Esc → Cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const handleBackdropClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // Only cancel if the click target IS the backdrop (not a child).
      if (e.target === e.currentTarget) onCancel();
    },
    [onCancel],
  );

  const displayTitle =
    noteTitle === null || noteTitle === undefined || noteTitle.trim() === ""
      ? "Untitled"
      : noteTitle;
  const bodyLine = body ?? `“${displayTitle}”`;

  return (
    <div style={BACKDROP_STYLE} onClick={handleBackdropClick} role="presentation">
      <div
        style={MODAL_STYLE}
        role="alertdialog"
        aria-labelledby="delete-confirm-title"
        aria-describedby="delete-confirm-body"
      >
        <h2 id="delete-confirm-title" style={TITLE_STYLE}>
          {title ?? "Delete this note?"}
        </h2>
        <p id="delete-confirm-body" style={BODY_TITLE_STYLE}>
          {bodyLine}
        </p>
        <p style={BODY_WARNING_STYLE}>{warning ?? "This cannot be undone."}</p>
        <div style={BUTTON_ROW_STYLE}>
          <button
            ref={cancelRef}
            type="button"
            data-testid="delete-confirm.cancel"
            onClick={onCancel}
            style={CANCEL_BUTTON_STYLE}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="delete-confirm.confirm"
            onClick={onConfirm}
            style={DELETE_BUTTON_STYLE}
          >
            {confirmLabel ?? "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
