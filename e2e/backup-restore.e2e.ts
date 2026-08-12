// Vault backup + restore suite (MYND-56; engines MYND-32/MYND-218,
// epic MYND-217, spec §9.11).
//
// Pins the whole-vault backup round trip through the production binary:
// export writes a verified `.myne-backup` (SYNC-4 — the file's existence
// means it re-read and verified), restore recreates the vault as a fresh
// `vaults/<id>/` (SYNC-5 — same-identity collisions surface and KeepBoth
// restores side-by-side), and the restored vault unlocks with the ORIGINAL
// password through the real unlock UI — the credential wraps travel inside
// the byte-copied vault.meta (the fresh-machine guarantee).
//
// Native file dialogs cannot be driven by WebDriver, so the export/restore
// IPCs fire from the page seat (`__TAURI_INTERNALS__.invoke` — production
// IPC, no test hook; the vault-creation suite's pattern). The surrounding
// UI surfaces (Settings buttons, the Welcome entry, the restore Stage
// screen) are driven for real.
//
// KDF: weak generator fixtures (legal — unlock reads params from
// vault.meta; no production-KDF story here).

import { expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  openSettings,
  pageSeatInvoke,
  switchToVault,
  unlockToEditor,
} from "./support/flows";

describeE2E("backup-restore (MYND-56)", () => {
  it("br1: export → verified file → keep-both restore → restored vault unlocks with the original password", async () => {
    // Vault-count precondition: 1 (weak KDF).
    // Seed via the pre-boot callback (the seedVaults contract): seeding
    // after launchApp races the app's boot probe — an empty dir at probe
    // time lands on Welcome, where the unlock form never appears. The
    // race is deterministic when this file runs first and the seed pays
    // the one-time fixture-gen cargo build.
    let seeded!: SeededVault;
    await scenario(
      "br1-roundtrip",
      { seed: (dir) => void (seeded = seedVault(dir)) },
      async (app) => {
        const { session } = app;

        // Unlock the seeded vault through the real UI.
        await unlockToEditor(session, seeded.password);
        await dismissImporterOffer(session);

        // Settings → Storage carries the ENABLED backup controls (MYND-56
        // task 1 — formerly disabled stubs).
        await openSettings(session, "storage");
        expect(await (await session.byTestId("settings.backup-vault")).enabled()).toBe(true);
        expect(await (await session.byTestId("settings.restore-backup")).enabled()).toBe(true);
        // The buttons open native dialogs WebDriver cannot drive — close
        // the modal and fire the engine IPCs from the page seat instead.
        await closeSettings(session);

        // Export (SYNC-4: Ok ⇒ the file was re-read and verified).
        const destination = path.join(app.dataHome, "roundtrip.myne-backup");
        const exported = await pageSeatInvoke(
          session,
          "plugin:backup|vault_export_backup",
          // `vaultId` is `String`, not `Option<String>` — the command parses it
          // and answers `VaultNotFound` on a bad one
          // (`plugins/backup/commands.rs`). Sending `null` failed the whole
          // scenario on argument deserialization, so it never reached the
          // export/restore round trip it exists to prove. Same defect, same
          // command, as scheduled-backup carried.
          { vaultId: seeded.vaultId, destination },
          60_000,
        );
        if (exported.err !== undefined) {
          throw new Error("export failed: " + JSON.stringify(exported.err));
        }
        expect(fs.existsSync(destination)).toBe(true);

        // Same-identity restore with NO intent → the engine reports the
        // collision and touches nothing (SYNC-5).
        const collided = await pageSeatInvoke(
          session,
          "plugin:backup|vault_restore_backup",
          { source: destination, options: null },
          60_000,
        );
        const collidedErr = collided.err as { kind?: string } | undefined;
        expect(collidedErr?.kind).toBe("VaultAlreadyExists");

        // KeepBoth → side-by-side restore into a fresh vaults/<id>/.
        const restored = await pageSeatInvoke(
          session,
          "plugin:backup|vault_restore_backup",
          { source: destination, options: { on_collision: "keep-both" } },
          60_000,
        );
        const outcome = restored.ok as { vault_id?: string } | undefined;
        if (typeof outcome?.vault_id !== "string") {
          throw new Error("restore failed: " + JSON.stringify(restored));
        }

        // The switcher probes listVaults() at every open, so the restored
        // vault appears without a reload. Switching relocks the current
        // vault and lands on the restored vault's unlock form; the
        // ORIGINAL password unlocks it (wraps travel in vault.meta).
        await switchToVault(session, outcome.vault_id);
        const form = await session.byTestId("unlock.form", { timeoutMs: 15_000 });
        expect(await form.attribute("data-vault-id")).toBe(outcome.vault_id);
        await unlockToEditor(session, seeded.password);
      },
    );
  });

  it("br2: Welcome carries the fresh-install restore door into the Stage flow", async () => {
    // Vault-count precondition: 0.
    await scenario("br2-welcome-door", {}, async (app) => {
      const { session } = app;
      const restoreCta = await session.waitForElement(
        '[data-testid="welcome.restore-cta"]',
      );
      await restoreCta.click();
      await session.waitForElement('[data-testid="restore.root"]');
      // Pre-unlock-class Stage screen (never a modal): picking a file is a
      // native dialog, so br1 covers the engine path — here we pin the
      // surface + the reprobe-based Back exit.
      const back = await session.byTestId("restore.back");
      await back.click();
      await session.waitForElement('[data-testid="welcome.root"]');
    });
  });
});
