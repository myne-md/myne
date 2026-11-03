// Multi-device E2E primitives (MYND-428 tasks 3 + 4).
//
// `launchDevice(index)` boots ONE production app-instance with its own
// driver+native port pair (off the `MYNE_E2E_*_PORT` base) and its own isolated
// data dir, so N instances coexist — the single-session `launchApp` machinery
// (teardown, artifacts, XDG isolation) is reused verbatim. `withTwoDevices`
// composes two devices + one ephemeral server, pointing both clients at the
// server via the REAL endpoint-config surface (SYNC-14 `sync-config.json` seeded
// into each device's app_config_dir — no test hook).

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { BETA_TERMS_VERSION } from "../../src/lib/load-bearing-copy";
import { join } from "node:path";
import { type AppSession, type LaunchOptions, launchApp } from "./session";
import { testIdSelector } from "./webdriver";
import type { EphemeralServer } from "./sync-server";
import { seedVault } from "./fixtures";
import {
  clickByTestId,
  closeSettings,
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  ipcOk,
  openSettings,
  pageSeatInvoke,
  selectSettingsTopic,
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
export function syncConfigSeed(
  endpointUrl: string,
  inviteCode?: string,
): (appConfigDir: string) => void {
  return (appConfigDir: string) => {
    const body = JSON.stringify(
      inviteCode ? { endpoint_url: endpointUrl, invite_code: inviteCode } : { endpoint_url: endpointUrl },
      null,
      2,
    );
    writeFileSync(join(appConfigDir, "sync-config.json"), body);
    // Every scenario that seeds an endpoint is a scenario about sync, not about
    // the terms — so they arrive already accepted (myne-ops#15). Without this
    // the beta-terms gate stands in front of `sync.enroll.*` and every one of
    // these specs times out on a testid that is no longer rendered.
    legalConsentSeed()(appConfigDir);
  };
}

/**
 * The joining device's half of a two-device fleet: join an existing account,
 * then wait for the §6.3 compare.
 *
 * **The UI door this drives is gone, and the command behind it is not.**
 * `welcome.join-cta` and the whole `join.*` modal were withdrawn on every client
 * (`decisions/sync/0767`, commit 5624c67a), while `sync_join_account` survives on
 * desktop for exactly the generations these suites seed — the ones with no person
 * to invite (`MYV1`, `NTV5`, `NTV6`; `0767`'s "population rather than an
 * oversight"). So the join goes through the same production IPC the deleted form
 * called, from the page seat: real command, real ACL, no test hook — the shape
 * `e2e/AGENTS.md` sanctions for a path whose affordance was withdrawn.
 *
 * Waiting for `welcome.join-cta` instead is what took every caller of
 * `setupTwoSyncedDevices` down for two days: the id renders nowhere in `src/`,
 * and `tests/screens/welcomeOneDoor.test.tsx` ASSERTS it is absent.
 */
export async function joinAccountDevice(
  b: AppSession,
  args: { serverUrl: string; accountNumber: string; password: string },
): Promise<{ deviceIdHex: string }> {
  await b.session.byTestId("welcome.root", { timeoutMs: 20_000 });
  const join = await pageSeatInvoke(
    b.session,
    "plugin:sync|sync_join_account",
    {
      serverUrl: args.serverUrl,
      accountNumber: args.accountNumber,
      password: args.password,
      confirmedFingerprint: null,
    },
    300_000,
  );
  if (join.err !== undefined) {
    throw new Error(`setup: the join was refused: ${JSON.stringify(join.err)}`);
  }
  const result = join.ok as { device_id_hex?: string };
  if (typeof result.device_id_hex !== "string") {
    throw new Error("setup: the join returned no device id");
  }
  // The join materializes the account's real vault on this device. **It does not
  // route this device to a compare screen, and it never did on desktop**: the
  // awaiting-approval wait is gated out wherever a vault may be the only copy
  // (`src/lib/pending-approval.ts`), because awaiting sync approval does not
  // block local use there. The §6.3 compare is the APPROVING device's screen
  // (`sync.approve-verify`), which `settleApproverCompare` closes.
  await b.session.refresh();
  return { deviceIdHex: result.device_id_hex };
}

/**
 * Unlock the vault a join just materialized and land in its editor.
 *
 * A reload first, because the page-seat join changed the disk under a running
 * boot probe: the app was on `welcome` and its stage knows nothing about a vault
 * it did not create. The probe then routes to unlock, and the join's own password
 * is the credential (the account join never holds the recovery phrase).
 */
/**
 * Land in the vault a join just materialized.
 *
 * **Two states are correct, and the second one is not a workaround.** The join
 * runs in the crash-free path and leaves the vault UNLOCKED: measured on this
 * seat (2026-11-03), the reloaded device comes up straight in the editor of the
 * joined vault, with the importer offer over it. A device that reloads later boot
 * routes to unlock instead, which is the state a returning user sees. So this
 * accepts whichever arrived rather than asserting one of them, and the
 * assertion the suites actually need — that B holds A's vault — is the editor
 * either way.
 */
export async function landInJoinedVault(b: AppSession, password: string): Promise<void> {
  const screen = `${testIdSelector("editor.root")}, ${testIdSelector("unlock.password-input")}`;
  await b.session.waitForElement(screen, { timeoutMs: 120_000 });
  if ((await b.session.byTestIdAll("unlock.password-input")).length > 0) {
    await unlockToEditor(b.session, password);
  }
  await b.session.byTestId("editor.root", { timeoutMs: 120_000 });
  await dismissImporterOffer(b.session);
}

/**
 * The approving device's half of the ceremony: approve B, then close the compare
 * it opens.
 *
 * **Closing it is not tidiness.** An unconfirmed compare holds the joiner's
 * pushes (`sync-replication`'s ceremony scenario proves the hold), so a fleet
 * that leaves the code on screen replicates nothing and the wait would read as a
 * sync defect.
 */
export async function settleApproverCompare(a: AppSession): Promise<void> {
  await (await a.session.byTestId("sync.approve-device", { timeoutMs: 60_000 })).click();
  await a.session.byTestId("sync.approve-verify", { timeoutMs: 60_000 });
  await a.session.byTestId("sync.sas-fingerprint", { timeoutMs: 60_000 });
  await clickByTestId(a.session, "sync.sas-match", { timeoutMs: 30_000 });
  await closeSettings(a.session);
}

/**
 * This device's view of the head it adopted, as the compare code renders it.
 *
 * A production read rather than a screen scrape, and on desktop it is the ONLY
 * way to see the joining device's side of the compare: the wait screen that shows
 * `pending-approval.sas` is gated out on a client that may hold the only copy
 * (`src/lib/pending-approval.ts`), so a desktop joiner shows no code anywhere.
 * The claim `sync-replication` makes is about the two devices reading the SAME
 * head, and this is that fact without inventing a surface for it.
 */
export async function adoptedHeadFingerprint(b: AppSession, timeoutMs = 90_000): Promise<string> {
  // Polled, because the head arrives on the joiner's FIRST cycle after approval
  // and that cycle is armed by the unlock edge rather than by anything this
  // helper can click.
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    // A cycle per poll, because the head is adopted by one and the joiner's own
    // scheduler is armed on an edge this helper cannot reach on every path.
    await ipcOk(b.session, "plugin:sync|sync_now", {});
    const value = (await ipcOk(b.session, "plugin:sync|sync_head_fingerprint", {})) as string | null;
    last = (value ?? "").trim();
    if (last !== "") return last;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`setup: this device adopted no head within ${timeoutMs} ms, so there is nothing to compare`);
}

