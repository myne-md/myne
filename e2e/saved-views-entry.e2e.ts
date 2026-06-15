// Saved Views entry-surface E2E (Saved Views #4 / MYND-274).
//
// Pins the views sidebar flow end-to-end against the production binary: create a
// view from the "Views" section header → it appears as a row AND opens as a
// view tab → rename it via the row context menu → create a second view, reorder
// (move up/down) and assert the sequence swaps → delete a view and assert it
// leaves the list. Saved views persist in vault.prefs (MYP1) via the prefs
// plugin; this drives the real upsert/delete/set_view_order IPC, no test hook.
//
// VERIFICATION STATUS (Saved Views #4, 2026-06-15): authored to the harness
// conventions but NOT yet run on this dev platform (macOS; the suite is
// Linux/tauri-driver only — `pnpm test:e2e` self-skips off-platform). Definition
// of done per e2e/CLAUDE.md is "green 3× in the container" (./scripts/e2e-local.sh)
// and MUST be met before merge. The ".base import" leg is omitted (its action is
// disabled until the importer lands, MYND-276). Run ISOLATED per the
// full-suite-contamination note (e2e-full-suite-contamination memory).

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, unlockToEditor } from "./support/flows";
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

        // The Views section exists (empty hint at zero views).
        await s.byTestId("views.section");
        await s.byTestId("views.empty");

        // Create a view → it opens as a view tab AND appears as a sidebar row.
        await (await s.byTestId("views.new-button")).click();
        await s.byTestId("editor.view-host"); // the new view opened as a tab
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

        // Create a second view → two rows.
        await (await s.byTestId("views.new-button")).click();
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

        // Open a view by clicking its row → a view-host tab is shown.
        await (await s.byTestId("views.row")).click();
        await s.byTestId("editor.view-host");

        // Delete one view → the list drops to a single row.
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
