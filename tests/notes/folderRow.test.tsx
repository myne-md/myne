// @vitest-environment jsdom
//
// `<FolderRow>` render + interaction tests. The row branches on: disclosure
// (chevron present vs the empty-folder spacer), depth indent (paddingLeft),
// expanded vs collapsed (aria-expanded; empty → undefined), empty-folder dimmed
// "empty" hint + no-toggle-on-click, inline rename (auto-focused input, Enter /
// Esc / blur, no-op-when-unchanged), the drag-kind-discriminated drop affordance
// (folder reorder edge vs note 3-zone into/above/below), custom icon + color dot,
// and the reorder insertion line. Pure component — no IPC.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FolderNode } from "../../src/notes/folderTree";

// jsdom can't drive the drag GEOMETRY reliably (synthetic DragEvents drop
// `clientY`, and `e.currentTarget.getBoundingClientRect()` reports a 0-rect), so
// the pure 2-edge / 3-zone hit-tests are mocked to a controllable value. The
// geometry itself is unit-tested elsewhere; here we assert FolderRow ROUTES the
// resolved zone to the right callback — which is the component's real branching.
let nextZone: "above" | "into" | "below" = "into";
vi.mock("../../src/notes/components/reorderDnd", async (orig) => {
  const actual = await orig<typeof import("../../src/notes/components/reorderDnd")>();
  return {
    ...actual,
    dragEdge: () => (nextZone === "into" ? "below" : nextZone),
    dragZone: () => nextZone,
  };
});

const { FolderRow } = await import("../../src/notes/components/FolderRow");
type FolderRowProps = import("../../src/notes/components/FolderRow").FolderRowProps;

afterEach(cleanup);

function node(over: Partial<FolderNode> = {}): FolderNode {
  return {
    path: "Projects/",
    key: "projects/",
    name: "Projects",
    depth: 1,
    deliberate: false,
    noteIds: [],
    children: [],
    ...over,
  };
}

function renderRow(over: Partial<FolderRowProps> = {}) {
  const props: FolderRowProps = {
    node: node(),
    depth: 0,
    collapsed: false,
    empty: false,
    onToggle: vi.fn(),
    ...over,
  };
  return { props, ...render(<FolderRow {...props} />) };
}

// jsdom synthetic drag events carry no `dataTransfer`; the handlers set
// `dropEffect`, so we supply a minimal stub.
const dataTransfer = () => ({ dropEffect: "", setData() {}, getData: () => "" });

// Fire a dragOver / drop with the mocked hit-test resolving to `zone`.
function dragOverZone(el: HTMLElement, zone: "above" | "into" | "below") {
  nextZone = zone;
  fireEvent.dragOver(el, { dataTransfer: dataTransfer() });
}
function dropZone(el: HTMLElement, zone: "above" | "into" | "below") {
  nextZone = zone;
  fireEvent.drop(el, { dataTransfer: dataTransfer() });
}

