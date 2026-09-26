// @vitest-environment jsdom
//
// Unit tests for the saved-views flyout (Saved Views #4, MYND-274).
// The component used to render a sidebar nav row that opened the flyout beside
// itself; the row is gone (myne-md/myne#762) and `requestRevealViews()` — what
// the `views.show` ribbon button and the palette both fire — is the only way in.
// Rows / empty-state / rename all live inside the flyout, so tests open it
// first. Pure component — no IPC.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ViewsSection } from "../../src/notes/components/ViewsSection";
import {
  requestRevealViews,
  __resetRevealViewsForTest,
} from "../../src/notes/views/revealViewsSignal";
import type { SavedView } from "../../src/lib/prefs";

afterEach(() => {
  cleanup();
  __resetRevealViewsForTest();
});

function view(id: string, name: string): SavedView {
  return { id, name, view_type: "cards", filters: { kind: "all" } };
}

/** Open the flyout the way the product does — the reveal signal the `views.show`
 *  command fires. It toggles, so call it once per open. */
function openFlyout() {
  act(() => {
    requestRevealViews();
  });
}

describe("ViewsSection", () => {
  it("renders nothing until revealed; the list + empty-state live in the flyout", () => {
    render(<ViewsSection views={[]} onOpenView={vi.fn()} onNewView={vi.fn()} />);
    // Closed by default, and with the nav row gone that means NOTHING in the DOM
    // — the component is a flyout host, not a sidebar entry.
    expect(screen.queryByTestId("views.flyout")).toBeNull();
    expect(screen.queryByTestId("views.empty")).toBeNull();
    // Opening the flyout reveals the quiet empty-state hint.
    openFlyout();
    expect(screen.getByTestId("views.flyout")).toBeTruthy();
    expect(screen.getByTestId("views.empty")).toBeTruthy();
    expect(screen.queryByTestId("views.row")).toBeNull();
  });

  it("renders one flyout row per view, in the given order, with a data-view-id", () => {
    render(
      <ViewsSection
        views={[view("v2", "Books"), view("v1", "Films")]}
        onOpenView={vi.fn()}
        onNewView={vi.fn()}
      />,
    );
    openFlyout();
    const rows = screen.getAllByTestId("views.row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-view-id")).toBe("v2");
    expect(rows[0]!.textContent).toContain("Books");
    expect(rows[1]!.getAttribute("data-view-id")).toBe("v1");
    expect(screen.queryByTestId("views.empty")).toBeNull();
  });

  it("clicking a flyout row opens that view", () => {
    const onOpenView = vi.fn();
    render(
      <ViewsSection
        views={[view("v1", "Books")]}
        onOpenView={onOpenView}
        onNewView={vi.fn()}
      />,
    );
    openFlyout();
    fireEvent.click(screen.getByTestId("views.row"));
    expect(onOpenView).toHaveBeenCalledWith("v1");
  });

  it("the + button lives in the flyout header and triggers onNewView", () => {
    const onNewView = vi.fn();
    render(
      <ViewsSection views={[]} onOpenView={vi.fn()} onNewView={onNewView} />,
    );
    // It used to sit on the nav row, reachable without opening anything; with
    // the row gone it moved into the flyout's search header.
    expect(screen.queryByTestId("views.new-button")).toBeNull();
    openFlyout();
    fireEvent.click(screen.getByTestId("views.new-button"));
    expect(onNewView).toHaveBeenCalledTimes(1);
    // Creating opens the filter-builder modal, so the flyout gets out of the way.
    expect(screen.queryByTestId("views.flyout")).toBeNull();
  });

  it("a second reveal toggles the flyout closed", () => {
    render(
      <ViewsSection
        views={[view("v1", "Books")]}
        onOpenView={vi.fn()}
        onNewView={vi.fn()}
      />,
    );
    openFlyout();
    expect(screen.getByTestId("views.row")).toBeTruthy();
    openFlyout(); // the same ribbon button pressed again
    expect(screen.queryByTestId("views.row")).toBeNull();
  });

  it("filters the flyout list by the search query", () => {
    render(
      <ViewsSection
        views={[view("v1", "Books"), view("v2", "Films")]}
        onOpenView={vi.fn()}
        onNewView={vi.fn()}
      />,
    );
    openFlyout();
    fireEvent.change(screen.getByTestId("views.search"), {
      target: { value: "film" },
    });
    const rows = screen.getAllByTestId("views.row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-view-id")).toBe("v2");
  });

  it("flags the active view with data-active in the flyout", () => {
    render(
      <ViewsSection
        views={[view("v1", "Books"), view("v2", "Films")]}
        activeViewId="v2"
        onOpenView={vi.fn()}
        onNewView={vi.fn()}
      />,
    );
    openFlyout();
    const rows = screen.getAllByTestId("views.row");
    const active = rows.filter((r) => r.getAttribute("data-active") === "true");
    expect(active).toHaveLength(1);
    expect(active[0]!.getAttribute("data-view-id")).toBe("v2");
  });

  it("falls back to 'Untitled view' for a blank name", () => {
    render(
      <ViewsSection
        views={[view("v1", "  ")]}
        onOpenView={vi.fn()}
        onNewView={vi.fn()}
      />,
    );
    openFlyout();
    expect(screen.getByTestId("views.row").textContent).toContain(
      "Untitled view",
    );
  });
});

