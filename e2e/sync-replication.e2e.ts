// Two-device sync canary (MYND-428 task 6) — the harness's own proof.
//
// Self-skips unless BOTH the tauri-driver harness (Linux + built app) AND the
// myne-server binary are present (Docker/CI; on the macOS dev machine this
// skips — the wiring is covered driver-free by `multi-device-harness.e2e.ts`).
//
// What this canary proves TODAY (the 424+428 substrate): one ephemeral server +
// two isolated app-instances boot concurrently, each carrying the SYNC-14
// endpoint config that points at the server. The full "two devices enroll +
// replicate one note" assertion layers on once device enrollment (MYND-425) and
// the wired engine loop land — it is called out explicitly below rather than
// faked green.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { harnessSupported } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { launchDevice, syncConfigSeed, withTwoDevices } from "./support/multi-device";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  openSettings,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import { readdirSync } from "node:fs";

const driver = harnessSupported();
const server = syncServerSupported();
const ready = driver.ok && server.ok;

if (!ready) {
  // One honest reason line so a filtered run explains itself.
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] sync-replication canary skipped: ${!driver.ok ? driver.reason : server.reason}`,
  );
}

const describeCanary = ready ? describe : describe.skip;

describeCanary("two-device sync canary (MYND-428)", () => {
  it("boots one server + two isolated devices, each carrying the SYNC-14 endpoint", async () => {
    const srv = await startSyncServer();
    try {
      await withTwoDevices(srv, async (a, b) => {
        // Both devices boot to Welcome (clean, isolated XDG roots).
        await a.session.byTestId("welcome.root", { timeoutMs: 20_000 });
        await b.session.byTestId("welcome.root", { timeoutMs: 20_000 });

        // Each device carries the seeded endpoint config (SYNC-14) the sync
        // plugin reads — the harness pointed both at the ephemeral server via
        // the real product surface, no test hook.
        expect(existsSync(join(a.appConfigDir, "sync-config.json"))).toBe(true);
        expect(existsSync(join(b.appConfigDir, "sync-config.json"))).toBe(true);

        // The devices are isolated: distinct data homes.
        expect(a.appDataDir).not.toBe(b.appDataDir);

        // TODO(MYND-425 + MYND-424 loop wiring): create a vault on A, enroll B
        // through the approval gate, edit one note on A, and assert it appears
        // on B (the full replicate-one-note canary). Blocked on device
        // enrollment (425) + the wired tokio sync loop, not on the harness —
        // the transport/pull/push/conflict engine is unit-tested (FakeTransport)
        // and the /sync/blob download route is live (server suite green).
      });
    } finally {
      await srv.teardown();
    }
  });

  it("A enrolls + writes a note; B joins, A approves, and the note replicates to B", async () => {
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
      const b = await launchDevice(1, { seedConfig: syncConfigSeed(srv.url) });
      try {
        // --- A: unlock → enroll (first device self-approves) → write a note ---
        await unlockToEditor(a.session, password);
        await dismissImporterOffer(a.session);
        await openSettings(a.session);
        await (await a.session.byTestId("settings.tab-sync")).click();
        await (await a.session.byTestId("sync.enroll.account-input")).sendKeys(account);
        await (await a.session.byTestId("sync.enroll.password-input")).sendKeys(password);
        await (await a.session.byTestId("sync.enroll.submit")).click();
        await a.session.byTestId("sync.enroll.approved", { timeoutMs: 30_000 });
        await closeSettings(a.session);

        // A note to replicate. `createNote` writes the `.myn` (backend
        // `note_create` + the title rename); a short settle lets the rename save
        // flush before the push. Typed-body content is a flaky-probe refinement,
        // not needed to prove a blob replicates to B.
        await createNote(a.session, "CanaryNote");
        await new Promise((r) => setTimeout(r, 1500));

        // Push A's note to the server. The sync trigger is a backend command
        // (no UI value); drive it via the sanctioned page-seat IPC instead of the
        // flaky settings-panel button (production IPC, no test hook — see
        // e2e/CLAUDE.md).
        await pageSeatInvoke(a.session, "plugin:sync|sync_now", {}, 20_000);

        // --- B: join the account (account# + password) → pending, lands in editor ---
        await b.session.byTestId("welcome.root", { timeoutMs: 20_000 });
        await (await b.session.byTestId("welcome.join-cta")).click();
        await b.session.byTestId("join.modal");
        await (await b.session.byTestId("join.server-input")).sendKeys(srv.url);
        await (await b.session.byTestId("join.account-input")).sendKeys(account);
        await (await b.session.byTestId("join.password-input")).sendKeys(password);
        await (await b.session.byTestId("join.submit")).click();
        await b.session.byTestId("editor.root", { timeoutMs: 30_000 });
        await dismissImporterOffer(b.session);

        // --- A: approve B (the device panel auto-refreshes; the pending row appears) ---
        await openSettings(a.session);
        await (await a.session.byTestId("settings.tab-sync")).click();
        await (await a.session.byTestId("sync.approve-device", { timeoutMs: 30_000 })).click();
        await closeSettings(a.session);

        // --- B: claim token + pull → A's note replicates to B's vault on disk.
        // The token-claim happens once the approval has propagated, so retry the
        // cycle (page-seat IPC) a few ticks until the blob lands. ---
        let replicated = false;
        for (let i = 0; i < 12 && !replicated; i++) {
          await pageSeatInvoke(b.session, "plugin:sync|sync_now", {}, 20_000);
          await new Promise((r) => setTimeout(r, 1500));
          replicated = noteBlobCount(b.appDataDir) >= 1;
        }
        expect(replicated, "A's note replicated to B's vault").toBe(true);
      } finally {
        await b.teardown();
      }
    } finally {
      await a.teardown();
      await srv.teardown();
    }
  });
});

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
