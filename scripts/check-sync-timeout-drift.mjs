#!/usr/bin/env node
// The sync request deadline is written twice, in two languages, and the two
// must be one number (audit 2026-10-18 R0.3, fixed 2026-10-19).
//
// # The failure this prevents
//
// `core/src/plugins/sync/http_transport.rs` holds the native socket deadline,
// `SOCKET_TIMEOUT`, at 180 s since myne-md/myne#222. `rustls_transport.rs` and
// `socks5.rs` both import that one constant, so there is exactly one other place
// the number is written: `web/src/worker/sync-transport.ts`'s
// `REQUEST_TIMEOUT_MS`, which drives the synchronous `XMLHttpRequest` the wasm
// sync engine blocks on. It said **60 s**, and its comment said it "mirrors the
// native transports' socket deadline (`SOCKET_TIMEOUT`, 60 s)" — a comment that
// was true when written and had been false since #222 raised the native value for
// the reason the whole change was about: the deadline must cover the SERVER's
// work, not just the transfer, or the first sync of a large vault dies while the
// client is waiting on a server still applying blobs.
//
// Nothing in this tree could see the pair drift, and that is the part worth
// keeping:
//
//   - `SOCKET_TIMEOUT` is `#[cfg(not(target_arch = "wasm32"))]`, so it is not in
//     the browser build at all. No compiler compares it with a JavaScript
//     constant, because the JavaScript constant is the only one that exists
//     there.
//   - `check-embed-layout-drift.mjs` exists for this exact shape (one fact
//     written in two languages) and covers a different pair.
//   - A wrong deadline is not a build error, a type error or a test failure. It
//     is a wall-clock difference that appears as "sync is slow" on a large vault
//     and nowhere else.
//
// # Why browser 180 s AND not the other way round
//
// The native value is the one myne-md/myne#222 fixed and justified, and it is
// paired with `orchestrator::PUSH_CHUNK_MAX_BLOBS`, which is what bounds the
// server-side cost it is sized for; moving the browser DOWN would have required
// arguing that the same chunk bound costs less on a browser, which is not true.
// The cost of the larger value is stated in the native constant's own doc: a
// genuinely dead server hangs one cycle for 3 min instead of 1, and
// `loop_control`'s backoff already treats that class as transient.
//
// # What it does NOT cover, stated so it is not mistaken for more
//
// Only the one number. The keep-alive behaviour, the response-size ceiling
// (`MAX_SYNC_RESPONSE_BYTES`) and the retry/backoff policies are separate facts
// with separate owners, and widening this into a second transport comparison
// would recreate the "one fact, two hand-maintained copies" problem it exists to
// catch. It also says nothing about the SSE/poke deadlines
// (`POKE_RETRY_CAP_MS`, `AWARENESS_RETRY_CAP_MS`), which are retry cadences
// rather than request deadlines and have no native counterpart.
//
// Zero dependencies, hand-runnable: node scripts/check-sync-timeout-drift.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const JS_FILE = "web/src/worker/sync-transport.ts";
const RUST_FILE = "core/src/plugins/sync/http_transport.rs";

/** `const REQUEST_TIMEOUT_MS = 180_000;` — numeric separators allowed. */
export const JS_RE = /const\s+REQUEST_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/;
/** `pub(crate) const SOCKET_TIMEOUT: Duration = Duration::from_secs(180);` */
export const RUST_RE =
  /pub\(crate\)\s+const\s+SOCKET_TIMEOUT\s*:\s*Duration\s*=\s*Duration::from_secs\((\d+)\)\s*;/;

/** The milliseconds a source declares, or `null` when the shape is not there. */
export function parseJsTimeout(source) {
  const m = JS_RE.exec(source);
  return m === null ? null : Number(m[1].replace(/_/g, ""));
}

/** The seconds a source declares, scaled to milliseconds. */
export function parseRustTimeout(source) {
  const m = RUST_RE.exec(source);
  return m === null ? null : Number(m[1]) * 1000;
}

/** `null` when the two agree, else the sentence naming both. */
export function compareTimeouts(jsMs, rustMs) {
  if (jsMs === null || rustMs === null) return null;
  if (jsMs === rustMs) return null;
  return (
    `the sync request deadline disagrees: ${JS_FILE} says ${jsMs} ms, ${RUST_FILE} ` +
    `says ${rustMs} ms.\n` +
    `  The native value is the one myne-md/myne#222 sized and justified, and it is ` +
    `paired with\n  the chunk bound that bounds the server's work; the browser's is the ` +
    `only clock a\n  wasm request has, so the smaller of the two silently truncates the ` +
    `larger one's intent.`
  );
}

function main() {
  const failures = [];

  /** The declared value, or a recorded failure naming the file. */
  function declared(file, parse, shape) {
    let text;
    try {
      text = readFileSync(join(repoRoot, file), "utf8");
    } catch {
      failures.push(`${file}: not found. This guard is looking at the wrong tree.`);
      return null;
    }
    const value = parse(text);
    if (value === null) {
      // Silence would be the wrong answer: a guard that cannot find its input has
      // stopped checking, and that is exactly when it prints ok.
      failures.push(
        `${file}: no \`${shape}\` declaration found. If the constant was renamed or ` +
          `moved, teach this guard the new shape rather than deleting it, or the two ` +
          `deadlines go back to drifting with every gate green.`,
      );
      return null;
    }
    return value;
  }

  const jsMs = declared(JS_FILE, parseJsTimeout, "const REQUEST_TIMEOUT_MS = <n>;");
  const rustMs = declared(
    RUST_FILE,
    parseRustTimeout,
    "pub(crate) const SOCKET_TIMEOUT: Duration = Duration::from_secs(<n>);",
  );

  const disagreement = compareTimeouts(jsMs, rustMs);
  if (disagreement !== null) failures.push(disagreement);

  if (failures.length > 0) {
    console.error("sync-timeout drift: FAILED");
    for (const message of failures) console.error(`  - ${message}`);
    process.exit(1);
  }

  console.log(`sync-timeout drift: ok (${jsMs / 1000} s on both sides)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
