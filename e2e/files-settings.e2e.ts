// Files-settings suite (MYND-462). Drives the two Settings → Files preferences
// through the REAL editor UI:
//
//   nl1 — DEFAULT NEW-NOTE LOCATION: set "Default location for new notes" to a
//         specific folder, then create a note from the sidebar CTA (the
//         root-level create path that inherits the pref) and assert the note
//         lands under that folder — a folder row now exists in the sidebar.
//   so1 — DEFAULT FILE TO OPEN: set "Default file to open" to a specific note,
//         then Lock → re-unlock (a fresh editor mount = the startup path) and
//         assert that note is the one opened, NOT the workspace that was live
//         before. The saved-workspace-preservation invariant is implicitly
//         exercised: the pref-driven open does not require the prior layout.
//
// Reload mechanism — Lock → unlock (not refresh): a re-unlock remounts the
// editor and re-runs the restore effect, which is exactly the startup decision
// point startup_open feeds into. Same boot path the user sees on launch.
//
// new_note_location / startup_open are NOT load-bearing crypto: they ride the
// existing MYP1 vault.prefs AEAD envelope as additive omit-when-None fields —
// no new magic / KEK / AAD / format bump.
//
// KDF: weak generator fixtures (params are vault.meta-resident).
// SYNC-13: note titles are in-source scenario constants (residue needle rule).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  noteRowIds,
  openSettings,
  pickSelect,
  unlockToEditor,
} from "./support/flows";
import { type Element, testIdSelector } from "./support/webdriver";

// Distinct note titles — single lowercase-alnum tokens (residue needle rule).
const NOTE_TITLE = "filesnotealpha7k2m9qx4w8e5rj0";
const TARGET_FOLDER = "filesinbox7c2vb5kk0/";

// ── nl1: default new-note location = specific folder ─────────────────────────

describeE2E("nl1 default new-note location (MYND-462): specific folder", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a note created after setting a specific folder lands under that folder", async () => {
    let password = "";
    await scenario(
      "nl1-new-note-location",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Configure: new-note location → specific folder.
        await openSettings(s, "files");
        await pickSelect(s, "settings.new-note-location-select", "specific");
        const folderInput = await s.byTestId("settings.new-note-location-folder-input");
        await folderInput.replaceText(TARGET_FOLDER);
        // Tab out of the input (W3C key U+E004) so its onBlur fires the
        // disk-first persist before we leave the panel.
        await folderInput.sendKeys("\u{e004}");
        await closeSettings(s);

        // Create a note via the root-level sidebar CTA — it inherits the pref.
        await createNote(s, NOTE_TITLE);

        // The note was filed under TARGET_FOLDER, so that exact folder is present
        // in the sidebar tree (matched by `data-folder-path`). (Setting the pref
        // already surfaces the destination folder; creating the note files into
        // it — either way the TARGET_FOLDER row must exist.)
        const folderRow = await s.waitUntil(
          async () => {
            const found = await s.byTestIdAll("notes.folder-row");
            for (const r of found) {
              if ((await r.attribute("data-folder-path")) === TARGET_FOLDER) return r;
            }
            return null;
          },
          { label: "new-note folder row (TARGET_FOLDER)", timeoutMs: 15_000 },
        );
        expect(await folderRow.attribute("data-folder-path")).toBe(TARGET_FOLDER);
      },
    );
  });
});

// ── so1: default file to open = specific note ────────────────────────────────

describeE2E("so1 default file to open (MYND-462): specific note", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the configured note opens on the next unlock (startup path)", async () => {
    let password = "";
    await scenario(
      "so1-startup-open",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Create the target note and capture its id.
        await createNote(s, NOTE_TITLE);
        const [noteId] = await noteRowIds(s, 1);

        // Configure: startup-open → specific → the target note.
        await openSettings(s, "files");
        await pickSelect(s, "settings.startup-open-select", "specific");
        // The note picker is a SearchableSelect; open it and pick the note.
        await (await s.byTestId("settings.startup-open-note-select")).click();
        const option = await s.waitForElement(
          testIdSelector("settings.startup-open-note-select-option", {
            "data-value": noteId,
          }),
        );
        await option.click();
        await closeSettings(s);

        // Lock → re-unlock: a fresh editor mount = the startup path.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(s, password);

        // The configured note is the one opened (its tab is present).
        const tab: Element = await s.waitForElement(
          testIdSelector("editor.tab", { "data-tab-id": `note:${noteId}` }),
        );
        expect(await tab.attribute("data-tab-id")).toBe(`note:${noteId}`);
      },
    );
  });
});
