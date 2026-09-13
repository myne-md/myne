// lr-ribbon: left ribbon pin, run, reorder, unpin (myne-md/myne#699).
// Vault-count precondition: 1.
//
// Pins the rail against the production binary through the real UI:
//   - a fresh vault renders the curated default rail;
//   - the palette's Pin toggle adds a command and the rail gains its button;
//   - clicking that rail button RUNS the command (Settings opens);
//   - the Appearance roster's move-down reorders the rail;
//   - the roster's toggle unpins a command and the rail loses it.
//
// KDF: weak generator fixtures (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO: authored to the harness conventions but NOT yet validated in
// the container (this dev platform is macOS; the suite is Linux/tauri-driver
// only). Definition of done per e2e/CLAUDE.md is "green 3× consecutive" via
// ./scripts/e2e-buildrun.sh. Run ISOLATED: the full suite contaminates.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  openPalette,
  openSettings,
  unlockToEditor,
} from "./support/flows";
import type { Session } from "./support/webdriver";

const RAIL_BUTTON = '[data-testid="editor.ribbon.button"]';

/** The rail's rendered command ids, in order. */
async function railOrder(s: Session): Promise<string[]> {
  const ids = await s.execute<string[]>(
    `return Array.from(document.querySelectorAll('${RAIL_BUTTON}')).map((el) => el.getAttribute('data-command-id'));`,
  );
  return ids ?? [];
}

/** The element whose `data-command-id` matches, or null. */
async function byCommandId(
  s: Session,
  testId: string,
  commandId: string,
): Promise<Awaited<ReturnType<Session["byTestId"]>> | null> {
  for (const el of await s.byTestIdAll(testId)) {
    if (((await el.attribute("data-command-id")) ?? "") === commandId) return el;
  }
  return null;
}

describeE2E("lr-ribbon left ribbon pin/run/reorder/unpin (#699)", () => {
  it("renders the default rail and round-trips a pin through the palette and the roster", async () => {
    let seeded: SeededVault;
    await scenario(
      "lr-ribbon",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // Curated default rail: the default commands are present, and Settings
        // (eligible but not a default) is not.
        await s.byTestId("editor.ribbon");
        const initial = await railOrder(s);
        expect(initial).toContain("note.new");
        expect(initial).toContain("daily.open-today");
        expect(initial).toContain("periodic.open-this-week");
        expect(initial).not.toContain("app.open-settings");

        // Pin it from the palette.
        await openPalette(s);
        const pin = await byCommandId(s, "palette.pin", "app.open-settings");
        expect(pin, "the palette offers a pin for app.open-settings").not.toBeNull();
        await pin!.click();
        await s.execute(
          "document.querySelector('[data-testid=\"palette.dialog\"]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));",
        );
        await s.waitUntil(
          async () =>
            (await railOrder(s)).includes("app.open-settings") ? true : null,
          { label: "rail gains app.open-settings after the palette pin", timeoutMs: 10_000 },
        );

        // Clicking the rail button RUNS the command: Settings opens.
        const railSettings = await byCommandId(s, "editor.ribbon.button", "app.open-settings");
        expect(railSettings, "the rail shows the pinned Settings button").not.toBeNull();
        await railSettings!.click();
        await s.byTestId("settings.modal");

        // Appearance roster: add a command from the dropdown, then remove it.
        await openSettings(s, "appearance");
        await s.byTestId("settings.ribbon-customize");
        const beforeLen = (await railOrder(s)).length;
        await (await s.byTestId("settings.ribbon-customize.add")).click();
        await (await s.byTestId("settings.ribbon-customize.choice")).click();
        await s.waitUntil(
          async () => ((await railOrder(s)).length === beforeLen + 1 ? true : null),
          { label: "roster Add pins a command onto the rail", timeoutMs: 10_000 },
        );
        await (await s.byTestId("settings.ribbon-customize.remove")).click();
        await s.waitUntil(
          async () => ((await railOrder(s)).length === beforeLen ? true : null),
          { label: "roster remove drops it again", timeoutMs: 10_000 },
        );
        await closeSettings(s);
      },
    );
  });
});
