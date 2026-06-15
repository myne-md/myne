// Cards-view cover picker E2E (Saved Views follow-on — visual cover selection).
//
// Pins the end-to-end "set a cover image without editing frontmatter" flow
// against the production binary: a vault seeded WITH image attachments
// (`exportSuite`) → create an all-pages cards view → hover a card → its "Set
// cover" affordance → the cover picker → pick an existing image → the card's
// `view.card-image` appears. The cover is written to the note's `cover:`
// frontmatter property via the real `note_update` IPC and the view adopts
// `image: "cover"` (prefs IPC) — proven by the rendered cover surviving the
// reindex round-trip.
//
// The "upload new file" path needs the OS file dialog (page-seat intercept) and
// the drag-drop path needs synthetic file payloads; both are left to the Vitest
// unit test (`tests/notes/coverPicker.test.tsx`) — this scenario drives the
// "choose an existing attachment" path, which exercises the full
// setNoteCover → frontmatter → reindex → card-render chain.
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
import { testIdSelector } from "./support/webdriver";

describeE2E("vc1 cards cover picker — choose an existing image as a card cover", () => {
  // Vault-count precondition: 1 (weak KDF), seeded WITH image attachments.
  it("hovers a card, picks an existing image, and the cover renders", async () => {
    let password = "";
    await scenario(
      "vc1-cards-cover-picker",
      {
        seed: (dir) =>
          void (password = seedVault(dir, { exportSuite: true }).password),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // All-pages cards view via "+ New view" → save with no conditions.
        await (await s.byTestId("views.new-button")).click();
        await s.byTestId("view-filter.modal");
        await (await s.byTestId("view-filter.save")).click();
        await s.waitForGone(testIdSelector("view-filter.modal"));
        await s.byTestId("editor.view-host");

        // The gallery has at least one card (the seeded notes). Hover the first
        // card to reveal its "Set cover" affordance.
        const card = (await s.byTestIdAll("view.card"))[0];
        if (card === undefined) throw new Error("no cards rendered");
        await card.hover();
        await (await s.waitForElement(testIdSelector("view.card-set-cover"))).click();

        // The cover picker opens with the vault's existing image attachments.
        await s.byTestId("cover-picker.modal");
        const image = await s.waitForElement(testIdSelector("cover-picker.image"));
        await image.click();

        // Picker dismisses; the cover is written + reindexed; the card now shows
        // its cover image (proves frontmatter write + view adopting `cover`).
        await s.waitForGone(testIdSelector("cover-picker.modal"));
        await s.waitUntil(
          async () =>
            (await s.byTestIdAll("view.card-image")).length >= 1 ? true : null,
          { label: "card cover image renders after pick" },
        );
      },
    );
  });
});
