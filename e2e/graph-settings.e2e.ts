// Graph settings panel suite (graph-connection-ux-polish task 5) — the gear
// button in the graph pane opens a panel that FLOATS over the canvas (never
// resizing it, since a canvas-size change would re-run the layout and
// re-jumble the graph — the flashbang the warm-start layout work exists to
// prevent), with one working control (edge-direction arrows), a
// reset-to-defaults action, and device-local persistence in `vault.workspace`.
//
//   gs1 — open the gear: the panel appears WITHOUT changing the canvas's own
//         dimensions and WITHOUT bumping `data-layout-nonce` (the pane's
//         existing flashbang-free observability — `graph-layout-persistence
//         .e2e.ts` gp2's proof, reused here for "did opening settings re-run
//         the layout"); toggling the arrows switch flips its `aria-checked`
//         immediately, with NO layout re-run either (appearance-only); after a
//         lock → re-unlock remount, the graph pane + settings panel reopen
//         with the toggle still off (device-local persistence survived
//         restart); Reset restores the default (arrows back on).
//
// Why data-*/aria-* not canvas pixels: same reasoning as
// `graph-layout-persistence.e2e.ts` — the graph body is a force-laid-out
// <canvas>, so positions/appearance aren't in the DOM. The arrows toggle's own
// `aria-checked` and the pane's `data-layout-nonce` are the bounded,
// DENY-list-clean observability this scenario needs.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, lockAndReunlock, unlockToEditor } from "./support/flows";
import { type Session } from "./support/webdriver";

// Distinct note titles so the graph has nodes to lay out.
const TITLES = ["gs1notealfa7k2m9qx4w8e5rj0aa", "gs1notebravo3f6h1zn8c2vb5kk0"];

/** Open the whole-vault graph via the BottomBar affordance and return the pane
 *  element once it renders (mirrors `graph-layout-persistence.e2e.ts`). */
async function openGraph(s: Session) {
  await (await s.byTestId("editor.graph-button")).click();
  return await s.byTestId("editor.graph-pane", { timeoutMs: 15_000 });
}

/** Click the gear and return the now-open settings panel. */
async function openSettingsPanel(s: Session) {
  await (await s.byTestId("editor.graph-settings-gear")).click();
  return await s.byTestId("editor.graph-settings-panel");
}

describeE2E("gs1 graph settings panel — floats, no-relayout, toggles live, persists, resets", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("opens over the canvas without resizing/relayout, persists the toggle, and resets", async () => {
    let password = "";
    await scenario(
      "gs1-graph-settings-panel",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        for (const t of TITLES) await createNote(s, t);

        const pane = await openGraph(s);
        // Let the layout settle before probing "did it re-run" — gp2's wait.
        await s.waitUntil(
          async () => ((await pane.attribute("data-layout-nonce")) === "1" ? true : null),
          { label: "graph builds once", timeoutMs: 15_000 },
        );

        const canvas = await s.waitForElement("canvas");
        const rectBefore = await canvas.rect();

        await openSettingsPanel(s);

        // Floats over the canvas: no dimension change, no layout re-run.
        const rectAfter = await canvas.rect();
        expect(rectAfter.width).toBe(rectBefore.width);
        expect(rectAfter.height).toBe(rectBefore.height);
        expect(await pane.attribute("data-layout-nonce")).toBe("1");

        // Toggling arrows flips the switch live, with no re-layout either
        // (an appearance-only change per the PRD's render-time-layer rule).
        const toggle = await s.byTestId("editor.graph-settings-arrows-toggle");
        expect(await toggle.attribute("aria-checked")).toBe("true"); // default: arrows on
        await toggle.click();
        await s.waitUntil(
          async () => ((await toggle.attribute("aria-checked")) === "false" ? true : null),
          { label: "arrows toggle flips off" },
        );
        expect(await pane.attribute("data-layout-nonce")).toBe("1");

        // Persistence: lock (flushes the staged workspace descriptor) → re-unlock.
        await lockAndReunlock(s, password);
        await openGraph(s);
        await openSettingsPanel(s);
        const toggle2 = await s.byTestId("editor.graph-settings-arrows-toggle");
        expect(await toggle2.attribute("aria-checked")).toBe("false");

        // Reset restores every control to its default (arrows back on).
        await (await s.byTestId("editor.graph-settings-reset")).click();
        await s.waitUntil(
          async () => ((await toggle2.attribute("aria-checked")) === "true" ? true : null),
          { label: "reset restores default" },
        );
      },
    );
  });
});
