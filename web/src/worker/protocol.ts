// The main-thread ↔ Worker message protocol (phase3-web-client task 11).
//
// Everything the vault touches — the wasm core, every OPFS read and write, the
// ~0.5 s Argon2id derivation — lives in one dedicated Worker. That is not a
// preference: `createSyncAccessHandle` is dedicated-worker-only in every
// browser and Safari implements no `createWritable` at all, so there is no
// other place the storage layer can run. It usefully takes the derivation off
// the main thread as well.
//
// The protocol is deliberately small and deliberately explicit about failure,
// because the Worker's death is total: if it dies, the vault is unreachable and
// every in-flight call must be told, not left pending. A promise that never
// settles is the worst outcome available here — it presents as a spinner with
// no cause and no recovery short of the user guessing to reload.
//
// So there are exactly three failure shapes, and they are distinguishable:
//
//   `unsupported` — this platform cannot do this, ever. A modelled state, not
//                   an error; the UI's answer is to omit the affordance
//                   (task 27), and this exists for the paths gating cannot
//                   reach (a stale deep link, a replayed workspace command).
//   `error`       — the command ran and failed. Carries the backend's own
//                   error value **verbatim**, because every caller in `src/`
//                   pattern-matches on Rust error enums (`src/types/`).
//   `fatal`       — the Worker is gone: a wasm panic (wasm32 is `panic=abort`,
//                   so the instance traps permanently and every later call
//                   hits `unreachable`), an `onerror`, an `onmessageerror`, or
//                   the browser reclaiming it under memory pressure. Task 82
//                   owns the recovery; this type is what makes the distinction
//                   expressible at all.

/** A request from the page to the Worker. */
export type WorkerRequest =
  | {
      /** Correlation id. Monotonic per page; the Worker echoes it back. */
      id: number;
      kind: "invoke";
      cmd: string;
      args?: unknown;
    }
  /**
   * An invoke whose bulk content is a `File` the WORKER reads
   * (phase3-web-client task 67).
   *
   * The file travels as a `File` handle, not as bytes. A `File` is
   * structured-cloneable and the clone is a handle to the browser's blob store —
   * so the page never allocates the content at all, and "large files stream
   * rather than buffering whole in the main thread" is satisfied by the page
   * never holding them in the first place, rather than by chunking.
   *
   * The alternative — reading the file on the page and sending
   * `{ kind: "bytes", bytes: number[] }` — turns a 64 MiB attachment into a
   * 64-million-element JS array and then a ~200 MB JSON string. That is the
   * shape this message exists to avoid.
   */
  | {
      id: number;
      kind: "invoke-file";
      cmd: string;
      /** Everything EXCEPT the content (e.g. the display filename). */
      args?: unknown;
      file: File;
    };

/** Anything the Worker sends back. */
export type WorkerResponse =
  | { id: number; kind: "ok"; value: unknown }
  | { id: number; kind: "error"; error: unknown }
  | { id: number; kind: "unsupported"; operation: string }
  | { id: number; kind: "fatal"; code: string; where?: string }
  /** Backend→UI push, correlated to no request. */
  | { id: 0; kind: "event"; event: string; payload: unknown };

/**
 * A fatal Worker outcome.
 *
 * `code` is a **bounded static label**, never a formatted panic payload: a
 * panic message can carry a path, a note id, or a fragment of plaintext, and
 * this value reaches the page — where it can be read by devtools, by any
 * extension with devtools access, and by whoever the user screenshots it to
 * (`src-tauri/CLAUDE.md`, secret-handling logging discipline). `where` is
 * `file:line`, which is bounded by construction.
 */
export class WorkerFatalError extends Error {
  readonly code: string;
  readonly where?: string;

  constructor(code: string, where?: string) {
    super(`vault worker stopped: ${code}${where ? ` (${where})` : ""}`);
    // Pinned literal, not `constructor.name`: the page and the Worker are
    // separate bundles, so class identity does not survive the boundary.
    this.name = "WorkerFatalError";
    this.code = code;
    this.where = where;
  }
}

/** `true` when `e` is a {@link WorkerFatalError}, across bundle boundaries. */
export function isWorkerFatal(e: unknown): e is WorkerFatalError {
  return e instanceof Error && e.name === "WorkerFatalError";
}

/** Bounded reasons the Worker is unusable. Not a free string. */
export const FATAL_CODES = {
  /** A Rust panic inside wasm. The instance traps permanently. */
  wasmPanic: "wasm-panic",
  /** `Worker.onerror` — an uncaught exception in the Worker's own script. */
  workerError: "worker-error",
  /** `Worker.onmessageerror` — a message that could not be structured-cloned. */
  messageError: "worker-message-error",
  /** The Worker went away without saying why (typically memory pressure). */
  terminated: "worker-terminated",
  /** The Worker never announced itself within the startup budget (host-side). */
  startupTimeout: "worker-startup-timeout",
  /**
   * `init()` failed inside the Worker: the `.wasm` did not fetch, compile, or
   * instantiate. Distinct from {@link FATAL_CODES.startupTimeout}, which is the
   * host giving up without hearing anything — this one is the Worker reporting
   * a definite failure, and the two want different operator advice.
   */
  startupFailed: "wasm-startup-failed",
  /**
   * The CSPRNG self-check failed: `crypto.getRandomValues` is unreachable or
   * returned two identical 32-byte draws.
   *
   * A fatal startup outcome rather than a warning, and deliberately so. Every
   * AEAD nonce and every fresh key in the product draws from that source
   * (`protocol/CLAUDE.md`: *"Nonce reuse is catastrophic … there is no
   * counter-mode fallback"*), so a vault that opened without it would encrypt
   * its next write with a nonce this client cannot vouch for. Refusing before
   * the unlock screen is the only correct answer.
   */
  csprngUnavailable: "csprng-unavailable",
} as const;

export type FatalCode = (typeof FATAL_CODES)[keyof typeof FATAL_CODES];

/**
 * The one event the Worker emits on its own behalf rather than on the backend's:
 * "the wasm instance is live and the CSPRNG answered".
 *
 * Namespaced under `myne:` like the window events in `src/lib/`, so it cannot
 * collide with a backend event name forwarded through the same channel.
 */
export const WORKER_READY = "myne:worker-ready";
