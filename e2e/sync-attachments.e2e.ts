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
import { harnessSupported } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { setupTwoSyncedDevices } from "./support/multi-device";
import { ipcOk, pageSeatInvoke } from "./support/flows";

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
        // The import has been failing `{"kind":"Locked"}` on a device this
        // very setup just unlocked, enrolled and pushed a note from — so the
        // interesting question is not "did it fail" but "what did the host
        // think the vault's state was at that moment".
        //
        // `Locked` here means `hold_unlocked_attachment_material()` found the
        // ACTIVE slot not `Unlocked` (core/src/plugins/vault_unlock/state.rs).
        // That is a claim about which vault is active and what its slot holds,
        // and the host will answer both if asked. Asking costs one IPC on the
        // failure path only, and it is the difference between a bug report that
        // says "Locked" and one that says which slot was locked and why.
        const importRes = await pageSeatInvoke(
          a.session,
          "plugin:attachments|attachment_import",
          { source: { kind: "bytes", bytes: payload, filename: "replicated.bin" } },
          60_000,
        );
        if (importRes.err !== undefined) {
          const status = await pageSeatInvoke(a.session, "plugin:vault-unlock|vault_status", {}, 20_000);
          throw new Error(
            `attachment_import failed: ${JSON.stringify(importRes.err)}\n` +
              `  vault_status at that moment: ${JSON.stringify(status.ok ?? status.err)}`,
          );
        }
        const imported = importRes.ok as { id: string; deduplicated: boolean };
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
