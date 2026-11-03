// Headless bridge from the per-surface toast API to the central store (#238).
//
// Every surface that used to render its own positioned toast still writes
// `<Toast message={…} onDone={…} variant=… action=… />` exactly as before — but
// this no longer draws anything. It pushes the message into the toast store, so
// the single <Toaster> (mounted once in App, above the stage switch, since
// myne-md/myne#390) renders it in the shared collapsed stack. That is what makes
// every toast — React-surface or the editor's imperative one — look and stack
// alike, without touching a single call site.
//
// The store owns auto-dismiss, the slide in/out, pause-on-hover and the ×; this
// component only mirrors the owner's `message` state into and out of the store.

import { useEffect, useRef } from "react";
import { dismissToast, toast } from "./toast/toastStore";

// Re-exported so existing importers (`import { ToastAction, ToastVariant }`)
// keep resolving from here.
export type { ToastActionSpec as ToastAction, ToastVariant } from "./toast/toastStore";

interface ToastProps {
  /** The message to display. When null, nothing is shown. */
  message: string | null;
  /** Called after the toast leaves (auto-dismiss or ×). Clear owner state here. */
  onDone: () => void;
  /** Auto-dismiss timeout (ms). Default 2500; 6000 when an action is present. */
  durationMs?: number;
  /** Optional inline action button (e.g. an undo affordance). */
  action?: { label: string; onAction: () => void; testId?: string };
  /** Semantic flavour driving the icon + rail colour. Default: `neutral`. */
  variant?: "neutral" | "success" | "error" | "info";
  /** Optional `data-testid` for the rendered row, so a surface with its own
   *  identity in E2E (the auto-tag undo) keeps it. Defaults to `editor.toast`. */
  testId?: string;
}

export function Toast({ message, onDone, durationMs, action, variant, testId }: ToastProps) {
  const idRef = useRef<number | null>(null);
  // Read the non-message props at push time without re-pushing when their
  // identity changes on an unrelated parent re-render.
  const latest = useRef({ onDone, durationMs, action, variant, testId });
  latest.current = { onDone, durationMs, action, variant, testId };

  useEffect(() => {
    if (message === null) return;
    const { onDone: od, durationMs: d, action: a, variant: v, testId: id } = latest.current;
    idRef.current = toast({
      message,
      variant: v,
      action: a,
      durationMs: d,
      onDismiss: od,
      testId: id,
    });
    // Cleanup fires when the message changes or the owner unmounts — a
    // bridge-initiated removal, so it is SILENT (the owner already moved on;
    // firing onDone here would clobber a replacement message).
    return () => {
      if (idRef.current !== null) {
        dismissToast(idRef.current, { silent: true });
        idRef.current = null;
      }
    };
  }, [message]);

  return null;
}
