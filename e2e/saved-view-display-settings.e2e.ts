// Saved-view DISPLAY settings E2E (Saved Views follow-on — cards cover image).
//
// Pins the cards display-settings modal end-to-end against the production binary:
// create an all-pages cards view → its row's "View settings…" context action
// opens the settings modal → set a cover-image property + an aspect-ratio preset
// → Save → reopen the modal and assert both values round-tripped. The round-trip
// is the proof that the real `upsert_saved_view` IPC persisted and `usePrefs`
// re-read it (the second open seeds purely from the stored view).
//
// The aspect picker is the app's custom `SearchableSelect` (driver-operable via
// the `${testId}-option[data-value=…]` row — same pattern as the filter builder
// and settings dropdowns). The cover-image field is a plain text Input driven by
// `replaceText` (the W3C-clear-bypasses-React caveat, per e2e/CLAUDE.md).
//
// SCOPE NOTE (no silent cap): this scenario exercises the cover-image property
// and aspect-ratio controls. The card-size control is a `<input type="range">`
// slider whose precise value is awkward to drive deterministically through
// WebDriver; its behavior (clamp 120–600, reset-to-default, omit-when-default) is
// covered by the Vitest unit test `tests/notes/viewSettings.test.tsx`.
//
// VERIFICATION STATUS (2026-06-15): authored to the harness conventions but NOT
// yet run on this dev platform (macOS; the suite is Linux/tauri-driver only —
// `pnpm test:e2e` self-skips off-platform). Definition of done per e2e/CLAUDE.md
// is "green 3× in the container" (./scripts/e2e-local.sh) and MUST be met before
// merge. Run ISOLATED per the full-suite-contamination note.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, unlockToEditor } from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Pick `value` from a custom `SearchableSelect` (testId `root`): open the
 *  trigger, then click the matching `${root}-option`. */
async function pickSelectOption(
  s: Session,
  root: string,
  value: string,
): Promise<void> {
  // The settings modal grew a view-type / group / sort / columns section above
  // the cover controls, so the aspect `SearchableSelect` now sits near the
  // bottom of the modal's scrolling body — bring its trigger into view before
  // clicking (W3C `/click` alone leaves it clipped → "not interactable").
  const trigger = await s.byTestId(root);
  await trigger.scrollIntoView();
  await trigger.click();
  await (
    await s.waitForElement(
      testIdSelector(`${root}-option`, { "data-value": value }),
    )
  ).click();
}

/** Right-click the view row whose visible label is `label`, then click the
 *  context-menu item with `data-item-id={itemId}`. */
async function rowMenuAction(
  s: Session,
  label: string,
  itemId: string,
): Promise<void> {
  const rows = await s.byTestIdAll("views.row");
  for (const r of rows) {
    if ((await r.textContent()).includes(label)) {
      await r.rightClick();
      await (
        await s.waitForElement(
          testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
        )
      ).click();
      return;
    }
  }
  throw new Error(`no views.row labelled "${label}"`);
}

describeE2E("vd1 cards view display settings — cover image + aspect round-trip", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("sets a cover-image property and aspect ratio, saves, and they persist", async () => {
    let password = "";
    await scenario(
      "vd1-view-display-settings",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Create an all-pages cards view via "+ New view" → save with no
        // conditions. It opens as a tab and appears as a sidebar row.
        await (await s.byTestId("views.new-button")).click();
        await s.byTestId("view-filter.modal");
        await (await s.byTestId("view-filter.save")).click();
        await s.waitForGone(testIdSelector("view-filter.modal"));
        await s.waitUntil(
          async () => ((await s.byTestIdAll("views.row")).length === 1 ? true : null),
          { label: "saved view appears in the sidebar" },
        );

        // Open the display-settings modal from the row's context menu.
        await rowMenuAction(s, "New view", "view-settings");
        await s.byTestId("view-settings.modal");

        // Set a cover-image property name and an aspect-ratio preset.
        await (await s.byTestId("view-settings.image-input")).replaceText("cover");
        await pickSelectOption(s, "view-settings.aspect-select", "1.78");

        // Save → modal dismisses (real upsert_saved_view IPC + prefs-nonce refresh).
        await (await s.byTestId("view-settings.save")).click();
        await s.waitForGone(testIdSelector("view-settings.modal"));

        // Reopen → the controls seed purely from the persisted view, so the
        // round-tripped values prove the save landed.
        await rowMenuAction(s, "New view", "view-settings");
        await s.byTestId("view-settings.modal");
        await s.waitUntil(
          async () => {
            const v = await (
              await s.byTestId("view-settings.image-input")
            ).property<string>("value");
            return v === "cover" ? true : null;
          },
          { label: "cover-image property round-trips" },
        );
        const aspect = await (
          await s.byTestId("view-settings.aspect-select")
        ).textContent();
        if (!aspect.includes("16:9")) {
          throw new Error(`aspect did not round-trip: "${aspect}"`);
        }
      },
    );
  });
});
