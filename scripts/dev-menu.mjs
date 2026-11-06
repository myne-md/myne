#!/usr/bin/env node
// dev-menu.mjs — one command, one local sync server, any mix of Myne clients.
//
//   pnpm start                     # interactive menu; press a key per client
//   pnpm start --open d,d,w        # same, non-interactive (scripts, screenshots)
//   pnpm dev:reset                 # wipe the dev instances and the sync store
//
//   a  Android (emulator, or a USB device with adb reverse)
//   i  iOS simulator (macOS only)
//   d  Desktop instance A        second press: desktop instance B
//   w  web client
//   l  status                    k  stop the last target        q / Ctrl-C  quit
//
// # What this replaced, and why one file
//
// `scripts/dev-two-desktop.sh` and `scripts/dev-web.sh` each booted a sync server
// from scratch, so the facts that make a dev server honest lived in two places and
// would have lived in a third here: `MYNE_STORAGE_BACKEND=fs` beside its path (the
// server's default is `mem`, which throws the account away at exit while the
// directory sits there looking persistent), the loopback-only endpoint, the
// per-vault in-process lock that makes two servers over one store two writers, and
// the check that a port answering is not the same thing as OUR server answering.
// Both scripts are gone; this file is the only owner of those facts.
//
// # The four constraints this file exists to obey
//
// 1. **Never the real identifier.** `md.myne.desktop` is the owner's own app and
//    vault. Seeding a dev endpoint into it repoints the production app at
//    127.0.0.1, so both desktop instances use `md.myne.desktop.a` / `.b` and keep
//    their own data directories. The reset script knows those two names.
// 2. **The second desktop costs a relink.** `tauri-build` bakes the identifier at
//    compile time and emits `rerun-if-env-changed=TAURI_CONFIG`, so switching
//    between A and B rebuilds the desktop crate. That is the behaviour the old
//    `dev:two` had and it is kept on purpose; the status line says why the second
//    press is slow instead of looking hung.
// 3. **One Cargo build at a time.** Five clients share one `target/`, and Cargo
//    serialises on the build-directory lock. Presses queue, and Cargo prints
//    "Blocking waiting for file lock" itself, so this file does not pretend to
//    schedule them; it does serialise its own one-shot warm-ups (sidecars, wasm),
//    which are ours and do finish.
// 4. **A phone cannot reach a LAN endpoint.** `core/src/plugins/sync/config.rs`
//    accepts plain `http` only on a loopback host, so `a` and `i` mean emulator and
//    simulator. A USB Android works through `adb reverse`; a physical iPhone would
//    need TLS and is out of scope. The mobile endpoint is typed once in Settings,
//    because the config lives inside the app container rather than in a directory
//    a shell can write.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
const PNPM = IS_WIN ? "pnpm.cmd" : "pnpm";

const DESKTOP_VITE_PORT = 1420;
const WEB_PORT = 1421;
const SYNC_PORT_DEFAULT = Number(process.env.MYNE_DEV_SYNC_PORT ?? 8787);
const SYNC_PORT_ATTEMPTS = 20;

const STORE_BASE = join(ROOT, ".opencode", "dev-sync-store");
const LOCK_DIR = join(ROOT, ".opencode", "dev-launch");
const LOCK_FILE = join(LOCK_DIR, "session.json");

const DESKTOP_IDS = ["md.myne.desktop.a", "md.myne.desktop.b"];

// ── output ───────────────────────────────────────────────────────────────────
const log = (msg = "") => process.stdout.write(`${msg}\n`);
const warn = (msg) => process.stderr.write(`${msg}\n`);

// ── process plumbing ─────────────────────────────────────────────────────────
//
// Every child is spawned detached so it leads its own process group. That is what
// lets one kill take the whole tree: `pnpm tauri dev` -> cargo -> the app binary,
// and `pnpm dev` -> vite -> esbuild. Killing the pid alone orphans them, which the
// old scripts' `set -m` + `kill -- -$pid` existed to avoid.
function spawnTarget(label, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  child.label = label;
  child.on("error", (err) => warn(`!! ${label}: ${err.message}`));
  return child;
}

function stopGroup(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      return;
    }
  }
  const pid = child.pid;
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 4000).unref();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A bare TCP probe. It answers "does something listen", which is all a readiness
// wait needs, and it is deliberately not the same question as "is it OUR server".
async function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(700, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(host, port)) return true;
    await sleep(300);
  }
  return false;
}

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Serialises the warm-ups this file owns. `tauri dev` deliberately does not go
// through here: it is long-lived, so a queue would block every later press.
let warmupTail = Promise.resolve();
function serialized(fn) {
  const run = warmupTail.then(fn);
  warmupTail = run.then(
    () => {},
    () => {},
  );
  return run;
}

