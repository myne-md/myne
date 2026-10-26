// Settings → Sync usage block, end-to-end against a REAL myne-server (MYND-570).
//
// Three scenarios, matching the acceptance criteria:
//
//   su1 — hosted WITH a ceiling: figures + a meter.
//   su2 — no ceiling (the self-hosted / free-beta posture): the same figures with
//         NO meter, no error and no upsell. `0` is the server's unlimited
//         sentinel for both ceilings and must never render as a ceiling of zero.
//   su3 — an over-quota push surfaces as its OWN state, distinguishable from a
//         generic "sync failed".
//
// The ceiling is set with `MYNE_QUOTA_CEILING_BYTES` on the spawned server rather
// than by seeding a per-account `accounts.json` override: that store is
// fs-backend-only and keyed by an `account_number_hash` the test cannot know
// until after enrollment, whereas the global knob is read at boot and flows
// through the SAME `EffectiveQuota` resolver the enforcement guard uses — so it
// exercises the real resolution path, not a bypass.
//
// KDF: weak generator fixtures (params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { harnessSupported } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { launchDevice, syncConfigSeed } from "./support/multi-device";
import { seedVault } from "./support/fixtures";
import { type Session } from "./support/webdriver";
import {
  createNote,
  ipcOk,
  openSettings,
  pageSeatInvoke,
  selectSettingsTopic,
  typeIntoEditor,
  waitForSaved,
  unlockAndEnroll,
} from "./support/flows";

const supported = harnessSupported().ok && syncServerSupported().ok;

/** Re-open Settings → Sync so the usage block re-mounts and re-fetches.
 *
 * **The topic has to be named, and clicking the rail is not enough.** Settings
 * REMEMBERS the active topic across a reopen (`settings-tabs`: "selects a topic,
 * keeps it across a reopen"), and `unlockAndEnroll` leaves the panel on
 * `devices` because that is where the enrolment form lives. Clicking
 * `settings.tab-sync` therefore restored the DEVICES topic, the usage block (a
 * CONNECTION-topic row) never mounted, and su1/su2 reported a 20 s timeout on a
 * `sync.usage` that was working: measured 2026-10-24 in isolation, 2 of 3 red.
 * `sync_account_status` itself answered correctly in the same run, which is what
 * separated "the block is missing" from "the fetch failed". */
async function openSyncSettings(session: Session): Promise<void> {
  await openSettings(session);
  await (await session.byTestId("settings.tab-sync")).click();
  await selectSettingsTopic(session, "sync", "connection");
}

describe.skipIf(!supported)("su · Settings → Sync usage block (MYND-570)", () => {
  it("su1 — with a ceiling, renders storage/devices figures and a meter", async () => {
    // 50 MiB: comfortably above a seeded vault, so the account is under quota.
    const srv = await startSyncServer({ quotaCeilingBytes: 50 * 1024 * 1024 });
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
      await unlockAndEnroll(a.session, account, password);
      await openSyncSettings(a.session);

      await a.session.byTestId("sync.usage", { timeoutMs: 20_000 });
      await a.session.byTestId("sync.usage-storage");
      await a.session.byTestId("sync.usage-devices");
      // A real ceiling ⇒ a meter is rendered.
      await a.session.byTestId("sync.usage-meter");
    } finally {
      await a.teardown();
      await srv.teardown();
    }
  });

  it("su2 — with NO ceiling, renders figures with no meter, no error and no upsell", async () => {
    // Default server: MYNE_QUOTA_CEILING_BYTES unset ⇒ 0 ⇒ unlimited.
    const srv = await startSyncServer();
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
      await unlockAndEnroll(a.session, account, password);
      await openSyncSettings(a.session);

      await a.session.byTestId("sync.usage", { timeoutMs: 20_000 });
      await a.session.byTestId("sync.usage-storage");
      // The load-bearing assertion: no meter, because there is nothing to
      // measure against. `0` must not be treated as a ceiling of zero.
      expect(await a.session.byTestIdAll("sync.usage-meter")).toHaveLength(0);
      // Neutral: the account is not frozen and nothing errored.
      expect(await a.session.byTestIdAll("sync.usage-frozen")).toHaveLength(0);
    } finally {
      await a.teardown();
      await srv.teardown();
    }
  });

  it("su3 — an over-quota push reports its own state, not a generic failure", async () => {
    // A 1-byte ceiling: any push exceeds it, so the server answers 507 `quota`.
    const srv = await startSyncServer({ quotaCeilingBytes: 1 });
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
      await unlockAndEnroll(a.session, account, password);
      // Write real content and wait for the save to land, so the cycle has a
      // blob to push. Without a dirty blob the cycle succeeds trivially and the
      // quota guard is never reached.
      await createNote(a.session, "OverQuotaNote");
      await typeIntoEditor(a.session, "over quota body");
      await waitForSaved(a.session);

      // Drive the cycle through production IPC (no test hook), then poll the
      // runtime status: the engine coarsens 507 to its own failure class, whose
      // `status_detail()` tag is what the UI keys its banner off. Polling rather
      // than a single read because the status cell is published asynchronously
      // by the cycle.
      const detail = await a.session.waitUntil(
        async () => {
          await pageSeatInvoke(a.session, "plugin:sync|sync_now", {}, 30_000);
          const s = (await ipcOk(a.session, "plugin:sync|sync_status", {}, 20_000)) as {
            state?: string;
            detail?: string;
          };
          return s.state === "error" ? (s.detail ?? "") : null;
        },
        { label: "sync status reports a refusal", timeoutMs: 40_000 },
      );

      // The whole point of the feature: NOT the generic "sync_failed" tag.
      expect(detail).toBe("quota_exceeded");
    } finally {
      await a.teardown();
      await srv.teardown();
    }
  });
});
