// Worker contract integration test — drives `parseStream` with 100
// small synthetic notes, breaks after the 50th yield, and asserts:
//   - exactly 50 results were yielded (no overshoot)
//   - the underlying iterable's `next()` was called at most 51 times
//     (50 consumed + at most 1 prefetched after break)
//   - subsequent `parseStream` invocations are independent of the
//     cancelled one (no leaked state across calls)
//
// Companion to `parseStream.test.ts` (Task 15) — that file covers the
// API contract; this file covers the cancellation-at-scale contract.

import { describe, expect, it } from "vitest";
import { parseStream } from "../../../src/dialect/worker";

const enc = new TextEncoder();

describe("worker contract — cancellation at scale", () => {
  it("breaks at item 50 of 100 with at most one prefetch past the break", async () => {
    let nextCalls = 0;
    function* gen() {
      for (let i = 0; i < 100; i++) {
        nextCalls++;
        yield {
          id: `note-${i}`,
          bytes: enc.encode(`# Note ${i}\nBody ${i}\n`),
        };
      }
    }

    let yielded = 0;
    for await (const _r of parseStream(gen())) {
      yielded++;
      if (yielded === 50) break;
    }

    expect(yielded).toBe(50);
    // After break: at most one prefetched item past consumer's break point.
    expect(nextCalls).toBeLessThanOrEqual(51);
  });

  it("emits no further results after break — observable via post-break delay", async () => {
    let resultsAfterBreak = 0;
    function* gen() {
      for (let i = 0; i < 100; i++) {
        yield { id: String(i), bytes: enc.encode("# x\n") };
      }
    }

    const stream = parseStream(gen());
    const collected: string[] = [];
    for await (const r of stream) {
      collected.push(r.id);
      if (collected.length === 5) break;
    }

    // The for-await break causes the generator's iterator to be closed.
    // Wait a small tick to ensure no late emissions slipped through.
    await new Promise<void>((r) => setTimeout(r, 20));

    // Try pulling more — the iterator is done; no further results.
    const remainder = stream as AsyncIterable<{ id: string }>;
    const it = remainder[Symbol.asyncIterator]();
    const more = await it.next();
    if (!more.done) resultsAfterBreak++;

    expect(collected).toHaveLength(5);
    expect(resultsAfterBreak).toBe(0);
  });

  it("multiple cancelled streams don't leak state into each other", async () => {
    function* gen(prefix: string) {
      for (let i = 0; i < 100; i++) {
        yield { id: `${prefix}-${i}`, bytes: enc.encode("# x\n") };
      }
    }

    // First stream: cancel after 10
    const collected1: string[] = [];
    for await (const r of parseStream(gen("first"))) {
      collected1.push(r.id);
      if (collected1.length === 10) break;
    }

    // Second stream: cancel after 5
    const collected2: string[] = [];
    for await (const r of parseStream(gen("second"))) {
      collected2.push(r.id);
      if (collected2.length === 5) break;
    }

    expect(collected1).toHaveLength(10);
    expect(collected2).toHaveLength(5);
    expect(collected1.every((id) => id.startsWith("first"))).toBe(true);
    expect(collected2.every((id) => id.startsWith("second"))).toBe(true);
  });

  it("draining the full stream (no break) yields exactly N results", async () => {
    const N = 25;
    function* gen() {
      for (let i = 0; i < N; i++) {
        yield { id: String(i), bytes: enc.encode(`# Note ${i}\n`) };
      }
    }

    const collected: string[] = [];
    for await (const r of parseStream(gen())) {
      collected.push(r.id);
    }
    expect(collected).toHaveLength(N);
    expect(collected[0]).toBe("0");
    expect(collected[N - 1]).toBe(String(N - 1));
  });
});
