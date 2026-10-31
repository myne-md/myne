// @vitest-environment jsdom
//
// The move-to-folder picker as a collapsible TREE (myne#952).
//
// What it was: one flat list whose only hierarchy was leading spaces baked into
// the label. Three consequences, one test each below — subfolders could not be
// folded away, a filtered result lost the ancestry that explains it, and a deep
// vault was a wall of indented text.
//
// The behaviours worth pinning, because each is a way the naive version goes
// wrong:
//   - collapsing a parent must hide its DESCENDANTS and nothing after them
//     (a depth scan that forgets to clear the threshold eats the next sibling);
//   - selecting a PARENT still selects it, unlike a submenu parent — "move to
//     02 - AREAS" is a destination, not just a doorway;
//   - a filter must walk the WHOLE tree, so a match inside a collapsed folder is
//     still findable, and it must say whose child it is.
// Plain component, no IPC.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ContextMenu,
  type ContextMenuItem,
} from "../../src/notes/components/ContextMenu";

afterEach(cleanup);

const FOLDERS: ContextMenuItem[] = [
  { id: "__vault_root__", label: "Vault root", icon: "folder", depth: 0, onSelect: vi.fn() },
  { id: "02 - AREAS/", label: "02 - AREAS", path: "02 - AREAS/", icon: "folder", depth: 1, onSelect: vi.fn() },
  { id: "02 - AREAS/Education/", label: "Education", path: "02 - AREAS/Education/", icon: "folder", depth: 2, onSelect: vi.fn() },
  { id: "02 - AREAS/Education/01-24-spring/", label: "01-24-spring", path: "02 - AREAS/Education/01-24-spring/", icon: "folder", depth: 3, onSelect: vi.fn() },
  { id: "02 - AREAS/Finance/", label: "Finance", path: "02 - AREAS/Finance/", icon: "folder", depth: 2, onSelect: vi.fn() },
  // A row DEEPER than the collapsed folder, sitting AFTER it. Without one of
  // these the "collapse hides only its own subtree" test is vacuous: every row
  // below could stay visible on a broken scan and the assertion would still pass.
  { id: "02 - AREAS/Finance/2025/", label: "2025", path: "02 - AREAS/Finance/2025/", icon: "folder", depth: 3, onSelect: vi.fn() },
  { id: "03 - JOURNAL/", label: "03 - JOURNAL", path: "03 - JOURNAL/", icon: "folder", depth: 1, onSelect: vi.fn() },
];

function rowIds(): string[] {
  return screen
    .queryAllByTestId("notes.context-menu-item")
    .map((el) => el.getAttribute("data-item-id") ?? "");
}

function rowById(id: string): HTMLElement {
  const found = screen
    .queryAllByTestId("notes.context-menu-item")
    .find((el) => el.getAttribute("data-item-id") === id);
  if (found === undefined) throw new Error(`no menu row ${id}`);
  return found;
}

function toggleOf(id: string): HTMLElement {
  const toggle = rowById(id).querySelector<HTMLElement>(
    '[data-testid="notes.context-menu-disclosure"]',
  );
  if (toggle === null) throw new Error(`no disclosure on ${id}`);
  return toggle;
}

// The label cell, named rather than guessed. `span:last-child` used to stand in
// for it and read as precise while measuring nothing: a row that grows a
// trailing element (a submenu chevron, a shortcut hint) moves "last" without
// moving the label, and the click then lands on decoration and bubbles to the
// row anyway, so the assertion keeps passing.
function labelOf(id: string): HTMLElement {
  const label = rowById(id).querySelector<HTMLElement>(
    '[data-testid="notes.context-menu-label"]',
  );
  if (label === null) throw new Error(`no label on ${id}`);
  return label;
}

function renderTree() {
  return render(
    <ContextMenu x={0} y={0} items={FOLDERS} onClose={vi.fn()} searchable tree />,
  );
}

describe("move picker as a tree (myne#952)", () => {
  it("renders every folder expanded, with its depth on the row", () => {
    renderTree();
    expect(rowIds()).toEqual(FOLDERS.map((f) => f.id));
    expect(rowById("02 - AREAS/Education/01-24-spring/").dataset.depth).toBe("3");
  });

  it("collapses a folder's descendants and nothing past them", () => {
    renderTree();
    fireEvent.click(toggleOf("02 - AREAS/Education/"));

    // Education's children go…
    expect(rowIds()).not.toContain("02 - AREAS/Education/01-24-spring/");
    // …and everything at Education's own level or above stays, including the
    // NEXT sibling of the collapsed row and that sibling's OWN deeper children.
    // A depth scan that never clears its hidden-below threshold swallows them.
    expect(rowIds()).toEqual([
      "__vault_root__",
      "02 - AREAS/",
      "02 - AREAS/Education/",
      "02 - AREAS/Finance/",
      "02 - AREAS/Finance/2025/",
      "03 - JOURNAL/",
    ]);
    expect(rowById("02 - AREAS/Education/").dataset.expanded).toBe("false");

    fireEvent.click(toggleOf("02 - AREAS/Education/"));
    expect(rowIds()).toContain("02 - AREAS/Education/01-24-spring/");
  });

  it("still SELECTS a parent row — it is a destination, not just a doorway", () => {
    const onSelect = vi.fn();
    const items = FOLDERS.map((f) =>
      f.id === "02 - AREAS/Education/" ? { ...f, onSelect } : f,
    );
    render(
      <ContextMenu x={0} y={0} items={items} onClose={vi.fn()} searchable tree />,
    );
    fireEvent.click(labelOf("02 - AREAS/Education/"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("does not select a parent when its toggle is pressed", () => {
    const onSelect = vi.fn();
    const items = FOLDERS.map((f) =>
      f.id === "02 - AREAS/Education/" ? { ...f, onSelect } : f,
    );
    render(
      <ContextMenu x={0} y={0} items={items} onClose={vi.fn()} searchable tree />,
    );
    fireEvent.click(toggleOf("02 - AREAS/Education/"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("finds a match inside a COLLAPSED folder, and says whose child it is", () => {
    renderTree();
    fireEvent.click(toggleOf("02 - AREAS/Education/"));
    expect(rowIds()).not.toContain("02 - AREAS/Education/01-24-spring/");

    fireEvent.change(screen.getByTestId("notes.context-menu-search"), {
      target: { value: "spring" },
    });

    // Found even though its parent is folded away: a filter searches the whole
    // tree, otherwise searching for a folder you cannot see is impossible.
    expect(rowIds()).toEqual(["02 - AREAS/Education/01-24-spring/"]);
    // …and the ancestry is stated, because a filtered list has no indent to
    // read. This is the "I cannot tell whose sub this is" defect.
    expect(
      screen.getByTestId("notes.context-menu-ancestry").textContent,
    ).toContain("Education");
  });

  it("drops the depth indent while filtering, so results do not look nested", () => {
    renderTree();
    expect(rowById("02 - AREAS/Education/01-24-spring/").dataset.depth).toBe("3");
    fireEvent.change(screen.getByTestId("notes.context-menu-search"), {
      target: { value: "spring" },
    });
    expect(rowById("02 - AREAS/Education/01-24-spring/").dataset.depth).toBe("0");
  });
});
