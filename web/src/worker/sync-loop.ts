// The Worker's sync loop: the timer that ticks the scheduler, and the poke
// stream that wakes it (phase3-web-client tasks 38 + 84).
//
// # What lives here and what deliberately does not
//
// Nothing here DECIDES anything. The cadence, the focus rate-limit, the push
// coalescing and the extend-only retry ladder are `SyncScheduler`'s, shared with
// desktop and covered by `cargo test --workspace`; this file only delivers ticks
// and signals to it. Two clients that re-derived those answers would disclose at
// two different granularities (`sync-protocol.md` §8.3, the A13 timing posture),
// which is exactly the failure the shared scheduler exists to prevent.
//
// # Why a fetch-streamed reader rather than `EventSource`
//
// `EventSource` cannot set request headers, and `/sync/poke` authenticates with
// `Authorization: Bearer <token-hex>` — `myne-server`'s `poke.go` rejects
// anything else with 401. The two ways out are putting the token in the query
// string (a credential in a URL, which lands in access logs and referrers, and
// would need a server change) or reading the stream through `fetch`, which CAN
// set headers and whose body is a `ReadableStream`. The second is strictly
// better and needs no server change at all — task 84's own text allows it
// ("`EventSource` (or a fetch-streamed reader)").
//
// # The fallback is not a fallback path
//
// "Falls back cleanly when SSE is unavailable" needs no code: polling is the
// scheduler's baseline cadence and the poke is an accelerant. If the stream
// never opens, never reconnects, or is blocked by a proxy, sync keeps running on
// the poll interval. That is why every failure here is swallowed rather than
// surfaced.

/**
 * The three wasm exports this loop drives, INJECTED rather than imported.
 *
 * `scripts/check-platform-seam.mjs` allows exactly one importer of the wasm glue
 * — `worker.ts` — because a second import is a second wasm instance, which means
 * a second copy of `root_key` and two sync access handles on the same OPFS
 * files. This module runs inside that same Worker, so importing here would be
 * harmless in fact and indistinguishable from the harmful case to any checker.
 * Taking the functions as parameters keeps the rule exactly as written, and the
 * guard's invariant is stronger for having no exception.
 */
export interface SyncLoopBindings {
  /** One scheduler tick; resolves to the action taken. */
  tick: () => Promise<string>;
  /** Tell the scheduler something happened. */
  signal: (kind: string) => void;
  /** `{"endpoint","token"}` JSON, or nullish when sync is not usable yet. */
  pokeTarget: () => Promise<string | undefined>;
  /**
   * One received opaque awareness frame (the `data:` payload verbatim, with the
   * SSE prefix stripped). Delivered to the wasm awareness inbox
   * (`sync_awareness_deliver`); this file never parses a frame. The same export
   * the poke stream uses supplies the token and endpoint (`SYNC-13`).
   */
  awarenessFrame: (payload: string) => void;
}

let bindings: SyncLoopBindings | null = null;

/**
 * Tick cadence, matching the desktop loop's `LOOP_TICK_MS`.
 *
 * A fine tick that mostly decides `Idle` — the scheduler enforces the real poll
 * interval and coalescing window against its own clock. Matching desktop matters
 * because the scheduler's thresholds are expressed in milliseconds of logical
 * time, and a client that fed it a coarser tick would round every interval up.
 */
const TICK_MS = 1_000;

/** First reconnect delay after the poke stream drops; doubles to the cap. */
const POKE_RETRY_START_MS = 2_000;
/** Cap for the poke reconnect delay. */
const POKE_RETRY_CAP_MS = 60_000;

/**
 * First reconnect delay after the awareness stream drops; doubles to the cap.
 *
 * 1 s, not the poke reader's 2 s. The native awareness supervisor uses a 1 s
 * base (`SYNC-3`), and the ratified 2026-10-10 task decision is that the web
 * awareness reader matches IT rather than the web poke reader: awareness is the
 * latency-sensitive channel, and a reconnect that lags the desktop's would make
 * the browser the slow participant in the same session. The poke reader is left
 * at 2 s on purpose, it is a contentless accelerant and its cadence is fine.
 */
export const AWARENESS_RETRY_START_MS = 1_000;
/** Cap for the awareness reconnect delay (mirrors the native supervisor). */
export const AWARENESS_RETRY_CAP_MS = 60_000;

let started = false;

