// The B2B member roster, end to end (myne-md/myne#698).
//
// Uses the shared `scenario` helper, which self-skips when the platform or
// binary cannot run the harness (a macOS host, a missing build), the same
// gate every other suite on this lane carries.
//
// What this proves that no other tier can: the Settings → Sync member-roster
// panel exists in the REAL app and answers the PRE-B2B shape honestly. A
// single-account vault (no membership roster extension) renders the panel
// with an EMPTY list, a no-op by construction, not a hidden error. The full
// two-device invite flow needs the Grill 4 wire route and lands with it.
//
// The empty-state arm is load-bearing: it pins that the panel is a no-op on
// every vault a pre-B2B user holds, which is the back-compat half of
// decisions/protocol/0592.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import {
  closeSettings,
  dismissImporterOffer,
  openSettings,
  unlockToEditor,
} from "./support/flows";
import { seedVault, type SeededVault } from "./support/fixtures";

describeE2E("MR-1 member roster panel renders (myne-md/myne#698)", () => {
  it("the panel mounts in Sync settings and answers empty on a single-account vault", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "mr1-roster-empty",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        await openSettings(app.session, "sync");
        // The panel mounts with the person-identity step first: the invite
        // path needs a held identity, so the phrase form is what a fresh
        // process shows.
        await app.session.byTestId("member-roster", { timeoutMs: 10_000 });
        await app.session.byTestId("member-roster.person-unlock");
        // The empty-list arm: this is the load-bearing back-compat claim (a
        // single-account vault renders the panel as a no-op, not an error), so
        // the assertion is on the empty paragraph, not merely the mount.
        await app.session.byTestId("member-roster.empty");
        // The invite button is present but DISABLED until identity unlocks;
        // this pins the gate rather than only the mount.
        const invite = await app.session.byTestId("member-roster.invite-button");
        expect(await invite.attribute("disabled")).not.toBeNull();
        await closeSettings(app.session);
      },
    );
  });
});