// The shipped beta-terms version, read from its source of truth. The old
// `dev:two` wrote "1" long after `@myne/copy` moved to "2", which is a dev
// instance that boots behind the terms gate and looks like an app bug.
function betaTermsVersion() {
  const src = readFileSync(join(ROOT, "copy/src/index.ts"), "utf8");
  const m = /export const BETA_TERMS_VERSION = "([^"]+)"/.exec(src);
  if (!m) throw new Error("BETA_TERMS_VERSION not found in copy/src/index.ts");
  return m[1];
}

// ── the sync server ──────────────────────────────────────────────────────────
//
// A WORKTREE HAS NO COMPANION REPOS. `myne-server` is a separate repository cloned
// into the MAIN checkout, so it does not exist beside this file in a worktree.
// `--git-common-dir` is the shared `.git`, whose parent is the checkout the
// worktrees were cut from, which is where the second look goes. The binary is
// written beside that companion (gitignored there); the STORE stays under THIS
// checkout, so two worktrees never share accounts.
function findServerDir() {
  const override = process.env.MYNE_SERVER_DIR;
  if (override) return override;

  const local = join(ROOT, "myne-server");
  if (existsSync(join(local, "go.mod"))) return local;

  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    const besideMain = join(dirname(common), "myne-server");
    if (existsSync(join(besideMain, "go.mod"))) return besideMain;
  } catch {
    /* not a git checkout, or no git on PATH */
  }
  return null;
}

async function startSyncServer() {
  const dir = findServerDir();
  if (!dir) {
    warn("!! no myne-server checkout found, beside this repository or beside the main one.");
    warn("!! Clone the companions with ./workspace/setup.sh, or set MYNE_SERVER_DIR.");
    warn("!! The desktop clients can still run with sync unconfigured. The web client");
    warn("!! cannot open a vault at all without a server, so `w` will refuse.");
    return null;
  }

  const bin = join(dir, "myne-server");
  let hasGo = false;
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    hasGo = true;
  } catch {
    /* no toolchain: use whatever binary is already there */
  }

  if (hasGo) {
    log(`==> building myne-server (host binary, from ${dir})`);
    try {
      execFileSync("go", ["build", "-o", "myne-server", "./cmd/myne-server"], {
        cwd: dir,
        stdio: ["ignore", "inherit", "inherit"],
      });
    } catch {
      warn(`!! could not build myne-server in ${dir}.`);
      return null;
    }
  } else if (!existsSync(bin)) {
    warn(`!! ${bin} is missing, and no Go toolchain is here to build it.`);
    return null;
  }

  // The store is what carries the account, so the PORT is the cheap thing to move.
  // A run that does move gets its OWN store, because `myne-server` locks per vault
  // IN PROCESS only (`myne-server/internal/store/fsstore.go`), so two server
  // processes over one store root are two writers with nothing between them.
  let port = SYNC_PORT_DEFAULT;
  let moved = 0;
  while (await portOpen("127.0.0.1", port)) {
    port += 1;
    moved += 1;
    if (moved > SYNC_PORT_ATTEMPTS) {
      warn(`!! no free sync port in ${SYNC_PORT_DEFAULT}..${port}. Set MYNE_DEV_SYNC_PORT.`);
      return null;
    }
  }
  const store = moved === 0 ? STORE_BASE : `${STORE_BASE}-${port}`;
  if (moved !== 0) log(`==> :${SYNC_PORT_DEFAULT} is taken; using :${port} with its own store`);

  mkdirSync(store, { recursive: true });
  const endpoint = `http://127.0.0.1:${port}`;
  // `MYNE_ALLOWED_ORIGINS` is what makes the browser's calls legal at all: the page
  // is on a different origin from the server by construction, CORS is off unless an
  // operator lists origins, and an unlisted one is refused at the preflight. Both
  // spellings, because `localhost` and `127.0.0.1` are two different origins to a
  // browser and both are things a person types.
  const child = spawnTarget("sync server", bin, [], {
    env: {
      MYNE_SERVER_ADDR: `127.0.0.1:${port}`,
      MYNE_STORAGE_BACKEND: "fs",
      MYNE_STORAGE_PATH: store,
      MYNE_ALLOWED_ORIGINS: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
    },
  });

  log(`==> starting the local sync server on ${endpoint} (store: ${store})`);
  if (!(await waitForPort("127.0.0.1", port, 12000))) {
    warn(`!! :${port} never started listening. The store is untouched.`);
    stopGroup(child);
    return null;
  }

  // A port that answers is not the same thing as OUR server. This check was added
  // to the old web script after the failure it catches happened for real: two
  // processes raced for a port, the wrong one won, and the run still printed a URL.
  if (!(await httpOk(`${endpoint}/healthz`))) {
    warn(`!! :${port} answers, but not with the sync server's /healthz.`);
    stopGroup(child);
    return null;
  }

  child.on("exit", () => {
    if (!shuttingDown) warn("!! the sync server exited. Target presses that need it will refuse.");
    session.server = null;
  });
  return { port, store, endpoint, child };
}

