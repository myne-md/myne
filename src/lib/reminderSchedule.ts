// The reminder scheduling decision core (MYND-618, task 3).
//
// A **pure** function from (task list, clock, horizon) to the set of reminders
// that should currently be registered, plus the diff against what is registered.
// The OS notifier is injected, following the existing scheduler-dependencies
// shape, so this is fully testable without any platform at all.
//
// That matters more here than usual: **delivery itself cannot be driven by the
// test harness.** Whether the operating system actually fires a registration
// while Myne is closed is a manual measurement, so every property that CAN be
// tested has to be tested here, or it is not tested anywhere.
//
// IDEMPOTENT BY CONSTRUCTION. The pass computes the target set and reconciles;
// running it twice produces no second-time change, because the second run's
// diff against the now-current state is empty. A rebuilt or missing index
// therefore cannot orphan platform state: the next pass cancels whatever is
// registered and no longer wanted, whatever put it there.
//
// THE HORIZON IS SHORT ON PURPOSE. Pending reminder times leave the AEAD
// envelope and sit in OS-owned plaintext (`threat-model.md` §7), so the fewer
// that are registered at a time, the less is exposed. It is a privacy bound
// first and a resource bound second.

import type { VaultTask } from "../notes/taskIndex";

// Re-exported so a consumer of this module needs only this module. Mobile
// reaches it through the `@myne/reminder-schedule` alias (MYND-619 task 5) and
// would otherwise have to name a relative path out of its own repository to
// spell the input type of the functions below.
export type { VaultTask };

/** How far ahead reminders are registered with the OS. */
export const REMINDER_HORIZON_DAYS = 7;

/**
 * The horizons a user may choose between, shortest first (myne#508).
 *
 * Lives here rather than in either settings panel for the reason myne#52
 * recorded against this exact feature: the two clients derived the horizon's
 * end date apart and drifted, so the same vault told two devices two different
 * dates. An option SET is the same hazard one step earlier. A picker offering
 * 1/7/14/30 on one client and 1/7/30 on the other is a preference whose meaning
 * depends on which device last wrote it, and because the horizon is
 * device-local (`prefs_classification.rs`, `PrefClass::DeviceLocal`) nothing
 * ever reconciles the disagreement.
 *
 * **Days, not labels.** An earlier draft paired each day with an i18n key,
 * which put presentation in a module whose header calls it a pure decision core
 * and cost five catalog keys in each of 32 locales to say "7d". Both clients
 * render these through `Intl.NumberFormat`'s `unit` style instead, which is one
 * line each and cannot drift between them, because the shared implementation is
 * the platform's rather than ours.
 *
 * **Four, not five.** `docs/design/README.md` ("Which picker") puts `Segmented`
 * at 2-4 options and `Select` at 5-12, so a fifth entry would have forced the
 * desktop into a dropdown while mobile kept a segmented control: two shapes for
 * one setting, decided by an option nobody asked for.
 *
 * **The default is the CEILING, and every other choice is shorter.** The issue
 * asked for a way to TIGHTEN this bound, and `threat-model.md` §7 accepts the
 * reminder leak on four axes of which the first is "the horizon is short (only
 * reminders within it are ever registered)". A draft of this offered 14 and 30,
 * which would have quadrupled the window whose shortness is the mitigation, in
 * a change whose whole purpose was the opposite direction, and would have made
 * that sentence describe a bound the code no longer enforced. Offering only
 * shorter horizons keeps §7 true as written. Whether Myne should ever offer a
 * LONGER one is a threat-model amendment and a decision the owner makes, not
 * something a bug fix decides on the way past.
 *
 * {@link REMINDER_HORIZON_DAYS} is a member, and `reminderSchedule.test.ts`
 * holds it to that: a default absent from the picker leaves a never-set vault
 * rendering no selected segment at all.
 */
export const REMINDER_HORIZON_CHOICES = [1, 3, 5, 7] as const;

