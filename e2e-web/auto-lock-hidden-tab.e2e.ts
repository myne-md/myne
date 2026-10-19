// A tab that was hidden past its auto-lock deadline is locked the instant you
// look at it again. myne-md/myne#556, the `vault.auto-lock` /
// `settings.block.auto-lock` bullet:
//
//   > a driver hides the tab for real by opening a second one and the browser
//   > then throttles the hidden tab's timers; `useIdleAutoLock.ts` compares
//   > timestamps, so "locked the instant you return" is deterministic and "note
//   > content unmounted" is a DOM query.
//
// # The walk this retires, and why it is the one that gets faked
//
// Set auto-lock to a minute, switch to another tab, wait, come back, check it
// locked. Waiting a real minute is the part that gets skipped — and skipping it
// is invisible, because a tester who waits ten seconds and sees an unlocked
// vault concludes "not yet" rather than "I did not run this check".
//
// # What is actually at risk, in one paragraph
//
// `useIdleAutoLock.ts` exists because a browser tells a page nothing about OS
// idle, and its header names the trap it is built around: browsers clamp
// `setTimeout` in a hidden tab to roughly once per minute and may suspend it
// entirely, so **a countdown built from ticks stops counting exactly when the
// user has walked away** — the situation auto-lock exists for, turned into the
// one it silently skips.
//
// So nothing there counts ticks; every decision compares timestamps, and
// `visibilitychange` is deliberately NOT treated as activity ("becoming visible
// is not activity, it is the moment to *evaluate*"). This scenario is the only
// place that property is exercised end to end, because it needs a genuinely
// backgrounded tab and a real clock.
//
// # Why a second TAB rather than driver trickery
//
// Opening a second top-level context is what actually makes the first one
// `document.hidden` and puts it under the browser's real throttling policy. No
// emulation, no CDP: the same thing a user does when they go read something
// else. The second tab is left on `about:blank` — it exists only to hold the
// foreground, and never touches the app, so the single-tab vault lock is not
// involved.
//
// # Non-vacuity: it must NOT lock on the short trip
//
// "It is locked when I come back" is also true of a vault that locks the moment
// the tab is hidden, or on any `visibilitychange` at all, or that was already
// locked. So the scenario makes the SAME round trip twice: once well inside the
// deadline, asserting the vault is still open, and once past it. Only the pair
// says anything about a timeout.
//
// # The timing is the shipped minimum, not a test-only value
//
// The Privacy panel offers 1 / 5 / 15 / 30 / 60 minutes and this takes the
// smallest, driven through the real control. Setting a smaller value through
// IPC would be forcing a state the UI cannot produce, which is the thing the
// lane's rules refuse — so this scenario costs a real minute of wall clock and
// says so rather than cheating it.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault, openSettingsTab } from "./support/fixture-session";
import type { Session } from "./support/session";
import { testIdSelector } from "./support/session";

/** The smallest auto-lock the Privacy panel offers, in seconds. */
const AUTO_LOCK_SECS = 60;
/** How long to stay away on the long trip. Past the deadline with margin for
 *  the round trips this scenario makes before starting the clock. */
const AWAY_MS = (AUTO_LOCK_SECS + 8) * 1000;
/** The short trip: long enough to be a real backgrounding, far short of the
 *  deadline. */
const BRIEF_MS = 4_000;

/** Whether the unlocked shell is still on screen. */
async function isUnlocked(session: Session): Promise<boolean> {
  return await session.execute<boolean>(
    "return !!document.querySelector('[data-testid=\"editor.bottom-bar\"]');",
  );
}

/**
 * Leave for `awayMs` in a second tab, then come back.
 *
 * The wait happens while the OTHER tab is foregrounded, which is the whole
 * point: the app's tab is genuinely hidden and its timers are subject to the
 * browser's real throttling, not to anything this test arranged.
 */