// ── one session at a time ────────────────────────────────────────────────────
//
// Two sessions would have picked different ports and therefore different stores,
// which is the split-brain nobody notices until an account is missing. A stale lock
// (a crashed session) is taken over, since its pid no longer answers.
function takeLock() {
  mkdirSync(LOCK_DIR, { recursive: true });
  if (existsSync(LOCK_FILE)) {
    try {
      const prev = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
      if (prev.pid && prev.pid !== process.pid) {
        process.kill(prev.pid, 0);
        return prev;
      }
    } catch {
      /* dead or unreadable: take it over */
    }
  }
  return null;
}

const session = { server: null, web: null, vite: null, desktops: [], last: null };

// ── desktop instances ────────────────────────────────────────────────────────
//
// Tauri derives `app_data_dir` from the identifier at COMPILE time, and
// `tauri-plugin-single-instance` keys its lock on the same string, so a second
// `pnpm tauri dev` from this checkout only focuses the first window. Handing each
// instance its own identifier separates both the lock and the data directory,
// which is what makes instance B an independent app with an independent vault. The
// real `md.myne.desktop` is never in this list, on purpose.
function appConfigDir(id) {
  if (IS_MAC) return join(homedir(), "Library", "Application Support", id);
  if (IS_WIN) return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), id);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), id);
}

// `sync-config.json` is the endpoint surface (SYNC-14) and `legal-consent.json` the
// beta-terms acceptance, so both are seeded before boot and no in-app Settings step
// is needed. The version comes from `@myne/copy` because a stale one re-asks for
// terms that were already accepted, or fails to match the shipped string at all.
function seedAppConfig(id, endpoint) {
  const dir = appConfigDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sync-config.json"), `{\n  "endpoint_url": "${endpoint}"\n}\n`);
  writeFileSync(
    join(dir, "legal-consent.json"),
    `{\n  "beta_terms_version": "${betaTermsVersion()}"\n}\n`,
  );
}

async function ensureDesktopVite() {
  if (session.vite) return true;
  if (await portOpen("localhost", DESKTOP_VITE_PORT)) {
    log(`==> :${DESKTOP_VITE_PORT} already serving; reusing the running Vite`);
    session.vite = { reused: true };
    return true;
  }
  log(`==> starting the shared Vite dev server on :${DESKTOP_VITE_PORT}`);
  const child = spawnTarget("vite", PNPM, ["dev"]);
  session.vite = { child, reused: false };
  if (!(await waitForPort("localhost", DESKTOP_VITE_PORT, 40000))) {
    warn(`!! the Vite dev server never answered on :${DESKTOP_VITE_PORT}.`);
    stopGroup(child);
    session.vite = null;
    return false;
  }
  return true;
}

