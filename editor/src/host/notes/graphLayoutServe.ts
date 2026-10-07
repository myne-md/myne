// The worker-side driver for the graph layout (myne-md/myne#727).
//
// It used to be that the worker's whole body was `postMessage(compute(req))`:
// one request in, one answer out, and then the worker was terminated. A live
// layout cannot work that way, because the point is that the main thread sees
// the graph moving while the simulation runs. So the worker now owns a
// `LayoutSimulation` and pumps it in bounded bursts, posting a frame after each
// one, until the cycle settles or exhausts its budget.
//
// Both clients' worker entries are three lines now: they narrow `self` to
// {@link WorkerScope} and call this. Keeping the driver here rather than copied
// into each entry is what makes the streaming contract testable without a
// Worker at all: a test passes a scope it controls and a scheduler it drives by
// hand, and asserts the exact frame sequence.

import {
  createLayoutSimulation,
  TICKS_PER_BURST,
  type LayoutSimulation,
  type LayoutWorkerCommand,
  type LayoutWorkerMessage,
} from "./graphLayout";

/** The slice of a worker's global scope this driver uses. Narrow rather than
 *  `DedicatedWorkerGlobalScope`, because the tsconfig `lib` is DOM-only (no
 *  WebWorker lib) and typing `self` as a window is what the entries were
 *  already working around. */
export interface WorkerScope {
  onmessage: ((e: MessageEvent<LayoutWorkerCommand>) => void) | null;
  postMessage: (message: LayoutWorkerMessage, transfer?: Transferable[]) => void;
}

/** How the driver defers its next burst. Injected so a test can drive the
 *  stream deterministically instead of waiting on a real timer. */
export type Scheduler = (run: () => void) => void;

const defaultScheduler: Scheduler = (run) => {
  setTimeout(run, 0);
};

/**
 * Serve one worker's lifetime. The scope's `onmessage` is replaced with the
 * command handler; every frame is posted with its buffer transferred, so the
 * simulation immediately reuses the memory rather than the message and the
 * simulation both holding a copy.
 */
export function serveLayoutWorker(
  scope: WorkerScope,
  schedule: Scheduler = defaultScheduler,
): void {
  let sim: LayoutSimulation | null = null;
  let scheduled = false;

  const postFrame = (kind: "frame" | "settled") => {
    if (sim === null) return;
    const flat = sim.flat();
    if (kind === "frame") {
      scope.postMessage({ kind, flat, alpha: sim.alpha() }, [flat.buffer]);
    } else {
      scope.postMessage({ kind, flat }, [flat.buffer]);
    }
  };

  const pump = () => {
    scheduled = false;
    if (sim === null) return;
    sim.step(TICKS_PER_BURST);
    if (sim.settled()) {
      postFrame("settled");
      sim.stop();
      return;
    }
    postFrame("frame");
    kick();
  };

  /** Schedule a burst, unless one is already scheduled. Both `start` and
   *  `reheat` go through here, so a re-heat that arrives mid-stream does not
   *  produce two interleaved pumps. */
  const kick = () => {
    if (scheduled || sim === null) return;
    scheduled = true;
    schedule(pump);
  };

  scope.onmessage = (e: MessageEvent<LayoutWorkerCommand>) => {
    const cmd = e.data;
    switch (cmd.kind) {
      case "start": {
        // A second `start` replaces the simulation rather than stacking on it,
        // which is what a filter change sends.
        sim?.stop();
        sim = createLayoutSimulation(cmd.request);
        scope.postMessage({ kind: "ids", ids: sim.ids });
        kick();
        return;
      }
      case "reheat":
        if (sim !== null) {
          sim.reheat();
          kick();
        }
        return;
      case "hold":
        sim?.hold(cmd.id, cmd.x, cmd.y);
        return;
      case "release":
        sim?.release(cmd.id);
        return;
      case "dragWarm":
        sim?.dragWarm(cmd.on);
        // `kick()` on the way IN only: entering a gesture must wake the tick
        // loop if it had gone quiet, where leaving one wants it to coast down
        // on its own rather than be handed one more impulse on release.
        if (cmd.on) kick();
        return;
    }
  };
}
