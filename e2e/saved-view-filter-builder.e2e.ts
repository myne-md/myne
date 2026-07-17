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
// condition, switch its type via the dropdown, type a search value, save);
// vf3 pins the property condition (key picked from the vault-indices key list,
// operator dropdown, free-text value, live count through the property resolver,
// and the edit round-trip that proves a property view is no longer read-only).
//
// VERIFICATION STATUS (2026-07-16): vf1+vf2+vf3 green 3× consecutive in the
// container (single-file isolated runs, fresh production build) — the
// e2e/CLAUDE.md definition of done. Run ISOLATED per the
// full-suite-contamination note.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  pageSeatInvoke,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

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

describeE2E("vf3 filter builder property condition (key + op + value)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("builds a property filter with a live count, saves it, and reopens it editable", async () => {
    let password = "";
    await scenario(
      "vf3-property-condition",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Two notes carrying a custom `status` frontmatter property — one
        // matching, one not — created via page-seat IPC (typing frontmatter
        // through the CM6 Live editor is cursor-fragile; this is the
        // attachments-library setup pattern). A custom key, not a managed one
        // like `title`, so the scenario doesn't lean on managed-key behavior.
        for (const plaintext of [
          "---\nstatus: urgent\n---\nprop hit body",
          "---\nstatus: later\n---\nprop miss body",
        ]) {
          const r = await pageSeatInvoke(s, "plugin:notes|note_create", { plaintext }, IPC_TIMEOUT);
          expect(r.err, "note_create should succeed").toBeUndefined();
        }

        // The notes were created behind the frontend's back — reload the
        // WebView (slot stays Unlocked) so the note cache and the
        // vault-indices reindex see them.
        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        await dismissImporterOfferIfPresent(s);

        // Compose: type=property, key=status (the option's presence in the
        // picker proves the reindex delivered the key), op pinned to ==,
        // free-text value.
        await (await s.byTestId("views.new-button")).click();
        await s.byTestId("view-filter.modal");
        await (await s.byTestId("view-filter.add-condition-first")).click();
        await s.byTestId("view-filter.condition");
        await pickSelectOption(s, "view-filter.condition-type", "property");
        await pickSelectOption(s, "view-filter.condition-key", "status");
        await pickSelectOption(s, "view-filter.condition-op", "==");
        await (await s.byTestId("view-filter.condition-value")).sendKeys("urgent");

        // The live count settles on exactly 1 of the 2 seeded notes — the
        // draft evaluated through the property resolver.
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("view-filter.count")).textContent()).trim() === "1 note"
              ? true
              : null,
          { label: "live count settles on the single matching note" },
        );

        // Save → the view opens as a tab (cards default) rendering exactly the
        // matching note, and lands in the sidebar.
        await (await s.byTestId("view-filter.save")).click();
        await s.waitForGone(testIdSelector("view-filter.modal"));
        await s.byTestId("editor.view-host");
        await s.waitUntil(
          async () => ((await s.byTestIdAll("view.card")).length === 1 ? true : null),
          { label: "view renders exactly the matching note" },
        );
        await s.waitUntil(
          async () => ((await s.byTestIdAll("views.row")).length === 1 ? true : null),
          { label: "property view appears in the sidebar" },
        );

        // Edit round-trip: the property view reopens EDITABLE — a property row
        // with its key picker, not the unrepresentable read-only state.
        await openRowMenu(s, "New view");
        await (
          await s.waitForElement(
            testIdSelector("notes.context-menu-item", { "data-item-id": "edit-filter" }),
          )
        ).click();
        await s.byTestId("view-filter.modal");
        await s.byTestId("view-filter.condition-key");
        await (await s.byTestId("view-filter.cancel")).click();
        await s.waitForGone(testIdSelector("view-filter.modal"));
      },
    );
  });
});
