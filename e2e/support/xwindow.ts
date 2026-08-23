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
// # The window is found by NAME, and the name is asserted to be unique
//
// `xdotool search --name` matches a regex against every window on the display,
// and the harness runs up to MYNE_E2E_SHARDS file-workers in parallel — but
// each on its OWN Xvfb display (`xvfb-run -a` allocates a free one), so a match
// set larger than one is not another scenario's app. It means the regex is
// catching something else on this display, and resizing "something else" would
// leave the scenario measuring a window it never touched. So the count is
// checked rather than assumed, and `[0]` is never taken from a longer list.

import { execFileSync } from "node:child_process";
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
 * one means the regex is catching something this scenario must not resize.
 */
export function appWindowId(): string {
  const out = xdotool(["search", "--name", WINDOW_NAME_RE]);
  const ids = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (ids.length !== 1) {
    throw new Error(
      `xdotool search --name ${WINDOW_NAME_RE} matched ${ids.length} windows on ` +
        `this display, expected exactly 1. Zero means the app window is not mapped ` +
        `yet or its title no longer matches (tauri.conf.json app.windows[0].title); ` +
        `more than one means this scenario would be resizing a window it did not ` +
        `choose.`,
    );
  }
  return ids[0]!;
}

/** Resize the app's toplevel window. Returns the window id it acted on. */
export function resizeAppWindow(width: number, height: number): string {
  const id = appWindowId();
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
export function closeAppWindow(): string {
  const id = appWindowId();
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
