// Prefs sync (MYND-478) — two-device vault-rename replication + the
// device-local negative.
//
// Vault-count precondition: A boots with one seeded vault; B joins the account.
//
// What this proves end-to-end over the REAL server + two production app
// instances (self-skips off-platform / without the myne-server binary, like
// sync-attachments.e2e.ts):
//   1. renaming the vault on A — through the real Settings → Account UI, so
//      the central setter clock-stamping path is exercised — lands in B's
//      decrypted `vault.prefs` (shared field, scalar-LWW on its field clock)
//      AND surfaces in B's vault-switcher chip without a relock (the
//      `myne://prefs-changed` → window-event bridge, MYND-478 T9);
//   2. a device-local pref set on A (theme) never reaches B — the
//      shared-subset push gate + classification split (§10.2).
//
// The theme write + prefs reads are driven via the sanctioned page-seat IPC
// (production commands, no test hook — e2e/CLAUDE.md): reads keep the
// assertions byte-precise about WHAT replicated.

import { describe, expect, it } from "vitest";
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
import { join } from "node:path";
import { readdirSync } from "node:fs";

const driver = harnessSupported();
const server = syncServerSupported();
const ready = driver.ok && server.ok;

if (!ready) {
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] prefs-sync skipped: ${!driver.ok ? driver.reason : server.reason}`,
  );
}

const describePrefsSync = ready ? describe : describe.skip;

const RENAMED = "Fleet Vault Name";

describePrefsSync("prefs sync (MYND-478)", () => {
  it("a vault rename on A reaches B's prefs + switcher chip; A's theme never does", async () => {
    const srv = await startSyncServer();
    try {
      const { a, b, teardown } = await setupTwoSyncedDevices(srv);
      try {
        // --- A: rename the vault through the REAL Settings → Account UI
        // (exercises the production setter → central clock-stamping path).
        // The setup left the modal on the Sync tab — select Account explicitly. ---
        await openSettings(a.session);
        await (await a.session.byTestId("settings.tab-account")).click();
        const labelInput = await a.session.byTestId("settings.label-input");
        await labelInput.replaceText(RENAMED);
        await (await a.session.byTestId("settings.label-save")).click();
        await new Promise((r) => setTimeout(r, 800));
        await closeSettings(a.session);

        await ipcOk(a.session, "plugin:sync|sync_now", {});

        // --- B: pull until the rename lands in its decrypted vault.prefs.
        // (B's very first prefs record may arrive as the §10.2.1 enrollment
        // wholesale seed — by design; at this point A's blob carries no
        // device-local values, so the seed is identity-only.) ---
        let labelOnB: string | null = null;
        for (let i = 0; i < 12 && labelOnB !== RENAMED; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await new Promise((r) => setTimeout(r, 1500));
          const prefs = (await ipcOk(b.session, "plugin:prefs|prefs_read", {})) as {
            label: string | null;
            theme: string | null;
          };
          labelOnB = prefs.label;
        }
        expect(labelOnB, "A's rename replicated into B's vault.prefs").toBe(RENAMED);

        // The T9 bridge: B's switcher chip shows the new name live (no relock,
        // no reopen — the sync loop's `myne://prefs-changed` event refreshed it).
        let chipText = "";
        for (let i = 0; i < 8 && !chipText.includes(RENAMED); i++) {
          await new Promise((r) => setTimeout(r, 500));
          chipText = await (await b.session.byTestId("switcher.chip")).textContent();
        }
        expect(chipText, "B's switcher chip live-refreshed to the new name").toContain(
          RENAMED,
        );

        // --- Negative: NOW flip a DEVICE-LOCAL pref on A (theme). B is no
        // longer virgin (it holds the seeded/merged prefs above), so this must
        // never cross: the shared-subset push gate keeps A's blob off the wire
        // entirely, and the classification keeps the merge away from theme. ---
        await ipcOk(a.session, "plugin:prefs|set_theme", { theme: "dark" });
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        for (let i = 0; i < 3; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await new Promise((r) => setTimeout(r, 1000));
        }
        const prefsB = (await ipcOk(b.session, "plugin:prefs|prefs_read", {})) as {
          label: string | null;
          theme: string | null;
        };
        expect(prefsB.theme, "A's device-local theme never crossed the merge").toBeNull();
        expect(prefsB.label, "the shared label survived the extra cycles").toBe(RENAMED);

        // Stability: further cycles on both sides change nothing (no ping-pong).
        await ipcOk(b.session, "plugin:sync|sync_now", {});
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        const prefsA = (await ipcOk(a.session, "plugin:prefs|prefs_read", {})) as {
          label: string | null;
          theme: string | null;
        };
        expect(prefsA.label).toBe(RENAMED);
        expect(prefsA.theme).toBe("dark");
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
 *  (mirrors sync-attachments.e2e.ts's setup). */
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
      await createNote(a.session, "PrefsSyncNote");
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
