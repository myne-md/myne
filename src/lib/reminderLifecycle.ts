// Reminder registration lifecycle (MYND-618, task 8).
//
// One policy, expressed as data, driving reconciliation from every lifecycle
// path. Keeping it as a table rather than as scattered call sites is what makes
// the one surprising entry auditable instead of buried.
//
// **LOCKING DOES NOT CANCEL, and that is a written departure** from the rule
// that every plaintext surface is torn down on every lock path.
//
// The reasoning, stated so a future reader does not read it as an oversight:
// that rule protects **vault content**, and the precedent it comes from tears
// down a surface holding the actual text of a note. What the platform holds here
// is a timestamp and a content-free string — the threat-model entry says exactly
// that (`threat-model.md` §7). It is also barely a choice: the default auto-lock
// is five minutes with no off switch, so cancelling on lock would kill reminders
// roughly five minutes after the user stops typing, which is the same as not
// shipping the feature.
//
// **Completion cancels its own registration as part of the completion write**,
// not as a later reconciliation. A task the user just ticked must not notify
// them thirty seconds afterwards because the next pass had not run yet.

/** Every lifecycle moment that touches the registration set. */
export type ReminderLifecycleEvent =
  /** Vault unlocked — the catch-up pass. */
  | "unlock"
  /** The periodic tick while unlocked. */
  | "tick"
  /** A note was saved, so the task list may have changed. */
  | "note-save"
  /** Graceful app exit. */
  | "exit"
  /** Vault locked, manually or by auto-lock. */
  | "lock"
  /** The per-device setting was turned off. */
  | "setting-off"
  /** The vault was deleted. */
  | "vault-delete"
  /** The vault password changed. */
  | "password-change"
  /** A task was completed. */
  | "task-complete";

/** What an event does to the registration set. */
export type ReminderLifecycleAction =
  /** Recompute the target set and reconcile. */
  | "reconcile"
  /** Cancel everything this vault registered. */
  | "cancel-all"
  /** Cancel exactly the completed task's registration. */
  | "cancel-one"
  /** Deliberately nothing. */
  | "none";

/**
 * The policy table. Exhaustive over the event union, so adding an event without
 * deciding its action fails to compile.
 */
export function lifecycleAction(event: ReminderLifecycleEvent): ReminderLifecycleAction {
  switch (event) {
    case "unlock":
    case "tick":
    case "note-save":
    case "exit":
      return "reconcile";

    // THE DEPARTURE. See the module comment: the teardown rule protects vault
    // content, and this holds a timestamp plus a content-free string. With a
    // five-minute default auto-lock and no off switch, cancelling here would
    // end reminders five minutes after the user stops typing.
    case "lock":
      return "none";

    case "setting-off":
    case "vault-delete":
    case "password-change":
      return "cancel-all";

    // Cancelled as part of the completion WRITE, not by a later pass — a task
    // the user just ticked must not notify them while the next tick is pending.
    case "task-complete":
      return "cancel-one";

    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** Whether an event should trigger a full reconciliation pass. */
export function reconcilesOn(event: ReminderLifecycleEvent): boolean {
  return lifecycleAction(event) === "reconcile";
}

/** Whether an event clears every registration this vault made. */
export function cancelsAllOn(event: ReminderLifecycleEvent): boolean {
  return lifecycleAction(event) === "cancel-all";
}

/** Every event, for exhaustiveness checks in tests and in the settings audit. */
export const REMINDER_LIFECYCLE_EVENTS: readonly ReminderLifecycleEvent[] = [
  "unlock",
  "tick",
  "note-save",
  "exit",
  "lock",
  "setting-off",
  "vault-delete",
  "password-change",
  "task-complete",
];
