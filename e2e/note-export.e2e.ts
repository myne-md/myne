// Per-note "Export as Markdown…" suite (MYND-116; backend MYND-115,
// spec markdown-dialect.md §6 export transform, threat-model TB3 egress
// exception).
//
// Pins the note-export flow through the production binary: the sidebar
// note-row context menu carries the export entry, the attachments-bearing
// note raises the pre-flight mini-modal (count + the load-bearing egress
// copy + toggle + free-exit cancel), the export IPCs write byte-verbatim
// plaintext (no-attachments note) and the §6 embed rewrite + " (1)"
// suffix-dedup (attachments note), and the completed flow lands the
// success toast with its "Show in folder" action.
//
// What is asserted vs not — the OS save dialog is the one native surface
// WebDriver cannot drive (the backup-restore precedent):
//   - ne1/ne2 bypass it entirely: the export IPCs fire from the page seat
//     (`pageSeatInvoke` — production IPC, zero test hooks) at a
//     container-temp destination, and the exported FILES are asserted.
//   - ne3 completes the REAL UI flow (menu click → pre-flight scan →
//     export IPC → toast) by stubbing ONLY the `plugin:dialog|save`
//     round-trip from the page seat so the dialog resolves a known
//     path; production code unmodified. `__TAURI_INTERNALS__` is
//     immutable on this build (every IPC-path own property — `invoke`,
//     `ipc`, `postMessage` — is non-writable + non-configurable, and
//     the window binding itself is non-configurable), so the wrapper
//     lands on the one writable seam the transport calls: the global
//     `fetch` that carries Tauri's custom-protocol IPC. Only the exact
//     `plugin:dialog|save` IPC URL is intercepted; every other request
//     reaches the native fetch. Everything else in the flow is
//     production code end-to-end.
//   - The toast's "Show in folder" action asserts PRESENCE + label only;
//     the OS reveal itself is never clicked (it opens a native file
//     manager the harness can't observe).
//
// Fixture: `seedVault(..., { exportSuite: true })` — the generator
// (`e2e/fixture-gen`, protocol public API only) pre-bakes a note WITHOUT
// attachments (the byte-verbatim oracle) and a note WITH two canonical
// form-C embeds whose catalog filenames collide (dedup bait), plus the
// MYA1 blobs + MYC1 catalog. Note plaintexts are scenario content, not
// credentials — SYNC-13 applies to passwords/phrases, which never appear
// in any assert below.
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
  EXPORT_ATTACHMENTS_PLACEMENT_SUBLABEL,
  EXPORT_PLAIN_MARKDOWN_SENTENCE,
} from "../src/lib/load-bearing-copy";

const EXPORT_ITEM_SELECTOR = testIdSelector("notes.context-menu-item", {
  "data-item-id": "export-markdown",
});

/** `" (n)"` suffix before the extension — the export-side dedup shape
 *  (`suffixed_filename` in the notes plugin). */
function suffixed(filename: string, n: number): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return `${filename} (${n})`;
  return `${filename.slice(0, dot)} (${n})${filename.slice(dot)}`;
}

/** Right-click the sidebar row of `noteId` and wait for the export
 *  context-menu item. Returns the item handle. */
async function openExportMenuItem(s: Session, noteId: string) {
  const row = await s.waitForElement(
    testIdSelector("notes.row", { "data-note-id": noteId }),
  );
  await row.rightClick();
  // One level down since myne-md/myne#611: the four formats live under one
  // `Export…` row rather than four top-level ones.
  return openExportSubmenuItem(s, "export-markdown");
}

function seededExportSuite(seeded: SeededVault) {
  const suite = seeded.exportSuite;
  if (suite === undefined) {
    throw new Error("fixture was not seeded with exportSuite: true");
  }
  return suite;
}

describeE2E("ne1 no-attachments export is byte-verbatim (MYND-116)", () => {
  // Vault-count precondition: 1 (weak KDF, export-suite notes).
  it("context menu carries the export entry; the export IPC writes the exact plaintext", async () => {
    let seeded!: SeededVault;
    await scenario(
      "ne1-verbatim-export",
      { seed: (dir) => void (seeded = seedVault(dir, { exportSuite: true })) },
      async (app) => {
        const s = app.session;
        const suite = seededExportSuite(seeded);
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // The live note row's context menu carries the export entry
        // (data-item-id rides the existing notes.context-menu-item
        // scheme — no new testid).
        //
        // myne-md/myne#611 split the single "Export as Markdown…" row into an
        // `Export…` parent and a per-format leaf, so the sentence the user
        // reads now spans TWO rows. Both halves are asserted here: updating
        // only the leaf would leave the word "Export" covered by nothing,
        // which is how this assertion came to name a string the product had
        // already stopped rendering.
        const item = await openExportMenuItem(s, suite.plainNoteId);
        const exportParent = await s.waitForElement(
          testIdSelector("notes.context-menu-item", { "data-item-id": "export" }),
        );
        expect(await exportParent.text()).toBe("Export…");
        expect(await item.text()).toBe("Markdown");
        // Esc-dismiss WITHOUT selecting: clicking would open the native
        // save dialog WebDriver cannot drive (ne3 covers the UI path
        // with the dialog stubbed).
        await s.execute(
          'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))',
        );
        await s.waitForGone(EXPORT_ITEM_SELECTOR);

        // Dialog bypass: fire the export IPC from the page seat at a
        // container-temp destination (the backup-restore pattern).
        const exportsDir = path.join(app.dataHome, "exports");
        fs.mkdirSync(exportsDir, { recursive: true });
        const destination = path.join(exportsDir, "plain-verbatim.md");
        const exported = await pageSeatInvoke(
          s,
          "plugin:notes|note_export_as_markdown",
          { noteId: suite.plainNoteId, targetPath: destination, overwrite: true },
          30_000,
        );
        if (exported.err !== undefined) {
          throw new Error("export failed: " + JSON.stringify(exported.err));
        }

        // Byte-verbatim: the exported file IS the fixture plaintext —
        // frontmatter included, zero post-processing.
        expect(fs.readFileSync(destination, "utf8")).toBe(suite.plainNotePlaintext);
      },
    );
  });
});

