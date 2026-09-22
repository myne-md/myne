// The graph layout's streaming contract (myne-md/myne#727).
//
// The kernel used to be a request with an answer, so nothing needed a test at
// the worker seam: `postMessage(compute(req))` either returned or it did not.
// A live layout is a stream instead, and a stream has one failure mode that
// looks exactly like success, which is stopping early. The canvas would then
// freeze at whatever frame arrived last, with no error anywhere. So the
// assertions here are about the SEQUENCE: the order announcement, at least one
// frame, and a `settled` at the end of every cycle.
//
// The driver is exercised without a Worker on purpose. It takes its scope and
// its scheduler as parameters, so this test drives both by hand and never waits
// on a timer.

import { describe, expect, it } from "vitest";
import {
  serveLayoutWorker,
  type Scheduler,
  type WorkerScope,
} from "@myne/editor/host/notes/graphLayoutServe";
import {
  ALPHA_MIN,
  MAX_TICKS_PER_CYCLE,
  TICKS_PER_BURST,
  type LayoutRequest,
  type LayoutWorkerCommand,
  type LayoutWorkerMessage,
} from "@myne/editor/host/notes/graphLayout";

/** A scope the test owns, and a scheduler the test drains. */
function harness() {
  const sent: LayoutWorkerMessage[] = [];
  const pending: Array<() => void> = [];
  const scope: WorkerScope = {
    onmessage: null,
    postMessage: (message) => {
      sent.push(message);
    },
  };
  const schedule: Scheduler = (run) => {
    pending.push(run);
  };
  serveLayoutWorker(scope, schedule);

  const send = (cmd: LayoutWorkerCommand) => {
    scope.onmessage?.({ data: cmd } as MessageEvent<LayoutWorkerCommand>);
  };
  /** Run every burst the driver has queued. Returns how many ran, so a test can
   *  assert the stream TERMINATED rather than assume the queue emptied. */
  const drain = (cap = 10_000) => {
    let ran = 0;
    while (pending.length > 0 && ran < cap) {
      pending.shift()?.();
      ran += 1;
    }
    return ran;
  };

  return { sent, send, drain, queued: () => pending.length };
}

const req: LayoutRequest = {
  // Deliberately unsorted, so the order assertion means something.
  nodes: [{ id: "c" }, { id: "a" }, { id: "b" }],
  edges: [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ],
  seed: {},
};

const frames = (sent: LayoutWorkerMessage[]) => sent.filter((m) => m.kind === "frame");
const settled = (sent: LayoutWorkerMessage[]) => sent.filter((m) => m.kind === "settled");

describe("serveLayoutWorker", () => {
  it("announces the canonical order once, then streams frames to a settled", () => {
    const h = harness();
    h.send({ kind: "start", request: req });

    const first = h.sent[0];
    expect(first).toBeDefined();
    expect(first!.kind).toBe("ids");
    // The canonical order is the kernel's sorted id order, not the caller's.
    if (first!.kind === "ids") expect([...first!.ids]).toEqual(["a", "b", "c"]);

    h.drain();

    // The failure this file exists for: a stream that stops without saying so
    // leaves the canvas frozen and reports nothing.
    expect(frames(h.sent).length).toBeGreaterThan(0);
    expect(settled(h.sent).length).toBe(1);
    expect(h.sent[h.sent.length - 1]!.kind).toBe("settled");
    expect(h.queued()).toBe(0);
  });

  it("carries the canonical id order and a flat pair per node in every frame", () => {
    const h = harness();
    h.send({ kind: "start", request: req });
    h.drain();
    for (const m of [...frames(h.sent), ...settled(h.sent)]) {
      expect(m.flat.length).toBe(req.nodes.length * 2);
      expect(m.flat).toBeInstanceOf(Float32Array);
    }
  });

  it("allocates a fresh buffer per frame, so transferring one cannot detach the simulation", () => {
    // The worker transfers each frame's buffer. If the driver ever reused a
    // single array, the first transfer would detach it and every later frame
    // would carry zeros with no error raised.
    const h = harness();
    h.send({ kind: "start", request: req });
    h.drain();
    const buffers = [...frames(h.sent), ...settled(h.sent)].map((m) => m.flat.buffer);
    expect(new Set(buffers).size).toBe(buffers.length);
  });

  it("cools rather than exhausting its budget", () => {
    // A small graph must actually converge. Note the one-burst offset: the
    // frame is posted BEFORE the step that crosses the threshold, so the last
    // frame's alpha sits just above ALPHA_MIN and the `settled` message is what
    // marks the crossing. An exhausted budget would instead end with alpha
    // still high, which is the state this asserts against.
    const h = harness();
    h.send({ kind: "start", request: req });
    h.drain();
    const fs = frames(h.sent);
    const first = fs[0];
    const last = fs[fs.length - 1];
    expect(first?.kind).toBe("frame");
    expect(last?.kind).toBe("frame");
    if (first?.kind === "frame" && last?.kind === "frame") {
      expect(last.alpha).toBeLessThan(first.alpha);
      expect(last.alpha).toBeLessThan(ALPHA_MIN * 2);
    }
    expect(fs.length).toBeLessThan(MAX_TICKS_PER_CYCLE / TICKS_PER_BURST);
  });

  it("a settled cycle stays settled until something re-heats it", () => {
    const h = harness();
    h.send({ kind: "start", request: req });
    h.drain();
    const afterSettle = h.sent.length;

    // Draining again must do nothing: there is no perpetual loop here.
    expect(h.drain()).toBe(0);
    expect(h.sent.length).toBe(afterSettle);

    h.send({ kind: "reheat" });
    expect(h.drain()).toBeGreaterThan(0);
    expect(settled(h.sent).length).toBe(2);
    expect(h.queued()).toBe(0);
  });

  it("holds a node where an interaction put it, and releases it on request", () => {
    const h = harness();
    h.send({ kind: "start", request: req });
    // Exactly one burst, so the hold is set before the frame is read.
    h.drain(1);
    h.send({ kind: "hold", id: "a", x: 7, y: 9 });
    h.drain(1);

    const index = 0; // canonical order is a, b, c
    const held = [...frames(h.sent)].pop();
    expect(held?.kind).toBe("frame");
    if (held?.kind === "frame") {
      expect(held.flat[index * 2]).toBeCloseTo(7, 3);
      expect(held.flat[index * 2 + 1]).toBeCloseTo(9, 3);
    }

    // Released, a re-heat lets the link force pull it back: the node must no
    // longer sit at the point it was held at. This is the "spring" half of the
    // contract, and it is why `release` exists at all.
    h.send({ kind: "release", id: "a" });
    h.send({ kind: "reheat" });
    h.drain();
    const after = settled(h.sent)[settled(h.sent).length - 1];
    expect(after?.kind).toBe("settled");
    if (after?.kind === "settled") {
      const moved = after.flat[index * 2] !== 7 || after.flat[index * 2 + 1] !== 9;
      expect(moved).toBe(true);
    }
  });

  it("replaces the simulation when a second start arrives, rather than stacking", () => {
    const h = harness();
    h.send({ kind: "start", request: req });
    h.drain(2);
    h.send({ kind: "start", request: { ...req, nodes: [{ id: "z" }], edges: [] } });
    const order = h.sent.filter((m) => m.kind === "ids");
    expect(order.length).toBe(2);
    h.drain();
    const last = h.sent[h.sent.length - 1];
    expect(last?.kind).toBe("settled");
    if (last?.kind === "settled") expect(last.flat.length).toBe(2);
  });
});
