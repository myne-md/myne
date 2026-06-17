// Per-note "Export as Plain Text…" suite (note-export MYND-340; backend
// reuses `note_export_html` as the shared verbatim text-write command,
// emitter `src/dialect/text/emitNoteText.ts`, threat-model TB3 egress
// exception).
//
// Pins the plain-text export flow through the production binary: the
// sidebar note-row context menu carries the plain-text entry as a sibling
// of the markdown / PDF / HTML ones, the write command lands a stripped
// plain-text file (no attachments — TXT is a lossy projection, never a
// sidecar export), and the completed UI flow lands the success toast.
//
// What is asserted vs not — the OS save dialog is the one native surface
// WebDriver cannot drive (the note-export.e2e.ts ne3 precedent):
//   - tt1 bypasses the dialog: the write IPC fires from the page seat
//     (`pageSeatInvoke`) with a small static text payload at a
//     container-temp destination, and the exported FILE is asserted (the
//     stripper's golden coverage lives in tests/dialect/text).
//   - tt2 completes the REAL UI flow (menu click → flow → write IPC →
//     toast) by stubbing ONLY the `plugin:dialog|save` round-trip from
//     the page seat (the ne3 fetch-seam pattern).
//
// Fixture: `seedVault(..., { exportSuite: true })` — reuses the MYND-116
// suite's plain note. Note plaintexts are scenario content, not
// credentials (SYNC-13).
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
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const TXT_ITEM_SELECTOR = testIdSelector("notes.context-menu-item", {
  "data-item-id": "export-txt",
});

/** A small static stripped plain-text payload — the emitter's full golden
 *  coverage lives in tests/dialect/text; this pins the Rust WRITE arm. */
const STATIC_TEXT = "Title\n\nplain body line\n";

function seededExportSuite(seeded: SeededVault) {
  const suite = seeded.exportSuite;
  if (suite === undefined) {
    throw new Error("fixture was not seeded with exportSuite: true");
  }
  return suite;
}

/** Right-click the sidebar row of `noteId` and wait for the plain-text
 *  export context-menu item. Returns the item handle. */
async function openTxtExportMenuItem(s: Session, noteId: string) {
  const row = await s.waitForElement(
    testIdSelector("notes.row", { "data-note-id": noteId }),
  );
  await row.rightClick();
  return s.waitForElement(TXT_ITEM_SELECTOR);
}

describeE2E("tt1 plain-text export writes the stripped file (MYND-340)", () => {
  // Vault-count precondition: 1 (weak KDF, export-suite notes).
  it("context menu carries the plain-text entry; the write IPC lands the exact text atomically", async () => {
    let seeded!: SeededVault;
    await scenario(
      "tt1-txt-write",
      { seed: (dir) => void (seeded = seedVault(dir, { exportSuite: true })) },
      async (app) => {
        const s = app.session;
        const suite = seededExportSuite(seeded);
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        const item = await openTxtExportMenuItem(s, suite.plainNoteId);
        expect(await item.text()).toBe("Export as Plain Text…");
        // Esc-dismiss WITHOUT selecting (clicking opens the undriveable
        // save dialog; tt2 covers the UI path with the dialog stubbed).
        await s.execute(
          'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))',
        );
        await s.waitForGone(TXT_ITEM_SELECTOR);

        // Dialog bypass: fire the (shared) text-write IPC from the page
        // seat at a container-temp destination with the static text.
        const exportsDir = path.join(app.dataHome, "exports");
        fs.mkdirSync(exportsDir, { recursive: true });
        const destination = path.join(exportsDir, "probe.txt");
        const exported = await pageSeatInvoke(
          s,
          "plugin:notes|note_export_html",
          { html: STATIC_TEXT, targetPath: destination, overwrite: true },
          30_000,
        );
        if (exported.err !== undefined) {
          throw new Error("txt export failed: " + JSON.stringify(exported.err));
        }

        // The exact text landed; atomic publish leaves no residue.
        expect(fs.readFileSync(destination, "utf8")).toBe(STATIC_TEXT);
        expect(fs.readdirSync(exportsDir)).toEqual(["probe.txt"]);
      },
    );
  });
});

describeE2E("tt2 plain-text export UI flow lands the success toast (MYND-340)", () => {
  // Vault-count precondition: 1 (weak KDF, export-suite notes).
  it("menu click → flow → write IPC → toast (dialog stubbed at the fetch seam)", async () => {
    let seeded!: SeededVault;
    await scenario(
      "tt2-txt-ui-flow",
      { seed: (dir) => void (seeded = seedVault(dir, { exportSuite: true })) },
      async (app) => {
        const s = app.session;
        const suite = seededExportSuite(seeded);
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        const exportsDir = path.join(app.dataHome, "exports");
        fs.mkdirSync(exportsDir, { recursive: true });
        const destination = path.join(exportsDir, "flow-export.txt");

        // Stub ONLY the `plugin:dialog|save` round-trip (the ne3 pattern).
        const patched = await s.execute<boolean>(
          "if (window.__e2eDialogPatched !== true) {" +
            "  const saveUrl = window.__TAURI_INTERNALS__.convertFileSrc('plugin:dialog|save', 'ipc');" +
            "  const origFetch = window.fetch.bind(window);" +
            "  const wrapper = function (input, init) {" +
            "    const url = typeof input === 'string' ? input : input && input.url;" +
            "    if (url === saveUrl) {" +
            "      window.__e2eDialogSaveCalls += 1;" +
            "      return Promise.resolve(new Response(JSON.stringify(window.__e2eDialogSavePath), {" +
            "        status: 200," +
            "        headers: { 'content-type': 'application/json', 'Tauri-Response': 'ok' }," +
            "      }));" +
            "    }" +
            "    return origFetch(input, init);" +
            "  };" +
            "  window.fetch = wrapper;" +
            "  window.__e2eDialogSaveCalls = 0;" +
            "  window.__e2eDialogPatched = window.fetch === wrapper;" +
            "}" +
            "window.__e2eDialogSavePath = arguments[0];" +
            "return window.__e2eDialogPatched === true;",
          [destination],
        );
        expect(patched).toBe(true);

        // The real UI path: context menu → "Export as Plain Text…". TXT
        // has no pre-flight modal (no attachments) — straight into the
        // stubbed dialog, then the real strip + write.
        const item = await openTxtExportMenuItem(s, suite.plainNoteId);
        await item.click();

        const toast = await s.waitUntil(
          async () =>
            await s.execute<{ message: string; action: string } | null>(
              'const t = document.querySelector(\'[data-testid="editor.toast"]\');' +
                "if (!t) return null;" +
                "const span = t.querySelector('span');" +
                'const btn = t.querySelector(\'[data-testid="editor.toast-action"]\');' +
                "return {" +
                "  message: span && span.textContent ? span.textContent : ''," +
                "  action: btn && btn.textContent ? btn.textContent : ''," +
                "};",
            ),
          { label: "txt export success toast", timeoutMs: 30_000 },
        );
        expect(toast.message).toBe("Exported to flow-export.txt");
        expect(toast.action).toBe("Show in folder");

        // The dialog stub was consulted exactly once, and a real .txt
        // landed at the dialog-chosen path (ending with a trailing
        // newline — a well-formed POSIX text file).
        expect(await s.execute<number>("return window.__e2eDialogSaveCalls")).toBe(1);
        const text = fs.readFileSync(destination, "utf8");
        expect(text.endsWith("\n")).toBe(true);
      },
    );
  });
});
