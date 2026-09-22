// @vitest-environment jsdom
//
// The three centre-column view modes as KEYBOARD surfaces (myne-md/myne#728,
// issue item 5).
//
// Every row in all three renderers was `role="button"` with `tabIndex={-1}` and
// no key handler. That shape is worth naming precisely, because it reads as
// finished: the role announces a control, the negative tabindex looks like the
// roving pattern the sidebar uses, and the mouse works. What it actually was is
// a control no Tab reaches and no key operates - SC 2.1.1, level A - across the
// whole of Saved Views. Nothing reported it: `role="button"` with `tabIndex=-1`
// is legal markup, axe's `focusable-element` checks the reverse direction, and
// the renderers' own specs drove every assertion through `fireEvent.click`.
//
// The cards renderer had a second defect underneath the first. Its Set cover
// button is a DESCENDANT of the card, so making the card a control at all is
// `nested-interactive`, and that button is gated on hover with no other entry
// point anywhere in the tree - a capability the mouse had and the keyboard did
// not, rather than a mouse shortcut for something both could do.
//
// Three tiers, because each catches what the others cannot: the tabindex (the
// reach), the key handlers including the modifier matrix (the operation), and
// axe over a rendered card with the cover button revealed (the nesting).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListView } from "../../src/notes/views/listView";
import { TableView } from "../../src/notes/views/tableView";
import { CardsView } from "../../src/notes/views/cardsView";
import type { SavedView } from "../../src/lib/prefs";
import type { ViewResult, ViewRow } from "../../src/notes/queryEngine";
import { formatViolations, runAxe } from "./axe-config";

afterEach(cleanup);

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

const row = (noteId: string, title: string): ViewRow => ({
  noteId,
  title,
  folder: null,
  values: {},
});

function result(): ViewResult {
  return {
    groups: [{ key: "", type: "none", rows: [row("n1", "Alpha"), row("n2", "Beta")] }],
  };
}

function def(view_type: SavedView["view_type"]): SavedView {
  return { id: "v1", name: "Reading", view_type, filters: { kind: "all" }, columns: [] };
}

/**
 * The three renderers under one description, keyed by the testid of the thing
 * that IS the control. For list and table that is the row; for cards it is the
 * content block INSIDE the card, which is the whole point of that renderer's
 * restructure - asserting against `view.card` would pass on the nested shape
 * this test exists to reject.
 */
const MODES = [
  {
    name: "list",
    control: "view.list-row",
    render: (onOpenNote?: (id: string, o: { newTab: boolean; toSide: boolean }) => void) => (
      <ListView def={def("list")} result={result()} onOpenNote={onOpenNote} />
    ),
  },
  {
    name: "table",
    control: "view.table-row",
    render: (onOpenNote?: (id: string, o: { newTab: boolean; toSide: boolean }) => void) => (
      <TableView def={def("table")} result={result()} onOpenNote={onOpenNote} />
    ),
  },
  {
    name: "cards",
    control: "view.card-open",
    render: (onOpenNote?: (id: string, o: { newTab: boolean; toSide: boolean }) => void) => (
      <CardsView def={def("cards")} result={result()} onOpenNote={onOpenNote} />
    ),
  },
] as const;