async function startDesktop(index) {
  const id = DESKTOP_IDS[index];
  if (index >= DESKTOP_IDS.length) return;
  if (session.desktops[index]) {
    log(`==> instance ${"AB"[index]} is already up (${id})`);
    return;
  }
  if (!(await ensureDesktopVite())) return;

  if (session.server) {
    seedAppConfig(id, session.server.endpoint);
    log(`    endpoint seeded into ${appConfigDir(id)}/sync-config.json`);
  } else {
    warn("!! no sync server: this instance starts with sync unconfigured.");
  }

  // The sidecars are `externalBin` entries, so the desktop binary needs them staged
  // before `tauri dev` runs. `beforeDevCommand` is emptied because this file owns
  // the Vite server, and a second `pnpm dev` would die on `strictPort`.
  if (!(await ensureSidecars())) return;
  log(`==> instance ${"AB"[index]} (${id})`);
  if (index > 0) {
    log("    the identifier differs from instance A, so this relinks the desktop crate");
  }
  log("    Cargo builds share one target dir: a press made now queues behind it");
  const child = spawnTarget(`desktop ${"AB"[index]}`, PNPM, [
    "tauri",
    "dev",
    "--config",
    JSON.stringify({ identifier: id, build: { beforeDevCommand: "" } }),
  ]);
  session.desktops[index] = child;
  session.last = child;
  child.on("exit", (code) => {
    if (session.desktops[index] === child) session.desktops[index] = null;
    if (!shuttingDown) log(`==> instance ${"AB"[index]} exited (${code ?? "signal"})`);
  });
}

// ── web client ───────────────────────────────────────────────────────────────
//
// `web/wasm/pkg/` is a derived artefact and is NOT in git, and `src/worker/worker.ts`
// imports it by path, so a fresh worktree fails the bundle with a missing-export
// error rather than at runtime. Built once here and then left alone, because it is
// the slowest step in this file by an order of magnitude.
async function ensureWebWasm() {
  const pkg = join(ROOT, "web/wasm/pkg/myne_web_wasm.js");
  if (existsSync(pkg) && !process.env.MYNE_DEV_REBUILD_WASM) return true;
  log("==> building the web wasm package (not in git; this takes a few minutes)");
  return serialized(() => new Promise((resolve) => {
    const child = spawnTarget("wasm", "bash", [join(ROOT, "scripts/build-wasm.sh")]);
    child.on("exit", (code) => resolve(code === 0));
  }));
}

async function startWeb() {
  if (session.web) {
    log(`==> the web client is already up on http://localhost:${WEB_PORT}`);
    return;
  }
  // A server already on :1421 was not necessarily started by this file, and the ones
  // that were not (an older checkout, a bare `pnpm web:dev`) serve the environment
  // refusal screen. Reusing one silently would make this command's promise
  // unverifiable, so it stops here instead.
  if (await portOpen("localhost", WEB_PORT)) {
    warn(`!! :${WEB_PORT} is already serving. Stop that server and press w again: a dev`);
    warn("!! server started outside this command has no cross-origin isolation headers");
    warn("!! and no /config.json, so the page it serves is the refusal screen.");
    return;
  }
  // The asymmetry the old web script spelled out and this one keeps: a desktop window
  // with no sync server is still a desktop app, and a browser tab with no server can
  // do nothing at all, so this refuses rather than printing a URL that cannot work.
  if (!session.server) {
    warn("!! the web client needs the sync server, and there is none. Not starting.");
    warn("!! Fix the server first: ./workspace/setup.sh clones myne-server.");
    return;
  }
  if (!(await ensureWebWasm())) {
    warn("!! the wasm package did not build; the web client cannot start without it.");
    return;
  }

  log(`==> starting the web dev client on :${WEB_PORT}`);
  const child = spawnTarget("web", PNPM, ["web:dev"], {
    env: { MYNE_DEV_SYNC_ORIGIN: session.server.endpoint },
  });
  session.web = child;
  session.last = child;
  child.on("exit", (code) => {
    if (session.web === child) session.web = null;
    if (!shuttingDown) log(`==> the web client exited (${code ?? "signal"})`);
  });

  if (!(await waitForPort("localhost", WEB_PORT, 60000))) {
    warn(`!! the web dev client exited before it was serving. A taken :${WEB_PORT} is the usual reason.`);
    session.web = null;
    return;
  }

  // Both halves of the pair, not one. `web/src/environment-gate.ts` requires
  // `crossOriginIsolated` AND a constructible `SharedArrayBuffer`, so a regression
  // that drops only COEP would pass a single-header check and still print a URL
  // leading to the refusal screen.
  let headers;
  try {
    headers = await fetch(`http://localhost:${WEB_PORT}/`, { signal: AbortSignal.timeout(4000) }).then(
      (r) => r.headers,
    );
  } catch {
    headers = null;
  }
  for (const name of ["cross-origin-opener-policy", "cross-origin-embedder-policy"]) {
    if (!headers?.has?.(name)) {
      warn(`!! :${WEB_PORT} answers without the ${name} header, so this is not the dev`);
      warn("!! server this command started. The page it serves is the refusal screen.");
      stopGroup(child);
      session.web = null;
      return;
    }
  }

  const url = `http://localhost:${WEB_PORT}`;
  log(`    web client: ${url}`);
  log("    the dev server sends NO CSP (Vite's dev client is an inline module script),");
  log("    so nothing about the security posture is verified here: that lives in the");
  log("    container and in `pnpm test:e2e:web`, which load the built bundle.");
  if (!process.env.MYNE_DEV_NO_OPEN) openBrowser(url);
}

