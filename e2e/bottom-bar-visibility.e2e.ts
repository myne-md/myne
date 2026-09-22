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

/** How many bottom-bar items carry `itemId`. The item under test is Tags: the
 *  graph affordance left the bar when the left ribbon shipped (myne-md/myne#727,
 *  which supersedes #396's bottom-left launcher), and the hide/show contract
 *  needs an item that is still in it. */
async function barItemCount(session: Session, itemId: string): Promise<number> {
  return (
    await session.findElements(
      testIdSelector("editor.bar-item", { "data-bar-item-id": itemId }),
    )
  ).length;
}

/** Open the bottom-bar LIST menu (per-item visibility toggles) and return the
 *  menu item for `itemId`. The menu belongs to the bar ROOT, and every place a
 *  right-click could land other than the empty middle belongs to something
 *  else: the graph launcher used to live in a left cluster (myne-md/myne#396),
 *  which myne-md/myne#727 removed entirely; the
 *  right cluster is full of affordances, each of which opens its OWN menu. So
 *  the click targets the flexible spacer by testid rather than guessing an
 *  offset from the bar's centre. */
async function openBarMenuItem(session: Session, itemId: string) {
  await (await session.byTestId("editor.bar-spacer")).rightClick();
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

        // Baseline: the Tags affordance is present in the bar.
        await s.byTestId("editor.tags-cta");
        expect(await barItemCount(s, "tags")).toBe(1);

        // Right-click the bar → the "Tags" item shows as checked (visible).
        const tagsItem = await openBarMenuItem(s, "tags");
        expect(await tagsItem.attribute("data-checked")).toBe("true");

        // Toggle it off. The menu stays open (checkable-toggle mode), so close
        // it with a neutral outside-click before asserting the bar.
        await tagsItem.click();
        await dismissBarMenu(s);
        await s.waitUntil(async () => ((await barItemCount(s, "tags")) === 0 ? true : null), {
          label: "tags affordance disappears after toggle-off",
        });

        // Persistence: lock → unlock mounts a fresh editor that reads
        // hidden_bar_items from disk; the Tags affordance stays hidden.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        // Second mount on a vault that already has notes: the importer offer's
        // dismissal persisted, so it does NOT re-appear — present-or-skip.
        await dismissImporterOfferIfPresent(s);
        await s.byTestId("editor.bottom-bar");
        expect(await barItemCount(s, "tags")).toBe(0);

        // The reopened menu reflects the persisted state: "Tags" is unchecked.
        const tagsItemAfter = await openBarMenuItem(s, "tags");
        expect(await tagsItemAfter.attribute("data-checked")).toBe("false");

        // Toggle it back on → the affordance returns to the bar.
        await tagsItemAfter.click();
        await dismissBarMenu(s);
        await s.waitUntil(async () => ((await barItemCount(s, "tags")) === 1 ? true : null), {
          label: "tags affordance returns after toggle-on",
        });
      },
    );
  });
});

// bb2 — myne-md/myne#557's `workspace.bottom-bar` / `sidebar.notes-and-folders`
// bullet.
//
// # What the roster row asked, and what it could not distinguish
//
// "Right-click a sidebar note row and confirm the platform's own menu does not
// appear on top of Myne's." On WebKitGTK that observation is worthless, for the
// same reason it is worthless for the spell squiggle (SP-5): the engine offers
// no native context menu there at all, so "no native menu appeared" is true
// whether or not the app asked for it. The reviewer on the container seat and
// the reviewer on macOS are answering two different questions and reporting the
// same word.
//
// # What is assertable everywhere
//
// Suppression IS `preventDefault()` on the `contextmenu` event, and
// `dispatchEvent` returns `false` exactly when a cancelable event was
// prevented. So the app's decision is readable from inside the page, on any
// engine, independent of what the host would have drawn — and it is the same
// decision on every platform, because it is one React handler.
//
// Two-finger tap and Control-click arrive as the same `contextmenu` event, so
// this covers the trackpad and the mouse gesture at once. What it does NOT
// cover is whether the OS honours the prevention, which is the platform's
// contract rather than Myne's.
describeE2E("bb2 a sidebar row's context menu replaces the platform's (myne-md/myne#557)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("prevents the contextmenu on a note row and opens Myne's own menu", async () => {
    let password = "";
    await scenario(
      "bb2-row-contextmenu",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Baglam Menusu Notu");

        // Dispatch a real cancelable contextmenu at the row's own centre.
        // Coordinates matter: the handler forwards `clientX`/`clientY` to place
        // the menu, and a 0,0 event would place it off the row even where the
        // prevention itself does not depend on them (SP-5 learned this the
        // expensive way).
        const prevented = await s.execute<boolean | null>(
          "var el = document.querySelector('[data-testid=\"notes.row\"]');" +
            "if (!el) return null;" +
            "var r = el.getBoundingClientRect();" +
            "var ev = new MouseEvent('contextmenu', {" +
            "  bubbles: true, cancelable: true," +
            "  clientX: Math.round(r.left + r.width / 2)," +
            "  clientY: Math.round(r.top + r.height / 2)" +
            "});" +
            "return el.dispatchEvent(ev) === false;",
        );

        expect(prevented, "no sidebar note row to dispatch on").not.toBeNull();
        expect(
          prevented,
          "the contextmenu was NOT prevented on a note row, so on a seat with a " +
            "native menu the platform's would open instead of (or on top of) " +
            "Myne's row menu",
        ).toBe(true);

        // …and the prevention was in service of the ROW's menu, not just of
        // something. Two corrections are folded into this assertion, and both
        // came from injecting the defect:
        //
        //  1. Deleting the row's own `preventDefault()` did NOT fail an earlier
        //     draft, because `NoteList.tsx`'s background handler prevents any
        //     contextmenu a row did not (`if (e.defaultPrevented) return`). So
        //     "was it prevented" alone cannot tell the row's menu from the
        //     sidebar's — the sidebar covers for the row.
        //  2. The distinguishing fact is WHICH menu opened. `open-in-new-tab`
        //     is a note action; the background menu (new note, new folder) has
        //     no such item, so its presence is the row menu and nothing else.
        await s.waitForElement(
          testIdSelector("notes.context-menu-item", { "data-item-id": "open-in-new-tab" }),
          { timeoutMs: 10_000 },
        );
      },
    );
  });
});
