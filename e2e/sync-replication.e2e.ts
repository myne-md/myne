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
import { type AppSession, harnessSupported } from "./support/session";
import {
  type EphemeralServer,
  startSyncServer,
  syncServerSupported,
} from "./support/sync-server";
import { launchDevice, syncConfigSeed, withTwoDevices } from "./support/multi-device";
import type { Session } from "./support/webdriver";
import { seedVault } from "./support/fixtures";
import { patchDeletedField, patchFrontmatterField } from "../src/dialect";
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

  it("A enrolls + writes a note; B joins, A approves, B verifies the SAS, and the note replicates to B", async () => {
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

        // --- B: join the account (account# + password) → waits on the approval gate ---
        await b.session.byTestId("welcome.root", { timeoutMs: 20_000 });
        await (await b.session.byTestId("welcome.join-cta")).click();
        await b.session.byTestId("join.modal");
        await (await b.session.byTestId("join.server-input")).sendKeys(srv.url);
        await (await b.session.byTestId("join.account-input")).sendKeys(account);
        await (await b.session.byTestId("join.password-input")).sendKeys(password);
        await (await b.session.byTestId("join.submit")).click();
        // A loopback (http) join has no TLS cert to pin, so B lands straight on the
        // "waiting for approval" step (no `join.pinned`).
        await b.session.byTestId("join.pending", { timeoutMs: 30_000 });

        // --- A: approve B while it is pending (its row appears via the roster poll) ---
        await openSettings(a.session);
        await (await a.session.byTestId("settings.tab-sync")).click();
        await (await a.session.byTestId("sync.approve-device", { timeoutMs: 30_000 })).click();
        await closeSettings(a.session);

        // --- B: the pending screen auto-claims its token + pulls, then advances to
        // the mandatory head-fingerprint SAS eye-compare (SYNC-40). The fingerprint
        // surfaces as soon as the pulled head MAC-verifies — before the note bodies
        // finish downloading (the join-SAS latency fix) — so verify appears promptly. ---
        await b.session.byTestId("join.verify", { timeoutMs: 30_000 });
        const sas = (await (await b.session.byTestId("join.sas-fingerprint")).textContent()).trim();
        expect(sas.length, "B shows a non-empty head-fingerprint SAS").toBeGreaterThan(0);

        // B confirms the eye-compare match → routes into the editor.
        await (await b.session.byTestId("join.sas-match")).click();
        await b.session.byTestId("editor.root", { timeoutMs: 30_000 });
        await dismissImporterOffer(b.session);

        // A's note was pulled during the claim; confirm it landed on B's disk (a few
        // extra cycles cover any body download still in flight).
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

  it("keep-both: concurrent edits to the same note both survive on B", async () => {
    const srv = await startSyncServer();
    try {
      const { a, b, noteId, teardown } = await setupTwoSyncedDevices(srv);
      try {
        const idHex = noteId.replace(/-/g, "");
        // Concurrent edits: A and B change the SAME synced note to different
        // content (deterministic note_update IPC, no flaky editor typing).
        await ipcOk(a.session, "plugin:notes|note_update", { noteId, plaintext: "A edit keepboth" });
        await ipcOk(b.session, "plugin:notes|note_update", { noteId, plaintext: "B edit keepboth" });
        // A pushes first; B's push then loses the blob CAS, so the engine STAGES
        // A's remote revision (no wedge) instead of dropping an edit.
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        await ipcOk(b.session, "plugin:sync|sync_now", {});
        // Drive the keep-both materialization exactly as `useConflictMaterializer`
        // does — its `sync://changed` hook only fires off the 30s background loop,
        // so we run its real command chain (+ the real dialect copy-builder)
        // deterministically here.
        const pending = (await ipcOk(b.session, "plugin:sync|sync_pending_conflicts", {})) as string[];
        expect(pending).toContain(idHex);
        const remoteBody = (await ipcOk(b.session, "plugin:sync|sync_take_conflict", { originalIdHex: idHex })) as string;
        expect(remoteBody).toContain("A edit keepboth");
        await ipcOk(b.session, "plugin:notes|note_create", { plaintext: buildConflictCopy(remoteBody, noteId) });
        await ipcOk(b.session, "plugin:sync|sync_resolve_conflict", { originalIdHex: idHex });
        // Both revisions survive on B: its own edit at X + a conflict copy of A's.
        expect(noteBlobCount(b.appDataDir)).toBe(2);
      } finally {
        await teardown();
      }
    } finally {
      await srv.teardown();
    }
  });

  it("take-theirs: the remote version wins, the local original is tombstoned, and the win replicates to A", async () => {
    const srv = await startSyncServer();
    try {
      const { a, b, noteId, teardown } = await setupTwoSyncedDevices(srv);
      try {
        const idHex = noteId.replace(/-/g, "");
        // Concurrent edits to the SAME synced note (deterministic note_update).
        await ipcOk(a.session, "plugin:notes|note_update", { noteId, plaintext: "A edit taketheirs" });
        await ipcOk(b.session, "plugin:notes|note_update", { noteId, plaintext: "B edit taketheirs" });
        // A pushes first; B's push loses the CAS → the engine STAGES A's remote
        // revision (the same path keep-both uses).
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        await ipcOk(b.session, "plugin:sync|sync_now", {});
        // B materializes A's remote revision as a conflict copy (capture its id).
        const pending = (await ipcOk(b.session, "plugin:sync|sync_pending_conflicts", {})) as string[];
        expect(pending).toContain(idHex);
        const remoteBody = (await ipcOk(b.session, "plugin:sync|sync_take_conflict", { originalIdHex: idHex })) as string;
        expect(remoteBody).toContain("A edit taketheirs");
        const copyId = (await ipcOk(b.session, "plugin:notes|note_create", {
          plaintext: buildConflictCopy(remoteBody, noteId),
        })) as string;
        await ipcOk(b.session, "plugin:sync|sync_resolve_conflict", { originalIdHex: idHex });

        // "Use this version" / take-theirs (the `applyConflictVersion` chain):
        // promote the copy (clear its conflict markers) + tombstone the original.
        const copyContent = (await ipcOk(b.session, "plugin:notes|note_read", { noteId: copyId })) as string;
        await ipcOk(b.session, "plugin:notes|note_update", {
          noteId: copyId,
          plaintext: clearConflictMarkersRaw(copyContent),
        });
        const origContent = (await ipcOk(b.session, "plugin:notes|note_read", { noteId })) as string;
        const tombstoned = new TextDecoder().decode(
          patchDeletedField(new TextEncoder().encode(origContent), "2026-06-29T00:00:00Z"),
        );
        await ipcOk(b.session, "plugin:notes|note_update", { noteId, plaintext: tombstoned });
        await ipcOk(b.session, "plugin:sync|sync_mark_tombstone", { noteIdHex: idHex }, 5_000);

        // On B: the surviving copy carries A's remote content with no conflict
        // markers; the local original carries the `deleted:` tombstone.
        const survivor = (await ipcOk(b.session, "plugin:notes|note_read", { noteId: copyId })) as string;
        expect(survivor).toContain("A edit taketheirs");
        expect(survivor).not.toContain("conflict:");
        const localOrig = (await ipcOk(b.session, "plugin:notes|note_read", { noteId })) as string;
        expect(localOrig).toContain("deleted:");
        // Two blobs on disk: the promoted copy + the tombstoned original.
        expect(noteBlobCount(b.appDataDir)).toBe(2);

        // Push B's resolution; A pulls until the original shows the tombstone —
        // the "theirs won everywhere" replication. Generous budget (≈48 s) under
        // full-suite cumulative load (server + two app instances live).
        await ipcOk(b.session, "plugin:sync|sync_now", {});
        let propagated = false;
        for (let i = 0; i < 24 && !propagated; i++) {
          await ipcOk(a.session, "plugin:sync|sync_now", {});
          await new Promise((r) => setTimeout(r, 2_000));
          const onA = (await ipcOk(a.session, "plugin:notes|note_read", { noteId })) as string;
          propagated = onA.includes("deleted:");
        }
        expect(propagated, "the take-theirs tombstone replicated to A").toBe(true);
      } finally {
        await teardown();
      }
    } finally {
      await srv.teardown();
    }
  });

  it("tombstone: a deletion on A propagates to B", async () => {
    const srv = await startSyncServer();
    try {
      const { a, b, noteId, teardown } = await setupTwoSyncedDevices(srv);
      try {
        const idHex = noteId.replace(/-/g, "");
        // B sees the live note (no deleted: marker yet).
        const before = (await ipcOk(b.session, "plugin:notes|note_read", { noteId })) as string;
        expect(before).not.toContain("deleted:");
        // A deletes it via the real tombstone path: write a `deleted:` field (the
        // same dialect surgery `tombstoneNote` uses) + queue the tombstone flag.
        const current = (await ipcOk(a.session, "plugin:notes|note_read", { noteId })) as string;
        const tombstoned = new TextDecoder().decode(
          patchDeletedField(new TextEncoder().encode(current), "2026-06-21T00:00:00Z"),
        );
        await ipcOk(a.session, "plugin:notes|note_update", { noteId, plaintext: tombstoned });
        await ipcOk(a.session, "plugin:sync|sync_mark_tombstone", { noteIdHex: idHex }, 5_000);
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        // B pulls the deletion → its copy now carries the `deleted:` marker.
        // Generous budget (≈48 s): with the sync server + TWO app instances live,
        // the pull cadence slows markedly under full-suite cumulative load versus
        // an isolated run.
        let propagated = false;
        for (let i = 0; i < 24 && !propagated; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await new Promise((r) => setTimeout(r, 2_000));
          const body = (await ipcOk(b.session, "plugin:notes|note_read", { noteId })) as string;
          propagated = body.includes("deleted:");
        }
        expect(propagated, "the deletion replicated to B").toBe(true);
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

/** Build a keep-both conflict copy's content (remote body + the managed conflict
 *  frontmatter) — the same composition as `src/notes/conflictCopy.ts`. */
function buildConflictCopy(remoteBody: string, originalUuid: string): string {
  const enc = new TextEncoder();
  const withConflict = patchFrontmatterField(enc.encode(remoteBody), "conflict", "true");
  const withBoth = patchFrontmatterField(withConflict, "conflict_of", originalUuid);
  return new TextDecoder().decode(withBoth);
}

/** Clear a conflict copy's `conflict:` / `conflict_of:` markers — the same
 *  composition as `clearConflictMarkers` in `src/notes/conflictCopy.ts`. */
function clearConflictMarkersRaw(content: string): string {
  const enc = new TextEncoder();
  const noConflict = patchFrontmatterField(enc.encode(content), "conflict", null);
  const cleared = patchFrontmatterField(noConflict, "conflict_of", null);
  return new TextDecoder().decode(cleared);
}

/** Boot A (seeded vault) + B, enroll A, write+push one note, B joins + is
 *  approved + pulls it — the shared "two synced devices, one replicated note"
 *  precondition. Returns both devices, the synced note id, and a teardown. */
async function setupTwoSyncedDevices(srv: EphemeralServer): Promise<{
  a: AppSession;
  b: AppSession;
  noteId: string;
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
      await createNote(a.session, "SyncedNote");
      await new Promise((r) => setTimeout(r, 1500));
      await ipcOk(a.session, "plugin:sync|sync_now", {});
      const ids = (await ipcOk(a.session, "plugin:notes|note_list", {})) as string[];
      const noteId = ids[0];

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

      // B: auto-claim + pull → the mandatory SAS verify step → confirm the match →
      // editor (SYNC-40).
      await b.session.byTestId("join.verify", { timeoutMs: 30_000 });
      await (await b.session.byTestId("join.sas-match")).click();
      await b.session.byTestId("editor.root", { timeoutMs: 30_000 });
      await dismissImporterOffer(b.session);

      // B: pull until A's note replicates.
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
      return { a, b, noteId, teardown };
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
