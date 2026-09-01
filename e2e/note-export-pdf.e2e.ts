// Per-note "Export as PDF…" suite (MYND-255; pipeline `plugins/
// pdf_export`, emitter `src/dialect/html/emitNoteHtml.ts`, spec posture
// decisions.md 2026-06-11 export-suite + PDF-pipeline entries,
// threat-model TB3 egress exception).
//
// Pins the PDF-export flow through the production binary: the sidebar
// note-row context menu carries the PDF entry as a sibling of the
// markdown one, the `.pdf`-embedding fixture note raises the pre-export
// exclusion notice (the two load-bearing sentences + the excluded
// filename + free-exit cancel — BEFORE any dialog), and the capture
// command drives the hidden window through the platform's native
// print-to-PDF (Linux: WebKitPrintOperation print-to-file) landing a
// real `%PDF` document atomically.
//
// What is asserted vs not — the OS save dialog is the one native
// surface WebDriver cannot drive (the note-export.e2e.ts precedent):
//   - np1 drives the REAL UI up to the notice and cancels there (a free
//     exit — the dialog is never reached). The notice leg is the only
//     UI-new surface; the dialog→toast leg is shape-identical to the
//     markdown flow's ne3 and its glue is Vitest-pinned
//     (tests/notes/exportPdfFlow.test.ts).
//   - np2 bypasses the dialog entirely: `pdf_export_render` fires from
//     the page seat (`pageSeatInvoke` — production IPC, zero test
//     hooks) with a small static HTML payload at a container-temp
//     destination, and the produced FILE is asserted (`%PDF` magic,
//     nonempty, no `.capture-tmp` staging residue beside it).
//
// Fixture: `seedVault(..., { exportSuite: true })` — the generator
// (`e2e/fixture-gen`) pre-bakes, alongside the MYND-116 notes, a note
// whose single form-C embed is a `.pdf` attachment (`report.pdf`): the
// projection cannot include it, so the exclusion notice fires. Note
// plaintexts are scenario content, not credentials — SYNC-13 applies to
// passwords/phrases, which never appear in any assert below.
//
// KDF: weak generator fixtures (legal — unlock reads params from
// vault.meta; no production-KDF story here).

import { expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  openExportSubmenuItem,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";
import {
  EXPORT_PDF_EXCLUSION_SENTENCE,
  EXPORT_PDF_PLAIN_SENTENCE,
} from "../src/lib/load-bearing-copy";

/** Right-click the sidebar row of `noteId` and wait for the PDF export
 *  context-menu item. Returns the item handle. */
async function openPdfExportMenuItem(s: Session, noteId: string) {
  const row = await s.waitForElement(
    testIdSelector("notes.row", { "data-note-id": noteId }),
  );
  await row.rightClick();
  return openExportSubmenuItem(s, "export-pdf");
}

describeE2E("np1 pdf-embedding note raises the exclusion notice (MYND-255)", () => {
  // Vault-count precondition: 1 (weak KDF, export-suite notes).
  it("context menu carries the PDF entry; the notice shows the literal copy + excluded filename; cancel is free", async () => {
    let seeded!: SeededVault;
    await scenario(
      "np1-pdf-exclusion-notice",
      { seed: (dir) => void (seeded = seedVault(dir, { exportSuite: true })) },
      async (app) => {
        const s = app.session;
        const suite = seeded.exportSuite;
        if (suite === undefined) {
          throw new Error("fixture was not seeded with exportSuite: true");
        }
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // The live note row's context menu carries "Export as PDF…" as a
        // sibling of the markdown entry (data-item-id rides the existing
        // notes.context-menu-item scheme — no new testid).
        const item = await openPdfExportMenuItem(s, suite.pdfNoteId);
        expect(await item.text()).toBe("Export as PDF…");

        // Selecting it on the `.pdf`-embedding note runs the CHEAP
        // pre-flight scan (scanExcludedAttachments — no emitter import)
        // and raises the exclusion notice BEFORE any dialog; the heavy
        // projection happens only after a destination is confirmed.
        // This leg is fully driveable.
        await item.click();
        await s.byTestId("export.pdf-notice", { timeoutMs: 20_000 });

        // Load-bearing copy by FULL-literal equality (SYNC-8): the
        // egress sentence + the exclusion sentence render the
        // `load-bearing-copy.ts` constants verbatim, and the excluded
        // attachment's filename is listed.
        const [egress, exclusion, filename] = await s.execute<
          [string | null, string | null, string | null]
        >(
          'const ps = document.querySelectorAll(\'[data-testid="export.pdf-notice"] p\');' +
            "return [" +
            "  ps[0] ? ps[0].textContent : null," +
            "  ps[1] ? ps[1].textContent : null," +
            "  ps[2] ? ps[2].textContent : null," +
            "];",
        );
        expect(egress).toBe(EXPORT_PDF_PLAIN_SENTENCE);
        expect(exclusion).toBe(EXPORT_PDF_EXCLUSION_SENTENCE);
        expect(filename).toBe(suite.pdfAttachment.filename);

        // No toggle — exclusions aren't optional (product decision).
        expect(
          await s.execute<number>(
            "return document.querySelectorAll(" +
              "'[data-testid=\"export.pdf-notice\"] input[type=\"checkbox\"]'" +
              ").length;",
          ),
        ).toBe(0);

        // Cancel = free exit: notice unmounts, no dialog, nothing
        // invoked, nothing written anywhere.
        await (await s.byTestId("export.pdf-cancel")).click();
        await s.waitForGone(testIdSelector("export.pdf-notice"));
      },
    );
  });
});

describeE2E("np2 capture command lands a %PDF document atomically (MYND-255)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("page-seat pdf_export_render → hidden window → native print-to-PDF → nonempty %PDF file, no staging residue", async () => {
    let seeded!: SeededVault;
    await scenario(
      "np2-pdf-capture",
      { seed: (dir) => void (seeded = seedVault(dir)) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        const exportsDir = path.join(app.dataHome, "exports");
        fs.mkdirSync(exportsDir, { recursive: true });
        const destination = path.join(exportsDir, "capture-probe.pdf");

        // Dialog bypass: fire the render IPC from the page seat with a
        // small static payload (the emitter's golden coverage lives in
        // tests/dialect/html; this scenario pins the CAPTURE arm). The
        // budget covers hidden-window boot + render settle + the native
        // print operation's 30 s capture deadline.
        const exported = await pageSeatInvoke(
          s,
          "plugin:pdf-export|pdf_export_render",
          {
            html:
              '<h1 class="note-title">Capture Probe</h1>' +
              "<p>Static body line for the E2E capture probe.</p>",
            title: "Capture Probe",
            targetPath: destination,
            overwrite: true,
          },
          120_000,
        );
        if (exported.err !== undefined) {
          throw new Error("pdf export failed: " + JSON.stringify(exported.err));
        }

        // A real PDF landed: nonempty, `%PDF` magic.
        const bytes = fs.readFileSync(destination);
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes.subarray(0, 4).toString("ascii")).toBe("%PDF");

        // Atomic publish: no `.capture-tmp` staging sibling (nor any
        // other residue) beside the destination.
        expect(fs.readdirSync(exportsDir)).toEqual(["capture-probe.pdf"]);
      },
    );
  });
});
