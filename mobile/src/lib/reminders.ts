// The mobile reminder notifier — the WebView half of `tauri-plugin-reminders`
// (MYND-619, task 1).
//
// This module is the **adapter**, not the policy. Which reminders should be
// registered right now is decided by the pure scheduling core (MYND-618 task 3:
// `targetReminders` / `diffReminders` / `runReminderPass`); this file only hands
// that core's output to the operating system and reports back what the OS says
// it is holding. Keeping the decision above the seam is what lets one model
// cover all four platforms — and it is why this file has no clock, no horizon
// and no notion of a task.
//
// **The shape IS the desktop's `ReminderNotifier`** — imported, not restated
// (MYND-619 task 5 established that the decision core aliases cleanly into this
// repo, so the type comes from the same place the pass does). A member added or
// renamed upstream is now a compile error here rather than a method missing on a
// device. `tests/reminders.test.ts` keeps a runtime check beside it, because a
// type says nothing about what the object actually carries.
//
// **What crosses into the operating system** is `{ id, at }` and nothing else.
// Everything placed there is written into the platform's own persistence — and,
// on Android, into a pending intent — which is plaintext outside the AEAD
// envelope (`threat-model.md` §7). The notification body is fixed and
// content-free and is owned by the native side, so no task text can reach the OS
// store through this path at all.

import { invoke } from "../platform/core";
import type {
  PendingReminder,
  ReminderNotifier,
  ReminderPayload,
} from "@myne/reminder-schedule";
import { HAS_TAURI } from "./app-window";
import { opaqueNotifier } from "./reminderIdentity";

export type { PendingReminder, ReminderNotifier, ReminderPayload };

/**
 * The mobile notifier: the desktop surface plus the wholesale drop the
 * lifecycle table needs for `setting-off`, `vault-delete` and
 * `password-change`.
 */
export type MobileReminderNotifier = ReminderNotifier & {
  cancelAll: () => Promise<void>;
};

/**
 * A local wall-clock instant with no zone attached, `YYYY-MM-DDTHH:MM`.
 *
 * Anchored and exact: a trailing `Z`, a `+03:00` offset or stray seconds must
 * NOT slip through, because the native halves parse this into local calendar
 * components and would either misread the extra text or silently shift the
 * instant. A reminder that fires at the wrong hour is the failure this feature
 * exists to avoid.
 */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Raised for a payload that must never reach the platform boundary. */
export class InvalidReminder extends Error {}

/**
 * Reject a payload the OS should never be handed.
 *
 * Validated **here**, at the last point that can explain itself, rather than in
 * Swift and again in Kotlin: a malformed instant on the native side is a silent
 * no-fire, whereas a rejection here is counted by the reconciliation pass and
 * retried on the next one.
 */
function assertRegisterable(payload: ReminderPayload): void {
  if (payload.id.length === 0) {
    throw new InvalidReminder("reminder id is empty");
  }
  if (!INSTANT_RE.test(payload.at)) {
    throw new InvalidReminder(`reminder instant is not local YYYY-MM-DDTHH:MM: ${payload.at}`);
  }
}

/** True when a value has the `{ id, at }` shape the plugin promised to return. */
function isPendingReminder(value: unknown): value is PendingReminder {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.at === "string";
}

/**
 * The notifier backed by the in-repo native plugin.
 *
 * Without a Tauri host (browser dev, the flow-test tier) it is **inert rather
 * than broken**: `listPending` reports an empty set and the mutations resolve
 * without doing anything, so the reconciliation pass runs its full diff without
 * a host and without pretending a registration exists.
 */
export function createReminderNotifier(): MobileReminderNotifier {
  // Wrapped at the FACTORY, so there is no way to obtain an unwrapped notifier
  // for production use. The identifier that crosses into the platform — and
  // therefore into Android's `SharedPreferences`, outside the encrypted
  // envelope — is opaque by construction rather than by whoever wires the
  // engine remembering to wrap it. Leaving the wrap to the call site would make
  // `threat-model.md` §7's "no resolvable note identifier" a claim that depends
  // on a future edit; here it cannot be got wrong.
  return opaqueNotifier(createRawReminderNotifier());
}

/** The unwrapped platform notifier. Exported for tests that need to see the
 *  bytes actually handed to the plugin; production must use the factory above. */
export function createRawReminderNotifier(): MobileReminderNotifier {
  return {
    async listPending(): Promise<readonly PendingReminder[]> {
      if (!HAS_TAURI) return [];
      const rows = await invoke<unknown>("plugin:reminders|list_pending");
      // A malformed row is dropped rather than trusted: the diff compares this
      // against the target set, and one bad entry would otherwise produce a
      // cancel for an id the OS does not hold, every pass, forever.
      return Array.isArray(rows)
        ? rows.filter(isPendingReminder).map(({ id, at }) => ({ id, at }))
        : [];
    },

    async schedule(payload: ReminderPayload): Promise<void> {
      assertRegisterable(payload);
      if (!HAS_TAURI) return;
      await invoke("plugin:reminders|schedule", {
        reminder: { id: payload.id, at: payload.at },
      });
    },

    async cancel(id: string): Promise<void> {
      if (!HAS_TAURI) return;
      await invoke("plugin:reminders|cancel", { id });
    },

    async cancelAll(): Promise<void> {
      if (!HAS_TAURI) return;
      await invoke("plugin:reminders|cancel_all");
    },
  };
}