describe.each(MODES)("$name view rows are keyboard-operable", (mode) => {
  it("puts every interactive row in the Tab order", () => {
    render(mode.render(vi.fn()));
    const controls = screen.getAllByTestId(mode.control);
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) {
      expect(el.getAttribute("role")).toBe("button");
      // `0`, not `-1`. The sidebar's `-1` is the tree pattern, where the
      // container owns one stop; these carry no composite role and so own
      // their own.
      expect(el.getAttribute("tabindex")).toBe("0");
    }
  });

  it("leaves a read-only render out of the Tab order entirely", () => {
    // No `onOpenNote` means nothing to activate, so a Tab stop would be a ring
    // on something that does nothing. `interactive` gates the role AND the
    // tabindex together.
    render(mode.render(undefined));
    for (const el of screen.getAllByTestId(mode.control)) {
      expect(el.getAttribute("role")).toBeNull();
      expect(el.getAttribute("tabindex")).toBeNull();
    }
  });

  it("opens on Enter and on Space, and swallows Space so the list cannot scroll", () => {
    for (const key of ["Enter", " "]) {
      const onOpenNote = vi.fn();
      render(mode.render(onOpenNote));
      const first = screen.getAllByTestId(mode.control)[0]!;
      const notDefaulted = fireEvent.keyDown(first, { key });
      expect(onOpenNote).toHaveBeenCalledWith("n1", { newTab: false, toSide: false });
      // `fireEvent` returns false when a handler called preventDefault.
      expect(notDefaulted).toBe(false);
      cleanup();
    }
  });

  it("carries the same modifier matrix the click does", () => {
    const onOpenNote = vi.fn();
    render(mode.render(onOpenNote));
    const first = screen.getAllByTestId(mode.control)[0]!;
    fireEvent.keyDown(first, { key: "Enter", metaKey: true });
    expect(onOpenNote).toHaveBeenLastCalledWith("n1", { newTab: true, toSide: false });
    fireEvent.keyDown(first, { key: "Enter", ctrlKey: true });
    expect(onOpenNote).toHaveBeenLastCalledWith("n1", { newTab: true, toSide: false });
    fireEvent.keyDown(first, { key: "Enter", altKey: true });
    expect(onOpenNote).toHaveBeenLastCalledWith("n1", { newTab: false, toSide: true });
  });

  it("ignores a key that is not an activation", () => {
    const onOpenNote = vi.fn();
    render(mode.render(onOpenNote));
    const first = screen.getAllByTestId(mode.control)[0]!;
    // Not swallowed: arrows and typing belong to whatever else wants them.
    expect(fireEvent.keyDown(first, { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(first, { key: "a" })).toBe(true);
    expect(onOpenNote).not.toHaveBeenCalled();
  });

  it("opens the row the key came from, not the first one", () => {
    const onOpenNote = vi.fn();
    render(mode.render(onOpenNote));
    const second = screen.getAllByTestId(mode.control)[1]!;
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onOpenNote).toHaveBeenCalledWith("n2", { newTab: false, toSide: false });
  });
});

describe("the cards Set cover button", () => {
  const cardsWithCover = (onSetCover: (id: string) => void) => (
    <CardsView
      def={def("cards")}
      result={result()}
      onOpenNote={vi.fn()}
      onSetCover={onSetCover}
    />
  );

  it("is revealed by focus, not by hover alone", () => {
    // It is the only entry point the feature has anywhere in the tree, so
    // hover-gating it made setting a cover a mouse-only capability.
    render(cardsWithCover(vi.fn()));
    expect(screen.queryByTestId("view.card-set-cover")).toBeNull();
    fireEvent.focus(screen.getAllByTestId("view.card-open")[0]!);
    expect(screen.getAllByTestId("view.card-set-cover").length).toBeGreaterThan(0);
    fireEvent.blur(screen.getAllByTestId("view.card-open")[0]!);
    expect(screen.queryByTestId("view.card-set-cover")).toBeNull();
  });

  it("still works, and does not also open the note", () => {
    const onSetCover = vi.fn();
    const onOpenNote = vi.fn();
    render(
      <CardsView
        def={def("cards")}
        result={result()}
        onOpenNote={onOpenNote}
        onSetCover={onSetCover}
      />,
    );
    fireEvent.focus(screen.getAllByTestId("view.card-open")[0]!);
    fireEvent.click(screen.getAllByTestId("view.card-set-cover")[0]!);
    expect(onSetCover).toHaveBeenCalledWith("n1");
    expect(onOpenNote).not.toHaveBeenCalled();
  });

  it("comes after the card's content in reading order", () => {
    // Revealed BY focus on the content block, so rendering it before that
    // block put it before the only thing that can reveal it: forward Tab
    // skipped to the next card and the control was reachable only by
    // Shift+Tab into a button that had not existed a moment earlier.
    render(cardsWithCover(vi.fn()));
    const content = screen.getAllByTestId("view.card-open")[0]!;
    fireEvent.focus(content);
    const cover = screen.getAllByTestId("view.card-set-cover")[0]!;
    expect(
      content.compareDocumentPosition(cover) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the reveal button must follow the element whose focus reveals it",
    ).toBeTruthy();
  });

  it("is not nested inside the card's control", async () => {
    // The assertion axe makes for us below, stated directly too: a control
    // inside a control is the defect, and the structural check says WHICH
    // nesting axe would be complaining about if the rule ever changes name.
    const { container } = render(cardsWithCover(vi.fn()));
    fireEvent.focus(screen.getAllByTestId("view.card-open")[0]!);
    const coverButton = screen.getAllByTestId("view.card-set-cover")[0]!;
    expect(coverButton.closest('[data-testid="view.card-open"]')).toBeNull();
    expect(coverButton.closest('[data-testid="view.card"]')).not.toBeNull();

    const results = await runAxe(container);
    expect(results.violations, formatViolations(results)).toHaveLength(0);
  });
});
