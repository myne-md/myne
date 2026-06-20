// Ephemeral myne-server lifecycle for the multi-device sync E2E (MYND-428, SYNC-18).
//
// Spawns the REAL `myne-server` (in-memory MemStore) on `127.0.0.1:0` and reads
// the OS-assigned port back race-free via the server's portfile (MYND-428 task 1:
// `MYNE_SERVER_ADDR` + `MYNE_SERVER_PORTFILE`). One ephemeral server per test
// file; in-memory store + a fresh process = inherent isolation, and scenarios
// within a file isolate further by a unique `account_number_hash` (distinct
// vaults → distinct hashes; `uniqueAccountSeed()` makes that explicit).
//
// The binary path comes from `MYNE_E2E_SERVER` or the built
// `myne-server/myne-server` (the MYND-428 task-5 Docker image — deferred —
// builds it from a pinned SHA). When neither is present, `syncServerSupported()`
// yields an actionable skip reason so specs self-skip instead of spawn-failing.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO_ROOT } from "./session";

const SERVER_HOST = "127.0.0.1";
const SERVER_READY_TIMEOUT_MS = 10_000;

/** The myne-server binary under test (env override, else the built path). */
export function syncServerBinary(): string {
  return process.env.MYNE_E2E_SERVER ?? join(REPO_ROOT, "myne-server", "myne-server");
}

/** Preflight: can we spawn an ephemeral server? (Binary present.) */
export function syncServerSupported(): { ok: boolean; reason?: string } {
  if (!existsSync(syncServerBinary())) {
    return {
      ok: false,
      reason: `myne-server binary not found at ${syncServerBinary()} — build it (cd myne-server && go build -o myne-server ./cmd/myne-server) or set MYNE_E2E_SERVER. The E2E image (MYND-428 task 5, deferred) builds it from a pinned SHA.`,
    };
  }
  return { ok: true };
}

let accountSeedCounter = 0;
/** A process-unique seed for per-scenario account isolation within one file. */
export function uniqueAccountSeed(): string {
  accountSeedCounter += 1;
  return `e2e-account-${process.pid}-${accountSeedCounter}`;
}

export interface EphemeralServer {
  /** `http://127.0.0.1:<port>` — pass to the client via the SYNC-14 surface. */
  url: string;
  /** The OS-assigned bound port. */
  port: number;
  /** Stop the server + remove its portfile dir. */
  teardown(): Promise<void>;
}

/**
 * Spawn an ephemeral myne-server on an OS-assigned port and wait until it has
 * surfaced its bound port (MYND-428 task 1) and answers `/healthz`.
 */
export async function startSyncServer(): Promise<EphemeralServer> {
  const support = syncServerSupported();
  if (!support.ok) throw new Error(support.reason);

  const dir = mkdtempSync(join(tmpdir(), "myne-e2e-server-"));
  const portfile = join(dir, "port");

  const proc: ChildProcess = spawn(syncServerBinary(), [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      MYNE_SERVER_ADDR: `${SERVER_HOST}:0`,
      MYNE_SERVER_PORTFILE: portfile,
    },
  });
  let log = "";
  proc.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  proc.stderr?.on("data", (d: Buffer) => (log += d.toString()));

  const teardown = async () => {
    proc.kill("SIGTERM");
    await sleep(150);
    if (proc.exitCode === null) proc.kill("SIGKILL");
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // tmpdir reaps eventually.
    }
  };

  // Wait for the portfile to appear (race-free port discovery).
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  let port = 0;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      await teardown();
      throw new Error(`myne-server exited early (code ${proc.exitCode}). Log:\n${log}`);
    }
    if (existsSync(portfile)) {
      const raw = readFileSync(portfile, "utf8").trim();
      const p = Number.parseInt(raw, 10);
      if (Number.isInteger(p) && p > 0) {
        port = p;
        break;
      }
    }
    await sleep(50);
  }
  if (port === 0) {
    await teardown();
    throw new Error(`myne-server did not surface a port within ${SERVER_READY_TIMEOUT_MS} ms. Log:\n${log}`);
  }

  // Health probe so the caller knows the routes are live.
  const url = `http://${SERVER_HOST}:${port}`;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${url}/healthz`);
      if (resp.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not up yet
    }
    await sleep(50);
  }
  if (!healthy) {
    await teardown();
    throw new Error(`myne-server bound port ${port} but /healthz never went green. Log:\n${log}`);
  }

  return { url, port, teardown };
}