/**
 * The horizon actually in force: the stored value clamped, or the default.
 *
 * **The clamp is the bound, and before myne#508 nothing needed one.**
 * `runReminderPass`'s `horizonDays: number = REMINDER_HORIZON_DAYS` default
 * pinned the horizon at seven whatever `vault.prefs` held, because no caller
 * ever passed one. That default was the only thing enforcing §7's "short
 * horizon" axis, and threading the preference through removes it. The offered
 * SET bounds the picker; it does not bound the preference, which
 * `core/src/plugins/prefs/commands.rs` stores verbatim and deliberately does
 * not clamp (clamping there would disagree with whatever the settings UI had
 * shown).
 *
 * So the bound lives here, and `horizonEndDate` applies it rather than trusting
 * its caller to have done so. That matters because every horizon-taking
 * function below still carries `horizonDays: number = REMINDER_HORIZON_DAYS`,
 * which is an opt-in bound: a caller passing a raw stored value opts out by
 * omission, and mobile's pass is documented as the next thing to pass one.
 * Clamping at the derivation both the date line and the cutoff go through is
 * what makes it a bound rather than a convention. Two values it has to survive, neither of them hypothetical: a
 * stored `0`, which `??` passes through unchanged and which would render
 * "registered through yesterday" while registering nothing at all, and a value
 * from a future build or a hand-edited blob that is larger than anything this
 * one offers.
 *
 * `null` is not one of them. It is a legitimate persisted state meaning "never
 * chosen", and it resolves to the default.
 *
 * **It clamps into the RANGE, not onto the offered SET.** A stored `4` stays
 * `4`: the scheduler has to honour the horizon actually in force, and snapping
 * it onto a neighbouring choice would make the pass register a window the user
 * never asked for. What that costs is a picker with no segment selected, which
 * is what both clients show for a value they do not offer, and it is the honest
 * readout rather than a rounded one. Only a hand-edited blob or a build with a
 * different choice set can produce one, since the two pickers are the only
 * writers.
 */
export function resolveHorizonDays(stored: number | null): number {
  // `Number.isFinite` first, because the clamp cannot catch `NaN`:
  // `Math.max(NaN, 1)` and `Math.min(NaN, 7)` are both `NaN`, and a `NaN`
  // horizon builds the cutoff string `"NaN-NaN-NaNT23:59"`, which every real
  // instant sorts BELOW. The bound would then disappear in the widest possible
  // direction, on a function whose whole job is to survive a hand-edited blob.
  if (stored === null || !Number.isFinite(stored)) return REMINDER_HORIZON_DAYS;
  return Math.min(Math.max(Math.trunc(stored), 1), REMINDER_HORIZON_DAYS);
}

/** One reminder as the OS holds it. Content-free by design — see below. */
export type PendingReminder = {
  /**
   * Stable identity, derived from the task's location rather than its text, so
   * editing a task's wording does not orphan its registration.
   */
  readonly id: string;
  /** Local wall-clock instant, `YYYY-MM-DDTHH:MM`. */
  readonly at: string;
};

/**
 * What the OS is asked to show.
 *
 * **Content-free by default**: the body carries no task text and no note
 * identifier. The registration lives in OS-owned plaintext storage and can
 * surface on a locked screen, so putting the task's words in it would hand
 * content to a shoulder-surfer for a convenience nobody asked for.
 */
export type ReminderPayload = {
  readonly id: string;
  readonly at: string;
};

/** The injected OS surface. Every method may fail; none may throw upward. */
export type ReminderNotifier = {
  /** Currently registered reminders, as the OS reports them. */
  listPending: () => Promise<readonly PendingReminder[]>;
  schedule: (payload: ReminderPayload) => Promise<void>;
  cancel: (id: string) => Promise<void>;
};

/** Injected clock. This module never reads the wall clock itself. */
export type ReminderClock = () => Date;

/** Identity of a task's reminder: its note plus its line, never its text. */
export function reminderId(task: VaultTask): string {
  return `myne.reminder.${task.noteId}.${task.lineIndex ?? "note"}`;
}

/** `YYYY-MM-DDTHH:MM` from a stored instant, defaulting a missing time to 09:00. */
function instantOf(raw: string): string {
  const [date, time] = raw.split(/[ T]/);
  // A date with no time means "that day"; 09:00 local is the only defensible
  // default — midnight would fire while the user is asleep, and a
  // notification nobody sees is the same as no notification.
  return `${date}T${(time ?? "09:00").slice(0, 5)}`;
}

