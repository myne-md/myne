// @vitest-environment jsdom
//
// The sidebar's two trees each keep a Tab stop (myne-md/myne#728, review).
//
// `NoteList` cannot be rendered in jsdom without a provider harness that does
// not exist, so these drive the two RULES directly against a fabricated DOM of
// the shape the component produces. That is a real limitation and worth
// stating: what is pinned here is the logic, and `e2e/a11y-keyboard.e2e.ts`
// AK-2 is what exercises the rendered article.
//
// Two defects, both found by review rather than by any gate, and both invisible
// to every compiler:
//
//   1. The Favorites block was declared `role="tree"` with no `tabIndex` and no
//      `onKeyDown`, and `NoteRow` gives the roving Tab stop to the TREE copy of
//      a favourited note and never to the Favorites one. So every row in it was
//      `-1` as well, and the block announced a tree to a screen reader that no
//      keyboard could enter by any route.
//
//   2. The main tree's `treeOwnsTabStop` was measured by a dependency-array-less
//      `useEffect`, which runs when its own component renders. The thing it
//      measures is mounted by `VirtualList`, which re-renders on SCROLL from its
//      own internal state without re-rendering the parent. So scrolling the
//      selected row out of the window left the flag `true` over a tree with no
//      `tabindex="0"` in it, and the container held `tabIndex={-1}` believing a
//      row had the stop. The whole sidebar then had no Tab stop at all,
//      reachable by turning a wheel.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import {
  makeTreeKeydownHandler,
  useRowOwnsTabStop,
} from "../../src/notes/components/NoteList";

afterEach(cleanup);

/** `fireEvent.keyDown` returns false when a handler called preventDefault. */
function fireKey(el: HTMLElement, key: string): boolean {
  return fireEvent.keyDown(el, { key, bubbles: true });
}

/**
 * A minimal host for the REAL hook. The tree markup is fabricated because
 * `NoteList` needs a provider harness that does not exist, but the
 * measurement itself is `useRowOwnsTabStop` imported from the component,
 * not a copy of it: a harness that reimplemented the effect would stay green
 * with the fix reverted, which is a fixture that cannot hold the defect.
 */
function TreeHarness({ rows }: { rows: readonly { id: string; stop: boolean }[] }) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const owns = useRowOwnsTabStop(treeRef);
  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label="Notes"
      data-testid="tree"
      tabIndex={owns ? -1 : 0}
    >
      {rows.map((r) => (
        <div key={r.id} role="treeitem" data-note-id={r.id} tabIndex={r.stop ? 0 : -1}>
          {r.id}
        </div>
      ))}
    </div>
  );
}

describe("the tree container yields its Tab stop only while a row holds one", () => {
  it("takes the stop when no row has one", () => {
    render(<TreeHarness rows={[{ id: "a", stop: false }]} />);
    expect(screen.getByTestId("tree").getAttribute("tabindex")).toBe("0");
  });

  it("yields the stop when a row has one", async () => {
    render(<TreeHarness rows={[{ id: "a", stop: true }]} />);
    await waitFor(() =>
      expect(screen.getByTestId("tree").getAttribute("tabindex")).toBe("-1"),
    );
  });

  it("takes the stop back when the virtualizer unmounts that row", async () => {
    // THE defect. The row is removed from OUTSIDE React, which is what
    // `VirtualList` effectively does to this component: it re-renders from its
    // own state and the parent never hears. A render-driven measurement stays
    // stale here and the sidebar loses its only Tab stop.
    render(<TreeHarness rows={[{ id: "a", stop: true }]} />);
    const tree = screen.getByTestId("tree");
    await waitFor(() => expect(tree.getAttribute("tabindex")).toBe("-1"));

    tree.querySelector('[data-note-id="a"]')?.remove();

    await waitFor(() =>
      expect(
        tree.getAttribute("tabindex"),
        "container must retake the Tab stop when the last stop-holding row leaves the window",
      ).toBe("0"),
    );
  });

  it("yields again when the row scrolls back in", async () => {
    // The mirror case: without re-measuring, the container keeps `0` beside a
    // row that also has `0`, which is two Tab stops for one group.
    render(<TreeHarness rows={[{ id: "a", stop: false }]} />);
    const tree = screen.getByTestId("tree");
    expect(tree.getAttribute("tabindex")).toBe("0");

    const row = document.createElement("div");
    row.setAttribute("role", "treeitem");
    row.setAttribute("tabindex", "0");
    tree.appendChild(row);

    await waitFor(() => expect(tree.getAttribute("tabindex")).toBe("-1"));
  });

  it("re-measures when tabindex MOVES between mounted rows", async () => {
    // Neither row enters or leaves; only the attribute moves. `childList`
    // alone would miss this, which is why the observer also watches
    // `tabindex`.
    render(
      <TreeHarness
        rows={[
          { id: "a", stop: true },
          { id: "b", stop: false },
        ]}
      />,
    );
    const tree = screen.getByTestId("tree");
    await waitFor(() => expect(tree.getAttribute("tabindex")).toBe("-1"));

    tree.querySelector('[data-note-id="a"]')?.setAttribute("tabindex", "-1");
    await waitFor(() => expect(tree.getAttribute("tabindex")).toBe("0"));
  });
});

describe("the Favorites tree is enterable", () => {
  // Its container is unconditionally the Tab stop, unlike the main tree's
  // measured one: no Favorites row can ever own a stop, because `NoteRow`
  // gives it to the tree copy of a favourited note by design, so there is
  // nothing to measure and a measured `tabIndex` would be permanently `0`
  // with extra steps.

  function favTree(ids: readonly string[], handlers: {
    select: (id: string) => void;
    open: (id: string) => void;
  }) {
    const ref = { current: null as HTMLDivElement | null };
    const onKeyDown = makeTreeKeydownHandler({
      rowsOf: () =>
        ref.current === null
          ? []
          : Array.from(ref.current.querySelectorAll<HTMLElement>('[role="treeitem"]')),
      select: handlers.select,
      open: handlers.open,
      toggleFolder: () => {},
      renaming: false,
    });
    function Fav() {
      return (
        <div
          ref={(el) => {
            ref.current = el;
          }}
          role="tree"
          aria-label="Favorites"
          data-testid="fav"
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          {ids.map((id) => (
            <div key={id} role="treeitem" data-note-id={id} tabIndex={-1}>
              {id}
            </div>
          ))}
        </div>
      );
    }
    return render(<Fav />);
  }

  it("is in the Tab order even though none of its rows are", () => {
    favTree(["n1", "n2"], { select: vi.fn(), open: vi.fn() });
    expect(screen.getByTestId("fav").getAttribute("tabindex")).toBe("0");
    for (const row of screen.getAllByRole("treeitem")) {
      expect(row.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("moves the selection on ArrowDown from one of its own rows", () => {
    const select = vi.fn();
    favTree(["n1", "n2"], { select, open: vi.fn() });
    const rows = screen.getAllByRole("treeitem");
    rows[0]!.focus();
    const handled = !fireKey(rows[0]!, "ArrowDown");
    expect(handled, "the handler claims the key").toBe(true);
    expect(select).toHaveBeenCalledWith("n2");
  });

  it("opens on Enter from one of its own rows", () => {
    const open = vi.fn();
    favTree(["n1", "n2"], { select: vi.fn(), open });
    const rows = screen.getAllByRole("treeitem");
    fireKey(rows[1]!, "Enter");
    expect(open).toHaveBeenCalledWith("n2");
  });
});
