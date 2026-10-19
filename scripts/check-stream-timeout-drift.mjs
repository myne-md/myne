#!/usr/bin/env node
// Two cross-repo numbers nothing compared (audit 2026-10-18, Aşama 6 B1+B2):
//
//   B1  the sync stream deadline: the SERVER's SSE heartbeat cadence against the
//       CLIENT's dead-connection read timeout.
//   B2  the blob-fetch window caps: the SERVER's per-batch ceilings against the
//       CLIENT's mirrored window bounds.
//
// # The failures these prevent
//
// B1. `myne-server` emits an SSE comment-line heartbeat on both long-lived
// stream routes, and it declares the cadence twice, in two packages:
// `internal/poke/poke.go` (`DefaultHeartbeatInterval`) and
// `internal/awareness/handler.go` (`DefaultHeartbeat`). The client consumes both
// streams under ONE read timeout, `SSE_READ_TIMEOUT` in
// `core/src/plugins/sync/stream_supervisor.rs`, calibrated in its own doc to
// "two missed 30 s server heartbeats plus margin". Both repos say so in prose and
// neither number is compared with the other. Raise the server heartbeat past the
// client's timeout and a healthy, live stream is torn down every time the gap
// between two heartbeats exceeds it: the client reconnects, the server sees a
// fresh attach, and nothing anywhere reports the cause, so it reads as a flaky
// network. The client's `SSE_READ_TIMEOUT` is the one clock a stream has, so the
// requirement is that it stays ABOVE two missed heartbeats, not merely above one.
//
// B2. The server bounds one batched `POST /sync/blobs` two ways — `MaxBlobFetchIDs`
// and `MaxBlobFetchBytes` in `internal/syncapi/syncapi.go` — and the client mirrors
// both as its fetch window, `FETCH_WINDOW_MAX_BLOBS` and `FETCH_WINDOW_MAX_BYTES` in
// `core/src/plugins/sync/orchestrator.rs`. The id cap REFUSES an over-count with 413
// rather than clamping, so a server id cap that drops BELOW the client's window makes
// every full window a hard failure; a server byte cap that drops below the client's
// makes the server serve a smaller prefix, which is survivable but is not the size
// the client planned for and is a silent throughput regression. Today the two pairs
// agree, and nothing guards either.
//
// # Canonical side, and why
//
// The SERVER's values are canonical in both pairs. They are what the wire actually
// enforces — the heartbeat it emits and the caps it refuses or truncates on — and
// the client can only be sized to them. So a server-side RAISE is safe (the client
// simply never asks for more than its own, smaller window) and is recorded as a
// NOTE rather than a failure, because a future client may want the headroom and a
// guard that fails on the safe direction is one people learn to route around. A
// server-side value BELOW the client's mirror, or a heartbeat the client's timeout
// can no longer cover, is the failure.
//
// # What it does NOT cover, stated so it is not mistaken for more
//
//   - The push window (`PUSH_CHUNK_MAX_BLOBS` / `PUSH_CHUNK_MAX_BYTES` in the same
//     orchestrator file) and the server's push reader (`MaxBlobSize * 4`): a
//     different pair, bounded by the push path's own cost model. Only the fetch
//     pair is compared here.
//   - The client's reconnect backoff (`BACKOFF_START_MS` / `BACKOFF_CAP_MS`) and
//     supervisor tick cadence, the SSE retry caps (`POKE_RETRY_CAP_MS` /
//     `AWARENESS_RETRY_CAP_MS`) and the awareness frame/batch caps
//     (`DefaultQueueCap`, `MaxFrameSize`, ...). Those are cadences and memory
//     bounds with their own owners, not a deadline the other repo mirrors.
//   - Whether the numbers are SENSIBLE, or that a stream actually survives: this
//     compares declared constants, and the live behaviour is the E2E lane's.
//
// Signature, like its neighbours: `myne-server` is a companion repo and is ABSENT
// in CI and in a fresh clone, so this prints what it could not compare rather than
// a verdict. `MYNE_SERVER_DIR` overrides its location; `--require-companion` turns
// the absent branch into a failure for a caller that knows better.
//
// Zero dependencies, hand-runnable: node scripts/check-stream-timeout-drift.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CANDIDATES = (name) => [resolve(ROOT, name), resolve(ROOT, "..", "..", "..", name)];