describe("ViewsSection — management (MYND-274 task 6)", () => {
  function renderManaged(
    over: Partial<{
      onViewSettings: (id: string) => void;
      onRename: (id: string, name: string) => void;
      onDelete: (id: string) => void;
      onMoveView: (id: string, dir: -1 | 1) => void;
    }> = {},
  ) {
    const handlers = {
      onOpenView: vi.fn(),
      onNewView: vi.fn(),
      onEditFilter: vi.fn(),
      onViewSettings: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onMoveView: vi.fn(),
      ...over,
    };
    render(
      <ViewsSection
        views={[view("v1", "Books"), view("v2", "Films")]}
        {...handlers}
      />,
    );
    openFlyout();
    return handlers;
  }

  function openRowMenu(viewId: string) {
    const row = screen
      .getAllByTestId("views.row")
      .find((r) => r.getAttribute("data-view-id") === viewId)!;
    fireEvent.contextMenu(row);
  }

  it("right-click opens a menu with edit / settings / rename / move / delete", () => {
    renderManaged();
    openRowMenu("v1");
    const ids = screen
      .getAllByTestId("notes.context-menu-item")
      .map((el) => el.getAttribute("data-item-id"));
    // "view-settings" is offered for cards views (the test fixtures are cards).
    expect(ids).toEqual([
      "edit-filter",
      "view-settings",
      "rename",
      "move-up",
      "move-down",
      "delete",
    ]);
  });

  it("View settings… dispatches onViewSettings with the row id", () => {
    const onViewSettings = vi.fn();
    renderManaged({ onViewSettings });
    openRowMenu("v2");
    fireEvent.click(
      screen
        .getAllByTestId("notes.context-menu-item")
        .find((el) => el.getAttribute("data-item-id") === "view-settings")!,
    );
    expect(onViewSettings).toHaveBeenCalledWith("v2");
  });

  it("includes View settings… for every view type (table)", () => {
    const onViewSettings = vi.fn();
    const tableView: SavedView = {
      id: "vl",
      name: "Table",
      view_type: "table",
      filters: { kind: "all" },
    };
    render(
      <ViewsSection
        views={[tableView]}
        onOpenView={vi.fn()}
        onNewView={vi.fn()}
        onEditFilter={vi.fn()}
        onViewSettings={onViewSettings}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onMoveView={vi.fn()}
      />,
    );
    openFlyout();
    openRowMenu("vl");
    const ids = screen
      .getAllByTestId("notes.context-menu-item")
      .map((el) => el.getAttribute("data-item-id"));
    expect(ids).toContain("view-settings");
    fireEvent.click(
      screen
        .getAllByTestId("notes.context-menu-item")
        .find((el) => el.getAttribute("data-item-id") === "view-settings")!,
    );
    expect(onViewSettings).toHaveBeenCalledWith("vl");
  });

  it("delete dispatches onDelete with the row id", () => {
    const onDelete = vi.fn();
    renderManaged({ onDelete });
    openRowMenu("v2");
    fireEvent.click(
      document.querySelector('[data-item-id="delete"]') as Element,
    );
    expect(onDelete).toHaveBeenCalledWith("v2");
  });

  it("move up / down dispatch onMoveView with the direction", () => {
    const onMoveView = vi.fn();
    renderManaged({ onMoveView });
    openRowMenu("v2");
    fireEvent.click(
      document.querySelector('[data-item-id="move-up"]') as Element,
    );
    expect(onMoveView).toHaveBeenCalledWith("v2", -1);
  });

  it("rename → inline input → Enter dispatches onRename with the new name", () => {
    const onRename = vi.fn();
    renderManaged({ onRename });
    openRowMenu("v1");
    fireEvent.click(
      document.querySelector('[data-item-id="rename"]') as Element,
    );
    const input = screen.getByTestId("views.rename-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Reading" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("v1", "Reading");
  });

  it("rename to the same name does not dispatch onRename", () => {
    const onRename = vi.fn();
    renderManaged({ onRename });
    openRowMenu("v1");
    fireEvent.click(
      document.querySelector('[data-item-id="rename"]') as Element,
    );
    const input = screen.getByTestId("views.rename-input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Enter" }); // unchanged "Books"
    expect(onRename).not.toHaveBeenCalled();
  });
});
