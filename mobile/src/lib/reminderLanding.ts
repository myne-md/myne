// Where a tapped reminder lands (MYND-620, task 7).
//
// This is the receiving half of the split the two features were designed
// around: MYND-619 owns the notification — registering it, latching the
// identifier a tap delivers, consuming it exactly once — and this owns the
// surface it arrives at. Nothing here touches the notification side.
//
// ── Resolution is by comparison, never by parsing ──────────────────────────
//
// The latch holds the **opaque** identifier the platform was given.
// `locatorFor` maps it back to the reminder's locator, and the task it belongs
// to is found by asking the shared `reminderId` what each task's locator would
// be. Parsing the locator string instead would be a second implementation of a
// format the generator owns, and the two would drift the first time a task
// gained a new kind of location.
//
// ── The cold-start limit, stated rather than papered over ──────────────────
//
// The opaque→locator map is memory-only **by design** (a persisted map would put
// the note identifier back into plaintext, which is what the opacity exists to
// prevent). So a session that did not itself register the reminder — the common
// case, since a tap on a locked phone cold-launches the app — cannot name it.
//
// That is why an unresolved tap is a **distinct outcome** rather than an error:
// the notification still led somewhere, just to the list rather than to the one
// task. Whether that is the final answer is an open decision recorded in
// `task-notifications-mobile/progress.md`; this module is written so that
// answering it later means changing one call site.

import { reminderId } from "@myne/reminder-schedule";
import { locatorFor } from "./reminderIdentity";
import { consumeReminderTap } from "./reminderTap";
import type { VaultTask } from "./tasks";

/** What a consumed tap turned out to mean. */
export type ReminderLanding =
  /** Nothing was latched. The app was opened some other way. */
  | { kind: "none" }
  /** The identifier named a task that is still there. */
  | { kind: "task"; task: VaultTask }
  /**
   * Something was tapped, but this session cannot say what — either the map
   * never had it (a cold start) or the task has since been deleted or moved.
   * The list is the honest destination: it is where the task would have been.
   */
  | { kind: "unresolved" };

/**
 * Resolve one latched identifier against the current task list.
 *
 * Pure: the latch is passed in rather than read, so the decision can be tested
 * without the module-level state, and the caller decides when consuming happens.
 */
export function resolveReminderTap(
  latched: string | null,
  tasks: readonly VaultTask[],
): ReminderLanding {
  if (latched === null) return { kind: "none" };

  const locator = locatorFor(latched);
  if (locator === null) return { kind: "unresolved" };

  const task = tasks.find((candidate) => reminderId(candidate) === locator);
  // A task that has been completed-and-removed, deleted, or moved to another
  // line is gone as far as this identifier is concerned. Landing on the list
  // beats an error about an identifier the user never saw.
  return task === undefined ? { kind: "unresolved" } : { kind: "task", task };
}

/**
 * Consume the latch and resolve it. Call once, after unlock.
 *
 * Consuming is unconditional — even when the identifier turns out to be
 * unresolvable — because a latch that survived a failed resolution would fire
 * again on the next unlock, sending the user somewhere they did not ask to go a
 * second time.
 */
export function takeReminderLanding(tasks: readonly VaultTask[]): ReminderLanding {
  return resolveReminderTap(consumeReminderTap(), tasks);
}
