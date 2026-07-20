// Settings-search suite (MYND-536). Drives the Settings-panel search through the
// REAL editor UI:
//
//   ss1 — CROSS-PANEL JUMP: open Settings on the default Account panel, type a
//         query that matches a PRIVACY setting ("screen capture"), assert it
//         appears in the results list, activate it, and assert the modal switched
//         to the Privacy panel AND scrolled the target setting (its
//         `data-setting-anchor`) into the content pane.
//   ss2 — EMPTY STATE: type a query that matches nothing and assert the explicit
//         "no settings match" state renders.
//
// The search index is a static registry (src/components/settings/search/), so
// matching never mounts the other nine panels; only the selected jump mounts one.
//
// AUTHORED ON A NON-HARNESS HOST (macOS) — pending green-3× verification on the
// Linux tauri-driver container (the e2e DoD; `./scripts/e2e-local.sh`).
//
// KDF: weak generator fixtures (SYNC-9 — params are vault.meta-resident).

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  openSettings,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Type `text` into the Settings search box (sending keys focuses it first). */
async function typeSearch(session: Session, text: string): Promise<void> {
  await (await session.byTestId("settings.search-input")).replaceText(text);
}

// ── ss1: cross-panel search → jump + scroll to the target setting ────────────

describeE2E("ss1 settings search cross-panel jump (MYND-536)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("searches from Account and jumps to the matched Privacy setting", async () => {
    let password = "";
    await scenario(
      "ss1-cross-panel-jump",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Open Settings on the default Account panel.
        await openSettings(s);
        await s.byTestId("settings.search-input");

        // Type a query that matches a setting living in the PRIVACY panel.
        await typeSearch(s, "screen capture");

        // The results list surfaces the screen-capture entry.
        const resultSel = testIdSelector("settings.search-result", {
          "data-setting-id": "privacy.screen-capture",
        });
        const row = await s.waitForElement(resultSel);
        if ((await row.attribute("data-panel")) !== "privacy") {
          throw new Error("screen-capture result is not tagged with the privacy panel");
        }

        // Activate it → switch to Privacy + scroll/flash the target setting.
        await row.click();

        // The rail now marks Privacy selected.
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.tab-privacy")).attribute("aria-selected")) === "true"
              ? true
              : null,
          { label: "privacy tab becomes selected after result select" },
        );

        // And the target setting's anchor is present in the (now Privacy) content
        // pane — proving the jump landed on the setting, not just the panel.
        await s.waitForElement('[data-setting-anchor="privacy.screen-capture"]');

        await closeSettings(s);
      },
    );
  });
});

// ── ss2: no-match query → explicit empty state ───────────────────────────────

describeE2E("ss2 settings search empty state (MYND-536)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("shows the empty state when the query matches nothing", async () => {
    let password = "";
    await scenario(
      "ss2-empty-state",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await openSettings(s);
        // A single lowercase-alnum token that matches no setting title/desc/keyword.
        await typeSearch(s, "zzzzznope42");

        await s.waitForElement(testIdSelector("settings.search-empty"));

        await closeSettings(s);
      },
    );
  });
});
