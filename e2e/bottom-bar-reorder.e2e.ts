// Bottom-bar-reorder suite (drag-to-reorder + the right-click "move" a11y
// fallback). The editor's BottomBar lets the user rearrange its items; the
// chosen order persists per-vault in vault.prefs (`bar_items_order`). This pins
// the user-facing contract through the REAL editor UI via the context-menu move
// path (WebDriver cannot synthesize a native HTML5 drag reliably; the move
// action is the same persistence seam):
//
//   br1, the bottom bar carries NO graph affordance (myne-md/myne#727, which
//         supersedes #396's bottom-left launcher: a corner-pinned launcher is a
//         second, uncustomizable place for a command the left ribbon already
//         hosts), the graph is still reachable from the palette, and a
//         reorder of the bar's own items still SURVIVES a lock → unlock
//         round-trip (disk-persisted, not transient).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

/** The bar item ids in current DOM (display) order. */
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

describeE2E("br1 bottom-bar reorder, and no graph launcher in the bar", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the bar has no graph affordance, the palette still opens the graph, and a reorder persists", async () => {
    let password = "";
    await scenario(
      "br1-bottom-bar-reorder",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "br1notealfa7k2m9qx4w8e5rj0aa");

        // The launcher is GONE from the bar. This is the assertion the whole
        // scenario exists for: #396 asked for a bottom-left launcher, this
        // branch shipped one, and using it settled the question the other way.
        await s.byTestId("editor.bottom-bar");
        expect((await s.byTestIdAll("editor.graph-button")).length).toBe(0);
        const before = await barOrder(s);
        expect(before).not.toContain("graph");
        expect(before).toContain("tags");
        expect(before).toContain("views");

        // ... and the graph is still reachable, through the palette, which is
        // where a command nobody opens daily belongs. The ribbon can host it
        // too: `graph.show` carries ribbon metadata in `commands/actions.ts`.
        await runPaletteAction(s, "graph.show", "graph");
        await s.byTestId("editor.graph-pane", { timeoutMs: 15_000 });

        // The bar's own reorder contract is unchanged: Tags one step right
        // swaps it past Views. The bar is chrome, so it is present whichever
        // tab is active, which is why this needs no tab switching.
        await moveBarItem(s, "tags", "right");
        await s.waitUntil(
          async () => {
            const o = await barOrder(s);
            return o.indexOf("tags") > o.indexOf("views") ? true : null;
          },
          { label: "tags moves past views after move-right" },
        );

        // Persistence: lock → unlock mounts a fresh editor that reads
        // bar_items_order from disk; Tags stays after Views, and the graph
        // launcher does not reappear.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        // Second editor mount on a vault that already has notes: the importer
        // offer does NOT re-appear (its dismissal persisted), so a hard dismiss
        // would time out — use the present-or-skip variant.
        await dismissImporterOfferIfPresent(s);
        await s.byTestId("editor.bottom-bar");
        const after = await barOrder(s);
        expect(after.indexOf("tags")).toBeGreaterThan(after.indexOf("views"));
        expect(after).not.toContain("graph");
        expect((await s.byTestIdAll("editor.graph-button")).length).toBe(0);
      },
    );
  });
});
