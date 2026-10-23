// Clipboard copy feedback (myne-md/myne#390 + myne-md/myne#455).
//
// # What this pins that a unit test cannot
//
// The unit tests in `tests/lib/clipboard.test.ts` prove the policy module runs
// the right arm. They cannot prove that the arm reaches a surface: every one of
// them installs its own fake, and the defect this feature fixes was precisely
// that the real surfaces were missing or unreachable. Two of them concretely:
//
//   - The desktop `<Toaster />` mounted INSIDE the post-unlock editor screen, so
//     a `toast(...)` from vault creation drew nothing, silently, with no error
//     and no failing test anywhere.
//   - `AccountStep`'s confirmation was set and cleared only when the step
//     committed, so it read "Copied" for the rest of the step whatever the user
//     did next.
//
// Both are DOM facts about the real binary, which is what this file is for.
//
// # What it deliberately does NOT assert
//
// Anything about the system clipboard's contents. tauri-driver cannot read the
// OS pasteboard, and the properties that matter most on mobile (device
// confinement, OS-enforced expiry) have no CI-observable form at all, those are
// `docs/dev/clipboard-sensitivity-verification.md`, manual and honestly labelled.
// A scenario here that claimed to check them would be worse than none.

import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  openExportSubmenuItem,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";



const PASSWORD = "correct horse battery staple 42";

/**
 * The success string, by value.
 *
 * Duplicated from `locales/en/common.json` rather than imported, deliberately:
 * this suite drives the production BUNDLE, so importing the catalog would assert
 * the test's copy of the string against itself. A rewording that lands in the
 * catalog and not here fails this scenario, which is the correct outcome for a
 * string the user reads on the screen where the phrase is shown once.
 */
const KIT_COPIED =
  "The kit is on your clipboard. Myne clears it in 30 seconds, even if you move on, as long as the app keeps running.";

/** The SAVE success string on the desktop's dialog arm (myne-md/myne#522).
 *
 *  Duplicated for the same reason as `KIT_COPIED`, and asserted by EQUALITY
 *  for one more: this screen has two affordances sharing one status line, and
 *  the defect being pinned is a save rendering the COPY sentence. "Something
 *  appeared" passes that; the wrong sentence does not. */
const KIT_SAVED =
  "Saved. It is a plain text file holding both secrets, so keep it somewhere only you can read.";

