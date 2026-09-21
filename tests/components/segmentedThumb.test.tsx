// @vitest-environment jsdom
//
// `<Segmented>`'s selection thumb re-measures when its BOX changes
// (myne-md/myne#727).
//
// The thumb is an absolutely-positioned fill sized from the active segment's
// `offsetWidth`, and that measurement happens in a layout effect keyed on the
// value and the option set. Neither of those moves when the CONTAINER changes,
// so a caller whose container mounts hidden measures 0 and stays there: the
// thumb is zero-width while the selected label keeps `--accent-on`, which in the
// dark themes is `#0b0b09`. The active segment renders invisible on a dark
// panel, and nothing reports it.
//
// jsdom has no layout, so the box is stubbed. That is the point rather than a
// workaround: the component's geometry is a function of two integers, and
// stubbing them is how the transition from "measured while hidden" to "measured
// while visible" gets driven at all.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Segmented } from "../../src/components/primitives/Segmented";

let stubWidth = 0;
let stubLeft = 0;

const OPTIONS = [
  { value: "graph", label: "Graph" },
  { value: "list", label: "List" },
];

beforeEach(() => {
  stubWidth = 0;
  stubLeft = 0;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      // The ACTIVE segment is the one that matters; give the first segment the
      // stub and the second a fixed offset so a mis-measure is visible.
      return (this as HTMLElement).dataset["value"] === "graph" ? stubWidth : 40;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset["value"] === "graph" ? stubLeft : 80;
    },
  });
});

afterEach(cleanup);

const thumb = () => {
  const root = screen.getByTestId("probe");
  return root.firstElementChild as HTMLElement;
};

describe("Segmented thumb measurement", () => {
  it("takes the active segment's box", () => {
    stubWidth = 60;
    stubLeft = 10;
    render(
      <Segmented
        options={OPTIONS}
        value="graph"
        onChange={() => {}}
        ariaLabel="View"
        testId="probe"
      />,
    );
    expect(thumb().style.width).toBe("60px");
    expect(thumb().style.transform).toBe("translateX(10px)");
  });

  it("re-measures when the box appears, which the value-keyed effect cannot see", () => {
    // The defect: mounted hidden (0), then shown. Neither `value` nor `options`
    // moved, so the layout effect does not re-run and the thumb stays at zero.
    render(
      <Segmented
        options={OPTIONS}
        value="graph"
        onChange={() => {}}
        ariaLabel="View"
        testId="probe"
      />,
    );
    expect(thumb().style.width).toBe("0px");

    // The container becomes visible.
    stubWidth = 60;
    stubLeft = 10;
    // jsdom has no `ResizeObserver`, so the window fallback is the live path.
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(thumb().style.width).toBe("60px");
  });

  it("still moves when the selection changes", () => {
    stubWidth = 60;
    const { rerender } = render(
      <Segmented
        options={OPTIONS}
        value="graph"
        onChange={() => {}}
        ariaLabel="View"
        testId="probe"
      />,
    );
    expect(thumb().style.transform).toBe("translateX(0px)");
    rerender(
      <Segmented
        options={OPTIONS}
        value="list"
        onChange={() => {}}
        ariaLabel="View"
        testId="probe"
      />,
    );
    expect(thumb().style.width).toBe("40px");
    expect(thumb().style.transform).toBe("translateX(80px)");
  });

  it("keeps the radiogroup contract it already had", () => {
    render(
      <Segmented
        options={OPTIONS}
        value="list"
        onChange={() => {}}
        ariaLabel="View"
        testId="probe"
      />,
    );
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
    // And the segment testids the graph E2E clicks.
    expect(screen.getByTestId("probe-list")).toBeTruthy();
    fireEvent.click(screen.getByTestId("probe-graph"));
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
  });
});
