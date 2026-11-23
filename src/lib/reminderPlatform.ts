// Which reminder tier this platform actually offers (MYND-618, task 7).
//
// **On Linux the in-app layer is the whole feature, and the app says so.** The
// desktop notification specification there is fire-now only; app-closed firing
// would need a user timer or a cron entry — which is the operating-system
// scheduling the project already rejected for backups — and taking a new crate
// for one platform's weakest tier runs directly against the dependency policy.
//
// So Linux gets the same in-app layer as everywhere else and **nothing is
// pretended**. The limitation is stated in the settings copy rather than
// discovered by a user whose reminder never arrived, and it is classified as a
// **usability** limitation, matching `threat-model.md` §7: a platform that holds
// no registration leaks nothing, so this gap is the safer side of the trade.
//
// No Linux-only notification dependency is added by this module or by anything
// that reads it.

/** How far a platform can deliver a reminder. */
export type ReminderTier =
  /** The OS holds the registration and fires it while Myne is closed. */
  | "pre-registered"
  /** Reminders appear only while Myne is open. */
  | "in-app-only";

/** Detected host platform, kept deliberately coarse. */
export type ReminderPlatform = "macos" | "windows" | "linux" | "unknown";

/**
 * The host platform, from the same `navigator.platform` signal the keybinding
 * layer uses. Coarse on purpose: the only decision it drives is which sentence
 * the settings panel shows.
 */
export function detectReminderPlatform(): ReminderPlatform {
  try {
    if (typeof navigator === "undefined") return "unknown";
    const p = `${navigator.platform} ${navigator.userAgent}`;
    if (/Mac|iP(hone|[oa]d)/.test(p)) return "macos";
    if (/Win/i.test(p)) return "windows";
    if (/Linux|X11|BSD/i.test(p)) return "linux";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The tier a platform offers.
 *
 * `unknown` is treated as **in-app-only**, which is the honest default: claiming
 * a delivery guarantee for a platform we could not identify would be exactly the
 * promise this module exists to avoid making.
 */
export function reminderTier(_platform: ReminderPlatform = detectReminderPlatform()): ReminderTier {
  // EVERY platform reports `in-app-only`, and that is a statement about what
  // this build can deliver rather than about what macOS and Windows can do.
  //
  // The `pre-registered` tier needs two things and this build has one of them.
  // The adapter exists (`src-tauri/src/plugins/reminders/`, and the notifier over
  // it in `src/lib/reminderOsNotifier.ts`), and it can register. What is still
  // missing is the DELIVERY MEASUREMENT: whether a Developer-ID-signed, notarized
  // bundle actually fires a scheduled local notification while not running. That
  // was re-run on 2026-11-22 and is BLOCKED rather than negative — macOS refused
  // authorization for a locally signed probe with `notDetermined` left untouched,
  // and the machine holds no Developer ID identity to build the artifact the test
  // needs (`decisions/ai/0805`, `features/task-notifications-desktop/progress.md`).
  //
  // Reporting `pre-registered` here would put "arrives even when Myne is
  // closed" in the settings copy on the strength of an assumption. The whole
  // point of this module is to not do that: "a platform that holds no
  // registration leaks nothing", and a client that promises no delivery it
  // cannot perform is the same discipline pointed at the user instead of the
  // adversary. When a measurement says delivery works for our artifacts, this
  // returns `pre-registered` for the platforms it covers and the copy follows
  // automatically — and not before, because the adapter's existence is a fact about
  // our code while delivery is a fact about somebody else's platform.
  return "in-app-only";
}

/** Whether the settings panel must show the in-app-only limitation sentence. */
export function showsInAppOnlyLimitation(
  platform: ReminderPlatform = detectReminderPlatform(),
): boolean {
  return reminderTier(platform) === "in-app-only";
}
