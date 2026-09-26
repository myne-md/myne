// Tag browser browse + filter suite (tag-system #2 / MYND-46).
//
// Pins the modal tag browser: open it from the BottomBar, multi-select tags in
// the tree, the AND/OR toggle changes the result set, and clicking a result
// opens that note. Tags are seeded by typing inline #tags into note bodies — the
// real save → reindex pipeline (`vaultIndicesApply`) populates the index, so the
// browser reads production data, no test hook.
//
// VERIFICATION STATUS (tag-system #2, 2026-06-14): authored to the harness
// conventions but NOT yet run on this dev platform (macOS; the suite is
// Linux/tauri-driver only — `pnpm test:e2e` self-skips off-platform). Definition
// of done per e2e/AGENTS.md is "green 3× in the container" (./scripts/e2e-local.sh)
// and MUST be met before merge. Coexistence with the graph's own tag dropdown
// (TS-4 / story 14) is structural — GraphView's picker is untouched by this slice
// — so it is asserted by construction, not separately driven here (would need new
// testids inside the graph modal, out of this slice).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickRibbonUntilVisible,
  createNote,
  dismissImporterOffer,
  editorText,
  setViewsEnabled,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";
import { KEY, pressKey } from "./support/keyboard";

/** Number of filtered-result rows currently rendered in the modal. */
async function resultCount(s: Session): Promise<number> {
  return (await s.byTestIdAll("tags.result-row")).length;
}

describeE2E("tb1 browse + AND/OR filter (MYND-46)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("multi-selects tags, toggles AND/OR, and opens a result", async () => {
    // Leading space so the FIRST inline tag has the required (^|\s) boundary
    // even after typeIntoEditor's sacrificial probe char.
    const A_MARK = " #shared #alpha";
    const B_MARK = " #shared #beta";
    let password = "";
    await scenario(
      "tb1-browse-filter",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Two notes: Alpha = #shared + #alpha; Beta = #shared + #beta.
        await createNote(s, "Alpha Note");
        await typeIntoEditor(s, A_MARK);
        await waitForSaved(s);
        await createNote(s, "Beta Note");
        await typeIntoEditor(s, B_MARK);
        await waitForSaved(s);

        // Open the tag browser from the persistent BottomBar affordance.
        await (await s.byTestId("editor.tags-cta")).click();
        await s.byTestId("tags.modal");

        // Select #shared → both notes match. The whole chip toggles selection.
        await (
          await s.waitForElement(
            testIdSelector("tags.chip", { "data-tag-key": "shared" }),
          )
        ).click();
        await s.waitUntil(async () => ((await resultCount(s)) === 2 ? true : null), {
          label: "#shared → 2 results",
        });

        // Add #alpha (AND is the default) → intersection = Alpha Note only.
        await (
          await s.waitForElement(
            testIdSelector("tags.chip", { "data-tag-key": "alpha" }),
          )
        ).click();
        await s.waitUntil(async () => ((await resultCount(s)) === 1 ? true : null), {
          label: "#shared AND #alpha → 1 result",
        });

        // Switch to "Any" (OR) → union = both notes again (proves the toggle).
        await (await s.byTestId("tags.mode-or")).click();
        await s.waitUntil(async () => ((await resultCount(s)) === 2 ? true : null), {
          label: "#shared OR #alpha → 2 results",
        });

        // Click a result → it opens in the editor and the modal closes.
        await (await s.byTestId("tags.result-row")).click();
        await s.waitForGone(testIdSelector("tags.modal"));
        await s.waitUntil(
          async () => ((await editorText(s)).includes("#shared") ? true : null),
          { label: "result opened in the editor" },
        );

        // tag-system #3: the opened note's body shows inline #tag CHIPS; clicking
        // one re-opens the browser filtered to that tag (myne-open-tag bridge).
        await (await s.byTestId("editor.tag-chip")).click();
        await s.byTestId("tags.modal");
      },
    );
  });
});

