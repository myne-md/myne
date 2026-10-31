// @vitest-environment jsdom
//
// Find-bar VIEW (MYND-175, Task 1) — pure presentational layer, no engine.
// Exercises its three render states (idle / matches / no-match), the case-toggle
// pressed state, nav enablement, the a11y live region, input↔state sync, and the
// intent handlers wired to DOM events. Catches regressions where a status string,
// disabled flag, aria attribute, or handler wire silently drifts.

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
  dateFallback: null,
};

let bar: FindBarView | null = null;
afterEach(() => {
  bar?.destroy();
  bar = null;
});

const status = (b: FindBarView) =>
  b.dom.querySelector(".cm-find-bar-status") as HTMLElement;
const live = (b: FindBarView) =>
  b.dom.querySelector(".cm-find-bar-a11y") as HTMLElement;
const caseBtn = (b: FindBarView) =>
  b.dom.querySelector(".cm-find-bar-case") as HTMLButtonElement;
const prevBtn = (b: FindBarView) =>
  b.dom.querySelector(".cm-find-bar-prev") as HTMLButtonElement;
const nextBtn = (b: FindBarView) =>
  b.dom.querySelector(".cm-find-bar-next") as HTMLButtonElement;

describe("find-bar view: render states", () => {
  it("idle (empty query) hides the status and disables nav", () => {
    bar = createFindBarView(IDLE, noopHandlers());
    expect(status(bar).textContent).toBe("");
    expect(status(bar).className).toContain("cm-find-bar-status--hidden");
    expect(live(bar).textContent).toBe("");
    expect(prevBtn(bar).disabled).toBe(true);
    expect(nextBtn(bar).disabled).toBe(true);
  });

  it("matches state shows 'k/N' count, a spoken 'k of N', and enables nav", () => {
    bar = createFindBarView(IDLE, noopHandlers());
    bar.update({
      query: "foo",
      caseSensitive: false,
      status: "matches",
      match: { current: 3, total: 12 },
      expanded: false,
      replace: "",
      dateFallback: null,
    });
    expect(status(bar).textContent).toBe("3/12");
    expect(status(bar).className).toContain("cm-find-bar-status--count");
    expect(live(bar).textContent).toBe("3 of 12");
    expect(prevBtn(bar).disabled).toBe(false);
    expect(nextBtn(bar).disabled).toBe(false);
  });

  it("no-match state shows the muted 'No matches' caption and disables nav", () => {
    bar = createFindBarView(IDLE, noopHandlers());
    bar.update({
      query: "zzz",
      caseSensitive: false,
      status: "no-match",
      match: null,
      expanded: false,
      replace: "",
      dateFallback: null,
    });
    expect(status(bar).textContent).toBe("No matches");
    expect(status(bar).className).toContain("cm-find-bar-status--nomatch");
    expect(live(bar).textContent).toBe("No matches");
    expect(prevBtn(bar).disabled).toBe(true);
    expect(nextBtn(bar).disabled).toBe(true);
  });

  it("'matches' status without a match payload falls through to idle (no '0/0')", () => {
    bar = createFindBarView(IDLE, noopHandlers());
    // Defensive branch: status==="matches" but match===null must not crash and
    // must not render a bogus count.
    bar.update({
      query: "foo",
      caseSensitive: false,
      status: "matches",
      match: null,
      expanded: false,
      replace: "",
      dateFallback: null,
    });
    expect(status(bar).textContent).toBe("");
    expect(status(bar).className).toContain("cm-find-bar-status--hidden");
  });
});

