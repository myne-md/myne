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

  it("round-trips RTL through the URL and onto the stage", async () => {
    const el = await mountShell();
    const button = el.querySelector('[data-testid="stories.axis.rtl"]');
    expect(button, "the RTL control must exist").not.toBeNull();

    await act(async () => {
      fireEvent.click(button as HTMLElement);
    });

    // The URL is the contract, and the stage is where the axis has to land. The
    // catalogue's own chrome stays LTR on purpose: mirroring the rail too would
    // make the chrome the thing under review.
    expect(window.location.hash).toContain("rtl=1");
    const stage = el.querySelector('[data-testid="stories.stage"]');
    expect(stage?.getAttribute("dir")).toBe("rtl");
    expect(el.querySelector('[data-testid="stories.rail"]')?.getAttribute("dir")).toBeNull();
  });

  it("round-trips the two mirrored axes onto the stage", async () => {
    const el = await mountShell();
    for (const axis of ["reduced-motion", "forced-colors"]) {
      const button = el.querySelector(`[data-testid="stories.axis.${axis}"]`);
      expect(button, `${axis} must have a control`).not.toBeNull();
      await act(async () => {
        fireEvent.click(button as HTMLElement);
      });
      expect(window.location.hash, `${axis} must reach the URL`).toContain(`${axis}=1`);
      const stage = el.querySelector('[data-testid="stories.stage"]');
      // The marker is what the mirrored rules are scoped to, so it is the
      // observable half: whether jsdom carries the sheets is a separate question
      // and the marker is what a real browser needs.
      expect(stage?.getAttribute(`data-axis-${axis}`)).toBe("true");
    }
  });

  it("files an issue whose URL carries the story and the form", async () => {
    const el = await mountShell();
    const button = el.querySelector('[data-testid="stories.file-issue"]');
    expect(button, "the File issue button must exist").not.toBeNull();

    // `window.open` is what the button calls, so the URL is only observable by
    // intercepting it. Asserting the built string is the point: the form field
    // id and the query parameter are one contract, and a rename on either side
    // silently drops the context.
    const opened: string[] = [];
    const original = window.open;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
    await act(async () => {
      fireEvent.click(button as HTMLElement);
    });
    window.open = original;

    expect(opened.length, "one click opens one tab").toBe(1);
    const url = opened[0];
    expect(url).toContain("github.com/myne-md/myne/issues/new");
    expect(url).toContain("template=design-system.yml");
    // `URLSearchParams` encodes a space as `+`, which `decodeURIComponent` does
    // not reverse, so the `+` is decoded too rather than the assertion loosened.
    const decoded = decodeURIComponent(url).replace(/\+/g, " ");
    // The context is the whole reason this button exists.
    expect(decoded).toContain("documentation/welcome/introduction");
    expect(decoded).toContain("Theme: light");
    expect(decoded).toContain("Story: documentation/welcome/introduction");
  });
});
