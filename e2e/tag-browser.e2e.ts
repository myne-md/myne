// Tag browser browse + filter suite (tag-system #2 / MYND-46).
//
// Pins the modal tag browser: open it from the BottomBar, multi-select tags in
// the tree, the AND/OR toggle changes the result set, and clicking a result
// opens that note. Tags are seeded by typing inline #tags into note bodies — the
// real save → reindex pipeline (`vaultIndicesApply`) populates the index, so the
// browser reads production data, no test hook.
//
// VERIFICATION STATUS (tag-system #2, 2026-06-14): authored to the harness
// conventions but NOT yet run on this dev platform (macOS; the suite is
// Linux/tauri-driver only — `pnpm test:e2e` self-skips off-platform). Definition
// of done per e2e/CLAUDE.md is "green 3× in the container" (./scripts/e2e-local.sh)
// and MUST be met before merge. Coexistence with the graph's own tag dropdown
// (TS-4 / story 14) is structural — GraphView's picker is untouched by this slice
// — so it is asserted by construction, not separately driven here (would need new
// testids inside the graph modal, out of this slice).

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Number of filtered-result rows currently rendered in the modal. */
async function resultCount(s: Session): Promise<number> {
  return (await s.byTestIdAll("tags.result-row")).length;
}

describeE2E("tb1 browse + AND/OR filter (MYND-46)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("multi-selects tags, toggles AND/OR, and opens a result", async () => {
    // Leading space so the FIRST inline tag has the required (^|\s) boundary
    // even after typeIntoEditor's sacrificial probe char.
    const A_MARK = " #shared #alpha";
    const B_MARK = " #shared #beta";
    let password = "";
    await scenario(
      "tb1-browse-filter",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Two notes: Alpha = #shared + #alpha; Beta = #shared + #beta.
        await createNote(s, "Alpha Note");
        await typeIntoEditor(s, A_MARK);
        await waitForSaved(s);
        await createNote(s, "Beta Note");
        await typeIntoEditor(s, B_MARK);
        await waitForSaved(s);

        // Open the tag browser from the persistent BottomBar affordance.
        await (await s.byTestId("editor.tags-cta")).click();
        await s.byTestId("tags.modal");

        // Select #shared → both notes match. The whole chip toggles selection.
        await (
          await s.waitForElement(
            testIdSelector("tags.chip", { "data-tag-key": "shared" }),
          )
        ).click();
        await s.waitUntil(async () => ((await resultCount(s)) === 2 ? true : null), {
          label: "#shared → 2 results",
        });

        // Add #alpha (AND is the default) → intersection = Alpha Note only.
        await (
          await s.waitForElement(
            testIdSelector("tags.chip", { "data-tag-key": "alpha" }),
          )
        ).click();
        await s.waitUntil(async () => ((await resultCount(s)) === 1 ? true : null), {
          label: "#shared AND #alpha → 1 result",
        });

        // Switch to "Any" (OR) → union = both notes again (proves the toggle).
        await (await s.byTestId("tags.mode-or")).click();
        await s.waitUntil(async () => ((await resultCount(s)) === 2 ? true : null), {
          label: "#shared OR #alpha → 2 results",
        });

        // Click a result → it opens in the editor and the modal closes.
        await (await s.byTestId("tags.result-row")).click();
        await s.waitForGone(testIdSelector("tags.modal"));
        await s.waitUntil(
          async () => ((await editorText(s)).includes("#shared") ? true : null),
          { label: "result opened in the editor" },
        );

        // tag-system #3: the opened note's body shows inline #tag CHIPS; clicking
        // one re-opens the browser filtered to that tag (myne-open-tag bridge).
        await (await s.byTestId("editor.tag-chip")).click();
        await s.byTestId("tags.modal");
      },
    );
  });
});
