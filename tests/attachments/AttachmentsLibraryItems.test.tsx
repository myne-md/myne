// @vitest-environment jsdom
//
// AttachmentsLibrary per-item tests (MYND-164 second polish round):
//   - Fix 2: each tile/row exposes a single ⋮ (more-vertical) menu whose items
//     are exactly Preview · Rename · Delete — rendered via a portal.
//   - Fix 3: the standalone "insert into current note" action is fully gone
//     (no Insert button, no arrow-right affordance on any tile).
//   - Fix 6: only ONE "used in notes" popover is open at a time — opening a
//     second tile's popover closes the first.
//
// The catalog + referencing-notes IPC wrappers + the PDF renderer + the
// lightbox are mocked so the surface renders deterministically without a
// backend.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { AttachmentsLibrary } from "../../src/components/attachments/AttachmentsLibrary";
import { SidebarStateProvider } from "../../src/notes/sidebarState";
import { catalogList, type CatalogEntry } from "../../src/lib/attachments";
import { referencingNotes } from "../../src/notes/attachmentRefs";
import { showAttachmentLightbox } from "../../src/editor/attachments/lightbox";

vi.mock("../../src/lib/attachments", () => ({
  catalogList: vi.fn(),
  attachmentImport: vi.fn(),
  attachmentDelete: vi.fn(),
  attachmentRename: vi.fn(),
}));
vi.mock("../../src/notes/attachmentRefs", () => ({
  referencingNotes: vi.fn().mockResolvedValue(["note-1", "note-2"]),
}));
vi.mock("../../src/editor/attachments/pdf-render", () => ({
  renderPdfFirstPage: vi.fn().mockReturnValue(new Promise(() => {})),
}));
vi.mock("../../src/editor/attachments/lightbox", () => ({
  showAttachmentLightbox: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const mockedCatalog = vi.mocked(catalogList);
const mockedRefs = vi.mocked(referencingNotes);
const mockedLightbox = vi.mocked(showAttachmentLightbox);

const ENTRY_A: CatalogEntry = {
  id: "a".repeat(64),
  content_type: "image/png",
  created_at: 1_700_000_000,
  filename: "alpha.png",
  size: 2048,
};
const ENTRY_B: CatalogEntry = {
  id: "b".repeat(64),
  content_type: "image/png",
  created_at: 1_700_000_500,
  filename: "bravo.png",
  size: 4096,
};

function renderLibrary() {
  return render(
    <SidebarStateProvider>
      <AttachmentsLibrary onClose={() => {}} />
    </SidebarStateProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockedRefs.mockResolvedValue(["note-1", "note-2"]);
});

describe("AttachmentsLibrary per-item ⋮ menu (Fix 2 + Fix 3)", () => {
  it("the insert-into-note action is fully removed (no Insert affordance)", async () => {
    mockedCatalog.mockResolvedValue([ENTRY_A]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("alpha.png")).toBeTruthy());

    expect(screen.queryByLabelText("Insert into current note")).toBeNull();
    expect(screen.queryByText("Insert")).toBeNull();
  });

  it("collapses item actions into one ⋮ menu trigger per item", async () => {
    mockedCatalog.mockResolvedValue([ENTRY_A]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("alpha.png")).toBeTruthy());

    const triggers = screen.getAllByLabelText("Attachment actions");
    expect(triggers).toHaveLength(1);
    // The menu is closed until the ⋮ is clicked.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens a Preview · Rename · Delete menu (portal) on ⋮ click", async () => {
    mockedCatalog.mockResolvedValue([ENTRY_A]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("alpha.png")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Attachment actions"));

    const menu = screen.getByRole("menu");
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.textContent);
    expect(items).toEqual(["Preview", "Rename", "Delete"]);
  });

  it("Preview opens the shared lightbox with the attachment URL", async () => {
    mockedCatalog.mockResolvedValue([ENTRY_A]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("alpha.png")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Attachment actions"));
    fireEvent.click(screen.getByText("Preview"));

    expect(mockedLightbox).toHaveBeenCalledWith({
      url: `attachment://${ENTRY_A.id}`,
      alt: "alpha.png",
      kind: "image",
    });
  });

  it("Rename enters inline-rename mode for the item", async () => {
    mockedCatalog.mockResolvedValue([ENTRY_A]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("alpha.png")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Attachment actions"));
    fireEvent.click(screen.getByText("Rename"));

    // The filename becomes an editable input seeded with the current name.
    const input = screen.getByDisplayValue("alpha.png");
    expect(input.tagName).toBe("INPUT");
  });
});

describe("AttachmentsLibrary hover-preview is grid-only (MYND-164 Fix 2)", () => {
  // Surface the hover-preview button by hovering the thumbnail's wrapper (the
  // element whose onMouseEnter flips the hovering state).
  function hoverThumb(container: HTMLElement) {
    const img = container.querySelector('img[alt="alpha.png"]');
    // The image renders as the direct child of the hover wrapper
    // (THUMB_HOVER_WRAP) whose onMouseEnter flips the hovering state.
    const wrap = img?.parentElement ?? container;
    fireEvent.mouseEnter(wrap);
  }

  it("shows the preview button on hover in GRID view", async () => {
    mockedCatalog.mockResolvedValue([ENTRY_A]);
    const { container } = renderLibrary();
    await waitFor(() => expect(screen.getByText("alpha.png")).toBeTruthy());

    // Default view is grid. Before hover the affordance is hidden.
    expect(screen.queryByLabelText("Preview attachment")).toBeNull();
    hoverThumb(container);
    expect(screen.getByLabelText("Preview attachment")).toBeTruthy();
  });

  it("does NOT show the preview button on hover in LIST view", async () => {
    mockedCatalog.mockResolvedValue([ENTRY_A]);
    const { container } = renderLibrary();
    await waitFor(() => expect(screen.getByText("alpha.png")).toBeTruthy());

    // Switch to list view.
    fireEvent.click(screen.getByLabelText("List view"));
    await waitFor(() => expect(screen.getByLabelText("Grid view")).toBeTruthy());

    hoverThumb(container);
    // List rows pass showPreview={false}: no hover-preview affordance ever.
    expect(screen.queryByLabelText("Preview attachment")).toBeNull();
  });
});

describe("AttachmentsLibrary PDF tile preview → scrollable reader (MYND-164)", () => {
  const PDF_ENTRY: CatalogEntry = {
    id: "f".repeat(64),
    content_type: "application/pdf",
    created_at: 1_700_000_900,
    filename: "report.pdf",
    size: 8192,
  };

  it("shows the hover-preview button on a PDF tile in GRID view", async () => {
    mockedCatalog.mockResolvedValue([PDF_ENTRY]);
    const { container } = renderLibrary();
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeTruthy());

    // The PDF tile's thumbnail box still renders the first-page-render placeholder
    // (the "PDF document" icon while the mocked renderer never resolves).
    const placeholder = screen.getAllByLabelText("PDF document")[0]!;
    const wrap = placeholder.closest("div")!.parentElement!;

    expect(screen.queryByLabelText("Preview attachment")).toBeNull();
    fireEvent.mouseEnter(wrap);
    expect(screen.getByLabelText("Preview attachment")).toBeTruthy();
  });

  it("clicking the PDF preview opens the lightbox in pdf (scrollable reader) mode", async () => {
    mockedCatalog.mockResolvedValue([PDF_ENTRY]);
    const { container } = renderLibrary();
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeTruthy());

    const placeholder = screen.getAllByLabelText("PDF document")[0]!;
    const wrap = placeholder.closest("div")!.parentElement!;
    fireEvent.mouseEnter(wrap);
    fireEvent.click(screen.getByLabelText("Preview attachment"));

    expect(mockedLightbox).toHaveBeenCalledWith({
      url: `attachment://${PDF_ENTRY.id}`,
      alt: "report.pdf",
      kind: "pdf",
    });
  });
});

describe("AttachmentsLibrary single used-in-notes popover (Fix 6)", () => {
  it("opening a second tile's popover closes the first (only one open)", async () => {
    mockedCatalog.mockResolvedValue([ENTRY_A, ENTRY_B]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("alpha.png")).toBeTruthy());
    // Both "Used in 2 notes" triggers resolve their refs.
    await waitFor(() =>
      expect(screen.getAllByText("Used in 2 notes")).toHaveLength(2),
    );

    const [triggerA, triggerB] = screen.getAllByText("Used in 2 notes");

    // Open A's popover → exactly one popover (role=menu) in the document.
    fireEvent.click(triggerA);
    await waitFor(() => expect(screen.getAllByRole("menu")).toHaveLength(1));

    // Open B's popover → A's must close; still exactly one popover.
    fireEvent.click(triggerB);
    await waitFor(() => expect(screen.getAllByRole("menu")).toHaveLength(1));
  });
});
