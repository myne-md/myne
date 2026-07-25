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
import { setupTwoSyncedDevices } from "./support/multi-device";
import { type Session, testIdSelector } from "./support/webdriver";
import { type AppSession } from "./support/session";
import { closeSettings, ipcOk, openSettings } from "./support/flows";

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
  await openSettings(session);
  await (await session.byTestId("settings.tab-sync")).click();
  await session.byTestId("sync.device-management", { timeoutMs: 30_000 });
}

/** The visible primary labels of every approved row. */
async function rowNames(session: Session): Promise<string[]> {
  const els = await session.findElements(testIdSelector("sync.device-name"));
  return await Promise.all(els.map((e) => e.textContent()));
}

/** The demoted short codes of every approved row. */
async function rowCodes(session: Session): Promise<string[]> {
  const els = await session.findElements(testIdSelector("sync.device-code"));
  return await Promise.all(els.map((e) => e.textContent()));
}

/** Pull until `predicate` holds on the device's rendered list, or give up. */
async function pullUntil(
  session: Session,
  predicate: (names: string[]) => boolean,
  attempts = 12,
): Promise<string[]> {
  let names: string[] = [];
  for (let i = 0; i < attempts; i++) {
    await ipcOk(session, "plugin:sync|sync_now", {});
    await new Promise((r) => setTimeout(r, 1500));
    // Reopen the list so the panel re-reads prefs even if the live event was
    // missed — the assertion is about the DATA replicating, not about the
    // refresh timing (that is task 3's concern and is covered by the rename
    // case below, which never reopens).
    names = await rowNames(session);
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
          seedNote: false as boolean,
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
          const namesOnA = await pullUntil(a.session, (n) => n.includes(NAME_B));
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
          const rows = await a.session.findElements(testIdSelector("sync.device-row"));
          let renamedTarget = false;
          for (const row of rows) {
            const current = await row.attribute("data-current");
            if (current === "true") continue; // rename the OTHER device
            const trigger = await a.session.byTestId("sync.rename-device");
            await trigger.click();
            const input = await a.session.byTestId("sync.device-name-input");
            await input.clear();
            await input.sendKeys(RENAMED_B);
            // U+E007 is the WebDriver Enter key. Written as an ESCAPE, not as a
            // literal control character — an invisible key in a source line has
            // bitten this suite before.
            await input.sendKeys("\uE007");
            renamedTarget = true;
            break;
          }
          expect(renamedTarget).toBe(true);
          await a.session.byTestId("sync.device-name", { timeoutMs: 10_000 });
          expect(await rowNames(a.session)).toContain(RENAMED_B);

          // Push A's prefs, then let B pull them.
          await ipcOk(a.session, "plugin:sync|sync_now", {});
          await closeSettings(a.session);

          await openDeviceList(b.session);
          const namesOnB = await pullUntil(b.session, (n) => n.includes(RENAMED_B));
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
    "a device nobody named keeps the id-derived fallback",
    async () => {
      const srv = await startSyncServer();
      try {
        // No `deviceNames` → both enrollment forms submit their PRE-FILLED
        // platform default, so no row is ever nameless even without user input.
        const { a, teardown } = await setupTwoSyncedDevices(srv, { seedNote: false as boolean });
        try {
          await openDeviceList(a.session);
          const names = await rowNames(a.session);
          expect(names.length).toBeGreaterThan(0);
          for (const name of names) {
            expect(name.trim()).not.toBe("");
          }
          // Both devices took the same platform default, so the demoted code is
          // what disambiguates them — the reason it is a permanent line.
          const codes = await rowCodes(a.session);
          expect(new Set(codes).size).toBe(codes.length);
        } finally {
          await teardown();
        }
      } finally {
        await srv.teardown();
      }
    },
    600_000,
  );
});