function openBrowser(url) {
  const cmd = IS_MAC ? "open" : IS_WIN ? "cmd" : "xdg-open";
  const args = IS_WIN ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* no browser launcher: the URL is printed above anyway */
  }
}

// ── mobile clients ───────────────────────────────────────────────────────────
//
// `pnpm mobile:android` / `mobile:ios` bring their own Vite server on :1422 through
// `beforeDevCommand`, so nothing here has to start one. What they cannot get is the
// endpoint: it is stored inside the app container, not in a directory this file can
// write, so it is typed once in Settings.
function mobileEndpointHint() {
  if (!session.server) {
    warn("!! no sync server: sync stays unconfigured in the app until one exists.");
    return;
  }
  log(`    endpoint to type in Settings -> Sync: ${session.server.endpoint}`);
}

async function startAndroid() {
  if (!session.server) mobileEndpointHint();
  // An emulator reaches the host loopback through `adb reverse`, and so does a USB
  // device. Without it the endpoint a person types is a 127.0.0.1 that means the
  // phone itself, and `validate_endpoint_url` cannot help: it is loopback, and legal.
  if (session.server) {
    try {
      execFileSync("adb", ["reverse", `tcp:${session.server.port}`, `tcp:${session.server.port}`], {
        stdio: "ignore",
      });
      log(`    adb reverse tcp:${session.server.port} in place, so 127.0.0.1 reaches this machine`);
    } catch {
      log("    no adb on PATH (or no device attached): on an emulator the loopback");
      log("    address is the emulator itself. Run `adb reverse tcp:<port> tcp:<port>` first.");
    }
  }
  mobileEndpointHint();
  log("==> starting the Android client (needs the SDK and NDK)");
  const child = spawnTarget("android", PNPM, ["mobile:android"]);
  session.last = child;
  child.on("exit", (code) => {
    if (!shuttingDown) log(`==> the Android client exited (${code ?? "signal"})`);
  });
}

function startIos() {
  if (!IS_MAC) {
    warn("!! the iOS client needs Xcode, so it only runs on macOS.");
    return;
  }
  // The simulator shares the host network stack, so a loopback endpoint works as
  // typed. A physical iPhone does not, and would need an https endpoint.
  mobileEndpointHint();
  log("==> starting the iOS client in the simulator");
  const child = spawnTarget("ios", PNPM, ["mobile:ios"]);
  session.last = child;
  child.on("exit", (code) => {
    if (!shuttingDown) log(`==> the iOS client exited (${code ?? "signal"})`);
  });
}

// ── sidecars ─────────────────────────────────────────────────────────────────
//
// `tauri.conf.json` stages the CLI, MCP and Tor binaries as `externalBin` through
// `beforeDevCommand`, which this file empties, so one staging pass happens here and
// only the first desktop press waits for it.
let sidecars = null;
function ensureSidecars() {
  if (!sidecars) {
    sidecars = serialized(() => new Promise((resolve) => {
      log("==> staging the CLI, MCP and Tor sidecars (once)");
      const child = spawnTarget("sidecars", PNPM, ["sidecar"]);
      child.on("exit", (code) => {
        if (code !== 0) {
          warn("!! sidecar staging failed; a desktop instance may refuse to start.");
          sidecars = null;
        }
        resolve(code === 0);
      });
    }));
  }
  return sidecars;
}

// ── status ───────────────────────────────────────────────────────────────────
function status() {
  const state = (v, what) => (v ? what : "not started");
  log("");
  log("  sync server  " + (session.server
    ? `${session.server.endpoint}  (store: ${session.server.store})`
    : "none: desktop clients start unconfigured, the web client refuses"));
  log("  env          " + (session.vite ? `Vite on :${DESKTOP_VITE_PORT}` : "no Vite on :1420 yet"));
  log("  desktop A    " + state(session.desktops[0], `up (${DESKTOP_IDS[0]})`));
  log("  desktop B    " + state(session.desktops[1], `up (${DESKTOP_IDS[1]})`));
  log("  web          " + state(session.web, `up on http://localhost:${WEB_PORT}`));
  log("");
  log("  Enrolment is still manual and it is the one thing this command cannot do:");
  log("  create the account in one window, then enrol the others with the same");
  log("  credentials. They already share one server, so they will see one vault.");
  log("");
}

