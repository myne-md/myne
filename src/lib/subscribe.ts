// Subscribing to a backend event without leaking a rejected promise.
//
// # Why this exists
//
// Four call sites had independently written the same six lines: call `listen`,
// stash the returned unlisten function, and if the component unmounted before
// the promise settled, call it immediately instead. All four wrote it as
// `void listen(...).then(fn)`, and none of them wrote the rejection handler.
//
// On desktop that was invisible. `listen` resolves as soon as the Tauri IPC
// bridge is up, which it is before any React tree mounts, so the rejected branch
// never ran in practice. It ran in exactly two places: jsdom, where there is no
// bridge at all, and — the one that matters — **the web client**, where `listen`
// is a Worker message subscription that genuinely can fail if the worker died or
// has not booted. There the dropped rejection becomes an unhandled
// `Promise` rejection, and `global-failure.ts` escalates unhandled rejections
// into the fatal screen. A status indicator that could not subscribe would have
// taken the whole app down.
//
// # What a failed subscription means, and why it is not fatal
//
// Every caller here is a *freshness* mechanism layered on something that already
// works: the three hooks poll on an interval and use the event only to skip the
// wait, and the snapshot indicator is a transient toast. Losing the subscription
// degrades them — updates arrive on the poll interval instead of immediately —
// but it does not make any of them wrong. Escalating that to a fatal screen
// would be trading a real, working app for a hypothetical inconsistency.
//
// So a failed subscription warns and continues. It is deliberately NOT silent:
// `SnapshotFailedIndicator` subscribes to an *error* event and has no poll to
// fall back on, so for that one caller a lost subscription means an error the
// user should have seen never appears. There is nothing better it can do at
// runtime, but the warning is what makes it diagnosable rather than a mystery.

import { listen, type UnlistenFn } from "../platform/event";

/**
 * Subscribe to one or more backend events, returning a synchronous disposer.
 *
 * The disposer is safe to call before any subscription has settled — a handle
 * that arrives after disposal is unlistened on arrival rather than retained,
 * which is the race every hand-written copy of this was already guarding and is
 * the reason it cannot simply be `await`ed in an effect.
 */
export function subscribeToEvents(
  events: readonly string[],
  handler: () => void,
): () => void {
  let disposed = false;
  const unlisteners: UnlistenFn[] = [];

  for (const event of events) {
    listen(event, handler).then(
      (fn) => {
        // Disposed while the subscription was in flight: release it now rather
        // than holding a handle nothing will ever call.
        if (disposed) fn();
        else unlisteners.push(fn);
      },
      (err: unknown) => {
        // Handled — the point of this function. See the header for why a lost
        // subscription is a degradation rather than a failure.
        console.warn(`[myne] could not subscribe to "${event}":`, err);
      },
    );
  }

  return () => {
    disposed = true;
    for (const fn of unlisteners) fn();
    unlisteners.length = 0;
  };
}
