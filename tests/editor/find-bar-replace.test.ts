// @vitest-environment jsdom
//
// Find-bar REPLACE affordance (MYND-302) — the view layer added on top of the
// MYND-175 find bar. Exercises:
//   - the expand/collapse toggle (one-row find by default → reveals the replace row)
//   - the replace input ↔ state sync + its onReplaceChange intent
//   - the "Replace" / "Replace all (N)" buttons + their intent handlers
//   - the count-aware "Replace all (N)" label tracking the live match total
//   - replace controls disabled when there is no live query / no matches
//   - data-testids on every replace control (E2E contract, SYNC-8)
//
// Pure presentational layer — no @codemirror/search engine here; the wiring to
// replaceNext/replaceAll lives in find-extension.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFindBarView,
  type FindBarHandlers,
  type FindBarState,
  type FindBarView,
} from "../../src/editor/find/find-bar-view";

function noopHandlers(): FindBarHandlers {
  return {
    onQueryChange: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onToggleCase: vi.fn(),
    onClose: vi.fn(),
    onToggleReplace: vi.fn(),
    onReplaceChange: vi.fn(),
    onReplaceOne: vi.fn(),
    onReplaceAll: vi.fn(),
  };
}

const IDLE: FindBarState = {
  query: "",
  caseSensitive: false,
  status: "idle",
  match: null,
  expanded: false,
  replace: "",
};

let bar: FindBarView | null = null;
afterEach(() => {
  bar?.destroy();
  bar = null;
});

const byTestId = (b: FindBarView, id: string) =>
  b.dom.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const toggleBtn = (b: FindBarView) => byTestId(b, "find.toggle-replace") as HTMLButtonElement;
const replaceRow = (b: FindBarView) => b.dom.querySelector(".cm-find-bar-replace-row") as HTMLElement | null;
const replaceInput = (b: FindBarView) => byTestId(b, "find.replace-input") as HTMLInputElement;
const replaceOneBtn = (b: FindBarView) => byTestId(b, "find.replace-one") as HTMLButtonElement;
const replaceAllBtn = (b: FindBarView) => byTestId(b, "find.replace-all") as HTMLButtonElement;

describe("find-bar replace: data-testids (E2E contract)", () => {
  it("exposes testids on the find input, toggle, replace input, and both replace buttons", () => {
    bar = createFindBarView({ ...IDLE, expanded: true }, noopHandlers());
    expect(byTestId(bar, "find.input")).not.toBeNull();
    expect(byTestId(bar, "find.toggle-replace")).not.toBeNull();
    expect(byTestId(bar, "find.replace-input")).not.toBeNull();
    expect(byTestId(bar, "find.replace-one")).not.toBeNull();
    expect(byTestId(bar, "find.replace-all")).not.toBeNull();
  });
});

describe("find-bar replace: expand / collapse toggle", () => {
  it("starts collapsed: no replace row rendered, toggle not pressed", () => {
    bar = createFindBarView(IDLE, noopHandlers());
    expect(replaceRow(bar)).toBeNull();
    expect(toggleBtn(bar).getAttribute("aria-expanded")).toBe("false");
  });

  it("expanded state renders the replace row and marks the toggle pressed", () => {
    bar = createFindBarView(IDLE, noopHandlers());
    bar.update({ ...IDLE, expanded: true });
    expect(replaceRow(bar)).not.toBeNull();
    expect(replaceInput(bar)).not.toBeNull();
    expect(toggleBtn(bar).getAttribute("aria-expanded")).toBe("true");
  });

  it("toggle is reversible: expanded → collapsed removes the replace row", () => {
    bar = createFindBarView({ ...IDLE, expanded: true }, noopHandlers());
    expect(replaceRow(bar)).not.toBeNull();
    bar.update({ ...IDLE, expanded: false });
    expect(replaceRow(bar)).toBeNull();
    expect(toggleBtn(bar).getAttribute("aria-expanded")).toBe("false");
  });

  it("clicking the toggle fires onToggleReplace", () => {
    const h = noopHandlers();
    bar = createFindBarView(IDLE, h);
    toggleBtn(bar).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(h.onToggleReplace).toHaveBeenCalledTimes(1);
  });
});

