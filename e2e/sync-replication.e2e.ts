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
import { withTwoDevices } from "./support/multi-device";

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
});