describeE2E("tb2 save current filter as view → appears in the sidebar (Saved Views #4)", () => {
  // Vault-count precondition: 1 (weak KDF). Regression lock for the cross-surface
  // prefs refresh: saving a view from the Tag browser must surface it in the
  // sidebar "Views" section WITHOUT an app restart (the prefs nonce bumped at the
  // upsert chokepoint re-reads the sidebar's own `usePrefs`). Before the fix, the
  // row only appeared after a remount.
  it("saves a tag filter as a view and shows it in the sidebar without a restart", async () => {
    const A_MARK = " #alpha";
    let password = "";
    await scenario(
      "tb2-save-as-view",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        // Views is OPT-IN (`settings.views-enabled`). Without this the Views nav
        // row never renders, so every `views.*` wait below burns its full budget.
        await setViewsEnabled(s, true);

        // One tagged note so the browser has a chip to filter on.
        await createNote(s, "Alpha Note");
        await typeIntoEditor(s, A_MARK);
        await waitForSaved(s);

        // The sidebar Views section starts empty (no saved views yet). The list
        // and its empty state live inside a flyout the nav row opens; both are
        // absent from the screen until it is.
        await clickRibbonUntilVisible(s, "views.show", "views.flyout");
        await s.byTestId("views.empty");

        // Open the browser, select #alpha → the "Save as view" affordance shows.
        await (await s.byTestId("editor.tags-cta")).click();
        await s.byTestId("tags.modal");
        await (
          await s.waitForElement(
            testIdSelector("tags.chip", { "data-tag-key": "alpha" }),
          )
        ).click();

        // Save the current filter (the name defaults to the selected tag).
        await (await s.byTestId("views.save-current")).click();
        await (await s.byTestId("views.save-confirm")).click();

        // Modal closes; the saved view appears in the sidebar with NO restart —
        // this is the bug the prefs-nonce chokepoint fixes.
        await s.waitForGone(testIdSelector("tags.modal"));
        // The view rows live in the flyout, and saving from the tags browser
        // left it closed. Re-open before counting rows.
        await clickRibbonUntilVisible(s, "views.show", "views.flyout");
        await s.waitUntil(
          async () => ((await s.byTestIdAll("views.row")).length === 1 ? true : null),
          { label: "saved view appears in the sidebar" },
        );
      },
    );
  });
});

// tb3 — myne-md/myne#557's `tags.browser` bullet.
//
// # The premise the roster row was written on, and why it does not hold
//
// The row asked a person to open the tag browser on machines with different
// system locales and confirm the tag list is ordered stably and lists no tag
// twice — the worry being that a locale-aware collator would order it
// differently per host.
//
// It cannot. The tag tree comes from the Rust vault-indices accessor, and there
// is no `Intl.Collator` anywhere in `src/`, so no host ICU data is consulted at
// any point between the index and the rendered chip. What is left of the row is
// its own stated acceptance criterion — stable ordering, no tag twice — and both
// halves are set assertions over the rendered DOM.
//
// # What "stable" is asserted against
//
// Not against a hardcoded list: the ordering rule is the accessor's, and pinning
// a literal here would freeze a decision this file does not own. It is asserted
// as IDEMPOTENCE — the same corpus, read twice across a close and reopen, in the
// same order — which is what "stable" means for a list nobody is editing, and
// what a locale-sensitive collator would break the moment anything about the
// environment differed between the two reads.
//
// The duplicate half is stronger than it looks. Tags arrive from several notes
// and the same tag appears in many; a browser that listed one chip per
// OCCURRENCE rather than per tag would still filter correctly, still open the
// right notes, and pass every other scenario in this file.
describeE2E("tb3 the tag list is stable and lists no tag twice (myne-md/myne#557)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("orders identically across a reopen, and lists each tag exactly once", async () => {
    let password = "";
    await scenario(
      "tb3-tag-list-stability",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // A corpus where the SAME tags appear on several notes, in different
        // orders, with a case difference and a diacritic — the inputs a
        // per-occurrence list or a locale-aware collator would each disturb.
        const NOTES: ReadonlyArray<[title: string, body: string]> = [
          ["Zebra Note", " #shared #zulu #alpha"],
          ["Alpha Note", " #alpha #shared"],
          ["Middle Note", " #shared #mike #zulu"],
          ["Diacritic Note", " #ekonomi #shared"],
        ];
        for (const [title, body] of NOTES) {
          await createNote(s, title);
          await typeIntoEditor(s, body);
          await waitForSaved(s);
        }

        /** The rendered chips' tag keys, in DOM order. */
        const chipKeys = async (): Promise<string[]> => {
          const chips = await s.byTestIdAll("tags.chip");
          const keys: string[] = [];
          for (const chip of chips) keys.push((await chip.attribute("data-tag-key")) ?? "?");
          return keys;
        };

        await (await s.byTestId("editor.tags-cta")).click();
        await s.byTestId("tags.modal");

        // Wait for the whole corpus to be indexed, so the two reads below are
        // of the same list rather than of a growing one.
        await s.waitUntil(
          async () => ((await chipKeys()).length >= 5 ? true : null),
          { label: "every seeded tag reached the browser" },
        );
        const first = await chipKeys();

        // 1. No tag twice. Five distinct tags across four notes, three of which
        //    carry #shared — a per-occurrence list would show it three times.
        expect(
          new Set(first).size,
          `the tag list repeats a tag: ${first.join(", ")}`,
        ).toBe(first.length);
        for (const tag of ["shared", "alpha", "zulu", "mike", "ekonomi"]) {
          expect(first, `#${tag} is missing from the browser`).toContain(tag);
        }

        // 2. Stable across a close and reopen. The list is rebuilt from the
        //    index on each open, so this is a genuine second read rather than a
        //    cached render.
        await pressKey(s, KEY.ESCAPE);
        await s.waitForGone(testIdSelector("tags.modal"));
        await (await s.byTestId("editor.tags-cta")).click();
        await s.byTestId("tags.modal");
        await s.waitUntil(
          async () => ((await chipKeys()).length === first.length ? true : null),
          { label: "the reopened browser lists the same number of tags" },
        );
        expect(await chipKeys()).toEqual(first);
      },
    );
  });
});