/**
 * Start the loop. Idempotent — a second call is a no-op rather than a second
 * timer, because two timers would double the tick rate and, with it, every
 * cadence the scheduler derives from it.
 */
export function startSyncLoop(b: SyncLoopBindings): void {
  if (started) return;
  started = true;
  bindings = b;
  setInterval(() => {
    // Fire-and-forget: a tick that overlaps the previous one is fine, because
    // the CYCLE is serialized by a process-wide mutex in `myne-core` — the
    // overlap costs an await, never a lost-update on `sync-state.json`.
    void b.tick().catch(() => {
      // Swallowed on purpose. A failed tick is not a user-facing event: the
      // scheduler already records the failure through `on_cycle_outcome` and
      // backs off, and the console is not a place vault errors may go (see the
      // logging discipline at the top of `worker.ts`).
    });
  }, TICK_MS);
  void runPokeStream();
  void runAwarenessStream({
    getTarget: async () => {
      // The SAME wasm export the poke stream uses (task 4, acceptance criterion
      // 4). It adds no exposure: the token already crosses into JS on every sync
      // request (`sync_loop::poke_target`'s own doc says so).
      const raw = await b.pokeTarget().catch(() => null);
      return raw ? parseTarget(raw) : null;
    },
    sink: b.awarenessFrame,
  });
}

/** The endpoint and token a stream needs, parsed from `pokeTarget`'s JSON. */
export interface AwarenessTarget {
  endpoint: string;
  token: string;
}

