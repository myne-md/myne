// @vitest-environment jsdom
//
// jsdom, unlike the Tauri subject's plain node environment: the web seam calls
// real browser APIs — `window.confirm`, `window.open`, `navigator.clipboard`,
// `document.createElement("input")`. That asymmetry is the point rather than an
// inconvenience; the desktop seam reaches a mocked `@tauri-apps/*`, the web seam
// reaches the platform.
//
// The platform-seam contract, run against the WEB implementation
// (phase3-web-client task 25).
//
// The second subject. `tests/platform/tauri-seam.test.ts` was the first, and the
// point of having both is stated in `seam-contract.ts`: the desktop E2E suite is
// not dual-driven against a browser because "it is the same `src/` tree, only
// the seam differs" — and that premise is only a premise until both
// implementations are held to one assertion suite.
//
// **This file adds no assertions.** If it did, the two subjects would be tested
// differently and the premise would be unverified again.
//
// # What is mocked, and what deliberately is not
//
// The transport under the web seam is `web/src/worker/host.ts` — Worker
// lifecycle, request correlation, the four fatal routes. That module has its own
// dedicated tests (`tests/web/worker-host.test.ts`) driving a fake `Worker`
// through every death path. Here it is mocked, because this suite is about the
// SEAM's behaviour — does `invoke` forward verbatim, does a rejection propagate
// unwrapped, does `listen` detach — not about the transport's.
//
// Mocking at `../../web/src/worker/host` rather than at the seam modules is the
// same discipline the Tauri subject follows (it mocks `@tauri-apps/*`, not
// `src/platform/*`): mock the thing UNDER the seam, so the seam itself is the
// code under test.

import { vi } from "vitest";
import { runSeamContract, type SeamModules } from "./seam-contract";
import type { SeamOperation } from "../../src/platform/unsupported";

let nextResolve: unknown;
let nextReject: unknown;
let hasReject = false;
const recorded: unknown[][] = [];
const subscribers = new Map<string, Set<(p: unknown) => void>>();

// ── the web seam has SEVERAL things underneath it, not one ──────────────────
//
// The contract's subject model says "program the transport under the seam", and
// on desktop there is exactly one: Tauri IPC. On web that is not true, and the
// difference is structural rather than incidental — `invoke` and events go to
// the wasm Worker, while `dialog`, `clipboard` and `opener` go to **browser
// APIs**, because those are the operations a browser answers natively and
// routing them through the Worker would be pure ceremony.
//
// So this subject programs all of them, recording into the same `recorded`
// array. The contract stays unchanged and unaware, which is the property that
// makes it a shared contract; what varies is what "the transport" means, and
// that is the subject's job to know.
function programBrowserPlatform(): void {
  vi.stubGlobal("confirm", (msg?: string) => {
    recorded.push([msg, ...(pendingConfirmExtra ?? [])]);
    return nextResolve as boolean;
  });
  vi.stubGlobal("alert", (msg?: string) => {
    recorded.push([msg]);
  });
  vi.stubGlobal("open", (url?: string) => {
    recorded.push([url]);
    return null;
  });
  vi.stubGlobal("navigator", {
    // Write only — `readText` left the seam with myne#379, and the web arm is
    // where that removal is least controversial: page content cannot be granted
    // clipboard read in Firefox at all.
    clipboard: {
      writeText: async (t: string) => {
        recorded.push([t]);
      },
    },
  });
  // `dialog.open` builds an `<input type="file">` and awaits its `change`.
  // jsdom's `click()` cannot produce a file, so the click is intercepted and a
  // programmed FileList is delivered — the same shape a real pick produces.
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const el = realCreate(tag);
    if (tag === "input") {
      (el as HTMLInputElement).click = () => {
        recorded.push([pendingOpenOptions]);
        Object.defineProperty(el, "files", { value: pendingFiles, configurable: true });
        el.dispatchEvent(new Event(pendingFiles === null ? "cancel" : "change"));
      };
    }
    return el;
  }) as typeof document.createElement);
}

