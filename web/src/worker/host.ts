// The main thread's half of the Worker transport (phase3-web-client task 11).
//
// `web/src/platform/core.ts` is a two-line re-export over this file. Everything
// interesting is here so the seam module stays what the seam is supposed to be:
// a substitution point, not a place logic hides.
//
// # The one invariant
//
// **Every returned promise settles.** A promise that never settles is the worst
// failure available on this path: it presents as a spinner with no cause, no
// error boundary reached, and no recovery short of the user guessing to reload.
// So the Worker's death — by panic, by `onerror`, by `onmessageerror`, by the
// browser reclaiming it under memory pressure, or by never starting — rejects
// every in-flight call and every subsequent one, rather than leaving them
// hanging. That is why `WorkerFatalError` exists as a distinct type.
//
// # What the main thread deliberately does NOT do
//
// It does not touch OPFS, does not hold key material, and does not run wasm. It
// serialises arguments, posts, and resolves. The ~0.5 s Argon2id derivation runs
// in the Worker, so the unlock screen keeps painting while it does — the reason
// the acceptance criterion is "main thread never blocks on derivation" and not
// "derivation is fast".

import {
  FATAL_CODES,
  isWorkerFatal,
  WORKER_READY,
  WorkerFatalError,
  type FatalCode,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
// The SAME error type the desktop seam throws for an operation the platform
// cannot do (`src/platform/unsupported.ts`), so a call site's `catch` behaves
// identically on both clients. Deliberately not a web-local class.
import {
  PlatformUnsupportedError,
  type SeamOperation,
} from "../../../src/platform/unsupported";

/**
 * How long the Worker gets to announce itself before the host gives up.
 *
 * Generous on purpose. It covers fetching and compiling a ~128 KiB `.wasm` on a
 * cold cache over a slow link, on a device that may be a phone. Too short and a
 * first visit on bad network is indistinguishable from a broken build; the cost
 * of too long is only that a genuinely broken build takes longer to say so.
 */
const STARTUP_TIMEOUT_MS = 30_000;

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Listener registered through the seam's `event` module (task 26 wires it up). */
export type EventListener = (payload: unknown) => void;

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
/**
 * Set once the Worker is known dead, and never cleared by this module.
 *
 * Recovery is a re-*creation*, not a reset: the keys died with the instance, so
 * the correct next state is the locked unlock screen with a fresh Worker. Task
 * 82 owns that teardown. Keeping the reason here means every call after the
 * death rejects with the original cause instead of a second, less informative
 * failure.
 */
let fatal: WorkerFatalError | null = null;

let nextId = 1;
const waiters = new Map<number, Waiter>();
const listeners = new Map<string, Set<EventListener>>();

/**
 * Fail every in-flight call and mark the Worker dead.
 *
 * Called from four places — a `fatal` message, `onerror`, `onmessageerror`, and
 * the startup timeout — because all four mean the same thing to a caller: this
 * instance will not answer. Collapsing them into one function is what keeps
 * "some paths reject and some hang" from being possible.
 */
function declareFatal(code: FatalCode | string, where?: string): void {
  if (fatal) return; // first cause wins; a cascade is not new information
  fatal = new WorkerFatalError(code, where);
  for (const waiter of waiters.values()) waiter.reject(fatal);
  waiters.clear();
}

function ensureWorker(): { worker: Worker; ready: Promise<void> } {
  if (fatal) throw fatal;
  if (worker && ready) return { worker, ready };

  // `type: "module"` is required: the wasm-bindgen glue is an ES module, and
  // `--target web` emits `import`/`export`. A classic Worker cannot load it.
  //
  // `new URL(..., import.meta.url)` is the form Vite statically analyses to emit
  // the Worker as its own chunk. A string path would be resolved at runtime
  // against the document, which breaks under any hashed-asset layout.
  const w = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "myne-vault",
  });

  const readyPromise = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      declareFatal(FATAL_CODES.startupTimeout);
      // Resolve rather than reject: callers await `ready` and then check
      // `fatal`, so a rejection here would produce a second unhandled rejection
      // alongside the one each caller already gets.
      resolve();
    }, STARTUP_TIMEOUT_MS);

    w.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      if (message.kind === "event") {
        if (message.event === WORKER_READY) {
          clearTimeout(timer);
          resolve();
          return;
        }
        // A backend→UI push. Delivered to every registered listener; one
        // throwing must not stop the others or kill the message pump.
        for (const listener of listeners.get(message.event) ?? []) {
          try {
            listener(message.payload);
          } catch {
            // A listener's own bug. Swallowed here deliberately: the alternative
            // is an exception inside `onmessage`, which would surface as
            // `onerror` and be mistaken for the Worker dying.
          }
        }
        return;
      }

      if (message.kind === "fatal") {
        clearTimeout(timer);
        declareFatal(message.code, message.where);
        resolve();
        return;
      }

      const waiter = waiters.get(message.id);
      if (!waiter) return; // already settled by a fatal, or a duplicate reply
      waiters.delete(message.id);

      switch (message.kind) {
        case "ok":
          waiter.resolve(message.value);
          break;
        case "error":
          // Rejected with the backend's own error value, NOT wrapped in an
          // `Error`. Every caller in `src/` pattern-matches on Rust error enums
          // (`src/types/`), and Tauri's `invoke` rejects with the same bare
          // value — wrapping it here would break the shared tree on web only.
          waiter.reject(message.error);
          break;
        case "unsupported":
          // `operation` crossed a structured-clone boundary as a plain string,
          // so the compiler cannot know it still has the IPC shape. Narrowed
          // rather than asserted: an unexpected value falls back to the
          // seam-level operation instead of minting a malformed one.
          waiter.reject(
            new PlatformUnsupportedError(
              message.operation.includes("|")
                ? (message.operation as SeamOperation)
                : "core.invoke",
            ),
          );
          break;
      }
    };

    // An uncaught exception in the Worker's own script. `preventDefault` stops
    // it also surfacing as an unhandled `window.onerror` on the page, where it
    // would read as an application crash rather than a handled Worker fault.
    //
    // The location is captured into `where` — and ONLY the location. An
    // `ErrorEvent` carries `message` too, but a wasm abort's message can contain
    // a formatted panic payload, which may hold a path, a note id, or a fragment
    // of plaintext (`src-tauri/CLAUDE.md`, secret-handling logging discipline).
    // `filename:lineno` is bounded by construction, which is exactly what
    // `protocol.ts` specifies `where` to be.
    //
    // Without this the fault is COMPLETELY silent: `preventDefault()` also
    // suppresses the browser's own console report, so a dead Worker gave a bare
    // `worker-error` and nothing else — no file, no line, nothing to search for.
    // Found the hard way while debugging this very path.
    w.onerror = (event) => {
      event.preventDefault();
      clearTimeout(timer);
      const at =
        event instanceof ErrorEvent && event.filename
          ? `${event.filename}:${event.lineno ?? 0}`
          : undefined;
      declareFatal(FATAL_CODES.workerError, at);
      resolve();
    };

    // A message that could not be structured-cloned. Rare, and always a bug in
    // what we posted rather than in the Worker — but it means a reply was lost,
    // so a caller is waiting on something that will never arrive.
    w.onmessageerror = () => {
      clearTimeout(timer);
      declareFatal(FATAL_CODES.messageError);
      resolve();
    };
  });

  worker = w;
  ready = readyPromise;
  return { worker: w, ready: readyPromise };
}

