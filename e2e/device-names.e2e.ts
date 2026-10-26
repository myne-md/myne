// Device friendly names, end to end (MYND-548).
//
// Self-skips unless BOTH the tauri-driver harness (Linux + built app) AND the
// myne-server binary are present — same gate as `sync-replication.e2e.ts`, whose
// two-device setup this reuses rather than standing up a second harness.
//
// What this proves that no other tier can: a name typed at ENROLLMENT on one
// device reaches the OTHER device through the real prefs blob and the real §10.2
// per-key merge — not a mocked map. The mobile flow tier verifies the UI contract
// against mock IPC; replication is only observable here.
//
// It also pins the deliberate NEGATIVE: the pending row must never show the name
// the newcomer chose for itself. A name next to an unverified device reads as a
// trust signal while nothing verifies it, which would weaken the SAS eye-compare
// that is the actual defense (SYNC-40).

import { describe, expect, it } from "vitest";
import { harnessSupported } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { launchDevice, setupTwoSyncedDevices, syncConfigSeed } from "./support/multi-device";
import { type Session, testIdSelector } from "./support/webdriver";
import { type AppSession } from "./support/session";
import {
  closeSettings,
  dismissImporterOffer,
  ipcOk,
  openSyncDevices,
  unlockToEditor,
} from "./support/flows";
import { seedVault } from "./support/fixtures";

const driver = harnessSupported();
const server = syncServerSupported();
const ready = driver.ok && server.ok;

