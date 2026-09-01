// Per-note "Export as HTML…" suite (note-export MYND-340; backend
// `note_export_html` / `note_export_html_attachments` in plugins/notes,
// assembler `src/dialect/html/htmlDocument.ts`, spec markdown-dialect.md
// §6 export transform — HTML arm, threat-model TB3 egress exception).
//
// Pins the HTML-export flow through the production binary: the sidebar
// note-row context menu carries the HTML entry as a sibling of the
// markdown / PDF ones, the no-attachments path writes a standalone
// `<html>` document, the attachments path writes the `.html` + image
// sidecars with `attachment://<id>` srcs rewritten to relative filenames,
// and the completed UI flow lands the success toast.
//
// What is asserted vs not — the OS save dialog is the one native surface
// WebDriver cannot drive (the note-export.e2e.ts ne3 precedent):
//   - hh1/hh2 bypass the dialog: the export IPCs fire from the page seat
//     (`pageSeatInvoke` — production IPC, zero test hooks) at a
//     container-temp destination, and the exported FILES are asserted.
//     The composed HTML payload is a small static document (the
//     assembler's golden coverage lives in tests/dialect/html); these
//     pin the Rust WRITE + §6 src-rewrite arm.
//   - hh3 completes the REAL UI flow (menu click → flow → write IPC →
//     toast) by stubbing ONLY the `plugin:dialog|save` round-trip from
//     the page seat (the ne3 fetch-seam pattern); production code
//     untouched, everything past the dialog is the real flow.
//
// Fixture: `seedVault(..., { exportSuite: true })` — reuses the MYND-116
// suite's plain note + the two-colliding-image attachments note. Note
// plaintexts are scenario content, not credentials (SYNC-13).
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

const HTML_ITEM_SELECTOR = testIdSelector("notes.context-menu-item", {
  "data-item-id": "export-html",
});

/** A small static standalone HTML document — the assembler's full golden
 *  coverage lives in tests/dialect/html; this is the WRITE-arm payload. */
const STATIC_DOC =
  "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
  "<title>Capture</title></head><body><h1>HTML Probe</h1>" +
  "<p>Static body for the E2E HTML write probe.</p></body></html>\n";

function seededExportSuite(seeded: SeededVault) {
  const suite = seeded.exportSuite;
  if (suite === undefined) {
    throw new Error("fixture was not seeded with exportSuite: true");
  }
  return suite;
}

/** Right-click the sidebar row of `noteId` and wait for the HTML export
 *  context-menu item. Returns the item handle. */
async function openHtmlExportMenuItem(s: Session, noteId: string) {
  const row = await s.waitForElement(
    testIdSelector("notes.row", { "data-note-id": noteId }),
  );
  await row.rightClick();
  return openExportSubmenuItem(s, "export-html");
}

describeE2E("hh1 no-attachments HTML export writes a standalone doc (MYND-340)", () => {
  // Vault-count precondition: 1 (weak KDF, export-suite notes).
  it("context menu carries the HTML entry; note_export_html writes the verbatim document atomically", async () => {
    let seeded!: SeededVault;
    await scenario(
      "hh1-html-write",
      { seed: (dir) => void (seeded = seedVault(dir, { exportSuite: true })) },
      async (app) => {
        const s = app.session;
        const suite = seededExportSuite(seeded);
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // The live note row's context menu carries "Export as HTML…"
        // (data-item-id rides the existing notes.context-menu-item scheme
        // — no new testid).
        const item = await openHtmlExportMenuItem(s, suite.plainNoteId);
        expect(await item.text()).toBe("Export as HTML…");
        // Esc-dismiss WITHOUT selecting (clicking opens the undriveable
        // save dialog; hh3 covers the UI path with the dialog stubbed).
        await s.execute(
          'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))',
        );
        await s.waitForGone(HTML_ITEM_SELECTOR);

        // Dialog bypass: fire the write IPC from the page seat at a
        // container-temp destination with the static composed doc.
        const exportsDir = path.join(app.dataHome, "exports");
        fs.mkdirSync(exportsDir, { recursive: true });
        const destination = path.join(exportsDir, "probe.html");
        const exported = await pageSeatInvoke(
          s,
          "plugin:notes|note_export_html",
          { html: STATIC_DOC, targetPath: destination, overwrite: true },
          30_000,
        );
        if (exported.err !== undefined) {
          throw new Error("html export failed: " + JSON.stringify(exported.err));
        }

        // The exact composed document landed; atomic publish leaves no
        // staging residue beside it.
        expect(fs.readFileSync(destination, "utf8")).toBe(STATIC_DOC);
        expect(fs.readdirSync(exportsDir)).toEqual(["probe.html"]);
      },
    );
  });
});

