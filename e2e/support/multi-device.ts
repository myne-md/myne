// Multi-device E2E primitives (MYND-428 tasks 3 + 4).
//
// `launchDevice(index)` boots ONE production app-instance with its own
// driver+native port pair (off the `MYNE_E2E_*_PORT` base) and its own isolated
// data dir, so N instances coexist — the single-session `launchApp` machinery
// (teardown, artifacts, XDG isolation) is reused verbatim. `withTwoDevices`
// composes two devices + one ephemeral server, pointing both clients at the
// server via the REAL endpoint-config surface (SYNC-14 `sync-config.json` seeded
// into each device's app_config_dir — no test hook).

import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppSession, type LaunchOptions, launchApp } from "./session";
import type { EphemeralServer } from "./sync-server";
import { seedVault } from "./fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  ipcOk,
  openSettings,
  unlockToEditor,
} from "./flows";

const DRIVER_BASE = Number(process.env.MYNE_E2E_DRIVER_PORT ?? 4444);
const NATIVE_BASE = Number(process.env.MYNE_E2E_NATIVE_PORT ?? 4445);
/** Port stride per device instance (keeps each device's pair well separated). */
const PORT_STRIDE = 10;

/** Driver/native port pair for device `index` (0-based). */
export function devicePorts(index: number): { driverPort: number; nativePort: number } {
  return {
    driverPort: DRIVER_BASE + index * PORT_STRIDE,
    nativePort: NATIVE_BASE + index * PORT_STRIDE,
  };
}

/**
 * Boot device `index` as an isolated production app-instance. Reuses
 * `launchApp` (teardown / artifacts / fresh XDG_DATA_HOME) with a per-instance
 * port pair so multiple devices run concurrently. The existing single-session
 * `scenario()` / `launchApp()` paths are untouched.
 */
export async function launchDevice(index: number, opts: LaunchOptions = {}): Promise<AppSession> {
  const { driverPort, nativePort } = devicePorts(index);
  return launchApp({ ...opts, driverPort, nativePort });
}

/**
 * A `seedConfig` callback that writes the device-local sync endpoint config
 * (SYNC-14) pointing at `endpointUrl` — the same `sync-config.json` the real
 * `sync_set_endpoint` command persists. Loopback `http` is policy-valid
 * (`validate_endpoint_url`), so the ephemeral server's URL is accepted as-is.
 */
export function syncConfigSeed(endpointUrl: string): (appConfigDir: string) => void {
  return (appConfigDir: string) => {
    const body = JSON.stringify({ endpoint_url: endpointUrl }, null, 2);
    writeFileSync(join(appConfigDir, "sync-config.json"), body);
  };
}

/**
 * Launch two devices pointed at `server`, run `fn(a, b)`, and tear both down
 * (LIFO, in `finally`, so a scenario throw never leaks a process). Both devices
 * are seeded with the server endpoint via the SYNC-14 surface before boot.
 */
export async function withTwoDevices(
  server: EphemeralServer,
  fn: (a: AppSession, b: AppSession) => Promise<void>,
): Promise<void> {
  const seedConfig = syncConfigSeed(server.url);
  const a = await launchDevice(0, { seedConfig });
  try {
    const b = await launchDevice(1, { seedConfig });
    try {
      await fn(a, b);
    } finally {
      await b.teardown();
    }
  } finally {
    await a.teardown();
  }
}

/** The two-synced-devices precondition — see [`setupTwoSyncedDevices`]. */
export type TwoSyncedDevices = {
  a: AppSession;
  b: AppSession;
  /** Id of the note seeded on A + replicated to B; `null` with `seedNote: false`. */
  noteId: string | null;
  /** The shared vault password (for re-unlock scenarios). */
  password: string;
  teardown: () => Promise<void>;
};

/** Boot A (seeded vault) + B, enroll A, write+push one note, B joins + is
 *  approved + pulls it — the shared "two synced devices, one replicated note"
 *  precondition used by the sync-replication / prefs-sync / sync-attachments
 *  suites. Returns both devices, the synced note id, the shared vault password
 *  (for re-unlock scenarios), and a teardown.
 *
 *  `seedNote: false` skips the note-creation block AND B's note-replication
 *  wait, for variants whose scenario seeds its own synced state. A's explicit
 *  `sync_now` still runs — an empty vault authors a genesis head on push
 *  (§6.1 genesis-on-empty), which B's join gate needs: `join.verify` surfaces
 *  only once `sync_head_fingerprint` observes a pulled head. */
