// Absence, proved in a browser (MYND-574 tasks 27 + 61).
//
// The whole capability model rests on one claim: an affordance a browser cannot
// honour is **absent from the UI**, not present-and-failing. `decisions.md`
// 2026-07-26 makes that normative, `check-web-capabilities.mjs` checks the
// descriptor agrees with the router, and `tests/platform/` checks the seam
// refuses. None of those looks at a rendered page.
//
// This does. It is the only check in the feature that answers "did the button
// actually not render", which is the form the user experiences.
//
// Vault-count precondition: **0** — a clean profile on the first-run screen.
// Everything asserted here is reachable before any vault exists, deliberately:
// a gating bug that only appears post-unlock would be caught by the same
// assertions later, but this way the scenario needs no server.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { openApp } from "./support/flows";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";

/**
 * Testids that must NOT exist anywhere in a web build's first-run surface.
 *
 * Each names a capability the web descriptor lists as absent. Asserted as "no
 * element with this testid" rather than "the element is disabled", because
 * disabled is the outcome the rule forbids: a greyed control still tells the
 * user the feature exists here and still invites a support question about why
 * it does not work.
 */
const MUST_BE_ABSENT: readonly [string, string][] = [
  // `decisions.md` 2026-08-15 removed the two entries that used to head this
  // list — `create.start` and `recover.phrase-input`, both named for the
  // phrase ban this client no longer carries. Creation and recovery SHIP here,
  // so asserting their absence would now assert the opposite of the rule.
  // (Neither testid existed in the tree by those names, which is its own
  // lesson: an absence assertion on a name nothing renders passes forever and
  // proves nothing. The list below is checked against real testids.)
  //
  // What stays is the phrase path this client still refuses to OFFER. The grid
  // itself SHIPS here since `decisions.md` 2026-10-18 (entry 0704, which retired
  // the build-time substitution and the deleted `check-web-no-phrase.mjs`), so
  // the rule this entry asserts is the rendered arm, not the module: the
  // `phraseEnrolment` capability flag hides it, and an element that renders
  // anyway is the regression.
  ["sync.enroll.phrase-cell", "the phrase as a DEVICE-ENROLMENT credential — refused as an offer, while the module ships (decisions.md 2026-10-18, entry 0704)"],
  ["member-roster", "the B2B member surface: `memberSharing` is absent (web has no keychain-style carrier and the panel's phrase prompt is substituted out of the bundle, not merely gated)"],
  // The creation flow's two disk affordances (`create.ready-backup-now`,
  // `create.ready-show-folder`) left this list with myne-md/myne#960: the
  // controls were deleted on BOTH clients, so asserting their absence here
  // would be the "name nothing renders" shape this list's own comment warns
  // about. What remains absent is `backup` on the panel it still reaches.
];

describeE2E("capability gating renders as absence", () => {
  it("does not render an affordance for a capability this client lacks", async () => {
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    try {
      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        await openApp(browser.session, server.origin);
        await browser.session.byTestId("welcome.root", { timeoutMs: 30_000 });

        for (const [testId, why] of MUST_BE_ABSENT) {
          const found = await browser.session.byTestIdAll(testId);
          expect(found.length, `${testId} must be absent — ${why}`).toBe(0);
        }
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
    }
  });
});
