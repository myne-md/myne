// Reminder permission: when to ask, and what to do when refused (MYND-618, task 12).
//
// **The request fires at the moment the user creates their FIRST reminder**, with
// a short in-app explanation immediately before the platform dialog. The dialog
// then makes sense, because the user has just asked for the thing it enables.
//
// The two alternatives were considered and are worse for concrete reasons:
// asking when the setting is toggled does not work because the setting defaults
// **on** and nobody toggles it, so the prompt would never fire; asking at launch
// is cold and happens before unlock, when there is no reminder to explain it.
//
// ON DENIAL: **one quiet line**, in the task surface, saying reminders are off
// and where to turn them on. No nagging, no repeated prompts, no alarm styling.
// The app never re-prompts on its own — a second automatic prompt is how an app
// teaches a user to dismiss dialogs without reading them.

/** What the platform reports about the notification permission. */
export type ReminderPermission = "granted" | "denied" | "not-determined" | "unavailable";

/** The injected platform surface. Kept tiny so it can be stubbed anywhere. */
export type ReminderPermissionApi = {
  status: () => Promise<ReminderPermission>;
  /** Show the platform dialog. Resolves with whatever the user chose. */
  request: () => Promise<ReminderPermission>;
};

/** Whether this moment is the first reminder the user has created. */
export type ReminderPermissionContext = {
  /** How many reminders existed BEFORE the one just created. */
  priorReminderCount: number;
  /** Whether the app already asked once this install. */
  alreadyAsked: boolean;
};

/**
 * Whether to ask now.
 *
 * Exactly one moment qualifies: the first reminder, not yet asked, and the
 * platform has not already answered. Every other combination is silence.
 */
export function shouldRequestPermission(
  status: ReminderPermission,
  ctx: ReminderPermissionContext,
): boolean {
  if (status !== "not-determined") return false;
  if (ctx.alreadyAsked) return false;
  return ctx.priorReminderCount === 0;
}

export type PermissionFlowDeps = {
  api: ReminderPermissionApi;
  /**
   * Show the in-app explanation and resolve when the user acknowledges it.
   * Resolving `false` means they backed out — the platform dialog is then never
   * shown, which keeps the one prompt the OS allows for a moment the user
   * actually wants it.
   */
  explain: () => Promise<boolean>;
  /** Record that the ask happened, so it never repeats automatically. */
  markAsked: () => void;
};

export type PermissionFlowResult =
  | { outcome: "granted" }
  | { outcome: "denied" }
  | { outcome: "skipped"; reason: "already-answered" | "not-first" | "already-asked" | "declined-explainer" }
  | { outcome: "unavailable" };

/**
 * Run the permission flow for a just-created reminder.
 *
 * **Never throws.** A platform that errors on either call is reported as
 * `unavailable`, which the surface states quietly — the same posture as denial,
 * because from the user's side the difference is not actionable.
 */
export async function requestReminderPermission(
  ctx: ReminderPermissionContext,
  deps: PermissionFlowDeps,
): Promise<PermissionFlowResult> {
  let status: ReminderPermission;
  try {
    status = await deps.api.status();
  } catch {
    return { outcome: "unavailable" };
  }

  if (status === "granted") return { outcome: "skipped", reason: "already-answered" };
  if (status === "denied") return { outcome: "denied" };
  if (status === "unavailable") return { outcome: "unavailable" };

  if (ctx.alreadyAsked) return { outcome: "skipped", reason: "already-asked" };
  if (ctx.priorReminderCount !== 0) return { outcome: "skipped", reason: "not-first" };

  // The in-app explanation comes FIRST, so the platform dialog arrives with
  // context rather than as a cold interruption.
  let acknowledged: boolean;
  try {
    acknowledged = await deps.explain();
  } catch {
    acknowledged = false;
  }
  if (!acknowledged) return { outcome: "skipped", reason: "declined-explainer" };

  // Mark BEFORE requesting. If the platform dialog somehow never returns, the
  // app must still not ask again — one automatic prompt, ever.
  deps.markAsked();

  try {
    const answer = await deps.api.request();
    if (answer === "granted") return { outcome: "granted" };
    if (answer === "unavailable") return { outcome: "unavailable" };
    return { outcome: "denied" };
  } catch {
    return { outcome: "unavailable" };
  }
}
