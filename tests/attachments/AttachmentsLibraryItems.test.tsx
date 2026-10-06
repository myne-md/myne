// @vitest-environment jsdom
//
// AttachmentsLibrary per-item tests (MYND-164 second polish round):
//   - Fix 2: each tile/row exposes a single ⋮ (more-vertical) menu whose items
//     are Preview (renderable only) · Export · Rename · Delete — via a portal.
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
import type { TitleRecord } from "../../src/notes/loadNoteBatch";
import type { NoteId } from "@myne/editor/host/notes/itemOrder";

vi.mock("../../src/lib/attachments", () => ({
  catalogList: vi.fn(),
  attachmentImport: vi.fn(),
  attachmentDelete: vi.fn(),
  attachmentRename: vi.fn(),
}));
vi.mock("../../src/notes/attachmentRefs", () => ({
  referencingNotes: vi.fn().mockResolvedValue(["note-1", "note-2"]),
}));
// #212 counts only the notes the user actually sees, reading the sidebar's
// title cache and dropping every id absent from it. The provider fills that
// cache from IPC, which is mocked away here — so the two referencing ids are
// injected as live records, or the count collapses to zero and the popover
// triggers this file asserts on never render.
vi.mock("../../src/notes/sidebarState", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/notes/sidebarState")>();
  return {
    ...real,
    useSelectedNote: () => ({
      ...real.useSelectedNote(),
      cache: LIVE_TITLE_CACHE,
    }),
  };
});
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

/** A live (non-conflict, non-trashed, non-template) title-cache record. */
function liveTitleRecord(noteUuid: string): TitleRecord {
  return {
    noteUuid,
    title: noteUuid,
    folder: null,
    updatedAt: null,
    trashed: null,
    deleted: null,
    archived: null,
    template: false,
    folderIndex: false,
    conflict: false,
    conflictOf: null,
    hasSource: false,
    kind: null,
    done: null,
  };
}

const LIVE_TITLE_CACHE = new Map<NoteId, TitleRecord>([
  ["note-1" as NoteId, liveTitleRecord("note-1")],
  ["note-2" as NoteId, liveTitleRecord("note-2")],
]);

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
      <AttachmentsLibrary />
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

  it("opens a Preview · Export · Rename · Delete menu (portal) on ⋮ click", async () => {
    mockedCatalog.mockResolvedValue([ENTRY_A]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("alpha.png")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Attachment actions"));

    const menu = screen.getByRole("menu");
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.textContent);
    // Image entry → previewable → Preview present; Export available for all.
    expect(items).toEqual(["Preview", "Export", "Rename", "Delete"]);
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
      id: ENTRY_A.id,
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

describe("AttachmentsLibrary thumbnail click-to-open (MYND-164 revised)", () => {
  // MYND-164 revised: the hover-revealed expand button is gone. A previewable
  // (image / PDF) thumbnail is itself the click target — role="button",
  // aria-label "Preview attachment", data-testid "attachments.tile-preview-target"
  // — in BOTH grid and list view (no hover state, no view gating).

  it("the image thumbnail is a preview button in GRID view (no hover)", async () => {
    mockedCatalog.mockResolvedValue([ENTRY_A]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("alpha.png")).toBeTruthy());

    // Default view is grid — the affordance is present immediately, not on hover.
    const target = screen.getByTestId("attachments.tile-preview-target");
    expect(target.getAttribute("role")).toBe("button");
    expect(target.getAttribute("aria-label")).toBe("Preview attachment");
  });

  it("clicking the image thumbnail opens the image lightbox", async () => {
    mockedCatalog.mockResolvedValue([ENTRY_A]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("alpha.png")).toBeTruthy());

    fireEvent.click(screen.getByTestId("attachments.tile-preview-target"));

    expect(mockedLightbox).toHaveBeenCalledWith({
      url: `attachment://${ENTRY_A.id}`,
      alt: "alpha.png",
      kind: "image",
      id: ENTRY_A.id,
    });
  });

  it("the image thumbnail is ALSO a preview button in LIST view", async () => {
    mockedCatalog.mockResolvedValue([ENTRY_A]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("alpha.png")).toBeTruthy());

    // Switch to list view — the small row thumbnail stays click-to-open now.
    fireEvent.click(screen.getByLabelText("List view"));
    await waitFor(() => expect(screen.getByLabelText("Grid view")).toBeTruthy());

    fireEvent.click(screen.getByTestId("attachments.tile-preview-target"));
    expect(mockedLightbox).toHaveBeenCalledWith({
      url: `attachment://${ENTRY_A.id}`,
      alt: "alpha.png",
      kind: "image",
      id: ENTRY_A.id,
    });
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

  it("the PDF thumbnail is a preview button in GRID view", async () => {
    mockedCatalog.mockResolvedValue([PDF_ENTRY]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeTruthy());

    // The PDF tile's thumbnail box still renders the first-page-render placeholder
    // (the "PDF document" icon while the mocked renderer never resolves), wrapped
    // in the click-to-open preview target.
    const target = screen.getByTestId("attachments.tile-preview-target");
    expect(target.getAttribute("role")).toBe("button");
    expect(within(target).getAllByLabelText("PDF document")[0]).toBeTruthy();
  });

  it("clicking the PDF thumbnail opens the lightbox in pdf (scrollable reader) mode", async () => {
    mockedCatalog.mockResolvedValue([PDF_ENTRY]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeTruthy());

    fireEvent.click(screen.getByTestId("attachments.tile-preview-target"));

    expect(mockedLightbox).toHaveBeenCalledWith({
      url: `attachment://${PDF_ENTRY.id}`,
      alt: "report.pdf",
      kind: "pdf",
      id: PDF_ENTRY.id,
    });
  });

  it("omits Preview for a non-renderable (octet-stream) file, keeping Export", async () => {
    // MYND-173: a generic file falls back to the editor file-card and is NOT
    // previewable; the library menu drops Preview but still offers Export.
    const generic: CatalogEntry = {
      id: "c".repeat(64),
      content_type: "application/octet-stream",
      filename: "notes.docx",
      size: 4096,
      created_at: 1_700_000_000,
    };
    mockedCatalog.mockResolvedValue([generic]);
    renderLibrary();
    await waitFor(() => expect(screen.getByText("notes.docx")).toBeTruthy());

    // Non-previewable → the thumbnail is NOT a click-to-open target.
    expect(screen.queryByTestId("attachments.tile-preview-target")).toBeNull();

    fireEvent.click(screen.getByLabelText("Attachment actions"));
    const items = within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((el) => el.textContent);
    expect(items).toEqual(["Export", "Rename", "Delete"]);
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
