// Wikilink heading deep-links (wikilink-deep-links / MYND-305, task 6;
// stories 1/2/3/7).
//
// Drives the deep-link behaviors through the production binary:
//   wd1  Clicking `[[Note#Heading]]` opens the note AND scrolls to that heading
//        (a heading far down a long note → the scroller scrollTop moves off 0).
//        A not-found anchor `[[Note#Ghost]]` opens the note at the TOP
//        (scrollTop stays 0) — the §5.6 fallback.
//   wd2  `[[#` autocompletes the CURRENT note's headings and inserts the compact
//        `[[#Heading]]` form. `[[##` autocompletes vault-wide headings and
//        inserts the full `[[vault/path.md#Heading|Display]]` path form.
//
// What is NOT asserted here (and why):
//   - The anchor-match function (fold-identity, duplicate→first, not-found→null),
//     the hybrid emit forms, the picker mode discriminator, and the heading rank
//     are unit-tested (tests/editor/wikilink-anchor.test.ts,
//     wikilink-emit.test.ts, wikilink-heading-rank.test.ts,
//     wikilink-picker-anchor.test.ts) — E2E pins the end-to-end click→scroll +
//     insert, not the pure logic.
//   - The block-anchor half (`[[^^` / `^block-id` authoring) is DEFERRED
//     (MYND-382) and intentionally has no scenario.
//
// The chip widget carries no testid, so it is matched by its CodeMirror class
// `.cm-wikilink-chip` — the sanctioned class-selector exception for the chip
// (see folder-notes.e2e.ts fn1). Note bodies are in-source scenario content,
// never credentials (SYNC-13).
//
// Vault-count precondition: 1 (weak KDF generator fixture — legal: unlock reads
// params from vault.meta).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { type Session } from "./support/webdriver";

const CM_CONTENT = '[data-testid="editor.content"] .cm-content';
const CM_SCROLLER = '[data-testid="editor.content"] .cm-scroller';

/** Read the editor's scroll offset (the `.cm-scroller` scrollTop). > 0 means the
 *  view scrolled away from the top. */
async function scrollTop(s: Session): Promise<number> {
  return s.execute<number>(
    "var el = document.querySelector('" + CM_SCROLLER + "');" +
      "return el === null ? -1 : Math.round(el.scrollTop);",
  );
}

// A LONG target note: a unique-tail H1 at the top + a target heading pushed far
// down by filler so a scroll-to-heading visibly moves the scroller. The unique
// tails pin which note the editor shows.
const FILLER = Array.from({ length: 60 }, (_, i) => `filler line ${i}`).join("\n");
const TARGET_BODY = [
  "# Top heading wdtoph1",
  FILLER,
  "## Deep Section wddeep",
  "deep body line",
  FILLER,
].join("\n");

describeE2E("wd1 click [[Note#Heading]] scrolls to the heading; not-found → note top (MYND-305)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a resolved heading chip scrolls down to the heading; a missing-heading chip opens at the top", async () => {
    let password = "";
    await scenario(
      "wd1-deep-link-scroll",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // ── The deep-link TARGET note. ──
        await createNote(s, "Target");
        await typeIntoEditor(s, TARGET_BODY);
        await waitForSaved(s);

        // ── A SOURCE note carrying the anchor links. The first link points at a
        // real heading deep in Target; the second at a heading that does not
        // exist (the §5.6 not-found fallback). Title-only forms keep the chip
        // text short and resolve by title. ──
        await createNote(s, "Source");
        await typeIntoEditor(s, "[[Target#Deep Section wddeep]]\n[[Target#Ghost Heading]]\n");
        await waitForSaved(s);

        // Two resolved chips render (both notes exist; the anchor never breaks
        // the LINK, only the in-note scroll target).
        await s.waitForElement(".cm-wikilink-chip");
        await s.waitUntil(
          async () => ((await s.findElements(".cm-wikilink-chip")).length >= 2 ? true : null),
          { label: "both anchor chips rendered", timeoutMs: 10_000 },
        );

        // ── Click the FIRST chip (#Deep Section) → opens Target + scrolls down. ──
        const chips1 = await s.findElements(".cm-wikilink-chip");
        await chips1[0].click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("wddeep") ? true : null),
          { label: "navigated to Target", timeoutMs: 10_000 },
        );
        // The scroller moved off the top to bring the deep heading into view.
        await s.waitUntil(
          async () => ((await scrollTop(s)) > 0 ? true : null),
          { label: "scrolled to the deep heading (scrollTop > 0)", timeoutMs: 10_000 },
        );

        // ── Go back to Source, click the SECOND chip (#Ghost) → opens Target at
        // the TOP (anchor not found → §5.6 note-top fallback). ──
        const sourceRow = await s.waitForElement(
          '[data-testid="notes.row"][aria-selected="false"]',
        );
        await sourceRow.click();
        await s.waitUntil(
          async () => {
            const text = await editorText(s);
            // Source shows the raw chip text via its links; Target's deep body is
            // absent → we are back on Source.
            return text.includes("Ghost Heading") ? true : null;
          },
          { label: "back on Source", timeoutMs: 10_000 },
        );

        const chips2 = await s.findElements(".cm-wikilink-chip");
        await chips2[1].click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("wddeep") ? true : null),
          { label: "navigated to Target (not-found anchor)", timeoutMs: 10_000 },
        );
        // Not-found anchor lands at the top — scrollTop stays 0.
        await s.waitUntil(
          async () => ((await scrollTop(s)) === 0 ? true : null),
          { label: "missing-heading chip opened Target at the top", timeoutMs: 10_000 },
        );
      },
    );
  });
});

describeE2E("wd2 [[# / [[## heading autocomplete inserts the hybrid form (MYND-305)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("`[[#` inserts the compact form for a current-note heading; `[[##` inserts the path form for a vault-wide heading", async () => {
    let password = "";
    await scenario(
      "wd2-heading-autocomplete",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // A note whose vault-wide heading `[[##` can find later.
        await createNote(s, "Spec");
        await typeIntoEditor(s, "## Goals wdgoals\nbody\n");
        await waitForSaved(s);

        // The authoring note, with its OWN heading for `[[#` to find.
        await createNote(s, "Author");
        await typeIntoEditor(s, "## Setup wdsetup\n\n");
        await waitForSaved(s);

        const content = await s.waitForElement(CM_CONTENT);

        // ── `[[#` current-note heading → compact `[[#Heading]]`. ──
        await content.sendKeys("[[#setup");
        await (
          await s.waitForElement(
            '[data-testid="picker.heading-row"]',
            { timeoutMs: 10_000 },
          )
        ).click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("[[#Setup wdsetup]]") ? true : null),
          { label: "[[# inserted the compact heading-anchor form", timeoutMs: 10_000 },
        );

        // ── `[[##` vault-wide heading → full path form. ──
        await content.sendKeys("\n[[##goals");
        await (
          await s.waitForElement(
            '[data-testid="picker.vault-heading-row"]',
            { timeoutMs: 10_000 },
          )
        ).click();
        await s.waitUntil(
          async () => {
            const text = await editorText(s);
            // The full path form: a `.md#` anchor + the `|` alias divider.
            return text.includes("Spec.md#Goals wdgoals|") ? true : null;
          },
          { label: "[[## inserted the full path heading form", timeoutMs: 10_000 },
        );
      },
    );
  });
});
