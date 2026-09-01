// @vitest-environment jsdom
//
// The bottom tab bar's fifth column (myne-md/myne#457).
//
// **What is under test is the COLUMN BUDGET, not the icon.** The bar is
// top-level navigation on a phone, so a fifth column is a fifth of the width
// taken from the four that were there, and every claim this file makes is about
// that trade: the column appears exactly when `ai_enabled` is on, it is last so
// no existing column moves, and its label is contained so a long translation
// truncates instead of crossing into its neighbour.
//
// It is a component test rather than a flow test on purpose. The two `TabBar`
// call sites in `EditorFlow` are separate renders (compact, and medium with the
// panes collapsed), and the failure this file is aimed at is one of them being
// updated and not the other. That is a compile-time property now, because `ai`
// is a REQUIRED prop, and the test below that names both call sites is the
// reason it is required rather than defaulted.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { TabBar } from "../../src/app/flows/editor/chrome/TabBar";

afterEach(cleanup);

function renderBar(overrides: Partial<Parameters<typeof TabBar>[0]> = {}) {
  const onChat = vi.fn();
  render(
    <TabBar
      active="notes"
      ai={false}
      onNotes={vi.fn()}
      onTasks={vi.fn()}
      onGraph={vi.fn()}
      onAttachments={vi.fn()}
      onChat={onChat}
      {...overrides}
    />,
  );
  return { onChat };
}

/** Every button in the bar, in render order. */
function columns(): string[] {
  return Array.from(screen.getByTestId("workspace.tab-bar").querySelectorAll("button")).map(
    (b) => b.getAttribute("data-testid") ?? "",
  );
}

describe("TabBar", () => {
  it("is exactly the four columns it was when AI is off", () => {
    renderBar({ ai: false });

    // An exact list rather than a count. A count passes if a column was
    // swapped, and the point of this assertion is that turning AI off returns
    // the bar users learned, not a bar with the right number of things in it.
    expect(columns()).toEqual([
      "workspace.tab-notes",
      "workspace.tab-tasks",
      "workspace.tab-graph",
      "workspace.tab-files",
    ]);
    expect(screen.queryByTestId("workspace.tab-chat")).toBeNull();
  });

  it("adds Chat LAST when AI is on, so no existing column moves", () => {
    renderBar({ ai: true });

    expect(columns()).toEqual([
      "workspace.tab-notes",
      "workspace.tab-tasks",
      "workspace.tab-graph",
      "workspace.tab-files",
      "workspace.tab-chat",
    ]);
  });

  it("leaves no reserved gap where the fifth column would be", () => {
    // The alternative shape, and the one worth ruling out: rendering the button
    // always and hiding it with `visibility` or an empty flex child. That reads
    // identically in a testid query and leaves a dead fifth of the bar.
    renderBar({ ai: false });
    const bar = screen.getByTestId("workspace.tab-bar");
    expect(bar.children.length).toBe(4);
  });

  it("calls back when the column is pressed", () => {
    const { onChat } = renderBar({ ai: true });
    screen.getByTestId("workspace.tab-chat").click();
    expect(onChat).toHaveBeenCalledTimes(1);
  });

  it("contains a long label instead of letting it cross into the next column", () => {
    // Measured rather than assumed: `fi` renders "Muistiinpanot" for Notes and
    // `tr` renders "Yapay Zeka" for this very tab, and at five columns each
    // gets a fifth of a 390px phone rather than a quarter. jsdom computes no
    // layout, so what is asserted is the CONTAINMENT, which is the property
    // that makes the worst case a truncated word rather than overlapping text.
    renderBar({ ai: true });
    const span = screen.getByTestId("workspace.tab-chat").querySelector("span");
    expect(span?.style.overflow).toBe("hidden");
    expect(span?.style.textOverflow).toBe("ellipsis");
    expect(span?.style.whiteSpace).toBe("nowrap");
    expect(span?.style.maxWidth).toBe("100%");
    // And the flex item has to be allowed to shrink, or the widest label still
    // decides the column widths and the ellipsis never engages.
    expect(screen.getByTestId("workspace.tab-chat").style.minWidth).toBe("0px");
  });

  it("is passed `ai` at every call site in the editor flow", async () => {
    // The failure this whole file exists for: two `TabBar` renders, one updated.
    // `ai` being a required prop makes that a compile error, and this assertion
    // is what stops somebody making it optional later to quiet a new call site.
    // Read as text rather than driven, because driving `EditorFlow` needs the
    // whole vault runtime and would test the mock instead.
    // Read cwd-relative, the way every other file-reading spec in this suite
    // does. `import.meta.url` is not a file URL under the jsdom environment, so
    // the `fileURLToPath` form used in the desktop suite throws here.
    const flow = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/flows/EditorFlow.tsx", "utf8"),
    );
    const renders = flow.match(/<TabBar\b/g) ?? [];
    expect(renders.length).toBeGreaterThanOrEqual(2);
    expect(flow.match(/ai=\{prefs\.ai_enabled\}/g)?.length).toBe(renders.length);
  });
});
