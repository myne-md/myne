// Driving the TOPLEVEL window from a scenario (myne-md/myne#555).
//
// # Why this exists rather than `session.setWindowRect`
//
// WebKitWebDriver accepts `POST /window/rect` and does nothing with it. Not an
// error, not a refusal: HTTP 200 carrying the window's UNCHANGED rect. Measured
// on this harness, asking for 800px on a 1100px window over a 1280x1024 screen:
//
//     ask=800  granted={"x":0,"y":0,"width":1100,"height":720}
//     page={"iw":1100,"ow":1100,"sw":1280,"sh":1024}
//
// `window.innerWidth` agreed with the granted rect, so it is not stale
// geometry, and the screen is 180px wider than the request, so it is not a
// ceiling. The command is simply unimplemented and reports success — which is
// the worst shape a gap can take, because a caller has nothing to check.
// `Session.setWindowRect` stays on the Session (it is correct W3C, and a driver
// that grows the capability will start working through it) but nothing in this
// suite may rely on it.
//
// # What xdotool does instead, and why it works BETTER without a window manager
//
// xdotool talks to the X server. Under xvfb there is no window manager, so
// there is nobody to arbitrate, veto, or reinterpret a geometry request:
// `windowsize` is a plain XConfigureWindow and the server applies it. GTK
// receives the resulting ConfigureNotify and reflows, which is the same path a
// user dragging a window edge produces on a real desktop.
//
// The absence of a WM is also why `windowclose` is the right primitive for a
// close: it sends WM_DELETE_WINDOW as a ClientMessage directly to the window,
// GTK turns that into `delete-event`, and tao raises `CloseRequested` — the
// exact chain `Editor.tsx` listens on. `xdotool key --window <id> alt+F4` would
// need a WM to mean anything and is not usable here.
//
// # The window is found by NAME, scoped by OWNER, and the count is asserted
//
// `xdotool search --name` matches a regex against every window on the display,
// and a full-suite run shares ONE Xvfb display across all its file-workers:
// `e2e-local.sh` wraps the whole `pnpm test:e2e` in a single `xvfb-run -a`, so
// two shards' live app windows sit side by side on the same screen, both
// titled "Myne". Measured on myne-md/myne#555: `wr1` failed 3/3 attempts with
// "matched 2 windows", then passed 3/3 isolated. The paragraph that used to
// stand here claimed the opposite — one display per worker — which is true of
// no runner in this repo; every `e2e-*.sh` starts one X server per CONTAINER,
// never per worker.
//
// So the name match is only the first half. The second half is ownership: the
// caller hands over its driver pid (`AppSession.driverPid`, also the process
// group id — driver → WebKitWebDriver → app all live under it), and a candidate
// window counts only when its `_NET_WM_PID` is that group or one of its
// descendants, walked through /proc. A sibling shard's window is then someone
// else's by construction rather than a count to argue with, and taking `[0]`
// from an unscoped list is never on the table. Without a pid the lookup keeps
// the old exactly-1 behaviour, so a caller that cannot know its owner still
// fails loud rather than resizing a stranger.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Tauri window's title (`src-tauri/tauri.conf.json` -> `app.windows[0].title`).
 *  Anchored so a note titled "Myne something" in the app cannot widen the match —
 *  the search is over WINDOW names, but the title bar tracks the document on some
 *  platforms and the anchor costs nothing. */
const WINDOW_NAME_RE = "^Myne$";

/** Raised instead of a bare exec failure so a missing binary reads as what it is:
 *  the harness image is behind `e2e/Dockerfile`, not the app misbehaving. */
class XdotoolUnavailable extends Error {}

function xdotool(args: readonly string[]): string {
  try {
    return execFileSync("xdotool", args, { encoding: "utf8", timeout: 10_000 });
  } catch (e) {
    // Structural, not `NodeJS.ErrnoException`: the E2E tsconfig does not pull in
    // the Node global namespace, and a cast to a name it cannot resolve is a
    // type error rather than a nicety.
    const code = (e as { code?: unknown }).code;
    if (code === "ENOENT") {
      throw new XdotoolUnavailable(
        "xdotool is not installed on this seat. It is baked into `e2e/Dockerfile`; " +
          "a container built from an older image will not have it. Rebuild " +
          "(`./scripts/e2e-buildrun.sh` without --skip-build rebuilds the app, not " +
          "the image — use `docker build -f e2e/Dockerfile`).",
      );
    }
    throw e;
  }
}

