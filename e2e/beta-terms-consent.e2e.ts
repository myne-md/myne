// The beta-terms consent gate (myne-ops#15). Three scenarios over one
// mechanism: a device may not turn sync on until the person at it has accepted
// the terms this build ships, and "this build" is a version comparison rather
// than a flag.
//
//   bt1 — no acceptance on disk: the Settings sync panel shows the GATE where
//         the enrol form would be, and the enrol form is NOT rendered. Opens
//         the terms dialog, dismisses it (the form is still absent — a
//         dismissable dialog in front of a live form would be a route past the
//         gate, not a gate), then accepts, and the form appears. The halves are
//         one scenario because the later ones are only meaningful as the state
//         change of the first — asserting "the form is present" on a fresh
//         device proves nothing about a gate.
//
//   bt2 — the current version already accepted: neither the gate nor its dialog
//         appears and the enrol form is there from the start. This is the
//         regression that matters most in daily use; a gate that re-asks every
//         launch would be noticed immediately, and a gate that never re-asks
//         would not.
//
//   bt3 — an OLD version accepted: the gate appears again. This is the whole
//         reason the record stores a version instead of a boolean, and it is
//         the assertion that would silently stop holding if someone "simplified"
//         the record to `accepted: true`.
//
// No server and no second device: the gate is entirely device-local and stands
// BEFORE any network contact, so a scenario that stood up a sync server would
// be paying for infrastructure it never reaches — and would fail for reasons
// that have nothing to do with consent.
//
// The four clauses are asserted by FULL-LITERAL equality against `@myne/copy`
// (e2e/CLAUDE.md): each is a bounded claim, and the failure this guards against
// is a well-meaning paraphrase that softens one of them.
//
// Green 3× consecutive in the Linux tauri-driver container (the e2e DoD),
// via `./scripts/e2e-buildrun.sh beta-terms-consent beta-terms-consent
// beta-terms-consent` — one build, three runs in the same warm container, no
// retries consumed.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { legalConsentSeed } from "./support/multi-device";
import { dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import {
  BETA_TERMS_DATA_LOSS,
  BETA_TERMS_WHAT_HAPPENS_NEXT,
  BETA_TERMS_WHAT_THIS_IS,
  BETA_TERMS_WHAT_WE_CAN_SEE,
} from "../src/lib/load-bearing-copy";
import type { Session } from "./support/webdriver";

/** Every clause, by the testid it renders under and the literal it must equal. */
const CLAUSES: ReadonlyArray<[string, string]> = [
  ["sync.beta-terms.what-this-is", BETA_TERMS_WHAT_THIS_IS],
  ["sync.beta-terms.data-loss", BETA_TERMS_DATA_LOSS],
  ["sync.beta-terms.what-happens-next", BETA_TERMS_WHAT_HAPPENS_NEXT],
  ["sync.beta-terms.what-we-can-see", BETA_TERMS_WHAT_WE_CAN_SEE],
];

/**
 * Assert the four clauses are on screen, verbatim.
 *
 * `textContent`, not `text()`: this driver's W3C getText returns only what is
 * VISIBLE, and the four clauses sit far enough down a tall settings modal that
 * the lower ones are clipped by its scroll container. The first run of this
 * spec failed on exactly that — an empty string against a clause that was
 * present and correct in the DOM.
 */
async function expectClausesVerbatim(s: Session): Promise<void> {
  for (const [testId, literal] of CLAUSES) {
    const el = await s.byTestId(testId);
    expect(await el.textContent()).toBe(literal);
  }
}

describeE2E("beta-terms consent gate", () => {
  it("bt1 — asks before the first sync enable, and opens the door once accepted", async () => {
    let password = "";
    await scenario(
      "bt1-beta-terms-asked",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await openSettings(s, "sync");

        // Wait for the gate before counting anything. `byTestIdAll` is a
        // one-shot query with no wait in it, and the panel renders neither the
        // gate nor the form until the device-local read resolves — so a bare
        // count races the answer and reads zero from a panel that is about to
        // be right. (That race is what failed bt3 on this spec's first run,
        // while bt1 happened to win it.)
        await s.byTestId("sync.beta-terms.open");

        // The gate stands where the enrol form would be. Not "above it" — the
        // form is absent, so there is no route to enrolment that skips the text.
        expect((await s.byTestIdAll("sync.enroll.account-input")).length).toBe(0);

        // The terms themselves are a dialog. It is the ONLY thing that renders
        // the accepting button, which is why the clauses are checked here and
        // not on the panel behind it.
        await (await s.byTestId("sync.beta-terms.open")).click();
        await s.byTestId("sync.beta-terms");

        await expectClausesVerbatim(s);

        // Dismissing declines: the form must still be absent afterwards, or the
        // dialog would be a route past the gate rather than the gate itself.
        await (await s.byTestId("sync.beta-terms.cancel")).click();
        await s.waitUntil(
          async () => ((await s.byTestIdAll("sync.beta-terms")).length === 0 ? true : null),
          { label: "the terms dialog closes", timeoutMs: 15_000 },
        );
        expect((await s.byTestIdAll("sync.enroll.account-input")).length).toBe(0);

        await (await s.byTestId("sync.beta-terms.open")).click();
        await (await s.byTestId("sync.beta-terms.accept")).click();

        // The state change: the gate gives way to the form it was standing in
        // front of, and the dialog is gone with it.
        await s.byTestId("sync.enroll.account-input");
        expect((await s.byTestIdAll("sync.beta-terms")).length).toBe(0);
        expect((await s.byTestIdAll("sync.beta-terms.open")).length).toBe(0);
      },
    );
  });

  it("bt2 — does not ask again once the current version is accepted", async () => {
    let password = "";
    await scenario(
      "bt2-beta-terms-remembered",
      {
        seed: (dir) => void (password = seedVault(dir).password),
        seedConfig: legalConsentSeed(),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await openSettings(s, "sync");

        await s.byTestId("sync.enroll.account-input");
        // Neither the gate nor its dialog. Checking only the dialog would pass
        // trivially — it opens on a click nobody made.
        expect((await s.byTestIdAll("sync.beta-terms.open")).length).toBe(0);
        expect((await s.byTestIdAll("sync.beta-terms")).length).toBe(0);
      },
    );
  });

  it("bt3 — asks again when the accepted version is not the shipped one", async () => {
    let password = "";
    await scenario(
      "bt3-beta-terms-superseded",
      {
        seed: (dir) => void (password = seedVault(dir).password),
        // A version that is deliberately not the shipped one. This stands in
        // for "the terms were edited and the version bumped" without needing
        // to rebuild the app with different copy — the comparison is the thing
        // under test, and it cannot tell the two situations apart.
        seedConfig: legalConsentSeed("0-superseded"),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await openSettings(s, "sync");

        await s.byTestId("sync.beta-terms.open");
        expect((await s.byTestIdAll("sync.enroll.account-input")).length).toBe(0);
      },
    );
  });
});
