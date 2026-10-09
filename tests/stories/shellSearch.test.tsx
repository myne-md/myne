// @vitest-environment jsdom
//
// The catalogue shell's search and filter (myne-md/myne#845).
//
// The shell is not a story, so neither the smoke check nor the a11y gate reaches
// it: those mount `story.render()`, and this is the chrome around it. That left
// the navbar's behaviour verified by nothing, which is the same "no evidence"
// gap the guards elsewhere in this repo exist to close.
//
// The rule under test is the one the search changed shape for: search PROPOSES
// destinations and must not touch the rail, and the rail's narrowing belongs to
// the separate filter. The first version conflated them, so typing replaced the
// whole tree with a flat "matches" list and the reader lost their place in the
// hierarchy.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { App } from "../../stories/src/App";

/** Mount the shell on a known story. */
async function mountShell(): Promise<HTMLElement> {
  window.location.hash = "#documentation/welcome/introduction";
  let container: HTMLElement | null = null;
  await act(async () => {
    container = render(<App />).container;
  });
  return container as unknown as HTMLElement;
}

const searchInput = (el: HTMLElement): HTMLInputElement => {
  const input = el.querySelector('[data-testid="stories.search"]');
  if (input === null) throw new Error("no search input");
  return input as HTMLInputElement;
};

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
});

describe("the catalogue shell's search proposes rather than filters", () => {
  it("opens a suggestion panel under the input as you type", async () => {
    const el = await mountShell();
    const input = searchInput(el);

    await act(async () => {
      fireEvent.change(input, { target: { value: "sync" } });
    });

    const panel = el.querySelector('[data-testid="stories.search-results"]');
    expect(panel, "typing must open the panel").not.toBeNull();
    expect(panel?.getAttribute("role")).toBe("listbox");
    // A query with no hits is a panel that says so, not a silent no-op.
    expect((panel?.textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  it("does NOT narrow the rail", async () => {
    const el = await mountShell();
    // Baseline: the rail carries the documentation section.
    const before = el.querySelector('[data-testid="stories.item.Welcome"]');
    expect(before, "the welcome entry must exist before searching").not.toBeNull();

    await act(async () => {
      fireEvent.change(searchInput(el), { target: { value: "sync" } });
    });

    // The whole point: the rail is untouched, because the query is not a filter.
    expect(
      el.querySelector('[data-testid="stories.item.Welcome"]'),
      "search must not remove rail entries",
    ).not.toBeNull();
  });

  it("exposes the filter as its own control", async () => {
    const el = await mountShell();
    const filter = el.querySelector('[data-testid="stories.filter"]');
    expect(filter, "the filter control must exist").not.toBeNull();
    // It is a labelled control, not a decorative icon.
    const trigger = filter?.querySelector('[aria-label="Filter the rail by group"]');
    expect(trigger, "the filter needs an accessible name").not.toBeNull();
  });

  it("closes the panel on Escape", async () => {
    const el = await mountShell();
    const input = searchInput(el);
    await act(async () => {
      fireEvent.change(input, { target: { value: "sync" } });
    });
    expect(el.querySelector('[data-testid="stories.search-results"]')).not.toBeNull();

    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(el.querySelector('[data-testid="stories.search-results"]')).toBeNull();
  });
});
