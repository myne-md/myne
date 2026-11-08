// The dedicated Worker that hosts the wasm core (phase3-web-client task 11).
//
// Everything the vault touches runs here: the wasm module, every OPFS read and
// write (task 17), and the ~0.5 s Argon2id derivation. See `protocol.ts` for the
// message shapes and `host.ts` for the main-thread half.
//
// # Why the startup handshake is a message and not an exported promise
//
// The main thread cannot await this module's initialisation directly — a Worker
// is not an importable module from the outside. So startup is a protocol: this
// file posts exactly one `ready` or one `fatal`, and `host.ts` queues every
// `invoke` until one of them arrives. Nothing is dropped and nothing is sent
// into an uninitialised instance.
//
// # What must NOT be here
//
// No `console.*` of any command payload, argument, or error value. Those carry
// note bodies, note ids and filesystem paths — the DENY list in
// `src-tauri/AGENTS.md`'s secret-handling logging discipline applies verbatim,
// and it applies harder here: the browser console is readable by devtools, by
// any extension with devtools access, and is what a user screenshots into a bug
// report. Task 82 owns the diagnostic sink that makes bounded logging possible;
// until it lands, the correct amount of logging is none.

import init, {
  build_info,
  csprng_self_check,
  install_panic_hook,
  install_sync_transport,
  invoke as wasmInvoke,
  invoke_with_bytes as wasmInvokeWithBytes,
  sync_awareness_deliver,
  sync_poke_target,
  sync_signal,
  sync_tick,
  vault_recovering_ttl_tick,
} from "../../wasm/pkg/myne_web_wasm.js";
import { installOpfsBridge } from "./opfs";
import { installSyncHttpBridge } from "./sync-transport";
import { installAttachmentUrlBridge } from "./attachment-url";
import { startSyncLoop } from "./sync-loop";
import {
  FATAL_CODES,
  type WorkerRequest,
  type WorkerResponse,
  WORKER_READY,
} from "./protocol";

/** Post a response to the page. Typed so a malformed shape is a compile error. */
function reply(message: WorkerResponse): void {
  self.postMessage(message);
}

/**
 * Requests that arrived before `init()` resolved.
 *
 * A Worker starts receiving messages the moment it is constructed, which is
 * before this module has finished importing — so without a queue the first
 * `invoke` of a session would hit an undefined wasm instance. `host.ts` also
 * queues on its side; both are needed, because the two queues close different
 * windows (before `new Worker` returns, and between that and `ready`).
 */
const pending: WorkerRequest[] = [];
let started = false;

/**
 * Cadence of the `Slot::Recovering` deadline tick, matching `RECOVERING_TICK`
 * in `myne-core` (myne-md/myne#758).
 *
 * The deadline itself is a timestamp comparison, so this only decides how
 * promptly an already-expired recovery session is dropped; a coarser interval
 * delays the drop, it never extends the deadline.
 */
const VAULT_RECOVERING_TTL_TICK_MS = 5_000;

/**
 * Called BY the wasm panic hook (task 82) — see `entry.rs::install_panic_hook`.
 *
 * Exposed on `globalThis` because that is what wasm-bindgen's `extern "C"`
 * import resolves against inside a Worker, and because a plain function is the
 * only thing guaranteed to still work at that moment: the instance calling it is
 * already doomed, so anything routed back through a wasm export would be calling
 * into a module about to become unreachable.
 *
 * It posts and returns. No cleanup, no re-init attempt, no retry — the main
 * thread owns the Worker's lifecycle, and a dying instance trying to manage its
 * own replacement is how one fault becomes two.
 *
 * `location` is `file:line` from `file!()`/`line!()`. The panic PAYLOAD is
 * deliberately not passed: it is arbitrary text from arbitrary code and can
 * carry a note id or a note body, both DENY-listed.
 */
(globalThis as unknown as Record<string, unknown>).reportWasmPanic = (
  location: string,
): void => {
  reply({ id: 0, kind: "fatal", code: FATAL_CODES.wasmPanic, where: location });
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (!started) {
    pending.push(request);
    return;
  }
  void handle(request);
};

