// Saved Views cards-render E2E (Saved Views #5 / MYND-275).
//
// Pins the cards-view render end-to-end against the production binary: with
// three live notes (none carrying an `image:` frontmatter), creating a blank
// cards view via the "Views" section header opens it as a view tab whose body
// is the cards gallery — three image-less cards under the no-group "No value"
// section heading (count = 3). Single-clicking a card opens its note in the
// focused tab, replacing the view host with the note editor. The cards surface
// is a read-only projection of the live note caches through the query engine;
// this drives the real create-view IPC (prefs upsert, MYP1) + the real
// view-host open seam, no test hook.
//
// VERIFICATION STATUS (Saved Views #5, 2026-06-15): authored to the harness
// conventions but NOT yet run on this dev platform (macOS; the suite is
// Linux/tauri-driver only — `pnpm test:e2e` self-skips off-platform). Definition
// of done per e2e/CLAUDE.md is "green 3× in the container" (./scripts/e2e-local.sh)
// and MUST be met before merge. Run ISOLATED per the full-suite-contamination
// note (e2e-full-suite-contamination memory).
//
// Cards-count decision: EXACT 3. The base seed (`seedVault`, no `exportSuite`)
// writes only `vault.meta` — zero notes, no welcome/default note (verified:
// e2e/fixture-gen/src/lib.rs::write_fixture writes the meta only; notes land
// solely under `--export-suite`/`write_export_suite`). So the vault is genuinely
// empty until the three `createNote` calls, and the blank "all" view over those
// three live notes is exactly three cards in one "No value" group.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, unlockToEditor } from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

// No raw key sends here — `createNote` commits via the rename-input unmount, so
// the WebDriver Enter primitive (String.fromCharCode(0xe007)) isn't needed.

/** Visible text of every rendered card, in DOM order. */
async function cardTitles(s: Session): Promise<string[]> {
  const cards = await s.byTestIdAll("view.card");
  return Promise.all(cards.map((c) => c.text()));
}

describeE2E("svc1 cards view renders live notes as image-less cards (MYND-275)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("opens a blank cards view as a tab and renders one card per note", async () => {
    let password = "";
    await scenario(
      "svc1-cards-render",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Three live notes — none gets an `image:` frontmatter, so every card
        // is image-less (no cover, no broken-image glyph).
        await createNote(s, "Dune");
        await createNote(s, "Sapiens");
        await createNote(s, "Hyperion");

        // Create a blank view from the Views section header. "+ New view" opens
        // the filter builder empty (MYND-282); saving with no conditions creates
        // a view that opens as a tab.
        await (await s.byTestId("views.new-button")).click();
        await (await s.byTestId("view-filter.save")).click();
        await s.waitForGone(testIdSelector("view-filter.modal"));
        await s.byTestId("editor.view-host"); // the new view opened as a tab

        // The cards surface is present and renders one card per live note.
        await s.byTestId("view.cards");
        await s.waitUntil(
          async () => ((await s.byTestIdAll("view.card")).length === 3 ? true : null),
          { label: "three cards over the three live notes" },
        );

        // The no-group view renders a single "No value" section heading whose
        // text carries the card count (heading renders `<label> · <count>`).
        const headings = await s.byTestIdAll("view.group-heading");
        await s.waitUntil(async () => (headings.length >= 1 ? true : null), {
          label: "at least one group heading",
        });
        await s.waitUntil(
          async () => ((await headings[0]!.text()).includes("3") ? true : null),
          { label: "group heading carries the count" },
        );

        // Image-less: no note carries `image:`, so no card paints a cover.
        await s.waitUntil(
          async () => ((await s.byTestIdAll("view.card-image")).length === 0 ? true : null),
          { label: "no card cover images rendered" },
        );
        // …and the cards still render without a cover (count unchanged).
        await s.waitUntil(
          async () => ((await s.byTestIdAll("view.card")).length === 3 ? true : null),
          { label: "three image-less cards still present" },
        );
        // The three created titles are present among the cards.
        await s.waitUntil(async () => {
          const titles = await cardTitles(s);
          return ["Dune", "Sapiens", "Hyperion"].every((t) =>
            titles.some((card) => card.includes(t)),
          )
            ? true
            : null;
        }, { label: "the three created titles appear as cards" });

        // Single-click the first card → its note opens in the focused tab,
        // replacing the view host with the note editor.
        await (await s.byTestId("view.card")).click();
        await s.byTestId("editor.content"); // the note editor surface appears
        await s.waitForGone(testIdSelector("editor.view-host"));
      },
    );
  });
});
