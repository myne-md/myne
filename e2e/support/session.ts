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
/** How long to wait for a previous driver to release the port. Generous, because
 *  the alternative to waiting is the silent wrong-data-directory launch
 *  `waitForDriverGone` documents; a scenario that pays ten seconds here is far
 *  cheaper than one that burns its whole budget on the wrong app. */
const DRIVER_FREE_TIMEOUT_MS = 10_000;

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
  /** PID of the spawned tauri-driver process. The driver is spawned `detached`,
   *  so this pid is also the process GROUP id: driver → WebKitWebDriver → the
   *  app binary all live under it. X-level helpers (`support/xwindow.ts`) use it
   *  to pick THIS session's toplevel window out of a display shared with sibling
   *  shards (myne-md/myne#555) — without it a name search cannot tell two live
   *  "Myne" windows apart. `undefined` when the spawn did not report one. */
  driverPid: number | undefined;
  /** Stop the app session + driver, remove the temp dir. */
  teardown(): Promise<void>;
  /**
   * Kill the app the way a crash kills it — SIGKILL to the whole process
   * group, no `deleteSession`, no `CloseRequested`, no chance to flush.
   *
   * `teardown` is a graceful stop and cannot stand in for this: it sends
   * SIGTERM first, and the difference between the two is the entire subject of
   * a crash-recovery scenario. Anything the app would only persist on the way
   * out is, by construction, not persisted here.
   *
   * Pair with `keepDataDir: true` — a scenario that hard-kills and then lets
   * the harness delete the tree has thrown away the only evidence. Resolves
   * once the driver has stopped answering, so the next launch cannot attach to
   * this one's corpse (see `waitForDriverGone` and the port note above).
   *
   * The session object is dead afterwards; every call on it will throw.
   */
  hardKill(): Promise<void>;
  /**
   * Wait for the app to finish exiting ON ITS OWN, after something outside the
   * harness asked it to.
   *
   * The one caller is a scenario that closes the window the way a user does —
   * `xdotool windowclose`, i.e. WM_DELETE_WINDOW, which GTK raises as
   * `delete-event` and tao as `CloseRequested`, the event `Editor.tsx` listens
   * on. That handler `preventDefault()`s the close, flushes every pane, persists
   * the workspace, the vault indices and the graph layout, and only then calls
   * `destroy()`. So the app's exit is the SIGNAL that the flush completed, and a
   * scenario that returned before it would let `teardown` SIGTERM the app
   * mid-flush and then measure a disk it had itself truncated.
   *
   * Neither `teardown` nor `hardKill` can stand in: both KILL the app, which is
   * the opposite of asking it to leave. `teardown` afterwards is still correct
   * and still cheap — it finds the session gone and reaps a dead group.
   *
   * The session object is dead once this resolves; every call on it will throw.
   */
  waitForExit(timeoutMs?: number): Promise<void>;
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
  /**
   * Command-line arguments handed to the app binary at launch.
   *
   * The one production surface this models is an OS **deep link** (MYND-567):
   * on Linux a `myne://…` click launches the app with the URL as its ONLY
   * argument, which is exactly what the app's `setup` hook reads via
   * `handle_cli_arguments`. So passing the URL here is not a test hook — it is
   * the real cold-start delivery mechanism, driven from the real entry point.
   *
   * (The warm arrival — a second process relayed through
   * `tauri-plugin-single-instance` — is NOT reachable in this container: the
   * plugin's Linux transport is DBus and the image ships no session bus. That
   * half is covered by the unit suite, not here.)
   */
  args?: readonly string[];
  /**
   * Extra environment for the app process, merged over the composed env below.
   *
   * The one thing this is for is a scenario whose SUBJECT is the machine's own
   * configuration — `TZ` above all. A timezone bug is not reachable any other
   * way: the app reads the host zone through ICU, there is no in-app setting
   * that changes what "the machine's zone" is, and a scenario that could only
   * run in the runner's own zone would be measuring the runner. Setting it here
   * is the same lever a user's OS pulls, which is what makes it a real
   * condition rather than a hook.
   *
   * It cannot reach the isolation the harness depends on: the `XDG_*` and
   * `TMPDIR` values are applied AFTER this spread, so a scenario cannot point
   * the app at a shared profile by accident (the plaintext-residue scan and the
   * whole per-scenario data dir rest on those, and a scenario that could
   * override them could silently disarm both).
   */
  env?: Readonly<Record<string, string>>;
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
 * Block until nothing is answering WebDriver on `baseUrl`.
 *
 * **This is the fix for the worst failure the suite had, and the failure looked
 * like nothing to do with ports.** Every scenario in a worker launches its own
 * `tauri-driver` on the SAME port (per worker, keyed on `VITEST_POOL_ID`), and
 * `waitForDriver` can only ask "is something answering there" — it cannot tell
 * the driver it just spawned from the previous scenario's driver still dying.
 * `teardown` sent SIGTERM, slept 200 ms, sent SIGKILL and returned WITHOUT
 * waiting for the process to go, so under load the old one was routinely still
 * listening.
 *
 * When that happened, `newSession` went to the OLD driver, which spawns the app
 * with the OLD environment — an `XDG_DATA_HOME` pointing at the `dataHome` that
 * same teardown had just `rmSync`'d. The app found no `vaults/` directory,
 * which is the legitimate fresh-install path, and rendered WELCOME. The
 * scenario then waited its full budget for an unlock screen that was never
 * coming, on a vault it had correctly seeded, in a directory the app was not
 * looking at.
 *
 * That is `sd1`, `gp1`, `gp2` and `nav1`, all quarantined for months as runner
 * contention. It also explains every property that diagnosis could not: more
 * timeout never helped (the app is pointed at a deleted directory forever), it
 * got worse at the tail of a run (more load, slower process death), and it
 * reproduced on an idle machine now and then (the race is small, not absent).
 *
 * Waiting on the PORT rather than on the process is deliberate: the port is what
 * the next launch keys on, and it covers the paths a process wait does not — a
 * teardown that never ran because its worker died, or a driver whose child
 * outlived it.
 *
 * `probe` defaults to the real `GET /status` and is a parameter only so a unit
 * test can drive the loop without standing up an HTTP server. Note that a bare
 * TCP listener is NOT enough to stand in for a driver here: `driverStatus`
 * throws on any non-2xx, so anything that answers something other than a
 * WebDriver status already reads as gone.
 */
