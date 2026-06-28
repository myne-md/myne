// tauri-driver process + session lifecycle for the Myne E2E harness.
//
// One `tauri-driver` process per app session. The driver proxies W3C
// WebDriver to the platform's native driver (WebKitWebDriver on Linux —
// the harness's only supported platform, SYNC-1; tauri-driver has no
// macOS support). Each session gets a fresh `XDG_DATA_HOME` so
// `app_data_dir` (identifier `md.myne.desktop`) resolves into an
// isolated throwaway directory — the SYNC-2 isolation primitive. The
// fuller fixture layer (`seedVault`, fault injection) builds on top of
// this in `fixtures.ts`.
//
// Zero test hooks: the app binary is the untouched production build;
// all state control happens via env, disk layout, and real UI driving.

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  driverStatus,
  newSession,
  type Session,
} from "./webdriver";

const DRIVER_HOST = "127.0.0.1";
const DEFAULT_DRIVER_PORT = 4444;
const DEFAULT_NATIVE_PORT = 4445;
const DRIVER_READY_TIMEOUT_MS = 15_000;

/** Repo root (this file lives at e2e/support/). */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** Production binary under test (SYNC-4: prod bundle, not dev).
 *  The workspace-level Cargo target dir lives at the REPO ROOT
 *  (single shared workspace — src-tauri has no own target/). */
export function defaultAppPath(): string {
  return (
    process.env.MYNE_E2E_APP ?? join(REPO_ROOT, "target", "release", "myne-desktop")
  );
}

export function driverBinary(): string {
  return process.env.TAURI_DRIVER ?? "tauri-driver";
}

/** Signal the whole process GROUP led by `proc` (it is spawned `detached`, so its
 *  pid is the group id), reaping tauri-driver + WebKitWebDriver + the app binary
 *  together. Falls back to signalling just `proc` if the group send fails (e.g.
 *  the process already exited, or a platform without process groups). */
function killTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // group gone / unsupported — fall through to the single-process kill
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // already dead
  }
}

/** Cheap preflight: are we even on a platform that can run the harness?
 *  Used by specs to self-skip with an honest message instead of a
 *  confusing spawn failure (the harness is Linux-only — SYNC-1). */
export function harnessSupported(): { ok: boolean; reason?: string } {
  if (process.platform !== "linux") {
    return {
      ok: false,
      reason: `tauri-driver supports Linux/Windows only and this harness targets Linux (platform: ${process.platform}). Run via the container — see docs/dev/e2e.md.`,
    };
  }
  if (!existsSync(defaultAppPath())) {
    return {
      ok: false,
      reason: `app binary not found at ${defaultAppPath()} — build it first (pnpm tauri build --no-bundle) or set MYNE_E2E_APP.`,
    };
  }
  return { ok: true };
}

export interface AppSession {
  session: Session;
  /** The session's isolated XDG_DATA_HOME root. */
  dataHome: string;
  /** `<dataHome>/md.myne.desktop` — what `app_data_dir` resolves to. */
  appDataDir: string;
  /** `<dataHome>/.config/md.myne.desktop` — what `app_config_dir`
   *  resolves to (device-local sync endpoint config lives here, SYNC-14). */
  appConfigDir: string;
  /** Stop the app session + driver, remove the temp dir. */
  teardown(): Promise<void>;
  /** Save a failure artifact (base64 PNG screenshot + page source). */
  saveArtifacts(label: string): Promise<void>;
}

export interface LaunchOptions {
  /** Pre-seed callback: receives the session's appDataDir BEFORE the
   *  app launches (lay down `vaults/<id>/` fixtures, legacy `vault/`
   *  layouts, corrupt bytes…). The dir exists when called. */
  seed?: (appDataDir: string) => void | Promise<void>;
  /** Pre-seed callback for the app_config_dir (device-local plaintext:
   *  the sync endpoint config, custom themes…). Runs before launch; the
   *  dir exists when called. Used by the multi-device harness to point a
   *  device at the ephemeral server via the real SYNC-14 surface. */
  seedConfig?: (appConfigDir: string) => void | Promise<void>;
  /** Keep the temp data dir on teardown (debugging). */
  keepDataDir?: boolean;
  /** Override the tauri-driver port (multi-device: one pair per instance,
   *  off the `MYNE_E2E_DRIVER_PORT` base). Defaults to env/4444. */
  driverPort?: number;
  /** Override the native (WebView automation) port. Defaults to env/4445. */
  nativePort?: number;
}

async function waitForDriver(baseUrl: string, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + DRIVER_READY_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `tauri-driver exited early (code ${proc.exitCode}). Is WebKitWebDriver installed? See docs/dev/e2e.md.`,
      );
    }
    try {
      await driverStatus(baseUrl);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(150);
    }
  }
  throw new Error(`tauri-driver not ready after ${DRIVER_READY_TIMEOUT_MS} ms: ${String(lastErr)}`);
}