describe("find-bar replace: input ↔ state sync", () => {
  it("seeds the replace input from initial state", () => {
    bar = createFindBarView({ ...IDLE, expanded: true, replace: "seed" }, noopHandlers());
    expect(replaceInput(bar).value).toBe("seed");
  });

  it("input event forwards the live replace value", () => {
    const h = noopHandlers();
    bar = createFindBarView({ ...IDLE, expanded: true }, h);
    replaceInput(bar).value = "xyz";
    replaceInput(bar).dispatchEvent(new Event("input"));
    expect(h.onReplaceChange).toHaveBeenCalledWith("xyz");
  });

  it("re-renders the replace input only when the incoming value differs (no clobber)", () => {
    bar = createFindBarView({ ...IDLE, expanded: true }, noopHandlers());
    replaceInput(bar).value = "typed";
    bar.update({ ...IDLE, expanded: true, replace: "typed" });
    expect(replaceInput(bar).value).toBe("typed");
    bar.update({ ...IDLE, expanded: true, replace: "fromState" });
    expect(replaceInput(bar).value).toBe("fromState");
  });
});

describe("find-bar replace: button intents", () => {
  it("Replace / Replace all clicks invoke their handlers", () => {
    const h = noopHandlers();
    bar = createFindBarView(
      { ...IDLE, expanded: true, query: "a", status: "matches", match: { current: 1, total: 3 } },
      h,
    );
    replaceOneBtn(bar).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    replaceAllBtn(bar).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(h.onReplaceOne).toHaveBeenCalledTimes(1);
    expect(h.onReplaceAll).toHaveBeenCalledTimes(1);
  });

  it("replace buttons are disabled when there are no matches (idle / no-match)", () => {
    bar = createFindBarView({ ...IDLE, expanded: true }, noopHandlers());
    expect(replaceOneBtn(bar).disabled).toBe(true);
    expect(replaceAllBtn(bar).disabled).toBe(true);

    bar.update({ ...IDLE, expanded: true, query: "zzz", status: "no-match" });
    expect(replaceOneBtn(bar).disabled).toBe(true);
    expect(replaceAllBtn(bar).disabled).toBe(true);
  });

  it("replace buttons enable when the query has live matches", () => {
    bar = createFindBarView(
      { ...IDLE, expanded: true, query: "a", status: "matches", match: { current: 1, total: 3 } },
      noopHandlers(),
    );
    expect(replaceOneBtn(bar).disabled).toBe(false);
    expect(replaceAllBtn(bar).disabled).toBe(false);
  });
});

describe("find-bar replace: count-aware 'Replace all (N)' label", () => {
  it("reads the live match total in the button label", () => {
    bar = createFindBarView(
      { ...IDLE, expanded: true, query: "a", status: "matches", match: { current: 2, total: 7 } },
      noopHandlers(),
    );
    expect(replaceAllBtn(bar).textContent).toBe("Replace all (7)");
  });

  it("updates the count as the match total changes", () => {
    bar = createFindBarView(
      { ...IDLE, expanded: true, query: "a", status: "matches", match: { current: 1, total: 2 } },
      noopHandlers(),
    );
    expect(replaceAllBtn(bar).textContent).toBe("Replace all (2)");
    bar.update({
      ...IDLE,
      expanded: true,
      query: "a",
      status: "matches",
      match: { current: 1, total: 5 },
    });
    expect(replaceAllBtn(bar).textContent).toBe("Replace all (5)");
  });

  it("falls back to a bare 'Replace all' (no count) when there are no matches", () => {
    bar = createFindBarView({ ...IDLE, expanded: true, query: "zzz", status: "no-match" }, noopHandlers());
    expect(replaceAllBtn(bar).textContent).toBe("Replace all");
  });
});
