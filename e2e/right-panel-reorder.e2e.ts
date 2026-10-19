// Right-panel-tabs reorder suite (drag-to-reorder + the right-click "move" a11y
// fallback). The editor's right panel lets the user rearrange its tabs; the
// chosen order persists per-vault in vault.prefs (`right_panel_tab_order`). This
// pins the user-facing contract through the REAL editor UI via the context-menu
// move path (WebDriver cannot synthesize a native HTML5 drag reliably; the move
// action is the same persistence seam):
//
//   rp2 — right-clicking a tab opens a per-tab menu with "Move right"; invoking
//         it reorders the tab past its neighbour, the new order SURVIVES a
//         lock → unlock round-trip (disk-persisted, not transient).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  unlockToEditor,
  tabIds,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

/** Right-click the tab `tabId`, then invoke "Move left"/"Move right". */
async function moveTab(session: Session, tabId: string, dir: "left" | "right"): Promise<void> {
  await (
    await session.waitForElement(
      testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": tabId }),
    )
  ).rightClick();
  // The per-tab menu is action-mode (closeOnSelect default) — clicking the move
  // item fires it and dismisses the menu.
  await (
    await session.waitForElement(
      testIdSelector("notes.context-menu-item", {
        "data-item-id": dir === "left" ? "move-left" : "move-right",
      }),
    )
  ).click();
}

describeE2E("rp2 right-panel tab reorder persists (right-panel tabs)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("right-click 'Move right' reorders Backlinks past Unlinked mentions and the order survives lock→unlock", async () => {
    let password = "";
    await scenario(
      "rp2-right-panel-reorder",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "rp2notealfa7k2m9qx4w8e5rj0aa");

        // Baseline: Backlinks sits before Unlinked in the canonical default order.
        await s.byTestId("editor.right-panel-tabs");
        const before = await tabIds(s);
        expect(before.indexOf("backlinks")).toBeLessThan(before.indexOf("unlinked"));

        // Move Backlinks one step right → it swaps past Unlinked.
        await moveTab(s, "backlinks", "right");
        await s.waitUntil(
          async () => {
            const o = await tabIds(s);
            return o.indexOf("backlinks") > o.indexOf("unlinked") ? true : null;
          },
          { label: "backlinks moves past unlinked after move-right" },
        );

        // Persistence: lock → unlock mounts a fresh editor that reads
        // right_panel_tab_order from disk; Backlinks stays after Unlinked.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        await dismissImporterOfferIfPresent(s);
        await s.byTestId("editor.right-panel-tabs");
        const after = await tabIds(s);
        expect(after.indexOf("backlinks")).toBeGreaterThan(after.indexOf("unlinked"));
      },
    );
  });
});