async function handle(request: WorkerRequest): Promise<void> {
  try {
    // The envelope is built in Rust and always well-formed (see `outcome.rs`),
    // so this parse cannot fail on a healthy instance. It is still guarded,
    // because the alternative to guarding is an unhandled rejection that
    // presents as a hung promise on the page.
    // The file is READ HERE, not on the page (task 67). `request.file` is a
    // handle into the browser's blob store; the content is materialised in this
    // Worker and handed to wasm as one `Uint8Array`, so the main thread never
    // allocates the attachment at all.
    const raw =
      request.kind === "invoke-file"
        ? await wasmInvokeWithBytes(
            request.cmd,
            serialiseArgs(request.args),
            new Uint8Array(await request.file.arrayBuffer()),
          )
        : await wasmInvoke(request.cmd, serialiseArgs(request.args));
    reply(fromEnvelope(request.id, JSON.parse(raw)));
  } catch {
    // Reached only if the wasm instance trapped — `invoke` is declared never to
    // throw. `panic = "abort"` means the instance is permanently unusable from
    // here on, so this is reported as `fatal` and not as a per-call error: the
    // page must tear the Worker down, not retry into a corpse.
    //
    // The caught value is deliberately NOT forwarded. A panic payload can carry
    // a path, a note id, or a fragment of plaintext.
    reply({ id: request.id, kind: "fatal", code: FATAL_CODES.wasmPanic });
  }
}

/**
 * The argument payload as JSON, matching what Tauri's IPC would have carried.
 *
 * `undefined` becomes `""` rather than `"null"` so the Rust side can distinguish
 * "no arguments" from "the argument is literally null" without a second flag.
 */
function serialiseArgs(args: unknown): string {
  return args === undefined ? "" : JSON.stringify(args);
}

/** Map the Rust [`Outcome`] envelope onto the wire protocol. */
function fromEnvelope(id: number, envelope: unknown): WorkerResponse {
  const e = envelope as Record<string, unknown>;
  switch (e.outcome) {
    case "ok":
      return { id, kind: "ok", value: e.value };
    case "error":
      return { id, kind: "error", error: e.error };
    case "unsupported":
      return { id, kind: "unsupported", operation: String(e.operation) };
    // `notported` and `badargs` are Rust-side classes with no separate wire
    // kind: from the page's point of view both are "the call failed, and here
    // is a structured reason", which is exactly `error`. They stay DISTINCT
    // from `unsupported` — that one drives permanent affordance omission (task
    // 27), and a missed port must never be mistaken for a product decision.
    case "notported":
      return {
        id,
        kind: "error",
        error: { kind: "NotPortedToWeb", command: e.command },
      };
    case "badargs":
      return {
        id,
        kind: "error",
        error: { kind: "BadArgs", command: e.command, detail: e.detail },
      };
    default:
      // An envelope shape this build does not know: a glue/`.wasm` version
      // skew. Surfaced as an error naming the tag rather than silently dropped.
      return {
        id,
        kind: "error",
        error: { kind: "UnknownEnvelope", outcome: e.outcome ?? null },
      };
  }
}

/**
 * Bring the wasm instance up, then drain whatever queued while it was starting.
 *
 * The CSPRNG check is a **startup gate**, not a diagnostic. `getrandom`'s
 * `custom` hook is resolved at link time, so a missing registration cannot get
 * this far — but a registration that links and then throws (no secure context,
 * a hostile `crypto` object) would otherwise first surface as a failed write,
 * long after the user typed a password. Every nonce in the product comes from
 * that source (`protocol/AGENTS.md`: "Nonce reuse is catastrophic … there is no
 * counter-mode fallback"), so a vault must not be openable without it.
 */
