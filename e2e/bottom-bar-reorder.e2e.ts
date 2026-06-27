// Bottom-bar-reorder suite (drag-to-reorder + the right-click "move" a11y
// fallback). The editor's BottomBar lets the user rearrange its right-cluster
// items; the chosen order persists per-vault in vault.prefs
// (`bar_items_order`). This pins the user-facing contract through the REAL
// editor UI via the context-menu move path (WebDriver cannot synthesize a
// native HTML5 drag reliably; the move action is the same persistence seam):
//
//   br1 — right-clicking a bar item opens a per-item menu with "Move right";
//         invoking it reorders the item past its neighbour, the new order
//         SURVIVES a lock → unlock round-trip (disk-persisted, not transient).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, unlockToEditor } from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

/** The right-cluster bar item ids in current DOM (display) order. */
async function barOrder(session: Session): Promise<string[]> {
  const els = await session.byTestIdAll("editor.bar-item");
  const ids = await Promise.all(els.map((e) => e.attribute("data-bar-item-id")));
  return ids.filter((id): id is string => id !== null);
}

/** Right-click the bar item `itemId`, then invoke "Move left"/"Move right". */
async function moveBarItem(
  session: Session,
  itemId: string,
  dir: "left" | "right",
): Promise<void> {
  await (
    await session.waitForElement(
      testIdSelector("editor.bar-item", { "data-bar-item-id": itemId }),
    )
  ).rightClick();
  // The per-item menu is action-mode (closeOnSelect default) — clicking the
  // move item fires it and dismisses the menu.
  await (
    await session.waitForElement(
      testIdSelector("notes.context-menu-item", {
        "data-item-id": dir === "left" ? "move-left" : "move-right",
      }),
    )
  ).click();
}

describeE2E("br1 bottom-bar item reorder persists (bottom-bar customization)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("right-click 'Move right' reorders the Graph affordance past Settings and the order survives lock→unlock", async () => {
    let password = "";
    await scenario(
      "br1-bottom-bar-reorder",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "br1notealfa7k2m9qx4w8e5rj0aa");

        // Baseline: Graph sits before Settings in the canonical default order.
        await s.byTestId("editor.graph-button");
        const before = await barOrder(s);
        expect(before).toContain("graph");
        expect(before).toContain("settings");
        expect(before.indexOf("graph")).toBeLessThan(before.indexOf("settings"));

        // Move Graph one step right → it swaps past Settings.
        await moveBarItem(s, "graph", "right");
        await s.waitUntil(
          async () => {
            const o = await barOrder(s);
            return o.indexOf("graph") > o.indexOf("settings") ? true : null;
          },
          { label: "graph moves past settings after move-right" },
        );

        // Persistence: lock → unlock mounts a fresh editor that reads
        // bar_items_order from disk; Graph stays after Settings.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await s.byTestId("editor.bottom-bar");
        const after = await barOrder(s);
        expect(after.indexOf("graph")).toBeGreaterThan(after.indexOf("settings"));
      },
    );
  });
});
