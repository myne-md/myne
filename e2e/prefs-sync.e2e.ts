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
// (production commands, no test hook — e2e/AGENTS.md): reads keep the
// assertions byte-precise about WHAT replicated.

import { describe, expect, it } from "vitest";
import { harnessSupported } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { setupTwoSyncedDevices } from "./support/multi-device";
import { closeSettings, ipcOk, openSettings } from "./support/flows";

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
        // --- A: rename the vault through the REAL Settings → Vault UI
        // (exercises the production setter → central clock-stamping path).
        // The setup left the modal on the Sync tab — select Vault explicitly. ---
        await openSettings(a.session);
        await (await a.session.byTestId("settings.tab-vault")).click();
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
