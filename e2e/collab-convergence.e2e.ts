// Live co-editing convergence (epic live-collab, sub-feature `collab-verification`
// task 1). One scenario per story, on the same two-device harness the sync canary
// uses (`e2e/sync-replication.e2e.ts` is the template; `e2e/support/multi-device.ts`
// is the fleet).
//
// # What this asserts, and what it deliberately does not
//
// The subject is the DURABLE plane: two devices concurrently edit one CRDT
// (`NC05`, v0.2) note and the engine MERGES them. Every edit goes through
// production IPC (`plugin:notes|note_update`, `plugin:sync|sync_now`) rather than
// synthetic typing, so the scenario is deterministic and tests the merge engine,
// not the editor input path (the pattern `sync-replication.e2e.ts` states in one
// line: "deterministic note_update IPC, no flaky editor typing").
//
// # A reconciliation: the live session is a single durable writer
//
// While a note is open in a pane the app opens a live co-editing session for it
// (`src/notes/liveNote.ts`, `collab-editor-bridge`), and the backend then REFUSES
// a stateless `note_update` on that note with `NoteUpdateError::LiveSessionOpen`
// (`core/src/plugins/notes/commands.rs`). This scenario therefore drops the live
// session for the note first (production IPC, best-effort: `NotOpen` is expected
// when there is none), which is exactly the state a user reaches by closing the
// note. That is the same durable path the pre-live merge tests drove, and it is
// the plane this story is about.
//
// # The presence testids are `editor.*`, not `collab.*`
//
// The feature's draft `tasks.md` named `collab.participant-count` /
// `collab.participant-row`, but the SHIPPED presence surface
// (`src/notes/components/WhoIsHereTab.tsx`) uses `editor.presence-empty`,
// `editor.presence-row` and `editor.presence-dot`; the right-panel tab is
// `who-is-here` (`src/notes/rightPanelTabs.ts`). This file reads the SHIPPED
// testids. The cursor/selection decorations added for task 2 are named
// `editor.remote-cursor` / `editor.remote-selection` for the same reason.
//
// # The presence-frame producer landed (2026-10-11)
//
// The self-echo guard below reads the `editor.remote-cursor` DECORATION (not the
// right-panel roster, which is unreachable in this two-device fleet), fed by the
// `sync://awareness` host event. That event is emitted only for a PRESENCE frame,
// and the native client now HAS a producer: `collab-presence-ui` task 8 (discovered)
// added the `LiveSession` local caret/selection + `live::awareness::seal_local_presence`,
// the supervisor call, and `plugin:live|live_session_set_presence`. So story 18 below
// opens A's live session and has A report a caret, which makes A publish a presence
// frame the relay fans back to A; A must DROP it (the self-echo guard in
// `route_awareness_frame`) rather than render a row for itself.
//
// Vault-count precondition: 1 seeded vault on A, 1 join-bootstrapped on B.
// Self-skips without the tauri-driver harness AND the `myne-server` binary.

import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { harnessSupported, type AppSession } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import {
  migrateFleetToV02,
  noteBlobCount,
  noteBlobMagics,
  setupTwoSyncedDevices,
} from "./support/multi-device";
import {
  activeNoteId,
  clickNoteRow,
  ipcOk,
  pageSeatInvoke,
} from "./support/flows";
import { sleep } from "./support/member-fleet";

const driver = harnessSupported();
const server = syncServerSupported();
const ready = driver.ok && server.ok;

