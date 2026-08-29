// @vitest-environment jsdom
//
// myne-md/myne#565: the fade is CONDITIONAL, and the condition is what nothing
// checked.
//
// `measure()` was untested. Forced to return `{ top: false, bottom: false }` the
// whole suite stayed green, because the only assertion anywhere was that the
// `myne-scroll-fade` class is present, and that class is unconditional. So the
// affordance the module argues at length for could have been dead on arrival
// with nothing red. The hook's own docstring even names the silent-failure mode
// it then shipped without a check for.
//
// jsdom reports 0 for every layout property, so the three geometry reads are
// stubbed on the node. That is the whole input `measure()` has.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { scrollRegionStyle, useScrollEdges } from "../../src/hooks/useScrollEdges";

afterEach(cleanup);

/** jsdom leaves these at 0; `measure()` reads exactly these three. */
function geometry(el: HTMLElement, top: number, client: number, total: number): void {
  Object.defineProperty(el, "scrollTop", { value: top, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: client, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: total, configurable: true });
}

function Probe() {
  const { ref, fadeProps } = useScrollEdges<HTMLDivElement>();
  return <div ref={ref} data-testid="region" style={scrollRegionStyle} {...fadeProps} />;
}

/** Mount, apply a geometry, fire a scroll, and read the two attributes back. */
function edgesAt(top: number, client: number, total: number): [string | null, string | null] {
  const { getByTestId } = render(<Probe />);
  const el = getByTestId("region");
  geometry(el, top, client, total);
  act(() => {
    el.dispatchEvent(new Event("scroll"));
  });
  return [el.getAttribute("data-fade-top"), el.getAttribute("data-fade-bottom")];
}

describe("useScrollEdges reports the edges you can scroll toward", () => {
  it("fades neither when the content fits", () => {
    // The case a static both-ends mask gets wrong, and the reason this module
    // measures at all: a half-faded first row on an unscrolled list reads as a
    // rendering fault rather than an affordance.
    expect(edgesAt(0, 300, 300)).toEqual([null, null]);
  });

  it("fades the bottom only, at the top of a long list", () => {
    expect(edgesAt(0, 300, 900)).toEqual([null, "true"]);
  });

  it("fades both in the middle", () => {
    expect(edgesAt(300, 300, 900)).toEqual(["true", "true"]);
  });

  it("fades the top only, at the bottom", () => {
    expect(edgesAt(600, 300, 900)).toEqual(["true", null]);
  });

  it("treats a sub-pixel remainder at the bottom as the bottom", () => {
    // Fractional scroll offsets and device pixel ratios otherwise leave
    // `scrollTop` a hair short of the true end forever, and the fade never turns
    // off. One pixel of slack, which the hook documents.
    expect(edgesAt(599.6, 300, 900)).toEqual(["true", null]);
  });
});

describe("the other two triggers, which are the ones that matter", () => {
  it("re-measures when a row is APPENDED, with no scroll event", async () => {
    // The module's own docstring calls this out: "Watching only `scroll` leaves
    // the fade stale in exactly the case that matters, a list that just grew past
    // the fold without anyone touching it." Deleting the whole observer block
    // left the suite green, because every case above fires a scroll first.
    const { getByTestId } = render(<Growable />);
    const el = getByTestId("region");
    geometry(el, 0, 300, 300);
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(el.getAttribute("data-fade-bottom")).toBeNull();

    // The list grows past the fold. Nobody scrolls.
    geometry(el, 0, 300, 900);
    // `MutationObserver` delivers on a microtask and `measure()` then sets React
    // state, so the flush has to happen inside `act` or the attribute is read a
    // render too early.
    await act(async () => {
      el.appendChild(document.createElement("div"));
      await Promise.resolve();
    });
    expect(el.getAttribute("data-fade-bottom")).toBe("true");
  });
});

/** A region whose children the test can append to. */
function Growable() {
  const { ref, fadeProps } = useScrollEdges<HTMLDivElement>();
  return (
    <div ref={ref} data-testid="region" style={scrollRegionStyle} {...fadeProps}>
      <div />
    </div>
  );
}