/**
 * What the platform reports about the notification permission. Mirrors the
 * desktop `ReminderPermission`; `tests/reminders.test.ts` pins the two together
 * by reading the desktop declaration.
 */
export type ReminderPermission = "granted" | "denied" | "not-determined" | "unavailable";

/** The injected platform surface, matching the desktop `ReminderPermissionApi`. */
export type ReminderPermissionApi = {
  status: () => Promise<ReminderPermission>;
  request: () => Promise<ReminderPermission>;
};

const PERMISSIONS: readonly ReminderPermission[] = [
  "granted",
  "denied",
  "not-determined",
  "unavailable",
];

/**
 * Normalize whatever the platform said.
 *
 * Anything unrecognised becomes `unavailable`, never `granted`: a false grant is
 * the only reading that actually misleads — the app would schedule, believe it
 * had asked, and never fire. `unavailable` is stated quietly and the user can
 * still enable notifications in system settings.
 */
function toPermission(value: unknown): ReminderPermission {
  return PERMISSIONS.includes(value as ReminderPermission)
    ? (value as ReminderPermission)
    : "unavailable";
}

/**
 * The permission surface backed by the native plugin.
 *
 * **It does not decide when to ask** — `requestReminderPermission` above the
 * seam owns that (the first reminder, after an in-app explanation, marked before
 * the ask, never automatically repeated, because the OS grants one prompt).
 * This is only the platform call.
 *
 * On iOS an unauthorized `add` succeeds and then delivers nothing, which is why
 * this exists at all rather than being a nicety: without it "the reminder fires
 * while the app is closed" would fail silently.
 */
export function createReminderPermissionApi(): ReminderPermissionApi {
  return {
    async status(): Promise<ReminderPermission> {
      if (!HAS_TAURI) return "unavailable";
      return toPermission(await invoke<unknown>("plugin:reminders|permission_status"));
    },

    async request(): Promise<ReminderPermission> {
      if (!HAS_TAURI) return "unavailable";
      return toPermission(await invoke<unknown>("plugin:reminders|request_permission"));
    },
  };
}

/**
 * How precisely this device will deliver a reminder.
 *
 * Three states, not two, because "the permission is missing" and "this platform
 * has no such permission" are different facts and the settings surface says
 * different things about them — the second one says nothing at all.
 */
export type ReminderExactness = "exact" | "approximate" | "not-applicable";

const EXACTNESS: readonly ReminderExactness[] = ["exact", "approximate", "not-applicable"];

/**
 * The Android precise-alarm surface.
 *
 * `request` opens the platform's **settings screen**, not a dialog, which is why
 * there is no "asked already" bookkeeping here: nothing is consumed by opening
 * it and there is no one-shot prompt to spend. It is only ever reached from an
 * affordance the user tapped — the app never opens it on its own.
 */
export type ExactAlarmApi = {
  status: () => Promise<ReminderExactness>;
  request: () => Promise<void>;
};

export function createExactAlarmApi(): ExactAlarmApi {
  return {
    async status(): Promise<ReminderExactness> {
      // Without a host there is no platform to be imprecise about, and claiming
      // "approximate" would put a caveat on a screen that has no reason for one.
      if (!HAS_TAURI) return "not-applicable";
      const answer = await invoke<unknown>("plugin:reminders|exact_alarm_status");
      return EXACTNESS.includes(answer as ReminderExactness)
        ? (answer as ReminderExactness)
        : // An unreadable answer is treated as approximate, not as exact: the
          // caveat being shown when it need not be is a smaller failure than a
          // reminder quietly arriving late after the app promised it would not.
          "approximate";
    },

    async request(): Promise<void> {
      if (!HAS_TAURI) return;
      await invoke("plugin:reminders|request_exact_alarm");
    },
  };
}

/**
 * Whether this build hands any reminder to the operating system.
 *
 * **`false`, and that is a statement about the client rather than about the
 * platform.** The plugin below works and the OS would hold the registration;
 * what is missing is the caller. `mobile/src/lib/reminderPass.ts` holds
 * `runBoundedReminderPass`, the pass that would reconcile the vault's tasks
 * against what the OS is holding, and nothing in `mobile/src` calls it. The
 * repo already records that: `scripts/check-unwired.mjs` carries the module as
 * a known-UNWIRED exemption.
 *
 * It exists because a settings sentence may not describe a mechanism that is
 * not running. "Reminders are registered through <date>" was rendered
 * unconditionally, and it was false on every mobile build (myne#508). The
 * desktop twin has said the same thing about itself since MYND-618, through
 * `reminderPlatform.ts::showsInAppOnlyLimitation`, which this mirrors.
 *
 * Flips to a real check on the change that gives the pass a caller, and the
 * sentence returns with it.
 */
export function remindersReachTheOs(): boolean {
  return false;
}