/**
 * The web implementation of `invoke`.
 *
 * Same signature and same call shape as `@tauri-apps/api/core`'s: `(cmd, args)`,
 * resolving to the command's return value and rejecting with the backend's own
 * error value. That identity is the whole contract of `src/platform/core.ts` —
 * `src/` is compiled unchanged for both clients.
 */
export async function invoke<T = unknown>(cmd: string, args?: unknown): Promise<T> {
  const { worker: w, ready: readyPromise } = ensureWorker();
  await readyPromise;
  // Re-checked AFTER the await: the Worker may have died while starting, or
  // between two calls.
  if (fatal) throw fatal;

  const id = nextId++;
  const request: WorkerRequest = { id, kind: "invoke", cmd, args };
  return new Promise<T>((resolve, reject) => {
    waiters.set(id, { resolve: resolve as (v: unknown) => void, reject });
    try {
      w.postMessage(request);
    } catch (e) {
      // `postMessage` throws only if `args` is not structured-cloneable — a
      // caller bug, not a Worker fault, so the Worker is NOT declared dead.
      waiters.delete(id);
      reject(e);
    }
  });
}

/**
 * `invoke`, with a `File` whose CONTENT the Worker reads (task 67).
 *
 * Same correlation, same envelope handling, same fatal semantics as
 * {@link invoke} — the only difference is that the bulk content travels as a
 * `File` handle rather than inside `args`. The page therefore never allocates
 * the file's bytes: `postMessage` clones a handle into the browser's blob
 * store, and `web/src/worker/worker.ts` does the read.
 *
 * Not part of `src/platform/core.ts`. The shared tree has one call shape
 * (`invoke(cmd, args)`) and must keep having one; this is the web seam's own
 * tool, used by `web/src/platform/filePicker.ts` and nothing else.
 */
