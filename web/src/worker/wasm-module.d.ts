// Types for the wasm-bindgen glue at `web/wasm/pkg/` (phase3-web-client task 11).
//
// # Why this is hand-written and not generated
//
// `scripts/build-wasm.sh` passes `--no-typescript` on purpose. A generated
// `.d.ts` would make `pnpm build` depend on having run the wasm build first —
// so a clean clone, and every CI lane that only type-checks, would fail with a
// missing-module error rather than a real diagnostic. `pkg/` is a gitignored
// build artefact; the *type* of its boundary is source, and belongs in the
// repository.
//
// The cost is stated: these signatures are asserted, not derived, so a change to
// an `#[wasm_bindgen]` export in `web/wasm/src/entry.rs` must be mirrored here.
// That is checked rather than trusted — `tests/web/wasm-boundary.test.ts` reads
// `entry.rs` and fails if an export appears, disappears, or changes arity
// without this file moving with it.

declare module "*/wasm/pkg/myne_web_wasm.js" {
  /**
   * Instantiate the module. Resolves once the wasm instance is live.
   *
   * `module_or_path` is optional: the glue defaults to fetching
   * `myne_web_wasm_bg.wasm` relative to its own URL, which is what Vite rewrites
   * and what a plain static server serves as-is.
   */
  export default function init(
    module_or_path?: { module_or_path: string | URL | Request | Response | WebAssembly.Module },
  ): Promise<unknown>;

  /**
   * Answer one `invoke`. Returns the JSON [`Outcome`] envelope as a string, and
   * **never rejects** — see `web/wasm/src/outcome.rs` for why a command failure
   * must not arrive as an exception. A rejection here therefore means the
   * instance is dead, which is what `protocol.ts` maps to `fatal`.
   */
  export function invoke(cmd: string, args_json: string): Promise<string>;

  /**
   * `invoke`, with the bulk content beside the JSON rather than inside it
   * (task 67). `wasm_bindgen` copies the `Uint8Array` into `Vec<u8>` once.
   *
   * Same never-rejects contract as {@link invoke}. Exactly one command accepts
   * a payload; every other name comes back as a `badargs` envelope rather than
   * silently ignoring the bytes.
   */
  export function invoke_with_bytes(cmd: string, args_json: string, bytes: Uint8Array): Promise<string>;

  /** `{"crate_version":"…"}` — the build's identity, for the startup handshake. */
  export function build_info(): string;

  /**
   * Install the browser's sync transport as `myne-core`'s answer for `https`
   * (task 35). Idempotent — the factory slot is a `OnceLock`.
   *
   * Must be called before any sync command: `build_transport` resolves `https`
   * through this factory, so a sync attempt made first fails as `BadRequest`,
   * which reads like a network problem and is not one.
   */
  /** Install the Rust panic hook (task 82). Calls back into
   *  `globalThis.reportWasmPanic(location)` with `file:line` only. */
  export function install_panic_hook(): void;
  export function install_sync_transport(): void;

  /** One scheduler tick; resolves to the action taken (`"idle"`, `"pull"`, …). */
  export function sync_tick(): Promise<string>;

  /** Tell the scheduler something happened (`"local-change"`, `"focus"`, `"poke"`). */
  export function sync_signal(kind: string): void;

  /** `{"endpoint","token"}` JSON for the poke stream, or `undefined` when sync
   *  is not usable yet (no endpoint, or this device is not enrolled). The
   *  awareness reader shares this export (live-collab, collab-client-transport
   *  task 4). */
  export function sync_poke_target(): Promise<string | undefined>;

  /**
   * Deliver one opaque awareness frame the Worker read off `/sync/awareness`
   * (the SSE `data:` payload verbatim, prefix stripped). Stored opaque in the
   * wasm awareness inbox; never parsed. The up-path POST rides `sync_tick`.
   */
  export function sync_awareness_deliver(payload: string): void;

  /**
   * `true` iff two 32-byte CSPRNG draws succeeded and differed. Called once at
   * startup: a `custom`-backend registration that links but throws at runtime
   * would otherwise first surface as a failed *write*, after the user has
   * already unlocked.
   */
  export function csprng_self_check(): boolean;
}
