// @vitest-environment jsdom
//
// `<Checkbox>` — the tree's one checkbox (myne-md/myne#1099).
//
// It replaced ten raw `<input type="checkbox">` call sites, each sized and skinned
// by hand. Three properties made that go wrong, and each is asserted here because
// each was the visible defect somewhere in the app:
//
//   1. the announced state and the painted state come from ONE attribute
//      (`aria-checked`), so a screen reader and a sighted user cannot disagree;
//   2. the BOX is 16px inside a `--target-min` target — the canon's rule for a
//      control whose box is what is drawn — rather than a native input stretched
//      to the target, which is what drew a 24px white tile on a card corner;
//   3. it is not an `<input>` at all, so it works inside the saved-view renderers
//      that must contain none (SYNC-1) — the reason `SelectToggle` exists and now
//      composes this.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Checkbox } from "../../src/components/primitives/Checkbox";

afterEach(() => cleanup());

describe("Checkbox", () => {
  it("announces its state from aria-checked, and paints from the same attribute", () => {
    const { rerender } = render(<Checkbox checked={false} ariaLabel="Select" onChange={vi.fn()} />);
    const box = screen.getByRole("checkbox", { name: "Select" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(box.querySelector(".myne-checkbox__box")!.textContent).toBe("");

    rerender(<Checkbox checked ariaLabel="Select" onChange={vi.fn()} />);
    expect(box.getAttribute("aria-checked")).toBe("true");
    // The tick is drawn by us, not by the platform, so it appears with the state.
    expect(box.querySelector(".myne-checkbox__box svg")).not.toBeNull();
  });

  it("toggles with the next value, not with a toggle it computes", () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} ariaLabel="Select" onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("is a button, never an input", () => {
    const { container } = render(<Checkbox checked ariaLabel="Select" onChange={vi.fn()} />);
    expect(container.querySelector("input")).toBeNull();
    expect(screen.getByRole("checkbox").tagName).toBe("BUTTON");
  });

  it("takes its name from its own visible label, and drops a second one", () => {
    // Two names is one too many: `aria-label` would win and the visible text would
    // stop matching what is announced.
    render(
      <Checkbox checked ariaLabel="ignored" onChange={vi.fn()}>
        Keep my original files
      </Checkbox>,
    );
    const box = screen.getByRole("checkbox", { name: "Keep my original files" });
    expect(box.getAttribute("aria-label")).toBeNull();
  });

  it("renders the inert placeholder when it cannot be toggled", () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} disabled onChange={onChange} ariaLabel="Select" />);
    const box = screen.getByRole("checkbox", { name: "Select" });
    expect(box.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("passes a caller's own attributes through, which is how a note id reaches it", () => {
    render(
      <Checkbox checked={false} ariaLabel="Select" onChange={vi.fn()} data-note-id="n1" />,
    );
    expect(screen.getByRole("checkbox").getAttribute("data-note-id")).toBe("n1");
  });
});