export async function waitForDriverGone(
  baseUrl: string,
  timeoutMs: number,
  probe: (url: string) => Promise<unknown> = driverStatus,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await probe(baseUrl);
    } catch {
      return true; // nothing is answering — the port is ours
    }
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/** How far apart the fallback ports are. A worker's band is 100 wide
 *  (`worker-ports.ts`), so stepping by 1000 lands outside every band rather
 *  than inside a neighbour's. */
const PORT_FALLBACK_STRIDE = 1000;
/** How many alternates to try before giving up and saying so. */
const PORT_FALLBACK_ATTEMPTS = 4;

/**
 * A driver/native port pair nothing is answering on: the configured one when it
 * is free, else a deterministic alternate.
 *
 * **Waiting was not enough, which the suite proved rather than suggested.** The
 * first version of this refused to launch while a previous driver still held the
 * port, and a full local run hit exactly that:
 * `a WebDriver is still answering on http://127.0.0.1:4544 after 10000 ms`. The
 * teardown had already waited its own ten seconds before that, so something was
 * holding the port more than twenty seconds after being SIGKILLed as a process
 * group — a lingering driver, or one whose teardown never ran because its
 * worker died mid-scenario.
 *
 * Refusing is still better than the silent alternative it replaced, where the
 * scenario attached to that driver and got an app pointed at a deleted data
 * directory. But there is no reason to insist on one number: moving to a free
 * port makes a lingering driver unable to affect the next scenario at all.
 *
 * Deterministic steps rather than an ephemeral `:0` bind, because a bind-then-
 * release handover has the same race it is meant to avoid — `tor_sidecar`'s
 * `pick_loopback_port` is the worked example of that going wrong.
 */