/**
 * Launch tauri-driver + the production app with an isolated data dir.
 *
 * The fresh `XDG_DATA_HOME` is exported on the DRIVER process (the app
 * inherits the driver's environment), so every `launchApp` is a cold,
 * hermetic boot — the `freshAppDataDir()` primitive of SYNC-2.
 */
export async function launchApp(opts: LaunchOptions = {}): Promise<AppSession> {
  const support = harnessSupported();
  if (!support.ok) throw new Error(support.reason);

  const driverPort =
    opts.driverPort ?? Number(process.env.MYNE_E2E_DRIVER_PORT ?? DEFAULT_DRIVER_PORT);
  const nativePort =
    opts.nativePort ?? Number(process.env.MYNE_E2E_NATIVE_PORT ?? DEFAULT_NATIVE_PORT);
  const baseUrl = `http://${DRIVER_HOST}:${driverPort}`;

  const dataHome = mkdtempSync(join(tmpdir(), "myne-e2e-"));
  const appDataDir = join(dataHome, "md.myne.desktop");
  mkdirSync(appDataDir, { recursive: true });
  // app_config_dir = XDG_CONFIG_HOME/md.myne.desktop (XDG_CONFIG_HOME is set
  // to <dataHome>/.config below). Create it so seedConfig can lay down the
  // device-local sync endpoint config before launch (SYNC-14).
  const appConfigDir = join(dataHome, ".config", "md.myne.desktop");
  mkdirSync(appConfigDir, { recursive: true });
  // XDG_RUNTIME_DIR demands 0700 ownership; create it explicitly so
  // WebKit scratch files land inside the scanned/cleaned tree too.
  const runtimeDir = join(dataHome, ".runtime");
  mkdirSync(runtimeDir, { recursive: true });
  chmodSync(runtimeDir, 0o700);
  const tmpDir = join(dataHome, ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  if (opts.seed) await opts.seed(appDataDir);
  if (opts.seedConfig) await opts.seedConfig(appConfigDir);

  const proc = spawn(
    driverBinary(),
    ["--port", String(driverPort), "--native-port", String(nativePort)],
    {
      // Own process GROUP: tauri-driver spawns WebKitWebDriver which spawns the
      // app binary; `detached` makes `proc` the group leader so teardown can
      // reap the WHOLE tree with one group signal. Without this, killing only
      // `proc` orphans the app binary when `deleteSession` doesn't close it
      // (e.g. it timed out under load) — and ~60 orphaned WebKit app instances
      // accumulating across the suite are exactly the cumulative host pressure
      // that made late tests flaky.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_DATA_HOME: dataHome,
        // Belt-and-suspenders isolation for config/cache too — keeps a
        // host machine's real profile out of reach even if a code path
        // ever consults these.
        XDG_CONFIG_HOME: join(dataHome, ".config"),
        XDG_CACHE_HOME: join(dataHome, ".cache"),
        // Scratch surfaces too — the plaintext-never-on-disk scan
        // (SYNC-13) covers dataHome, so point every tmp class at it.
        XDG_RUNTIME_DIR: runtimeDir,
        TMPDIR: tmpDir,
      },
    },
  );
  let driverLog = "";
  proc.stdout?.on("data", (d: Buffer) => (driverLog += d.toString()));
  proc.stderr?.on("data", (d: Buffer) => (driverLog += d.toString()));

  try {
    await waitForDriver(baseUrl, proc);
    const session = await newSession({ baseUrl, application: defaultAppPath() });

    const teardown = async () => {
      try {
        await session.deleteSession();
      } catch {
        // Session may already be gone (app crashed / window closed).
      }
      // Reap the ENTIRE driver→WebKitWebDriver→app process group (negative pid),
      // not just `proc` — orphaned app instances are the suite's load leak. Fall
      // back to a plain `proc` kill if the group signal can't be sent.
      killTree(proc, "SIGTERM");
      await sleep(200);
      if (proc.exitCode === null) killTree(proc, "SIGKILL");
      try {
        if (!opts.keepDataDir) rmSync(dataHome, { recursive: true, force: true });
      } catch {
        // Cleanup failure must never mask the scenario's own error
        // (teardown runs in finally) — the tmpdir reaps eventually.
      }
    };

    const saveArtifacts = async (label: string) => {
      const dir = join(REPO_ROOT, "e2e", "artifacts");
      mkdirSync(dir, { recursive: true });
      const stamp = label.replace(/[^a-z0-9-]+/gi, "_");
      try {
        const png = await session.screenshot();
        writeFileSync(join(dir, `${stamp}.png`), Buffer.from(png, "base64"));
      } catch {
        // Screenshot can fail if the window is gone — still try source.
      }
      try {
        const html = await session.source();
        writeFileSync(join(dir, `${stamp}.html`), html);
      } catch {
        // Best-effort.
      }
      writeFileSync(join(dir, `${stamp}.driver.log`), driverLog);
    };

    return { session, dataHome, appDataDir, appConfigDir, teardown, saveArtifacts };
  } catch (e) {
    killTree(proc, "SIGKILL");
    if (!opts.keepDataDir) rmSync(dataHome, { recursive: true, force: true });
    throw e;
  }
}
