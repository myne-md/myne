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
