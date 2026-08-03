// Saved Views entry-surface E2E (Saved Views #4 / MYND-274).
//
// Pins the views sidebar flow end-to-end against the production binary. Views is
// now a compact nav ROW whose list lives in a right-FLYOUT (opened by clicking
// the row): open the flyout → empty hint → create a view from its "+" (this
// closes the flyout + opens the filter builder) → re-open → it is a row AND the
// view opened as a tab → rename via the row context menu → create a second view,
// reorder (move up/down) and assert the sequence swaps → delete a view and
// assert it leaves the list. Saved views persist in vault.prefs (MYP1) via the
// prefs plugin; this drives the real upsert/delete/set_view_order IPC, no hook.
//
// VERIFICATION STATUS: authored to the harness conventions but NOT yet run on
// this dev platform (macOS; the suite is Linux/tauri-driver only — `pnpm
// test:e2e` self-skips off-platform). UPDATED for the Views flyout redesign
// (nav row + searchable right-flyout, replacing the inline expandable section)
// AND for the device-local Views feature toggle (#230): a fresh vault has 0
// views, so the entry is HIDDEN by default and sv1 must enable it via Settings →
// Editor before the flyout steps. sv2 pins that toggle's visibility contract on
// its own. These steps are unverified against real WebKit. Definition of done
// per e2e/CLAUDE.md is "green 3× in the container" (./scripts/e2e-local.sh) and
// MUST be met before merge. The ".base import" leg is omitted (its action is
// disabled until the importer lands, MYND-276). Run ISOLATED per the
// full-suite-contamination note (e2e-full-suite-contamination memory).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, setViewsEnabled, unlockToEditor } from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Explicit WebDriver Enter key (U+E007) — named so it is VISIBLE in source
 *  rather than hidden inside a string literal (e2e-invisible-U+E007 hazard). */
const ENTER = String.fromCharCode(0xe007);

/** Current view-row labels in display order. The row nests its name in a child
 *  `<span>`, and this driver's W3C getText drops nested-child text — use
 *  `textContent()` per the webdriver.ts guidance. */
async function viewRowLabels(s: Session): Promise<string[]> {
  const rows = await s.byTestIdAll("views.row");
  return Promise.all(rows.map((r) => r.textContent()));
}

/** Right-click the view row whose visible label is `label`, opening its menu.
 *  Uses `textContent()` (the label is in a nested span the W3C getText drops). */
async function openRowMenu(s: Session, label: string): Promise<void> {
  const rows = await s.byTestIdAll("views.row");
  for (const r of rows) {
    if ((await r.textContent()).includes(label)) {
      await r.rightClick();
      return;
    }
  }
  throw new Error(`no views.row labelled "${label}"`);
}

