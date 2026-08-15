// Clipboard copy feedback (myne-md/myne#390 + myne-md/myne#455).
//
// # What this pins that a unit test cannot
//
// The unit tests in `tests/lib/clipboard.test.ts` prove the policy module runs
// the right arm. They cannot prove that the arm reaches a surface: every one of
// them installs its own fake, and the defect this feature fixes was precisely
// that the real surfaces were missing or unreachable. Two of them concretely:
//
//   - The desktop `<Toaster />` mounted INSIDE the post-unlock editor screen, so
//     a `toast(...)` from vault creation drew nothing, silently, with no error
//     and no failing test anywhere.
//   - `AccountStep`'s confirmation was set and cleared only when the step
//     committed, so it read "Copied" for the rest of the step whatever the user
//     did next.
//
// Both are DOM facts about the real binary, which is what this file is for.
//
// # What it deliberately does NOT assert
//
// Anything about the system clipboard's contents. tauri-driver cannot read the
// OS pasteboard, and the properties that matter most on mobile (device
// confinement, OS-enforced expiry) have no CI-observable form at all, those are
// `docs/dev/clipboard-sensitivity-verification.md`, manual and honestly labelled.
// A scenario here that claimed to check them would be worse than none.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";



const PASSWORD = "correct horse battery staple 42";

/**
 * The success string, by value.
 *
 * Duplicated from `locales/en/common.json` rather than imported, deliberately:
 * this suite drives the production BUNDLE, so importing the catalog would assert
 * the test's copy of the string against itself. A rewording that lands in the
 * catalog and not here fails this scenario, which is the correct outcome for a
 * string the user reads on the screen where the phrase is shown once.
 */
const PHRASE_COPIED = "Copied to the clipboard. It clears itself in 30 seconds, even if you move on.";

describeE2E("cb1 the phrase step reports its copy, and says which outcome (myne#390)", () => {
  it("says nothing before the copy, and the SUCCESS string after it", async () => {
    await scenario("cb1-phrase-copy-reports-outcome", {}, async (app) => {
      const s = app.session;

      // Straight to the create flow's account step. The briefing + password +
      // phrase + confirm steps are exercised by `vault-creation.e2e.ts`; this
      // scenario reuses the same route rather than re-asserting it.
      await (await s.byTestId("welcome.create-cta", { timeoutMs: 30_000 })).click();

      await s.byTestId("create.briefing", { timeoutMs: 15_000 });
      for (const ack of await s.byTestIdAll("create.briefing-ack")) {
        await ack.click();
      }
      // Wait for the gate rather than clicking straight after the last ack: the
      // button enables on a React state update, and clicking into the gap leaves
      // the flow on the briefing with every later step waiting on an element
      // that is one screen away.
      const cont = await s.byTestId("create.briefing-continue");
      await s.waitUntil(() => cont.enabled(), {
        label: "briefing continue enabled (3/3 acknowledged)",
        timeoutMs: 10_000,
      });
      await cont.click();

      await (await s.byTestId("create.password-input")).sendKeys(PASSWORD);
      await (await s.byTestId("create.confirm-input")).sendKeys(PASSWORD);
      const submit = await s.byTestId("create.submit");
      await s.waitUntil(() => submit.enabled(), {
        label: "password submit enabled",
        timeoutMs: 15_000,
      });
      await submit.click();

      // Phrase step. Reveal, copy, and assert the confirmation APPEARS, this
      // surface reported nothing at all before myne#390, on the one screen where
      // the phrase is shown once.
      await s.byTestId("create.phrase-grid", { timeoutMs: 120_000 });
      await (await s.byTestId("create.phrase-reveal")).click();

      // The region exists BEFORE any copy and is empty. Both halves matter: a
      // live region that is only inserted once there is something to say cannot
      // announce it, because a screen reader watches a region it already knows
      // about. This is the half that is easy to get wrong and impossible to see.
      const status = await s.byTestId("create.phrase-copy-status", {
        timeoutMs: 10_000,
      });
      expect((await status.text()).trim()).toBe("");

      // Press Copy. Before myne#390 this screen changed NOTHING on either
      // outcome, which is the defect: a failed copy looked exactly like a
      // successful one on the screen where the phrase is shown once.
      await (await s.byTestId("create.phrase-copy")).click();

      // Asserted by EQUALITY against the success string, not by "something
      // appeared". An earlier version of this checked only that the region was
      // non-empty, which passes identically for `copied` and `copyFailed`, so
      // the concrete regression this branch fixes on the sibling client
      // (myne#455: the account-number Copy reported failure on every tap, on
      // every device, for as long as it shipped) would have passed it unchanged.
      // Distinguishing the two outcomes IS the feature.
      await s.waitUntil(
        async () => ((await status.text()).trim() === PHRASE_COPIED ? true : null),
        { label: "phrase copy reports SUCCESS, not merely an outcome", timeoutMs: 10_000 },
      );
    });
  });
});

// OWED, and deliberately not written as a stub: the note-copy toast.
//
// The note copy is reached through the export pre-flight modal, a multi-step
// flow whose own testids this scenario would have to drive. That is real work
// and it was not done here.
//
// What is NOT acceptable in its place is a scenario that unlocks, asserts the
// editor mounted, and calls itself coverage, which is the first thing this file
// contained. A test that cannot fail for the reason it names is worse than a
// missing one, because the roster then reports a check nobody performed. The gap
// is recorded in the feature's `progress.md` instead, where it can be closed
// rather than mistaken for done.