describeE2E("hh2 attachments HTML export writes sidecars + rewrites srcs (MYND-340)", () => {
  // Vault-count precondition: 1 (weak KDF, export-suite notes).
  it("note_export_html_attachments writes the .html + image sidecars with relative refs", async () => {
    let seeded!: SeededVault;
    await scenario(
      "hh2-html-attachments",
      { seed: (dir) => void (seeded = seedVault(dir, { exportSuite: true })) },
      async (app) => {
        const s = app.session;
        const suite = seededExportSuite(seeded);
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        const exportsDir = path.join(app.dataHome, "html-exports");
        fs.mkdirSync(exportsDir, { recursive: true });

        // A composed HTML doc that references BOTH suite image
        // attachments via the emitter's `attachment://<id>` <img> form.
        // The two share a catalog filename, so the second sidecar dedups
        // to `"<name> (1)"` and BOTH srcs are rewritten to their final
        // relative names (the §6 export transform, HTML arm).
        const [a, b] = suite.attachments;
        if (a === undefined || b === undefined) {
          throw new Error("export suite missing the two image attachments");
        }
        const doc =
          "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
          "<title>Pics</title></head><body>" +
          `<img class="att-image" src="attachment://${a.idHex}" alt="a">` +
          `<img class="att-image" src="attachment://${b.idHex}" alt="b">` +
          "</body></html>\n";

        const noteFilename = "Pics.html";
        const exported = await pageSeatInvoke(
          s,
          "plugin:notes|note_export_html_attachments",
          {
            noteId: suite.attachmentsNoteId,
            html: doc,
            targetDir: exportsDir,
            noteFilename,
            overwrite: true,
          },
          30_000,
        );
        if (exported.err !== undefined) {
          throw new Error(
            "html attachments export failed: " + JSON.stringify(exported.err),
          );
        }
        // Two image sidecars written.
        expect(exported.ok).toBe(2);

        // The .html plus the two deduped image sidecars are present.
        const written = fs.readdirSync(exportsDir).sort();
        const dot = a.filename.lastIndexOf(".");
        const second =
          dot > 0
            ? `${a.filename.slice(0, dot)} (1)${a.filename.slice(dot)}`
            : `${a.filename} (1)`;
        expect(written).toEqual([noteFilename, a.filename, second].sort());

        // The HTML's attachment:// srcs were rewritten to the relative
        // sidecar filenames (percent-encoded for the URL-shaped src); the
        // in-app-only `attachment://` scheme no longer appears.
        const html = fs.readFileSync(path.join(exportsDir, noteFilename), "utf8");
        expect(html).not.toContain("attachment://");
        expect(html).toContain(`src="${a.filename}"`);
        // The deduped second name carries a space → percent-encoded.
        expect(html).toContain(second.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29"));
      },
    );
  });
});

describeE2E("hh3 HTML export UI flow lands the success toast (MYND-340)", () => {
  // Vault-count precondition: 1 (weak KDF, export-suite notes).
  it("menu click → flow → write IPC → toast (dialog stubbed at the fetch seam)", async () => {
    let seeded!: SeededVault;
    await scenario(
      "hh3-html-ui-flow",
      { seed: (dir) => void (seeded = seedVault(dir, { exportSuite: true })) },
      async (app) => {
        const s = app.session;
        const suite = seededExportSuite(seeded);
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        const exportsDir = path.join(app.dataHome, "exports");
        fs.mkdirSync(exportsDir, { recursive: true });
        const destination = path.join(exportsDir, "flow-export.html");

        // Stub ONLY the `plugin:dialog|save` round-trip (the ne3 pattern):
        // `__TAURI_INTERNALS__` is immutable, so the wrapper sits on the
        // global `fetch` carrying the custom-protocol IPC; only the save
        // command's exact IPC URL is intercepted, every other URL reaches
        // the native fetch — production code untouched.
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

        // The real UI path: context menu → "Export as HTML…". The plain
        // (no-image) note goes straight past the pre-flight scan (no
        // modal) into the stubbed dialog, then the real compose + write.
        const item = await openHtmlExportMenuItem(s, suite.plainNoteId);
        await item.click();

        const toast = await s.waitUntil(
          async () =>
            await s.execute<{ message: string; action: string } | null>(
              'const t = document.querySelector(\'[data-testid="editor.toast"]\');' +
                "if (!t) return null;" +
                "const span = t.querySelector('[data-testid=\"editor.toast-message\"]');" +
                'const btn = t.querySelector(\'[data-testid="editor.toast-action"]\');' +
                "return {" +
                "  message: span && span.textContent ? span.textContent : ''," +
                "  action: btn && btn.textContent ? btn.textContent : ''," +
                "};",
            ),
          { label: "html export success toast", timeoutMs: 30_000 },
        );
        expect(toast.message).toBe("Exported to flow-export.html");
        expect(toast.action).toBe("Show in folder");

        // The dialog stub was consulted exactly once, and a real
        // standalone HTML document landed at the dialog-chosen path.
        expect(await s.execute<number>("return window.__e2eDialogSaveCalls")).toBe(1);
        const html = fs.readFileSync(destination, "utf8");
        expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
        // The FULL opening tag, not a bare `<body>`. The exporter emits
        // `<body dir="auto">` (`src/dialect/html/htmlDocument.ts`), and asserting
        // the substring `<body>` matched nothing once that attribute landed —
        // so this failed on a document that was perfectly well-formed. Pinning
        // the whole tag both fixes that and makes `dir="auto"` a thing the test
        // protects: it is what makes an exported RTL note read correctly
        // outside the app, and nothing else asserted it.
        expect(html).toContain('<body dir="auto">');
      },
    );
  });
});
