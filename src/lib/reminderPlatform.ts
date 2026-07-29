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
export function reminderTier(platform: ReminderPlatform = detectReminderPlatform()): ReminderTier {
  return platform === "macos" || platform === "windows" ? "pre-registered" : "in-app-only";
}

/** Whether the settings panel must show the in-app-only limitation sentence. */
export function showsInAppOnlyLimitation(
  platform: ReminderPlatform = detectReminderPlatform(),
): boolean {
  return reminderTier(platform) === "in-app-only";
}