describeE2E("ne2 attachments pre-flight modal + embed-rewrite export (MYND-116)", () => {
  // Vault-count precondition: 1 (weak KDF, export-suite notes).
  it("modal shows count + the load-bearing copy; cancel is free; the export rewrites embeds and dedups filenames", async () => {
    let seeded!: SeededVault;
    await scenario(
      "ne2-attachments-modal",
      { seed: (dir) => void (seeded = seedVault(dir, { exportSuite: true })) },
      async (app) => {
        const s = app.session;
        const suite = seededExportSuite(seeded);
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        const exportsDir = path.join(app.dataHome, "exports");
        fs.mkdirSync(exportsDir, { recursive: true });

        // Selecting the export entry on the attachments-bearing note
        // raises the pre-flight mini-modal BEFORE any dialog — this leg
        // of the UI path is fully driveable.
        const item = await openExportMenuItem(s, suite.attachmentsNoteId);
        await item.click();
        const modal = await s.byTestId("export.modal", { timeoutMs: 15_000 });

        // De-duplicated ref count (two distinct ids → 2).
        expect(await modal.textContent()).toContain("Include 2 attachments");

        // Load-bearing copy by FULL-literal equality (SYNC-8): the
        // egress sentence and the placement sub-label render the
        // `load-bearing-copy.ts` constants verbatim — a collapse fails
        // the strict equality, not just a substring probe.
        const [sentence, subLabel] = await s.execute<[string, string]>(
          'const ps = document.querySelectorAll(\'[data-testid="export.modal"] p\');' +
            "return [ps[0] ? ps[0].textContent : null, ps[1] ? ps[1].textContent : null];",
        );
        expect(sentence).toBe(EXPORT_PLAIN_MARKDOWN_SENTENCE);
        expect(subLabel).toBe(EXPORT_ATTACHMENTS_PLACEMENT_SUBLABEL);

        // Toggle defaults OFF on open; clicking flips it ON.
        const toggle = await s.byTestId("export.include-attachments-toggle");
        expect(await toggle.property<boolean>("checked")).toBe(false);
        await toggle.click();
        expect(await toggle.property<boolean>("checked")).toBe(true);

        // Cancel = free exit: modal unmounts, no dialog, nothing written.
        await (await s.byTestId("export.cancel")).click();
        await s.waitForGone(testIdSelector("export.modal"));
        expect(fs.readdirSync(exportsDir)).toEqual([]);

        // Dialog bypass for the attachments-included export: one IPC
        // writes the note + both attachments (all-or-nothing).
        const noteFilename = "Attachments Note.md";
        const exported = await pageSeatInvoke(
          s,
          "plugin:notes|note_export_attachments",
          {
            noteId: suite.attachmentsNoteId,
            targetDir: exportsDir,
            noteFilename,
            overwrite: true,
          },
          30_000,
        );
        if (exported.err !== undefined) {
          throw new Error("export failed: " + JSON.stringify(exported.err));
        }
        expect(exported.ok).toBe(2);

        // The colliding catalog filenames dedup deterministically in
        // first-appearance order: `evidence.png`, then `evidence (1).png`
        // — each carrying its attachment's exact plaintext bytes.
        const [first, second] = suite.attachments;
        const firstName = first.filename;
        const secondName = suffixed(second.filename, 1);
        expect(fs.readFileSync(path.join(exportsDir, firstName), "utf8")).toBe(
          first.contents,
        );
        expect(fs.readFileSync(path.join(exportsDir, secondName), "utf8")).toBe(
          second.contents,
        );

        // The §6 sanctioned export transform: each form-C embed is
        // rewritten to `![[<final-filename>]]`; every byte outside the
        // embed spans is preserved.
        const expectedNote = suite.attachmentsNotePlaintext
          .replaceAll(`![[att:${first.idHex}|${first.filename}]]`, `![[${firstName}]]`)
          .replaceAll(`![[att:${second.idHex}|${second.filename}]]`, `![[${secondName}]]`);
        expect(fs.readFileSync(path.join(exportsDir, noteFilename), "utf8")).toBe(
          expectedNote,
        );
      },
    );
  });
});

