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
import {
  launchDevice,
  migrateFleetToV02,
  noteBlobCount,
  noteBlobMagics,
  setupTwoSyncedDevices,
  syncConfigSeed,
  withTwoDevices,
} from "./support/multi-device";
import { type Element, type Session, testIdSelector } from "./support/webdriver";
import { seedVault } from "./support/fixtures";
import { patchDeletedField, patchFrontmatterField } from "../src/dialect";
import {
  closeSettings,
  createNote,
  clickByTestId,
  dismissImporterOffer,
  ipcOk,
  openSettings,
  pageSeatInvoke,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";

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

// Stale-pane scenario constants — single lowercase-alnum tokens ≥24 chars (the
// plaintext-scan needle-design rule: tokenizer-survivable, in-source scenario
// constants, not credentials).
const REMOTE_MARKER = "remoteeditalpha7k2m9qx4w8e5rj0";
const LOCAL_MARKER = "stalepanebravo3f6h1zn8c2vb5kk9";
const SPLIT_SIDE_TITLE = "splitsidenote1d4t7yp2mq6xs9zz0";

// CRDT-merge scenario constants (myne-md/myne#446). Same needle-design rule as
// the stale-pane markers above: single lowercase-alnum tokens ≥24 chars, so a
// tokenizer cannot split one and a count is exact.
//
// `BASE_MARKER` belongs to NEITHER edit — it is in the shared base both devices
// start from, which is what makes its COUNT the discriminator for #428's
// doubling bug (see the scenario for why a presence check cannot see it).
const BASE_MARKER = "crdtsharedbase5w1qk8mz3xr7hv2tt";
const A_MARKER = "crdteditalpha9j4dc6nb0ply5fg1uu";
const B_MARKER = "crdteditbravo2s8we4rt7yu0iop3mm";
/** The `deleted:` value A writes — asserted VERBATIM on B (#431). */
const DELETED_AT = "2026-08-11T04:05:06Z";
/** The v0.2 CRDT note magic (`protocol.md` §10.7). */
const CRDT_MAGIC = "NC05";

/** Non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

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

  // myne#462. The suite has driven this ceremony since `sr1` landed and has
  // never once compared the two codes to each other — `sr1` reads B's and
  // asserts only that it is non-empty, and it closes A's Settings immediately
  // after approving, so A's code is not even on screen. Every layer below this
  // one proves `head_id -> fingerprint` is a correct, frozen function; none of
  // them proves the two devices feed it the SAME head, which is the whole
  // defect.
  //
  // Bespoke rather than through `setupTwoSyncedDevices`, precisely because that
  // helper closes A's verify screen (`multi-device.ts`, the `closeSettings`
  // right after approve) — this scenario needs to be in exactly the state the
  // helper leaves behind.
  it("both devices show the SAME verification code, and keep agreeing across a mid-ceremony write", async () => {
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
        await unlockToEditor(a.session, password);
        await dismissImporterOffer(a.session);
        await openSettings(a.session);
        await (await a.session.byTestId("settings.tab-sync")).click();
        await (await a.session.byTestId("sync.enroll.account-input")).sendKeys(account);
        await (await a.session.byTestId("sync.enroll.password-input")).sendKeys(password);
        await (await a.session.byTestId("sync.enroll.submit")).click();
        await a.session.byTestId("sync.enroll.approved", { timeoutMs: 30_000 });
        await closeSettings(a.session);

        // A note, so the vault is not the empty-genesis case (which has its own
        // coverage in `orchestrator.rs`).
        await createNote(a.session, "sas-compare");
        await typeIntoEditor(a.session, "before the ceremony");
        await waitForSaved(a.session);
        await ipcOk(a.session, "plugin:sync|sync_now", {});

        // B joins and waits.
        await (await b.session.byTestId("welcome.join-cta", { timeoutMs: 30_000 })).click();
        await b.session.byTestId("join.modal", { timeoutMs: 30_000 });
        await (await b.session.byTestId("join.server-input")).sendKeys(srv.url);
        await (await b.session.byTestId("join.account-input")).sendKeys(account);
        await (await b.session.byTestId("join.password-input")).sendKeys(password);
        await (await b.session.byTestId("join.submit")).click();
        await b.session.byTestId("join.pending", { timeoutMs: 30_000 });

        // A approves and STAYS on the verify screen — the state `sr1` leaves.
        await openSettings(a.session);
        await (await a.session.byTestId("settings.tab-sync")).click();
        await (await a.session.byTestId("sync.approve-device", { timeoutMs: 30_000 })).click();
        await a.session.byTestId("sync.approve-verify", { timeoutMs: 30_000 });
        await b.session.byTestId("join.verify", { timeoutMs: 30_000 });

        // Both codes, read from the two live screens. Polled to convergence
        // rather than compared on first read: the assertion is that they AGREE,
        // not that they agree within one particular millisecond.
        const readBoth = async () => {
          const sa = (
            await (await a.session.byTestId("sync.sas-fingerprint", { timeoutMs: 30_000 })).textContent()
          ).trim();
          const sb = (
            await (await b.session.byTestId("join.sas-fingerprint", { timeoutMs: 30_000 })).textContent()
          ).trim();
          return [sa, sb] as const;
        };
        let [sasA, sasB] = await readBoth();
        for (let i = 0; i < 10 && sasA !== sasB; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          [sasA, sasB] = await readBoth();
        }
        expect(sasA.length, "A shows a code").toBeGreaterThan(0);
        expect(sasB, "both devices show the same verification code").toBe(sasA);

        // The reproducer: a vault write DURING the ceremony. Before the fix this
        // authored a new head, one screen followed it and the other did not, and
        // the user was shown a mismatch that meant nothing. The push hold is what
        // stops the head moving here.
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        await new Promise((r) => setTimeout(r, 2500));
        const [afterA, afterB] = await readBoth();
        expect(afterB, "the two codes still agree after a mid-ceremony sync").toBe(afterA);

        // Close the compare on both sides, and prove the hold RELEASED: the note
        // A wrote must still reach B.
        await clickByTestId(a.session, "sync.sas-match");
        await closeSettings(a.session);
        await clickByTestId(b.session, "join.sas-match");
        await b.session.byTestId("editor.root", { timeoutMs: 30_000 });
        await dismissImporterOffer(b.session);

        let replicated = false;
        for (let i = 0; i < 12 && !replicated; i++) {
          await pageSeatInvoke(b.session, "plugin:sync|sync_now", {}, 20_000);
          await new Promise((r) => setTimeout(r, 1500));
          replicated = noteBlobCount(b.appDataDir) >= 1;
        }
        expect(replicated, "the held push flushed once the compare closed").toBe(true);
      } finally {
        await b.teardown();
      }
    } finally {
      await a.teardown();
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

  // #422 (ASM-6→B) + myne-md/myne#446: the CRDT (NC05) counterpart of keep-both.
  // Two devices concurrently edit the SAME NC05 note, the engine MERGES (no
  // keep-both copy, no Conflicts row), and the pulling device shows the calm
  // "updated from another device" hint (`sync.remote-merge-hint`).
  //
  // Live since myne-md/myne#447. This scenario is what found that defect — the
  // peer could not join the generation a migration creates, so `migrateFleetToV02`
  // never got past its adoption step — and it is what proves the fix: B only
  // reaches the assertions below by staging the server's `NTV5` meta, opening it
  // with its own password, and promoting it.
  //
  // The assertions are COUNT-based on purpose (#446): the previous version
  // asserted `toContain("A")` + `toContain("B")`, which #428's doubling bug
  // satisfies. See the count comment inside.
  it("crdt-merge: concurrent NC05 edits merge with the hint, no keep-both, no Conflicts row", async () => {
    const srv = await startSyncServer();
    try {
      // BORN v0.2 rather than migrated (`decisions.md` 2026-08-13): this is the
      // vault a new user gets, and it is also the only fleet shape that
      // exercises the v0.2 arm of device ENROLMENT — the enrol path derives both
      // credential wrap keys under the vault's generation, and deriving them
      // under v0.1 against a v0.2 meta reports a correct password as wrong.
      // `crdt-remove-wins` below keeps the migrated route, so both ways of
      // reaching a CRDT fleet stay covered.
      const devices = await setupTwoSyncedDevices(srv, { generation: "v0.2" });
      const { a, b, noteId, teardown } = devices;
      try {
        const idHex = noteId.replace(/-/g, "");
        // The premise of everything below: this note is a v0.2 CRDT blob on both
        // devices. Asserted, not assumed — every claim here is about NC05 merge
        // semantics, and against a MY01 note they would all be vacuous.
        expect(noteBlobMagics(a.appDataDir)).toEqual([CRDT_MAGIC]);
        expect(noteBlobMagics(b.appDataDir)).toEqual([CRDT_MAGIC]);

        // A shared base both devices agree on, carrying a marker that belongs to
        // NEITHER edit. That marker is the whole discriminator — see below.
        await ipcOk(a.session, "plugin:notes|note_update", {
          noteId,
          plaintext: `# Merge\n\n${BASE_MARKER}\n`,
        });
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        let based = false;
        for (let i = 0; i < 24 && !based; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await new Promise((r) => setTimeout(r, 2_000));
          based = (
            (await ipcOk(b.session, "plugin:notes|note_read", { noteId })) as string
          ).includes(BASE_MARKER);
        }
        expect(based, "the shared base replicated to B before the divergence").toBe(true);

        // Diverge: each device appends its own marker to the SAME base.
        const baseBody = (await ipcOk(a.session, "plugin:notes|note_read", { noteId })) as string;
        await ipcOk(a.session, "plugin:notes|note_update", {
          noteId,
          plaintext: `${baseBody}\n${A_MARKER}\n`,
        });
        await ipcOk(b.session, "plugin:notes|note_update", {
          noteId,
          plaintext: `${baseBody}\n${B_MARKER}\n`,
        });
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        await ipcOk(b.session, "plugin:sync|sync_now", {});

        // NC05 merges — B stages NO keep-both conflict for this note...
        const pending = (await ipcOk(b.session, "plugin:sync|sync_pending_conflicts", {})) as string[];
        expect(pending).not.toContain(idHex);
        // ...its single blob still holds BOTH edits (merge, not fork)...
        expect(noteBlobCount(b.appDataDir)).toBe(1);
        const merged = (await ipcOk(b.session, "plugin:notes|note_read", { noteId })) as string;

        // COUNTS, not `toContain` (#446). The skipped version of this scenario
        // asserted `toContain("A")` + `toContain("B")`, and #428's bug satisfies
        // both: a whole-body `splice_text` records "delete everything, then
        // insert my entire document", so after the merge both deletions AND both
        // insertions survive and the note comes back containing the shared base
        // TWICE — once inside each inserted copy. A presence check cannot see
        // that; the base marker's count is exactly what can.
        expect(occurrences(merged, BASE_MARKER)).toBe(1);
        expect(occurrences(merged, A_MARKER)).toBe(1);
        expect(occurrences(merged, B_MARKER)).toBe(1);
        // ...and the calm hint is shown on the pulling device.
        await b.session.byTestId("sync.remote-merge-hint", { timeoutMs: 10_000 });
      } finally {
        await teardown();
      }
    } finally {
      await srv.teardown();
    }
  });

  // myne-md/myne#431 + #446: remove-wins on the CRDT plane.
  //
  // A deletes the note while B edits it, concurrently. The merge must keep it
  // DELETED — and, critically, must not fabricate. Without the remove-wins gate
  // the two front-matter blocks merge character-wise and produce a `deleted:`
  // timestamp NEITHER device wrote, blended from A's `deleted:` and B's
  // `updated:`. That value parses cleanly, so nothing downstream can catch it;
  // the only place it is visible is here, against the exact bytes.
  // Live since myne-md/myne#447 (see the note above). It asserts A's `deleted:`
  // value VERBATIM, because #431's failure mode is a well-formed timestamp
  // neither device wrote — blended character-wise from A's `deleted:` and B's
  // `updated:`. It parses cleanly, so `toContain("deleted:")` would pass against
  // the fabrication.
  it("crdt-remove-wins: a deletion beats a concurrent edit, with no fabricated timestamp", async () => {
    const srv = await startSyncServer();
    try {
      const devices = await setupTwoSyncedDevices(srv);
      const { a, b, noteId, teardown } = devices;
      try {
        const idHex = noteId.replace(/-/g, "");
        await migrateFleetToV02(devices);
        expect(noteBlobMagics(b.appDataDir)).toEqual([CRDT_MAGIC]);

        // A tombstones through the real path (the `tombstoneNote` dialect
        // surgery + the queued flag), B edits the same note concurrently.
        const current = (await ipcOk(a.session, "plugin:notes|note_read", { noteId })) as string;
        const tombstoned = new TextDecoder().decode(
          patchDeletedField(new TextEncoder().encode(current), DELETED_AT),
        );
        await ipcOk(a.session, "plugin:notes|note_update", { noteId, plaintext: tombstoned });
        await ipcOk(a.session, "plugin:sync|sync_mark_tombstone", { noteIdHex: idHex }, 5_000);
        const bBody = (await ipcOk(b.session, "plugin:notes|note_read", { noteId })) as string;
        await ipcOk(b.session, "plugin:notes|note_update", {
          noteId,
          plaintext: `${bBody}\n${B_MARKER}\n`,
        });

        await ipcOk(a.session, "plugin:sync|sync_now", {});
        await ipcOk(b.session, "plugin:sync|sync_now", {});

        // The deletion wins on B, even though B's edit is newer.
        const after = (await ipcOk(b.session, "plugin:notes|note_read", { noteId })) as string;
        expect(after).toContain("deleted:");
        // The timestamp is A's, VERBATIM. This is the assertion the issue is
        // about: a blended value is still a well-formed timestamp, so asserting
        // "contains deleted:" alone would pass against the fabrication.
        expect(after).toContain(DELETED_AT);
        // And no keep-both copy was staged — remove-wins is a merge outcome, not
        // a conflict the user has to arbitrate.
        const pending = (await ipcOk(b.session, "plugin:sync|sync_pending_conflicts", {})) as string[];
        expect(pending).not.toContain(idHex);
        expect(noteBlobCount(b.appDataDir)).toBe(1);
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

  it("unlock-edge + poke: a change pushed while B is locked appears within seconds of B's unlock — no Sync Now, no 30 s poll wait", async () => {
    // Vault-count precondition: 1 seeded vault on A, 1 join-bootstrapped on B.
    // Pins the sync-latency package (decisions.md 2026-07-12): the locked→
    // unlocked edge arms a one-shot immediate pull and the always-on SSE poke
    // stream does a catch-up pull on (re)connect, so a change that landed on
    // the server while this device was locked surfaces right after unlock —
    // WITHOUT a manual Sync Now and WITHOUT waiting out the 30 s poll boundary.
    const srv = await startSyncServer();
    try {
      const { a, b, noteId, password, teardown } = await setupTwoSyncedDevices(srv);
      try {
        // B locks via the real bottom-bar CTA: the sync loop hard-idles and
        // the poke stream tears down (locked devices hold no server stream).
        await (await b.session.byTestId("editor.lock-cta")).click();
        await b.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });

        // A edits the already-synced note and pushes while B is locked.
        await ipcOk(a.session, "plugin:notes|note_update", {
          noteId,
          plaintext: "edited while B slept",
        });
        await ipcOk(a.session, "plugin:sync|sync_now", {});

        // B unlocks through the real UI. From here on B gets NO sync nudge of
        // any kind — the unlock-edge arm (+ SSE catch-up) must pull on its own.
        await unlockToEditor(b.session, password);

        // Discriminating budget: comfortably above container jitter, but well
        // UNDER the 30 s poll interval — with the edge trigger and poke dead,
        // the first chance to see the edit would be the 30 s boundary, so a
        // green here can only come from the new immediate-pull paths.
        let fresh = false;
        const deadline = Date.now() + 20_000;
        while (!fresh && Date.now() < deadline) {
          const body = (await ipcOk(b.session, "plugin:notes|note_read", { noteId })) as string;
          fresh = body.includes("edited while B slept");
          if (!fresh) await new Promise((r) => setTimeout(r, 500));
        }
        expect(fresh, "B pulled A's edit right after unlock without a manual sync").toBe(true);
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

  it("unfocused split pane reloads on pull and never clobbers the remote edit", async () => {
    // Vault-count precondition: 1 seeded vault on A, 1 join-bootstrapped on B.
    // The stale-pane overwrite story: B parks the synced note X in an UNFOCUSED
    // split pane (X is NOT the selected note), A rewrites X remotely, B pulls.
    // The unfocused pane must re-read the pulled body — and an edit then typed
    // INTO that pane must build on the pulled body, so B's push never turns the
    // stale buffer into a clean linear advance that silently erases A's edit
    // (pre-fix: only the SELECTED pane reloaded on pull).
    const srv = await startSyncServer();
    try {
      const { a, b, noteId, teardown } = await setupTwoSyncedDevices(srv);
      try {
        // B: create a local side note, put X in the focused pane, then split
        // the side note out via the row context menu (the workspace-state
        // suite's driver-addressable split gesture). The side pane takes focus
        // AND selection, leaving X's pane unfocused (X ≠ selectedId).
        await createNote(b.session, SPLIT_SIDE_TITLE);
        await (await noteRow(b.session, noteId)).click();
        const sideId = await otherNoteRowId(b.session, noteId);
        await rowMenuPick(b.session, sideId, "open-to-side");
        const xPaneId = await unfocusedPaneIdShowing(b.session, noteId);

        // A: rewrite X with the remote marker and push (deterministic
        // note_update — the keep-both pattern, no flaky remote typing).
        await ipcOk(a.session, "plugin:notes|note_update", {
          noteId,
          plaintext: `${REMOTE_MARKER}\n`,
        });
        const aDisk = (await ipcOk(a.session, "plugin:notes|note_read", {
          noteId,
        })) as string;
        expect(aDisk.includes(REMOTE_MARKER), "A's update landed on A's own disk").toBe(true);
        // sync_now resolves Ok even for a failed cycle (the status IS the
        // result) — assert the push cycle actually succeeded.
        const stA = (await ipcOk(a.session, "plugin:sync|sync_now", {})) as {
          state?: string;
        };
        expect(
          stA?.state,
          `A's push cycle after the update (got ${JSON.stringify(stA)})`,
        ).toBe("idle");

        // B: pull until A's edit is on DISK (the engine leg), then until the
        // UNFOCUSED pane's live document shows it (the reload half of the fix
        // — pre-fix this pane kept the stale buffer and this poll timed out).
        // Two-stage on purpose: a disk-stage failure is a sync-engine problem,
        // a pane-stage failure is the UI reload chain.
        let onDisk = false;
        let lastStB: unknown = null;
        let lastBody = "";
        for (let i = 0; i < 12 && !onDisk; i++) {
          lastStB = await ipcOk(b.session, "plugin:sync|sync_now", {});
          await new Promise((r) => setTimeout(r, 1500));
          lastBody = (await ipcOk(b.session, "plugin:notes|note_read", {
            noteId,
          })) as string;
          onDisk = lastBody.includes(REMOTE_MARKER);
        }
        const bPending = (await ipcOk(
          b.session,
          "plugin:sync|sync_pending_conflicts",
          {},
        )) as string[];
        expect(
          onDisk,
          `A's edit reached B's disk (engine leg; B last status ${JSON.stringify(lastStB)}; ` +
            `B pending conflicts ${JSON.stringify(bPending)}; B blob count ${noteBlobCount(b.appDataDir)}; ` +
            `B X body head ${JSON.stringify(lastBody.slice(0, 80))})`,
        ).toBe(true);
        let reloaded = false;
        for (let i = 0; i < 12 && !reloaded; i++) {
          reloaded = (await paneText(b.session, xPaneId)).includes(REMOTE_MARKER);
          if (!reloaded) await new Promise((r) => setTimeout(r, 1000));
        }
        expect(reloaded, "the unfocused pane re-read A's pulled edit").toBe(true);

        // B: type a second marker into X's pane through the real editor — the
        // buffer that pre-fix still held the pre-pull body. X's pane is the
        // FIRST pane in DOM order, so the shared typing helper (which targets
        // the first CodeMirror surface, and whose click also moves pane focus
        // there) lands in it. Autosave, then push.
        await typeIntoEditor(b.session, `\n${LOCAL_MARKER}\n`);
        await waitForSaved(b.session);
        await ipcOk(b.session, "plugin:sync|sync_now", {});

        // A: pull until BOTH markers coexist in X. The pre-fix failure mode
        // pushed B's stale-based buffer as a clean linear advance (no conflict
        // staged, nothing to keep-both), erasing A's marker — so both-markers
        // is the whole point. Generous budget under full-suite cumulative load
        // (the take-theirs pattern).
        let both = false;
        for (let i = 0; i < 24 && !both; i++) {
          await ipcOk(a.session, "plugin:sync|sync_now", {});
          await new Promise((r) => setTimeout(r, 2_000));
          const onA = (await ipcOk(a.session, "plugin:notes|note_read", { noteId })) as string;
          both = onA.includes(REMOTE_MARKER) && onA.includes(LOCAL_MARKER);
        }
        expect(both, "B's follow-up edit preserved A's pulled edit on A").toBe(true);
      } finally {
        await teardown();
      }
    } finally {
      await srv.teardown();
    }
  });
});

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

// ── stale-pane scenario helpers (the workspace-state suite's row/split
//    driving pattern, scoped to what this one story needs) ────────────────

/** The sidebar row for `noteId` (`data-note-id` discriminator). */
async function noteRow(session: Session, noteId: string): Promise<Element> {
  return session.waitForElement(
    testIdSelector("notes.row", { "data-note-id": noteId }),
    { timeoutMs: 20_000 },
  );
}

/** The first sidebar row whose note-id differs from `notId` — the B-local
 *  side note created just before (two rows total in this scenario). */
async function otherNoteRowId(session: Session, notId: string): Promise<string> {
  return session.waitUntil(
    async () => {
      const rows = await session.byTestIdAll("notes.row");
      for (const r of rows) {
        const id = (await r.attribute("data-note-id")) ?? "";
        if (id && id !== notId) return id;
      }
      return null;
    },
    { label: "side note row present", timeoutMs: 15_000 },
  );
}

/** Right-click a note row and pick a context-menu item by `data-item-id` —
 *  the driver-addressable split gesture (WebDriver middle/Alt-click never
 *  reaches WebKit; see workspace-state.e2e.ts). */
async function rowMenuPick(session: Session, noteId: string, itemId: string): Promise<void> {
  await (await noteRow(session, noteId)).rightClick();
  await (
    await session.waitForElement(
      testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
    )
  ).click();
}

/** Poll until `noteId`'s tab sits in an UNFOCUSED pane (`data-focused="false"`)
 *  and return that pane's `data-pane-id`. */
async function unfocusedPaneIdShowing(session: Session, noteId: string): Promise<string> {
  return session.waitUntil(
    async () => {
      const panes = await session.byTestIdAll("editor.pane");
      for (const p of panes) {
        if ((await p.attribute("data-focused")) !== "false") continue;
        const paneId = (await p.attribute("data-pane-id")) ?? "";
        const tabs = await session.findElements(
          `${testIdSelector("editor.pane", { "data-pane-id": paneId })} ` +
            testIdSelector("editor.tab", { "data-tab-id": `note:${noteId}` }),
        );
        if (tabs.length > 0) return paneId;
      }
      return null;
    },
    { label: "note parked in an unfocused pane", timeoutMs: 15_000 },
  );
}

/** ONE pane's live CodeMirror document text, scoped by `data-pane-id` (the
 *  pane-qualified form of the shared `editorText` readout). */
async function paneText(session: Session, paneId: string): Promise<string> {
  const els = await session.findElements(
    `${testIdSelector("editor.pane", { "data-pane-id": paneId })} ` +
      '[data-testid="editor.content"] .cm-content',
  );
  return els.length > 0 ? els[0].textContent() : "";
}
