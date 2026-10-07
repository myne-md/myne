// `startLayout`, the main-thread entry point for a graph layout
// (myne-md/myne#727, formerly the one-shot `runLayout` of myne-md/myne#200).
//
// It prefers a module worker so the force run stays off the WebView main
// thread, and falls back to a synchronous settle when the Worker cannot be
// constructed OR errors while loading. That fallback came from the mobile
// client, where module workers are unproven on WKWebView and the Android
// WebView, and a worker that fails to load surfaces as an `error` event rather
// than a constructor throw. Desktop never had it and now does.
//
// The difference from `runLayout` is that this returns a HANDLE rather than a
// promise. A live layout is not a request with an answer; it is a stream the
// caller can push against, which is what lets a drag re-heat it and pull a
// displaced node back through its links. A host on the fallback path gets the
// settled answer and an inert handle, which is the honest degradation: no
// motion, and the same final picture.
//
// The worker ENTRY stays in each client's own tree and is passed in as
// `makeWorker`. That is deliberate: `new Worker(new URL("./x.worker.ts",
// import.meta.url))` has to be statically analysable by the bundler compiling
// that client, and a specifier resolved through the `@myne/editor` alias is
// not. The entry is ~10 lines of wiring; the kernel and the driver it wires are
// shared.

import {
  computeGraphLayout,
  type LaidOutNode,
  type LayoutRequest,
  type LayoutWorkerCommand,
  type LayoutWorkerMessage,
} from "./graphLayout";

export interface LayoutStreamHandlers {
  /** Called for every streamed frame while the simulation is hot, so the caller
   *  can repaint at the simulation's pace rather than waiting for the end. */
  onFrame?: (positions: LaidOutNode[]) => void;
  /** Called once per cycle, when the simulation has cooled or exhausted its
   *  budget. On the fallback path it is the only call. */
  onSettled: (positions: LaidOutNode[]) => void;
}

/** What the caller may do to a running layout. */
export interface LayoutHandle {
  /** Raise the simulation's energy so it moves again. */
  reheat(): void;
  /** Hold a node where an interaction put it, so the rest moves around it. */
  hold(id: string, x: number, y: number): void;
  /** Release a held node, so the link force pulls it back. */
  release(id: string): void;
  /** Hold the simulation warm for a whole gesture, rather than kicking it once
   *  per pointer move — which is an impulse train, and lurches. */
  dragWarm(on: boolean): void;
  /** Tear the layout down. Safe to call more than once, and safe on the
   *  fallback path, where it only cancels the deferred settle. */
  stop(): void;
}

const INERT: Pick<LayoutHandle, "reheat" | "hold" | "release" | "dragWarm"> = {
  reheat() {},
  hold() {},
  release() {},
  dragWarm() {},
};

export function startLayout(
  req: LayoutRequest,
  makeWorker: () => Worker,
  handlers: LayoutStreamHandlers,
): LayoutHandle {
  let worker: Worker | null = null;
  let order: readonly string[] | null = null;
  let stopped = false;

  const toPositions = (flat: Float32Array): LaidOutNode[] => {
    if (order === null) return [];
    const out: LaidOutNode[] = [];
    for (let i = 0; i < order.length; i += 1) {
      out.push({ id: order[i]!, x: flat[i * 2]!, y: flat[i * 2 + 1]! });
    }
    return out;
  };

  /** The synchronous settle, used when no worker can run. Deferred one
   *  macrotask so the caller's mount frame (the seeded first paint) reaches the
   *  screen before the stall. */
  const settleSync = () => {
    setTimeout(() => {
      if (stopped) return;
      handlers.onSettled(computeGraphLayout(req).positions);
    }, 0);
  };

  try {
    worker = makeWorker();
  } catch {
    settleSync();
    return { ...INERT, stop: () => { stopped = true; } };
  }

  let dead = false;
  worker.onmessage = (e: MessageEvent<LayoutWorkerMessage>) => {
    if (stopped || dead) return;
    const msg = e.data;
    if (msg.kind === "ids") {
      order = msg.ids;
      return;
    }
    const positions = toPositions(msg.flat);
    if (msg.kind === "frame") handlers.onFrame?.(positions);
    else handlers.onSettled(positions);
  };
  worker.onerror = () => {
    if (stopped || dead) return;
    dead = true;
    worker?.terminate();
    worker = null;
    settleSync();
  };

  const send = (cmd: LayoutWorkerCommand) => {
    if (!stopped && !dead) worker?.postMessage(cmd);
  };
  send({ kind: "start", request: req });

  return {
    reheat: () => send({ kind: "reheat" }),
    hold: (id, x, y) => send({ kind: "hold", id, x, y }),
    release: (id) => send({ kind: "release", id }),
    dragWarm: (on) => send({ kind: "dragWarm", on }),
    stop: () => {
      // `terminate` is the teardown: it discards anything the worker still has
      // queued, so there is no point posting a stop command first and no point
      // in the protocol carrying one.
      stopped = true;
      worker?.terminate();
      worker = null;
    },
  };
}
