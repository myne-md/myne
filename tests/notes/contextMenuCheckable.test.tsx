// @vitest-environment jsdom
//
// Unit tests for the shared ContextMenu primitive's checkable-toggle mode
// (bottom-bar customization). Covers the two backward-compatible opts added for
// the bottom-bar visibility menu: `checked` (the ✓ gutter + ARIA) and
// `closeOnSelect` (keep the menu open while flipping several items). Plain
// component — no IPC.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ContextMenu,
  type ContextMenuItem,
} from "../../src/notes/components/ContextMenu";

afterEach(cleanup);

function item(over: Partial<ContextMenuItem> & { id: string }): ContextMenuItem {
  return { label: over.id, onSelect: vi.fn(), ...over };
}

describe("ContextMenu checkable-toggle mode", () => {
  it("renders a checkbox role + data-checked for items carrying `checked`", () => {
    render(
      <ContextMenu
        x={10}
        y={10}
        onClose={vi.fn()}
        items={[
          item({ id: "graph", checked: true }),
          item({ id: "tags", checked: false }),
        ]}
      />,
    );
    const items = screen.getAllByTestId("notes.context-menu-item");
    const graph = items[0]!;
    expect(graph.getAttribute("data-item-id")).toBe("graph");
    expect(graph.getAttribute("role")).toBe("menuitemcheckbox");
    expect(graph.getAttribute("aria-checked")).toBe("true");
    expect(graph.getAttribute("data-checked")).toBe("true");
    expect(items[1]!.getAttribute("data-checked")).toBe("false");
  });

  it("a plain action item (no `checked`) keeps the menuitem role + no data-checked", () => {
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        items={[item({ id: "rename" })]}
      />,
    );
    const el = screen.getByTestId("notes.context-menu-item");
    expect(el.getAttribute("role")).toBe("menuitem");
    expect(el.getAttribute("data-checked")).toBeNull();
  });

  it("closeOnSelect:false fires onSelect but does NOT close the menu", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={onClose}
        items={[item({ id: "graph", checked: true, closeOnSelect: false, onSelect })]}
      />,
    );
    fireEvent.click(screen.getByTestId("notes.context-menu-item"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a default action item closes the menu on select (closeOnSelect defaults true)", () => {
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={onClose}
        items={[item({ id: "delete" })]}
      />,
    );
    fireEvent.click(screen.getByTestId("notes.context-menu-item"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
