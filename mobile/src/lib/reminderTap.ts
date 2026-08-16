// Tapping a reminder (MYND-619, task 7).
//
// Mirrors the deep-link ingress exactly (`deep-link.ts`), which is already
// threat-modelled: a **module-level in-memory latch**, never written to disk,
// consumed exactly once. The reason is the same one — a tap on a locked phone
// cold-launches the app, so the intent arrives long before anything can act on
// it, and it has to wait somewhere that a stolen device cannot be made to
// reveal.
//
// What the native side delivers is the **opaque registration identifier** and
// nothing else. There is no note identifier and no task text in a reminder
// payload to begin with (`reminderIdentity.ts`), so there is none here either.
//
// ── Dropped silently is the designed behaviour ─────────────────────────────
//
// A tap that arrives with nothing listening is lost, and that is deliberate
// rather than a gap: the alternative is a queue, and a queue is a file. The
// worst case is a user who taps a reminder and lands on the app's normal
// post-unlock surface instead of on that task — which is where they were going
// anyway, one step further away.
//
// ── What this module does NOT do ───────────────────────────────────────────
//
// It does not decide where a tap lands. That is the mobile task surface's job.
// It also cannot resolve an identifier tapped after a cold start: the
// opaque→locator map is memory-only by design and a new session has never seen
// it. See the note in `reminderIdentity.ts`.

import { HAS_TAURI } from "./app-window";

/**
 * Fired on the window when a reminder tap arrives while the app is already
 * running. The cold-launch case is covered by the latch below, not by this
 * event — nothing is mounted yet to hear it.
 */
export const REMINDER_TAP_EVENT = "myne-reminder-tap";

/** The global Tauri event the native halves emit. */
const NATIVE_EVENT = "reminder-tap";

/** A tap that arrived before anything was listening. Consumed once, after unlock. */
let latched: string | null = null;

/**
 * Latch and announce one tapped identifier.
 *
 * Exported for unit coverage of the cold-launch latch; `initReminderTaps` is the
 * production caller.
 */
export function handleReminderTap(id: unknown): void {
  // Anything that is not a non-empty string is not something the native halves
  // send. Ignored rather than latched, so a malformed delivery cannot occupy the
  // latch and block the real one behind it.
  if (typeof id !== "string" || id.length === 0) return;
  latched = id;
  window.dispatchEvent(new CustomEvent<{ id: string }>(REMINDER_TAP_EVENT, { detail: { id } }));
}

/**
 * Take (and clear) a latched tap.
 *
 * Exactly once: a second call returns `null`. Two surfaces both acting on the
 * same tap would navigate twice, and the second navigation is the one the user
 * did not ask for.
 */
export function consumeReminderTap(): string | null {
  const id = latched;
  latched = null;
  return id;
}

/** Discard a latched tap without acting on it — used when a session ends. */
export function clearReminderTap(): void {
  latched = null;
}

/**
 * Subscribe to native tap deliveries. Called once at boot.
 *
 * No-op in browser dev, and inert if the plugin is unavailable — a missing
 * listener means taps are dropped, which is the designed behaviour rather than
 * an error to surface.
 */
export async function initReminderTaps(): Promise<void> {
  if (!HAS_TAURI) return;
  try {
    const { listen } = await import("../platform/event");
    await listen<{ id?: unknown }>(NATIVE_EVENT, (event) => {
      handleReminderTap(event.payload?.id);
    });
  } catch {
    // No host, or an older one. Taps are simply inert.
  }
}
