// Multi-device harness wiring spec — runs WITHOUT the driver (the
// `harness.e2e.ts` precedent), so the MYND-428 support surface is verified on
// any platform incl. the macOS dev machine. The real two-device scenario
// (`sync-replication.e2e.ts`) self-skips when the driver/server are absent.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devicePorts, launchDevice, syncConfigSeed, withTwoDevices } from "./support/multi-device";
import { startSyncServer, syncServerBinary, syncServerSupported, uniqueAccountSeed } from "./support/sync-server";

describe("multi-device harness wiring (MYND-428)", () => {
  it("exposes the device + server primitives", () => {
    expect(typeof launchDevice).toBe("function");
    expect(typeof withTwoDevices).toBe("function");
    expect(typeof startSyncServer).toBe("function");
    expect(typeof syncConfigSeed).toBe("function");
    expect(syncServerBinary().length).toBeGreaterThan(0);
  });

  it("allocates a distinct, non-overlapping port pair per device index", () => {
    const a = devicePorts(0);
    const b = devicePorts(1);
    const c = devicePorts(2);
    const all = [a.driverPort, a.nativePort, b.driverPort, b.nativePort, c.driverPort, c.nativePort];
    // No two ports collide across the three devices.
    expect(new Set(all).size).toBe(all.length);
    // Each device's own pair differs.
    expect(a.driverPort).not.toBe(a.nativePort);
  });

  it("syncConfigSeed writes a SYNC-14 endpoint config a client can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "myne-cfgseed-"));
    try {
      syncConfigSeed("http://127.0.0.1:51820")(dir);
      const raw = readFileSync(join(dir, "sync-config.json"), "utf8");
      const parsed = JSON.parse(raw) as { endpoint_url?: string };
      // Shape matches the Rust SyncEndpointConfig (serde) the plugin reads.
      expect(parsed.endpoint_url).toBe("http://127.0.0.1:51820");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("server preflight yields an actionable verdict", () => {
    const v = syncServerSupported();
    if (!v.ok) {
      expect(v.reason).toMatch(/myne-server|MYNE_E2E_SERVER|go build|pinned SHA/);
    } else {
      expect(v.reason).toBeUndefined();
    }
  });

  it("per-scenario account seeds are unique within the process", () => {
    const seeds = new Set([uniqueAccountSeed(), uniqueAccountSeed(), uniqueAccountSeed()]);
    expect(seeds.size).toBe(3);
  });
});
