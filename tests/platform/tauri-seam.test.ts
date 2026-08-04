// The Tauri implementation as the first subject of the platform-seam contract
// (phase3-web-client task 3).
//
// The contract lives in `seam-contract.ts` and knows nothing about Tauri. This
// file supplies the two things it needs: a programmable transport standing in
// for Tauri IPC, and the statement of which seam operations desktop supports
// (all of them — desktop is the reference platform; the web subject in task 25
// is where `supports` starts having holes).
//
// Mocking at `@tauri-apps/*` rather than at `src/platform/*` is deliberate:
// the seam modules are the CODE UNDER TEST. Mocking them would test the mock.
// Because `src/platform/*` re-exports from `@tauri-apps/*`, the mock lands
// exactly one layer below the seam, which is where a real IPC boundary sits.

import { vi } from "vitest";
import type { SeamOperation } from "../../src/platform/unsupported";
import { runSeamContract, type SeamModules } from "./seam-contract";

// ── programmable transport ────────────────────────────────────────────────
// One recorder shared by every mocked Tauri entry point. `resolveWith` /
// `rejectWith` program the NEXT call (and every call after it, until reset),
// which is all the contract needs — each assertion programs then calls once.

type Outcome = { kind: "resolve"; value: unknown } | { kind: "reject"; err: unknown };

const state: {
  outcome: Outcome;
  calls: unknown[][];
  subscribers: Map<string, Set<(e: { event: string; payload: unknown }) => void>>;
} = {
  outcome: { kind: "resolve", value: undefined },
  calls: [],
  subscribers: new Map(),
};

function record(...args: unknown[]): Promise<unknown> {
  state.calls.push(args);
  return state.outcome.kind === "resolve"
    ? Promise.resolve(state.outcome.value)
    : Promise.reject(state.outcome.err);
}

/** Tauri's `listen`: registers a handler, resolves the detach function. */
function fakeListen(
  name: string,
  handler: (e: { event: string; payload: unknown }) => void,
): Promise<() => void> {
  state.calls.push([name]);
  let set = state.subscribers.get(name);
  if (!set) {
    set = new Set();
    state.subscribers.set(name, set);
  }
  set.add(handler);
  return Promise.resolve(() => {
    set.delete(handler);
    if (set.size === 0) state.subscribers.delete(name);
  });
}

class FakeChannel<T> {
  onmessage: ((m: T) => void) | null = null;
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => record(...args),
  Channel: FakeChannel,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: fakeListen }));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: (...args: unknown[]) => record(...args),
  join: (...args: unknown[]) => record(...args),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ destroy: (...args: unknown[]) => record(...args) }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: fakeListen }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => record(...args),
  save: (...args: unknown[]) => record(...args),
  confirm: (...args: unknown[]) => record(...args),
  message: (...args: unknown[]) => record(...args),
  ask: (...args: unknown[]) => record(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => record(...args),
  openPath: (...args: unknown[]) => record(...args),
  revealItemInDir: (...args: unknown[]) => record(...args),
}));
// Write only — the seam stopped re-exporting `readText`/`clear` with myne#379.
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...args: unknown[]) => record(...args),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: (...args: unknown[]) => record(...args),
  onOpenUrl: (h: (urls: string[]) => void) => fakeListen("deep-link", () => h([])),
}));

// ── the subject ───────────────────────────────────────────────────────────

/**
 * Desktop implements every seam operation. Stated as an explicit exhaustive
 * list rather than a wildcard so that adding an operation to `SeamOperation`
 * without deciding its desktop status is a type error, not a silent hole.
 */
const DESKTOP_SUPPORTS: ReadonlySet<SeamOperation> = new Set<SeamOperation>([
  "core.invoke",
  "core.Channel",
  "event.listen",
  "dialog.open",
  "dialog.save",
  "dialog.confirm",
  "opener.openUrl",
  "opener.openPath",
  "opener.revealItemInDir",
  "path.appDataDir",
  "path.join",
  "window.destroy",
  "window.isFullscreen",
  "webviewWindow.listen",
  "clipboard.writeText",
  "deepLink.onOpenUrl",
]);

runSeamContract({
  name: "tauri",
  supports: DESKTOP_SUPPORTS,
  reset: () => {
    state.outcome = { kind: "resolve", value: undefined };
    state.calls = [];
    state.subscribers.clear();
  },
  load: async (): Promise<SeamModules> => {
    const [core, event, dialog, opener, path, win, webviewWindow, clipboardManager, deepLink] =
      await Promise.all([
        import("../../src/platform/core"),
        import("../../src/platform/event"),
        import("../../src/platform/dialog"),
        import("../../src/platform/opener"),
        import("../../src/platform/path"),
        import("../../src/platform/window"),
        import("../../src/platform/webviewWindow"),
        import("../../src/platform/clipboardManager"),
        import("../../src/platform/deepLink"),
      ]);
    return {
      core,
      event,
      dialog,
      opener,
      path,
      window: win,
      webviewWindow,
      clipboardManager,
      deepLink,
    } as unknown as SeamModules;
  },
  program: {
    resolveWith: (value) => {
      state.outcome = { kind: "resolve", value };
    },
    rejectWith: (err) => {
      state.outcome = { kind: "reject", err };
    },
    calls: () => state.calls,
    emit: (name, payload) => {
      state.subscribers.get(name)?.forEach((h) => h({ event: name, payload }));
    },
    subscriberCount: (name) => state.subscribers.get(name)?.size ?? 0,
  },
});