/** Extra args the contract passes alongside a confirm message. */
let pendingConfirmExtra: unknown[] | null = null;
/** What the file picker "returns"; `null` models a cancelled pick. */
let pendingFiles: unknown = null;
/** The options `dialog.open` was called with, recorded for the call assertion. */
let pendingOpenOptions: unknown = undefined;

vi.mock("../../web/src/worker/host", () => ({
  invoke: (...args: unknown[]) => {
    recorded.push(args);
    if (hasReject) return Promise.reject(nextReject);
    return Promise.resolve(nextResolve);
  },
  subscribe: (event: string, handler: (p: unknown) => void) => {
    const set = subscribers.get(event) ?? new Set();
    set.add(handler);
    subscribers.set(event, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) subscribers.delete(event);
    };
  },
  terminate: () => {},
  fatalCause: () => null,
}));

/**
 * Operations the web seam implements.
 *
 * Everything NOT listed is asserted to reject with `PlatformUnsupportedError` —
 * omission is a claim the contract checks, not a way to skip an operation.
 *
 * The four absences are each a browser fact, not a backlog item:
 *   `dialog.save`          — no API grants a page an arbitrary write path.
 *   `opener.openPath`      — a page cannot hand a local path to the OS.
 *   `opener.revealItemInDir` — likewise, and there is no file manager to reveal in.
 *   `window.destroy`       — `window.close()` is ignored for a tab the script
 *                            did not open, and silently-ignored is worse than
 *                            refused (see `web/src/platform/window.ts`).
 *   `deepLink.onOpenUrl`   — a page cannot register an OS URL-scheme handler.
 *   `path.appDataDir`      — the vault root is an OPFS handle tree with no path.
 */
const SUPPORTS: ReadonlySet<SeamOperation> = new Set<SeamOperation>([
  "core.invoke",
  "core.Channel",
  "event.listen",
  "dialog.open",
  "dialog.confirm",
  "opener.openUrl",
  "path.join",
  "window.isFullscreen",
  "webviewWindow.listen",
  "clipboard.writeText",
]);

runSeamContract({
  name: "web",
  reset: () => {
    nextResolve = undefined;
    nextReject = undefined;
    hasReject = false;
    pendingConfirmExtra = null;
    pendingFiles = null;
    pendingOpenOptions = undefined;
    recorded.length = 0;
    subscribers.clear();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    programBrowserPlatform();
  },
  load: async (): Promise<SeamModules> => ({
    core: await import("../../web/src/platform/core"),
    event: await import("../../web/src/platform/event"),
    // `dialog.open`'s options are recorded by wrapping, because the options
    // never reach a transport on web — the picker is built from them locally.
    dialog: await (async () => {
      const m = await import("../../web/src/platform/dialog");
      return {
        ...m,
        open: (opts?: unknown) => {
          pendingOpenOptions = opts;
          return m.open(opts as never);
        },
      };
    })(),
    opener: await import("../../web/src/platform/opener"),
    diagnostics: await import("../../web/src/platform/diagnostics"),
    path: await import("../../web/src/platform/path"),
    window: await import("../../web/src/platform/window"),
    webviewWindow: await import("../../web/src/platform/webviewWindow"),
    clipboardManager: await import("../../web/src/platform/clipboardManager"),
    deepLink: await import("../../web/src/platform/deepLink"),
  }),
  program: {
    resolveWith: (value) => {
      nextResolve = value;
      hasReject = false;
      // A programmed string/array is what the file picker should yield; `null`
      // models a cancelled pick. `dialog.open` returns FILE NAMES on web (a page
      // never receives a path), so the contract's `/tmp/pick.md` is delivered as
      // the picked file's name — same string, and the difference in what it
      // MEANS is documented on `web/src/platform/dialog.ts`.
      pendingFiles =
        typeof value === "string" ? [{ name: value }] : Array.isArray(value) ? value : null;
    },
    rejectWith: (err) => {
      nextReject = err;
      hasReject = true;
    },
    calls: () => recorded,
    emit: (name, payload) => {
      for (const h of subscribers.get(name) ?? []) h(payload);
    },
    subscriberCount: (name) => subscribers.get(name)?.size ?? 0,
  },
  supports: SUPPORTS,
});
