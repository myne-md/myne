// Web seam — `core` (phase3-web-client task 11).
//
// The desktop side of this seam (`src/platform/core.ts`) is a straight re-export
// of `@tauri-apps/api/core`. This side routes the identical `(cmd, args)` call
// into the wasm Worker. That symmetry is the contract: `src/` is compiled
// unchanged for both clients, so this module must not wrap, rename, or add an
// argument — a divergence here is a divergence in the one place the seam exists
// to hold identical.
//
// Deliberately thin. All of the transport — Worker lifecycle, the request/reply
// correlation, the four fatal routes, the typed unsupported outcome — lives in
// `../worker/host.ts`, so the seam module stays a substitution point rather than
// a place logic hides from `tests/platform/seam-contract.ts`.

export { invoke } from "../worker/host";

import { lookup } from "./attachment-cache";

/**
 * Streaming sink handed INTO `invoke`, matching `@tauri-apps/api/core`'s shape.
 *
 * Still a shell. Tauri's `Channel` is a *serialisable handle*: it survives the
 * IPC boundary because Tauri assigns it an id and routes backend messages back
 * to the right instance. Reproducing that over `postMessage` means the Worker
 * must recognise a channel argument inside an otherwise-opaque payload and
 * stream to it — which is only worth building against a real streaming command,
 * and the only ones are the export progress channel (`plugin:export|*`, decided
 * absent on web) and `plugin:local-inference|chat_stream` (likewise). So there
 * is nothing on the web client that streams yet.
 *
 * Constructing one is therefore harmless and passing one to `invoke` currently
 * does nothing: `onmessage` is never called. It is NOT made to throw, because
 * the desktop's `Channel` constructor does not throw either and a call site that
 * merely *constructs* one while gated off must not blow up — the typed refusal
 * belongs on the command, which `capability.rs` already gives it.
 */
export class Channel<T> {
  onmessage: ((message: T) => void) | null = null;
}

/**
 * The URL a display surface uses to fetch an attachment's decrypted bytes.
 *
 * Desktop re-exports Tauri's `convertFileSrc`, which emits the per-platform form
 * of the registered `attachment://` custom protocol — derivable from the id with
 * no IO at all. **A browser has no custom protocol**, so the answer is a `blob:`
 * URL minted from bytes the Worker decrypted, and minting is asynchronous while
 * this call is not.
 *
 * That gap is closed one layer down, in `./attachment-cache`: `warm(ids)` runs
 * before a render and `lookup(id)` is the synchronous, total read during it. An
 * id nobody warmed resolves to a same-origin placeholder rather than to `""`
 * (which a browser resolves against the document URL and re-requests the whole
 * app shell for) or to a `data:` URI (which would need the CSP grant this task's
 * criterion forbids widening).
 *
 * The `protocol` argument is accepted and ignored so the signature matches the
 * desktop seam exactly; `attachment` is the only protocol this client uses, and
 * an id is all the cache needs.
 */
export function convertFileSrc(filePath: string, _protocol?: string): string {
  return lookup(filePath);
}
