// Custom-themes picker suite (custom-themes epic, MYND-112; vault-content
// promotion MYND-486). Pins the user-facing contract of the Settings →
// Appearance → Custom themes subsection through the real editor UI, against a
// real theme sealed into the encrypted `vault.themes` (`MYT1`) store:
//
//   ct1 — a fresh vault (no custom themes) shows the empty state + the Import
//         action.
//   ct2 — a Catppuccin Mocha theme imported into the unlocked vault's
//         vault.themes store (via the real `plugin:themes|themes_import` IPC —
//         the theme is VAULT CONTENT now, not a device-local file) lists as a
//         row; clicking Apply marks it active AND paints its palette onto
//         `:root` (the `--paper` base color appears as an inline CSS var — the
//         CSSOM apply path, src/lib/theme.ts).
//
// Why page-seat IPC to seed (ct2): the native "Import theme" OS file dialog is
// undriveable by WebDriver, so the theme is sealed by firing the real
// `themes_import` command from the page seat (the sanctioned `pageSeatInvoke`
// pattern — real IPC, zero test hooks). The palette validation + AEAD seal into
// vault.themes is the production path; the dialog→read-file glue is covered by
// the Vitest component test `tests/components/customThemesSection.test.tsx`.
//
// Theme oracle for the custom palette: the inline `:root` CSS vars (custom
// themes apply via `documentElement.style.setProperty`, NOT a `data-theme`
// attribute — so the built-in theme oracle in prefs.e2e doesn't apply here).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  openSettings,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The Catppuccin Mocha fixture palette as a JSON string — a complete, valid
 *  theme (all required-core tokens) sealed into vault.themes via themes_import. */
const CATPPUCCIN_JSON = readFileSync(
  join(HERE, "fixtures", "themes", "catppuccin-mocha.json"),
  "utf8",
);

/** The current inline `style` attribute on `<html>` (the custom-theme CSS vars
 *  land here via `setProperty`). Fresh lookup per call — the handle goes stale
 *  across re-render. */
async function rootInlineStyle(session: Session): Promise<string> {
  const v = await (await session.findElement("html")).attribute("style").catch(() => null);
  return v ?? "";
}

describeE2E("ct1 custom-themes subsection empty state (custom-themes epic, MYND-112)", () => {
  // Vault-count precondition: 1 (weak KDF). No custom themes seeded.
  it("Settings → Appearance shows the empty state + the Import action", async () => {
    let password = "";
    await scenario(
      "ct1-custom-themes-empty",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await openSettings(s, "appearance");
        await s.byTestId("settings.custom-theme-empty");
        await s.byTestId("settings.custom-theme-import");
      },
    );
  });
});

describeE2E("ct2 vault-content custom theme lists + applies (MYND-486)", () => {
  // Vault-count precondition: 1 (weak KDF). A Catppuccin Mocha theme is sealed
  // into the unlocked vault's vault.themes store via the real themes_import IPC.
  it("an imported theme lists as a row, and Apply marks it active + paints :root", async () => {
    let password = "";
    await scenario(
      "ct2-custom-themes-apply",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Seal the theme into vault.themes via the production IPC (the vault is
        // unlocked, so themes_import validates the palette and writes MYT1).
        const imported = await pageSeatInvoke(
          s,
          "plugin:themes|themes_import",
          { name: "catppuccin-mocha", paletteJson: CATPPUCCIN_JSON },
          15_000,
        );
        if (imported.err !== undefined) {
          throw new Error("themes_import failed: " + JSON.stringify(imported.err));
        }

        await openSettings(s, "appearance");

        // The imported theme lists as a row.
        const rowSel = testIdSelector("settings.custom-theme-row", {
          "data-theme-name": "catppuccin-mocha",
        });
        const row = await s.waitForElement(rowSel);
        expect(await row.attribute("data-active")).toBe("false");

        // Apply it.
        await (await s.byTestId("settings.custom-theme-apply")).click();

        // The row flips to active, AND the Catppuccin base color paints onto
        // :root via the CSSOM apply path.
        await s.waitUntil(
          async () =>
            (await (await s.findElement(rowSel)).attribute("data-active")) === "true" || null,
          { label: "custom-theme row data-active === true" },
        );
        await s.waitUntil(async () => (await rootInlineStyle(s)).includes("#1e1e2e") || null, {
          label: ":root inline style carries the Catppuccin --paper base (#1e1e2e)",
        });
      },
    );
  });
});
