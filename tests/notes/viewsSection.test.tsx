// @vitest-environment jsdom
//
// Unit tests for the sidebar "Views" section (Saved Views #4, MYND-274, task 3).
// Covers the list/empty-state logic + the open/new dispatch (the UI subtask's
// Vitest-coverage requirement). Pure component — no IPC.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ViewsSection } from "../../src/notes/components/ViewsSection";
import type { SavedView } from "../../src/lib/prefs";

afterEach(cleanup);

function view(id: string, name: string): SavedView {
  return { id, name, view_type: "cards", filters: { kind: "all" } };
}

describe("ViewsSection", () => {
  it("renders the quiet empty-state hint when there are no views", () => {
    render(<ViewsSection views={[]} onOpenView={vi.fn()} onNewView={vi.fn()} />);
    expect(screen.getByTestId("views.section")).toBeTruthy();
    expect(screen.getByTestId("views.empty")).toBeTruthy();
    expect(screen.queryByTestId("views.row")).toBeNull();
  });

  it("renders one row per view, in the given order, with a data-view-id", () => {
    render(
      <ViewsSection
        views={[view("v2", "Books"), view("v1", "Films")]}
        onOpenView={vi.fn()}
        onNewView={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId("views.row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-view-id")).toBe("v2");
    expect(rows[0]!.textContent).toContain("Books");
    expect(rows[1]!.getAttribute("data-view-id")).toBe("v1");
    expect(screen.queryByTestId("views.empty")).toBeNull();
  });

  it("clicking a row opens that view", () => {
    const onOpenView = vi.fn();
    render(
      <ViewsSection
        views={[view("v1", "Books")]}
        onOpenView={onOpenView}
        onNewView={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("views.row"));
    expect(onOpenView).toHaveBeenCalledWith("v1");
  });

  it("the + button triggers onNewView", () => {
    const onNewView = vi.fn();
    render(
      <ViewsSection views={[]} onOpenView={vi.fn()} onNewView={onNewView} />,
    );
    fireEvent.click(screen.getByTestId("views.new-button"));
    expect(onNewView).toHaveBeenCalledTimes(1);
  });

  it("collapsing the section hides the rows", () => {
    render(
      <ViewsSection
        views={[view("v1", "Books")]}
        onOpenView={vi.fn()}
        onNewView={vi.fn()}
      />,
    );
    expect(screen.getByTestId("views.row")).toBeTruthy();
    fireEvent.click(screen.getByTestId("views.collapse-toggle"));
    expect(screen.queryByTestId("views.row")).toBeNull();
  });

  it("falls back to 'Untitled view' for a blank name", () => {
    render(
      <ViewsSection
        views={[view("v1", "  ")]}
        onOpenView={vi.fn()}
        onNewView={vi.fn()}
      />,
    );
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

  it("omits View settings… for non-cards views", () => {
    const listView: SavedView = {
      id: "vl",
      name: "Table",
      view_type: "table",
      filters: { kind: "all" },
    };
    render(
      <ViewsSection
        views={[listView]}
        onOpenView={vi.fn()}
        onNewView={vi.fn()}
        onEditFilter={vi.fn()}
        onViewSettings={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onMoveView={vi.fn()}
      />,
    );
    openRowMenu("vl");
    const ids = screen
      .getAllByTestId("notes.context-menu-item")
      .map((el) => el.getAttribute("data-item-id"));
    expect(ids).not.toContain("view-settings");
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
