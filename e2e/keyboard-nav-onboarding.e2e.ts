// MYND-93 — keyboard-only navigation for the onboarding flows (create / unlock
// / recover). Asserts REACHABILITY + OPERABILITY (every interactive control is
// Tab-reachable and Enter/Space-activatable, no keyboard trap), and pins the
// EXACT Tab order only where order is load-bearing — the 24-cell recovery
// phrase grid. All keys go through the W3C Actions API via support/keyboard.ts
// (byte-clean escapes — no literal Tab/Enter in source).
//
// Vault-count preconditions declared per scenario. Linux-only harness; the
// suite self-skips off-platform via describeE2E.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  KEY,
  pressKey,
  tab,
  tabSignatures,
  tabToTestId,
  activeTestId,
} from "./support/keyboard";
import type { Session } from "./support/webdriver";
import { testIdSelector } from "./support/webdriver";

/** Index of the recovery-phrase cell that currently has focus (`<base>-cell-N`
 *  id pattern), or -1 when focus is not on a cell. */
function focusedCellIndex(session: Session): Promise<number> {
  return session.execute<number>(
    "var el = document.activeElement;" +
      "if (!el || !el.id) return -1;" +
      "var m = el.id.match(/-cell-(\\d+)$/);" +
      "return m ? parseInt(m[1], 10) : -1;",
  );
}

describeE2E("KN-1 unlock is keyboard-reachable, operable, and untrapped (MYND-93)", () => {
  it("Tab reaches password + submit, Enter submits, focus never traps", async () => {
    // Vault-count precondition: 1 (weak KDF — fast unlock).
    let fixture!: SeededVault;
    await scenario(
      "kn1-unlock-keyboard",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.form", { timeoutMs: 20_000 });

        // Reachability + no-trap: Tab around the idle form. The password input
        // is reachable and focus visits several distinct controls (a trap would
        // pin it). Submit is DISABLED while the password is empty, so it is
        // correctly NOT yet in the Tab order — its reachability is asserted
        // below, once typing enables it.
        const seen = await tabSignatures(app.session, 8);
        expect(seen).toContain("testid:unlock.password-input");
        expect(new Set(seen).size).toBeGreaterThanOrEqual(3);

        // Type the password (enabling Submit), Tab to Submit, activate with Enter.
        const input = await app.session.byTestId("unlock.password-input");
        await input.click();
        await input.sendKeys(fixture.password);
        expect(await tabToTestId(app.session, "unlock.submit")).toBe(true);
        await pressKey(app.session, KEY.ENTER);
        await app.session.byTestId("editor.root", { timeoutMs: 30_000 });
      },
    );
  });
});

describeE2E("KN-2 recovery phrase grid has a deterministic Tab order (MYND-93)", () => {
  it("Tab walks the 24 cells strictly in order 0..23 (load-bearing pin)", async () => {
    // Vault-count precondition: 1 — reach phrase entry via the unlock
    // recovery link (no decryption needed for the order pin).
    let fixture!: SeededVault;
    await scenario(
      "kn2-phrase-order",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await (await app.session.byTestId("unlock.recovery-link")).click();
        await app.session.byTestId("recover.phrase-grid", { timeoutMs: 10_000 });
        void fixture;

        const cells = await app.session.findElements(
          testIdSelector("recover.phrase-grid") + " input",
        );
        expect(cells).toHaveLength(24);

        // Focus the first cell, then Tab through; the cell index must
        // increment by exactly one each press — no skips, no back-jumps.
        await cells[0].click();
        expect(await focusedCellIndex(app.session)).toBe(0);
        for (let expected = 1; expected < 24; expected++) {
          await tab(app.session);
          expect(await focusedCellIndex(app.session)).toBe(expected);
        }
      },
    );
  });
});

describeE2E("KN-3 create flow is enterable by keyboard (MYND-93)", () => {
  it("the Welcome create CTA is Tab-reachable and Enter opens the first run", async () => {
    // Vault-count precondition: 0 (cold boot → Welcome).
    await scenario("kn3-create-entry", {}, async (app) => {
      await app.session.byTestId("welcome.root", { timeoutMs: 20_000 });

      // Tab to the primary CTA and activate it with Enter — no mouse.
      const reached = await tabToTestId(app.session, "welcome.create-cta");
      expect(reached).toBe(true);
      expect(await activeTestId(app.session)).toBe("welcome.create-cta");
      await pressKey(app.session, KEY.ENTER);

      // The one create door opens the FIRST RUN (myne-md/myne#911 task 6):
      // the identity ceremony, and the safety briefing follows it. The claim
      // here is keyboard reachability, which is why it stops at the stage.
      await app.session.byTestId("first-run.root", { timeoutMs: 15_000 });
    });
  });
});