function help() {
  log("");
  log("  a  Android (emulator, or a USB device with adb reverse)");
  log(`  i  iOS simulator${IS_MAC ? "" : " (macOS only)"}`);
  log("  d  desktop instance A       second press: desktop instance B");
  log("  w  web client");
  log("  l  status        k  stop the last target started");
  log("  ?  this help     q / Ctrl-C  stop everything and quit");
  log("");
}

// ── lifecycle ────────────────────────────────────────────────────────────────
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log();
  log("==> stopping every target");
  const children = [
    ...session.desktops,
    session.web,
    session.vite && !session.vite.reused ? session.vite.child : null,
    session.server?.child,
  ].filter(Boolean);
  for (const child of children) stopGroup(child);
  try {
    rmSync(LOCK_FILE, { force: true });
  } catch {
    /* nothing to remove */
  }
  // Children lead their own process groups, so this process exiting does not reach
  // them: the signals above are the whole teardown. The grace period exists because
  // a Cargo build takes a moment to die, and `stopGroup`'s own SIGKILL timer would
  // never fire once this process is gone.
  await sleep(1500);
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}

// ── keys ─────────────────────────────────────────────────────────────────────
async function press(key) {
  switch (key) {
    case "a":
      return startAndroid();
    case "i":
      return startIos();
    case "d":
      return session.desktops[0] ? startDesktop(1) : startDesktop(0);
    case "w":
      return startWeb();
    case "l":
      return status();
    case "k":
      if (session.last) {
        const label = session.last.label;
        stopGroup(session.last);
        session.last = null;
        log(`==> stopped ${label}`);
      } else {
        log("==> nothing has been started from this session yet");
      }
      return;
    case "?":
      return help();
    case "q":
    case "\u0003":
      return shutdown();
    default:
      return;
  }
}

// Keys arrive as `data` events, and two events can overlap while the first press is
// still waiting on a build. Every press goes through this queue, so a fast double
// `d` starts instance A once and then instance B, rather than instance A twice.
let pressTail = Promise.resolve();
function enqueue(key) {
  pressTail = pressTail.then(() => (shuttingDown ? undefined : press(key))).catch((err) => {
    warn(`!! ${err?.message ?? err}`);
  });
  return pressTail;
}

function interactive() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (buf) => {
    for (const ch of buf.toString("utf8")) {
      if (shuttingDown) return;
      enqueue(ch);
    }
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    help();
    return;
  }

  const openArg = argv.find((a, i) => argv[i - 1] === "--open");
  const keys = (openArg ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const live = takeLock();
  if (live) {
    warn(`!! a dev session is already running (pid ${live.pid}, sync server on :${live.port}).`);
    warn("!! Stop it first (q or Ctrl-C in that terminal), or set MYNE_DEV_SYNC_PORT to run");
    warn("!! a second session with its own port and store.");
    process.exit(2);
  }

  log();
  log("==> pnpm start: Myne clients against one local sync server");
  log(`    repo: ${ROOT}`);

  // The lock goes down BEFORE the server starts, so a session opened in the same
  // second as this one is refused instead of quietly taking the next port and its
  // own store. It is rewritten with the port once that is known.
  mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: null }, null, 2));

  session.server = await startSyncServer();
  writeFileSync(
    LOCK_FILE,
    JSON.stringify(
      { pid: process.pid, port: session.server?.port ?? null, started: new Date().toISOString() },
      null,
      2,
    ),
  );

  if (session.server) log(`    every client will point at ${session.server.endpoint}`);
  help();

  if (keys.length > 0) {
    // Non-interactive: still sequential, because two Cargo builds started at once
    // only take the build-directory lock from each other.
    for (const key of keys) await enqueue(key);
    if (!process.stdin.isTTY) {
      log("==> targets started; Ctrl-C stops them");
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise(() => {});
    }
  } else if (!process.stdin.isTTY) {
    warn("!! stdin is not a terminal, so the key menu cannot run.");
    warn("!! Use `pnpm start --open d,d,w` to name the targets instead.");
    await shutdown();
    return;
  }

  interactive();
}

main().catch(async (err) => {
  warn(`!! ${err?.stack ?? err}`);
  await shutdown();
});