describe("find-bar view: case toggle", () => {
  it("reflects the pressed state via class + aria-pressed", () => {
    bar = createFindBarView(IDLE, noopHandlers());
    expect(caseBtn(bar).getAttribute("aria-pressed")).toBe("false");
    expect(caseBtn(bar).classList.contains("cm-find-bar-btn-active")).toBe(false);

    bar.update({ ...IDLE, caseSensitive: true });
    expect(caseBtn(bar).getAttribute("aria-pressed")).toBe("true");
    expect(caseBtn(bar).classList.contains("cm-find-bar-btn-active")).toBe(true);
  });

  it("seeds aria-pressed from the initial state", () => {
    bar = createFindBarView({ ...IDLE, caseSensitive: true }, noopHandlers());
    expect(caseBtn(bar).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("find-bar view: input ↔ state sync", () => {
  it("seeds the input from the initial query", () => {
    bar = createFindBarView({ ...IDLE, query: "hello" }, noopHandlers());
    expect(bar.input.value).toBe("hello");
  });

  it("re-renders the input only when the incoming query differs (no clobber)", () => {
    bar = createFindBarView(IDLE, noopHandlers());
    // User typed into the field; a same-query re-render must NOT reset it.
    bar.input.value = "typed";
    bar.update({ ...IDLE, query: "typed", status: "no-match" });
    expect(bar.input.value).toBe("typed");
    // A genuinely different query DOES overwrite (programmatic prefill).
    bar.update({ ...IDLE, query: "prefilled" });
    expect(bar.input.value).toBe("prefilled");
  });
});

describe("find-bar view: intent handlers", () => {
  it("input event forwards the live query value", () => {
    const h = noopHandlers();
    bar = createFindBarView(IDLE, h);
    bar.input.value = "abc";
    bar.input.dispatchEvent(new Event("input"));
    expect(h.onQueryChange).toHaveBeenCalledWith("abc");
  });

  it("button clicks invoke their respective handlers", () => {
    const h = noopHandlers();
    bar = createFindBarView(IDLE, h);
    caseBtn(bar).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    nextBtn(bar).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    prevBtn(bar).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    (bar.dom.querySelector(".cm-find-bar-close") as HTMLButtonElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(h.onToggleCase).toHaveBeenCalledTimes(1);
    expect(h.onNext).toHaveBeenCalledTimes(1);
    expect(h.onPrev).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("destroy() aborts listeners so post-destroy events no longer fire handlers", () => {
    const h = noopHandlers();
    bar = createFindBarView(IDLE, h);
    const input = bar.input;
    bar.destroy();
    bar = null;
    input.dispatchEvent(new Event("input"));
    expect(h.onQueryChange).not.toHaveBeenCalled();
  });
});

// Reading order (myne#952).
//
// The bar was three different shapes in one release: full width with the input
// stretched across the note, then compact and pushed to the right edge, then
// this. The owner's correction was about WHERE the reader starts, which no
// render-state test above can see — they all query by class. So this group pins
// the DOM ORDER itself, and the two things that order depends on: the input
// leading its row, both rows wrapping their input in a field (that is what puts
// the two inputs' text at the same x), and the close button staying last.
describe("find-bar view: reading order", () => {
  it("puts the query field first in the find row", () => {
    bar = createFindBarView(IDLE, noopHandlers());
    const row = bar.dom.querySelector(".cm-find-bar-find-row") as HTMLElement;
    const first = row.firstElementChild as HTMLElement;
    expect(first.className).toContain("cm-find-bar-field");
    // The FIELD leads the row, not a control or an icon column: the input is
    // what the bar exists for.
    expect(first.firstElementChild?.classList.contains("cm-find-bar-lead")).toBe(
      true,
    );
    expect(first.querySelector("input")).toBe(bar.input);
  });

  it("orders the controls after the field, with close last", () => {
    bar = createFindBarView(IDLE, noopHandlers());
    const row = bar.dom.querySelector(".cm-find-bar-find-row") as HTMLElement;
    // Spelled out in full rather than compared pairwise: a pairwise check with
    // `indexOf` reads -1 for a row that is MISSING, and -1 is less than every
    // real index, so deleting the field outright passes every comparison
    // (measured — that is how this test was first written). The whole sequence
    // also forces the next person who adds a control to say where it goes.
    const order = Array.from(row.children)
      .map((el) => el.className)
      .filter((c) => !c.includes("cm-find-bar-divider"));
    expect(order).toEqual([
      "cm-find-bar-field",
      "cm-find-bar-status cm-find-bar-status--hidden",
      "cm-find-bar-btn cm-find-bar-case",
      "cm-find-bar-btn cm-find-bar-prev",
      "cm-find-bar-btn cm-find-bar-next",
      "cm-find-bar-btn cm-find-bar-toggle",
      "cm-find-bar-btn cm-find-bar-close",
      "cm-find-bar-a11y",
    ]);
  });

  it("wraps the replace input in a field too, so both rows start at one x", () => {
    const h = noopHandlers();
    bar = createFindBarView({ ...IDLE, expanded: true }, h);
    bar.update({ ...IDLE, expanded: true });
    const replaceRow = bar.dom.querySelector(
      ".cm-find-bar-replace-row",
    ) as HTMLElement;
    const first = replaceRow.firstElementChild as HTMLElement;
    expect(first.className).toContain("cm-find-bar-field");
    expect(first.querySelector(".cm-find-bar-replace-input")).not.toBeNull();
  });
});
