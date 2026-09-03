// sn1 — one Escape dismisses one surface. myne-md/myne#555, the `settings.shell`
// bullet:
//
//   > Esc-once-closes-child, Esc-again-closes-Settings and the backdrop
//   > equivalent are shared modal-stack logic, drivable now on WebKitGTK and
//   > again in the web lane across engines.
//
// # The defect this covers, which it was written against
//
// There is no modal stack. `SettingsModal` installs a `window` keydown listener
// that closes Settings on Escape; every child surface installs one of its own
// (the accent picker's is on `document`); none of them stops propagation. So
// one keypress reaches every listener, and what separates them is a single
// boolean the child raises through an `onDialogOpenChange` prop the shell has
// to be passing that panel.
//
// `AppearancePanel` was not being passed it. Opening the accent picker and
// pressing Escape closed the picker AND the Settings modal behind it — one
// keystroke, two surfaces, and whatever the user was in the middle of is gone.
// Fixed in the same change as this scenario.
//
// # Why this is worth a real-browser scenario on top of the unit tests
//
// `tests/components/settingsEscapeStack.test.tsx` drives the same three steps in
// jsdom and is the faster gate. It cannot answer one thing this can: jsdom has
// no real event loop and no engine-level key handling, so "the listeners fire in
// this order for a real Escape on WebKitGTK" is an assumption there and a
// measurement here. The registration ratchet
// (`tests/components/settingsChildDialogRegistration.test.ts`) is the third
// layer and the one that covers the panels this scenario does not open.
//
// The accent picker is the child surface used because it is reachable with no
// account, no provider key and no network — the other two registered children
// (the AI provider consent, the beta terms) each need one of those.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import { KEY, pressKey } from "./support/keyboard";
import { testIdSelector, type Session } from "./support/webdriver";

const MODAL = testIdSelector("settings.modal");
const POPOVER = testIdSelector("settings.accent-popover");

async function isPresent(s: Session, selector: string): Promise<boolean> {
  return (await s.findElements(selector)).length > 0;
}

describeE2E("sn1 Escape dismisses the child surface first (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("closes the accent picker, then Settings, one Escape at a time", async () => {
    let seeded: SeededVault;
    await scenario(
      "sn1-settings-nested-dismiss",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        await openSettings(s, "appearance");
        await (await s.byTestId("settings.accent-color")).click();
        await s.byTestId("settings.accent-popover");

        // First Escape: the child goes, Settings stays.
        await pressKey(s, KEY.ESCAPE);
        await s.waitForGone(POPOVER);
        expect(
          await isPresent(s, MODAL),
          "one Escape closed the accent picker AND the Settings modal behind it. " +
            "Both listen for Escape on the same document and neither stops " +
            "propagation; the shell stands down only while a panel has raised " +
            "`onDialogOpenChange`.",
        ).toBe(true);

        // Second Escape: now Settings goes.
        await pressKey(s, KEY.ESCAPE);
        await s.waitForGone(MODAL);

        // The other half of the same claim, and the reason the first assertion
        // is not enough: a shell that ignored Escape entirely would pass it and
        // be broken in the opposite direction — Settings that cannot be
        // dismissed from the keyboard at all.
        expect(await isPresent(s, MODAL), "Settings did not close on the second Escape").toBe(
          false,
        );
      },
    );
  });

  // Vault-count precondition: 1 (weak KDF).
  it("does the same for a click outside the child surface", async () => {
    // `handleBackdropClick` consults the same flag, so the pointer path is a
    // separate arm of one mechanism rather than a restatement. It broke and was
    // fixed by the same line, and it is the path a user reaches for first.
    let seeded: SeededVault;
    await scenario(
      "sn1-settings-nested-dismiss-backdrop",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        await openSettings(s, "appearance");
        await (await s.byTestId("settings.accent-color")).click();
        await s.byTestId("settings.accent-popover");

        // A click inside the Settings card but outside the popover. The panel
        // heading is a stable, inert target — clicking a control would test that
        // control's own handler instead of the dismissal path.
        await (await s.byTestId("settings.tab-appearance")).click();

        await s.waitForGone(POPOVER);
        expect(
          await isPresent(s, MODAL),
          "clicking outside the accent picker closed the Settings modal too",
        ).toBe(true);
      },
    );
  });
});
