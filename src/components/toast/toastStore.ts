// The single source of truth for every toast in the app (#238). Both toast
// systems feed it: the React surfaces via the headless `<Toast>` bridge
// (src/components/Toast.tsx), and the editor's imperative `showAttachmentToast`
// via the sink registered in `src/editor-host.ts`. One store → one `<Toaster>`
// renders them as a single collapsed stack, so a toast looks and stacks the
// same however it was raised.
//
// Framework-agnostic: a tiny observable list. `useToasts()` (Toaster.tsx)
// subscribes via `useSyncExternalStore`.

export type ToastVariant = "neutral" | "success" | "error" | "info";

export interface ToastActionSpec {
  label: string;
  onAction: () => void;
  /** Optional `data-testid` override for the action button. Defaults to the
   *  shared `editor.toast-action`; a surface whose action has its own identity in
   *  E2E (the auto-tag undo, `editor.auto-tag-undo`) sets its own, so a scenario
   *  presses the button it means rather than whichever toast is on screen. */
  testId?: string;
}

export interface ToastInput {
  message: string;
  variant?: ToastVariant;
  action?: ToastActionSpec;
  /** Auto-dismiss timeout (ms). Default 2500; 6000 when an action is present. */
  durationMs?: number;
  /** Notified when the toast leaves for ANY reason (auto-dismiss, ×, replace,
   *  or the owner clearing it). The `<Toast>` bridge wires this to its `onDone`
   *  so the owning component's state is cleared. Must be idempotent. */
  onDismiss?: () => void;
  /** Optional `data-testid` override for the rendered toast row (`<screen>.<element>`
   *  form). Defaults to the shared `editor.toast`; a specific surface (e.g. the
   *  remote-merge hint, #422) sets its own so E2E can target it distinctly. */
  testId?: string;
}

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  action?: ToastActionSpec;
  durationMs: number;
  onDismiss?: () => void;
  testId?: string;
}

const DEFAULT_DURATION_MS = 2500;
const ACTION_DURATION_MS = 6000;

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current snapshot (stable reference between changes — required by
 *  `useSyncExternalStore` to avoid infinite re-renders). */
export function getToasts(): readonly ToastItem[] {
  return items;
}

/** Raise a toast. Returns its id (pass to {@link dismissToast}). */
export function toast(input: ToastInput): number {
  const id = ++seq;
  const durationMs =
    input.durationMs ?? (input.action !== undefined ? ACTION_DURATION_MS : DEFAULT_DURATION_MS);
  items = [
    ...items,
    {
      id,
      message: input.message,
      variant: input.variant ?? "neutral",
      action: input.action,
      durationMs,
      onDismiss: input.onDismiss,
      testId: input.testId,
    },
  ];
  emit();
  return id;
}

/** Remove a toast. No-op if already gone (so the auto-dismiss path and the
 *  owner-clears path can't double-notify).
 *
 *  Fires `onDismiss` UNLESS `silent` — the `<Toast>` bridge removes silently
 *  when its owner already moved on (message replaced or unmounted), so it must
 *  not call `onDone` back and clobber a freshly-set message. The Toaster's ×
 *  and the auto-dismiss timer remove non-silently, so the owner's state clears. */
export function dismissToast(id: number, opts?: { silent?: boolean }): void {
  const item = items.find((i) => i.id === id);
  if (item === undefined) return;
  items = items.filter((i) => i.id !== id);
  emit();
  if (opts?.silent !== true) item.onDismiss?.();
}

/** Test helper — drop everything without notifying owners. */
export function resetToasts(): void {
  items = [];
  emit();
}
