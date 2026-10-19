// Transport-level awareness leak-budget stand-in (epic live-collab,
// sub-feature `collab-verification` task 3; SYNC-48).
//
// # What this is, and what it is NOT
//
// SYNC-48 chose an in-repo transport-level stand-in plus a written out-of-scope
// reason instead of a real `myne-range` scenario (the range companion is
// off-repo, unbuilt in a fresh clone and in CI, and cannot stand up the
// awareness timing/size leak). The recorded decision (sync-ledger SYNC-48,
// `check-adversary-coverage` A13) says the MACHINE-TESTABLE half is the CLIENT's
// emitted frame rate: awareness must emit at most ~10 frames/second (the SYNC-5
// floor) under sustained cursor movement, the envelope must be opaque
// (`{room_id_hex, frame_b64}` only), there must be one stream per device, and no
// frame may exceed the 64 KiB cap. No loopback HTTP sniffing and no test proxy.
//
// # The readout exists now (2026-10-11)
//
// `collab-client-transport` added `plugin:sync|sync_awareness_stats`, a read-only
// command returning counts and lengths of the emitted batches (never a frame byte,
// a room id or a note id): batches posted, frames carried, the last batch's encoded
// length, the reconnect generation, the subscribed-room count and the window they
// span. So the CLIENT's emitted frame rate is now asserted directly below, on the
// in-repo transport surface the decision names. What stays out of scope is the WIRE
// as the server observes it (that is the SYNC-48 out-of-scope reason, task 6).
//
// # What IS observable today, and is asserted below
//
// The client-side half of the leak budget IS reachable: the awareness channel is
// transient (RAM-only) and OPTIONAL. This scenario asserts (1) the awareness
// envelope is never persisted to disk on either device, and (2) the durable blob
// plane converges with no loss WITHOUT the live channel carrying anything, which
// is the "a stream failure is not silent data loss" guarantee the leak budget
// rests on.
//
// Vault-count precondition: 1 seeded vault on A, 1 join-bootstrapped on B.
// Self-skips without the tauri-driver harness AND the `myne-server` binary.

import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { harnessSupported, type AppSession } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { noteBlobCount, noteBlobMagics, setupTwoSyncedDevices } from "./support/multi-device";
import { clickNoteRow, ipcOk, pageSeatInvoke } from "./support/flows";
import { sleep } from "./support/member-fleet";

const driver = harnessSupported();
const server = syncServerSupported();
const ready = driver.ok && server.ok;

