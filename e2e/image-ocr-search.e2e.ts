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
//   - The form-C embed is written with `seedEmbedIntoNote` (real `note_update`
//     IPC + reopen) rather than typed: driving `![[` through WebDriver races
//     CodeMirror's bracket auto-close, which cost four CI rounds before the
//     input method itself was replaced. See that helper's header.
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
// container (`./scripts/e2e-local.sh`). See e2e/AGENTS.md "definition of done".

import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  pageSeatInvoke,
  searchAndOpenNote,
  seedEmbedIntoNote,
  selectedNoteId,
  unlockToEditor,
  importFixturePng,
} from "./support/flows";


/** OCR of one small image runs three model passes; generous but bounded. */
const IPC_TIMEOUT = 60_000;

const FILENAME = "fatura-taramasi.png";

/** Words the fixture image renders. `invoice` is unambiguous English. `sirket`
 *  is the FLATTENED spelling OCR actually produces for `şirket`; the query below
 *  deliberately types the accented form so only folding can bridge it. */
const IMAGE_WORD_EN = "invoice";
const QUERY_TR_ACCENTED = "şirket";

/** Type raw source into CM6 without a landed-check (the decoration replaces the
 *  embed source with a widget, so a landed-check would never match). */

// QUARANTINED — runner-contention victim, not a broken assertion. It passes
// locally (~32 s uncontended) and passed CI outright in pipeline #402; it fails
// in the slower runs (#401 at the 45 s default, #403 after the budget was
// raised to 120 s — three retries each, so more time does not rescue it: under
// load the OCR → MYE1 → re-index → palette chain stops completing at all rather
// than merely running late). Raising the budget was tried and reverted: it
// bought nothing and burned six minutes of runner time per failure, which makes
// contention worse for every spec after it.
//
// The debt is real coverage: while this is quarantined nothing in `e2e-floor`'s
// counted set proves an OCR'd word reaches search. Un-quarantine it with the boot-cost
// investigation the other five contention victims are also waiting on
// (e2e/AGENTS.md), not by nudging timeouts.
// DE-QUARANTINED (myne-md/myne#555). The quarantine reason was
// runner contention, and it was wrong for the same reason it was wrong for
// `nav1`: the first seeding test in a vitest process builds `e2e-fixture-gen`
// with `cargo build --release` INSIDE its own budget, ~171 s against a 180 s
// `testTimeout`. Which spec paid it depended only on which one seeded first,
// which is why the victim moved between runs and read as a loaded host.
// `e2e/support/global-setup.ts` now pays that build once per vitest invocation,
// before any worker starts. Measured after the fix, `--retry=0`, warm
// container: 16 consecutive clean runs, which is the bar `e2e/AGENTS.md` sets.
describeE2E("io1 image OCR makes an embedded image searchable (MYND-441)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("finds a note by words that exist only inside an embedded image", async () => {
    let password = "";
    let vaultId = "";
    await scenario(
      "io1-image-ocr-search",
      {
        seed: (dir) => {
          const v = seedVault(dir);
          password = v.password;
          vaultId = v.vaultId;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // **The one link between the passing unit test and this failing
        // scenario, asserted before the thing that depends on it.**
        // `attachment_import_desktop` reads `attachment_ocr_enabled` and picks
        // `extract_deferring_ocr` when it is off, which produces exactly the
        // empty cache entry this scenario reports. The Rust test that covers
        // the same import path passes `extract::extract` directly and so cannot
        // see this gate at all. The pref defaults ON, but the vault here is
        // seeded by the fixture generator rather than created by the app, and
        // nothing until now checked what that blob actually says.
        const prefs = await pageSeatInvoke(s, "plugin:prefs|prefs_read", {}, 10_000);
        expect(
          (prefs.ok as { attachment_ocr_enabled?: boolean } | undefined)?.attachment_ocr_enabled,
          "the seeded vault must have image OCR on, or import defers it and the cache stays empty",
        ).toBe(true);

        // OCR runs inside this call.
        const attachmentId = await importFixturePng(s, FILENAME);

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

        // **Which of the two empties is it?** The import caches every extraction
        // result EXCEPT `Unsupported`, so the presence of the blob on disk is
        // the one observable that separates them, and neither the command nor
        // the UI exposes the status itself:
        //   - no blob  → `Unsupported`, which for an image means `models()` was
        //                None, i.e. the running app never loaded the OCR weights
        //                from its resource directory.
        //   - a blob   → OCR ran and cleared nothing, a recognition result.
        // Eight other explanations have already been refuted by measurement
        // (weights present and real, image above the 96px floor, pipeline reads
        // the fixture, compression preserves it, `is_ocr_image` accepts the
        // compressed container, the full import path passes as a Rust test on
        // this very runner, the stub features do not touch OCR, and the pref
        // above is on), so this is the fork that is left.
        const cachePath = join(
          app.appDataDir,
          "vaults",
          vaultId,
          "attachments-text",
          attachmentId,
        );
        const cached = existsSync(cachePath);
        const text = (extracted.ok as { text?: string } | null)?.text ?? "";
        expect(
          cached,
          "no MYE1 blob at all means the extraction was Unsupported, which for an image " +
            "means the running app has no OCR weights loaded — not that OCR read nothing",
        ).toBe(true);
        expect(text.length, "OCR must have written a non-empty MYE1 entry").toBeGreaterThan(0);
        expect(
          text.toLowerCase().includes(IMAGE_WORD_EN),
          `the extraction must contain the English word the image renders ` +
            `(${text.length} characters were extracted)`,
        ).toBe(true);

        await createNote(s, "Taranmis belge");
        const noteId = await selectedNoteId(s);
        // No `waitForSaved` after this: the write went through `note_update`,
        // not through the editor, so the autosave badge never leaves its
        // pre-edit state and the wait burns its whole budget before failing.
        // The IPC call is already durable when it returns.
        await seedEmbedIntoNote(s, `![[att:${attachmentId}|${FILENAME}]]`);

        // 1. Base capability: a word only the pixels contain.
        await searchAndOpenNote(s, IMAGE_WORD_EN, noteId);

        // 2. Turkish: the image reads `sirket`, the user types `şirket`. Only
        //    the index-side diacritic folding can bridge that.
        await searchAndOpenNote(s, QUERY_TR_ACCENTED, noteId);
      },
    );
  });
});
