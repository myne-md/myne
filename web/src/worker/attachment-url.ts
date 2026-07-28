// The Worker-side object-URL bridge (phase3-web-client task 44).
//
// Two functions the wasm core calls to turn decrypted attachment bytes into
// something an `<img src>` accepts. They live here rather than in `web/wasm/`
// for the same reason the OPFS and sync-XHR bridges do: `myne-core` gains no JS
// glue, and this crate's Rust side gains no `web_sys` DOM plumbing it would then
// have to keep in step with.
//
// # Why the bytes stop in the Worker
//
// The alternative — return the bytes and mint on the page — loses twice. The
// outcome envelope is a JSON string (`web/wasm/src/outcome.rs`), so a 64 MiB
// attachment would base64 to ~85 MiB of string to build, copy and parse per
// render; and the decrypted plaintext would then exist in two heaps instead of
// one. `URL.createObjectURL` is available in a dedicated worker, so the `Blob`
// is created next to the plaintext that produced it and a ~50-byte handle is all
// that crosses.
//
// A `blob:` URL minted in a Worker is usable by its page: it is scoped to the
// ORIGIN, not to the realm.

/** The global the wasm bindings resolve, per call, at `globalThis.__myneAttachmentUrl`. */
interface AttachmentUrlBridge {
  mint: (bytes: Uint8Array, contentType: string) => string;
  revoke: (url: string) => void;
}

/**
 * Install the bridge on `globalThis`.
 *
 * Called before `init()` alongside the other bridges. wasm-bindgen resolves
 * `globalThis.__myneAttachmentUrl.<method>` per call rather than at
 * instantiation, so installing later would also work — it goes first for the
 * same reason the others do: "before the first operation" is a race nobody
 * should have to reason about.
 */
export function installAttachmentUrlBridge(): void {
  const bridge: AttachmentUrlBridge = {
    mint(bytes, contentType) {
      // `bytes` is a view onto the wasm linear memory. `Blob` COPIES its input,
      // so the resulting object is independent of the wasm heap — which it must
      // be: the Rust side drops (and zeroizes) its plaintext the moment this
      // returns, and a `Blob` holding a live view would then be reading freed
      // memory or, worse, whatever the allocator put there next.
      //
      // The copy is why an image renders correctly instead of intermittently.
      //
      // Copied EXPLICITLY rather than by handing the view to `Blob`: with
      // cross-origin isolation on (this client requires it — `web/csp.ts` sets
      // COOP/COEP so `SharedArrayBuffer` exists for the sync backoff's
      // `Atomics.wait`), a `Uint8Array` may be backed by a `SharedArrayBuffer`,
      // which `BlobPart` does not accept. `slice()` always yields an
      // `ArrayBuffer`-backed copy, which is the copy this needs anyway.
      const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: contentType });
      return URL.createObjectURL(blob);
    },
    revoke(url) {
      URL.revokeObjectURL(url);
    },
  };
  (globalThis as unknown as { __myneAttachmentUrl: AttachmentUrlBridge }).__myneAttachmentUrl =
    bridge;
}
