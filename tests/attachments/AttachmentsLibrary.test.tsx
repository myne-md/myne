// @vitest-environment jsdom
//
// AttachmentsLibrary top-bar tests (MYND-164 Fixes 1-3):
//   - Fix 1: it is a SCREEN, not a modal — NO × close button in the top bar.
//   - Fix 2: responsive top bar — the row wraps and the search field shrinks
//     (flex with min-width: 0) so controls stay visible when the right sidebar
//     narrows the pane.
//   - Fix 3: the grid/list view toggle is a BORDERED button matching the sort
//     select + Import button (border token + radius + height), and it toggles.
//
// The catalog + referencing-notes IPC wrappers + the PDF renderer are mocked so
// the surface renders deterministically without a backend.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AttachmentsLibrary } from "../../src/components/attachments/AttachmentsLibrary";
import { SidebarStateProvider } from "../../src/notes/sidebarState";
import { catalogList, type CatalogEntry } from "../../src/lib/attachments";
import { referencingNotes } from "../../src/notes/attachmentRefs";

vi.mock("../../src/lib/attachments", () => ({
  catalogList: vi.fn(),
  attachmentImport: vi.fn(),
  attachmentDelete: vi.fn(),
  attachmentRename: vi.fn(),
}));
vi.mock("../../src/notes/attachmentRefs", () => ({
  referencingNotes: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../src/editor/attachments/pdf-render", () => ({
  // never resolves → stays on the placeholder icon; irrelevant to top-bar tests.
  renderPdfFirstPage: vi.fn().mockReturnValue(new Promise(() => {})),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const mockedCatalog = vi.mocked(catalogList);
const mockedRefs = vi.mocked(referencingNotes);

const ENTRY: CatalogEntry = {
  id: "a".repeat(64),
  content_type: "image/png",
  folder: "",
  created_at: 1_700_000_000,
  filename: "diagram.png",
  size: 2048,
};

function renderLibrary() {
  return render(
    <SidebarStateProvider>
      <AttachmentsLibrary />
    </SidebarStateProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockedRefs.mockResolvedValue([]);
});

describe("AttachmentsLibrary top bar", () => {
  it("does NOT render a × close button (it is a screen, not a modal)", async () => {
    mockedCatalog.mockResolvedValue([ENTRY]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("diagram.png")).toBeTruthy());

    expect(screen.queryByLabelText("Close attachments")).toBeNull();
  });

  it("renders the bordered grid/list view toggle and toggles the view", async () => {
    mockedCatalog.mockResolvedValue([ENTRY]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("diagram.png")).toBeTruthy());

    // Starts in grid → the toggle offers "List view" and carries the bordered
    // chrome (matching the sort select / Import button: 1px line + radius).
    const toggle = screen.getByLabelText("List view");
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.style.border).toContain("var(--line-2)");
    expect(toggle.style.borderRadius).toBe("var(--radius-2)");
    expect(toggle.style.height).toBe("30px");

    // Clicking flips to list view → the toggle now offers "Grid view".
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Grid view")).toBeTruthy();
    expect(screen.queryByLabelText("List view")).toBeNull();
  });

  it("uses the custom Select primitive for the type filter + sort (no native <select> remains)", async () => {
    mockedCatalog.mockResolvedValue([ENTRY]);
    const { container } = renderLibrary();
    await waitFor(() => expect(screen.getByText("diagram.png")).toBeTruthy());

    // Fix 1 (MYND-164): the OS-native <select> is gone entirely from the
    // attachments library — both dropdowns are the token-styled custom Select.
    expect(container.querySelector("select")).toBeNull();

    const filter = screen.getByRole("combobox", { name: "Filter by type" });
    const sort = screen.getByRole("combobox", { name: "Sort attachments" });
    expect(filter.tagName).toBe("BUTTON");
    expect(sort.tagName).toBe("BUTTON");
    // The current selection shows on each trigger.
    expect(filter.textContent).toContain("All types");
    expect(sort.textContent).toContain("Newest first");
  });

  it("the custom sort Select opens a listbox and changes the selection", async () => {
    mockedCatalog.mockResolvedValue([ENTRY]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("diagram.png")).toBeTruthy());

    const sort = screen.getByRole("combobox", { name: "Sort attachments" });
    fireEvent.click(sort);
    // The catalog spells it with a hyphen (8d665d2f normalized the en dash
    // away); the accessible name must match the rendered label exactly.
    fireEvent.click(screen.getByRole("option", { name: "Name A-Z" }));
    expect(sort.textContent).toContain("Name A-Z");
  });

  it("keeps a shrinkable, min-width:0 search field so it stays usable when the pane narrows", async () => {
    mockedCatalog.mockResolvedValue([ENTRY]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("diagram.png")).toBeTruthy());

    const search = screen.getByLabelText("Search attachments by filename");
    // The input itself can shrink to zero (the wrapper owns the floor).
    expect(search.style.minWidth).toBe("0px");
    // Its bordered wrapper flexes (grow + shrink) rather than holding a fixed
    // width, so it gives way to the trailing controls instead of overflowing.
    const wrap = search.parentElement!;
    expect(wrap.style.flex).toContain("1");
  });

  it("lifts the focus ring to the WHOLE search wrapper on input focus, not the inner input", async () => {
    mockedCatalog.mockResolvedValue([ENTRY]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("diagram.png")).toBeTruthy());

    const search = screen.getByLabelText("Search attachments by filename");
    const wrap = search.parentElement!;

    // Idle: the wrapper carries the neutral hairline, no ring; the inner input
    // never owns an outline/border of its own (only the wrapper ever lights up).
    expect(wrap.style.boxShadow).toBe("");
    expect(search.style.outline).toBe("none");
    expect(search.style.border).toBe("0px");

    // Focusing the input lights up the WRAPPER: accent border + a single
    // adjacent soft halo (one focus indicator, not a double ring).
    fireEvent.focus(search);
    expect(wrap.style.borderColor).toBe("var(--accent)");
    expect(wrap.style.boxShadow).toContain("var(--accent-soft");
    // The inner input still has no outline/border of its own.
    expect(search.style.outline).toBe("none");
    expect(search.style.border).toBe("0px");

    // Blur removes the wrapper ring.
    fireEvent.blur(search);
    expect(wrap.style.boxShadow).toBe("");
    expect(wrap.style.borderColor).not.toBe("var(--accent)");
  });

  it("does NOT push the trailing controls with margin-left:auto (Fix 5 — aligned wrapped row)", async () => {
    mockedCatalog.mockResolvedValue([ENTRY]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("diagram.png")).toBeTruthy());

    // The trailing control cluster shares the filter <select> as a child.
    // Its container must NOT carry `marginLeft: auto` — that push caused the
    // lopsided gap when the row wrapped behind the right sidebar.
    const filter = screen.getByLabelText("Filter by type");
    const controls = filter.parentElement!;
    expect(controls.style.marginLeft).not.toBe("auto");
    // The flexible search field (flex: 1) is what fills line 1 at full width,
    // so removing the margin keeps full-width right-alignment without the
    // wrapped-row misalignment.
    const search = screen.getByLabelText("Search attachments by filename");
    expect(search.parentElement!.style.flex).toContain("1");
  });
});
