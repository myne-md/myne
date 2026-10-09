// The story host: installs a fake `window.__TAURI_INTERNALS__` so the desktop
// platform seam (`src/platform/*` → `@tauri-apps/api/*`) runs UNMODIFIED and
// every `invoke(cmd, args)` routes to canned fixture data instead of Rust.
//
// This is the mechanism `mobile/tests/flow-logic/mock-ipc.ts` and the E2E page
// seat already use, reused here rather than reinvented. The seam is the app's
// one host boundary, so a fake host is the whole of "mount the real app with no
// backend".
//
// Installing the global does two things beyond routing calls: it makes
// `HAS_TAURI` (src/lib/app-window.ts) true, and it lets `@tauri-apps/api/*`
// modules that read the global directly (`convertFileSrc`, event
// `transformCallback`) work without a real webview.

import type { Fixture } from "../types";

/** The four members of `window.__TAURI_INTERNALS__` the app's seam touches. */
export interface FakeInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  transformCallback(cb: unknown): unknown;
  unregisterCallback(): void;
  convertFileSrc(path: string, protocol?: string): string;
  /** Read by `@tauri-apps/api/window`'s `getCurrentWindow()`. */
  metadata: { currentWindow: { label: string } };
  /** Dispatch a backend→UI event to every handler registered for `name`.
   *  The real host emits from Rust; the fake one needs a way in, and this is
   *  what a story showing an event-driven state calls (myne-md/myne#845). */
  emitEvent(name: string, payload?: unknown): void;
}

/**
 * What an unhandled command resolves to.
 *
 * `[]` rather than `null` or `undefined`, deliberately: the editor mount
 * hydrates several list-returning commands (vault-indices, archived-folders, …)
 * whose `for…of`/spread throws "not iterable" on a `null`, and an object-shaped
 * consumer just reads `undefined` off `[]`. This is the same benign default the
 * mobile mock-ipc uses, and the reason a story mounts even when its fixture did
 * not anticipate every command the surface reads.
 */
const BENIGN_DEFAULT: readonly unknown[] = Object.freeze([]);

function makeInternals(fixture: Fixture | undefined): FakeInternals {
  const handlers = fixture?.handlers ?? {};
  // Backend→UI event subscriptions. The seam's `listen()` passes the handler
  // through `transformCallback`, which the fake host returns unchanged, so the
  // function itself arrives here and can be held. Rebuilt per install, so
  // swapping the fixture drops every listener from the previous story.
  const eventHandlers = new Map<string, Set<(event: unknown) => void>>();
  return {
    invoke: (cmd, args) => {
      // `@tauri-apps/api/event`'s listen/unlisten route through `invoke`, so
      // the fake host answers them here rather than falling through to the
      // benign default. Registration is SYNCHRONOUS inside `invoke`, which is
      // what lets a parent effect emit in the same commit a child subscribed.
      if (cmd === "plugin:event|listen") {
        const name = String((args ?? {}).event ?? "");
        const handler = (args ?? {}).handler;
        if (typeof handler === "function") {
          const set = eventHandlers.get(name) ?? new Set();
          set.add(handler as (event: unknown) => void);
          eventHandlers.set(name, set);
        }
        return Promise.resolve(0);
      }
      if (cmd === "plugin:event|unlisten") return Promise.resolve(undefined);
      const handler = handlers[cmd];
      try {
        return Promise.resolve(handler ? handler(args ?? {}) : BENIGN_DEFAULT);
      } catch (err) {
        return Promise.reject(err);
      }
    },
    emitEvent: (name, payload) => {
      const set = eventHandlers.get(name);
      if (set === undefined) return;
      const event = { event: name, id: 0, payload };
      for (const handler of [...set]) handler(event);
    },
    transformCallback: (cb) => cb,
    unregisterCallback: () => undefined,
    convertFileSrc: (path, protocol = "asset") => `${protocol}://localhost/${path}`,
    // `getCurrentWindow()` reads this before it constructs a Window, so a screen
    // whose mount effect reaches the window API needs it present.
    metadata: { currentWindow: { label: "main" } },
  };
}

/** Installs the fake internals. Idempotent; call again to swap the fixture. */
export function installStoryHost(fixture?: Fixture): void {
  (globalThis as { __TAURI_INTERNALS__?: FakeInternals }).__TAURI_INTERNALS__ =
    makeInternals(fixture);
  // `@tauri-apps/api/event`'s unlisten path reads `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`.
  // Without it, every event-subscribing surface rejects on unmount, which makes
  // Vitest exit non-zero even though the render succeeded. The host owns this,
  // not each story: a per-story workaround is a second fake host by another name.
  (
    globalThis as { __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener(): void } }
  ).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
}

/** Alias that reads better at a call site that is swapping mid-session. */
export function setStoryFixture(fixture: Fixture | undefined): void {
  installStoryHost(fixture);
}

/**
 * Fire a backend→UI event at whatever the current fixture's host has
 * subscribed. A story that renders an event-driven state wraps its surface in
 * an effect that calls this after mount; see `notes.tsx`'s `EmitStoryEvent`.
 */
export function emitStoryEvent(name: string, payload?: unknown): void {
  const internals = (globalThis as { __TAURI_INTERNALS__?: FakeInternals })
    .__TAURI_INTERNALS__;
  internals?.emitEvent(name, payload);
}