async function leaveAndReturn(session: Session, home: string, awayMs: number): Promise<void> {
  const away = await session.newWindow();
  // The wait happens on the TEST side, not in the page. An `execute` holding a
  // promise for a minute exceeds WebDriver's script timeout (30s by default,
  // and this failed on it), and — more importantly — a driver command running
  // against the app's tab during the absence is a driver command that can
  // re-activate it. Sleeping here means nothing touches that tab at all while
  // it is meant to be backgrounded.
  await new Promise((resolve) => setTimeout(resolve, awayMs));
  // Close the parked tab FIRST, from the parked tab, so the return home happens
  // exactly ONCE. An earlier version came home, went back to close, and came
  // home again — three visibility transitions, with the evaluate-and-lock the
  // first one starts still in flight during the next two. That made the whole
  // scenario non-deterministic: one run caught the editor mid-teardown and
  // "passed", the next found it still up thirty seconds later. One transition,
  // one thing to observe.
  await session.send("DELETE", "/window");
  void away;
  await session.switchToWindow(home);
}

describeE2E("a tab hidden past its auto-lock deadline is locked on return", () => {
  // THIS SCENARIO FOUND A LIVE DEFECT AND THE FIX IS IN THE SAME BRANCH.
  // myne-md/myne#556. It failed for a long time, and every intermediate
  // diagnosis was wrong, so the route is recorded — the wrong turns are the
  // useful part.
  //
  // WHAT WAS MEASURED, in order:
  //
  //   1. Setting auto-lock to 1 min through Settings -> Privacy PERSISTS.
  //   2. With the tab VISIBLE and untouched, the vault did not lock 75s later.
  //      (Polling with `execute` cannot be the cause: `markActive` listens only
  //      to pointerdown / keydown / wheel / touchstart.)
  //   3. With the tab genuinely HIDDEN it did not lock either. A recorder
  //      installed before leaving reported one transition each way,
  //      `hidden@… , visible@…`, 68.0s apart.
  //   4. The manual Lock button DID lock, in under a second, so
  //      `handleLockFlushed()` was sound.
  //   5. After a page RELOAD it locked correctly (~63s for a 60s timeout) —
  //      i.e. exactly when the value was already on disk at mount.
  //   6. THE CAUSE, from one build with `prefsRead()` itself instrumented and
  //      NO extra IPC added. The session's reads, in order:
  //
  //        read-ok als=null   x7          <- boot; nothing set yet
  //        called seconds=60 -> resolved  <- the Settings write lands
  //        read-ok als=60     x6          <- the nonce bump; six instances
  //                                          reload and all six get 60
  //        read-fail Io       x10         <- and the rest do not
  //        read-ok als=60     x1
  //        read-fail Io       x8
  //
  // The nonce bump notifies every mounted `usePrefs` in ONE synchronous loop —
  // fourteen of them — and each answers with a full backend round-trip for the
  // same bytes. Most of those concurrent reads failed with `Io`, and
  // `usePrefs`'s `reload` catches and keeps the current cache ("safer state per
  // spec 9.5.5"). So every instance that lost the race stayed on DEFAULT_PREFS
  // for the rest of the session, silently, with WHICH ones lost varying per
  // run. `Editor.tsx`'s `barPrefs` was one of them: `auto_lock_seconds` stayed
  // `null`, `timeoutSecs` 0, `active` false, the hook inert.
  //
  // A thundering herd with a silent swallow — and bigger than auto-lock, since
  // any cross-surface prefs refresh could leave any surface stale. Auto-lock is
  // where the stale value happens to be a security control that never arms.
  //
  // FIXED in `src/lib/prefs.ts`: concurrent `prefsRead()` calls AT THE SAME
  // NONCE share one round-trip. Keyed on the nonce rather than on time, because
  // sharing with a caller that arrived after a write published would hand back
  // pre-write bytes. `tests/lib/prefsReadCoalescing.test.ts` pins all three
  // properties (one round-trip per burst, no sharing across a bump, not a
  // cache), each verified by injection.
  //
  // WHY IT TOOK SO LONG, which is the part worth carrying forward: the failure
  // is NON-DETERMINISTIC — which instances lose the race varies per run — and a
  // page reload hides it, because a mount read happens without the herd. Two
  // earlier diagnoses in this file were confidently wrong for that reason, and
  // one was published and retracted. Measurements taken across DIFFERENT
  // instrumented builds cannot be read as a sequence; the run that settled it
  // instrumented one function, in one build, and added no traffic of its own.
  //
  it("stays open across a brief absence and locks after a real timeout", async () => {
    const ctx = await openFixtureVault();
    try {
      const { session } = ctx;

      // Set the timeout through the real control. The Privacy panel's
      // SearchableSelect: open it, pick the option carrying the seconds.
      await openSettingsTab(session, "settings.tab-privacy");
      await session.execute(
        "document.querySelector('[data-testid=\"settings.auto-lock-select\"]').click();",
      );
      await session.waitForElement(testIdSelector("settings.auto-lock-select-menu"), {
        timeoutMs: 15_000,
      });
      await session.execute(
        "var o = document.querySelector(" +
          "  '[data-testid=\"settings.auto-lock-select-option\"][data-value=\"' + arguments[0] + '\"]'" +
          ");" +
          "if (!o) throw new Error('no auto-lock option for ' + arguments[0]);" +
          "o.click();",
        [String(AUTO_LOCK_SECS)],
      );
      await session.waitUntil(
        async () =>
          (await session.execute<boolean>(
            "var t = document.querySelector('[data-testid=\"settings.auto-lock-select\"]');" +
              "return !!t && (t.textContent || '').indexOf('1 min') !== -1;",
          ))
            ? true
            : null,
        {
          label:
            "the auto-lock control to read back 1 min. Without the pref actually " +
            "landing, the timeout under test is whatever it was before — and the " +
            "default is 5 minutes, which this scenario would then never reach.",
          timeoutMs: 15_000,
        },
      );

      // Close Settings so the editor shell is what the assertions look at.
      await session.execute(
        "document.querySelector('[data-testid=\"settings.close\"]')?.click();",
      );
      await session.waitForGone(testIdSelector("settings.modal"), { timeoutMs: 15_000 });

      const home = await session.windowHandle();
      expect(
        await isUnlocked(session),
        "the vault is not open before the scenario starts, so nothing below measures " +
          "a lock",
      ).toBe(true);

      // NON-VACUITY. A brief absence must NOT lock. Without this, everything
      // below is also satisfied by a vault that locks on any visibilitychange,
      // or on being hidden at all, or that was already locked.
      await leaveAndReturn(session, home, BRIEF_MS);
      expect(
        await isUnlocked(session),
        `the vault locked after only ${BRIEF_MS / 1000}s away, well inside its ` +
          `${AUTO_LOCK_SECS}s timeout. Either becoming hidden is being treated as the ` +
          `deadline, or returning is being treated as expiry — useIdleAutoLock.ts is ` +
          `explicit that "becoming visible is not activity, it is the moment to ` +
          `evaluate", and evaluating must compare timestamps rather than fire on the ` +
          `event. A vault that locks every time you glance at another tab is one ` +
          `people turn off.`,
      ).toBe(true);

      // …and the long one.
      await leaveAndReturn(session, home, AWAY_MS);
      await session.waitForGone(testIdSelector("editor.bottom-bar"), {
        timeoutMs: 30_000,
      });
      expect(
        await isUnlocked(session),
        `the vault is still open after ${AWAY_MS / 1000}s hidden with a ` +
          `${AUTO_LOCK_SECS}s auto-lock. A hidden tab's timers are clamped to roughly ` +
          `once a minute and may be suspended entirely, which is exactly why ` +
          `useIdleAutoLock.ts compares timestamps instead of counting ticks and ` +
          `evaluates on visibilitychange — a countdown stops counting precisely when ` +
          `the user has walked away, which is the moment auto-lock exists for.`,
      ).toBe(false);
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
