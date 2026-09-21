// Recovered-notes quarantine visibility suite (Settings → Sync → "Recovered
// notes"; the MYND-427 reconcile drop-leg's `quarantine/` dir made
// user-visible). Vault-count precondition: 1 (weak KDF) for both scenarios.
//
//   rn1 — preview + restore round-trip. Seeds a vault with the export-suite
//     notes (real MY01 blobs through the production write path), then BEFORE
//     boot moves the plain note's blob `notes/<id>.myn` →
//     `quarantine/<id>.myn` via Node fs — exactly the file-move the reconcile
//     drop-leg performs (the decode AAD is the filename uuid, so the blob
//     stays decryptable in place; the fixtures.ts raw-drop precedent). The
//     scenario unlocks, opens Settings → Sync, sees the recovered row,
//     Preview decrypts the body in the modal, Restore re-creates the note
//     under a NEW id (disk truth read back via page-seat `note_list` +
//     `note_read` — byte-verbatim content), the row disappears, the
//     quarantine file is gone from disk, and the restored note's row shows in
//     the sidebar after the settings modal closes.
//
//   rn2 — delete path. Same seeding shape; Delete opens the confirm modal
//     (`sync.recovered-delete-confirm`), confirming removes the row AND the
//     `quarantine/<id>.myn` file at rest; the notes list is untouched (no
//     resurrection, no stray create).
//
// KDF: weak generator fixtures (legal — unlock reads params from vault.meta).
// The export-suite plaintexts are generator constants (in-source scenario
// content, not credentials); the password is the in-source constant class
// (SYNC-13 applies to credentials, which never reach any assert below).
//
// ⚠️ NEW SCENARIO — authored but NOT yet validated in the container. Per the
// e2e/AGENTS.md definition of done it must go green 3× consecutive via
// `./scripts/e2e-local.sh` before merge; it introduces the recovered-notes
// testid pass (`sync.recovered-row` / `sync.recovered-preview` /
// `sync.recovered-preview-body` / `sync.recovered-restore` /
// `sync.recovered-delete` / `sync.recovered-delete-confirm`).

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOfferIfPresent,
  openSettings,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const PASSWORD = "Qp9#xT4!nG7&wM2k-rn1";
const IPC_TIMEOUT = 15_000;

/** Move one seeded note's blob into `quarantine/` BEFORE boot — the exact
 *  rename the reconcile drop-leg performs (`quarantine_note`); the decode AAD
 *  is the filename's base uuid, so the blob stays decryptable in place. */
function quarantineSeededNote(appDataDir: string, vaultId: string, noteId: string): void {
  const vaultRoot = join(appDataDir, "vaults", vaultId);
  const qdir = join(vaultRoot, "quarantine");
  mkdirSync(qdir, { recursive: true });
  renameSync(
    join(vaultRoot, "notes", `${noteId}.myn`),
    join(qdir, `${noteId}.myn`),
  );
}

function quarantineBlobPath(appDataDir: string, vaultId: string, noteId: string): string {
  return join(appDataDir, "vaults", vaultId, "quarantine", `${noteId}.myn`);
}

/** Unlock, dismiss the importer offer if present, and land on
 *  Settings → Sync with the recovered row for `fileName` visible. */
async function openRecoveredRow(s: Session, fileName: string): Promise<void> {
  await unlockToEditor(s, PASSWORD);
  await dismissImporterOfferIfPresent(s);
  await openSettings(s, "sync");
  await s.byTestId("settings.sync-panel");
  await s.waitForElement(
    testIdSelector("sync.recovered-row", { "data-file-name": fileName }),
  );
}