const SERVER = process.env.MYNE_SERVER_DIR
  ? resolve(process.env.MYNE_SERVER_DIR)
  : (CANDIDATES("myne-server").find((c) => existsSync(join(c, "go.mod"))) ?? CANDIDATES("myne-server")[0]);

// Server side (the companion repo).
const POKE_FILE = join(SERVER, "internal", "poke", "poke.go");
const AWARENESS_FILE = join(SERVER, "internal", "awareness", "handler.go");
const SYNCAPI_FILE = join(SERVER, "internal", "syncapi", "syncapi.go");

// Client side (this repo).
const SUPERVISOR_FILE = "core/src/plugins/sync/stream_supervisor.rs";
const ORCHESTRATOR_FILE = "core/src/plugins/sync/orchestrator.rs";

// --- the named patterns ------------------------------------------------------
// Each is deliberately pinned to the constant's NAME and its declared TYPE or
// package, so a value that is not the value cannot satisfy it. A pattern that
// stops matching is a failure, not a pass (see `declared` below).

/** `const DefaultHeartbeatInterval = 30 * time.Second` */
export const POKE_RE = /const\s+DefaultHeartbeatInterval\s*=\s*(\d+)\s*\*\s*time\.Second\b/;
/** `DefaultHeartbeat      = 30 * time.Second` (inside the package const block) */
export const AWARENESS_RE = /\bDefaultHeartbeat\s*=\s*(\d+)\s*\*\s*time\.Second\b/;
/** `const MaxBlobFetchIDs = 256` */
export const SYNCAPI_IDS_RE = /\bMaxBlobFetchIDs\s*=\s*(\d+(?:\s*\*\s*\d+)*)/;
/** `const MaxBlobFetchBytes = 8 * 1024 * 1024` */
export const SYNCAPI_BYTES_RE = /\bMaxBlobFetchBytes\s*=\s*(\d+(?:\s*\*\s*\d+)*)/;
/** `pub(crate) const SSE_READ_TIMEOUT: Duration = Duration::from_secs(65);` */
export const CLIENT_TIMEOUT_RE =
  /pub\(crate\)\s+const\s+SSE_READ_TIMEOUT\s*:\s*Duration\s*=\s*Duration::from_secs\((\d+)\)/;
/** `const FETCH_WINDOW_MAX_BLOBS: usize = 256;` */
export const CLIENT_BLOBS_RE = /const\s+FETCH_WINDOW_MAX_BLOBS\s*:\s*usize\s*=\s*(\d+(?:\s*\*\s*\d+)*)/;
/** `const FETCH_WINDOW_MAX_BYTES: usize = 8 * 1024 * 1024;` */
export const CLIENT_BYTES_RE = /const\s+FETCH_WINDOW_MAX_BYTES\s*:\s*usize\s*=\s*(\d+(?:\s*\*\s*\d+)*)/;

/** The integer product a source declares, e.g. `8 * 1024 * 1024` -> 8388608. */
export function evalProduct(expr) {
  const factors = expr.split("*").map((f) => Number(f.replace(/_/g, "").trim()));
  if (factors.some((n) => !Number.isFinite(n))) return null;
  return factors.reduce((a, b) => a * b, 1);
}

/** The poke heartbeat in MILLISECONDS, or `null` when the shape is not there. */
export function parsePokeHeartbeat(source) {
  const m = POKE_RE.exec(source);
  return m === null ? null : Number(m[1]) * 1000;
}

/** The awareness heartbeat in MILLISECONDS, or `null`. */
export function parseAwarenessHeartbeat(source) {
  const m = AWARENESS_RE.exec(source);
  return m === null ? null : Number(m[1]) * 1000;
}

/** The client's SSE dead-connection read timeout in MILLISECONDS, or `null`. */
export function parseSseReadTimeout(source) {
  const m = CLIENT_TIMEOUT_RE.exec(source);
  return m === null ? null : Number(m[1]) * 1000;
}

/** The server's `MaxBlobFetchIDs`, or `null`. */
export function parseServerFetchIds(source) {
  const m = SYNCAPI_IDS_RE.exec(source);
  return m === null ? null : evalProduct(m[1]);
}

