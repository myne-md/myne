// @vitest-environment jsdom
//
// The graph's list view (myne-md/myne#727). This is the accessible half of the
// feature: the canvas cannot be read, so this list IS what a screen reader gets,
// and what a keyboard user navigates. It is generated from the SAME model the
// canvas draws, which is why the assertions here are about the model reaching
// the text rather than about formatting.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GraphList } from "../../src/notes/components/GraphList";
import type { GraphModel } from "../../src/notes/graphModel";

afterEach(cleanup);

const model: GraphModel = {
  nodes: [
    { id: "a", title: "Alpha" },
    { id: "b", title: "Bravo" },
    { id: "c", title: "Charlie" },
    { id: "d", title: null },
  ],
  edges: [
    { source: "a", target: "b", weight: 1 },
    { source: "c", target: "a", weight: 1 },
  ],
};

const rowIds = () =>
  screen
    .getAllByTestId("editor.graph-list-row")
    .map((el) => el.getAttribute("data-note-id"));

describe("GraphList", () => {
  it("renders one row per node in the model it is given", () => {
    render(<GraphList model={model} onOpen={() => {}} onOpenTag={() => {}} />);
    expect(rowIds().sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("puts the most connected note first, and breaks ties by title", () => {
    render(<GraphList model={model} onOpen={() => {}} onOpenTag={() => {}} />);
    // Alpha has two links; Bravo and Charlie one each; the untitled note none.
    expect(rowIds()[0]).toBe("a");
    expect(rowIds()[3]).toBe("d");
  });

  it("states each note's link count as a plural", () => {
    render(<GraphList model={model} onOpen={() => {}} onOpenTag={() => {}} />);
    expect(screen.getByText("2 links")).toBeTruthy();
    expect(screen.getAllByText("1 link").length).toBe(2);
  });

  it("names the notes it links to and the notes that link to it", () => {
    // The relationships are the whole point of the graph: a list that only
    // named the notes would be a note list, which the sidebar already is.
    render(<GraphList model={model} onOpen={() => {}} onOpenTag={() => {}} />);
    expect(screen.getByText("Links to: Bravo")).toBeTruthy();
    expect(screen.getByText("Linked from: Charlie")).toBeTruthy();
  });

  it("carries an untitled note rather than dropping it", () => {
    render(<GraphList model={model} onOpen={() => {}} onOpenTag={() => {}} />);
    expect(screen.getByText("Untitled note")).toBeTruthy();
  });

  it("navigates through the same callback the canvas uses", () => {
    const onOpen = vi.fn();
    render(<GraphList model={model} onOpen={onOpen} onOpenTag={() => {}} />);
    screen.getByText("Bravo").closest("button")?.click();
    expect(onOpen).toHaveBeenCalledWith("b");
  });

  it("survives an edge whose endpoint is outside the model", () => {
    // A filtered view can hold an edge the model does not have nodes for; the
    // list must not invent a connection line for a note it cannot open.
    const partial: GraphModel = {
      nodes: [{ id: "a", title: "Alpha" }],
      edges: [{ source: "a", target: "ghost", weight: 1 }],
    };
    render(<GraphList model={partial} onOpen={() => {}} onOpenTag={() => {}} />);
    expect(rowIds()).toEqual(["a"]);
    expect(screen.getByText("0 links")).toBeTruthy();
  });

  it("renders an empty model without crashing", () => {
    render(<GraphList model={{ nodes: [], edges: [] }} onOpen={() => {}} onOpenTag={() => {}} />);
    expect(screen.queryAllByTestId("editor.graph-list-row").length).toBe(0);
  });

  it("gives a tag node its own row, and selecting it FILTERS rather than opening", () => {
    // myne-md/myne#727 task 18. A tag node has no note behind it, so a row that
    // called `onOpen` with a `tag:…` id would ask the workspace for a note that
    // cannot exist. The two callbacks are the assertion: `onOpen` must NOT fire.
    const onOpen = vi.fn();
    const onOpenTag = vi.fn();
    const withTag: GraphModel = {
      nodes: [
        { id: "a", title: "Alpha" },
        { id: "tag:work", title: "#work", kind: "tag" },
      ],
      edges: [{ source: "tag:work", target: "a", weight: 1 }],
    };
    render(<GraphList model={withTag} onOpen={onOpen} onOpenTag={onOpenTag} />);

    const tagRow = screen.getByTestId("editor.graph-list-tag");
    expect(tagRow.getAttribute("data-tag-key")).toBe("work");
    // A tag row is not a note row, so it carries no note id and is absent from
    // the note-row query a scenario counts.
    expect(tagRow.getAttribute("data-note-id")).toBeNull();
    expect(rowIds()).toEqual(["a"]);

    tagRow.click();
    expect(onOpenTag).toHaveBeenCalledWith("work");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("does not list a tag row's members as connection titles", () => {
    // The count is the whole of what a tag row says: its "links to" list would
    // be every note carrying the tag, which buries the rows below it.
    const withTag: GraphModel = {
      nodes: [
        { id: "a", title: "Alpha" },
        { id: "b", title: "Bravo" },
        { id: "tag:work", title: "#work", kind: "tag" },
      ],
      edges: [
        { source: "tag:work", target: "a", weight: 1 },
        { source: "tag:work", target: "b", weight: 1 },
      ],
    };
    render(<GraphList model={withTag} onOpen={() => {}} onOpenTag={() => {}} />);
    const tagRow = screen.getByTestId("editor.graph-list-tag");
    expect(tagRow.textContent).toContain("2 links");
    expect(tagRow.textContent).not.toContain("Alpha");
    expect(tagRow.textContent).not.toContain("Bravo");
  });
});
