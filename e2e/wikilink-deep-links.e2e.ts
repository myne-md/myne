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
  pageSeatInvoke,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
  writeNoteBody,
} from "./support/flows";
import { type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

/** Read the selected sidebar row's note-id (`createNote` leaves it selected). */
async function selectedNoteId(s: Session): Promise<string> {
  const row = await s.waitForElement(
    '[data-testid="notes.row"][aria-selected="true"]',
  );
  return (await row.attribute("data-note-id")) ?? "";
}

const CM_CONTENT = '[data-testid="editor.content"] .cm-content';
const CM_SCROLLER = '[data-testid="editor.content"] .cm-scroller';

/** The MAX `.cm-scroller` scrollTop across every editor pane (the page can hold a
 *  reading-mode mirror or a second pane, so a single `querySelector` may read the
 *  wrong, top-anchored scroller). > 0 means SOME editor scrolled off the top. */
async function scrollTop(s: Session): Promise<number> {
  // The deep-link scroll may land on the .cm-scroller OR an ancestor scroll
  // container (scrollIntoView scrolls the nearest scrollable ancestor). Take the
  // MAX scrollTop across every element on the page — > 0 means SOMETHING scrolled
  // off the top; 0 means everything is at the top.
  return s.execute<number>(
    "var m = 0; var all = document.querySelectorAll('*');" +
      "for (var i=0;i<all.length;i++){ var t = all[i].scrollTop; if (t > m) m = t; }" +
      "return Math.round(m);",
  );
}

/** Press-and-release a wikilink chip by its display text, via a REAL pointer
 *  (W3C Actions: move to the chip, button-0 down, button-0 up).
 *
 *  This helper previously dispatched a native DOM `element.click()`, and its
 *  comment recorded a measurement for doing so: a synthetic pointer click did not
 *  reach CM6's chip `domEventHandlers.click`, while a DOM click did. That
 *  measurement was taken while the production handler listened on `click`.
 *  myne-md/myne#601 moved chip navigation onto `mousedown` + `mouseup`
 *  (`editor/src/wikilink/chip-widget.ts`) after measuring the opposite problem:
 *  the press REVEALS the raw `[[…]]` source, so the chip is gone by the time the
 *  button comes up, press and release no longer share a target, and the browser
 *  synthesises no `click` at all. A DOM `.click()` dispatches `click` alone and
 *  so reaches neither handler — which is why this scenario stopped navigating
 *  while every other assertion in it kept passing.
 *
 *  Re-measured against the current handler before this was changed: a DOM
 *  `.click()` navigates nowhere, the pointer press does. */
async function clickChipByText(s: Session, needle: string): Promise<void> {
  await s.waitUntil(
    async () => {
      const chips = await s.findElements(".cm-wikilink-chip");
      for (const chip of chips) {
        let text: string;
        try {
          text = await chip.textContent();
        } catch {
          // The chip list re-renders under us; let the outer budget re-query
          // rather than failing on a handle that staled between the two calls.
          return null;
        }
        if (!text.includes(needle)) continue;
        await chip.actionClick();
        return true;
      }
      return null;
    },
    { label: `pressed the "${needle}" chip`, timeoutMs: 10_000 },
  );
}

/** Click the first element matching `selector` via a native DOM `click()`,
 *  re-querying the DOM at click time. Avoids the stale-element-reference churn of
 *  a captured WebDriver handle for volatile, frequently-re-rendering elements
 *  (the bottom-bar view-mode CTA, sidebar rows). Returns true if one was found. */
async function jsClick(s: Session, selector: string): Promise<boolean> {
  return (
    (await s.execute<number>(
      "var e = document.querySelector(" +
        JSON.stringify(selector) +
        "); if (e) { e.click(); return 1; } return 0;",
    )) === 1
  );
}

/** A REAL WebDriver pointer click (mousedown+up+click — needed for components
 *  that insert on `mousedown`, e.g. the wikilink picker rows, where a bare DOM
 *  `click()` never fires) that re-FETCHES the element on every attempt. Unlike
 *  `Element.click()` (whose internal retry loops on a single captured handle and
 *  so spins for its full timeout once that handle goes stale), this re-queries
 *  each poll, so a row that re-renders as the query filters is clicked freshly.
 *  Returns once a fresh element was clicked without error. */
async function realClickFresh(s: Session, selector: string): Promise<void> {
  await s.waitUntil(
    async () => {
      const els = await s.findElements(selector);
      if (els.length === 0) return null;
      try {
        await s.send("POST", `/element/${els[0].elementId}/click`);
        return true;
      } catch {
        return null; // stale / not-interactable → re-fetch next poll
      }
    },
    { label: `clicked ${selector}`, timeoutMs: 10_000 },
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

        // ── The deep-link TARGET note. Its body is LARGE (120 filler lines push
        // the deep heading well below the fold); typing that many chars via the
        // driver drops keystrokes, so write the body via page-seat note_update
        // (production IPC) instead of typeIntoEditor, then reload so the resolver
        // + editor see it. The title ("Target") is set by createNote; preserve
        // its frontmatter by appending the body to the note's current plaintext. ──
        // Create BOTH notes through the real UI first, THEN seed their bodies via
        // page-seat IPC, THEN a single reload — so no createNote click races a
        // post-refresh re-render (a mid-flow refresh left the sidebar's create
        // button stale).
        await createNote(s, "Target");
        const targetId = await selectedNoteId(s);
        // ── A SOURCE note carrying the anchor links. The first link points at a
        // real heading deep in Target; the second at a heading that does not
        // exist (the §5.6 not-found fallback). Title-only forms keep the chip
        // text short and resolve by title. ──
        await createNote(s, "Source");
        const sourceId = await selectedNoteId(s);

        const seedBody = async (noteId: string, append: string) => {
          const cur = await pageSeatInvoke(
            s,
            "plugin:notes|note_read",
            { noteId },
            IPC_TIMEOUT,
          );
          const base = typeof cur.ok === "string" ? cur.ok : "";
          const up = await writeNoteBody(s, noteId, `${base}\n${append}`, IPC_TIMEOUT);
          expect(up.err, "the note body write should succeed").toBeUndefined();
        };

        // Target body is LARGE (120 filler lines push the deep heading well below
        // the fold); the driver drops keystrokes typing that many chars, and the
        // Source links would each open the wikilink autocomplete (swallowing the
        // inter-link Enter). Seed both via page-seat IPC, then reload so the
        // resolver + editor see them.
        await seedBody(targetId, TARGET_BODY);
        await seedBody(
          sourceId,
          "intro wdintro\n[[Target#Deep Section wddeep]]\n[[Target#Ghost Heading]]\n",
        );
        // The active editor tab's note-id ("note:<id>") — the race-free "which
        // note is open" signal (editorText would false-match the Source link text).
        const activeNoteId = async (): Promise<string | null> => {
          const tabs = await s.findElements('[data-testid="editor.tab"][data-active="true"]');
          if (tabs.length === 0) return null;
          const raw = (await tabs[0].attribute("data-tab-id")) ?? "";
          return raw.startsWith("note:") ? raw.slice("note:".length) : null;
        };

        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        // Open Source and WAIT until it is the active tab before touching the
        // bottom-bar view-mode CTA (which only mounts for a live note tab).
        await s.waitUntil(
          async () => {
            await jsClick(s, `[data-testid="notes.row"][data-note-id="${sourceId}"]`);
            return (await activeNoteId()) === sourceId ? true : null;
          },
          { label: "Source note opened", timeoutMs: 20_000 },
        );

        // Switch the pane to READING view (live → reading via the bottom-bar
        // cycle CTA). Reading view hard-disables the cursor-aware reveal, so the
        // links ALWAYS render as chips and a click on one navigates instead of
        // lifting it to raw text under the caret (the live-mode reveal otherwise
        // turns the clicked chip into editable text before the click handler runs,
        // so the navigation never fires). View mode is per-tab + persisted, so
        // Source stays in reading view across the round-trip.
        const CTA = '[data-testid="editor.view-mode-cta"]';
        const viewMode = async (): Promise<string | null> => {
          const ctas = await s.findElements(CTA);
          return ctas.length === 0 ? null : await ctas[0].attribute("data-view-mode");
        };
        const enterReading = async () => {
          // Cycle live → reading → source → live. Click ONCE per step and WAIT for
          // the mode to actually change before clicking again — a poll that
          // re-clicks before the re-render lands overshoots past "reading" (the
          // CTA also mounts a beat after the row click, so poll for it first).
          for (let i = 0; i < 4; i++) {
            const mode = await s.waitUntil(viewMode, {
              label: "view-mode CTA mounted",
              timeoutMs: 15_000,
            });
            if (mode === "reading") return;
            // JS-click the CTA (re-queries the DOM, so no stale handle as it
            // re-renders on each mode change), then wait for the mode to leave its
            // current value WITHOUT re-clicking (re-clicking before the re-render
            // lands would overshoot past "reading").
            await jsClick(s, CTA);
            await s.waitUntil(
              async () => ((await viewMode()) !== mode ? true : null),
              { label: "view mode advanced one step", timeoutMs: 8_000 },
            );
          }
          await s.waitUntil(async () => ((await viewMode()) === "reading" ? true : null), {
            label: "pane in reading view",
            timeoutMs: 8_000,
          });
        };
        await enterReading();
        await s.waitUntil(
          async () => ((await s.findElements(".cm-wikilink-chip")).length >= 2 ? true : null),
          { label: "both anchor chips rendered", timeoutMs: 10_000 },
        );

        // ── Click the DEEP chip → opens Target AND scrolls to the deep heading. ──
        await clickChipByText(s, "Deep Section");
        await s.waitUntil(async () => ((await activeNoteId()) === targetId ? true : null), {
          label: "navigated to Target via the deep chip",
          timeoutMs: 10_000,
        });
        await s.waitUntil(async () => ((await scrollTop(s)) > 0 ? true : null), {
          label: "scrolled to the deep heading (scrollTop > 0)",
          timeoutMs: 10_000,
        });

        // ── Back to Source, click the GHOST chip → opens Target at the TOP
        // (anchor not found → §5.6 note-top fallback). ──
        await s.waitUntil(
          async () => {
            await jsClick(s, `[data-testid="notes.row"][data-note-id="${sourceId}"]`);
            return (await activeNoteId()) === sourceId ? true : null;
          },
          { label: "back on Source", timeoutMs: 20_000 },
        );
        await enterReading();
        await clickChipByText(s, "Ghost Heading");
        await s.waitUntil(async () => ((await activeNoteId()) === targetId ? true : null), {
          label: "navigated to Target via the ghost chip",
          timeoutMs: 10_000,
        });
        // Not-found anchor lands at the top — scrollTop stays 0.
        await s.waitUntil(async () => ((await scrollTop(s)) === 0 ? true : null), {
          label: "missing-heading chip opened Target at the top",
          timeoutMs: 10_000,
        });
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
        const authorId = await selectedNoteId(s);
        await typeIntoEditor(s, "## Setup wdsetup\n\n");
        await waitForSaved(s);

        const content = await s.waitForElement(CM_CONTENT);

        // ── `[[#` current-note heading → compact `[[#Heading]]`. ── A real pointer
        // click (the picker inserts on mousedown — a DOM click() never fires it),
        // re-fetched so the row re-rendering as the query filters doesn't stale it.
        await content.sendKeys("[[#setup");
        await realClickFresh(s, '[data-testid="picker.heading-row"]');
        await s.waitUntil(
          async () => ((await editorText(s)).includes("[[#Setup wdsetup]]") ? true : null),
          { label: "[[# inserted the compact heading-anchor form", timeoutMs: 10_000 },
        );

        // ── `[[##` vault-wide heading → full path form. ── The chip widget is
        // an atomic Decoration.replace mounted OUTSIDE myneDecorations()
        // (extensions.ts wikilinkChipExtensions), so source mode still shows
        // the chip display (`Spec › Goals wdgoals`), never the path — the
        // only DOM lift is cursor-line reveal, which leaves as soon as focus
        // moves. Assert the bytes the autosave wrote via production
        // note_read IPC (same oracle wd1 already uses).
        await content.sendKeys("\n[[##goals");
        await realClickFresh(s, '[data-testid="picker.vault-heading-row"]');
        await waitForSaved(s);
        await s.waitUntil(
          async () => {
            const r = await pageSeatInvoke(
              s,
              "plugin:notes|note_read",
              { noteId: authorId },
              IPC_TIMEOUT,
            );
            const body = typeof r.ok === "string" ? r.ok : "";
            return body.includes("Spec.md#Goals wdgoals|") ? true : null;
          },
          { label: "[[## inserted the full path heading form", timeoutMs: 15_000 },
        );
      },
    );
  });
});
