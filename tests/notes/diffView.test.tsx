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
