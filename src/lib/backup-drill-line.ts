// The one-time line on the backup-success screen (myne-md/myne#468, task 6).
//
// After a backup lands, the success surface says once that a backup is not a
// substitute for the recovery phrase, with a button into the drill. It is the
// ONLY automatic surfacing this feature gets (`RecoveryDrillRow`'s header says
// why): it is context rather than a reminder, because the user has just been
// thinking about disaster recovery, and it never returns.
//
// # Why `localStorage` and not `vault.prefs`
//
// Dismissal is a UI fact, not vault content. Storing it in `vault.prefs` would
// mean a new field in the canonical prefs encoding, which is an on-disk format
// change (spec §9.5.2) for a boolean whose only job is "this device has already
// been told". The value carries nothing secret, so there is nothing the
// encrypted prefs blob would protect.
//
// Device-scoped rather than per-vault, for the same reason `WebReloadNotice`'s
// key is: what the line teaches ("a backup is not the phrase") is about the
// person, and a second vault is not a reason to teach it again. `last_backup_at`
// is per-vault because it drives a real reminder; this is the opposite.

/** The one key. Namespaced so it cannot collide with anything else on the origin. */
export const BACKUP_DRILL_LINE_KEY = "myne.backup.drill-line-seen";

/** Whether this device has already been shown the line.
 *
 *  A storage failure reads as "not seen": a private window with storage denied
 *  gets the line, and being told once too often is a far smaller cost than the
 *  lesson never landing. */
export function hasSeenBackupDrillLine(): boolean {
  try {
    return window.localStorage.getItem(BACKUP_DRILL_LINE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Retire the line for good. Called from every acknowledgement of the success
 *  screen: the Done button, Esc or the backdrop, and the drill button itself
 *  (acting on the line is the strongest acknowledgement there is).
 *
 *  A storage failure is swallowed on purpose. The write can only fail in a
 *  window whose storage is denied, where `hasSeenBackupDrillLine` already reads
 *  `false`, so the line would reappear next session either way, and failing the
 *  dismissal would be strictly worse than showing it again. */
export function markBackupDrillLineSeen(): void {
  try {
    window.localStorage.setItem(BACKUP_DRILL_LINE_KEY, "1");
  } catch {
    // Storage denied: nothing to persist into.
  }
}