/** `Date` → the same `YYYY-MM-DDTHH:MM` local shape, for comparison. */
function localStamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}`;
}

/**
 * `YYYY-MM-DDTHH:MM` → a `Date` in the **local** zone.
 *
 * Local is the only reading that agrees with how the reminder was written: a
 * stored instant is a wall-clock time carrying no offset (`markdown-dialect.md`
 * §3.8 — an offset-bearing value does not type at all), so 09:00 means 09:00
 * where the user is. Built from explicit fields rather than `new Date(string)`,
 * whose treatment of a bare `T`-form has changed across engines and versions.
 *
 * Exported because both consumers that need it — the scheduler's sleep
 * computation and the in-app notifier's timer — would otherwise each carry
 * their own copy, and two parsers that disagree by an hour is a bug nobody
 * would look for.
 */
export function parseLocalInstant(at: string): Date {
  const [date, time] = at.split("T");
  const [y, m, d] = (date ?? "").split("-").map(Number);
  const [hh, mm] = (time ?? "").split(":").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
}

/**
 * The reminders that SHOULD be registered right now.
 *
 * Excluded, each for its own reason:
 *   - **completed tasks** — the work is done; a reminder would be noise;
 *   - **tasks with no `remind`** — a due date is not a request to be nudged,
 *     and treating it as one would notify a user who never asked. Tested
 *     `== null`, not `=== undefined`: the `MYI1` row serializes `Option<String>`
 *     as `null`, and this module is reached by clients that hand their fetch's
 *     rows straight in, so a strict-undefined check lets a `null` through to
 *     `instantOf`'s `raw.split(…)` — a throw inside a background pass, which
 *     surfaces as an unhandled rejection rather than as anything a user sees;
 *   - **instants in the past** — the moment has gone; firing late is worse
 *     than not firing, because it reads as the reminder being wrong;
 *   - **instants beyond the horizon** — see the privacy bound above.
 */
/**
 * The LAST local calendar day the horizon covers, as `YYYY-MM-DD` (#52).
 *
 * Lives next to {@link REMINDER_HORIZON_DAYS} and next to the cutoff it
 * describes, because the two drifted the moment they lived apart: this client
 * rendered `today + (N - 1)` and the mobile one rendered `today + N`, so the
 * same vault told two devices two different dates and one of them was a day
 * later than any reminder the scheduler would actually register.
 *
 * `N - 1` because the horizon is INCLUSIVE of today: a 7-day horizon covers
 * today plus the next six days. `targetReminders` cuts off at the END of this
 * day, so the sentence this produces and the set the pass registers are the
 * same claim. They were not until myne#508: the cutoff was a rolling
 * `now + N × 86_400_000`, which admits instants up to N×24h out, so at N=1 the
 * line said "today" while the pass registered into tomorrow. Nothing caught it
 * because the parity tests pinned the two clients' DISPLAY derivations against
 * each other and never the display against the registration set.
 *
 * Local calendar arithmetic on purpose — a UTC-based shift would name the wrong
 * day for anyone far enough east or west, on a line whose entire job is being
 * checkable against a calendar.
 */
export function horizonEndDate(
  today: Date,
  horizonDays: number = REMINDER_HORIZON_DAYS,
): string {
  const end = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + resolveHorizonDays(horizonDays) - 1,
  );
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${end.getFullYear()}-${p(end.getMonth() + 1)}-${p(end.getDate())}`;
}

