// The in-app reminder notifier (MYND-618) — the delivery half the scheduling
// core was written against and shipped without.
//
// ── Why there is no OS notification here ───────────────────────────────────
//
// `reminderPlatform.ts` defines two tiers, and this implements the one whose
// name says what it is: **in-app-only — "reminders appear only while Myne is
// open."** A surface inside a running app is exactly what that sentence
// promises, so it is delivered by the app's own toast rather than by the
// operating system.
//
// That is not a shortcut around the OS tier; it is the honest scope of this
// tier. The `pre-registered` tier — the OS holding a registration and firing it
// while Myne is closed — stays behind the delivery measurement that
// `features/task-notifications-desktop/tasks.md` gates with `[NEEDS DECISION]`
// (it needs a Developer-ID-signed bundle to establish, and has never been run).
// Until that lands, no platform claims it.
//
// The consequence for dependencies is the reason to state this plainly:
// `dependency-policy.md`'s first question is "is there a way to do this without
// the dep?", and for this tier there is — no notification crate, no npm package,
// no capability entry, no `@tauri-apps/*` import and therefore no platform-seam
// member. The OS tier will need all of that; this one needs none of it.
//
// ── Content-free by construction ──────────────────────────────────────────
//
// `ReminderPayload` carries `{id, at}` and nothing else, so there is no task
// text here to leak even by accident. The delivered message says a reminder is
// due and offers a way to go look; it never quotes the task.

import {
  parseLocalInstant,
  type PendingReminder,
  type ReminderClock,
  type ReminderNotifier,
  type ReminderPayload,
} from "./reminderSchedule";

/**
 * How late a timer may fire and still deliver.
 *
 * A machine that slept through the instant wakes with an overdue timer, and
 * `targetReminders` is explicit that "firing late is worse than not firing,
 * because it reads as the reminder being wrong". The scheduler re-runs at least
 * once a minute and cancels anything now in the past, so a timer more than a
 * minute late means the process was not running — that one is dropped rather
 * than fired at a moment the user will read as wrong.
 */
export const DELIVERY_GRACE_MS = 60_000;

export type InAppNotifierDeps = {
  /**
   * Surface a due reminder to the user. Called with the registration only, so a
   * caller cannot accidentally widen this into a content-carrying channel.
   */
  deliver: (payload: ReminderPayload) => void;
  /** Injected so tests need no fake timers to assert the schedule arithmetic. */
  clock?: ReminderClock;
};

/** An in-app notifier plus the teardown the OS tier would not need. */
export type InAppNotifier = ReminderNotifier & {
  /**
   * Drop every pending timer without delivering.
   *
   * The lock path calls this: an in-app reminder has nowhere to appear once the
   * vault is locked and the workspace is unmounted, and a timer that survives a
   * lock would fire into a locked app.
   */
  dispose: () => void;
};

/**
 * A notifier that keeps its pending set in memory and fires it with timers.
 *
 * **Memory only, deliberately.** There is nothing to persist: the set is
 * rebuilt from the vault on unlock by the scheduler's first pass, and a file
 * mapping reminder ids to instants would be exactly the plaintext-at-rest
 * artefact `threat-model.md` §7 describes for the platforms that force one.
 * This tier is not forced, so it does not create one.
 */
export function createInAppNotifier(deps: InAppNotifierDeps): InAppNotifier {
  const { deliver, clock = () => new Date() } = deps;
  const pending = new Map<string, { at: string; timer: ReturnType<typeof setTimeout> }>();

  const drop = (id: string): void => {
    const held = pending.get(id);
    if (held === undefined) return;
    clearTimeout(held.timer);
    pending.delete(id);
  };

  const fire = (payload: ReminderPayload): void => {
    pending.delete(payload.id);
    const lateBy = clock().getTime() - parseLocalInstant(payload.at).getTime();
    if (lateBy > DELIVERY_GRACE_MS) return;
    deliver(payload);
  };

  return {
    listPending: async (): Promise<readonly PendingReminder[]> => {
      // Sorted by id so two calls over the same set are byte-identical, matching
      // `targetReminders` — a diff that depended on Map insertion order would
      // report churn that is not there.
      return [...pending.entries()]
        .map(([id, held]) => ({ id, at: held.at }))
        .sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
    },

    schedule: async (payload: ReminderPayload): Promise<void> => {
      // Replace-by-id, which is the semantics `runReminderPass` counts on when
      // it says "re-registering something already registered is harmless".
      drop(payload.id);
      const delay = parseLocalInstant(payload.at).getTime() - clock().getTime();
      if (delay <= 0) {
        // Already due. Deliver through `fire` so the staleness guard applies
        // here too — a pass that registers a just-passed instant should still
        // not fire one that passed an hour ago.
        fire(payload);
        return;
      }
      pending.set(payload.id, { at: payload.at, timer: setTimeout(() => fire(payload), delay) });
    },

    cancel: async (id: string): Promise<void> => {
      drop(id);
    },

    dispose: (): void => {
      for (const held of pending.values()) clearTimeout(held.timer);
      pending.clear();
    },
  };
}
