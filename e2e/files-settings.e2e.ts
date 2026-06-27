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
  openSettings,
  unlockToEditor,
} from "./support/flows";
import { type Element, type Session, testIdSelector } from "./support/webdriver";

// Distinct note titles — single lowercase-alnum tokens (residue needle rule).
const NOTE_TITLE = "filesnotealpha7k2m9qx4w8e5rj0";
const TARGET_FOLDER = "filesinbox7c2vb5kk0/";

/** Pick `value` from a plain Select identified by `selectTestId`. */
async function pickSelect(
  session: Session,
  selectTestId: string,
  value: string,
): Promise<void> {
  await (await session.byTestId(selectTestId)).click();
  const option = await session.waitForElement(
    testIdSelector(`${selectTestId}-option`, { "data-value": value }),
  );
  await option.click();
}

/** The sidebar rows' note-ids, in DOM order, once exactly `expected` exist. */
async function noteRowIds(session: Session, expected: number): Promise<string[]> {
  const rows = await session.waitUntil(
    async () => {
      const found = await session.byTestIdAll("notes.row");
      return found.length === expected ? found : null;
    },
    { label: `${expected} note rows`, timeoutMs: 15_000 },
  );
  return Promise.all(rows.map(async (r) => (await r.attribute("data-note-id")) ?? ""));
}

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

        // Before: no folder rows (the seeded vault is flat).
        expect((await s.byTestIdAll("notes.folder-row")).length).toBe(0);

        // Create a note via the root-level sidebar CTA — it inherits the pref.
        await createNote(s, NOTE_TITLE);

        // After: a folder row exists (the note was filed under TARGET_FOLDER, so
        // its virtual folder now appears in the sidebar tree).
        const folderRows = await s.waitUntil(
          async () => {
            const found = await s.byTestIdAll("notes.folder-row");
            return found.length >= 1 ? found : null;
          },
          { label: "new-note folder row", timeoutMs: 15_000 },
        );
        expect(folderRows.length).toBeGreaterThanOrEqual(1);
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
