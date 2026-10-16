// bbe-empty: the bottom bar disappears when every item is hidden, and comes
// back from Settings (myne-md/myne#773, epic #772).
// Vault-count precondition: 1.
//
// Two halves, and the second is the one that matters. Hiding all nine items
// must remove the bar itself rather than leave an empty 28px strip with a
// hairline under the editor. And because the right-click menu that un-hides an
// item LIVES on that bar, removing the bar removes the only route back unless a
// second one exists — so this also drives Settings -> Appearance -> Bottom bar,
// which is the restore path that makes the disappearance safe to ship at all.
//
// KDF: weak generator fixtures (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO: authored to the harness conventions but NOT yet validated in
// the container (this dev platform is macOS; the suite is Linux/tauri-driver
// only). Definition of done per e2e/AGENTS.md is "green 3× consecutive" via
// ./scripts/e2e-buildrun.sh. Run ISOLATED: the full suite contaminates.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  openSettings,
  selectSettingsTopic,
  unlockToEditor,
} from "./support/flows";
import type { Session } from "./support/webdriver";

/** The nine toggleable ids, in `BAR_ITEMS` order (src/notes/barItemsOrder.ts). */
const BAR_ITEM_IDS = [
  "save-status",
  "view-mode",
  "workspace",
  "tags",
  "views",
  "settings",
  "lock",
  "vim-mode",
  "word-count",
] as const;

async function barExists(s: Session): Promise<boolean> {
  const n = await s.execute<number>(
    `return document.querySelectorAll('[data-testid="editor.bottom-bar"]').length;`,
  );
  return (n ?? 0) > 0;
}

describeE2E("BBE-1 the bottom bar is removed when nothing is left on it", () => {
  it("hides every item from Settings, then restores one", async () => {
    let seeded: SeededVault;
    await scenario(
      "bbe1-empty",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        expect(
          await barExists(s),
          "the bar is present on a fresh vault, with its default items",
        ).toBe(true);

        // Appearance is the panel that owns the bar-customization block.
        await openSettings(s, "appearance");
        // The bar roster lives in Appearance's `interface` topic since
        // myne-md/myne#885; only the active topic's body is mounted.
        await selectSettingsTopic(s, "appearance", "interface");
        for (const id of BAR_ITEM_IDS) {
          const toggle = await s.byTestId(`settings.bar-item-toggle.${id}`);
          // The switch publishes its own state, so this is idempotent: turn OFF
          // only what is currently on, rather than blind-clicking nine times and
          // depending on the seeded defaults being exactly the full set.
          if ((await toggle.attribute("aria-checked")) === "true") {
            await toggle.click();
          }
        }
        await closeSettings(s);

        expect(
          await barExists(s),
          "with all nine hidden the bar must be GONE, not an empty strip",
        ).toBe(false);

        // The restore path, and it is the half that matters. The bar's own
        // right-click menu is unreachable now, so if Settings could not bring an
        // item back the setting would be a one-way door.
        await openSettings(s, "appearance");
        // The reopen is a fresh mount, so the `interface` topic is selected
        // again (myne-md/myne#885).
        await selectSettingsTopic(s, "appearance", "interface");
        await (await s.byTestId("settings.bar-item-toggle.lock")).click();
        await closeSettings(s);

        expect(
          await barExists(s),
          "restoring a single item from Settings brings the bar back",
        ).toBe(true);
      },
    );
  });
});