/** The server's `MaxBlobFetchBytes`, or `null`. */
export function parseServerFetchBytes(source) {
  const m = SYNCAPI_BYTES_RE.exec(source);
  return m === null ? null : evalProduct(m[1]);
}

/** The client's `FETCH_WINDOW_MAX_BLOBS`, or `null`. */
export function parseClientFetchBlobs(source) {
  const m = CLIENT_BLOBS_RE.exec(source);
  return m === null ? null : evalProduct(m[1]);
}

/** The client's `FETCH_WINDOW_MAX_BYTES`, or `null`. */
export function parseClientFetchBytes(source) {
  const m = CLIENT_BYTES_RE.exec(source);
  return m === null ? null : evalProduct(m[1]);
}

// --- the comparisons ---------------------------------------------------------

/**
 * `null` when the client's timeout covers two missed heartbeats, else the
 * sentence naming both numbers. A `null` side is a missing input the caller has
 * already recorded, so it defers rather than printing a second, misleading line.
 */
export function compareStreamTimeout(timeoutMs, heartbeatMs, which) {
  if (timeoutMs === null || heartbeatMs === null) return null;
  // The client's own doc calibrates this to "two missed <heartbeat> plus margin":
  // strictly above twice the cadence, so the margin stays positive.
  if (timeoutMs > heartbeatMs * 2) return null;
  return (
    `the stream read timeout no longer covers two missed heartbeats: ${SUPERVISOR_FILE} says\n` +
    `  SSE_READ_TIMEOUT = ${timeoutMs / 1000} s, but ${which} in the server emits one every ${heartbeatMs / 1000} s,\n` +
    `  so a healthy stream is torn down after ${timeoutMs / 1000} s of silence. The server's cadence is\n` +
    `  canonical: raise SSE_READ_TIMEOUT (it is calibrated to two missed heartbeats plus margin) or\n` +
    `  lower the server heartbeat, and change them together.`
  );
}

/** `null` when the two server heartbeats agree, else the sentence naming both. */
export function compareServerHeartbeats(pokeMs, awarenessMs) {
  if (pokeMs === null || awarenessMs === null) return null;
  if (pokeMs === awarenessMs) return null;
  return (
    `the server's two stream routes emit heartbeats at different cadences, but the client\n` +
    `  detects a dead stream on both with ONE timeout:\n` +
    `    poke              (${POKE_FILE}): ${pokeMs / 1000} s\n` +
    `    awareness (${AWARENESS_FILE}): ${awarenessMs / 1000} s\n` +
    `  They are meant to match (the awareness const's own doc says so). The binding cadence is\n` +
    `  the larger of the two; the client's SSE_READ_TIMEOUT must cover it.`
  );
}

/**
 * `null` when the server's cap is at least the client's window, else the sentence
 * naming both. Fails only on the dangerous direction (server SMALLER): a server
 * cap above the client's window is safe, since the client never asks for more.
 * A `null` side defers to the missing-input failure, as its neighbours do.
 */
export function compareFetchCap(serverValue, clientValue, what) {
  if (serverValue === null || clientValue === null) return null;
  if (serverValue >= clientValue) return null;
  return (
    `${what} is SMALLER on the server than the window the client requests: the server\n` +
    `  caps it at ${serverValue} but the client windows for ${clientValue}. A server that\n` +
    `  refuses or truncates what the client asks for is a hard failure (the id cap rejects\n` +
    `  with 413) or a silent throughput regression (the byte cap serves a smaller prefix).\n` +
    `  The server's value is canonical; raise it to at least ${clientValue} or lower the\n` +
    `  client's window, and change them together.`
  );
}

// --- entry point -------------------------------------------------------------

