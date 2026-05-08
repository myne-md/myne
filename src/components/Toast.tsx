// Single-message auto-dismissing toast pinned bottom-right. Parent owns
// the message state; setting a new message replaces the previous.
// `role="status"` + `aria-live="polite"` so screen readers announce
// without interrupting.

import { useEffect, type CSSProperties } from "react";

interface ToastProps {
  /** The message to display. When null, nothing renders. */
  message: string | null;
  /** Called after the auto-dismiss timeout elapses. */
  onDone: () => void;
  /** Auto-dismiss timeout in milliseconds. Default: 2500. */
  durationMs?: number;
}

const TOAST_STYLE: CSSProperties = {
  position: "fixed",
  bottom: "var(--space-5)",
  right: "var(--space-5)",
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

export function Toast({ message, onDone, durationMs = 2500 }: ToastProps) {
  useEffect(() => {
    if (message === null) return;
    const id = window.setTimeout(onDone, durationMs);
    return () => window.clearTimeout(id);
  }, [message, onDone, durationMs]);

  if (message === null) return null;

  return (
    <div role="status" aria-live="polite" style={TOAST_STYLE}>
      {message}
    </div>
  );
}
