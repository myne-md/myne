// First-run AI onboarding "seen" flag (myne-md/myne#805).
//
// A DEVICE-LOCAL UI preference (localStorage, exactly like `accentColor.ts` and
// `viewsEnabled.ts`), NOT a synced/encrypted `vault.prefs` field. Two reasons,
// both load-bearing:
//
//   1. The surface must appear ONCE PER DEVICE, across every entry path: fresh
//      create, restore, recovery, member accept. A `vault.prefs` field would be
//      vault content, so a device that joins a vault someone else already saw
//      the screen on would never see it, and the choice would depend on how the
//      vault started rather than on this device.
//   2. It is not a secret and carries nothing vault-derived, so device-local at
//      rest is the same trust level as the language preference.
//
// The AI opt-in itself is the existing `ai_enabled` pref (vault content); this
// flag only gates whether the first-run surface is OFFERED.

const SEEN_KEY = "myne.aiOnboardingSeen";

/** Whether the first-run AI surface has already been shown on this device. */
export function readAiOnboardingSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Private mode / disabled storage: treat as "not seen" so the surface is
    // still offered. The worst case is offering it again, never hiding it.
    return false;
  }
}

/** Mark the first-run AI surface as seen on this device. Idempotent. */
export function writeAiOnboardingSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode: the surface will simply be offered again next launch */
  }
}