describeE2E("cb1 the recovery kit reports its copy, and says which outcome (myne#390)", () => {
  it("says nothing before the copy, and the SUCCESS string after it", async () => {
    // Vault-count precondition: 2, and that is the re-site (myne-md/myne#911
    // task 6). This scenario's subject is the KIT's copy feedback, and a
    // person-born vault has no kit: the first run puts the phrase on the
    // identity ceremony instead. Seeding two vaults and creating a third from
    // the PICKER keeps the subject on the same component with the same ids,
    // because the picker entry is the legacy birth (no identity on this device,
    // so creation still mints a vault phrase).
    await scenario(
      "cb1-phrase-copy-reports-outcome",
      {
        seed: (appDataDir) => {
          seedVault(appDataDir, { password: "e2e-cb1-vault-a-pw" });
          seedVault(appDataDir, { password: "e2e-cb1-vault-b-pw" });
        },
      },
      async (app) => {
        const s = app.session;

        // Boot lands on the >=2-vault picker; "create another" is the legacy
        // route. The briefing is first-run-only, so there is none to acknowledge.
        await s.byTestId("picker.root", { timeoutMs: 20_000 });
        await (await s.byTestId("picker.create-cta")).click();

        // The vault-name step (myne-md/myne#468) sits between the briefing and the
        // password. Named rather than skipped, because the name is the kit sheet's
        // header and part of the file the save half below writes.
        await (await s.byTestId("create.name-input", { timeoutMs: 10_000 })).sendKeys(
          "E2E Kasa",
        );
        await (await s.byTestId("create.name-continue")).click();

        await (await s.byTestId("create.password-input", { timeoutMs: 10_000 })).sendKeys(
          PASSWORD,
        );
        await (await s.byTestId("create.confirm-input")).sendKeys(PASSWORD);
        const submit = await s.byTestId("create.submit");
        await s.waitUntil(() => submit.enabled(), {
          label: "password submit enabled",
          timeoutMs: 15_000,
        });
        await submit.click();

        // Recovery-kit step. Reveal, copy, and assert the confirmation APPEARS:
        // this surface reported nothing at all before myne#390, on the one screen
        // where the phrase is shown once.
        await s.byTestId("create.phrase-grid", { timeoutMs: 120_000 });
        await (await s.byTestId("create.phrase-reveal")).click();

        // The region exists BEFORE any copy and is empty. Both halves matter: a
        // live region that is only inserted once there is something to say cannot
        // announce it, because a screen reader watches a region it already knows
        // about. This is the half that is easy to get wrong and impossible to see.
        const status = await s.byTestId("create.kit-action-status", {
          timeoutMs: 10_000,
        });
        expect((await status.text()).trim()).toBe("");

        // Press Copy. Before myne#390 this screen changed NOTHING on either
        // outcome, which is the defect: a failed copy looked exactly like a
        // successful one on the screen where the phrase is shown once.
        await (await s.byTestId("create.kit-copy")).click();

        // Asserted by EQUALITY against the success string, not by "something
        // appeared". An earlier version of this checked only that the region was
        // non-empty, which passes identically for `copied` and `copyFailed`, so
        // the concrete regression this branch fixes on the sibling client
        // (myne#455: the account-number Copy reported failure on every tap, on
        // every device, for as long as it shipped) would have passed it unchanged.
        // Distinguishing the two outcomes IS the feature.
        await s.waitUntil(
          async () => ((await status.text()).trim() === KIT_COPIED ? true : null),
          { label: "kit copy reports SUCCESS, not merely an outcome", timeoutMs: 10_000 },
        );

        // ---- the SAVE half (myne-md/myne#522) --------------------------------
        //
        // Save as file reported NOTHING on either outcome until this issue: it
        // succeeded silently and it failed silently, on the screen the copy half
        // above exists for. Worse than a generic missing toast, because the
        // failed-copy string this scenario just asserted reads `Couldn't copy.
        // Use "Save as file" instead.` and named the silent path as the recovery.
        //
        // The native save dialog is not driveable by WebDriver, so the sanctioned
        // page-seat interception is used (`e2e/AGENTS.md`, "Page-seat dialog
        // interception"; `note-export.e2e.ts` ne3 is the template): the ONE IPC
        // URL for `plugin:dialog|save` gets a synthetic ok-Response carrying a
        // known path, every other URL reaches the native fetch, and everything
        // past the dialog is the real flow, including the Rust write.
        // Outside the vault tree: `secret-export|save_secret_text` re-validates
        // its destination and REFUSES the app-data / vault directory, which is the
        // narrow-seam guard this scenario must not fight.
        const saveDir = path.join(app.dataHome, "kit-saves");
        fs.mkdirSync(saveDir, { recursive: true });
        const savePath = path.join(saveDir, "e2e-kit.txt");
        const patched = await s.execute<boolean>(
          "if (window.__e2eDialogPatched !== true) {" +
            "  const saveUrl = window.__TAURI_INTERNALS__.convertFileSrc('plugin:dialog|save', 'ipc');" +
            "  const origFetch = window.fetch.bind(window);" +
            "  const wrapper = function (input, init) {" +
            "    const url = typeof input === 'string' ? input : input && input.url;" +
            "    if (url === saveUrl) {" +
            "      return Promise.resolve(new Response(JSON.stringify(window.__e2eDialogSavePath), {" +
            "        status: 200," +
            "        headers: { 'content-type': 'application/json', 'Tauri-Response': 'ok' }," +
            "      }));" +
            "    }" +
            "    return origFetch(input, init);" +
            "  };" +
            "  window.fetch = wrapper;" +
            // Assert the assignment TOOK. A non-writable `fetch` would silently
            // keep the real transport and open an undriveable native dialog.
            "  window.__e2eDialogPatched = window.fetch === wrapper;" +
            "}" +
            "window.__e2eDialogSavePath = arguments[0];" +
            "return window.__e2eDialogPatched === true;",
          [savePath],
        );
        expect(patched).toBe(true);

        await (await s.byTestId("create.kit-save")).click();

        // The SAVE sentence, by equality. The regression this pins is one status
        // line serving two affordances: before #522 the line either said nothing
        // at all, or (once it spoke) said the copy sentence for a save.
        await s.waitUntil(
          async () => ((await status.text()).trim() === KIT_SAVED ? true : null),
          {
            label: "kit save reports the SAVE sentence, not the copy one",
            timeoutMs: 15_000,
          },
        );

        // The sentence AND the file. Asserting only the sentence would pass a
        // build that announces success unconditionally, which is exactly the
        // defect this same issue fixed on the web arm.
        //
        // BOTH secrets, because the kit replaced two steps that saved two files
        // (myne-md/myne#468) and a save path still writing only the phrase would
        // report exactly this same success sentence. Shape only, never the
        // contents: SYNC-13 forbids a failure diff that could print the phrase, so
        // every assertion below is on a BOOLEAN.
        expect(fs.existsSync(savePath)).toBe(true);
        const kit: string = fs.readFileSync(savePath, "utf8");
        const lines: string[] = kit.split("\n").map((l: string) => l.trim());
        expect(
          lines.some((l: string) => l.split(/\s+/).length === 24),
          "no 24-word line in the saved kit",
        ).toBe(true);
        expect(
          lines.some((l: string) => /^MY(-[0-9A-HJKMNP-TV-Z]{4}){5}$/.test(l)),
          "no account number in the saved kit",
        ).toBe(true);
        expect(kit.includes("E2E Kasa"), "the kit does not name its vault").toBe(true);
    });
  });
});

