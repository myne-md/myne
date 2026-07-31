// @vitest-environment jsdom
//
// `<DiffView>` render smoke (MYND-334 task 3). The component is the one
// renderer for a `@myne/dialect` diff; the diff algorithm itself is pinned by
// `tests/dialect/diff.test.ts`, so what matters here is the painting contract
// the E2E scenarios and the conflict surface build on: one `diff.line` per
// line tagged with its type, word segments rendered as `diff.segment` spans
// that concatenate back to the line, and an unrefined line rendered as plain
// text. Pure component — no IPC, no i18n.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { DiffView } from "../../src/notes/components/DiffView";
import { diffWithSegments, lineDiff } from "../../src/dialect";

afterEach(cleanup);

/** The gutter marker is decorative; the line's real text is its segments. */
function lineText(el: HTMLElement): string {
  return (el.textContent ?? "").slice(2);
}

describe("<DiffView> — unified mode", () => {
  it("renders the container with the mode it was given", () => {
    render(<DiffView diff={lineDiff("a", "b")} mode="unified" />);
    expect(screen.getByTestId("diff.view").getAttribute("data-mode")).toBe("unified");
  });

  it("defaults to unified when no mode is passed", () => {
    render(<DiffView diff={lineDiff("a", "b")} />);
    expect(screen.getByTestId("diff.view").getAttribute("data-mode")).toBe("unified");
  });

  it("renders one tagged, indexed line per diff entry", () => {
    render(<DiffView diff={lineDiff("keep\nold", "keep\nnew")} />);
    const lines = screen.getAllByTestId("diff.line");
    expect(lines.map((l) => l.getAttribute("data-type"))).toEqual(["same", "del", "add"]);
    expect(lines.map((l) => l.getAttribute("data-index"))).toEqual(["0", "1", "2"]);
    expect(lines.map(lineText)).toEqual(["keep", "old", "new"]);
  });

  it("renders nothing but the container for an empty diff", () => {
    render(<DiffView diff={[]} />);
    expect(screen.getByTestId("diff.view").textContent).toBe("");
    expect(screen.queryAllByTestId("diff.line")).toHaveLength(0);
  });

  it("renders an unrefined line as plain text, with no segment spans", () => {
    // `lineDiff` never attaches segments, so every line takes the plain path.
    render(<DiffView diff={lineDiff("the quick fox", "the slow fox")} />);
    expect(screen.queryAllByTestId("diff.segment")).toHaveLength(0);
    expect(screen.getAllByTestId("diff.line").map(lineText)).toEqual([
      "the quick fox",
      "the slow fox",
    ]);
  });

  it("renders word segments as spans so only the changed word is marked", () => {
    render(<DiffView diff={diffWithSegments("the quick brown fox", "the slow brown fox")} />);
    const [del, add] = screen.getAllByTestId("diff.line");

    const delSegs = within(del).getAllByTestId("diff.segment");
    expect(delSegs.map((s) => s.getAttribute("data-type"))).toEqual(["same", "del", "same"]);
    expect(delSegs.map((s) => s.textContent)).toEqual(["the ", "quick", " brown fox"]);

    const addSegs = within(add).getAllByTestId("diff.segment");
    expect(addSegs.map((s) => s.getAttribute("data-type"))).toEqual(["same", "add", "same"]);
    expect(addSegs.map((s) => s.textContent)).toEqual(["the ", "slow", " brown fox"]);
  });

  it("segments concatenate back to the line's own text", () => {
    const diff = diffWithSegments("one two three", "one four three");
    render(<DiffView diff={diff} />);
    for (const line of screen.getAllByTestId("diff.line")) {
      const joined = within(line)
        .getAllByTestId("diff.segment")
        .map((s) => s.textContent)
        .join("");
      expect(joined).toBe(lineText(line));
    }
  });

  it("leaves `same` lines unsegmented even in a refined diff", () => {
    render(<DiffView diff={diffWithSegments("keep\none two", "keep\none 2")} />);
    const same = screen.getAllByTestId("diff.line")[0];
    expect(same.getAttribute("data-type")).toBe("same");
    expect(within(same).queryAllByTestId("diff.segment")).toHaveLength(0);
  });
});

