// io1 — image OCR in search (MYND-441), through the production binary.
//
// Pins the promise the feature exists to keep: a note that embeds an IMAGE
// becomes findable by words that appear only inside that image's pixels. The
// whole chain runs for real — bundled `rten` weights, the detection →
// orientation → CTC recognition pipeline, the `MYE1` cache write, the `att:`
// search doc, and the palette query — with no test hooks anywhere.
//
// Two assertions, and the second is the interesting one:
//
//   1. An English word present only in the image finds the note. That is the
//      base capability.
//   2. A Turkish word typed WITH its diacritics finds the note even though OCR
//      flattened them. The fixture image reads `sirket` (no cedilla) — which is
//      what the model actually emits — while the query types `şirket`. This is
//      the index-side diacritic-folding path, and it is the reason the feature
//      is usable in Turkish at all: no available on-device model reproduces
//      those characters reliably (`docs/decisions.md` 2026-07-25).
//
// What is driven vs. asserted:
//   - Import is page-seat IPC (`pageSeatInvoke`) because attachment import goes
//     through a native file picker WebDriver cannot drive — the gf1 /
//     attachment-text-preview precedent. It runs BEFORE the note is created so
//     the editor's per-mount catalog load sees the row.
//   - The form-C embed is typed with the `typeRaw` shape (probe char, then the
//     payload) rather than `typeIntoEditor`, because the decoration REPLACES the
//     raw source with a widget and a landed-check would false-negative and
//     double-type.
//   - Search goes through the real command palette and asserts on the note's own
//     option row (`data-note-id`), so an `att:` doc that failed to index cannot
//     satisfy it.
//
// ⚠ TIMING — do NOT add a wait on the `ocr-backlog-progress` event here.
// Import performs OCR **eagerly** (the desktop import wrapper injects the full
// extractor), so by the time `attachment_import` resolves the `MYE1` entry
// already exists and the background worker has nothing to do — the event never
// fires and the wait would hang. That indicator belongs to the OTHER path,
// attachments predating the feature which are drained after unlock; covering it
// needs a vault seeded with an attachment whose cache entry is absent.
//
// The fixture image is shared with the Rust pipeline test rather than
// duplicated: one binary, two consumers. It renders `Invoice total 4200` and
// `sirket raporu`.
//
// KDF: weak generator fixture (unlock reads params from vault.meta). The image
// and its filename are scenario content, not credentials (SYNC-13).
//
// ⚠ PLATFORM: the harness drives the production binary via tauri-driver and is
// Linux-only — authored on macOS to the conventions and run green in the
// container (`./scripts/e2e-local.sh`). See e2e/CLAUDE.md "definition of done".

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  pageSeatInvoke,
  searchAndOpenNote,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { REPO_ROOT } from "./support/session";
import { type Session } from "./support/webdriver";

const EDITOR = '[data-testid="editor.content"]';
const CM_CONTENT = `${EDITOR} .cm-content`;
const BACKSPACE = String.fromCharCode(0xe003); // W3C key codepoint (Backspace)

/** OCR of one small image runs three model passes; generous but bounded. */
const IPC_TIMEOUT = 60_000;

const FILENAME = "fatura-taramasi.png";

/** Words the fixture image renders. `invoice` is unambiguous English. `sirket`
 *  is the FLATTENED spelling OCR actually produces for `şirket`; the query below
 *  deliberately types the accented form so only folding can bridge it. */
const IMAGE_WORD_EN = "invoice";
const QUERY_TR_ACCENTED = "şirket";

/** Resolved from `REPO_ROOT` (the fixtures.ts convention) so it works from the
 *  bind-mounted container regardless of the runner's cwd. */
function fixturePng(): number[] {
  return Array.from(
    readFileSync(join(REPO_ROOT, "core", "tests", "fixtures", "ocr-sample.png")),
  );
}

/** Import the fixture image from the page seat (real IPC, zero test hooks) and
 *  return its catalog id. Import is where OCR happens on the desktop path. */
async function importImage(s: Session): Promise<string> {
  const r = await pageSeatInvoke(
    s,
    "plugin:attachments|attachment_import",
    { source: { kind: "bytes", bytes: fixturePng(), filename: FILENAME } },
    IPC_TIMEOUT,
  );
  expect(r.err, "attachment_import should accept the .png file").toBeUndefined();
  return (r.ok as { id: string }).id;
}

