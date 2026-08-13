// @vitest-environment jsdom
//
// SearchableSelect primitive — the searchable sibling of `Select`, used by
// every Settings dropdown with more options than a segmented control can show
// (auto-lock, spell languages, daily-notes folder + template, automatic-backup
// frequency, startup note, and the interface language since #182).
//
// The regression this file exists for: the search box is focused by an effect,
// but the menu is only portaled once the anchoring `useLayoutEffect` has
// measured the trigger — one render later. Keyed to `[open]` alone that focus
// silently no-opped on the FIRST open of a control, so typing went nowhere.
// It hid well: `coords` is never cleared on close, so every later open
// re-rendered the portal immediately and worked. Only the first was broken,
// and no test or scenario had ever typed into one of these boxes.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { SearchableSelect } from "../../src/components/primitives/SearchableSelect";
import type { SelectOption } from "../../src/components/primitives/Select";

type Lang = "en" | "de" | "tr";
const OPTIONS: readonly SelectOption<Lang>[] = [
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
  { value: "tr", label: "Türkçe" },
];

function Harness({ multiple = false }: { multiple?: boolean }) {
  const [selected, setSelected] = useState<Lang[]>(["en"]);
  return (
    <SearchableSelect
      options={OPTIONS}
      selected={selected}
      onChange={(next) => setSelected(next)}
      multiple={multiple}
      aria-label="Language"
      testId="probe.lang"
    />
  );
}

afterEach(cleanup);

describe("SearchableSelect", () => {
  it("focuses the search box on the FIRST open, not just on later ones", () => {
    render(<Harness />);

    fireEvent.click(screen.getByTestId("probe.lang"));

    // The assertion that would have failed before the fix. jsdom reproduces it
    // faithfully: `getBoundingClientRect` returns zeroes, but `coords` still
    // lands one render late, which is the whole defect.
    expect(document.activeElement).toBe(screen.getByTestId("probe.lang-search"));
  });

  it("filters the option list as the user types", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("probe.lang"));

    expect(screen.getAllByTestId("probe.lang-option")).toHaveLength(3);

    fireEvent.change(screen.getByTestId("probe.lang-search"), {
      target: { value: "deu" },
    });

    const shown = screen.getAllByTestId("probe.lang-option");
    expect(shown).toHaveLength(1);
    expect(shown[0].getAttribute("data-value")).toBe("de");
  });

  it("still focuses the search box on a second open", () => {
    render(<Harness />);
    const trigger = screen.getByTestId("probe.lang");

    fireEvent.click(trigger); // open
    fireEvent.click(trigger); // close
    fireEvent.click(trigger); // open again

    expect(document.activeElement).toBe(screen.getByTestId("probe.lang-search"));
  });

  it("summarises the selection on the trigger and replaces it in single mode", () => {
    render(<Harness />);
    const trigger = screen.getByTestId("probe.lang");
    expect(trigger.textContent).toContain("English");

    fireEvent.click(trigger);
    fireEvent.click(
      screen
        .getAllByTestId("probe.lang-option")
        .find((el) => el.getAttribute("data-value") === "tr")!,
    );

    expect(screen.getByTestId("probe.lang").textContent).toContain("Türkçe");
    // Single mode closes on choose.
    expect(screen.queryByTestId("probe.lang-menu")).toBeNull();
  });

  it("toggles without closing in multi mode", () => {
    render(<Harness multiple />);
    fireEvent.click(screen.getByTestId("probe.lang"));

    fireEvent.click(
      screen
        .getAllByTestId("probe.lang-option")
        .find((el) => el.getAttribute("data-value") === "de")!,
    );

    expect(screen.getByTestId("probe.lang-menu")).toBeTruthy();
    expect(screen.getByTestId("probe.lang").textContent).toContain("English, Deutsch");
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("probe.lang"));

    fireEvent.keyDown(screen.getByTestId("probe.lang-search"), { key: "Escape" });

    expect(screen.queryByTestId("probe.lang-menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("probe.lang"));
  });

  // This primitive already exempts its own menu from the capture-phase
  // close-on-scroll listener — and nothing asserted it, which is how the
  // identical bug survived in `Select` long after being fixed here. Both
  // directions: an exemption that swallowed every scroll would leave the fixed
  // menu drifting away from its trigger.
  describe("scrolling", () => {
    it("stays open while its OWN option list scrolls", () => {
      render(<Harness />);
      fireEvent.click(screen.getByTestId("probe.lang"));
      fireEvent.scroll(screen.getByRole("listbox"));
      expect(screen.queryByTestId("probe.lang-menu")).not.toBeNull();
    });

    it("still closes when an ANCESTOR scrolls", () => {
      render(<Harness />);
      fireEvent.click(screen.getByTestId("probe.lang"));
      fireEvent.scroll(document.body);
      expect(screen.queryByTestId("probe.lang-menu")).toBeNull();
    });
  });
});

// Keep the module's single-open coordinator from leaking between files.
afterEach(() => vi.restoreAllMocks());