// Split mode (MYND-334 task 5) folds the same one-column diff into aligned
// left/right rows. What matters is the pairing — a del must face the add it was
// refined against, and a surplus line must face an empty cell rather than
// sliding the two columns out of step.
describe("<DiffView> — split mode", () => {
  /** The cells of one side, in row order. */
  function side(which: "left" | "right"): HTMLElement[] {
    return screen
      .getAllByTestId("diff.line")
      .filter((l) => l.getAttribute("data-side") === which);
  }

  it("renders the split container and tags the mode", () => {
    render(<DiffView diff={lineDiff("a", "b")} mode="split" />);
    expect(screen.getByTestId("diff.view").getAttribute("data-mode")).toBe("split");
    expect(screen.getByTestId("diff.split")).toBeTruthy();
  });

  it("puts a `same` line on both sides of its row", () => {
    render(<DiffView diff={lineDiff("keep", "keep")} mode="split" />);
    const cells = screen.getAllByTestId("diff.line");
    expect(cells.map((c) => c.getAttribute("data-side"))).toEqual(["left", "right"]);
    expect(cells.map((c) => c.getAttribute("data-type"))).toEqual(["same", "same"]);
    expect(cells.map((c) => c.textContent)).toEqual(["keep", "keep"]);
    expect(cells.map((c) => c.getAttribute("data-index"))).toEqual(["0", "0"]);
  });

  it("faces the old line against the new one in the same row", () => {
    render(<DiffView diff={lineDiff("keep\nold", "keep\nnew")} mode="split" />);
    expect(side("left").map((c) => c.textContent)).toEqual(["keep", "old"]);
    expect(side("right").map((c) => c.textContent)).toEqual(["keep", "new"]);
    expect(side("left").map((c) => c.getAttribute("data-type"))).toEqual(["same", "del"]);
    expect(side("right").map((c) => c.getAttribute("data-type"))).toEqual(["same", "add"]);
  });

  it("faces a surplus removal against an empty cell (columns stay aligned)", () => {
    render(<DiffView diff={lineDiff("one\ntwo\nthree", "one\nthree")} mode="split" />);
    const left = side("left");
    const right = side("right");
    expect(left).toHaveLength(right.length);
    expect(left.map((c) => c.getAttribute("data-type"))).toEqual(["same", "del", "same"]);
    expect(right.map((c) => c.getAttribute("data-type"))).toEqual(["same", "empty", "same"]);
    expect(right[1]!.textContent).toBe("");
  });

  it("faces a surplus addition against an empty cell on the left", () => {
    render(<DiffView diff={lineDiff("one", "one\ntwo")} mode="split" />);
    expect(side("left").map((c) => c.getAttribute("data-type"))).toEqual(["same", "empty"]);
    expect(side("right").map((c) => c.getAttribute("data-type"))).toEqual(["same", "add"]);
  });

  it("carries the word segments into the paired cells", () => {
    render(
      <DiffView diff={diffWithSegments("the quick brown fox", "the slow brown fox")} mode="split" />,
    );
    const [del] = side("left");
    const [add] = side("right");
    expect(within(del!).getAllByTestId("diff.segment").map((s) => s.getAttribute("data-type")))
      .toEqual(["same", "del", "same"]);
    expect(within(add!).getAllByTestId("diff.segment").map((s) => s.textContent))
      .toEqual(["the ", "slow", " brown fox"]);
  });

  it("renders the column headings the host gave it, and none when it gave none", () => {
    const { unmount } = render(
      <DiffView diff={lineDiff("a", "b")} mode="split" leftLabel="Mine" rightLabel="Theirs" />,
    );
    const labels = screen.getAllByTestId("diff.column-label");
    expect(labels.map((l) => l.getAttribute("data-side"))).toEqual(["left", "right"]);
    expect(labels.map((l) => l.textContent)).toEqual(["Mine", "Theirs"]);
    unmount();

    render(<DiffView diff={lineDiff("a", "b")} mode="split" />);
    expect(screen.queryAllByTestId("diff.column-label")).toHaveLength(0);
  });

  it("renders nothing but the container for an empty diff", () => {
    render(<DiffView diff={[]} mode="split" />);
    expect(screen.getByTestId("diff.view").textContent).toBe("");
    expect(screen.queryAllByTestId("diff.line")).toHaveLength(0);
  });
});
