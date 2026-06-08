// @vitest-environment jsdom
//
// Select primitive (MYND-164 Fix 1) — the token-styled custom dropdown that
// replaces the OS-native <select>. Covers: trigger shows the current label;
// open on click; portaled listbox with role="option" + aria-selected mark;
// pick by click; keyboard open + ↑/↓ + Enter; Esc closes; outside-click closes.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { Select, type SelectOption } from "../../src/components/primitives/Select";

type Flavor = "a" | "b" | "c";
const OPTIONS: readonly SelectOption<Flavor>[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Bravo" },
  { value: "c", label: "Charlie" },
];

function Harness({ initial = "a" as Flavor }: { initial?: Flavor }) {
  const [value, setValue] = useState<Flavor>(initial);
  return (
    <Select
      value={value}
      options={OPTIONS}
      onChange={setValue}
      aria-label="Flavor"
    />
  );
}

function getTrigger() {
  return screen.getByRole("combobox", { name: "Flavor" });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Select primitive", () => {
  it("renders the current option's label on the trigger (no native <select>)", () => {
    const { container } = render(<Harness initial="b" />);
    expect(getTrigger().textContent).toContain("Bravo");
    // It is a button-based custom control, not a native element.
    expect(container.querySelector("select")).toBeNull();
  });

  it("opens a portaled listbox on click and lists all options", () => {
    render(<Harness />);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(getTrigger());
    const list = screen.getByRole("listbox");
    const opts = within(list).getAllByRole("option");
    expect(opts.map((o) => o.textContent)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  it("marks the selected option via aria-selected", () => {
    render(<Harness initial="c" />);
    fireEvent.click(getTrigger());
    const opts = screen.getAllByRole("option");
    expect(opts[0].getAttribute("aria-selected")).toBe("false");
    expect(opts[2].getAttribute("aria-selected")).toBe("true");
  });

  it("selects an option on click, updates the trigger, and closes", () => {
    render(<Harness />);
    fireEvent.click(getTrigger());
    fireEvent.click(screen.getByRole("option", { name: "Charlie" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(getTrigger().textContent).toContain("Charlie");
  });

  it("opens with ArrowDown and selects with keyboard (↓ then Enter)", () => {
    render(<Harness />);
    const trigger = getTrigger();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    // active starts on the selected option (index 0); ↓ moves to index 1.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger.textContent).toContain("Bravo");
  });

  it("closes on Escape without changing the value", () => {
    render(<Harness initial="a" />);
    const trigger = getTrigger();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger.textContent).toContain("Alpha");
  });

  it("closes on outside click", async () => {
    render(<Harness />);
    fireEvent.click(getTrigger());
    expect(screen.getByRole("listbox")).toBeTruthy();
    // The outside-click listener is attached on a deferred (setTimeout 0)
    // timer so the opening click doesn't immediately close it. Wait a tick.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps at most one Select open: opening the second closes the first", () => {
    render(
      <>
        <Select
          value={"a" as Flavor}
          options={OPTIONS}
          onChange={() => {}}
          aria-label="First"
        />
        <Select
          value={"a" as Flavor}
          options={OPTIONS}
          onChange={() => {}}
          aria-label="Second"
        />
      </>,
    );
    const first = screen.getByRole("combobox", { name: "First" });
    const second = screen.getByRole("combobox", { name: "Second" });

    fireEvent.click(first);
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
    expect(first.getAttribute("aria-expanded")).toBe("true");

    // Opening the second must close the first — only one menu in the DOM.
    fireEvent.click(second);
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(second.getAttribute("aria-expanded")).toBe("true");
  });
});