describeE2E("rn1 recovered-notes preview + restore (Settings → Sync)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("previews a quarantined note and restores it as a new note", async () => {
    let seeded: SeededVault | null = null;
    await scenario(
      "rn1-recovered-restore",
      {
        seed: (dir) => {
          seeded = seedVault(dir, { password: PASSWORD, exportSuite: true });
          quarantineSeededNote(dir, seeded.vaultId, seeded.exportSuite!.plainNoteId);
        },
      },
      async (app) => {
        const s = app.session;
        const suite = seeded!.exportSuite!;
        const fileName = `${suite.plainNoteId}.myn`;
        await openRecoveredRow(s, fileName);

        // ---- Preview: the modal decrypts the quarantined body in memory ----
        await (
          await s.waitForElement(
            testIdSelector("sync.recovered-preview", { "data-file-name": fileName }),
          )
        ).click();
        const previewBody = await s.byTestId("sync.recovered-preview-body");
        await s.waitUntil(
          async () =>
            (await previewBody.text()).includes("Verbatim export proof body")
              ? true
              : null,
          { label: "preview shows the decrypted quarantined body" },
        );
        // Close the preview via its explicit button (testid-only; no
        // synthetic-key chord — the invisible-keychar flakiness class).
        await (await s.byTestId("sync.recovered-preview-close")).click();
        await s.waitForGone(testIdSelector("sync.recovered-preview-body"));

        // ---- Restore: re-created as a NEW note; the row + file disappear ----
        await (
          await s.waitForElement(
            testIdSelector("sync.recovered-restore", { "data-file-name": fileName }),
          )
        ).click();
        await s.waitForGone(
          testIdSelector("sync.recovered-row", { "data-file-name": fileName }),
        );
        expect(
          existsSync(quarantineBlobPath(app.appDataDir, seeded!.vaultId, suite.plainNoteId)),
          "restore removes the quarantine source file",
        ).toBe(false);

        // Disk truth: exactly one NEW note id appeared (the attachments +
        // pdf suite notes were seeded too — pdf stayed in notes/ — so the
        // new id is whichever the pre-boot roster did not carry), and its
        // body is byte-verbatim the quarantined plaintext.
        const listed = await pageSeatInvoke(s, "plugin:notes|note_list", {}, IPC_TIMEOUT);
        const ids = (listed.ok ?? []) as string[];
        const known = new Set([suite.attachmentsNoteId, suite.pdfNoteId]);
        const newIds = ids.filter((id) => !known.has(id));
        expect(newIds, "exactly one restored note id").toHaveLength(1);
        const newId = newIds[0];
        expect(newId, "restore mints a NEW id").not.toBe(suite.plainNoteId);
        const read = await pageSeatInvoke(
          s,
          "plugin:notes|note_read",
          { noteId: newId },
          IPC_TIMEOUT,
        );
        expect(read.ok, "restored body is byte-verbatim").toBe(suite.plainNotePlaintext);

        // Sidebar truth: the restored note's row is live after the modal
        // closes (the panel refreshes the note list on restore).
        await closeSettings(s);
        await s.waitForElement(testIdSelector("notes.row", { "data-note-id": newId }));
      },
    );
  });
});

describeE2E("rn2 recovered-notes confirmed delete (Settings → Sync)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("deletes a quarantined note after the confirm modal", async () => {
    let seeded: SeededVault | null = null;
    await scenario(
      "rn2-recovered-delete",
      {
        seed: (dir) => {
          seeded = seedVault(dir, { password: PASSWORD, exportSuite: true });
          quarantineSeededNote(dir, seeded.vaultId, seeded.exportSuite!.plainNoteId);
        },
      },
      async (app) => {
        const s = app.session;
        const suite = seeded!.exportSuite!;
        const fileName = `${suite.plainNoteId}.myn`;
        await openRecoveredRow(s, fileName);

        // Delete opens the confirm modal; confirming removes row + file.
        await (
          await s.waitForElement(
            testIdSelector("sync.recovered-delete", { "data-file-name": fileName }),
          )
        ).click();
        await (await s.byTestId("sync.recovered-delete-confirm")).click();
        await s.waitForGone(
          testIdSelector("sync.recovered-row", { "data-file-name": fileName }),
        );
        expect(
          existsSync(quarantineBlobPath(app.appDataDir, seeded!.vaultId, suite.plainNoteId)),
          "confirmed delete removes the quarantine file at rest",
        ).toBe(false);

        // The delete never touches notes/ — the remaining suite notes are
        // intact and no stray note appeared.
        const listed = await pageSeatInvoke(s, "plugin:notes|note_list", {}, IPC_TIMEOUT);
        const ids = (listed.ok ?? []) as string[];
        expect(ids.sort()).toEqual(
          [suite.attachmentsNoteId, suite.pdfNoteId].sort(),
        );
      },
    );
  });
});
