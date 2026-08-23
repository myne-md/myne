/**
 * When a sync failure has lasted long enough to be worth interrupting for
 * (myne#583).
 *
 * Split out as a pure function for the reason `isBackupDue` is: the threshold
 * is the decision, and a decision buried inside a component is one nobody can
 * test at its edges. This one has exactly three, and each was a real question:
 * a device that has never synced, a failure that is minutes old, and one that
 * is days old.
 *
 * ## Why this exists at all
 *
 * Sync against `sync.myne.md` was completely dead for four days in August 2026
 * and nothing said so. The status indicator did its job — it read "Sync error"
 * the whole time — but it lives in Settings → Sync, which nobody opens while
 * their notes appear to be saving fine. Locally they were. Nothing was reaching
 * the server, and the only copy of four days of writing was on one disk.
 *
 * ## Why the copy carries no clock
 *
 * `threat-model.md` AS15 keeps per-device sync timing out of what is persisted
 * and displayed, and the mobile panels already generalise that into a UI rule:
 * status is state, not a local clock. So this answers a yes/no question and the
 * banner says "several days" — the stored timestamp exists to compute the
 * threshold, never to be rendered. A user who wants the exact moment can read
 * it from their server's logs; a shoulder-surfer should not get a usage diary
 * off the editor chrome.
 */

/**
 * Days of continuous failure before the banner appears.
 *
 * Three, which is a judgement rather than a measurement. One day would fire on
 * an ordinary weekend laptop-shut, a week is long enough that a user could
 * write a whole project's worth of notes into a vault that is not backed by
 * anything. It is deliberately coarse: this warning must never become something
 * people learn to dismiss reflexively, because the one time it is right is the
 * time it matters.
 */
export const SYNC_STALE_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Has sync been failing long enough to warn about?
 *
 * `lastSuccessAt` is epoch ms of the last cycle that completed on this device,
 * or `null`/`undefined` when none ever has.
 */
export function isSyncStale(
  lastSuccessAt: number | null | undefined,
  nowMs: number,
): boolean {
  // A device that has NEVER synced does not get this banner. It has no elapsed
  // failure to report, and the states that describe it — not enrolled, no
  // endpoint, awaiting approval — already have their own honest copy. Warning
  // here would tell someone mid-setup that something is wrong when the truth is
  // that they have not finished yet.
  if (lastSuccessAt == null) return false;
  // A clock that ran backwards (a corrected system time, a restored backup)
  // must not read as an ancient failure.
  if (nowMs <= lastSuccessAt) return false;
  return nowMs - lastSuccessAt >= SYNC_STALE_DAYS * DAY_MS;
}