/** Parse the `{"endpoint","token"}` JSON, or null if it is not that shape. */
function parseTarget(raw: string): AwarenessTarget | null {
  try {
    const t = JSON.parse(raw) as { endpoint?: unknown; token?: unknown };
    if (typeof t.endpoint === "string" && typeof t.token === "string") {
      return { endpoint: t.endpoint, token: t.token };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Hold a `/sync/poke` stream open, signalling the scheduler on every event, and
 * reconnect with backoff when it drops.
 *
 * Runs forever by design — the stream is long-lived and its ending is normal
 * (a proxy idle-timeout, a laptop sleeping, a server restart), so "it closed" is
 * a reconnect trigger rather than an error.
 */
async function runPokeStream(): Promise<void> {
  let delay = POKE_RETRY_START_MS;
  for (;;) {
    const opened = await openAndDrain();
    // A stream that OPENED resets the ladder, even if it stayed silent — a poke
    // stream with nothing to say is the healthy case. One that never opened
    // keeps climbing it, so an unreachable or SSE-less server (or a device that
    // is not enrolled yet) is probed rarely rather than every two seconds.
    delay = opened ? POKE_RETRY_START_MS : Math.min(delay * 2, POKE_RETRY_CAP_MS);
    await sleep(delay);
  }
}

/**
 * One connection attempt. Resolves `true` if the stream actually OPENED —
 * not whether it carried an event.
 *
 * That distinction is the whole point of the return value: a healthy poke stream
 * can be legitimately silent for hours (nobody else edited anything), so
 * "no events" must not be read as "connection failed" and must not push the
 * reconnect ladder up.
 */
async function openAndDrain(): Promise<boolean> {
  const b = bindings;
  if (!b) return false;
  const raw = await b.pokeTarget().catch(() => null);
  // No endpoint or no token — not enrolled yet, or sync is off. Nothing to
  // connect to; the caller waits and asks again.
  if (!raw) return false;
  let target: { endpoint: string; token: string };
  try {
    target = JSON.parse(raw) as { endpoint: string; token: string };
  } catch {
    return false;
  }

  let response: Response;
  try {
    response = await fetch(`${target.endpoint.replace(/\/$/, "")}/sync/poke`, {
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: "text/event-stream",
      },
      // No `keepalive`: that caps the body size and is for unload-time beacons,
      // the opposite of a long-lived stream.
      cache: "no-store",
    });
  } catch {
    return false;
  }
  if (!response.ok || !response.body) return false;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line. Heartbeats arrive as `:hb`
      // comment lines and carry no `data:`, so they keep the connection warm
      // without waking the scheduler — which is the point of the server sending
      // them (`poke.go`).
      let sep: number;
      while ((sep = buffered.indexOf("\n\n")) !== -1) {
        const frame = buffered.slice(0, sep);
        buffered = buffered.slice(sep + 2);
        if (frame.split("\n").some((line) => line.startsWith("data:"))) {
          // The event is contentless by design — it says "something changed",
          // never what. All it does is arm one immediate pull.
          b.signal("poke");
        }
      }
    }
  } catch {
    // A read error mid-stream is a dropped connection: reconnect.
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  // Opened, therefore `true` — see the doc. Reaching here means the body was
  // readable; how long it lived and whether it spoke are not this function's
  // business.
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The injected knobs `runAwarenessStream` reads. Everything but the fetch is
 * injectable so the reconnect ladder is testable without real time or a server
 * (`tests/web/awareness-reader.test.ts`).
 */
export interface AwarenessStreamOptions {
  /** Resolve the stream's target, or null when sync is not usable yet. */
  getTarget: () => Promise<AwarenessTarget | null>;
  /** Receives each `data:` payload verbatim; never a `:hb` comment. */
  sink: (payload: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Bounds the loop for tests; production leaves it unbounded. */
  maxAttempts?: number;
}

/**
 * Hold a `/sync/awareness` stream open, delivering each opaque frame to the
 * sink, and reconnect with backoff when it drops.
 *
 * A near-copy of `runPokeStream` (`SYNC-13`), with two differences that are the
 * whole point of it being a separate function rather than a parameterised one:
 *
 * * it hands each `data:` payload to the sink instead of firing a contentless
 *   signal, so frame splitting is behavioral here; and
 * * its ladder RESETS only when the stream OPENED (not when it carried a frame)
 *   and otherwise climbs from a 1 s base. The reset is what lets a client
 *   recover from a proxy idle-timeout quickly while still probing an SSE-less
 *   server rarely.
 *
 * Runs forever by design in production; its ending is normal (idle-timeout,
 * sleep, server restart), so a closed stream is a reconnect trigger, not an
 * error.
 */
export async function runAwarenessStream(opts: AwarenessStreamOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const doSleep = opts.sleep ?? sleep;
  const max = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
  let delay = AWARENESS_RETRY_START_MS;
  for (let attempt = 0; attempt < max; attempt++) {
    const target = await opts.getTarget().catch(() => null);
    const opened = target ? await openAwarenessAndDrain(target, opts.sink, fetchImpl) : false;
    await doSleep(delay);
    // Sleep the CURRENT delay, then move the ladder: so the first drop waits the
    // 1 s base (the native `Backoff` shape), an open resets it, and a failure
    // doubles it to the cap.
    delay = opened ? AWARENESS_RETRY_START_MS : Math.min(delay * 2, AWARENESS_RETRY_CAP_MS);
  }
}

/**
 * One awareness connection attempt. Resolves `true` if the stream actually
 * OPENED, not whether it carried a frame, a healthy awareness stream can be
 * silent for hours, so "no frames" must not push the ladder up.
 *
 * `fetch` + `ReadableStream`, never `EventSource`: the latter cannot set the
 * `Authorization` header, and `/sync/awareness` authenticates with
 * `Authorization: Bearer <token-hex>` exactly as the poke does (`SYNC-13`). The
 * body is read as SSE frames split on the blank line; a `:`-comment is the
 * server heartbeat and carries no frame.
 */
export async function openAwarenessAndDrain(
  target: AwarenessTarget,
  sink: (payload: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetchImpl(`${target.endpoint.replace(/\/$/, "")}/sync/awareness`, {
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: "text/event-stream",
      },
      cache: "no-store",
    });
  } catch {
    return false;
  }
  if (!response.ok || !response.body) return false;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffered.indexOf("\n\n")) !== -1) {
        const frame = buffered.slice(0, sep);
        buffered = buffered.slice(sep + 2);
        for (const payload of dataPayloads(frame)) sink(payload);
      }
    }
  } catch {
    // A read error mid-stream is a dropped connection: reconnect.
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return true;
}

/**
 * The `data:` payloads of one SSE frame. `:hb` comments and blank lines carry
 * none, which is how the heartbeat keeps the connection warm without delivering
 * a frame. A multi-line `data:` block is joined with a newline, per SSE.
 */
function dataPayloads(frame: string): string[] {
  const out: string[] = [];
  for (const raw of frame.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("data:")) out.push(line.slice(5).replace(/^ /, ""));
  }
  // A single-line frame is the overwhelming common case; joining is only correct
  // when a producer split one payload across several `data:` lines.
  return out.length > 1 ? [out.join("\n")] : out;
}