describeE2E("sv1 views sidebar create / open / rename / reorder / delete (MYND-274)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("creates, opens, renames, reorders and deletes a saved view", async () => {
    let password = "";
    await scenario(
      "sv1-views-entry",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // A fresh vault has 0 views, so the feature toggle's back-compat default
        // (#230) leaves the Views entry HIDDEN. Turn it on via Settings → Editor
        // so the nav row exists to drive the rest of this flow.
        await setViewsEnabled(s, true);

        // Views is a compact nav ROW; its list lives in a right-flyout opened by
        // clicking the row. Open it → empty-state hint (zero views).
        await s.byTestId("views.section");
        await (await s.byTestId("views.section")).click();
        await s.byTestId("views.flyout");
        await s.byTestId("views.empty");

        // Create a view from the flyout's create (+) button (visible while the
        // flyout is open). "+ New view" closes the flyout and opens the filter
        // builder empty (MYND-282); saving with no conditions creates an
        // all-pages view that opens as a tab.
        await (await s.byTestId("views.new-button")).click();
        await (await s.byTestId("view-filter.save")).click();
        await s.waitForGone(testIdSelector("view-filter.modal"));
        await s.byTestId("editor.view-host"); // the new view opened as a tab
        // Re-open the flyout → the new view is a row.
        await (await s.byTestId("views.section")).click();
        await s.waitUntil(
          async () => ((await s.byTestIdAll("views.row")).length === 1 ? true : null),
          { label: "first view row appears" },
        );

        // Rename it via the row context menu. Use replaceText (W3C backspaces
        // over the current value, defeating React's value-tracker no-op-clear)
        // + a SEPARATE Enter — the robust pattern (attachments-library al1);
        // a single sendKeys relying on onFocus-select can append, not replace.
        await openRowMenu(s, "New view");
        await (
          await s.waitForElement(
            testIdSelector("notes.context-menu-item", { "data-item-id": "rename" }),
          )
        ).click();
        const renameInput = await s.byTestId("views.rename-input");
        // Lowercase rename target: WebKitWebDriver's Send Keys does NOT apply the
        // shift modifier, so an uppercase char arrives lowercased — assert a value
        // the driver types faithfully (a real user's keyboard has Shift; this is a
        // driver-only limitation, not a product one).
        await renameInput.replaceText("reading");
        await renameInput.sendKeys(ENTER); // explicit Enter commits the rename
        await s.waitUntil(
          async () =>
            (await viewRowLabels(s)).some((l) => l.includes("reading")) ? true : null,
          { label: "row renamed to reading" },
        );

        // Create a second view → two rows (builder opens empty, save creates it).
        // The create (+) click closes the flyout, so re-open it after the save.
        await (await s.byTestId("views.new-button")).click();
        await (await s.byTestId("view-filter.save")).click();
        await s.waitForGone(testIdSelector("view-filter.modal"));
        await (await s.byTestId("views.section")).click();
        await s.waitUntil(
          async () => ((await s.byTestIdAll("views.row")).length === 2 ? true : null),
          { label: "second view row appears" },
        );

        // Reorder: move the FIRST row down → the first two labels swap.
        const before = await viewRowLabels(s);
        await openRowMenu(s, before[0]!);
        await (
          await s.waitForElement(
            testIdSelector("notes.context-menu-item", { "data-item-id": "move-down" }),
          )
        ).click();
        await s.waitUntil(async () => {
          const after = await viewRowLabels(s);
          return after[0] === before[1] && after[1] === before[0] ? true : null;
        }, { label: "move-down swaps the first two rows" });

        // Open a view by clicking its flyout row → a view-host tab is shown and
        // the flyout closes.
        await (await s.byTestId("views.row")).click();
        await s.byTestId("editor.view-host");

        // Delete one view → the list drops to a single row. Re-open the flyout
        // first (clicking a row above closed it).
        await (await s.byTestId("views.section")).click();
        const labels = await viewRowLabels(s);
        await openRowMenu(s, labels[0]!);
        await (
          await s.waitForElement(
            testIdSelector("notes.context-menu-item", { "data-item-id": "delete" }),
          )
        ).click();
        await s.waitUntil(
          async () => ((await s.byTestIdAll("views.row")).length === 1 ? true : null),
          { label: "one view remains after delete" },
        );
      },
    );
  });
});

describeE2E("sv2 Views feature toggle gates the sidebar entry (#230)", () => {
  // Vault-count precondition: 1 (weak KDF). A fresh vault has 0 saved views, so
  // the device-local Views toggle's back-compat default is OFF and the sidebar
  // Views nav row must be ABSENT until the user turns it on — then absent again
  // when turned back off (hidden, not disabled).
  it("hides the Views entry by default and shows it once enabled", async () => {
    let password = "";
    await scenario(
      "sv2-views-toggle",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Anchor on a known sidebar control first, so "Views absent" is asserted
        // against a MOUNTED sidebar, not a race where nothing has rendered yet.
        //
        // #275: the `+` menu BUTTON, not one of its entries. #230 folded the
        // new-note control into that menu, so `notes.create` renders only while
        // the dropdown is open — waiting for it here waits for something that
        // is not on screen, and the anchor that was meant to remove a race
        // became a timeout.
        await s.byTestId("notes.new-menu");

        // Default: 0 views + untouched pref → the entry is hidden.
        expect(
          (await s.byTestIdAll("views.section")).length,
          "Views entry is hidden by default on a fresh vault",
        ).toBe(0);

        // Enable via Settings → Editor → the nav row appears.
        await setViewsEnabled(s, true);
        await s.waitForElement(testIdSelector("views.section"));

        // Disable again → the row is gone (hidden, not merely inert).
        await setViewsEnabled(s, false);
        await s.waitForGone(testIdSelector("views.section"));
      },
    );
  });
});
