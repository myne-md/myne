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
// `pnpm test:e2e` self-skips off-platform). Definition of done per e2e/AGENTS.md
// is "green 3× in the container" (./scripts/e2e-local.sh) and MUST be met before
// merge. Run ISOLATED per the full-suite-contamination note.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickRibbonUntilVisible,
  clickUntilVisible,
  dismissImporterOffer,
  setViewsEnabled,
  unlockToEditor,
} from "./support/flows";
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
        // Views is OPT-IN (`settings.views-enabled`). Without this the Views nav
        // row never renders, so every `views.*` wait below burns its full budget
        // and the spec fails deterministically.
        await setViewsEnabled(s, true);

        // All-pages cards view via "+ New view" → save with no conditions.
        // The sidebar can remount and swallow the new-view click before its
        // React handler is wired, and a single click then never opens the modal.
        // This spec carried a private 3-attempt loop for that; the behaviour now
        // lives in `clickUntilVisible`, which every other Views spec shares —
        // the argument for why re-clicking is SAFE here was written down in this
        // file first and is quoted in the helper: the button only OPENS the
        // builder, and the view is committed by `view-filter.save`.
        // "+ New view" lives INSIDE the Views flyout: it renders while the flyout
        // is shut but is not interactable, so clicking it silently does nothing.
        // Open the flyout first — the same order the passing spec uses.
        await clickRibbonUntilVisible(s, "views.show", "views.flyout");
        await clickUntilVisible(s, "views.new-button", "view-filter.modal");
        await (await s.byTestId("view-filter.save")).click();
        await s.waitForGone(testIdSelector("view-filter.modal"));
        await s.byTestId("editor.view-host");

        // The gallery renders one card per seeded note, but the cards surface is
        // a projection of the post-unlock reindex — `byTestIdAll` is an
        // immediate, non-waiting query, so grabbing [0] before the reindex paints
        // is the "no cards rendered" race (the line-55 failure). Wait for the
        // cards host AND at least one card, THEN hover the first card to reveal
        // its "Set cover" affordance.
        await s.byTestId("view.cards");
        await s.waitUntil(
          async () => ((await s.byTestIdAll("view.card")).length >= 1 ? true : null),
          { label: "at least one card renders over the seeded notes" },
        );

        // The "Set cover" affordance is CONDITIONALLY rendered — it enters the
        // DOM only while the card is hovered (`showCoverButton = onSetCover &&
        // hovering`, cardsView.tsx). A single synthetic hover can miss the
        // `onMouseEnter` if it lands during a gallery re-render, leaving the
        // affordance unmounted; re-hover (re-fetching the card handle each pass,
        // since a remount staleness-invalidates the old one) until it appears.
        let setCover: Awaited<ReturnType<typeof s.waitForElement>> | undefined;
        const HOVER_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= HOVER_ATTEMPTS; attempt++) {
          try {
            const card = (await s.byTestIdAll("view.card"))[0]!;
            await card.hover();
            setCover = await s.waitForElement(testIdSelector("view.card-set-cover"), {
              timeoutMs: 6_000,
            });
            break;
          } catch (e) {
            if (attempt === HOVER_ATTEMPTS) throw e;
          }
        }
        await setCover!.click();

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
