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
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../../hooks/useFocusTrap";

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
  fontSize: "var(--text-md)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
  margin: 0,
  marginBottom: "var(--space-3)",
};

const BODY_TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-2)",
  margin: 0,
  marginBottom: "var(--space-1)",
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
  gap: "var(--space-2)",
};

const BUTTON_BASE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  padding: "8px 14px",
  borderRadius: "var(--radius-2)",
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
  /**
   * Confirm-button `data-testid` override (curated-prop testid discipline,
   * src/CLAUDE.md "Test observability"). Default: `"delete-confirm.confirm"`.
   * Callers whose E2E contract names a scoped confirm id (e.g. the
   * recovered-notes `sync.recovered-delete-confirm`) pass it here.
   */
  confirmTestId?: string;
  /**
   * Cancel-button `data-testid` override, symmetric with {@link confirmTestId}.
   * Default: `"delete-confirm.cancel"`. Callers whose E2E contract names a
   * scoped cancel id (e.g. the Archive folder-delete `archive.folder-delete-cancel`)
   * pass it here.
   */
  cancelTestId?: string;
  /**
   * Which button receives initial focus. Default `"cancel"` — the safer
   * choice for irreversible actions (folder delete, permanent purge), where a
   * stray Enter must not confirm. Pass `"confirm"` for the reversible
   * keyboard soft-trash gate (MYND-487) so Enter confirms / Escape cancels.
   */
  initialFocus?: "cancel" | "confirm";
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteConfirmModal(props: DeleteConfirmModalProps) {
  const { t } = useTranslation();
  const {
    noteTitle,
    title,
    body,
    warning,
    confirmLabel,
    confirmTestId,
    cancelTestId,
    initialFocus = "cancel",
    onCancel,
    onConfirm,
  } = props;
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Trap + restore focus while open. Default-focus Cancel (safer destructive
  // UX); `initialFocus="confirm"` moves it to the confirm button for the
  // reversible keyboard soft-trash gate. The modal only mounts while shown, so
  // always enabled (MYND-93).
  useFocusTrap(dialogRef, {
    enabled: true,
    initialFocusRef: initialFocus === "confirm" ? confirmRef : cancelRef,
  });

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

  // Enter handling, both branches load-bearing:
  //
  // - `initialFocus="confirm"` (reversible keyboard soft-trash gate, MYND-487)
  //   promises "Enter confirms / Escape cancels". An explicit handler is
  //   required — the focus trap places the confirm button's focus
  //   asynchronously and a focused <button>'s Enter→click default action is not
  //   fired reliably across WebViews (WebKitGTK under the E2E harness), so
  //   relying on button focus alone drops the confirm.
  //
  // - cancel-focused (the default; irreversible folder delete / permanent
  //   purge, and the recoverable soft-trash confirms we still withhold from
  //   Enter) swallows Enter as a no-op. Cancel holds initial focus, so a bare
  //   Enter would otherwise fire its native click and dismiss the dialog
  //   silently — a close indistinguishable from a successful confirm, so the
  //   user believes the delete went through when nothing happened (MYND-497 /
  //   #397). preventDefault stops the focused button's activation; keeping the
  //   dialog open forces a deliberate click or Tab to a real answer. A stray
  //   Enter must never confirm here — that reasoning still stands, this only
  //   stops it from silently cancelling either.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (initialFocus === "confirm") onConfirm();
      // cancel-focused: swallow — no action, dialog stays open.
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [initialFocus, onConfirm]);

  const handleBackdropClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // Only cancel if the click target IS the backdrop (not a child).
      if (e.target === e.currentTarget) onCancel();
    },
    [onCancel],
  );

  const displayTitle =
    noteTitle === null || noteTitle === undefined || noteTitle.trim() === ""
      ? t("notes.deleteConfirm.untitled")
      : noteTitle;
  const bodyLine = body ?? `“${displayTitle}”`;

  return (
    <div style={BACKDROP_STYLE} onClick={handleBackdropClick} role="presentation">
      <div
        ref={dialogRef}
        style={MODAL_STYLE}
        role="alertdialog"
        aria-labelledby="delete-confirm-title"
        aria-describedby="delete-confirm-body"
      >
        <h2 id="delete-confirm-title" style={TITLE_STYLE}>
          {title ?? t("notes.deleteConfirm.title")}
        </h2>
        <p id="delete-confirm-body" style={BODY_TITLE_STYLE}>
          {bodyLine}
        </p>
        <p style={BODY_WARNING_STYLE}>
          {warning ?? t("notes.deleteConfirm.warning")}
        </p>
        <div style={BUTTON_ROW_STYLE}>
          <button
            ref={cancelRef}
            type="button"
            data-testid={cancelTestId ?? "delete-confirm.cancel"}
            onClick={onCancel}
            style={CANCEL_BUTTON_STYLE}
          >
            {t("notes.deleteConfirm.cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            data-testid={confirmTestId ?? "delete-confirm.confirm"}
            onClick={onConfirm}
            style={DELETE_BUTTON_STYLE}
          >
            {confirmLabel ?? t("notes.deleteConfirm.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