function main() {
  const failures = [];
  const notes = [];
  let compared = false;
  const fail = (m) => failures.push(m);
  const REQUIRE_COMPANION = process.argv.includes("--require-companion");

  /** The declared value, or a recorded failure naming the file or the shape. */
  function declared(file, parse, shape) {
    let text;
    try {
      text = readFileSync(file.slice(0, 1) === "/" ? file : join(ROOT, file), "utf8");
    } catch {
      fail(`${file}: not found. This guard is looking at the wrong tree.`);
      return null;
    }
    const value = parse(text);
    if (value === null || !Number.isFinite(value)) {
      // Silence would be the wrong answer: a guard that cannot find its input has
      // stopped checking, and that is exactly when it prints ok.
      fail(
        `${file}: no \`${shape}\` declaration found. If the constant was renamed or ` +
          `moved, teach this guard the new shape rather than deleting it, or the two ` +
          `sides go back to drifting with every gate green.`,
      );
      return null;
    }
    return value;
  }

  const serverPresent =
    existsSync(POKE_FILE) && existsSync(AWARENESS_FILE) && existsSync(SYNCAPI_FILE);

  if (!serverPresent) {
    const message =
      "the myne-server companion is absent, so NOTHING was compared.\n" +
      `            Looked in: ${POKE_FILE}\n                      ${AWARENESS_FILE}\n` +
      "            This is the branch that runs in CI and in a fresh clone. Set MYNE_SERVER_DIR\n" +
      "            to point at a checkout (or a fixture) somewhere else.";
    if (REQUIRE_COMPANION) fail(`--require-companion was passed and ${message}`);
    else
      notes.push(
        "SKIPPED: " + message + "\n            Exit 0 here is an absence of evidence, not a pass.",
      );
  } else {
    compared = true;

    const pokeMs = declared(
      POKE_FILE,
      parsePokeHeartbeat,
      "const DefaultHeartbeatInterval = <n> * time.Second",
    );
    const awarenessMs = declared(
      AWARENESS_FILE,
      parseAwarenessHeartbeat,
      "DefaultHeartbeat = <n> * time.Second",
    );
    const serverIds = declared(SYNCAPI_FILE, parseServerFetchIds, "const MaxBlobFetchIDs = <n>");
    const serverBytes = declared(
      SYNCAPI_FILE,
      parseServerFetchBytes,
      "const MaxBlobFetchBytes = <n>",
    );

    const timeoutMs = declared(
      SUPERVISOR_FILE,
      parseSseReadTimeout,
      "pub(crate) const SSE_READ_TIMEOUT: Duration = Duration::from_secs(<n>);",
    );
    const clientBlobs = declared(
      ORCHESTRATOR_FILE,
      parseClientFetchBlobs,
      "const FETCH_WINDOW_MAX_BLOBS: usize = <n>;",
    );
    const clientBytes = declared(
      ORCHESTRATOR_FILE,
      parseClientFetchBytes,
      "const FETCH_WINDOW_MAX_BYTES: usize = <n>;",
    );

    const heartbeatDisagreement = compareServerHeartbeats(pokeMs, awarenessMs);
    if (heartbeatDisagreement !== null) fail(heartbeatDisagreement);

    const pokeTimeout = compareStreamTimeout(timeoutMs, pokeMs, "the poke route");
    if (pokeTimeout !== null) fail(pokeTimeout);
    const awarenessTimeout = compareStreamTimeout(timeoutMs, awarenessMs, "the awareness route");
    if (awarenessTimeout !== null) fail(awarenessTimeout);

    const idDisagreement = compareFetchCap(serverIds, clientBlobs, "the blob-fetch id cap");
    if (idDisagreement !== null) fail(idDisagreement);
    const byteDisagreement = compareFetchCap(serverBytes, clientBytes, "the blob-fetch byte cap");
    if (byteDisagreement !== null) fail(byteDisagreement);

    // The safe direction: a server cap above the client's window is harmless, since
    // the client never asks for more than its own window. Recorded, never failed.
    if (serverIds !== null && clientBlobs !== null && serverIds > clientBlobs) {
      notes.push(
        `the server's blob-fetch id cap (${serverIds}) is above the client's window ` +
          `(${clientBlobs}), which is safe: the client never asks for more.`,
      );
    }
    if (serverBytes !== null && clientBytes !== null && serverBytes > clientBytes) {
      notes.push(
        `the server's blob-fetch byte cap (${serverBytes}) is above the client's window ` +
          `(${clientBytes}), which is safe: the client never asks for more.`,
      );
    }
  }

  for (const n of notes) console.log(`note: ${n}`);
  if (failures.length > 0) {
    console.error("stream-timeout drift: FAILED");
    for (const message of failures) console.error(`  - ${message}`);
    process.exit(1);
  }
  console.log(
    compared
      ? "ok: the server's stream heartbeat and blob-fetch caps agree with the client's mirror"
      : "ok: NOTHING COMPARED (a companion is absent). This line is not a verdict.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
