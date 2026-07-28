// Web seam — `event` (phase3-web-client task 25).
//
// The desktop side is Tauri's event bus: the Rust core `emit`s and the WebView
// listens. Here the emitter is `HostCtx::emit` inside the wasm Worker
// (`web/wasm/src/host.rs`), which posts an `{ id: 0, kind: "event" }` message;
// `web/src/worker/host.ts` demultiplexes those to subscribers. This module is
// the seam-shaped face of that subscription.
//
// The types come from the desktop seam by TYPE-ONLY import — erased at compile
// time, so no Tauri code reaches this bundle, while the two implementations stay
// shape-identical by construction rather than by two hand-written declarations
// that drift. `conformance.ts` is what would catch it if they did.

import type { EventCallback, UnlistenFn } from "../../../src/platform/event";
import { subscribe } from "../worker/host";

export type { EventCallback, UnlistenFn };

/**
 * Subscribe to a backend event.
 *
 * # Two shape details that are contract, not preference
 *
 * **The handler receives Tauri's envelope**, `{ event, id, payload }`, not the
 * bare payload — because `src/` call sites destructure `({ payload })`. The
 * Worker carries only `event` + `payload`, so `id` is synthesised. It is a
 * *listener* id in Tauri (used to unlisten), and nothing in `src/` reads it, so
 * a monotonic counter is a faithful stand-in rather than a fake value with a
 * meaning attached.
 *
 * **Errors thrown by a handler are swallowed by the transport**, not here — see
 * `host.ts`. That is deliberate there: an exception escaping the Worker's
 * `onmessage` surfaces as `onerror`, which the host reads as the Worker dying.
 * A buggy UI listener must not look like a crashed vault.
 *
 * Returns synchronously-resolvable detach, matching Tauri: `listen` is called
 * from React effects whose cleanup awaits the result.
 */
let nextListenerId = 1;

export function listen<T>(
  event: string,
  handler: EventCallback<T>,
  _options?: unknown,
): Promise<UnlistenFn> {
  const id = nextListenerId++;
  const off = subscribe(event, (payload) => {
    handler({ event, id, payload: payload as T });
  });
  return Promise.resolve(off);
}