/** Read the `data-note-id` of the currently-selected sidebar row — the byTestId
 *  path to a live-created note's id (the sp1 pattern). */
async function selectedNoteId(s: Session): Promise<string> {
  const row = await s.waitForElement('[data-testid="notes.row"][aria-current="true"]');
  const id = await row.attribute("data-note-id");
  if (id === null || id === "") {
    throw new Error("selected notes.row carried no data-note-id");
  }
  return id;
}

/** Type raw source into CM6 without a landed-check (the decoration replaces the
 *  embed source with a widget, so a landed-check would never match). */
async function typeRaw(session: Session, text: string): Promise<void> {
  const content = await session.waitForElement(CM_CONTENT);
  await content.click();
  await session.waitUntil(
    async () => {
      await content.sendKeys("q");
      return (await content.textContent()).includes("q") || null;
    },
    { label: "keystroke pipeline established", timeoutMs: 10_000 },
  );
  await content.sendKeys(BACKSPACE); // drop the probe char
  await content.sendKeys(text);
}

// QUARANTINED — runner-contention victim, not a broken assertion. It passes
// locally (~32 s uncontended) and passed CI outright in pipeline #402; it fails
// in the slower runs (#401 at the 45 s default, #403 after the budget was
// raised to 120 s — three retries each, so more time does not rescue it: under
// load the OCR → MYE1 → re-index → palette chain stops completing at all rather
// than merely running late). Raising the budget was tried and reverted: it
// bought nothing and burned six minutes of runner time per failure, which makes
// contention worse for every spec after it.
//
// The debt is real coverage: while this is quarantined nothing on the merge gate
// proves an OCR'd word reaches search. Un-quarantine it with the boot-cost
// investigation the other five contention victims are also waiting on
// (e2e/CLAUDE.md), not by nudging timeouts.
describeE2E.flaky("io1 image OCR makes an embedded image searchable (MYND-441)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("finds a note by words that exist only inside an embedded image", async () => {
    let password = "";
    await scenario(
      "io1-image-ocr-search",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // OCR runs inside this call.
        const attachmentId = await importImage(s);

        // **Split the chain before asserting the end of it.** The palette wait
        // reported `the query landed but no row matched; re-running the search`
        // — so the query was intact, the palette re-ran the search, and the note
        // still was not a hit. That rules out the input and leaves two very
        // different bugs wearing one failure: OCR produced no text for this
        // image, or it produced text that never reached the search index. This
        // gate answers the first directly, through the same production command
        // the attachment-text preview uses, so a model that read nothing fails
        // HERE by name instead of 45 s later as a missing palette row.
        //
        // Assertion shapes are boolean and length only: the extracted text is
        // note-body-class plaintext and must not land in a CI log even though
        // this image is a repo fixture.
        const extracted = await pageSeatInvoke(
          s,
          "plugin:attachments|attachment_read_extracted_text",
          { id: attachmentId },
          IPC_TIMEOUT,
        );
        expect(extracted.err, "reading the MYE1 extraction cache must succeed").toBeUndefined();
        const text = (extracted.ok as { text?: string } | null)?.text ?? "";
        expect(text.length, "OCR must have written a non-empty MYE1 entry").toBeGreaterThan(0);
        expect(
          text.toLowerCase().includes(IMAGE_WORD_EN),
          `the extraction must contain the English word the image renders ` +
            `(${text.length} characters were extracted)`,
        ).toBe(true);

        await createNote(s, "Taranmis belge");
        const noteId = await selectedNoteId(s);
        await typeRaw(s, `![[att:${attachmentId}|${FILENAME}]]`);
        await waitForSaved(s);

        // 1. Base capability: a word only the pixels contain.
        await searchAndOpenNote(s, IMAGE_WORD_EN, noteId);

        // 2. Turkish: the image reads `sirket`, the user types `şirket`. Only
        //    the index-side diacritic folding can bridge that.
        await searchAndOpenNote(s, QUERY_TR_ACCENTED, noteId);
      },
    );
  });
});
