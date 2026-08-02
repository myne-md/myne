// ac-accent1 — custom accent colour (#235). Vault-count precondition: 1.
//
// Pins the Settings → Appearance accent picker against the production binary.
// The accent is a DEVICE-LOCAL preference (localStorage) but it is APPLIED live
// on pick — `set()` calls `applyAccent()`, which writes the `--accent` custom
// property onto `:root` — so the effect is observable through the real DOM:
//   - capture the theme-default `--accent`;
//   - open the picker popover and click a preset hue that differs from the
//     default → `--accent` becomes that exact hex (read back off `:root`);
//   - click the reset icon → `--accent` returns to the theme default.
//
// The preset's own `aria-label` carries its hex, so nothing is hard-coded: the
// scenario reads the target off the DOM and picks one that differs from the
// live default. `execute` reads the computed custom property (a `data-*` mirror
// would be the alternative, but the real applied value is the stronger proof).
//
// KDF: weak generator fixtures (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO — authored to the harness conventions but NOT yet validated in
// the container (this dev platform is macOS; the suite is Linux/tauri-driver
// only). Definition of done per e2e/CLAUDE.md is "green 3× consecutive" via
// ./scripts/e2e-buildrun.sh. Run ISOLATED — the full suite contaminates.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** The live value of the `--accent` custom property on `:root`, lower-cased.
 *  Read off the real applied style, not a mirror, so it proves `applyAccent`
 *  actually reached the DOM. */
async function accentVar(s: Session): Promise<string> {
  const v = await s.execute<string>(
    "return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase();",
  );
  return v ?? "";
}

describeE2E("ac-accent1 custom accent colour picker (#235)", () => {
  it("applies a picked preset to --accent and resets to the theme default", async () => {
    let seeded: SeededVault;
    await scenario(
      "ac-accent1-picker",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        const themeDefault = await accentVar(s);
        expect(themeDefault, "the theme ships a non-empty default accent").not.toBe("");

        // Open Appearance → the accent swatch → the picker popover.
        await openSettings(s, "appearance");
        await (await s.byTestId("settings.accent-color")).click();
        await s.byTestId("settings.accent-popover");

        // Pick the first preset whose hex differs from the live default.
        const presets = await s.byTestIdAll("settings.accent-preset");
        let target = "";
        let targetEl = presets[0]!;
        for (const p of presets) {
          const hex = ((await p.attribute("aria-label")) ?? "").toLowerCase();
          if (hex !== "" && hex !== themeDefault) {
            target = hex;
            targetEl = p;
            break;
          }
        }
        expect(target, "a preset hue differs from the default accent").not.toBe("");
        await targetEl.click();

        // The picked hue is applied live to `:root`.
        await s.waitUntil(async () => ((await accentVar(s)) === target ? true : null), {
          label: "--accent becomes the picked preset",
          timeoutMs: 10_000,
        });

        // Reset → back to the theme default (the reset icon shows once an accent
        // is set, beside the swatch).
        await (await s.byTestId("settings.accent-reset")).click();
        await s.waitUntil(
          async () => ((await accentVar(s)) === themeDefault ? true : null),
          { label: "--accent resets to the theme default", timeoutMs: 10_000 },
        );
      },
    );
  });
});
