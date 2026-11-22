// The desktop OS-tier notifier: the `ReminderNotifier` the scheduling core already
// knows about, implemented over the in-repo `reminders` plugin (myne-md/myne#1076,
// task 23 of the 0.19 block).
//
// ── What this adds to the in-app notifier ──────────────────────────────────
//
// `reminderNotifier.ts` implements the tier whose name says what it is: reminders
// appear only while Myne is open, delivered by the app's own surface. This one
// hands the same registrations to the operating system, so a reminder can arrive
// with Myne closed — which is a claim the platform has to be MEASURED making before
// the app states it (`reminderPlatform.ts`'s pre-registered tier, and task 24).
// That is why nothing here flips a capability flag: the adapter can register, and
// the product still does not promise delivery until the measurement says so.
//
// ── Refusals surface instead of vanishing ─────────────────────────────────
//
// The shared core counts a notifier that throws as a FAILED operation
// (`ReminderPassResult.failed`) and carries on, which is the contract that makes a
// revoked permission visible rather than silent. So every call here throws with the
// host's own `kind` attached, and nothing is swallowed: a caller that wants the
// count gets it from the pass, and a caller that wants the reason reads
// `lastRefusal()`.
//
// ── The payload is `{ id, at }` and there is nothing else to send ─────────
//
// The title and the body of the notification are constants owned by the Rust side.
// Nothing in this file can put task text into the platform's store, because there is
// no field to put it in.

// Through the seam, not around it: `src/platform/` is the only tree allowed to
// import `@tauri-apps/*` (`scripts/check-platform-seam.mjs`).
import { invoke } from "../platform/core";
import type {
  PendingReminder,
  ReminderNotifier,
  ReminderPayload,
} from "./reminderSchedule";

/** The `kind` values the host's closed error set can carry. */
export type ReminderRefusalKind = "unsupported" | "invalid_instant" | "refused" | "timed_out";

/** A refusal from the host, with its machine-readable kind kept. */
export class ReminderRefusal extends Error {
  readonly kind: ReminderRefusalKind;
  /** The host's own error value, kept for a caller that wants to log it. */
  readonly hostError: unknown;

  constructor(kind: ReminderRefusalKind, hostError?: unknown) {
    super(`reminder notifier refused: ${kind}`);
    this.name = "ReminderRefusal";
    this.kind = kind;
    this.hostError = hostError;
  }
}

/** The adapter, plus the one thing the settings surface needs to explain itself. */
export type OsNotifier = ReminderNotifier & {
  /**
   * The last refusal this adapter saw, or `null`.
   *
   * Kept because the pass counts failures and the user needs the CAUSE: "it did not
   * work" and "macOS has not been asked for permission" are the same count and two
   * different fixes.
   */
  lastRefusal: () => ReminderRefusal | null;
  /** What the platform currently allows: `authorized`, `denied`, `not_determined`, ... */
  permissionStatus: () => Promise<string>;
  /** Ask the platform once, and answer what it said. */
  requestPermission: () => Promise<string>;
};

/**
 * Build the OS notifier.
 *
 * A factory rather than module-level state so the scheduler can hold one per vault
 * session and a test can hold one per case: the refusal memory below is the only
 * mutable thing in this file, and a module-level one would carry a locked vault's
 * refusal into the next session.
 */
export function createOsNotifier(): OsNotifier {
  let last: ReminderRefusal | null = null;

  const fail = (error: unknown): never => {
    // The host sends `{ kind, ... }`; anything else (a missing capability, a bridge
    // that is not there) is reported as a refusal rather than rethrown raw, because
    // the pass must never see an unclassified throw.
    const kind = (error as { kind?: unknown } | null)?.kind;
    last =
      kind === "unsupported" || kind === "invalid_instant" || kind === "refused" || kind === "timed_out"
        ? new ReminderRefusal(kind, error)
        : new ReminderRefusal("refused", error);
    throw last;
  };

  return {
    async listPending(): Promise<readonly PendingReminder[]> {
      try {
        return await invoke<PendingReminder[]>("reminders_list_pending");
      } catch (error) {
        return fail(error);
      }
    },

    async schedule(payload: ReminderPayload): Promise<void> {
      try {
        // The two-field payload, sent as the host's own field name so the shape is
        // the same on both sides of the boundary.
        await invoke<void>("reminders_schedule", { reminder: { id: payload.id, at: payload.at } });
      } catch (error) {
        fail(error);
      }
    },

    async cancel(id: string): Promise<void> {
      try {
        await invoke<void>("reminders_cancel", { id });
      } catch (error) {
        fail(error);
      }
    },

    lastRefusal: () => last,

    async permissionStatus(): Promise<string> {
      try {
        return await invoke<string>("reminders_permission_status");
      } catch (error) {
        return fail(error);
      }
    },

    async requestPermission(): Promise<string> {
      try {
        return await invoke<string>("reminders_request_permission");
      } catch (error) {
        return fail(error);
      }
    },
  };
}
