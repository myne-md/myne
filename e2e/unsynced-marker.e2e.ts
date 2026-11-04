// The unsynced-edit marker, end-to-end against a REAL myne-server
// (phase3-web-client task 23).
//
// The marker exists because an edit that is only on this device is the one thing
// between the user and real loss when storage is evicted or the tab closes
// (story 29). Three scenarios, one per acceptance criterion:
//
//   um1 — visible WITHOUT opening a panel: type into a note with the server
//         unreachable, and the sidebar row and bottom bar both mark it.
//   um2 — clears only on a SERVER acknowledgement: with the server back, the
//         marker survives every local event (save, reload of the readout) until
//         a real push lands, and then goes.
//   um3 — survives a reload while still unsynced: the WebView reload discards
//         every React state tree and hook memory, and the marker comes back.
//
// The server is stopped rather than mocked, because "unsynced" has to mean the
// bytes are genuinely not on a server — a faked failure would pin the UI against
// a state the engine can produce and the world cannot.
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
  pageSeatInvoke,
  reopenNoteAfterReload,
  typeIntoEditor,
  waitForSaved,
  unlockAndEnroll,
} from "./support/flows";

const supported = harnessSupported().ok && syncServerSupported().ok;

/** How many sidebar rows currently carry the unsynced marker. */
async function markedRows(session: Session): Promise<number> {
  return (await session.byTestIdAll("notes.row-unsynced")).length;
}

/**
 * The command behind the marker, read directly.
 *
 * Asserted ALONGSIDE the DOM rather than instead of it: the DOM proves the user
 * can see it, and this proves what the client actually believes — a marker
 * rendered from a stale cache would pass the first check and fail this one.
 */
async function unsyncedIds(session: Session): Promise<string[]> {
  const r = (await ipcOk(session, "plugin:sync|sync_unsynced_edits", {}, 20_000)) as {
    note_ids?: string[];
    tracking?: boolean;
  };
  expect(r.tracking).toBe(true);
  return r.note_ids ?? [];
}

describe.skipIf(!supported)("um · unsynced-edit marker (MYND-574 task 23)", () => {
  it("um1 — an edit the server has not seen is marked, with no panel opened", async () => {
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
      // Drain whatever the seeded vault owes, so the marker's later appearance
      // is attributable to THIS edit and not to leftovers.
      await pageSeatInvoke(a.session, "plugin:sync|sync_now", {}, 30_000);
      await a.session.waitUntil(
        async () => ((await unsyncedIds(a.session)).length === 0 ? true : null),
        { label: "the seeded vault is fully pushed", timeoutMs: 40_000 },
      );

      // Now take the server away and write. The save succeeds (it is local);
      // the push cannot.
      await srv.teardown();
      await createNote(a.session, "StrandedNote");
      await typeIntoEditor(a.session, "this exists in exactly one place");
      await waitForSaved(a.session);
      await pageSeatInvoke(a.session, "plugin:sync|sync_now", {}, 30_000).catch(() => {
        /* the cycle is expected to fail — the point is that it did not land */
      });

      // The criterion: visible without opening anything. No settings panel, no
      // hover, no menu — the sidebar row carries it, and so does the bottom bar
      // for the note in focus.
      await a.session.byTestId("notes.row-unsynced", { timeoutMs: 20_000 });
      await a.session.byTestId("editor.unsynced-marker", { timeoutMs: 20_000 });
      expect(await unsyncedIds(a.session)).toHaveLength(1);
    } finally {
      await a.teardown();
    }
  });

  it("um2 — the marker clears on the server's acknowledgement and on nothing else", async () => {
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
      await pageSeatInvoke(a.session, "plugin:sync|sync_now", {}, 30_000);

      // **The ack is made IMPOSSIBLE for the first half, not merely unlikely.**
      // The claim is "a local save does not clear the marker", and with the
      // server reachable the poke timer can acknowledge between the save and the
      // read - at which point the marker clears for the RIGHT reason and the
      // assertion fails for the wrong one (measured 2026-11-03: `expected 0 to be
      // greater than 0`, alone-green). Pointing the endpoint at a port nothing
      // listens on is the product's own control, and it is restored below, so the
      // second half still proves the clear-on-acknowledgement it always did.
      await pageSeatInvoke(
        a.session,
        "plugin:sync|sync_set_endpoint",
        { endpointUrl: "http://127.0.0.1:9", inviteCode: null },
        30_000,
      );

      await createNote(a.session, "AckNote");
      await typeIntoEditor(a.session, "first body");
      await waitForSaved(a.session);

      // A LOCAL save is not an acknowledgement. This is the assertion the
      // feature turns on: the obvious implementation clears the marker when the
      // editor stops being dirty, which is exactly wrong — that is the moment
      // the note is at its most exposed.
      await a.session.byTestId("notes.row-unsynced", { timeoutMs: 20_000 });
      await typeIntoEditor(a.session, " and more");
      await waitForSaved(a.session);
      expect(await markedRows(a.session)).toBeGreaterThan(0);

      // Put the relay back before asking for the acknowledgement.
      await pageSeatInvoke(
        a.session,
        "plugin:sync|sync_set_endpoint",
        { endpointUrl: srv.url, inviteCode: null },
        30_000,
      );

      // The real thing.
      await pageSeatInvoke(a.session, "plugin:sync|sync_now", {}, 30_000);
      await a.session.waitUntil(
        async () => ((await unsyncedIds(a.session)).length === 0 ? true : null),
        { label: "the push is acknowledged", timeoutMs: 40_000 },
      );
      await a.session.waitUntil(
        async () => ((await markedRows(a.session)) === 0 ? true : null),
        { label: "the marker clears", timeoutMs: 20_000 },
      );
    } finally {
      await a.teardown();
      await srv.teardown();
    }
  });

  it("um3 — an unsynced edit is still marked after a WebView reload", async () => {
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
      await pageSeatInvoke(a.session, "plugin:sync|sync_now", {}, 30_000);

      await srv.teardown();
      await createNote(a.session, "SurvivesReload");
      await typeIntoEditor(a.session, "written while the server was gone");
      await waitForSaved(a.session);
      await a.session.byTestId("notes.row-unsynced", { timeoutMs: 20_000 });

      // The reload is what makes this a real test rather than a re-render: it
      // discards every React state tree, every hook's memory and the whole page,
      // then re-runs the boot probe. A marker driven by an in-RAM dirty flag
      // does not come back from that; one recomputed from the note's own header
      // nonce and the persisted sync baselines does.
      await a.session.refresh();
      await reopenNoteAfterReload(a.session);
      await a.session.byTestId("notes.row-unsynced", { timeoutMs: 20_000 });
      expect(await unsyncedIds(a.session)).toHaveLength(1);
    } finally {
      await a.teardown();
    }
  });
});
