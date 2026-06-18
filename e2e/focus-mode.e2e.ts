// Focus / distraction-free mode E2E (focus-mode / MYND-348).
//
// Pins the focus-mode flow end-to-end against the production binary:
//   fm1 — toggling focus mode (via the command palette `view.toggle-focus`
//         action) flips the editor root's `data-focus-active` attribute on, and
//         toggling again flips it off; the ephemeral state is observable through
//         that attribute (CSS keys the chrome fade on it).
//   fm2 — Settings → Editor exposes the two focus-behaviour switches
//         (`settings.focus-typewriter` / `settings.focus-dim`), both default ON;
//         toggling one flips its `aria-checked` and persists (the
//         editor_focus_typewriter / editor_focus_dim_inactive MYP1 fields).
//
// The ACTIVE focus state is ephemeral React state (not persisted to any blob);
// only the two behaviour toggles ride vault.prefs (MYP1). This drives the real
// toggle command + the disk-first persist IPC, no test hook.
//
// VERIFICATION STATUS (editor-modes-trio, 2026-06-17): authored to the harness
// conventions but NOT yet run on this dev platform (macOS; the suite is
// Linux/tauri-driver only — `pnpm test:e2e` self-skips off-platform). Definition
// of done per e2e/CLAUDE.md is "green 3× in the container"
// (./scripts/e2e-local.sh) and MUST be met before merge. Run ISOLATED per the
// full-suite-contamination note (e2e-full-suite-contamination memory).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  openSettings,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";
import { type Session } from "./support/webdriver";

/** Whether the editor root currently carries `data-focus-active="true"`. The
 *  attribute is omitted (null) when focus is off (the component renders
 *  `undefined`), so an exact "true" check is the on-signal. */
async function focusActive(s: Session): Promise<boolean> {
  return (await (await s.byTestId("editor.root")).attribute("data-focus-active")) === "true";
}

describeE2E("fm1 focus mode flips data-focus-active (focus-mode, MYND-348)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("toggling focus mode (palette) flips the editor root's data-focus-active", async () => {
    let password = "";
    await scenario(
      "fm1-focus-toggle",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // A note tab makes the editor surface (and the focus command) live.
        await createNote(s, "focus-mode");

        // Focus is off on entry — the attribute is absent.
        expect(await focusActive(s)).toBe(false);

        // Enter focus mode via the command palette (the `view.toggle-focus`
        // action — the in-focus-mode escape hatch, also bound to Mod-Shift-F).
        await runPaletteAction(s, "view.toggle-focus", "focus");
        await s.waitUntil(async () => ((await focusActive(s)) ? true : null), {
          label: "focus mode active (data-focus-active=true)",
        });

        // Toggle again → focus mode exits, the attribute drops.
        await runPaletteAction(s, "view.toggle-focus", "focus");
        await s.waitUntil(async () => (!(await focusActive(s)) ? true : null), {
          label: "focus mode exited (data-focus-active absent)",
        });
      },
    );
  });
});

describeE2E("fm2 focus-mode behaviour toggles persist (focus-mode, MYND-348)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("Settings → Editor typewriter + dim switches default ON and persist when toggled", async () => {
    let password = "";
    await scenario(
      "fm2-focus-settings",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await openSettings(s, "editor");

        // Both behaviour switches default ON (null ≡ unset → host default-on).
        const typewriter = await s.byTestId("settings.focus-typewriter");
        const dim = await s.byTestId("settings.focus-dim");
        expect(await typewriter.attribute("aria-checked")).toBe("true");
        expect(await dim.attribute("aria-checked")).toBe("true");

        // Toggle dim OFF → aria-checked flips to false.
        await dim.click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.focus-dim")).attribute("aria-checked")) === "false"
              ? true
              : null,
          { label: "dim inactive toggled off" },
        );

        // Re-open the panel → the off state survived the disk-first persist
        // (editor_focus_dim_inactive === false); typewriter stayed on.
        await (await s.byTestId("settings.tab-about")).click();
        await (await s.byTestId("settings.tab-editor")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.focus-dim")).attribute("aria-checked")) === "false"
              ? true
              : null,
          { label: "dim-off persisted across panel re-open" },
        );
        expect(
          await (await s.byTestId("settings.focus-typewriter")).attribute("aria-checked"),
        ).toBe("true");
      },
    );
  });
});