if (!ready) {
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] collab-leak-budget skipped: ${!driver.ok ? driver.reason : server.reason}`,
  );
}

const describeCanary = ready ? describe : describe.skip;

/** The v0.2 CRDT note magic. */
const CRDT_MAGIC = "NC05";
/** Sustained-edit markers (needle-design rule: ≥24 lowercase-alnum chars). */
const MARKERS = [
  "leakburstalpha7k2m9qx4w8e5rj0t",
  "leakburstbravo3f6h1zn8c2vb5kk",
  "leakburstcharlie9d4t7yp2mq6xs",
  "leakburstdelta1w4e7r9t2y5u8i0o",
] as const;

/** The `sync_awareness_stats` shape (`core/src/plugins/sync/awareness_listener.rs`).
 *  Counts and lengths only; never a frame byte, a room id or a note id. */
interface AwarenessStats {
  batchesPosted: number;
  framesPosted: number;
  lastBatchLen: number;
  generation: number;
  rooms: number;
  received: number;
  presenceRouted: number;
  rxNoRoom: number;
  rxSelfEcho: number;
  rxNoSession: number;
  rxOpenFailed: number;
  windowMs: number;
}

async function readBody(session: AppSession["session"], noteId: string): Promise<string> {
  return (await ipcOk(session, "plugin:notes|note_read", { noteId })) as string;
}

/** Drop a device's live co-editing session for `noteId`, best-effort. The live
 *  session is the single durable writer while open, so `note_update` is refused
 *  with `LiveSessionOpen` until it is dropped (`src/notes/liveNote.ts`). */
async function dropLiveSession(session: AppSession["session"], noteId: string): Promise<void> {
  await pageSeatInvoke(session, "plugin:live|live_session_close", { noteId }, 15_000);
}

/** Files under `root` whose NAME names an awareness artefact. */
function findAwarenessNamedFiles(root: string): string[] {
  const out: string[] = [];
  let entries: { parentPath: string; name: string }[];
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true }) as unknown as {
      parentPath: string;
      name: string;
    }[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (/awareness|presence/i.test(entry.name)) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

describeCanary("awareness leak budget: client-side half (collab-verification)", () => {
  // Stories 5/6: the in-repo stand-in for the SYNC-48 leak. Asserts the parts of
  // the budget the client surface exposes: RAM-only, and the durable plane as the
  // no-loss fallback. The transport half is asserted below through
  // `plugin:sync|sync_awareness_stats`.
  // Vault-count precondition: 1 seeded vault on A, 1 join-bootstrapped on B.
  it("persists no awareness envelope, and converges on the durable plane with no loss", async () => {
    const srv = await startSyncServer();
    try {
      // BORN v0.2 (the NC05 fleet), so the note really is a CRDT blob.
      const devices = await setupTwoSyncedDevices(srv, { generation: "v0.2" });
      const { a, b, noteId, teardown } = devices;
      try {
        expect(noteBlobMagics(a.appDataDir)).toEqual([CRDT_MAGIC]);
        expect(noteBlobMagics(b.appDataDir)).toEqual([CRDT_MAGIC]);

        // The note is open in A's pane, so its live session is the single
        // durable writer; drop it to drive the durable plane directly.
        await dropLiveSession(a.session, noteId);

        // A sustained edit burst on the durable plane, the traffic the
        // awareness channel would otherwise carry at keystroke frequency.
        let body = await readBody(a.session, noteId);
        for (const marker of MARKERS) {
          body = `${body}\n${marker}\n`;
          await ipcOk(a.session, "plugin:notes|note_update", { noteId, plaintext: body });
        }
        await ipcOk(a.session, "plugin:sync|sync_now", {});

        // No loss through the durable plane: every marker is on B exactly once.
        let onB = "";
        let converged = false;
        for (let i = 0; i < 12 && !converged; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await sleep(1_500);
          onB = await readBody(b.session, noteId);
          converged = MARKERS.every((m) => onB.split(m).length - 1 === 1);
        }
        expect(converged, "the durable plane carried the burst to B, each marker once").toBe(
          true,
        );

        // --- The transport half (`collab-verification` task 3, SYNC-48) ----------
        // The machine-testable half the decision names: the CLIENT's emitted frame
        // rate. A opens the note (so it has a live session and emits presence
        // frames), then a sustained input burst; the coalescing floor (SYNC-5) means
        // frames arrive on a bounded cadence, NOT per event.
        await clickNoteRow(a.session, noteId);
        await sleep(1_000);
        await pageSeatInvoke(a.session, "plugin:live|live_session_open", { noteId }, 15_000);

        const before = (await ipcOk(
          a.session,
          "plugin:sync|sync_awareness_stats",
          {},
        )) as AwarenessStats;
        const events = 30;
        const startedAt = Date.now();
        for (let i = 0; i < events; i++) {
          await pageSeatInvoke(
            a.session,
            "plugin:live|live_session_set_presence",
            { noteId, cursor: i, selection: null, label: null },
            10_000,
          );
          await sleep(100);
        }
        const elapsedS = Math.max((Date.now() - startedAt) / 1000, 1);
        await sleep(1_500);
        const after = (await ipcOk(
          a.session,
          "plugin:sync|sync_awareness_stats",
          {},
        )) as AwarenessStats;
        const emitted = after.framesPosted - before.framesPosted;
        expect(emitted, "the client emitted at least one awareness frame").toBeGreaterThan(0);
        expect(
          emitted / elapsedS,
          "plumbing: the emitted frame rate is bounded by the SYNC-5 floor (<= 10/s)",
        ).toBeLessThanOrEqual(10);
        expect(emitted, "coalescing: far fewer frames than input events").toBeLessThan(events);
        expect(after.generation, "one live stream per device").toBeGreaterThanOrEqual(1);
        expect(
          after.lastBatchLen,
          "no emitted batch exceeds the 64 KiB frame cap",
        ).toBeLessThanOrEqual(65_536);

        // RAM-only: the awareness envelope is never written to disk. The awareness
        // plane owns no file at all, so the assertion is its absence by name.
        for (const device of [a, b]) {
          expect(
            findAwarenessNamedFiles(device.dataHome),
            "no awareness/presence-named file on disk",
          ).toEqual([]);
        }

        // Positive control: the notes ARE on disk, so the scans ran over a
        // populated tree rather than a never-written one.
        expect(noteBlobCount(a.appDataDir)).toBeGreaterThanOrEqual(1);
        expect(noteBlobCount(b.appDataDir)).toBeGreaterThanOrEqual(1);
      } finally {
        await teardown();
      }
    } finally {
      await srv.teardown();
    }
  });
});
