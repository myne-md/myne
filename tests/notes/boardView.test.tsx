// @vitest-environment jsdom
//
// The board renderer (myne-md/myne#922 task 4). Behavior-level: render
// `BoardView` / `ViewRenderHost` with a fabricated view + result and assert the
// lane order, the empty lane that must stay, the stated no-`group_by` surface,
// the card component it reuses, and that a lane's scroll position belongs to the
// lane (a data change re-renders a lane; it does not remount it).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BoardView } from "../../src/notes/views/boardView";
import { ViewRenderHost } from "../../src/notes/views/viewRenderHost";
import type { SavedView } from "../../src/lib/prefs";
import type { ViewResult, ViewRow } from "../../src/notes/queryEngine";

afterEach(cleanup);

function boardDef(over: Partial<SavedView> = {}): SavedView {
  return {
    id: "b1",
    name: "Release board",
    view_type: "board",
    filters: { kind: "all" },
    group_by: "status",
    ...over,
  };
}

function row(noteId: string, title: string): ViewRow {
  return { noteId, title, folder: null, values: {} };
}

function result(): ViewResult {
  return {
    groups: [
      { key: "Doing", type: "string", rows: [row("n1", "Draft the guide")] },
      { key: "Backlog", type: "string", rows: [row("n2", "Pick a name")] },
    ],
  };
}

describe("BoardView", () => {
  it("renders one lane per derived value, in the declared order", () => {
    render(
      <BoardView
        def={boardDef({ lanes: ["Backlog", "Doing", "Done"] })}
        result={result()}
      />,
    );
    const lanes = screen.getAllByTestId("view.lane");
    expect(lanes.map((lane) => lane.getAttribute("data-lane-value"))).toEqual([
      "Backlog",
      "Doing",
      "Done",
    ]);
    expect(screen.getByTestId("view.board")).toBeTruthy();
  });

  it("keeps a declared lane on screen with its stated empty line", () => {
    render(
      <BoardView
        def={boardDef({ lanes: ["Backlog", "Doing", "Done"] })}
        result={result()}
      />,
    );
    const done = screen
      .getAllByTestId("view.lane")
      .find((lane) => lane.getAttribute("data-lane-value") === "Done")!;
    expect(within(done).getByTestId("view.lane-empty").textContent).toBe(
      "No cards",
    );
    expect(within(done).queryByTestId("view.card")).toBeNull();
    // …and the heading still counts the lane, at zero.
    expect(within(done).getByTestId("view.lane-heading").textContent).toContain(
      "0",
    );
  });

  it("appends a data lane the declaration does not name", () => {
    const withExtra: ViewResult = {
      groups: [
        ...result().groups,
        { key: "Blocked", type: "string", rows: [row("n3", "Waiting on review")] },
      ],
    };
    render(<BoardView def={boardDef({ lanes: ["Doing"] })} result={withExtra} />);
    expect(
      screen.getAllByTestId("view.lane").map((l) => l.getAttribute("data-lane-value")),
    ).toEqual(["Doing", "Backlog", "Blocked"]);
  });

  it("states the missing lane property instead of rendering a mystery board", () => {
    const ungrouped: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Draft the guide")] }],
    };
    render(<BoardView def={boardDef({ group_by: undefined })} result={ungrouped} />);
    const note = screen.getByTestId("view.board-no-group-by");
    expect(note.textContent).toContain("no lane property");
    // The single lane is still rendered; the line explains WHY it is single.
    expect(screen.getAllByTestId("view.lane")).toHaveLength(1);
    expect(screen.getAllByTestId("view.card")).toHaveLength(1);
  });

  it("renders no explanation when the view names a lane property", () => {
    render(<BoardView def={boardDef()} result={result()} />);
    expect(screen.queryByTestId("view.board-no-group-by")).toBeNull();
  });

  it("mounts the shared card, so a board card is the gallery's card", () => {
    const onOpenNote = vi.fn();
    render(
      <BoardView
        def={boardDef({ lanes: ["Doing"], columns: ["owner"] })}
        result={result()}
        onOpenNote={onOpenNote}
      />,
    );
    const card = screen.getAllByTestId("view.card")[0]!;
    expect(card.getAttribute("data-note-id")).toBe("n1");
    expect(card.textContent).toContain("Draft the guide");
    // The card's own gesture matrix travels with it, not a board copy of it.
    fireEvent.click(card);
    expect(onOpenNote).toHaveBeenCalledWith("n1", { newTab: false, toSide: false });
  });

  it("scrolls each lane independently and survives a data change", () => {
    const many = (prefix: string): ViewRow[] =>
      Array.from({ length: 40 }, (_, i) => row(`${prefix}${i}`, `${prefix} ${i}`));
    const first: ViewResult = {
      groups: [
        { key: "Doing", type: "string", rows: many("d") },
        { key: "Done", type: "string", rows: many("x") },
      ],
    };
    const { rerender } = render(
      <BoardView def={boardDef({ lanes: ["Doing", "Done"] })} result={first} />,
    );
    const laneOf = (value: string) =>
      screen
        .getAllByTestId("view.lane")
        .find((lane) => lane.getAttribute("data-lane-value") === value)!;
    const doingScroll = within(laneOf("Doing")).getByTestId("view.lane-scroll");
    const doneScroll = within(laneOf("Done")).getByTestId("view.lane-scroll");
    // Each lane owns a scroller, not one shared column scroller.
    expect(doingScroll).not.toBe(doneScroll);
    doingScroll.scrollTop = 240;

    // A data change in the SAME lane: one more card arrives.
    const changed: ViewResult = {
      groups: [
        {
          key: "Doing",
          type: "string",
          rows: [...many("d"), row("d-new", "A new card")],
        },
        { key: "Done", type: "string", rows: many("x") },
      ],
    };
    rerender(<BoardView def={boardDef({ lanes: ["Doing", "Done"] })} result={changed} />);

    const after = within(laneOf("Doing")).getByTestId("view.lane-scroll");
    // Same element (the lane is keyed by its value, so it re-renders rather than
    // remounting) and the same offset: a reader who scrolled is where they were.
    expect(after).toBe(doingScroll);
    expect(after.scrollTop).toBe(240);
  });

  it("renders the stated empty surface when nothing matches", () => {
    render(<BoardView def={boardDef()} result={{ groups: [] }} />);
    expect(screen.getByTestId("view.empty").textContent).toBe(
      "No notes match this view",
    );
    expect(screen.queryByTestId("view.lane")).toBeNull();
  });
});

describe("ViewRenderHost dispatch", () => {
  it("renders BoardView for a board view, not the gallery", () => {
    render(<ViewRenderHost def={boardDef()} result={result()} />);
    expect(screen.getByTestId("view.board")).toBeTruthy();
    expect(screen.queryByTestId("view.cards")).toBeNull();
    expect(screen.queryByTestId("view.table")).toBeNull();
    expect(screen.queryByTestId("view.list")).toBeNull();
  });

  it("keeps a board out of the other three renderers", () => {
    for (const view_type of ["cards", "table", "list"] as const) {
      const { unmount } = render(
        <ViewRenderHost def={boardDef({ view_type })} result={result()} />,
      );
      expect(screen.queryByTestId("view.board")).toBeNull();
      unmount();
    }
  });
});