export async function invokeWithFile<T = unknown>(
  cmd: string,
  args: unknown,
  file: File,
): Promise<T> {
  const { worker: w, ready: readyPromise } = ensureWorker();
  await readyPromise;
  if (fatal) throw fatal;

  const id = nextId++;
  const request: WorkerRequest = { id, kind: "invoke-file", cmd, args, file };
  return new Promise<T>((resolve, reject) => {
    waiters.set(id, { resolve: resolve as (v: unknown) => void, reject });
    try {
      w.postMessage(request);
    } catch (e) {
      waiters.delete(id);
      reject(e);
    }
  });
}

/**
 * Start the Worker now, without making a call (phase3-web-client task 68).
 *
 * The Worker's startup is not cheap and it is not on the page's critical path:
 * fetching and compiling the wasm module, installing the bridges and running the
 * CSPRNG self-check all happen off-thread. Left to `ensureWorker`'s lazy trigger
 * it begins at the FIRST `invoke` — which is the boot probe, after React has
 * mounted — so the two costs run one after the other for no reason.
 *
 * Called once from `web/src/main.tsx`, and only AFTER the environment gate has
 * passed: starting a Worker in a browser the gate is about to reject would
 * allocate for a session that is not going to happen.
 *
 * Idempotent, and it never throws — a Worker that dies during startup is
 * recorded as `fatal` exactly as it would be on the lazy path.
 */
export function warmWorker(): void {
  try {
    ensureWorker();
  } catch {
    // `ensureWorker` throws only when a fatal was ALREADY recorded, in which
    // case the first `invoke` reports it. There is nothing to add here, and
    // throwing out of a warm-up would take down the boot it is trying to speed.
  }
}

/** Subscribe to a backend→UI event. Returns the unsubscribe function. */
export function subscribe(event: string, listener: EventListener): () => void {
  ensureWorker();
  const set = listeners.get(event) ?? new Set<EventListener>();
  set.add(listener);
  listeners.set(event, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(event);
  };
}

/** The Worker's fatal cause, or `null` while it is healthy. Read by task 82. */
export function fatalCause(): WorkerFatalError | null {
  return fatal;
}

/**
 * Tear the transport down and forget it.
 *
 * Exported for the tab-lock handoff (task 21) and for tests; task 82's recovery
 * path calls it before creating a replacement. Deliberately does NOT clear
 * `fatal` — the module-level comment on that variable says why.
 */
export function terminate(): void {
  worker?.terminate();
  worker = null;
  ready = null;
  for (const waiter of waiters.values()) {
    waiter.reject(fatal ?? new WorkerFatalError(FATAL_CODES.terminated));
  }
  waiters.clear();
  listeners.clear();
}

// Re-exported so callers can discriminate a dead Worker from a command failure
// without importing two modules.
export { isWorkerFatal, WorkerFatalError };
