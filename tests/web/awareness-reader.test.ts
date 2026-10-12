// The web Worker's live-awareness SSE reader (live-collab, collab-client-transport task 4).
//
// # What is worth testing here
//
// The poke stream has no unit test: it is a five-line loop whose happy path the
// browser E2E run exercises. The awareness reader is the same shape, so most of
// it needs no unit test either. Two things are different, and they are the two
// this file covers.
//
// First, the awareness reader does something with each frame: it hands the
// `data:` payload to an opaque sink (the wasm awareness inbox), where the poke
// reader only fires a contentless signal. So frame splitting and the `:hb`
// comment distinction are behavioural, not incidental, and a mistake there
// silently drops a cursor update.
//
// Second, its reconnect ladder is a ratified contract (SYNC-3 / the 2026-10-10
// task decision): base 1 s doubling to a 60 s cap, RESET when the stream opened
// and CLIMB when it never opened. That reset is the whole difference between a
// client that recovers from a proxy idle-timeout and one that probes an
// SSE-less server once an hour. Both the ladder and the reset are asserted here
// against an injected `fetch`, because a real stream's timing is not testable.

import { describe, expect, it, vi } from "vitest";
import {
  AWARENESS_RETRY_CAP_MS,
  AWARENESS_RETRY_START_MS,
  openAwarenessAndDrain,
  runAwarenessStream,
  type AwarenessTarget,
} from "../../web/src/worker/sync-loop";

const TARGET: AwarenessTarget = { endpoint: "https://sync.example", token: "deadbeef" };

/** A `fetch` that answers one SSE body then reports EOF (the "opened" case). */
function fetchOnce(body: string): typeof fetch {
  let served = false;
  return (async () => {
    if (served) throw new Error("fetch called twice");
    served = true;
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

/** A `fetch` that never opens, the SSE-less or unreachable server. */
function fetchNeverOpens(): typeof fetch {
  return (async () => new Response(null, { status: 502 })) as unknown as typeof fetch;
}

describe("openAwarenessAndDrain, frame handling", () => {
  it("delivers `data:` payloads to the sink and skips the `:hb` comment", async () => {
    const sink = vi.fn();
    // A `data:` frame, a heartbeat comment, then a second `data:` frame, each
    // separated by the SSE blank line.
    const wire = 'data: {"room_id_hex":"00"}\n\n:hb\n\ndata: {"room_id_hex":"01"}\n\n';
    const opened = await openAwarenessAndDrain(TARGET, sink, fetchOnce(wire));

    expect(opened).toBe(true);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenNthCalledWith(1, '{"room_id_hex":"00"}');
    expect(sink).toHaveBeenNthCalledWith(2, '{"room_id_hex":"01"}');
  });

  it("does not treat the heartbeat as a frame", async () => {
    const sink = vi.fn();
    const opened = await openAwarenessAndDrain(TARGET, sink, fetchOnce(":hb\n\n:hb\n\n"));
    expect(opened).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });

  it("carries the token on the request and targets the awareness route", async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const spy = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.["Authorization"] });
      return new Response("data: {}\n\n", { status: 200 });
    }) as unknown as typeof fetch;

    await openAwarenessAndDrain(TARGET, vi.fn(), spy);
    expect(seen[0].url).toBe("https://sync.example/sync/awareness");
    expect(seen[0].auth).toBe("Bearer deadbeef");
  });

  it("returns false when the server answers non-ok (no token, not enrolled)", async () => {
    const sink = vi.fn();
    const opened = await openAwarenessAndDrain(TARGET, sink, fetchNeverOpens());
    expect(opened).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("runAwarenessStream, the reconnect ladder", () => {
  it("climbs the ladder when the stream never opens (1 s doubling to the cap)", async () => {
    const sleeps: number[] = [];
    await runAwarenessStream({
      getTarget: async () => TARGET,
      sink: vi.fn(),
      fetchImpl: fetchNeverOpens(),
      sleep: async (ms) => void sleeps.push(ms),
      maxAttempts: 3,
    });
    expect(sleeps).toEqual([AWARENESS_RETRY_START_MS, AWARENESS_RETRY_START_MS * 2, AWARENESS_RETRY_START_MS * 4]);
  });

  it("resets the ladder on every attempt that opened, even a silent one", async () => {
    const sleeps: number[] = [];
    await runAwarenessStream({
      getTarget: async () => TARGET,
      sink: vi.fn(),
      // Each attempt opens, delivers nothing, and ends: the healthy long-lived
      // stream case. The ladder must stay at the base rather than climb.
      fetchImpl: (async () => new Response(":hb\n\n", { status: 200 })) as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
      maxAttempts: 3,
    });
    expect(sleeps).toEqual([AWARENESS_RETRY_START_MS, AWARENESS_RETRY_START_MS, AWARENESS_RETRY_START_MS]);
  });

  it("caps the climbing ladder at AWARENESS_RETRY_CAP_MS", async () => {
    const sleeps: number[] = [];
    await runAwarenessStream({
      getTarget: async () => TARGET,
      sink: vi.fn(),
      fetchImpl: fetchNeverOpens(),
      sleep: async (ms) => void sleeps.push(ms),
      maxAttempts: 8,
    });
    // 1,2,4,8,16,32,60,60 seconds: the cap clamps before the ninth doubling.
    expect(sleeps[6]).toBe(AWARENESS_RETRY_CAP_MS);
    expect(sleeps[7]).toBe(AWARENESS_RETRY_CAP_MS);
  });

  it("does not fetch when there is no target, and never resets the ladder", async () => {
    const fetchImpl = vi.fn();
    const sleeps: number[] = [];
    await runAwarenessStream({
      getTarget: async () => null,
      sink: vi.fn(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
      maxAttempts: 2,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sleeps).toEqual([AWARENESS_RETRY_START_MS, AWARENESS_RETRY_START_MS * 2]);
  });
});