async function start(): Promise<void> {
  try {
    // Before `init()`.
    //
    // Not because wasm-bindgen resolves the namespace at instantiation — it
    // does NOT. Checked against the generated glue rather than assumed: each
    // binding emits `globalThis.__myneOpfs.<method>(…)` inline, so the lookup
    // happens **per call**. Installing afterwards would therefore also work, as
    // long as it landed before the first vault operation.
    //
    // It goes first anyway, because "as long as it lands before the first
    // operation" is a race nobody should have to reason about. The Worker
    // announces `ready` at the end of this function and the page starts sending
    // commands the moment it sees that; putting the install ahead of everything
    // means there is no ordering to get wrong, and a missing bridge fails at
    // startup rather than at the first note read.
    installOpfsBridge();
    // The sync transport's bridge, same placement and the same reasoning
    // (phase3-web-client task 35). Synchronous XHR, which only a dedicated
    // Worker may issue — installing it here also documents where that
    // restriction is satisfied.
    installSyncHttpBridge();
    // The object-URL bridge (task 44), same placement and reasoning: the wasm
    // side mints a `blob:` URL for an attachment's decrypted bytes so the plain-
    // text never crosses the wasm boundary as JSON.
    installAttachmentUrlBridge();

    await init();

    // The panic hook, first thing after the module exists (task 82). Under
    // `panic = "abort"` an instance is permanently unusable afterwards — every
    // later call traps — so the hook runs at the one moment the location is
    // still knowable, and the alternative is an infinite spinner with no visible
    // cause.
    //
    // Installed BEFORE `install_sync_transport` and the CSPRNG gate on purpose:
    // those are the first wasm calls that can panic, and a hook installed after
    // them would miss exactly the startup failures hardest to diagnose.
    install_panic_hook();

    // After `init()`, unlike the JS bridges above: this one is a wasm export, so
    // it cannot be called until the module exists. It must still land before any
    // sync command — `build_transport` answers `https` through this factory, and
    // without it a sync attempt fails as `BadRequest`, a startup bug wearing a
    // network error's clothes.
    install_sync_transport();

    if (!csprng_self_check()) {
      // No vault work has happened yet, so there is nothing to unwind — this is
      // the safe moment to refuse.
      reply({
        id: 0,
        kind: "fatal",
        code: FATAL_CODES.csprngUnavailable,
      });
      return;
    }

    started = true;

    // The sync loop starts here — AFTER the csprng gate and before `ready`, so
    // the page never sees a Worker that answers commands but is not ticking.
    // It is idempotent and cheap while idle: the timer mostly decides `Idle`,
    // and the poke stream backs off hard when there is no endpoint or no token
    // (the ordinary state of a browser that has not enrolled yet).
    // The three exports are handed over rather than imported by `sync-loop.ts`:
    // this file is the ONLY permitted importer of the wasm glue
    // (`check-platform-seam`), because a second import is a second instance and
    // therefore a second copy of `root_key`.
    startSyncLoop({
      tick: sync_tick,
      signal: sync_signal,
      pokeTarget: sync_poke_target,
      // The received-frame sink: the awareness reader hands each opaque `data:`
      // payload to the wasm inbox, and never parses it. The endpoint and token
      // come through `sync_poke_target` above.
      awarenessFrame: sync_awareness_deliver,
    });

    // The `Slot::Recovering` deadline (myne-md/myne#758, audit lead NV09).
    //
    // Every other client drives it from a Rust timer; the Worker has neither
    // threads nor a Rust timer, so this interval is its driver. That is the same
    // split `sync_loop` documents for the sync tick. It has to exist here rather than
    // only on the recovery screen: `recover_with_phrase` populates the slot and
    // the user can close that screen, and an expired session must still be
    // dropped while a locked vault sits behind it.
    //
    // The cadence matches `RECOVERING_TICK` in `myne-core`; a slower interval
    // only delays noticing a session that has already passed its deadline.
    //
    // The `.catch` is required by the promise type, not by a failure this code
    // expects: `entry.rs` states that nothing there throws, and a Rust panic
    // aborts the whole instance instead of rejecting. So a rejection here means
    // the instance is gone, which the next `invoke` reports as `fatal`, and there
    // is nothing this timer could add. Re-reporting it through the console would
    // break the logging discipline at the top of this file.
    //
    // What the user can see is on the other side of the boundary, where the
    // decision lives: a `bail_if_expired` that drops the session records a
    // `vault_locked` event with `reason = "recovering_ttl"`, so the drop is never
    // silent and this timer never has to describe it.
    setInterval(() => {
      void vault_recovering_ttl_tick().catch(() => {});
    }, VAULT_RECOVERING_TTL_TICK_MS);

    // `build_info()` is parsed rather than forwarded raw so a malformed value
    // fails here, in the handshake, instead of somewhere downstream.
    const info = JSON.parse(build_info()) as { crate_version?: string };
    reply({
      id: 0,
      kind: "event",
      event: WORKER_READY,
      payload: { crateVersion: info.crate_version ?? null },
    });

    for (const request of pending.splice(0)) void handle(request);
  } catch {
    // `init()` failed: the `.wasm` did not fetch, did not compile, or did not
    // instantiate. Nothing recoverable in-place — the page shows the
    // fail-closed surface (task 82).
    reply({ id: 0, kind: "fatal", code: FATAL_CODES.startupFailed });
  }
}

void start();
