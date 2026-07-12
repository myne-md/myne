// Attachment sync (MYND-468) — two-device replication + deletion propagation.
//
// Vault-count precondition: A boots with one seeded vault; B joins the account.
//
// What this proves end-to-end over the REAL server + two production app
// instances (self-skips off-platform / without the myne-server binary, like
// sync-replication.e2e.ts):
//   1. an attachment imported on A (MYA1 body over the resumable
//      `/attachments/{id}` transport + the MYC1 catalog on the blob plane)
//      lands on B's disk with a live catalog entry;
//   2. deleting it on A (catalog tombstone + §11.4 tombstone record) erases
//      B's body and leaves B's library empty — and nothing resurrects it.
//
// Attachment import/delete are driven via the sanctioned page-seat IPC
// (production commands, no test hook — e2e/CLAUDE.md): the import UX is a
// native file picker WebDriver cannot drive, and the deterministic IPC keeps
// the scenario byte-precise about WHAT replicated.

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { harnessSupported, type AppSession } from "./support/session";
import {
  type EphemeralServer,
  startSyncServer,
  syncServerSupported,
} from "./support/sync-server";
import { launchDevice, syncConfigSeed } from "./support/multi-device";
import type { Session } from "./support/webdriver";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  openSettings,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";

const driver = harnessSupported();
const server = syncServerSupported();
const ready = driver.ok && server.ok;