/**
 * A saved HTTPS URL for UI-only scenarios. No server is contacted on read.
 */
export function httpsConfigSeed(endpointUrl = "https://sync.invalid"): (appConfigDir: string) => void {
  return (appConfigDir: string) => {
    const body = JSON.stringify({ endpoint_url: endpointUrl }, null, 2);
    writeFileSync(join(appConfigDir, "sync-config.json"), body);
    legalConsentSeed()(appConfigDir);
  };
}

/**
 * A `seedConfig` callback that writes the device-local beta-terms acceptance —
 * the same `legal-consent.json` the real `sync_accept_beta_terms` command
 * persists (myne-ops#15).
 *
 * Exported separately from {@link syncConfigSeed} so a scenario can seed the
 * acceptance WITHOUT an endpoint, which is what the gate's own spec needs for
 * its "already accepted" leg: it must prove the screen stays away on a device
 * that has accepted, and pointing that device at a server would be testing
 * something else.
 *
 * The version is read from `@myne/copy` rather than written as `"1"` — the
 * whole mechanism turns on the stored value matching the shipped one, so a
 * hardcoded literal here would keep passing after a version bump while every
 * real device correctly re-asked.
 */
export function legalConsentSeed(
  version: string = BETA_TERMS_VERSION,
): (appConfigDir: string) => void {
  return (appConfigDir: string) => {
    const body = JSON.stringify({ beta_terms_version: version }, null, 2);
    writeFileSync(join(appConfigDir, "legal-consent.json"), body);
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
  /** The seeded vault's 24-word recovery phrase — `vault_migrate` requires it
   *  (§10.4.1: the re-key rewraps under BOTH credentials, so a migration that
   *  could not prove the phrase would silently orphan recovery). */
  phrase: string;
  teardown: () => Promise<void>;
};

/** Boot A (seeded vault) + B, enroll A, write+push one note, B joins + is
 *  approved + pulls it — the shared "two synced devices, one replicated note"
 *  precondition used by the sync-replication / prefs-sync / sync-attachments
 *  suites. Returns both devices, the synced note id, the shared vault password
 *  (for re-unlock scenarios), and a teardown.
 *
 *  **What the pair IS, since 2026-11-01.** B joins by ACCOUNT (the surviving
 *  `sync_join_account` command, driven from the page seat because its UI door was
 *  withdrawn — see `joinAccountDevice`), is approved by A, and then opens the
 *  vault with the same password. There is no compare step on B's side: the
 *  desktop client is gated out of the wait screen that would show one
 *  (`src/lib/pending-approval.ts`), so the §6.3 compare is A's screen and this
 *  helper closes it. A fleet that needs the two devices to AGREE on a head reads
 *  B's side over IPC instead (`adoptedHeadFingerprint`).
 *
 *  `seedNote: false` skips the note-creation block AND B's note-replication
 *  wait, for variants whose scenario seeds its own synced state. A's explicit
 *  `sync_now` still runs — an empty vault authors a genesis head on push
 *  (§6.1 genesis-on-empty), and the head is what B adopts on its first cycle. */
/** Options shared by every `setupTwoSyncedDevices` overload. */
interface SetupOptions {
  /**
   * Which generation A's vault is seeded in. **Defaults to `"v0.1"`** — not
   * because that is what a user gets today (a new vault is born v0.2,
   * `decisions.md` 2026-08-13), but because most scenarios in these suites are
   * about `MY01` semantics that a v0.2 vault does not have: keep-both conflict
   * copies, take-theirs, the `snapshots/` store. Those need a pre-flip vault to
   * have a subject at all.
   *
   * Pass `"v0.2"` for a fleet that is v0.2 FROM BIRTH — which is a different
   * thing from a migrated fleet (`migrateFleetToV02`) and worth covering
   * separately: enrolment derives the credential wrap keys under the vault's
   * generation, so a birth-v0.2 fleet is the only shape that exercises the v0.2
   * arm of the enrol path.
   */
  generation?: "v0.1" | "v0.2";
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
  let phrase = "";
  const a = await launchDevice(0, {
    seedConfig: syncConfigSeed(srv.url),
    seed: (appDataDir) => {
      const v = seedVault(appDataDir, {
        password: "CanaryPass-9-animals!",
        generation: opts.generation ?? "v0.1",
      });
      account = v.account;
      password = v.password;
      phrase = v.phrase;
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
      // The enrol form is on the panel's DEVICES topic since the topic split
      // (myne-md/myne#885). Waiting for it on the panel's first topic is the
      // stale-selector failure that took this helper's every caller down with it:
      // the panel opens on Connection, so the form never appeared.
      await selectSettingsTopic(a.session, "sync", "devices");
      await (await a.session.byTestId("sync.enroll.account-input")).sendKeys(account);
      if (opts.deviceNames) {
        // `replaceText`, not clear()+sendKeys: the field is PRE-FILLED with the
        // platform suggestion, and W3C clear bypasses React's value tracker on the
        // Input primitive, so the typed name would append to it.
        await (
          await a.session.byTestId("sync.enroll.device-name-input")
        ).replaceText(opts.deviceNames.a);
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

      // B: join the account → pending (waits on the approval gate). The join is
      // `joinAccountDevice`'s subject, and its header carries why this is the
      // page seat rather than a click: the affordance was withdrawn by
      // `decisions/sync/0767`, the command was not.
      const joined = await joinAccountDevice(b, {
        serverUrl: srv.url,
        accountNumber: account,
        password,
      });

      // A: approve B while it is pending, then CLOSE the compare the approval
      // opens — an unconfirmed compare holds the joiner's pushes, so leaving it
      // on screen would make every replication wait below read as a sync defect.
      await openSettings(a.session);
      await (await a.session.byTestId("settings.tab-sync")).click();
      await selectSettingsTopic(a.session, "sync", "devices");
      // Anything that must observe the PENDING row runs here — approving closes
      // that window for good. The row wait is scoped to that case: `approve-device`
      // is a CHILD of `pending-row`, so waiting for both on the default path would
      // just double the worst-case timeout for every suite that uses this setup.
      if (opts.whilePending) {
        await a.session.byTestId("sync.pending-row", { timeoutMs: 30_000 });
        await opts.whilePending({ a, b });
      }
      await settleApproverCompare(a);

      // B: unlock the vault the join materialized, then pull. There is no compare
      // step here and there cannot be one: see `alignedHeadFingerprint`'s header.
      await landInJoinedVault(b, password);
      // A named fleet is applied HERE rather than typed into a join form: the
      // form's "Name this device" field went with the modal, and an approved
      // device adopts the platform suggestion on its own
      // (`decisions/sync/0770`). This is the same prefs write the Devices panel
      // makes when a user renames a row, so a named fleet is still the real
      // surface and not a seeded value.
      if (opts.deviceNames) {
        // **B is named BY THE PEER, because that is the path the product has.**
        // The join form's "Name this device" field went with the modal (0767), and
        // the unattended self-name write refuses on exactly this device: the
        // backend will not create a joiner's `vault.prefs` (the enrollment seed is
        // keyed on that file being absent), so `selfName: true` answers `false` and
        // names nobody — measured, ten attempts over fifteen seconds. What lands is
        // the peer's write, which is the same call the Devices panel makes when a
        // user renames a row from the approving device (`decisions/sync/0770`).
        const written = await pageSeatInvoke(
          a.session,
          "plugin:prefs|set_device_name",
          { deviceIdHex: joined.deviceIdHex, name: opts.deviceNames.b, selfName: false },
          30_000,
        );
        if (written.err !== undefined || written.ok !== true) {
          throw new Error(`setup: A could not name B: ${JSON.stringify(written.err ?? written.ok)}`);
        }
        // Push it, so the pairwise rename below has a peer-held entry to overwrite
        // and the caller's own name reads happen against a settled prefs blob.
        await ipcOk(a.session, "plugin:sync|sync_now", {});
      }

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
      return { a, b, noteId, password, phrase, teardown };
    } catch (e) {
      await b.teardown();
      throw e;
    }
  } catch (e) {
    await a.teardown();
    throw e;
  }
}

/**
 * Move a synced two-device fleet from v0.1 to v0.2 (§10.4.1, myne-md/myne#446).
 *
 * **Exactly one device migrates.** `vault_migrate` mints a FRESH random
 * `root_key`, so running it on both devices gives them different vault keys and
 * forks the fleet irrecoverably — neither can decrypt the other's blobs and
 * there is no merge that recovers it. (The skipped NC05 scenario this helper
 * un-blocks carried a note saying the harness should "migrate both devices";
 * that setup would have been the hazard, not the fix.)
 *
 * The other device adopts the new generation instead, which is the production
 * path #429 specifies:
 *
 *  1. **A migrates.** The re-key drops A's unlocked slot — it held v0.1 keys
 *     that open none of the new `NC05` blobs — so A routes back to Unlock and
 *     re-unlocks under the same password (the NTV5 meta rewraps it).
 *  2. **A syncs.** Its pull cannot open the head it wrote under the OLD root, so
 *     the one-shot re-base flag lets it adopt that head's id unverified, author
 *     a fresh head under the new root, and push it — along with the NTV5 meta
 *     and the whole re-keyed corpus.
 *  3. **B syncs.** Its pull hits the same unopenable head with NO re-base flag,
 *     asks the one question that separates a migration from an attack (is the
 *     server's `vault.meta` a newer generation?), and on `true` locks the vault
 *     rather than crying forgery. `sync_now` reports a failed cycle here — that
 *     is the SUCCESS path for this step, not an error to retry.
 *  4. **B re-unlocks**, re-deriving the v0.2 root from the meta the meta phase
 *     adopted, then pulls the re-keyed corpus.
 *
 * After this returns, both devices hold the same `NC05` notes under the same
 * generation, and the note ids are unchanged (the migration re-encodes bodies;
 * it does not re-issue identities).
 */
export async function migrateFleetToV02(devices: TwoSyncedDevices): Promise<void> {
  const { a, b, password, phrase } = devices;

  // (1) A migrates. Real IPC, real production KDF path — no test hook.
  await ipcOk(a.session, "plugin:vault-migrate|vault_migrate", { password, phrase }, 300_000);
  await a.session.refresh();
  await unlockToEditor(a.session, password);
  // The TOLERANT variant on purpose: this is a re-unlock of a populated vault,
  // and the fresh-vault importer offer does not re-appear on a second mount —
  // the hard `dismissImporterOffer` waits 10 s for an overlay that will never
  // exist and fails the scenario in the setup step.
  await dismissImporterOfferIfPresent(a.session);

  // (2) A publishes the new generation. Two cycles: the first lands the re-based
  //     head + the replaced verifier, the second the re-keyed corpus behind it.
  await ipcOk(a.session, "plugin:sync|sync_now", {});
  await new Promise((r) => setTimeout(r, 1500));
  await ipcOk(a.session, "plugin:sync|sync_now", {});

  // (3) B meets the new generation and locks. The cycle FAILS by design, so this
  //     goes through the page seat rather than `ipcOk` — the command answers
  //     with a status, and treating a non-`Idle` status as a harness error here
  //     would be asserting the opposite of the specified behaviour.
  await pageSeatInvoke(b.session, "plugin:sync|sync_now", {}, 60_000);
  await b.session.byTestId("sync.vault-rekeyed", { timeoutMs: 30_000 });

  // (4) B re-unlocks under the adopted NTV5 meta and pulls the re-keyed corpus.
  await b.session.refresh();
  await unlockToEditor(b.session, password);
  await dismissImporterOfferIfPresent(b.session);
  for (let i = 0; i < 12; i++) {
    await ipcOk(b.session, "plugin:sync|sync_now", {});
    await new Promise((r) => setTimeout(r, 1500));
    if (noteBlobMagics(b.appDataDir).every((m) => m === "NC05")) return;
  }
  throw new Error("setup: the re-keyed NC05 corpus never replicated to B");
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

/**
 * The 4-byte magic of every `.myn` blob under a device's app-data dir.
 *
 * `MY01` is the v0.1 note, `NC05` the v0.2 CRDT note (`protocol.md` §10.7). Read
 * from disk rather than asked of the app, because "which format is this note
 * stored in" is a property of the bytes — a command that decodes either one
 * cannot tell them apart for us.
 */
export function noteBlobMagics(appDataDir: string): string[] {
  const out: string[] = [];
  try {
    for (const v of readdirSync(join(appDataDir, "vaults"))) {
      const notes = join(appDataDir, "vaults", v, "notes");
      try {
        for (const f of readdirSync(notes)) {
          if (!f.endsWith(".myn")) continue;
          out.push(readFileSync(join(notes, f)).subarray(0, 4).toString("latin1"));
        }
      } catch {
        /* this vault has no notes dir yet */
      }
    }
  } catch {
    /* no vaults dir */
  }
  return out;
}