/** The success toast's text, by value.
 *
 *  Duplicated from `locales/en/common.json` rather than imported for the same
 *  reason `PHRASE_COPIED` above is: this suite drives the production BUNDLE, so
 *  importing the catalog would assert the test's copy of the string against
 *  itself.
 */
const NOTE_COPIED = "Note text copied";

/** Right-click the sidebar row of `noteId` and return the export menu item. */
async function openExportMenuItem(s: Session, noteId: string) {
  const row = await s.waitForElement(
    testIdSelector("notes.row", { "data-note-id": noteId }),
  );
  await row.rightClick();
  return openExportSubmenuItem(s, "export-markdown");
}

describeE2E("cb2 a note copy toasts, from a stage the toast host only just reached", () => {
  // Vault-count precondition: 1 (weak KDF, export-suite notes).
  //
  // The pre-flight modal that carries Copy is raised ONLY when the note
  // references attachments (`src/notes/exportFlow.ts`), so this drives the
  // export suite's attachments-bearing note rather than a plain one.
  it("shows the success toast, and its text says SUCCESS", async () => {
    let seeded!: SeededVault;
    await scenario(
      "cb2-note-copy-toast",
      { seed: (dir) => void (seeded = seedVault(dir, { exportSuite: true })) },
      async (app) => {
        const s = app.session;
        const suite = seeded.exportSuite;
        if (suite === undefined) throw new Error("fixture was not seeded with exportSuite");

        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // Sidebar context menu, export entry, pre-flight modal, Copy.
        const item = await openExportMenuItem(s, suite.attachmentsNoteId);
        await item.click();
        await s.byTestId("export.modal", { timeoutMs: 15_000 });
        await (await s.byTestId("export.copy")).click();

        // The toast, asserted by EQUALITY rather than by "a toast appeared".
        // The failure arm renders into the same element, so a substring or a
        // presence check would pass for `copyFailed` too, and distinguishing the
        // two outcomes is the whole feature.
        // Re-fetched inside the poll rather than held: the toast element remounts
        // when the variant changes, so a held handle goes stale the moment the
        // failure arm renders instead of the success one, and the test then
        // reports a stale-element error rather than the text it actually found.
        // The point of this assertion is to name the wrong outcome, not to
        // notice that something moved.
        await s.byTestId("editor.toast-message", { timeoutMs: 10_000 });
        await s.waitUntil(
          async () => {
            const el = await s.byTestId("editor.toast-message");
            return (await el.text()).trim() === NOTE_COPIED ? true : null;
          },
          { label: `note copy toasts SUCCESS ("${NOTE_COPIED}")`, timeoutMs: 10_000 },
        );
      },
    );
  });
});
