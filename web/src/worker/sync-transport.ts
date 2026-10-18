// The synchronous HTTP bridge the wasm sync transport calls
// (phase3-web-client task 35).
//
// # Why synchronous, and why that is allowed here
//
// `SyncTransport::request` in `myne-core` is a **blocking** call — the sync
// engine is written around that, and making it async would be a refactor across
// the whole engine. A browser cannot block on `fetch`, but a **dedicated Worker
// may make a synchronous `XMLHttpRequest`**, and that is exactly the shape the
// trait wants: the call blocks this thread, the main thread is untouched, and no
// promise crosses the wasm boundary.
//
// Measured in Chromium before committing to it, because the spec forbids setting
// `responseType` on a synchronous request in a *document* and the worker
// exemption is the whole question: sync XHR with `responseType = "arraybuffer"`
// returned 200 with bytes intact, and a sync POST carrying a body and a request
// header round-tripped. Binary survives, which is what a transport moving
// ciphertext needs.
//
// # This is the browser's HTTP stack, not a reimplementation
//
// Same connection pool, same CORS enforcement, same TLS and same trust store as
// `fetch`. Nothing here parses HTTP; that is the entire reason for using the
// browser's client rather than a socket, and it is why there is no certificate
// pinning to be found (a page cannot pin — `decisions.md` 2026-07-26 records
// that as permanent, not deferred).
//
// # Blocking the Worker is a real cost, and it is bounded
//
// While a request is in flight this Worker answers nothing — no note read, no
// prefs write. That is acceptable because sync runs as a cycle rather than
// alongside interactive work, and because the alternative (an async trait) buys
// the same concurrency the OPFS layer already gives up for the same reason. It
// is NOT acceptable without a timeout: a hung server would wedge the Worker
// permanently, so every request carries one.

/** Mirrors the native transports' socket deadline — `SOCKET_TIMEOUT` in
 *  `core/src/plugins/sync/http_transport.rs` (180 s). `rustls_transport.rs` and
 *  `socks5.rs` both import that one constant, so this is the only other copy of
 *  the number that exists.
 *
 *  **It said 60 s, and had said so since the native value moved to 180 s.** The
 *  native deadline was raised for a reason worth repeating, because the same
 *  reasoning applies here: the budget has to cover the SERVER's work, not just
 *  the transfer (myne-md/myne#222). The old 60 s was justified as "comfortably
 *  exceeds any legitimate response (incl. a 64 MiB blob)" — a transfer-time
 *  budget, and the reason a first sync of a large vault failed: the client had
 *  finished writing long before the deadline and was waiting on a server still
 *  applying blobs. A push is the one request class whose server-side cost scales
 *  with what we sent, and on this client there is no other deadline to fall back
 *  on: the Rust `SOCKET_TIMEOUT` is `#[cfg(not(target_arch = "wasm32"))]`, so a
 *  browser request has exactly one clock and this is it.
 *
 *  `scripts/check-sync-timeout-drift.mjs` compares the two numbers, because
 *  nothing did: `wasm32` means the Rust constant is not in the browser's build
 *  at all, so no compiler, test or guard in this tree could see the pair drift. */
const REQUEST_TIMEOUT_MS = 180_000;

export interface SyncHttpResponse {
  status: number;
  /** Response body. Always a `Uint8Array`, empty when there is none. */
  body: Uint8Array;
  /** Response headers as a JSON `[name, value][]` — the shape the Rust side
   *  parses. Lower-cased names, because header names are case-insensitive and
   *  the callers match on them literally. */
  headers: string;
}

/**
 * Install the bridge on `globalThis.__myneSyncHttp`, before the wasm module is
 * instantiated. One explicit global, like `__myneOpfs`: a missing installation
 * surfaces as an immediate `is not a function` rather than as a silently wrong
 * result.
 */
export function installSyncHttpBridge(): void {
  (globalThis as unknown as Record<string, unknown>).__myneSyncHttp = {
    request(method: string, url: string, headersJson: string, body: Uint8Array): SyncHttpResponse {
      const xhr = new XMLHttpRequest();
      // `false` = synchronous. Legal in a dedicated Worker; this file must never
      // be imported from the main thread, where the same call would freeze the
      // page and the browser would (rightly) warn about it.
      xhr.open(method, url, false);
      xhr.responseType = "arraybuffer";
      xhr.timeout = REQUEST_TIMEOUT_MS;

      const headers = JSON.parse(headersJson) as [string, string][];
      for (const [name, value] of headers) xhr.setRequestHeader(name, value);

      // A GET/HEAD must send no body at all — some servers reject one, and
      // `send(new Uint8Array(0))` is not the same as `send(null)`.
      const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
      // `send` throws on a network failure, a CORS rejection or a timeout. It is
      // deliberately NOT caught here: the Rust side maps a thrown call to
      // `TransportError::Network`, and swallowing it into a fake status would
      // turn a failed request into a served one.
      //
      // The copy is required rather than defensive: `body` is a view into wasm
      // linear memory, and `send` may retain it past the call.
      xhr.send(hasBody ? new Uint8Array(body).buffer : null);

      const raw = xhr.response as ArrayBuffer | null;
      return {
        status: xhr.status,
        body: raw ? new Uint8Array(raw) : new Uint8Array(0),
        headers: JSON.stringify(parseResponseHeaders(xhr.getAllResponseHeaders())),
      };
    },
  };
}

/** `getAllResponseHeaders()` returns one CRLF-delimited string. */
function parseResponseHeaders(raw: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of raw.split("\r\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    out.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
  }
  return out;
}
