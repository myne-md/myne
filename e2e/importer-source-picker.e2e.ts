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
// begins. What it pins is the part that regressed silently before: that all five
// sources are reachable from one entry point, each with its fidelity disclosure
// shown BEFORE the user commits.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import { testIdSelector } from "./support/webdriver";

const SOURCES = ["obsidian", "notion", "evernote", "html", "csv"] as const;

describeE2E("isp1 import source picker reaches every adapter (MYND-586)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("opens one flow from Settings and offers all five sources with disclosure", async () => {
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
        const modal = await s.waitForElement(testIdSelector("import.modal"));
        expect(await modal.attribute("data-phase")).toBe("pick");
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
        // flow parameterized by source, not five flows.
        await (
          await s.waitForElement(
            testIdSelector("import.source-row", { "data-source": "evernote" }),
          )
        ).click();
        const setup = await s.waitForElement(testIdSelector("import.modal"));
        expect(await setup.attribute("data-phase")).toBe("setup");
        expect(await setup.attribute("data-source")).toBe("evernote");
        expect(await (await s.byTestId("import.chosen-source")).text()).toBe("Evernote");

        // PRE-import disclosure for the chosen source, before a path is even picked.
        expect(await (await s.byTestId("import.source-survives")).text()).not.toBe("");
        expect(await (await s.byTestId("import.source-loses")).text()).not.toBe("");

        // And a way back, since this flow opened on the picker.
        await (await s.byTestId("import.change-source")).click();
        expect(
          await (await s.waitForElement(testIdSelector("import.modal"))).attribute(
            "data-phase",
          ),
        ).toBe("pick");
        await (
          await s.waitForElement(
            testIdSelector("import.source-row", { "data-source": "csv" }),
          )
        ).click();

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