export async function freeDriverPorts(
  driverPort: number,
  nativePort: number,
  // Both injectable for the unit test only; production probes for real and
  // waits the full budget on the port it was actually configured with.
  probe: (url: string) => Promise<unknown> = driverStatus,
  firstWaitMs: number = DRIVER_FREE_TIMEOUT_MS,
): Promise<{ driverPort: number; nativePort: number; movedFrom?: number }> {
  for (let attempt = 0; attempt < PORT_FALLBACK_ATTEMPTS; attempt += 1) {
    const candidate = driverPort + attempt * PORT_FALLBACK_STRIDE;
    const budget = attempt === 0 ? firstWaitMs : 500;
    if (await waitForDriverGone(`http://${DRIVER_HOST}:${candidate}`, budget, probe)) {
      return {
        driverPort: candidate,
        nativePort: nativePort + attempt * PORT_FALLBACK_STRIDE,
        movedFrom: attempt === 0 ? undefined : driverPort,
      };
    }
  }
  throw new Error(
    `every candidate WebDriver port from ${driverPort} in steps of ` +
      `${PORT_FALLBACK_STRIDE} is still answering. Launching on one would attach this ` +
      "scenario to somebody else's driver, and the app would come up against that " +
      "driver's data directory rather than this one's seed.",
  );
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

  const wantedDriverPort =
    opts.driverPort ?? Number(process.env.MYNE_E2E_DRIVER_PORT ?? DEFAULT_DRIVER_PORT);
  const wantedNativePort =
    opts.nativePort ?? Number(process.env.MYNE_E2E_NATIVE_PORT ?? DEFAULT_NATIVE_PORT);

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

  // **Never start on a port somebody else is still holding.** See
  // `waitForDriverGone`: attaching to a previous scenario's dying driver hands
  // this scenario an app pointed at a deleted data directory, and the only
  // symptom is a screen that says the vault does not exist. Resolving here
  // rather than only in `teardown` covers the paths a teardown cannot: a worker
  // that died mid-scenario, a driver whose child outlived it, a stray manual run.
  const ports = await freeDriverPorts(wantedDriverPort, wantedNativePort);
  const driverPort = ports.driverPort;
  const nativePort = ports.nativePort;
  const baseUrl = `http://${DRIVER_HOST}:${driverPort}`;
  if (ports.movedFrom !== undefined) {
    // Said out loud rather than absorbed: a scenario that had to move ports is
    // evidence a driver outlived its teardown, and a silent workaround would
    // hide the thing worth fixing.
    // eslint-disable-next-line no-console
    console.warn(
      `[e2e] port ${ports.movedFrom} was still answering; launched on ${driverPort} instead`,
    );
  }

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
        // Scenario-supplied env goes HERE, above the isolation values below, so
        // it can set `TZ` and cannot set `XDG_DATA_HOME`. See `LaunchOptions.env`.
        ...(opts.env ?? {}),
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
    const session = await newSession({
      baseUrl,
      application: defaultAppPath(),
      args: opts.args,
    });

    // Seed the device-local first-run flags BEFORE any scenario reaches the
    // editor. `AiOnboardingSurface` (myne#805) opens whenever
    // `myne.aiOnboardingSeen` is absent and its full-viewport backdrop then
    // swallows every click, exactly like the importer offer the suites dismiss
    // per-scenario — but nothing dismisses this one. The key is read at Editor
    // mount, which is always after this, so one write here clears it for every
    // scenario. Key literal matches `src/lib/aiOnboardingSeen.ts` (`SEEN_KEY`).
    // Retried because `execute` can race the first document; a scenario whose
    // SUBJECT is the onboarding clears the key itself.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await session.execute<void>(
          'window.localStorage.setItem("myne.aiOnboardingSeen", "1");',
        );
        break;
      } catch {
        await sleep(100);
      }
    }

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
      // SIGKILL is asynchronous: the listener closes when the kernel actually
      // reaps the process, not when the signal is sent. Returning here is what
      // let the NEXT scenario see this driver still answering and attach to it
      // — see `waitForDriverGone`. Best-effort, because a teardown must never
      // mask the scenario's own error; the launch-side check is the one that
      // refuses to proceed.
      await waitForDriverGone(baseUrl, DRIVER_FREE_TIMEOUT_MS);
      try {
        if (!opts.keepDataDir) rmSync(dataHome, { recursive: true, force: true });
      } catch {
        // Cleanup failure must never mask the scenario's own error
        // (teardown runs in finally) — the tmpdir reaps eventually.
      }
    };

    // See the `hardKill` doc on `AppSession`. Deliberately does NOT call
    // `deleteSession` and does NOT send SIGTERM first: a crash gives the app
    // neither.
    const hardKill = async () => {
      killTree(proc, "SIGKILL");
      await waitForDriverGone(baseUrl, DRIVER_FREE_TIMEOUT_MS);
    };

    // See the `waitForExit` doc on `AppSession`. Sends nothing: the app has
    // already been asked to close by something outside this harness, and this
    // waits for it to finish doing so.
    const waitForExit = async (timeoutMs = DRIVER_FREE_TIMEOUT_MS) => {
      await waitForDriverGone(baseUrl, timeoutMs);
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

    return {
      session,
      dataHome,
      appDataDir,
      appConfigDir,
      driverPid: proc.pid,
      teardown,
      hardKill,
      waitForExit,
      saveArtifacts,
    };
  } catch (e) {
    killTree(proc, "SIGKILL");
    if (!opts.keepDataDir) rmSync(dataHome, { recursive: true, force: true });
    throw e;
  }
}