/** Options shared by every `setupTwoSyncedDevices` overload. */
interface SetupOptions {
  /** MYND-548: type these into the two enrollment forms' "Name this device"
   *  fields instead of accepting the pre-filled platform default. */
  deviceNames?: { a: string; b: string };
  /** MYND-548: runs on A while B is still PENDING — the only window in which the
   *  pending row is observable, since approval closes it. */
  whilePending?: (devices: { a: AppSession; b: AppSession }) => Promise<void>;
}

export async function setupTwoSyncedDevices(
  srv: EphemeralServer,
  opts?: SetupOptions & { seedNote?: true },
): Promise<TwoSyncedDevices & { noteId: string }>;
export async function setupTwoSyncedDevices(
  srv: EphemeralServer,
  opts: SetupOptions & { seedNote: boolean },
): Promise<TwoSyncedDevices>;
export async function setupTwoSyncedDevices(
  srv: EphemeralServer,
  opts: SetupOptions & { seedNote?: boolean } = {},
): Promise<TwoSyncedDevices> {
  const seedNote = opts.seedNote ?? true;
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
      if (opts.deviceNames) {
        const nameField = await a.session.byTestId("sync.enroll.device-name-input");
        await nameField.clear();
        await nameField.sendKeys(opts.deviceNames.a);
      }
      await (await a.session.byTestId("sync.enroll.password-input")).sendKeys(password);
      await (await a.session.byTestId("sync.enroll.submit")).click();
      await a.session.byTestId("sync.enroll.approved", { timeoutMs: 30_000 });
      await closeSettings(a.session);
      let noteId: string | null = null;
      if (seedNote) {
        await createNote(a.session, "SyncedNote");
        await new Promise((r) => setTimeout(r, 1500));
      }
      await ipcOk(a.session, "plugin:sync|sync_now", {});
      if (seedNote) {
        const ids = (await ipcOk(a.session, "plugin:notes|note_list", {})) as string[];
        noteId = ids[0];
      }

      // B: join (account# + password) → pending (waits on the approval gate).
      await b.session.byTestId("welcome.root", { timeoutMs: 20_000 });
      await (await b.session.byTestId("welcome.join-cta")).click();
      await b.session.byTestId("join.modal");
      await (await b.session.byTestId("join.server-input")).sendKeys(srv.url);
      await (await b.session.byTestId("join.account-input")).sendKeys(account);
      if (opts.deviceNames) {
        const nameField = await b.session.byTestId("join.device-name-input");
        await nameField.clear();
        await nameField.sendKeys(opts.deviceNames.b);
      }
      await (await b.session.byTestId("join.password-input")).sendKeys(password);
      await (await b.session.byTestId("join.submit")).click();
      await b.session.byTestId("join.pending", { timeoutMs: 30_000 });

      // A: approve B while it is pending.
      await openSettings(a.session);
      await (await a.session.byTestId("settings.tab-sync")).click();
      // Anything that must observe the PENDING row runs here — approving closes
      // that window for good. The row wait is scoped to that case: `approve-device`
      // is a CHILD of `pending-row`, so waiting for both on the default path would
      // just double the worst-case timeout for every suite that uses this setup.
      if (opts.whilePending) {
        await a.session.byTestId("sync.pending-row", { timeoutMs: 30_000 });
        await opts.whilePending({ a, b });
      }
      await (await a.session.byTestId("sync.approve-device", { timeoutMs: 30_000 })).click();
      await closeSettings(a.session);

      // B: auto-claim + pull → the mandatory SAS verify step → confirm the match →
      // editor (SYNC-40).
      await b.session.byTestId("join.verify", { timeoutMs: 30_000 });
      await (await b.session.byTestId("join.sas-match")).click();
      await b.session.byTestId("editor.root", { timeoutMs: 30_000 });
      await dismissImporterOffer(b.session);

      if (seedNote) {
        // B: pull until A's note replicates (the synced-baseline precondition).
        let replicated = false;
        for (let i = 0; i < 12 && !replicated; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await new Promise((r) => setTimeout(r, 1500));
          replicated = noteBlobCount(b.appDataDir) >= 1;
        }
        if (!replicated) throw new Error("setup: A's note never replicated to B");
      }

      const teardown = async () => {
        await b.teardown();
        await a.teardown();
      };
      return { a, b, noteId, password, teardown };
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
export function noteBlobCount(appDataDir: string): number {
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