export function targetReminders(
  tasks: readonly VaultTask[],
  now: Date,
  horizonDays: number = REMINDER_HORIZON_DAYS,
): PendingReminder[] {
  const from = localStamp(now);
  // The END of the last day the horizon covers, which is the day
  // `horizonEndDate` names, and which clamps through `resolveHorizonDays` on
  // the way. A rolling `now + N × 86_400_000` cutoff is what this used to be,
  // and it admitted instants a day past the date the settings line stated
  // (myne#508). `23:59` rather than the next midnight because the comparison is
  // on the `YYYY-MM-DDTHH:MM` string and a reminder is stored to the minute.
  const to = `${horizonEndDate(now, horizonDays)}T23:59`;
  // At horizon 1, during the final minute of a local day, `from` and `to` are
  // the same string and the set is empty. That is correct rather than
  // degenerate: a one-day horizon covers today, and at 23:59 no instant today
  // is still in the future. What it costs is one minute of churn at the day
  // boundary, since the pass cancels what it holds and re-registers after
  // midnight. Harmless on the in-app tier, where the notifier's own timers are
  // already armed, and worth knowing on the OS tier both clients are one wiring
  // change from. Pinned in `reminderSchedule.test.ts` so the shape is a
  // recorded property rather than a surprise. The old rolling cutoff had no
  // such minute, and it bought that by registering a day past the date the
  // settings line stated.

  const out: PendingReminder[] = [];
  for (const task of tasks) {
    if (task.completed) continue;
    if (task.remind == null) continue;
    const at = instantOf(task.remind);
    if (at <= from || at > to) continue;
    out.push({ id: reminderId(task), at });
  }
  // Sorted so two runs over the same input produce byte-identical output — a
  // diff that depended on iteration order would report spurious churn.
  out.sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
  return out;
}

/** What a reconcile pass would do. Computed, so it can be asserted directly. */
export type ReminderDiff = {
  readonly schedule: readonly PendingReminder[];
  readonly cancel: readonly string[];
};

/**
 * The diff from `current` to `target`.
 *
 * A reminder whose **time changed** appears in both halves — cancel then
 * reschedule — because no OS surface here offers an atomic move, and pretending
 * otherwise would leave the old time registered.
 */
export function diffReminders(
  current: readonly PendingReminder[],
  target: readonly PendingReminder[],
): ReminderDiff {
  const currentById = new Map(current.map((r) => [r.id, r.at]));
  const targetById = new Map(target.map((r) => [r.id, r.at]));

  const schedule = target.filter((r) => currentById.get(r.id) !== r.at);
  const cancel = current
    .filter((r) => targetById.get(r.id) !== r.at)
    .map((r) => r.id);
  return { schedule, cancel };
}

/** The outcome of a pass. Failures are counted, never thrown. */
export type ReminderPassResult = {
  readonly scheduled: number;
  readonly cancelled: number;
  /** Operations the notifier refused. A pass with failures is still a pass. */
  readonly failed: number;
};

/**
 * Reconcile the OS registration set against the task list.
 *
 * **Never throws.** A notifier that fails — permission revoked, platform
 * unavailable, a transient error — must not take down the caller, because this
 * runs from an unlock hook and a periodic tick where an exception would surface
 * as a crash for a feature the user may not even have enabled. Failures are
 * counted and the pass continues; the next pass retries by construction, since
 * the target set is recomputed from scratch every time.
 */
export async function runReminderPass(
  tasks: readonly VaultTask[],
  notifier: ReminderNotifier,
  clock: ReminderClock,
  horizonDays: number = REMINDER_HORIZON_DAYS,
): Promise<ReminderPassResult> {
  let current: readonly PendingReminder[] = [];
  try {
    current = await notifier.listPending();
  } catch {
    // An unreadable current set is treated as empty: re-registering something
    // already registered is harmless (the OS replaces by id), while giving up
    // would leave the user with no reminders at all.
    current = [];
  }

  const target = targetReminders(tasks, clock(), horizonDays);
  const { schedule, cancel } = diffReminders(current, target);

  let scheduled = 0;
  let cancelled = 0;
  let failed = 0;

  // Cancel first. Scheduling first would briefly hold both the old and the new
  // time for a moved reminder, and a duplicate notification is the failure a
  // user actually notices.
  for (const id of cancel) {
    try {
      await notifier.cancel(id);
      cancelled++;
    } catch {
      failed++;
    }
  }
  for (const reminder of schedule) {
    try {
      await notifier.schedule({ id: reminder.id, at: reminder.at });
      scheduled++;
    } catch {
      failed++;
    }
  }

  return { scheduled, cancelled, failed };
}
