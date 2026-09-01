// @vitest-environment jsdom
//
// The shared ContextMenu primitive's SUBMENU mode, added so the four export
// formats collapse into one "Export…" row (they were four rows here and four
// more in the editor's "…" menu).
//
// The three behaviours that are easy to get wrong, and that each broke a real
// menu when the naive version was written:
//   - a parent row must NOT fire its own action, or "Export…" would export;
//   - selecting a CHILD must close the whole menu, not just the submenu, or the
//     parent is left standing over the save dialog it opened;
//   - the submenu's own dismissal must NOT close the parent, or clicking a
//     sibling row is swallowed by the submenu's outside-click handler.
// Plain component, no IPC.

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

function rowById(id: string): HTMLElement {
  const found = screen
    .getAllByTestId("notes.context-menu-item")
    .find((el) => el.getAttribute("data-item-id") === id);
  if (found === undefined) throw new Error(`no menu row ${id}`);
  return found;
}

function rowIds(): string[] {
  return screen
    .getAllByTestId("notes.context-menu-item")
    .map((el) => el.getAttribute("data-item-id") ?? "");
}

describe("ContextMenu submenu", () => {
  it("marks a parent row as a popup and starts it closed", () => {
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        items={[item({ id: "export", children: [item({ id: "md" })] })]}
      />,
    );
    const parent = rowById("export");
    expect(parent.getAttribute("aria-haspopup")).toBe("menu");
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(rowIds()).toEqual(["export"]);
  });

  it("opens the children on hover, and marks the parent expanded", () => {
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        items={[
          item({ id: "export", children: [item({ id: "md" }), item({ id: "pdf" })] }),
        ]}
      />,
    );
    fireEvent.mouseEnter(rowById("export"));
    expect(rowIds()).toEqual(["export", "md", "pdf"]);
    expect(rowById("export").getAttribute("aria-expanded")).toBe("true");
  });

  it("does NOT fire the parent's own action when the parent is selected", () => {
    const parentSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={onClose}
        items={[
          item({ id: "export", onSelect: parentSelect, children: [item({ id: "md" })] }),
        ]}
      />,
    );
    fireEvent.click(rowById("export"));
    expect(parentSelect).not.toHaveBeenCalled();
    // ...and it does not dismiss the menu either: the children are the point.
    expect(onClose).not.toHaveBeenCalled();
    expect(rowIds()).toContain("md");
  });

  it("does not fire a parent's action from the SEARCH box's Enter either", () => {
    // The click path returns before `handleSelect`, so the guard inside
    // `handleSelect` is reachable only from here: a searchable menu commits its
    // first match on Enter, and that match can be a parent. Without the guard
    // this fires "Export…"'s no-op and dismisses the menu, so the user's Enter
    // silently does nothing at all.
    //
    // This case exists because injecting that exact defect left the click-path
    // test above green. It was proving the early return, not the guard.
    const parentSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={0}
        y={0}
        searchable
        searchPlaceholder="Filter"
        onClose={onClose}
        items={[
          item({ id: "export", label: "Export", onSelect: parentSelect, children: [item({ id: "md" })] }),
        ]}
      />,
    );
    const box = screen.getByTestId("notes.context-menu-search");
    fireEvent.change(box, { target: { value: "Exp" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(parentSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("selecting a child runs the child's action AND closes the whole menu", () => {
    const childSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={onClose}
        items={[
          item({ id: "export", children: [item({ id: "md", onSelect: childSelect })] }),
        ]}
      />,
    );
    fireEvent.mouseEnter(rowById("export"));
    fireEvent.click(rowById("md"));
    expect(childSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hovering a plain sibling closes the open submenu", () => {
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        items={[
          item({ id: "export", children: [item({ id: "md" })] }),
          item({ id: "delete" }),
        ]}
      />,
    );
    fireEvent.mouseEnter(rowById("export"));
    expect(rowIds()).toContain("md");
    fireEvent.mouseEnter(rowById("delete"));
    expect(rowIds()).not.toContain("md");
  });

  it("closes ONE level on Escape, not the whole menu", () => {
    // The parent and the nested menu each register their own document keydown,
    // so one press ran both `onClose`s and dismissed everything. The submenu's
    // `onClose` comment claimed the opposite while the code did the other
    // thing, and this file's own header lists the behaviour as one it pins.
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={onClose}
        items={[item({ id: "export", children: [item({ id: "md" })] })]}
      />,
    );
    fireEvent.mouseEnter(rowById("export"));
    expect(rowIds()).toContain("md");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(rowIds()).not.toContain("md");
    expect(onClose).not.toHaveBeenCalled();
    // A second press, with no submenu left to close, dismisses the menu.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not take focus when the submenu was opened by HOVER", () => {
    // Taking it cost the whole menu its keyboard cycle: moving the pointer to a
    // sibling unmounted the submenu, focus fell to `<body>`, and the arrow-key
    // handler on the menu div then received nothing for the rest of its life.
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        items={[
          item({ id: "export", children: [item({ id: "md" })] }),
          item({ id: "delete" }),
        ]}
      />,
    );
    const before = document.activeElement;
    fireEvent.mouseEnter(rowById("export"));
    expect(document.activeElement).toBe(before);
    // ...and the cycle still works after the pointer moves on.
    fireEvent.mouseEnter(rowById("delete"));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("DOES take focus when the submenu was opened by click", () => {
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        items={[item({ id: "export", children: [item({ id: "md" })] })]}
      />,
    );
    fireEvent.click(rowById("export"));
    expect(document.activeElement?.getAttribute("data-item-id")).toBe("md");
  });

  it("returns focus to the parent row when a click-opened submenu closes", () => {
    // Otherwise focus falls to `<body>` with the menu still up, and the arrow
    // cycle has no starting point: the user backs out of the submenu and the
    // keyboard stops working, which is the same dead end the hover case caused
    // by the opposite mistake.
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        items={[item({ id: "export", children: [item({ id: "md" })] })]}
      />,
    );
    fireEvent.click(rowById("export"));
    expect(document.activeElement?.getAttribute("data-item-id")).toBe("md");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement?.getAttribute("data-item-id")).toBe("export");
  });

  it("drives the SUBMENU's own arrow cycle once focus is inside it", () => {
    // The parent's two `[data-submenu]` guards are inherited by the nested
    // instance, because it is the same component. Unscoped, the child's bail
    // fired on its own rows and its filter stripped them, so ArrowDown,
    // ArrowUp, Home and End all did nothing inside an open submenu. Escape and
    // Enter kept working (a document listener, and native button semantics),
    // which is what made it easy to miss.
    //
    // The case above fires on the PARENT menu div, whose own wrapper lookup is
    // null, so it exercises the parent cycle only and stayed green throughout.
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        items={[
          item({
            id: "export",
            children: [item({ id: "md" }), item({ id: "pdf" }), item({ id: "html" })],
          }),
        ]}
      />,
    );
    fireEvent.click(rowById("export"));
    expect(document.activeElement?.getAttribute("data-item-id")).toBe("md");
    const submenu = rowById("md").closest('[role="menu"]')!;
    fireEvent.keyDown(submenu, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-item-id")).toBe("pdf");
    fireEvent.keyDown(submenu, { key: "End" });
    expect(document.activeElement?.getAttribute("data-item-id")).toBe("html");
  });

  it("keeps the parent menu's arrow cycle to its OWN rows while a submenu is open", () => {
    // The submenu is a nested ContextMenu with its own key handler. Without the
    // `[data-submenu]` bail, one ArrowDown would move focus twice (once per
    // menu) and the cycle would also walk into the children.
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        items={[
          item({ id: "export", children: [item({ id: "md" }), item({ id: "pdf" })] }),
          item({ id: "delete" }),
        ]}
      />,
    );
    fireEvent.mouseEnter(rowById("export"));
    const parentMenu = rowById("export").closest('[role="menu"]')!;
    rowById("export").focus();
    fireEvent.keyDown(parentMenu, { key: "ArrowDown" });
    // One step from "export" lands on the next PARENT row, not on a child.
    expect(document.activeElement?.getAttribute("data-item-id")).toBe("delete");
  });
  it("hovering a sibling gives focus BACK to the parent row, not to `<body>`", () => {
    // The case the sibling test one above cannot reach. That one opens the
    // submenu by HOVER, which never held focus, so it passes whether or not any
    // restore exists. Opening by CLICK is what puts focus inside the submenu,
    // and hovering a sibling then unmounts the element focus is standing on.
    //
    // The hover path used to call `setSubmenu(null)` directly while the restore
    // lived only in the child's `onClose`, so this exact gesture, open with the
    // keyboard then move the mouse, dropped focus to `<body>` and killed the
    // arrow keys for the rest of the menu's life. Injecting that back (dropping
    // the `open.focus` branch in `closeSubmenu`) fails this and nothing else.
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        items={[
          item({ id: "export", children: [item({ id: "md" })] }),
          item({ id: "delete" }),
        ]}
      />,
    );
    fireEvent.click(rowById("export"));
    expect(rowIds()).toContain("md");
    // The click-opened submenu autofocuses, so focus is inside it.
    expect(rowById("export").contains(document.activeElement)).toBe(false);
    expect(document.activeElement).not.toBe(document.body);

    fireEvent.mouseEnter(rowById("delete"));
    expect(rowIds()).not.toContain("md");
    expect(document.activeElement).toBe(rowById("export"));
  });

  it("names the submenu after the row that opened it", () => {
    // Without it the nested `role="menu"` is anonymous, so a screen reader
    // announces that focus entered a menu and cannot say which one.
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        items={[item({ id: "export", label: "Export…", children: [item({ id: "md" })] })]}
      />,
    );
    fireEvent.mouseEnter(rowById("export"));
    const menus = screen.getAllByRole("menu");
    expect(menus.map((m) => m.getAttribute("aria-label"))).toContain("Export…");
  });
  it("hides the decorative chevron from the accessibility tree", () => {
    // The row's own text is its name; the chevron only says which way the
    // submenu opens. `NoteActionsMenu` already wrapped its chevron this way and
    // this one did not, which is one of the three ways the two implementations
    // had drifted.
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        items={[item({ id: "export", label: "Export…", children: [item({ id: "md" })] })]}
      />,
    );
    const chevron = rowById("export").querySelector("svg")?.closest("span");
    expect(chevron?.getAttribute("aria-hidden")).toBe("true");
  });
});