/**
 * The X window id of the app's toplevel window.
 *
 * Fails by name when the match set is not exactly one, because both directions
 * are real failures that would otherwise be silent: zero means the app's window
 * is not mapped yet (or the title changed and this file did not), and more than
 * one means the caller would be driving a window it did not choose.
 *
 * `driverPid` scopes the match to windows owned by this session (see the header:
 * a full-suite display holds every shard's window). Candidates whose
 * `_NET_WM_PID` is outside the driver's process group are someone else's and
 * are dropped before the count, so a sibling shard next door reads as "not
 * mine" rather than as an error. Omit it only where the owner is unknowable;
 * the unscoped exactly-1 assertion stays as the fallback.
 */
export function appWindowId(driverPid?: number): string {
  const out = xdotool(["search", "--name", WINDOW_NAME_RE]);
  const ids = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const ours =
    driverPid === undefined
      ? ids
      : ids.filter((id) => {
          const pid = windowPid(id);
          return pid !== null && isInGroup(pid, driverPid);
        });
  if (ours.length !== 1) {
    throw new Error(
      `xdotool search --name ${WINDOW_NAME_RE} matched ${ids.length} windows on ` +
        `this display, ${ours.length} of them owned by driver pid ${String(driverPid)}, ` +
        `expected exactly 1. Zero means the app window is not mapped yet or its ` +
        `title no longer matches (tauri.conf.json app.windows[0].title); more than ` +
        `one of MINE means the regex is catching something this scenario must not ` +
        `drive; the rest belong to sibling shards sharing this display and are ` +
        `correctly ignored.`,
    );
  }
  return ours[0]!;
}

/** A window's owning pid via `_NET_WM_PID`, or null when the window vanished
 *  between the search and this query or its client never set one. */
function windowPid(id: string): number | null {
  let out: string;
  try {
    out = execFileSync("xdotool", ["getwindowpid", id], {
      encoding: "utf8",
      timeout: 10_000,
    }) as string;
  } catch {
    return null;
  }
  const pid = Number(out.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Is `pid` the group itself or one of its descendants? Walked up through
 *  /proc rather than via `pgrep -P`, so the lookup needs no binary beyond
 *  xdotool itself. A pid that vanished mid-walk answers false: a window without
 *  a live owner is not one this scenario may drive. */
function isInGroup(pid: number, group: number): boolean {
  let current = pid;
  // The ppid field sits right after the comm parenthetical in /proc/<pid>/stat,
  // which is why the parse anchors on the LAST ") " — comm itself may contain
  // parens and spaces, and splitting the whole line on spaces misattributes
  // both (the shape that silently matched the wrong process).
  for (let i = 0; i < 64; i += 1) {
    if (current === group) return true;
    if (current <= 1) return false;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${current}/stat`, "utf8") as string;
    } catch {
      return false;
    }
    const after: string = stat.slice(stat.lastIndexOf(") ") + 2);
    const ppid = Number(after.split(" ")[1]);
    if (!Number.isInteger(ppid) || ppid <= 0) return false;
    current = ppid;
  }
  return false;
}

/** Resize the app's toplevel window. Returns the window id it acted on. */
export function resizeAppWindow(width: number, height: number, driverPid?: number): string {
  const id = appWindowId(driverPid);
  xdotool(["windowsize", id, String(width), String(height)]);
  return id;
}

/**
 * Ask the app's toplevel window to close, the way a title-bar X does.
 *
 * NOT `xdotool windowclose`, which is the obvious tool and the wrong one — see
 * `wm-delete-window.py`'s header for the measurement. In one line: it calls
 * XDestroyWindow, so GTK never raises `delete-event`, tao never raises
 * `CloseRequested`, and the app's close handler never runs. The app still exits,
 * which is what makes the mistake expensive: every outward sign of a graceful
 * close is there and none of the graceful behaviour happened.
 *
 * This sends the real `WM_PROTOCOLS` / `WM_DELETE_WINDOW` ClientMessage through
 * a ~20-line ctypes Xlib script, which needs no window manager and no package
 * the image does not already have.
 */
export function closeAppWindow(driverPid?: number): string {
  const id = appWindowId(driverPid);
  const script = join(dirname(fileURLToPath(import.meta.url)), "wm-delete-window.py");
  try {
    execFileSync("python3", [script, id], { encoding: "utf8", timeout: 10_000 });
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "ENOENT") {
      throw new Error(
        "python3 is not on this seat. It is present in the E2E image (and in the " +
          "CI E2E steps' base image); a container built from an older image may " +
          "not have it. Rebuild: docker build -f e2e/Dockerfile -t myne-e2e e2e",
      );
    }
    throw e;
  }
  return id;
}
