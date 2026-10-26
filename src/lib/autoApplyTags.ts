// Whether automatic tagging WRITES, and it is DEVICE-LOCAL on purpose
// (myne-md/myne#908).
//
// The switch that turns the tag pass on (`auto_tag_enabled`) is vault content in
// `vault.prefs`, because whether the vault wants suggestions is a property of the
// vault. This one is different in kind: it decides whether THIS device is allowed
// to write into notes without a click. A phone should not start editing notes
// because a desktop opted in, and a member of a shared vault should not inherit a
// write permission from someone else's machine. So it follows the same pattern as
// `aiOnboardingSeen.ts` / `accentColor.ts`: a localStorage flag, not a synced
// field.
//
// Consequence, stated rather than implied: turning it on is a per-device choice.
// The PR body names what a synced version would cost (a new additive-optional
// field in `protocol/src/prefs.rs`, a `PrefClass`, a merge arm and the protocol
// vectors), and that is a separate decision, not an omission.

const KEY = "myne.autoApplyTags";

/** Listeners for same-window changes. `storage` does not fire in the window that
 *  wrote the value, so the panel needs this to make the switch take effect
 *  without a reload. */
const listeners = new Set<(enabled: boolean) => void>();

/** Whether automatic tagging may write on this device. Default off. */
export function readAutoApplyTags(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // Private mode / disabled storage: off, which is the safe direction.
    return false;
  }
}

/** Persist the device-local answer and notify this window. Idempotent. */
export function writeAutoApplyTags(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    /* private mode: the switch simply does not survive a reload */
  }
  for (const fn of listeners) fn(enabled);
}

/** Subscribe to same-window changes. Returns the unsubscribe function. */
export function subscribeAutoApplyTags(
  fn: (enabled: boolean) => void,
): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test-only: drop every listener between specs. */
export function __resetAutoApplyTagsForTest(): void {
  listeners.clear();
}
