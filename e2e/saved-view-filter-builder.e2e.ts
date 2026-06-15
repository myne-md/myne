// Saved-view filter builder E2E (Saved Views #4 / MYND-282).
//
// Pins the builder's structural flow end-to-end against the production binary:
// "+ New view" opens the builder empty (no blank view created up front) → saving
// with no conditions creates an all-pages view that opens as a tab AND appears as
// a sidebar row (the prior "+ New view" behavior, now the empty case) → the row's
// "Edit filter…" context action reopens the builder → Cancel dismisses it. Drives
// the real `upsert_saved_view` IPC via the prefs plugin, no test hook.
//
// The condition pickers/toggles use the app's custom `SearchableSelect` (same as
// the settings dropdowns), so they ARE driver-operable: click the `${testId}`
// trigger, then the `${testId}-option[data-value=…]` row — exactly the
// settings.auto-lock-select pattern. vf1 pins the structural flow (create /
// empty-save / edit-entry / cancel); vf2 pins condition composition (add a
// condition, switch its type via the dropdown, type a search value, save).
//
// VERIFICATION STATUS (2026-06-15): authored to the harness conventions but NOT
// yet run on this dev platform (macOS; the suite is Linux/tauri-driver only —
// `pnpm test:e2e` self-skips off-platform). Definition of done per e2e/CLAUDE.md
// is "green 3× in the container" (./scripts/e2e-local.sh) and MUST be met before
// merge. Run ISOLATED per the full-suite-contamination note.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Pick `value` from a custom `SearchableSelect` (testId `root`): open the
 *  trigger, then click the matching `${root}-option`. Mirrors the
 *  settings.auto-lock-select driving pattern. */
async function pickSelectOption(
  s: Session,
  root: string,
  value: string,
): Promise<void> {
  await (await s.byTestId(root)).click();
  await (
    await s.waitForElement(
      testIdSelector(`${root}-option`, { "data-value": value }),
    )
  ).click();
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

describeE2E("vf1 filter builder create / empty-save / edit-entry / cancel (MYND-282)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("opens the builder from + New view, saves an all-pages view, and reopens it to edit", async () => {
    let password = "";
    await scenario(
      "vf1-filter-builder",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // The Views section starts empty.
        await s.byTestId("views.section");
        await s.byTestId("views.empty");

        // "+ New view" opens the builder EMPTY — it no longer creates a blank
        // view immediately (the old behavior). The empty-state hint shows.
        await (await s.byTestId("views.new-button")).click();
        await s.byTestId("view-filter.modal");
        await s.byTestId("view-filter.empty");

        // Save with no conditions → an all-pages view is created, opens as a tab,
        // and appears as a sidebar row (no app restart — real upsert IPC + the
        // prefs-nonce refresh).
        await (await s.byTestId("view-filter.save")).click();
        await s.waitForGone(testIdSelector("view-filter.modal"));
        await s.byTestId("editor.view-host");
        await s.waitUntil(
          async () => ((await s.byTestIdAll("views.row")).length === 1 ? true : null),
          { label: "saved view appears in the sidebar" },
        );

        // "Edit filter…" on the row reopens the builder seeded with that view.
        await openRowMenu(s, "New view");
        await (
          await s.waitForElement(
            testIdSelector("notes.context-menu-item", { "data-item-id": "edit-filter" }),
          )
        ).click();
        await s.byTestId("view-filter.modal");

        // Cancel dismisses without persisting.
        await (await s.byTestId("view-filter.cancel")).click();
        await s.waitForGone(testIdSelector("view-filter.modal"));
      },
    );
  });
});

describeE2E("vf2 filter builder condition composition (MYND-282)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("adds a search condition via the custom dropdown and saves a filtered view", async () => {
    // A distinctive token so the search condition has a real hit (single
    // lowercase-alnum, tokenizer-survivable).
    const TOKEN = " zxcvqwertasdfghjkl";
    let password = "";
    await scenario(
      "vf2-condition-compose",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // One note carrying the token in its body, so the search filter matches.
        await createNote(s, "Hit Note");
        await typeIntoEditor(s, TOKEN);
        await waitForSaved(s);

        // Open the builder and add the first condition (defaults to a tag).
        await (await s.byTestId("views.new-button")).click();
        await s.byTestId("view-filter.modal");
        await (await s.byTestId("view-filter.add-condition-first")).click();
        await s.byTestId("view-filter.condition");

        // Switch the condition type to "search" via the custom dropdown, then
        // type the token into the (now text) value field.
        await pickSelectOption(s, "view-filter.condition-type", "search");
        await (await s.byTestId("view-filter.condition-value")).sendKeys(TOKEN.trim());

        // The live count surfaces (a read-only projection — proves the draft
        // evaluates), and Save persists the filtered view as a tab + sidebar row.
        await s.byTestId("view-filter.count");
        await (await s.byTestId("view-filter.save")).click();
        await s.waitForGone(testIdSelector("view-filter.modal"));
        await s.byTestId("editor.view-host");
        await s.waitUntil(
          async () => ((await s.byTestIdAll("views.row")).length === 1 ? true : null),
          { label: "filtered view appears in the sidebar" },
        );
      },
    );
  });
});
