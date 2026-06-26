// Multi-device E2E primitives (MYND-428 tasks 3 + 4).
//
// `launchDevice(index)` boots ONE production app-instance with its own
// driver+native port pair (off the `MYNE_E2E_*_PORT` base) and its own isolated
// data dir, so N instances coexist — the single-session `launchApp` machinery
// (teardown, artifacts, XDG isolation) is reused verbatim. `withTwoDevices`
// composes two devices + one ephemeral server, pointing both clients at the
// server via the REAL endpoint-config surface (SYNC-14 `sync-config.json` seeded
// into each device's app_config_dir — no test hook).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppSession, type LaunchOptions, launchApp } from "./session";
import type { EphemeralServer } from "./sync-server";

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
export function syncConfigSeed(endpointUrl: string): (appConfigDir: string) => void {
  return (appConfigDir: string) => {
    const body = JSON.stringify({ endpoint_url: endpointUrl }, null, 2);
    writeFileSync(join(appConfigDir, "sync-config.json"), body);
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
