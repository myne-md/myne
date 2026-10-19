// @vitest-environment jsdom
//
// The graph CANVAS mounts and runs its `[model]` effect (myne-md/myne#727).
//
// This spec exists for one specific defect, and the defect is why it has to
// stub a 2D context rather than just render the component.
//
// The canvas's whole setup, the simulation, the pointer handlers, the camera,
// the theme observer, lives in ONE `useEffect`. jsdom's
// `HTMLCanvasElement.getContext("2d")` returns `null`, and that effect RETURNS
// EARLY on a null context, so a plain `render(<GraphCanvas/>)` never executes a
// line of it. Every test that mounts this component without a context stub is
// therefore asserting almost nothing about it, and that is exactly how a
// Rules-of-Hooks violation shipped: a `useRef` declared inside the effect
// callback, which React rejects with "Invalid hook call" the moment the effect
// runs. tsc was green, `pnpm build` was green, all 10k unit tests were green,
// and the app replaced its entire workspace with the fail-closed card the first
// time a user opened the graph. Only a real mount that reaches the effect sees
// it.
//
// So the assertions below are deliberately about the effect having RUN, not
// about pixels: if the effect throws, the test fails, and that is the point.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { GraphModel } from "../../src/notes/graphModel";

const MODEL: GraphModel = {
  nodes: [
    { id: "n-a", title: "Alpha" },
    { id: "n-b", title: "Bravo" },
    { id: "tag:work", title: "#Work", kind: "tag" },
  ],
  edges: [
    { source: "n-a", target: "n-b", weight: 1 },
    { source: "tag:work", target: "n-a", weight: 1 },
    { source: "tag:work", target: "n-b", weight: 1 },
  ],
};

/** A 2D context stub with the handful of members the render pass touches. Every
 *  method is a no-op and every property is assignable; the point is that the
 *  effect gets PAST its `ctx === null` early return and runs to the end. */
function stub2dContext(): CanvasRenderingContext2D {
  const noop = () => {};
  return {
    save: noop,
    restore: noop,
    scale: noop,
    translate: noop,
    clearRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    closePath: noop,
    stroke: noop,
    fill: noop,
    fillText: noop,
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: "",
    fillStyle: "",
    font: "",
  } as unknown as CanvasRenderingContext2D;
}

/** A Worker that never answers. The layout is fire-and-forget from the
 *  component's side, so the effect completes without one. */
function stubWorker(): Worker {
  return {
    postMessage: () => {},
    terminate: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Worker;
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => stub2dContext() as never,
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GraphCanvas mounts (myne-md/myne#727)", () => {
  it("runs its [model] effect to the end with tag nodes in the model", async () => {
    const { default: GraphCanvas } = await import(
      "@myne/editor/host/notes/GraphCanvas"
    );
    render(
      <GraphCanvas
        model={MODEL}
        makeWorker={stubWorker}
        onPositionsChanged={() => {}}
        onNodeClick={() => {}}
      />,
    );
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="editor.graph-canvas"]',
    );
    expect(canvas).not.toBeNull();
    // Written imperatively by the effect, so its presence IS the proof that the
    // effect body ran rather than bailing out at the null-context guard.
    await waitFor(() =>
      expect(canvas?.dataset["canvasModelNonce"]).toBe("1"),
    );
    // The camera transform is written by the render loop, which the effect
    // schedules, the second half of "the effect really ran".
    await waitFor(() => expect(canvas?.dataset["viewK"]).toBeDefined());
  });

  it("does NOT rebuild when the same model arrives as a new OBJECT", async () => {
    // The repaint-only contract, at the seam that decides it (myne-md/myne#727).
    // A caller that re-renders with an equal-but-new model object used to cost a
    // full teardown and a re-layout; the canvas keys its rebuild on CONTENT, so
    // it does not. `gc1` caught the container version of this.
    const { default: GraphCanvas } = await import(
      "@myne/editor/host/notes/GraphCanvas"
    );
    const { rerender } = render(
      <GraphCanvas
        model={MODEL}
        makeWorker={stubWorker}
        onPositionsChanged={() => {}}
        onNodeClick={() => {}}
      />,
    );
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="editor.graph-canvas"]',
    );
    await waitFor(() => expect(canvas?.dataset["canvasModelNonce"]).toBe("1"));

    // A structurally identical model in a fresh object, the way a colour-rule
    // edit produces one.
    rerender(
      <GraphCanvas
        model={{
          nodes: MODEL.nodes.map((n) => ({ ...n })),
          edges: MODEL.edges.map((e) => ({ ...e })),
        }}
        makeWorker={stubWorker}
        onPositionsChanged={() => {}}
        onNodeClick={() => {}}
      />,
    );
    // Give a rebuild a chance to be a rebuild.
    await new Promise((r) => setTimeout(r, 40));
    expect(canvas?.dataset["canvasModelNonce"]).toBe("1");
  });

  it("does not frame the camera again when only TAG nodes were added", async () => {
    // Task 18's contract: a hub arriving rebuilds the model (same notes, one
    // more node) and must NOT frame the camera again, because `fittedKeyRef` is
    // keyed on the NOTE set. The fixture therefore starts NOTES-ONLY and ADDS
    // the hub (`tag:work`), which is the state the defect needs; the earlier
    // version started with the hub and removed it, the opposite direction.
    //
    // The fitted transform itself is NOT the observable here: jsdom's canvas has
    // no CSS box, so `fitTransform` clamps to its floor and `data-view-k` is the
    // same number whether or not the fit re-ran, which is exactly how the old
    // version passed while the defect was live. `data-fit-count`, bumped only
    // when the note key changes, is the fixture that can hold it.
    const { default: GraphCanvas } = await import(
      "@myne/editor/host/notes/GraphCanvas"
    );
    const NOTES_ONLY = {
      nodes: MODEL.nodes.slice(0, 2),
      edges: MODEL.edges.slice(0, 1),
    };
    const { rerender } = render(
      <GraphCanvas
        model={NOTES_ONLY}
        makeWorker={stubWorker}
        onPositionsChanged={() => {}}
        onNodeClick={() => {}}
      />,
    );
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="editor.graph-canvas"]',
    );
    await waitFor(() => expect(canvas?.dataset["canvasModelNonce"]).toBe("1"));
    await waitFor(() => expect(canvas?.dataset["fitCount"]).toBe("1"));

    // Same notes, one more node (the `tag:work` hub) plus its two edges. The
    // model rebuilds, the camera must not refit.
    rerender(
      <GraphCanvas
        model={MODEL}
        makeWorker={stubWorker}
        onPositionsChanged={() => {}}
        onNodeClick={() => {}}
      />,
    );
    await waitFor(() => expect(canvas?.dataset["canvasModelNonce"]).toBe("2"));
    await new Promise((r) => setTimeout(r, 40));
    expect(canvas?.dataset["fitCount"]).toBe("1");

    // Non-vacuity: a changed NOTE set DOES refit, so the assertion above is not
    // passing merely because the count never moves at all.
    rerender(
      <GraphCanvas
        model={{
          nodes: [...MODEL.nodes, { id: "n-c", title: "Charlie" }],
          edges: [
            ...MODEL.edges,
            { source: "n-a", target: "n-c", weight: 1 },
            { source: "n-c", target: "n-b", weight: 1 },
          ],
        }}
        makeWorker={stubWorker}
        onPositionsChanged={() => {}}
        onNodeClick={() => {}}
      />,
    );
    await waitFor(() => expect(canvas?.dataset["canvasModelNonce"]).toBe("3"));
    await waitFor(() => expect(canvas?.dataset["fitCount"]).toBe("2"));
  });
});
