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
import { closeSync, existsSync, openSync, readSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const bin = syncServerBinary();
  if (!existsSync(bin)) {
    return {
      ok: false,
      reason: `myne-server binary not found at ${bin} — build it (cd myne-server && go build -o myne-server ./cmd/myne-server) or set MYNE_E2E_SERVER. The E2E image (MYND-428 task 5, deferred) builds it from a pinned SHA.`,
    };
  }
  // PRESENT is not the same as RUNNABLE, and the difference is a whole class of
  // confusing failure. The desktop suite runs inside a Linux container while the
  // repo is usually checked out on a developer's macOS host, so
  // `myne-server/myne-server` is very often a Mach-O binary sitting in a place
  // an ELF loader is about to look. `execve` then fails with ENOEXEC, the child
  // exits 126, and the scenario reports
  //
  //     myne-server exited early (code 126)
  //     Cannot run macOS (Mach-O) executable in Docker: Exec format error
  //
  // which reads like a product failure in whatever spec happened to be running
  // and is really "you built this for the wrong OS". A MISSING binary already
  // self-skips with an honest reason; an unusable one should too, rather than
  // failing the suite it is not equipped to serve.
  //
  // The check reads the file's magic rather than trusting the host platform:
  // the binary may legitimately have been cross-compiled or come from the CI
  // image, and what matters is what the loader in THIS process's OS will accept.
  try {
    const head = Buffer.alloc(4);
    const fd = openSync(bin, "r");
    try {
      readSync(fd, head, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
    const isElf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
    // Both Mach-O magics, and the fat/universal wrapper.
    const be = head.readUInt32BE(0);
    const isMachO =
      be === 0xfeedface ||
      be === 0xfeedfacf ||
      be === 0xcefaedfe ||
      be === 0xcffaedfe ||
      be === 0xcafebabe ||
      be === 0xbebafeca;
    if (process.platform === "linux" && !isElf) {
      return {
        ok: false,
        reason:
          `myne-server at ${bin} is not an ELF binary${isMachO ? " (it is Mach-O — built on macOS)" : ""}, ` +
          "so this Linux container cannot execute it. Rebuild it for Linux " +
          "(cd myne-server && GOOS=linux GOARCH=amd64 go build -o myne-server ./cmd/myne-server) " +
          "or set MYNE_E2E_SERVER. CI builds it in the `myne-server-build` step and is unaffected.",
      };
    }
  } catch {
    // Unreadable for some other reason — let the spawn produce the real error
    // rather than inventing a skip reason from a failed sniff.
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
export interface SyncServerOptions {
  /**
   * Per-account storage ceiling in bytes (`MYNE_QUOTA_CEILING_BYTES`).
   * Omit (or `0`) for the server default: **unlimited** — the self-hosted /
   * no-ceiling posture. A deliberately tiny value makes the next push exceed it,
   * which is how the over-quota banner is exercised without needing a
   * per-account `accounts.json` override (that store is fs-backend-only and
   * keyed by an account hash the test does not know until after enrollment).
   */
  quotaCeilingBytes?: number;
  /** Device cap (`MYNE_MAX_DEVICES_PER_ACCOUNT`); omit/`0` = unlimited. */
  maxDevicesPerAccount?: number;
  /**
   * Shared invite code (`MYNE_INVITE_CODE`); omit for open registration. When
   * set, the server refuses a NEW account that does not carry the matching code
   * (`decisions/sync/0625`). Minimum 32 characters, enforced at server startup.
   */
  inviteCode?: string;
}

export async function startSyncServer(
  opts: SyncServerOptions = {},
): Promise<EphemeralServer> {
  const support = syncServerSupported();
  if (!support.ok) throw new Error(support.reason);

  const dir = mkdtempSync(join(tmpdir(), "myne-e2e-server-"));
  const portfile = join(dir, "port");

  const policyEnv: Record<string, string> = {};
  if (opts.quotaCeilingBytes !== undefined) {
    policyEnv.MYNE_QUOTA_CEILING_BYTES = String(opts.quotaCeilingBytes);
  }
  if (opts.maxDevicesPerAccount !== undefined) {
    policyEnv.MYNE_MAX_DEVICES_PER_ACCOUNT = String(opts.maxDevicesPerAccount);
  }
  if (opts.inviteCode !== undefined) {
    policyEnv.MYNE_INVITE_CODE = opts.inviteCode;
  }

  const proc: ChildProcess = spawn(syncServerBinary(), [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      MYNE_SERVER_ADDR: `${SERVER_HOST}:0`,
      MYNE_SERVER_PORTFILE: portfile,
      ...policyEnv,
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
