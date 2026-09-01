// Import source-picker suite (MYND-586, importer-breadth epic).
//
// The flow-level counterpart to `importer-read-seam.e2e.ts`. This scenario is only
// possible BECAUSE this epic added the importer's `data-testid` pass —
// `ObsidianImportModal.tsx` previously carried zero testids, so the modal was
// invisible to the driver and no import flow could be E2E-driven at all
// (`src/CLAUDE.md`: "a screen without testids is invisible to E2E").
//
// ASSERTED-VS-DEFERRED SPLIT (the `vault-export` suite's documented pattern): the
// picker step and the per-source setup step are driven for real. The step AFTER
// choosing a path is reachable only through the OS-native file/folder dialog, which
// WebDriver cannot drive — so the engine itself stays covered by the read-seam suite
// plus the Vitest adapter suites, and this scenario stops where the native dialog
// begins. What it pins is the part that regressed silently before: that all six
// sources are reachable from one entry point, each with its fidelity disclosure
// shown BEFORE the user commits.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const SOURCES = [
  // The sixth source (myne-md/myne#464) is first in the picker, not by
  // seniority: it is the only one whose format is Myne's own, and a user with
  // two vaults looking for how to combine them has nowhere else to look.
  "myne",
  "obsidian",
  "notion",
  "evernote",
  "html",
  "csv",
] as const;

/** Wait until the modal reports `phase`. The modal element persists across phases —
 *  only `data-phase` changes — so `waitForElement` returns immediately and a single
 *  `attribute()` read races React's state update. This is what made the first version
 *  of this scenario pass only on retry. */
async function waitForPhase(
  s: Session,
  phase: "pick" | "setup",
): Promise<void> {
  await s.waitUntil(
    async () => {
      const el = await s.byTestId("import.modal");
      return (await el.attribute("data-phase")) === phase ? true : null;
    },
    { label: `import.modal[data-phase=${phase}]` },
  );
}


describeE2E("isp1 import source picker reaches every adapter (MYND-586)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("opens one flow from Settings and offers all six sources with disclosure", async () => {
    let password = "";
    await scenario(
      "isp1-source-picker",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Settings → Storage → Import is one of the three surfaces the epic
        // generalized; all three now open the SAME flow.
        await openSettings(s, "storage");
        await (await s.byTestId("storage.import")).click();

        // The flow opens on the picker, not on an Obsidian-specific setup step.
        await waitForPhase(s, "pick");
        await s.waitForElement(testIdSelector("import.source-picker"));

        // Every adapter is reachable, and each row carries its own honest
        // what-survives / what-does-not line before anything is committed.
        for (const source of SOURCES) {
          const row = await s.waitForElement(
            testIdSelector("import.source-row", { "data-source": source }),
          );
          expect(await row.text()).not.toBe("");
        }
        // Cards carry a one-line identity; the full keeps/loses disclosure renders
        // on the setup step (asserted below), still before anything is committed.
        expect(await s.byTestIdAll("import.source-short")).toHaveLength(SOURCES.length);

        // Choosing a source advances to that source's setup step and records which
        // adapter the flow will run — the assertion that this is genuinely one
        // flow parameterized by source, not six flows.
        await (
          await s.waitForElement(
            testIdSelector("import.source-row", { "data-source": "evernote" }),
          )
        ).click();
        await waitForPhase(s, "setup");
        expect(
          await (await s.byTestId("import.modal")).attribute("data-source"),
        ).toBe("evernote");
        expect(await (await s.byTestId("import.chosen-source")).text()).toBe("Evernote");

        // PRE-import disclosure for the chosen source, before a path is even picked.
        expect(await (await s.byTestId("import.source-survives")).text()).not.toBe("");
        expect(await (await s.byTestId("import.source-loses")).text()).not.toBe("");

        // And a way back, since this flow opened on the picker.
        await (await s.byTestId("import.change-source")).click();
        await waitForPhase(s, "pick");
        await (
          await s.waitForElement(
            testIdSelector("import.source-row", { "data-source": "csv" }),
          )
        ).click();
        await waitForPhase(s, "setup");

        // Nothing is armed until a path is picked, and the native dialog is the only
        // way to arm it — so this is where the driven part ends.
        expect(await (await s.byTestId("import.start")).enabled()).toBe(false);

        // Cancel is a free exit: nothing invoked, nothing written.
        await (await s.byTestId("import.cancel")).click();
        await s.waitForGone(testIdSelector("import.modal"));
      },
    );
  });
});