describeE2E("ne3 UI flow lands the success toast (MYND-116)", () => {
  // Vault-count precondition: 1 (weak KDF, export-suite notes).
  it("menu click → flow → export IPC → toast with the filename + Show in folder action", async () => {
    let seeded!: SeededVault;
    await scenario(
      "ne3-ui-flow-toast",
      { seed: (dir) => void (seeded = seedVault(dir, { exportSuite: true })) },
      async (app) => {
        const s = app.session;
        const suite = seededExportSuite(seeded);
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        const exportsDir = path.join(app.dataHome, "exports");
        fs.mkdirSync(exportsDir, { recursive: true });
        const destination = path.join(exportsDir, "flow-export.md");

        // Stub ONLY the `plugin:dialog|save` round-trip: the native save
        // dialog is the one undriveable boundary. `__TAURI_INTERNALS__`
        // is immutable (`invoke`/`ipc`/`postMessage` are non-writable +
        // non-configurable own props; the window binding itself is
        // non-configurable), so the wrapper sits on the writable seam
        // the transport actually calls: the global `fetch` carrying the
        // custom-protocol IPC. The save command's exact IPC URL (the
        // same `convertFileSrc(cmd, 'ipc')` the transport computes) gets
        // a synthetic ok-Response with the known path; every other URL
        // reaches the native fetch — production code untouched, and the
        // export IPC + toast below are the real flow end-to-end.
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
            // Verify the assignment actually took (a non-writable fetch
            // would silently keep the real transport — and the click
            // below would open a real, undriveable dialog).
            "  window.__e2eDialogPatched = window.fetch === wrapper;" +
            "}" +
            "window.__e2eDialogSavePath = arguments[0];" +
            "return window.__e2eDialogPatched === true;",
          [destination],
        );
        expect(patched).toBe(true);

        // The real UI path: context menu → "Export as Markdown…". The
        // no-attachments note goes straight past the pre-flight scan
        // (no modal) into the (stubbed) dialog, then the real export.
        const item = await openExportMenuItem(s, suite.plainNoteId);
        await item.click();

        // One atomic in-page read of message + action label: the toast
        // auto-dismisses (6 s with an action), so both texts are captured in a single
        // poll instead of two racy element round-trips.
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
          { label: "export success toast", timeoutMs: 20_000 },
        );
        expect(toast.message).toBe("Exported to flow-export.md");
        // "Show in folder" PRESENCE + label only — the OS reveal is
        // never clicked (native file manager, unobservable here).
        expect(toast.action).toBe("Show in folder");

        // The dialog stub was consulted exactly once, and the flow's
        // export wrote the exact plaintext at the dialog-chosen path.
        expect(await s.execute<number>("return window.__e2eDialogSaveCalls")).toBe(1);
        expect(fs.readFileSync(destination, "utf8")).toBe(suite.plainNotePlaintext);
      },
    );
  });
});

describeE2E("ne4 Copy puts the note text on the clipboard and toasts (MYND-643)", () => {
  // Vault-count precondition: 1 (weak KDF, export-suite notes).
  it("export modal → icon-only Copy → success toast (no OS dialog on this path)", async () => {
    let seeded!: SeededVault;
    await scenario(
      "ne4-copy-toast",
      { seed: (dir) => void (seeded = seedVault(dir, { exportSuite: true })) },
      async (app) => {
        const s = app.session;
        const suite = seededExportSuite(seeded);
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // The icon-only Copy button lives inside the export pre-flight modal,
        // which the ATTACHMENTS-bearing note raises (the no-attachments note
        // skips straight to the save dialog). Copy is text-only — the
        // attachment count is irrelevant to what lands on the clipboard.
        const item = await openExportMenuItem(s, suite.attachmentsNoteId);
        await item.click();
        await s.byTestId("export.modal", { timeoutMs: 15_000 });

        // Copy has no OS dialog (a clipboard is not a file), so unlike export
        // this whole path is driveable end-to-end through the production
        // binary. onCopy strips frontmatter, writes the body to the clipboard
        // and — because a clipboard write has no visible result — MUST toast.
        // The frontmatter-strip golden lives in the tests/notes/copyNoteMarkdown
        // unit suite; here we pin the UI flow reaching the success toast.
        await (await s.byTestId("export.copy")).click();

        const message = await s.waitUntil(
          async () =>
            await s.execute<string | null>(
              'const t = document.querySelector(\'[data-testid="editor.toast"]\');' +
                "if (!t) return null;" +
                "const span = t.querySelector('[data-testid=\"editor.toast-message\"]');" +
                "return span && span.textContent ? span.textContent : null;",
            ),
          { label: "copy success toast", timeoutMs: 20_000 },
        );
        expect(message).toBe("Note text copied");
      },
    );
  });
});