if (!ready) {
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] sync-attachments skipped: ${!driver.ok ? driver.reason : server.reason}`,
  );
}

const describeAttachments = ready ? describe : describe.skip;

describeAttachments("attachment sync (MYND-468)", () => {
  it("an attachment imported on A replicates to B, and A's deletion erases it on B", async () => {
    const srv = await startSyncServer();
    try {
      const { a, b, teardown } = await setupTwoSyncedDevices(srv);
      try {
        // --- A: import an attachment (deterministic bytes → deterministic id) ---
        const payload = Array.from(
          new TextEncoder().encode("sync-attachment payload: replicate me across the fleet"),
        );
        const imported = (await ipcOk(a.session, "plugin:attachments|attachment_import", {
          source: { kind: "bytes", bytes: payload, filename: "replicated.bin" },
        })) as { id: string; deduplicated: boolean };
        expect(imported.id).toMatch(/^[0-9a-f]{64}$/);

        // Push A (the import hook marked the loop dirty; drive it explicitly).
        await ipcOk(a.session, "plugin:sync|sync_now", {});

        // --- B: pull until the body lands on disk + the catalog entry is live ---
        let onB = 0;
        for (let i = 0; i < 12 && onB === 0; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await new Promise((r) => setTimeout(r, 1500));
          onB = attachmentBlobCount(b.appDataDir);
        }
        expect(onB, "A's attachment body replicated to B's vault").toBe(1);
        const catalogB = (await ipcOk(b.session, "plugin:attachments|catalog_list", {})) as Array<{
          id: string;
          filename: string;
        }>;
        expect(catalogB.map((e) => e.id)).toContain(imported.id);
        expect(catalogB.find((e) => e.id === imported.id)?.filename).toBe("replicated.bin");

        // --- A: delete → tombstone propagates → B erases the body ---
        await ipcOk(a.session, "plugin:attachments|attachment_delete", { id: imported.id });
        expect(attachmentBlobCount(a.appDataDir), "A erased its own body").toBe(0);
        await ipcOk(a.session, "plugin:sync|sync_now", {});

        let erased = false;
        for (let i = 0; i < 12 && !erased; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await new Promise((r) => setTimeout(r, 1500));
          erased = attachmentBlobCount(b.appDataDir) === 0;
        }
        expect(erased, "the deletion erased B's body (§11.4 propagation)").toBe(true);
        const catalogAfter = (await ipcOk(b.session, "plugin:attachments|catalog_list", {})) as Array<{
          id: string;
        }>;
        expect(
          catalogAfter.map((e) => e.id),
          "B's library no longer lists the deleted attachment (tombstones are filtered)",
        ).not.toContain(imported.id);

        // Stability: further cycles on both sides resurrect nothing.
        await ipcOk(b.session, "plugin:sync|sync_now", {});
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        expect(attachmentBlobCount(a.appDataDir)).toBe(0);
        expect(attachmentBlobCount(b.appDataDir)).toBe(0);
      } finally {
        await teardown();
      }
    } finally {
      await srv.teardown();
    }
  });
});

/** Page-seat IPC that unwraps the result (throws on `err`, returns `ok`). */
async function ipcOk(
  session: Session,
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs = 20_000,
): Promise<unknown> {
  const r = await pageSeatInvoke(session, cmd, args, timeoutMs);
  if (r.err !== undefined) throw new Error(`${cmd} failed: ${JSON.stringify(r.err)}`);
  return r.ok;
}

/** Boot A (seeded vault) + B, enroll A, write+push one note, B joins + is
 *  approved + pulls it — the shared "two synced devices" precondition
 *  (mirrors sync-replication.e2e.ts's setup). */
async function setupTwoSyncedDevices(srv: EphemeralServer): Promise<{
  a: AppSession;
  b: AppSession;
  teardown: () => Promise<void>;
}> {
  let account = "";
  let password = "";
  const a = await launchDevice(0, {
    seedConfig: syncConfigSeed(srv.url),
    seed: (appDataDir) => {
      const v = seedVault(appDataDir, { password: "CanaryPass-9-animals!" });
      account = v.account;
      password = v.password;
    },
  });
  try {
    const b = await launchDevice(1, { seedConfig: syncConfigSeed(srv.url) });
    try {
      // A: unlock → enroll (self-approves) → create a note → push.
      await unlockToEditor(a.session, password);
      await dismissImporterOffer(a.session);
      await openSettings(a.session);
      await (await a.session.byTestId("settings.tab-sync")).click();
      await (await a.session.byTestId("sync.enroll.account-input")).sendKeys(account);
      await (await a.session.byTestId("sync.enroll.password-input")).sendKeys(password);
      await (await a.session.byTestId("sync.enroll.submit")).click();
      await a.session.byTestId("sync.enroll.approved", { timeoutMs: 30_000 });
      await closeSettings(a.session);
      await createNote(a.session, "AttachmentSyncNote");
      await new Promise((r) => setTimeout(r, 1500));
      await ipcOk(a.session, "plugin:sync|sync_now", {});

      // B: join (account# + password) → pending (waits on the approval gate).
      await b.session.byTestId("welcome.root", { timeoutMs: 20_000 });
      await (await b.session.byTestId("welcome.join-cta")).click();
      await b.session.byTestId("join.modal");
      await (await b.session.byTestId("join.server-input")).sendKeys(srv.url);
      await (await b.session.byTestId("join.account-input")).sendKeys(account);
      await (await b.session.byTestId("join.password-input")).sendKeys(password);
      await (await b.session.byTestId("join.submit")).click();
      await b.session.byTestId("join.pending", { timeoutMs: 30_000 });

      // A: approve B while it is pending.
      await openSettings(a.session);
      await (await a.session.byTestId("settings.tab-sync")).click();
      await (await a.session.byTestId("sync.approve-device", { timeoutMs: 30_000 })).click();
      await closeSettings(a.session);

      // B: auto-claim + pull → SAS verify → editor (SYNC-40).
      await b.session.byTestId("join.verify", { timeoutMs: 30_000 });
      await (await b.session.byTestId("join.sas-match")).click();
      await b.session.byTestId("editor.root", { timeoutMs: 30_000 });
      await dismissImporterOffer(b.session);

      // B: pull until A's note replicates (the synced-baseline precondition).
      let replicated = false;
      for (let i = 0; i < 12 && !replicated; i++) {
        await ipcOk(b.session, "plugin:sync|sync_now", {});
        await new Promise((r) => setTimeout(r, 1500));
        replicated = noteBlobCount(b.appDataDir) >= 1;
      }
      if (!replicated) throw new Error("setup: A's note never replicated to B");

      const teardown = async () => {
        await b.teardown();
        await a.teardown();
      };
      return { a, b, teardown };
    } catch (e) {
      await b.teardown();
      throw e;
    }
  } catch (e) {
    await a.teardown();
    throw e;
  }
}

/** Count `.myn` note blobs across every vault under a device's app-data dir. */
function noteBlobCount(appDataDir: string): number {
  let count = 0;
  try {
    for (const v of readdirSync(join(appDataDir, "vaults"))) {
      try {
        for (const f of readdirSync(join(appDataDir, "vaults", v, "notes"))) {
          if (f.endsWith(".myn")) count++;
        }
      } catch {
        /* this vault has no notes dir yet */
      }
    }
  } catch {
    /* no vaults dir */
  }
  return count;
}

/** Count canonical MYA1 attachment blobs (64-hex names) across every vault. */
function attachmentBlobCount(appDataDir: string): number {
  let count = 0;
  try {
    for (const v of readdirSync(join(appDataDir, "vaults"))) {
      try {
        for (const f of readdirSync(join(appDataDir, "vaults", v, "attachments"))) {
          if (/^[0-9a-f]{64}$/.test(f)) count++;
        }
      } catch {
        /* this vault has no attachments dir yet */
      }
    }
  } catch {
    /* no vaults dir */
  }
  return count;
}