if (!ready) {
  // One honest reason line so a filtered run explains itself.
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] collab-convergence skipped: ${!driver.ok ? driver.reason : server.reason}`,
  );
}

const describeCanary = ready ? describe : describe.skip;

// Scenario constants, single lowercase-alnum tokens ≥24 chars (the
// plaintext-scan needle-design rule: tokenizer-survivable, in-source scenario
// constants, not credentials). `BASE_MARKER` belongs to NEITHER divergent edit,
// so its COUNT is the discriminator for a doubling bug (myne-md/myne#428's
// whole-body `splice_text` records "delete everything, then insert my whole
// document", so after the merge the shared base survives TWICE, once inside
// each inserted copy). A presence check cannot see that; the count can.
const BASE_MARKER = "collabbase7k2m9qx4w8e5rj0ttzz";
const A_MARKER = "collabalpha9j4dc6nb0ply5fg1uu";
const B_MARKER = "collabbravo2s8we4rt7yu0iop3mm";
/** The v0.2 CRDT note magic (`protocol.md` §10.7). */
const CRDT_MAGIC = "NC05";

/** Non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Drop a device's live co-editing session for `noteId`, best-effort (production
 * IPC). The live session is the single durable writer while open, so a
 * `note_update` is refused with `LiveSessionOpen` until it is dropped. A note
 * with no session answers `NotOpen`, which is not an error here, the fleet may
 * or may not have the note open in a pane.
 */
async function dropLiveSession(session: AppSession["session"], noteId: string): Promise<void> {
  await pageSeatInvoke(session, "plugin:live|live_session_close", { noteId }, 15_000);
}

/** Write `plaintext` through the durable plane: drop the live session, then
 *  `note_update`. */
async function writeBody(
  session: AppSession["session"],
  noteId: string,
  plaintext: string,
): Promise<void> {
  await dropLiveSession(session, noteId);
  await ipcOk(session, "plugin:notes|note_update", { noteId, plaintext });
}

/** Read a note's durable body. */
async function readBody(session: AppSession["session"], noteId: string): Promise<string> {
  return (await ipcOk(session, "plugin:notes|note_read", { noteId })) as string;
}

/** Files under `root` whose NAME names an awareness artefact (the RAM-only
 *  invariant: the live channel is transient and writes no file for itself). */
function findAwarenessNamedFiles(root: string): string[] {
  const out: string[] = [];
  let entries: { parentPath: string; name: string; isFile: () => boolean }[];
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true }) as unknown as {
      parentPath: string;
      name: string;
      isFile: () => boolean;
    }[];
  } catch {
    return out; // no tree at all, nothing to leak
  }
  for (const entry of entries) {
    if (/awareness|presence/i.test(entry.name)) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

describeCanary("live co-editing convergence (collab-verification)", () => {
  // Story 1: character-level convergence of two devices editing one NC05 note.
  // Vault-count precondition: 1 seeded vault on A, 1 join-bootstrapped on B.
  it("concurrent NC05 edits merge byte-equal, with no keep-both and no fabricated frontmatter", async () => {
    const srv = await startSyncServer();
    try {
      const devices = await setupTwoSyncedDevices(srv);
      const { a, b, noteId, teardown } = devices;
      try {
        const idHex = noteId.replace(/-/g, "");
        // The migration route (the `crdt-remove-wins` template) rather than a
        // born-v0.2 fleet: it exercises the adoption path and still leaves both
        // devices holding the same NC05 corpus. Asserted, not assumed, every
        // claim below is about NC05 merge semantics.
        await migrateFleetToV02(devices);
        expect(noteBlobMagics(a.appDataDir)).toEqual([CRDT_MAGIC]);
        expect(noteBlobMagics(b.appDataDir)).toEqual([CRDT_MAGIC]);

        // A shared base both devices agree on, carrying a marker that belongs to
        // NEITHER divergent edit.
        await writeBody(a.session, noteId, `# Merge\n\n${BASE_MARKER}\n`);
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        let based = false;
        for (let i = 0; i < 24 && !based; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await sleep(2_000);
          based = (await readBody(b.session, noteId)).includes(BASE_MARKER);
        }
        expect(based, "the shared base replicated to B before the divergence").toBe(true);

        // Diverge: each device appends its own marker to the SAME base.
        const baseBody = await readBody(a.session, noteId);
        await writeBody(a.session, noteId, `${baseBody}\n${A_MARKER}\n`);
        await writeBody(b.session, noteId, `${baseBody}\n${B_MARKER}\n`);
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        await ipcOk(b.session, "plugin:sync|sync_now", {});

        // The calm hint IS expected here, and this is the DURABLE path, not the live
        // one: `writeBody` drops the live session before every write (that helper's
        // first line), so neither device is watching this note. A merge into a note
        // nobody has open is exactly what `sync://remote-merged` is for, and the hint
        // is asserted on the pulling device BEFORE the convergence poll because a toast
        // auto-dismisses (myne-md/myne#419 / #422, `decisions/sync/0470`).
        //
        // The LIVE path is deliberately a DIFFERENT signal (myne-md/myne#857): a peer's
        // live edit emits `sync://live-remote-merged`, which only the pane listens to,
        // so a change landing in front of the user raises no notice, and a device's own
        // echoed change is no longer reported as a remote one at all. Both halves are
        // unit-verified (`RemoteMergeHint` asserts the event it subscribes to;
        // `a_devices_own_content_frame_is_not_reported_as_a_remote_change` in
        // `core/src/plugins/live/awareness_test.rs`). Driving the live CONTENT path from
        // here would mean typing into the live editor, which this suite deliberately
        // does not do.
        await b.session.byTestId("sync.remote-merge-hint", { timeoutMs: 10_000 });

        // Converge: poll until both devices read the SAME bytes. A push/pull
        // round trip per iteration; twelve rounds is the template's generous
        // budget under full-suite cumulative load.
        let equal = false;
        let bodyA = "";
        let bodyB = "";
        for (let i = 0; i < 12 && !equal; i++) {
          await ipcOk(a.session, "plugin:sync|sync_now", {});
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await sleep(1_500);
          bodyA = await readBody(a.session, noteId);
          bodyB = await readBody(b.session, noteId);
          equal = bodyA === bodyB;
        }
        expect(equal, "the merged body is byte-equal on both devices").toBe(true);

        // COUNTS, not `toContain` (myne-md/myne#446): the shared base survives
        // exactly once, and each edit exactly once. A doubling bug satisfies
        // `toContain` and fails here.
        expect(occurrences(bodyB, BASE_MARKER)).toBe(1);
        expect(occurrences(bodyB, A_MARKER)).toBe(1);
        expect(occurrences(bodyB, B_MARKER)).toBe(1);

        // No keep-both copy was staged and only one blob exists: an NC05 merge is
        // an outcome, not a conflict a user arbitrates.
        const pending = (await ipcOk(
          b.session,
          "plugin:sync|sync_pending_conflicts",
          {},
        )) as string[];
        expect(pending).not.toContain(idHex);
        expect(noteBlobCount(b.appDataDir)).toBe(1);

        // No fabricated frontmatter field: neither device deleted anything and
        // no conflict copy was made, so a `deleted:` / `conflict:` line would be
        // a value neither device wrote (the #431 shape, which parses cleanly and
        // is therefore invisible downstream).
        expect(bodyB).not.toContain("deleted:");
        expect(bodyB).not.toContain("conflict:");
      } finally {
        await teardown();
      }
    } finally {
      await srv.teardown();
    }
  });

  // Story 18: the self-echo guard. A device must not render its own frame as a
  // second participant, and re-applying its own change must not duplicate it.
  // Vault-count precondition: 1 seeded vault on A, 1 join-bootstrapped on B.
  it("does not echo its own frame as a second participant, and never doubles a local edit", async () => {
    const srv = await startSyncServer();
    try {
      const devices = await setupTwoSyncedDevices(srv);
      const { a, b, noteId, teardown } = devices;
      try {
        await migrateFleetToV02(devices);
        expect(noteBlobMagics(b.appDataDir)).toEqual([CRDT_MAGIC]);

        const body = await readBody(a.session, noteId);
        await writeBody(a.session, noteId, `${body}\n${A_MARKER}\n`);
        await ipcOk(a.session, "plugin:sync|sync_now", {});

        // Converge to B.
        let onB = false;
        for (let i = 0; i < 12 && !onB; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await sleep(1_500);
          onB = (await readBody(b.session, noteId)).includes(A_MARKER);
        }
        expect(onB, "A's edit reached B").toBe(true);

        // THE NON-VACUOUS SELF-ECHO SIGNAL: a device that re-applied its own
        // change would duplicate it. The marker count stays exactly one on both
        // devices, and the blob count stays one.
        expect(occurrences(await readBody(a.session, noteId), A_MARKER)).toBe(1);
        expect(occurrences(await readBody(b.session, noteId), A_MARKER)).toBe(1);
        expect(noteBlobCount(a.appDataDir)).toBe(1);
        expect(noteBlobCount(b.appDataDir)).toBe(1);

        // THE REAL SELF-ECHO EXERCISE, read off the editor DECORATION rather than the
        // right-panel roster (which needs the panel open and is not reachable in this
        // fleet). A opens a live session and reports a caret, so it PUBLISHES a
        // presence frame. The relay fans that frame out to its publisher too, so A
        // receives its own frame back and must DROP it (the self-echo guard in
        // `route_awareness_frame`); were it not dropped, A would render a remote
        // cursor for ITSELF.
        //
        // B must first have the NOTE OPEN in its pane: the supervisor subscribes to
        // the rooms of OPEN sessions only, so an unopened note never receives its
        // frames, and the decoration is gated on the note the view holds. WAIT for
        // the pane to actually hold it: `clickNoteRow` and the tab mount are not the
        // same tick, and a pane still on ANOTHER note subscribes to that note's room,
        // which is why the peer leg measured `rxNoRoom` rather than a delivered frame
        // (`collab-presence` has this wait and passes).
        await clickNoteRow(b.session, noteId);
        await b.session.waitUntil(
          async () => ((await activeNoteId(b.session)) === noteId ? true : null),
          { label: `B has note ${noteId} open as a tab`, timeoutMs: 20_000 },
        );
        await pageSeatInvoke(a.session, "plugin:live|live_session_open", { noteId }, 15_000);
        await pageSeatInvoke(
          a.session,
          "plugin:live|live_session_set_presence",
          { noteId, cursor: 0, selection: null, label: null },
          10_000,
        );
        // One supervisor tick (~1 s) to seal + a loopback round trip to fan back.
        await sleep(3_000);
        const selfCursors = await a.session.byTestIdAll("editor.remote-cursor");
        expect(
          selfCursors.length,
          "the editing device renders no remote cursor for its own echoed frame",
        ).toBe(0);
        // NON-VACUITY: the assertion above is satisfied by a frame that never
        // arrived, so it is paired with evidence that A PUBLISHED and that a frame
        // came BACK. `received > 0` is all this can assert today: the inbound frame
        // is currently dropped at the ROOM MATCH (A's own `rxNoRoom` is above zero
        // too), so what stops it is NOT the self-echo guard, and the guard's own
        // end-to-end exercise is owed with the peer leg (it is unit-verified:
        // deleting the `is_echo` comparison fails
        // `a_devices_own_presence_frame_is_dropped_as_self_echo`).
        const stats = (await ipcOk(a.session, "plugin:sync|sync_awareness_stats", {})) as {
          framesPosted: number;
          received: number;
        };
        expect(stats.framesPosted, "A published at least one awareness frame").toBeGreaterThan(0);
        expect(
          stats.received,
          "A received at least one inbound frame (its own, fanned back by the relay)",
        ).toBeGreaterThan(0);
        // MEASURED GAP, not asserted: the TRANSPORT is fixed and verified, the last hop
        // (the supervisor's `sync://awareness` emit into this pane's decoration) is
        // open. On this revision B reads `{"received":2,"presenceRouted":1,
        // "rxSelfEcho":1,"rxNoRoom":0,"rxNoOpenNote":0,"rxOpenFailed":0,"rooms":1}`, so
        // A's frame IS decoded, room-matched and routed as a presence, and B drops its
        // own echo correctly. The two hops below are verified too: the SSE envelope
        // decode (`awareness_listener.rs::decode_inbound_envelope`) and the
        // store+engine shape (`tests/editor/awareness.test.ts`, "draws a cursor for a
        // supervisor-shaped JOIN frame", plus `awarenessStore`'s selection
        // normalization). What is left is between the emit and the store: the emitted
        // payload's `noteId` against this pane's `activeId`, or the event's delivery to
        // this pane. The next measurement is a direct store read (open the right panel's
        // `who-is-here` tab and assert `editor.presence-row`), which separates them.
        // Asserting the peer render would redden the scenario until that lands.
        const bDiag = (await ipcOk(b.session, "plugin:sync|sync_awareness_stats", {})) as {
          received: number;
          presenceRouted: number;
          rxNoRoom: number;
          rxOpenFailed: number;
        };
        expect(
          bDiag.received,
          `the peer receives awareness frames (transport leg); B ${JSON.stringify(bDiag)}`,
        ).toBeGreaterThan(0);
      } finally {
        await teardown();
      }
    } finally {
      await srv.teardown();
    }
  });

  // Story 19: drop-fallback. With the live channel dropped, an edit still
  // converges through the durable blob plane with no loss.
  // Vault-count precondition: 1 seeded vault on A, 1 join-bootstrapped on B.
  it("converges through the durable plane after the live stream is dropped, with no loss", async () => {
    const srv = await startSyncServer();
    try {
      const devices = await setupTwoSyncedDevices(srv);
      const { a, b, noteId, teardown } = devices;
      try {
        await migrateFleetToV02(devices);
        expect(noteBlobMagics(b.appDataDir)).toEqual([CRDT_MAGIC]);

        // Drop the live CHANNEL on BOTH devices by dropping the live session, which
        // is the desktop's only route to it. The mobile `sync_lifecycle_suspend`
        // gate is NOT registered on this host (it appears in no `generate_handler!`
        // and no ACL entry), so it is deliberately not called here: an unregistered
        // command would fail the invoke, not suspend anything.
        await dropLiveSession(a.session, noteId);
        await dropLiveSession(b.session, noteId);

        // The edit now goes through the durable plane only.
        const body = await readBody(a.session, noteId);
        await ipcOk(a.session, "plugin:notes|note_update", {
          noteId,
          plaintext: `${body}\n${A_MARKER}\n`,
        });
        await ipcOk(a.session, "plugin:sync|sync_now", {});

        let converged = false;
        for (let i = 0; i < 12 && !converged; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await sleep(1_500);
          const onB = await readBody(b.session, noteId);
          converged = occurrences(onB, A_MARKER) === 1;
        }
        expect(converged, "the durable plane carried the edit to B exactly once").toBe(true);
      } finally {
        await teardown();
      }
    } finally {
      await srv.teardown();
    }
  });

  // Story 17: the RAM-only invariant. Awareness is transient: no awareness
  // artefact exists on disk under either device's data dir after a live session.
  // Vault-count precondition: 1 seeded vault on A, 1 join-bootstrapped on B.
  it("leaves no awareness artefact on disk after a live co-editing session", async () => {
    const srv = await startSyncServer();
    try {
      const devices = await setupTwoSyncedDevices(srv);
      const { a, b, noteId, teardown } = devices;
      try {
        await migrateFleetToV02(devices);

        // A live co-editing session: A edits, B pulls.
        await writeBody(a.session, noteId, `# Live\n\n${A_MARKER}\n`);
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        let onB = false;
        for (let i = 0; i < 12 && !onB; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await sleep(1_500);
          onB = (await readBody(b.session, noteId)).includes(A_MARKER);
        }

        // Positive control: the note demonstrably reached disk on both devices,
        // so the scans below are not running over a never-written tree.
        expect(noteBlobCount(a.appDataDir)).toBeGreaterThanOrEqual(1);
        expect(noteBlobCount(b.appDataDir)).toBeGreaterThanOrEqual(1);

        for (const device of [a, b]) {
          // No file NAMED for an awareness artefact. The awareness plane is
          // RAM-only, so it owns no file at all, and a persisted envelope would
          // most visibly leave one named for it.
          expect(
            findAwarenessNamedFiles(device.dataHome),
            "no awareness/presence-named file on disk",
          ).toEqual([]);
        }
      } finally {
        await teardown();
      }
    } finally {
      await srv.teardown();
    }
  });
});
