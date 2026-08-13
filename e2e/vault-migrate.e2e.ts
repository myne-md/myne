// automerge-sync-migration #420 task 4: the whole-vault v0.1 → v0.2 migration,
// end to end through the production binary. One vault, production KDF.
//
// Drives the real `vault_migrate` command from the page seat (production IPC, no
// test hook): a seeded MYV1 vault with a MY01 note migrates to NTV5 + NC05, the
// phrase-required gate refuses a wrong phrase without writing, and the migrated
// NTV5 vault re-unlocks (proving the unlock magic-dispatch). SYNC-13: never logs
// the phrase/password (only in-source fixture constants + emptiness/magic checks).

import { expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import {
  dismissImporterOfferIfPresent,
  ipcOk,
  openSettings,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector } from "./support/webdriver";
import { seedVault, vaultMetaPath, type SeededVault } from "./support/fixtures";

function magic(path: string): string {
  return readFileSync(path).subarray(0, 4).toString("latin1");
}

describeE2E("vault migration v0.1 → v0.2 (1 vault, production KDF)", () => {
  it("migrates MYV1→NTV5 + MY01→NC05, enforces the phrase gate, and the NTV5 vault re-unlocks", async () => {
    let fixture!: SeededVault;
    await scenario(
      "vm1-migrate",
      {
        seed: (appDataDir) => {
          // v0.1 ON PURPOSE: this scenario IS the pre-flip vault. A new vault is
          // born v0.2 (`decisions.md` 2026-08-13), which has nothing to migrate.
          fixture = seedVault(appDataDir, { kdf: "production", generation: "v0.1" });
        },
      },
      async (app) => {
        const notesDir = join(app.appDataDir, "vaults", fixture.vaultId, "notes");
        const metaPath = vaultMetaPath(app.appDataDir, fixture.vaultId);
        expect(magic(metaPath)).toBe("MYV1");

        // Unlock, then create a MY01 note through the real IPC.
        await unlockToEditor(app.session, fixture.password);
        const noteId = (await ipcOk(app.session, "plugin:notes|note_create", {
          plaintext: "---\ntitle: Pre\n---\n\n# Body [[l]]\n",
        })) as string;
        const notePath = join(notesDir, `${noteId}.myn`);
        expect(magic(notePath)).toBe("MY01");

        // (1) A WRONG phrase is refused backend-side and writes nothing.
        const wrong = await pageSeatInvoke(app.session, "plugin:vault-migrate|vault_migrate", {
          password: fixture.password,
          phrase: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
        });
        expect((wrong.err as { kind?: string } | undefined)?.kind).toBe("RecoveryPhraseRequired");
        expect(magic(metaPath)).toBe("MYV1"); // still v0.1 — nothing written

        // (2) Correct password + phrase migrates the whole vault.
        const summary = (await ipcOk(app.session, "plugin:vault-migrate|vault_migrate", {
          password: fixture.password,
          phrase: fixture.phrase,
        })) as { notes_migrated: number };
        expect(summary.notes_migrated).toBeGreaterThanOrEqual(1);
        expect(magic(metaPath)).toBe("NTV5"); // committed
        expect(magic(notePath)).toBe("NC05"); // the note re-keyed to CRDT
        // The pre-migration vault survives in legacy/ (the abort hatch).
        expect(magic(join(app.appDataDir, "vaults", fixture.vaultId, "legacy", "vault.meta"))).toBe(
          "MYV1",
        );

        // (3) Migration is a RE-KEY event: the backend minted a fresh root_key +
        // itemsKey and DROPPED the running slot (it held stale v0.1 keys that
        // decrypt none of the new NC05 notes). So the app routes back to Unlock.
        // Re-probe (Cmd+R survives the host slot, now Empty → the NTV5 vault reads
        // Exists, not Corrupted) and re-unlock — proving the NTV5 unlock
        // magic-dispatch end to end against the migrated vault.
        await app.session.refresh();
        await unlockToEditor(app.session, fixture.password);
        await app.session.byTestId("editor.root", { timeoutMs: 30_000 });

        // (4) The migration is NOT settled (§10.4.1 point 5, myne-md/myne#430):
        // the whole pre-migration vault is staged, and until the user says so the
        // old root_key is still on disk — wrapped under the OLD password and the
        // OLD recovery phrase, which is why a later password rotation would not
        // revoke access to those notes. The status probe says so.
        const status = (await ipcOk(
          app.session,
          "plugin:vault-migrate|vault_migrate_settle_status",
        )) as { pending: boolean; can_abort: boolean; offerable: boolean };
        expect(status.pending).toBe(true);
        expect(status.can_abort).toBe(true); // unenrolled vault → pre-sync
        // …and the UPGRADE is no longer on offer, which is what removes the
        // form from Settings. The two flags disagree here on purpose: the vault
        // is current (nothing to migrate) while its snapshot is unsettled.
        expect(status.offerable).toBe(false);

        // (5) CONFIRM crypto-erases it. Asserted on the old meta's absence rather
        // than on the 200: the staged meta is the only remaining wrapper of the
        // old root_key, so its disappearance IS the erase.
        await ipcOk(app.session, "plugin:vault-migrate|vault_migrate_confirm");
        expect(
          existsSync(join(app.appDataDir, "vaults", fixture.vaultId, "legacy", "vault.meta")),
        ).toBe(false);
        const settled = (await ipcOk(
          app.session,
          "plugin:vault-migrate|vault_migrate_settle_status",
        )) as { pending: boolean; offerable: boolean };
        expect(settled.pending).toBe(false);
        expect(settled.offerable).toBe(false);

        // (6) With both flags down, Settings shows NO migration block at all —
        // not a heading over an empty section, and not a form that would ask for
        // the recovery phrase to perform a no-op. Asserted through the real
        // Settings surface rather than on the flags alone, because the flags
        // reaching the panel is the half that can break.
        // The re-unlocked editor can still be carrying the importer onboarding
        // overlay, which sits over the Settings CTA — the tolerant variant,
        // because on this vault the offer may equally not be there at all.
        await dismissImporterOfferIfPresent(app.session);
        await openSettings(app.session, "sync");
        await app.session.byTestId("settings.modal");
        expect(
          await app.session.findElements(testIdSelector("migrate.phrase-input")),
        ).toHaveLength(0);
        expect(
          await app.session.findElements('[data-setting-anchor="sync.migrate"]'),
        ).toHaveLength(0);
      },
    );
  });

  // The other half of §10.4.1 point 5: a migration can be taken BACK, and the
  // vault that comes back is the byte-identical v0.1 one — not a re-encode, not
  // a best-effort reconstruction (myne-md/myne#430 + #435).
  it("aborts a migration and restores the byte-identical v0.1 vault", async () => {
    let fixture!: SeededVault;
    await scenario(
      "vm2-abort",
      {
        seed: (appDataDir) => {
          // v0.1 ON PURPOSE: this scenario IS the pre-flip vault. A new vault is
          // born v0.2 (`decisions.md` 2026-08-13), which has nothing to migrate.
          fixture = seedVault(appDataDir, { kdf: "production", generation: "v0.1" });
        },
      },
      async (app) => {
        const vaultRoot = join(app.appDataDir, "vaults", fixture.vaultId);
        const notesDir = join(vaultRoot, "notes");
        const metaPath = vaultMetaPath(app.appDataDir, fixture.vaultId);

        await unlockToEditor(app.session, fixture.password);
        const noteId = (await ipcOk(app.session, "plugin:notes|note_create", {
          plaintext: "---\ntitle: Survivor\n---\n\n# Untouched\n",
        })) as string;
        const notePath = join(notesDir, `${noteId}.myn`);
        const originalNote = readFileSync(notePath);
        const originalMeta = readFileSync(metaPath);

        await ipcOk(app.session, "plugin:vault-migrate|vault_migrate", {
          password: fixture.password,
          phrase: fixture.phrase,
        });
        expect(magic(metaPath)).toBe("NTV5");
        expect(magic(notePath)).toBe("NC05");

        // Abort. The vault locks (a re-key in EITHER direction is a re-unlock
        // event), so the assertions below read the disk rather than the UI.
        await app.session.refresh();
        await unlockToEditor(app.session, fixture.password);
        await ipcOk(app.session, "plugin:vault-migrate|vault_migrate_abort");

        // Byte-identical, not merely "opens again". A restore that re-encoded
        // would satisfy a magic check and still have authored a change into a
        // vault the user asked to be put back untouched.
        expect(readFileSync(metaPath).equals(originalMeta)).toBe(true);
        expect(readFileSync(notePath).equals(originalNote)).toBe(true);
        expect(existsSync(join(vaultRoot, "legacy", "vault.meta"))).toBe(false);

        // …and the restored v0.1 vault unlocks under the ORIGINAL password.
        await app.session.refresh();
        await unlockToEditor(app.session, fixture.password);
        await app.session.byTestId("editor.root", { timeoutMs: 30_000 });
      },
    );
  });
});