if (!ready) {
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] device-names skipped: ${!driver.ok ? driver.reason : server.reason}`,
  );
}

const describeNames = ready ? describe : describe.skip;

const NAME_A = "Studio Desktop";
const NAME_B = "Travel Laptop";
const RENAMED_B = "Renamed From A";

/** Open Settings → Sync and wait for the device list to render. */
async function openDeviceList(session: Session): Promise<void> {
  await openSyncDevices(session);
  await session.byTestId("sync.device-management", { timeoutMs: 30_000 });
}

/** The visible primary labels of every approved row. */
async function rowNames(session: Session): Promise<string[]> {
  const els = await session.byTestIdAll("sync.device-name");
  return await Promise.all(els.map((e) => e.textContent()));
}

/** The demoted short codes of every approved row. */
async function rowCodes(session: Session): Promise<string[]> {
  const els = await session.byTestIdAll("sync.device-code");
  return await Promise.all(els.map((e) => e.textContent()));
}

/** Cycle both devices until `predicate` holds on `reader`'s rendered list.
 *
 *  BOTH sides must be driven. A name chosen at enrollment is parked in
 *  device-local state and applied by a later prefs phase — on a joining device
 *  that is the cycle AFTER its §10.2.1 seed — so the writer has to run its own
 *  cycles before the reader has anything to pull. Driving only the reader made
 *  this flaky: it depended on the writer's background 30 s poll landing inside
 *  the reader's window. */
async function syncUntil(
  reader: Session,
  writers: Session[],
  predicate: (names: string[]) => boolean,
  // Sized to the chain, not guessed: a name now travels approval → token claim →
  // pull (which runs the §10.2.1 seed) → the writer naming itself → its push →
  // the reader's pull. That is several cycles more than a plain note edit, and a
  // 12-attempt budget was observably tight (~1 run in 4 missed the last hop).
  attempts = 24,
): Promise<string[]> {
  let names: string[] = [];
  for (let i = 0; i < attempts; i++) {
    for (const w of writers) await ipcOk(w, "plugin:sync|sync_now", {});
    await ipcOk(reader, "plugin:sync|sync_now", {});
    await new Promise((r) => setTimeout(r, 1500));
    // Re-read the rendered rows: the assertion is about the DATA replicating.
    // The panel refreshes itself off the prefs nonce, so no reopen is needed.
    names = await rowNames(reader);
    if (predicate(names)) return names;
  }
  return names;
}

describeNames("device friendly names (two devices)", () => {
  it(
    "a name typed at enrollment reaches the peer, the pending row never shows it, and a rename propagates back",
    async () => {
      const srv = await startSyncServer();
      try {
        let pendingRowText = "";
        const { a, b, teardown } = await setupTwoSyncedDevices(srv, {
          seedNote: false,
          deviceNames: { a: NAME_A, b: NAME_B },
          // The only window in which the pending row exists.
          whilePending: async ({ a: deviceA }: { a: AppSession; b: AppSession }) => {
            const row = await deviceA.session.byTestId("sync.pending-row", {
              timeoutMs: 30_000,
            });
            pendingRowText = await row.textContent();
          },
        });

        try {
          // ── The pending row never carried B's self-chosen name ──────────────
          expect(pendingRowText).not.toContain(NAME_B);
          // It still shows something identifying — the id-derived label.
          expect(pendingRowText.length).toBeGreaterThan(0);

          // ── A sees its own name, and B's name once prefs replicate ──────────
          await openDeviceList(a.session);
          const namesOnA = await syncUntil(a.session, [b.session], (n) => n.includes(NAME_B));
          expect(namesOnA).toContain(NAME_A);
          expect(namesOnA).toContain(NAME_B);

          // Every row demotes its code to a secondary line — this is what tells
          // two devices apart when their names collide.
          const codesOnA = await rowCodes(a.session);
          expect(codesOnA).toHaveLength(namesOnA.length);
          for (const code of codesOnA) {
            expect(code).toMatch(/^[0-9a-f]{6}$/);
          }

          // ── Rename B's row FROM A, and watch it land on B ───────────────────
          // Scope the trigger to the row that is NOT this device — a bare
          // `byTestId("sync.rename-device")` is a document-wide lookup and would
          // silently rename A instead, passing for the wrong reason.
          const trigger = await a.session.findElement(
            `${testIdSelector("sync.device-row", { "data-current": "false" })} ` +
              testIdSelector("sync.rename-device"),
          );
          await trigger.click();
          const input = await a.session.byTestId("sync.device-name-input");
          // `replaceText`, not clear(): the rename input is seeded with the
          // current name, and W3C clear bypasses React's value tracker.
          await input.replaceText(RENAMED_B);
          // U+E007 is the WebDriver Enter key. Written as an ESCAPE, not as a
          // literal control character — an invisible key in a source line has
          // bitten this suite before.
          await input.sendKeys("\uE007");
          await a.session.byTestId("sync.device-name", { timeoutMs: 10_000 });
          expect(await rowNames(a.session)).toContain(RENAMED_B);

          // Push A's prefs, then let B pull them.
          await ipcOk(a.session, "plugin:sync|sync_now", {});
          await closeSettings(a.session);

          await openDeviceList(b.session);
          const namesOnB = await syncUntil(b.session, [a.session], (n) => n.includes(RENAMED_B));
          expect(namesOnB).toContain(RENAMED_B);
          // A's own name replicated too — the map is shared, not per-device.
          expect(namesOnB).toContain(NAME_A);
        } finally {
          await teardown();
        }
      } finally {
        await srv.teardown();
      }
    },
    600_000,
  );

  it(
    "the enrollment form pre-fills a real, platform-derived name with no user input",
    async () => {
      // ONE device. The claim is that the suggestion survives the real path —
      // Rust's `std::env::consts::OS` → the i18n catalogue → the rendered field —
      // with nothing typed. That is observable at the form, and asserting it there
      // keeps this off a second two-device harness (the most expensive thing this
      // suite can buy). Whether a name reaches the OTHER device is scenario 1's
      // job, and it covers it end to end.
      const srv = await startSyncServer();
      try {
        let password = "";
        const a = await launchDevice(0, {
          seedConfig: syncConfigSeed(srv.url),
          seed: (appDataDir) => {
            const v = seedVault(appDataDir, { password: "CanaryPass-9-animals!" });
            password = v.password;
          },
        });
        try {
          await unlockToEditor(a.session, password);
          await dismissImporterOffer(a.session);
          await openSyncDevices(a.session);

          const field = await a.session.byTestId("sync.enroll.device-name-input", {
            timeoutMs: 30_000,
          });
          const prefilled = (await field.property<string>("value")) ?? "";
          expect(prefilled.trim()).not.toBe("");
          // A catalogue word, never the id-derived device label.
          expect(prefilled).not.toMatch(/^Device [0-9a-f]{6}$/);
        } finally {
          await a.teardown();
        }
      } finally {
        await srv.teardown();
      }
    },
    600_000,
  );
});
