// Bottom-bar-customization suite (bottom-bar right-click hide/show). The
// editor's BottomBar gains a right-click context menu that toggles the
// visibility of its individual items; the hidden set persists per-vault in
// vault.prefs (`hidden_bar_items`). This pins the user-facing contract through
// the REAL editor UI:
//
//   bb1 — right-clicking the bar opens a checkable menu; toggling "Graph" off
//         removes the graph affordance from the bar, the choice SURVIVES a
//         lock → unlock round-trip (it is disk-persisted, not transient), and
//         toggling it back on through the same menu restores the affordance.
//
// The menu reuses the shared ContextMenu primitive in its checkable-toggle mode
// (`closeOnSelect: false`), so a click flips the item and leaves the menu open;
// the test dismisses it with a neutral outside-click before asserting the bar.
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
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

/** Count of `editor.graph-button` affordances currently in the bottom bar. */
async function graphButtonCount(session: Session): Promise<number> {
  return (await session.byTestIdAll("editor.graph-button")).length;
}

/** Open the bottom-bar LIST menu (per-item visibility toggles) and return the
 *  menu item for `itemId`. The bar's affordances sit in a RIGHT cluster after a
 *  `flex:1` spacer; right-clicking the bar CENTER lands on an affordance and
 *  opens its per-item (move/hide) menu instead. Right-click the empty LEFT
 *  spacer so the bar-root `onContextMenu` (list menu) fires. */
async function openBarMenuItem(session: Session, itemId: string) {
  const bar = await session.byTestId("editor.bottom-bar");
  const r = await bar.rect();
  await bar.rightClick(-(Math.floor(r.width / 2) - 24), 0);
  return await session.waitForElement(
    testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
  );
}

/** Dismiss an open context menu via a neutral outside-click on the bar root
 *  (the ContextMenu closes on any document mousedown outside its own node). */
async function dismissBarMenu(session: Session): Promise<void> {
  await (await session.byTestId("editor.bottom-bar")).click();
}

describeE2E("bb1 bottom-bar item hide/show persists (bottom-bar customization)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("right-click hides the Graph affordance, the choice survives lock→unlock, and re-toggling restores it", async () => {
    let password = "";
    await scenario(
      "bb1-bottom-bar-visibility",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "bb1notealfa7k2m9qx4w8e5rj0aa");

        // Baseline: the Graph affordance is present in the bar.
        await s.byTestId("editor.graph-button");
        expect(await graphButtonCount(s)).toBe(1);

        // Right-click the bar → the "Graph" item shows as checked (visible).
        const graphItem = await openBarMenuItem(s, "graph");
        expect(await graphItem.attribute("data-checked")).toBe("true");

        // Toggle it off. The menu stays open (checkable-toggle mode), so close
        // it with a neutral outside-click before asserting the bar.
        await graphItem.click();
        await dismissBarMenu(s);
        await s.waitUntil(async () => ((await graphButtonCount(s)) === 0 ? true : null), {
          label: "graph affordance disappears after toggle-off",
        });

        // Persistence: lock → unlock mounts a fresh editor that reads
        // hidden_bar_items from disk; the Graph affordance stays hidden.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        // Second mount on a vault that already has notes: the importer offer's
        // dismissal persisted, so it does NOT re-appear — present-or-skip.
        await dismissImporterOfferIfPresent(s);
        await s.byTestId("editor.bottom-bar");
        expect(await graphButtonCount(s)).toBe(0);

        // The reopened menu reflects the persisted state: "Graph" is unchecked.
        const graphItemAfter = await openBarMenuItem(s, "graph");
        expect(await graphItemAfter.attribute("data-checked")).toBe("false");

        // Toggle it back on → the affordance returns to the bar.
        await graphItemAfter.click();
        await dismissBarMenu(s);
        await s.waitUntil(async () => ((await graphButtonCount(s)) === 1 ? true : null), {
          label: "graph affordance returns after toggle-on",
        });
      },
    );
  });
});