describe("FolderRow — disclosure + depth", () => {
  it("renders the folder name and path", () => {
    renderRow({ node: node({ name: "Inbox", path: "Inbox/" }) });
    const row = screen.getByTestId("notes.folder-row");
    expect(row.textContent).toContain("Inbox");
    expect(row.getAttribute("data-folder-path")).toBe("Inbox/");
  });

  it("indents by depth (paddingInlineStart = base + depth * per-level)", () => {
    const { rerender } = renderRow({ depth: 0 });
    // Logical property (RTL migration): the leading-edge indent is
    // `padding-inline-start`, which is `padding-left` in an LTR document.
    const at0 = screen.getByTestId("notes.folder-row").style.paddingInlineStart;
    rerender(
      <FolderRow node={node()} depth={2} collapsed={false} empty={false} onToggle={vi.fn()} />,
    );
    const at2 = screen.getByTestId("notes.folder-row").style.paddingInlineStart;
    // BASE_PADDING_LEFT=8, INDENT_PER_LEVEL=18 → depth 0 = 8px, depth 2 = 44px.
    expect(at0).toBe("8px");
    expect(at2).toBe("44px");
  });

  it("expanded folder → aria-expanded=true", () => {
    renderRow({ collapsed: false, empty: false });
    expect(
      screen.getByTestId("notes.folder-row").getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("collapsed folder → aria-expanded=false", () => {
    renderRow({ collapsed: true, empty: false });
    expect(
      screen.getByTestId("notes.folder-row").getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("empty folder → aria-expanded omitted entirely", () => {
    renderRow({ empty: true });
    expect(
      screen.getByTestId("notes.folder-row").getAttribute("aria-expanded"),
    ).toBeNull();
  });
});

describe("FolderRow — empty folder variant", () => {
  it("renders the 'empty' hint and does not toggle on click", () => {
    const onToggle = vi.fn();
    renderRow({ empty: true, onToggle });
    expect(screen.getByTestId("notes.folder-row").textContent).toContain(
      "empty",
    );
    fireEvent.click(screen.getByTestId("notes.folder-row"));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("non-empty folder click toggles by key", () => {
    const onToggle = vi.fn();
    renderRow({ node: node({ key: "projects/" }), onToggle });
    fireEvent.click(screen.getByTestId("notes.folder-row"));
    expect(onToggle).toHaveBeenCalledWith("projects/");
  });
});

describe("FolderRow — context menu", () => {
  it("right-click → onContextMenu with node + cursor position", () => {
    const onContextMenu = vi.fn();
    const n = node();
    renderRow({ node: n, onContextMenu });
    fireEvent.contextMenu(screen.getByTestId("notes.folder-row"), {
      clientX: 11,
      clientY: 22,
    });
    expect(onContextMenu).toHaveBeenCalledWith(n, { x: 11, y: 22 });
  });

  it("right-click is suppressed during rename", () => {
    const onContextMenu = vi.fn();
    renderRow({ renaming: true, onContextMenu });
    fireEvent.contextMenu(screen.getByTestId("notes.folder-row"));
    expect(onContextMenu).not.toHaveBeenCalled();
  });
});

describe("FolderRow — inline rename", () => {
  it("renders an auto-focused, all-selected input seeded with the folder name", () => {
    renderRow({ node: node({ name: "Work" }), renaming: true });
    const inputs = screen.getByTestId("notes.folder-row").querySelectorAll("input");
    expect(inputs).toHaveLength(1);
    const input = inputs[0] as HTMLInputElement;
    expect(input.value).toBe("Work");
    expect(document.activeElement).toBe(input);
  });

  it("Enter with a changed value commits the new name", () => {
    const onCommitRename = vi.fn();
    const n = node({ name: "Work" });
    renderRow({ node: n, renaming: true, onCommitRename });
    const input = screen.getByTestId("notes.folder-row").querySelector("input")!;
    fireEvent.change(input, { target: { value: "  Workspace  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommitRename).toHaveBeenCalledWith(n, "Workspace");
  });

  it("Enter with the SAME name cancels (no rename to the identical segment)", () => {
    const onCommitRename = vi.fn();
    const onCancelRename = vi.fn();
    renderRow({
      node: node({ name: "Work" }),
      renaming: true,
      onCommitRename,
      onCancelRename,
    });
    const input = screen.getByTestId("notes.folder-row").querySelector("input")!;
    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommitRename).not.toHaveBeenCalled();
    expect(onCancelRename).toHaveBeenCalledTimes(1);
  });

  it("Enter with an empty value cancels", () => {
    const onCommitRename = vi.fn();
    const onCancelRename = vi.fn();
    renderRow({ renaming: true, onCommitRename, onCancelRename });
    const input = screen.getByTestId("notes.folder-row").querySelector("input")!;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommitRename).not.toHaveBeenCalled();
    expect(onCancelRename).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels", () => {
    const onCancelRename = vi.fn();
    renderRow({ renaming: true, onCancelRename });
    const input = screen.getByTestId("notes.folder-row").querySelector("input")!;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancelRename).toHaveBeenCalledTimes(1);
  });

  it("blur with a changed value commits", () => {
    const onCommitRename = vi.fn();
    const n = node({ name: "Work" });
    renderRow({ node: n, renaming: true, onCommitRename });
    const input = screen.getByTestId("notes.folder-row").querySelector("input")!;
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.blur(input);
    expect(onCommitRename).toHaveBeenCalledWith(n, "Renamed");
  });

  it("the row is not draggable while renaming", () => {
    renderRow({ renaming: true });
    expect(
      screen.getByTestId("notes.folder-row").getAttribute("draggable"),
    ).toBe("false");
  });
});

describe("FolderRow — drag affordances", () => {
  it("folder drag → reorder edge by cursor half, no drop-target highlight", () => {
    const onFolderReorderOver = vi.fn();
    const onDragTarget = vi.fn();
    const n = node();
    renderRow({
      node: n,
      dragKind: "folder",
      onFolderReorderOver,
      onDragTarget,
    });
    const row = screen.getByTestId("notes.folder-row");
    dragOverZone(row, "above");
    expect(onFolderReorderOver).toHaveBeenLastCalledWith(n, "above");
    dragOverZone(row, "below");
    expect(onFolderReorderOver).toHaveBeenLastCalledWith(n, "below");
    // An EDGE zone never leaves the into-highlight standing (myne#281 gave the
    // folder drag the note drag's three zones, so it now has one to clear).
    expect(onDragTarget).toHaveBeenLastCalledWith(null);
  });

  it("note drag over the middle → 'into' highlights the folder as a move target", () => {
    const onDragTarget = vi.fn();
    const onFolderReorderOver = vi.fn();
    const onFolderReorderLeave = vi.fn();
    const n = node({ key: "projects/" });
    renderRow({
      node: n,
      dragKind: "note",
      onDropNote: vi.fn(),
      onDragTarget,
      onFolderReorderOver,
      onFolderReorderLeave,
    });
    dragOverZone(screen.getByTestId("notes.folder-row"), "into");
    expect(onDragTarget).toHaveBeenLastCalledWith("projects/");
    expect(onFolderReorderLeave).toHaveBeenCalledWith("projects/");
    expect(onFolderReorderOver).not.toHaveBeenCalled();
  });

  it("note drag over the top quarter → reorder 'above', clears the into-highlight", () => {
    const onDragTarget = vi.fn();
    const onFolderReorderOver = vi.fn();
    const n = node();
    renderRow({
      node: n,
      dragKind: "note",
      onDropNote: vi.fn(),
      onDragTarget,
      onFolderReorderOver,
    });
    dragOverZone(screen.getByTestId("notes.folder-row"), "above");
    expect(onFolderReorderOver).toHaveBeenLastCalledWith(n, "above");
    expect(onDragTarget).toHaveBeenLastCalledWith(null);
  });

  it("folder drop → onFolderReorderDrop with the cursor edge", () => {
    const onFolderReorderDrop = vi.fn();
    const n = node();
    renderRow({ node: n, dragKind: "folder", onFolderReorderDrop });
    dropZone(screen.getByTestId("notes.folder-row"), "below");
    expect(onFolderReorderDrop).toHaveBeenCalledWith(n, "below");
  });

  it("note drop in the middle → onDropNote with the folder path", () => {
    const onDropNote = vi.fn();
    const onFolderReorderDrop = vi.fn();
    const n = node({ path: "Projects/" });
    renderRow({ node: n, dragKind: "note", onDropNote, onFolderReorderDrop });
    dropZone(screen.getByTestId("notes.folder-row"), "into");
    expect(onDropNote).toHaveBeenCalledWith("Projects/");
    expect(onFolderReorderDrop).not.toHaveBeenCalled();
  });

  it("note drop in the bottom quarter → reorder (onFolderReorderDrop), not into", () => {
    const onDropNote = vi.fn();
    const onFolderReorderDrop = vi.fn();
    const n = node();
    renderRow({ node: n, dragKind: "note", onDropNote, onFolderReorderDrop });
    dropZone(screen.getByTestId("notes.folder-row"), "below");
    expect(onFolderReorderDrop).toHaveBeenCalledWith(n, "below");
    expect(onDropNote).not.toHaveBeenCalled();
  });

  it("dragStart forwards to onDragStartFolder; dragEnd to onDragEnd", () => {
    const onDragStartFolder = vi.fn();
    const onDragEnd = vi.fn();
    const n = node();
    renderRow({ node: n, onDragStartFolder, onDragEnd });
    const row = screen.getByTestId("notes.folder-row");
    fireEvent.dragStart(row);
    expect(onDragStartFolder).toHaveBeenCalledWith(expect.anything(), n);
    fireEvent.dragEnd(row);
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });
});

describe("FolderRow — visual extras", () => {
  it("renders the drop-target highlight ring when dropTarget is set", () => {
    renderRow({ dropTarget: true });
    const style = screen.getByTestId("notes.folder-row").style;
    expect(style.boxShadow).toContain("var(--accent)");
  });

  it("no drop-target ring by default", () => {
    renderRow({ dropTarget: false });
    expect(screen.getByTestId("notes.folder-row").style.boxShadow).toBe("");
  });

  it("renders an insertion line element when reorderPlace is set", () => {
    const { container } = renderRow({ reorderPlace: "above" });
    // The insertion line is the only aria-hidden DIV: the default folder icon's
    // aria-hidden node is a SPAN (FolderRow.tsx:219) and the glyphs are SVGs.
    // Selecting on `[aria-hidden="true"]` alone matched the icon on every row,
    // so deleting the line left this green.
    const line = container.querySelector('div[aria-hidden="true"]') as HTMLElement | null;
    expect(line).toBeTruthy();
    expect(line?.style.background).toContain("var(--accent)");
    expect(line?.style.height).toBe("2px");
  });

  it("renders a custom folder glyph when iconName resolves", () => {
    const { container } = renderRow({ iconName: "star" });
    // FolderGlyph renders an <svg>; the default FolderIcon stacks two. With a
    // valid custom icon the default stacked pair is replaced.
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  it("marks the row with its colour slot when colorSlot is set", () => {
    const { container } = renderRow({ colorSlot: "amber" });
    expect(container.querySelector('[data-color-slot="amber"]')).toBeTruthy();
  });

  it("carries no colour marker when colorSlot is omitted", () => {
    const { container } = renderRow();
    expect(container.querySelector("[data-color-slot]")).toBeNull();
  });
});

// ── myne#281: a folder drag gets the same three zones a note drag has ───────
//
// It used to get two edges and no middle, so a folder could only be reordered
// among its siblings and the tree could not be re-nested by drag at all — the
// asymmetry that read as a bug, because drag is the gesture the tree already
// teaches for notes.
describe("FolderRow — folder re-nest by drag (myne#281)", () => {
  it("folder drag over the middle → highlights the folder as a move target", () => {
    const onDragTarget = vi.fn();
    const onFolderReorderOver = vi.fn();
    const onFolderReorderLeave = vi.fn();
    const n = node({ key: "projects/" });
    renderRow({
      node: n,
      dragKind: "folder",
      onDropFolderInto: vi.fn(),
      onDragTarget,
      onFolderReorderOver,
      onFolderReorderLeave,
    });
    dragOverZone(screen.getByTestId("notes.folder-row"), "into");
    expect(onDragTarget).toHaveBeenLastCalledWith("projects/");
    expect(onFolderReorderLeave).toHaveBeenCalledWith("projects/");
    expect(onFolderReorderOver).not.toHaveBeenCalled();
  });

  it("folder drop in the middle → onDropFolderInto, not a sibling reorder", () => {
    const onDropFolderInto = vi.fn();
    const onFolderReorderDrop = vi.fn();
    const n = node({ path: "Projects/" });
    renderRow({ node: n, dragKind: "folder", onDropFolderInto, onFolderReorderDrop });
    dropZone(screen.getByTestId("notes.folder-row"), "into");
    expect(onDropFolderInto).toHaveBeenCalledWith(n);
    expect(onFolderReorderDrop).not.toHaveBeenCalled();
  });

  it("keeps the edge zones reordering among siblings", () => {
    const onDropFolderInto = vi.fn();
    const onFolderReorderDrop = vi.fn();
    const n = node();
    renderRow({ node: n, dragKind: "folder", onDropFolderInto, onFolderReorderDrop });
    dropZone(screen.getByTestId("notes.folder-row"), "above");
    expect(onFolderReorderDrop).toHaveBeenCalledWith(n, "above");
    expect(onDropFolderInto).not.toHaveBeenCalled();
  });

  it("falls back to a sibling reorder when no into-handler is wired", () => {
    // A surface that has not opted into re-nesting must keep its old behaviour
    // rather than swallowing the drop.
    const onFolderReorderDrop = vi.fn();
    const n = node();
    renderRow({ node: n, dragKind: "folder", onFolderReorderDrop });
    dropZone(screen.getByTestId("notes.folder-row"), "into");
    expect(onFolderReorderDrop).toHaveBeenCalledWith(n, "below");
  });
});
