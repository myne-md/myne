// Failures that never reach React (phase3-web-client task 114).
//
// # The gap
//
// `RootErrorBoundary` catches render exceptions. That is one of three ways this
// client breaks. A rejected seam call, a Worker error, or a throw in an event
// handler reaches **nothing but the console** — so on the web client, where the
// user cannot open a devtools panel and read it back to a maintainer, the
// observable surface for those is a page that stopped working with no
// explanation and no code.
//
// # What this deliberately does NOT do
//
// It does not render, does not navigate, and does not swallow. It records the
// most recent bounded failure CODE and notifies subscribers; the surface that
// shows it is `FailClosedError`'s, and the decision to show it belongs to the
// screen, not to a global handler that has no idea what the user is in the
// middle of. A handler that force-navigated on the first stray rejection would
// throw away work over a failure the app had already recovered from.
//
// # Bounded codes only
//
// Never a message string, never a stack. `window.onerror` hands us arbitrary
// text from arbitrary code — on this client it can quote a path, a note title or
// a credential in scope — and the whole point of the diagnostic block is that it
// carries what a maintainer can act on and nothing else.

/** The closed set of global failure classes. Extending it is a deliberate edit,
 *  which is what keeps the code bounded. */
export const GLOBAL_FAILURE_CODES = [
  "uncaught-error",
  "unhandled-rejection",
  "worker-fatal",
] as const;

export type GlobalFailureCode = (typeof GLOBAL_FAILURE_CODES)[number];

let last: GlobalFailureCode | null = null;
const listeners = new Set<(code: GlobalFailureCode) => void>();

/** The most recent global failure, or `null`. */
export function lastGlobalFailure(): GlobalFailureCode | null {
  return last;
}

/** Subscribe; returns an unsubscribe. */
export function onGlobalFailure(fn: (code: GlobalFailureCode) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Record a failure. Exported so the Worker fault path (task 82) can report one
 *  through the same channel rather than inventing a second. */
export function reportGlobalFailure(code: GlobalFailureCode): void {
  last = code;
  for (const fn of [...listeners]) {
    try {
      fn(code);
    } catch {
      // A listener that throws must not stop the others, and must not re-enter
      // this function — which is exactly what an uncaught throw here would do.
    }
  }
}

/** Test-only reset, so one test's recorded failure cannot leak into the next. */
export function resetGlobalFailureForTest(): void {
  last = null;
  listeners.clear();
}

/**
 * Install the window-level handlers. Idempotent — a second call is a no-op, so
 * a hot reload or a double-invoked effect cannot register two.
 */
let installed = false;
export function installGlobalFailureHandlers(target: Window = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener("error", () => {
    // The event carries `message`, `filename`, `lineno` and the `Error` itself.
    // None of them travel: a bounded code is what is recorded.
    reportGlobalFailure("uncaught-error");
  });
  target.addEventListener("unhandledrejection", () => {
    reportGlobalFailure("unhandled-rejection");
  });
}
