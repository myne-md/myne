// Single-message auto-dismissing toast pinned bottom-right. Parent owns
// the message state; setting a new message replaces the previous.
// `role="status"` + `aria-live="polite"` so screen readers announce
// without interrupting.
//
// Optional `action` renders an inline button (e.g. "Undo") — used by the
// soft-trash flow's undo toast (MYND-133). Invoking the action does NOT
// auto-dismiss; the parent clears the message in the action handler.

import { useEffect, type CSSProperties } from "react";

export interface ToastAction {
  /** Button label (e.g. "Undo"). */
  label: string;
  /** Invoked on click. The parent is responsible for dismissing the toast. */
  onAction: () => void;
}

interface ToastProps {
  /** The message to display. When null, nothing renders. */
  message: string | null;
  /** Called after the auto-dismiss timeout elapses. */
  onDone: () => void;
  /** Auto-dismiss timeout in milliseconds. Default: 2500. */
  durationMs?: number;
  /** Optional inline action button (e.g. an undo affordance). */
  action?: ToastAction;
}

const TOAST_STYLE: CSSProperties = {
  position: "fixed",
  bottom: "var(--space-5)",
  right: "var(--space-5)",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-4)",
  boxShadow: "var(--shadow-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  zIndex: 1100,
};

const ACTION_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  margin: 0,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  color: "var(--accent, var(--fg-1))",
  cursor: "pointer",
  textDecoration: "underline",
};

export function Toast({ message, onDone, durationMs = 2500, action }: ToastProps) {
  useEffect(() => {
    if (message === null) return;
    const id = window.setTimeout(onDone, durationMs);
    return () => window.clearTimeout(id);
  }, [message, onDone, durationMs]);

  if (message === null) return null;

  return (
    <div role="status" aria-live="polite" data-testid="editor.toast" style={TOAST_STYLE}>
      <span>{message}</span>
      {action !== undefined && (
        <button
          type="button"
          style={ACTION_STYLE}
          onClick={action.onAction}
          data-testid="editor.toast-action"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
