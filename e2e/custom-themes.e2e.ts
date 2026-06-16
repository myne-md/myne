// Custom-themes picker suite (custom-themes epic, MYND-112). Pins the
// user-facing contract of the Settings → Appearance → Custom themes subsection
// through the real editor UI, against a real seeded theme file:
//
//   ct1 — a fresh vault (no theme files) shows the empty state + the Import /
//         Open-themes-folder actions.
//   ct2 — a Catppuccin Mocha theme seeded into app_config_dir/themes/ lists as a
//         valid row; clicking Apply marks it active AND paints its palette onto
//         `:root` (the `--paper` base color appears as an inline CSS var — the
//         CSSOM apply path, src/lib/theme.ts).
//
// The theme file is seeded with `seedCustomTheme` (writes
// `e2e/fixtures/themes/catppuccin-mocha.json` into the config-dir themes
// folder). NOT exercised here: the native "Import theme" OS file dialog
// (WebDriver can't drive it) — that path's logic is covered by the Vitest
// component test `tests/components/customThemesSection.test.tsx`.
//
// Theme oracle for the custom palette: the inline `:root` CSS vars (custom
// themes apply via `documentElement.style.setProperty`, NOT a `data-theme`
// attribute — so the built-in theme oracle in prefs.e2e doesn't apply here).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedCustomTheme, seedVault } from "./support/fixtures";
import { dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** The current inline `style` attribute on `<html>` (the custom-theme CSS vars
 *  land here via `setProperty`). Fresh lookup per call — the handle goes stale
 *  across re-render. */
async function rootInlineStyle(session: Session): Promise<string> {
  const v = await (await session.findElement("html")).attribute("style").catch(() => null);
  return v ?? "";
}

describeE2E("ct1 custom-themes subsection empty state (custom-themes epic, MYND-112)", () => {
  // Vault-count precondition: 1 (weak KDF). No theme files seeded.
  it("Settings → Appearance shows the empty state + Import + Open-folder actions", async () => {
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
        await s.byTestId("settings.custom-theme-open-folder");
      },
    );
  });
});

describeE2E("ct2 seeded custom theme lists + applies (custom-themes epic, MYND-112)", () => {
  // Vault-count precondition: 1 (weak KDF). A Catppuccin Mocha theme file is
  // seeded into the config-dir themes folder BEFORE launch.
  it("a seeded theme lists as valid, and Apply marks it active + paints :root", async () => {
    let password = "";
    await scenario(
      "ct2-custom-themes-apply",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
          seedCustomTheme(dir, "catppuccin-mocha");
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await openSettings(s, "appearance");

        // The seeded theme lists as a valid row (data-valid="true").
        const rowSel = testIdSelector("settings.custom-theme-row", {
          "data-theme-name": "catppuccin-mocha",
        });
        const row = await s.waitForElement(rowSel);
        expect(await row.attribute("data-valid")).toBe("true");
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
