// @vitest-environment jsdom
//
// The `Checkbox` primitive's click contract
// (myne-md/myne#1099, `decisions/ui/0793`'s sibling in the primitives layer).
//
// The failure this pins is one line of ordering. The primitive spreads the
// caller's props onto its `<button>` and then writes its own `onClick` after
// them, so a caller that passed a handler — `SelectToggle` passes
// `(e) => e.stopPropagation()` so a row's selector does not also open the note
// under it — had that handler silently discarded. Every row click in a view
// table then toggled the selection AND navigated away, which
// `e2e/view-manifests.e2e.ts` vm3 caught as a `stale element reference` (the
// table was replaced by the note it opened) and cost three E2E runs to find.
//
// Two claims, both about the same composition:
//   1. the caller's handler runs, and its `preventDefault` suppresses the toggle;
//   2. without that, the toggle happens — so the composition is not "call the
//      caller and forget the state".

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Checkbox } from "../../src/components/primitives/Checkbox";

afterEach(cleanup);

describe("the Checkbox primitive's click", () => {
  it("runs the caller's onClick and still toggles", () => {
    const onChange = vi.fn();
    const onClick = vi.fn();
    render(
      <Checkbox
        checked={false}
        onChange={onChange}
        onClick={onClick}
        ariaLabel="select row"
        testId="probe"
      />,
    );
    fireEvent.click(screen.getByTestId("probe"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("lets the caller cancel the toggle, which is what stopPropagation-only callers rely on", () => {
    const onChange = vi.fn();
    render(
      <Checkbox
        checked={false}
        onChange={onChange}
        onClick={(event) => {
          // The real caller stops the bubble; a caller that also refuses the
          // toggle must be able to say so through the event.
          event.stopPropagation();
          event.preventDefault();
        }}
        ariaLabel="select row"
        testId="probe"
      />,
    );
    fireEvent.click(screen.getByTestId("probe"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports its state through aria-checked, which is what the specs read", () => {
    const { rerender } = render(<Checkbox checked ariaLabel="row" testId="probe" />);
    expect(screen.getByTestId("probe").getAttribute("aria-checked")).toBe("true");
    rerender(<Checkbox checked={false} ariaLabel="row" testId="probe" />);
    expect(screen.getByTestId("probe").getAttribute("aria-checked")).toBe("false");
  });
});
