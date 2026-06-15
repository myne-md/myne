// @vitest-environment jsdom
//
// Unit tests for `<CoverPicker>` — the cover-image picker modal. Covers the
// image-only filter, grid → onPick, the empty state, and the conditional
// "Remove cover" action. Upload / drag-drop (which need the Tauri dialog + IPC)
// are exercised by the E2E "choose existing" path + manual QA, not here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Catalog source — mocked per test.
const catalogListMock = vi.fn();
vi.mock("../../src/lib/attachments", () => ({
  catalogList: () => catalogListMock(),
}));

// Tauri seams pulled in transitively — stub so the import graph loads cleanly.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The thumbnail decrypts via `attachment://`; in jsdom we only care that a tile
// exists per image, so stub it to a marker.
vi.mock("../../src/components/attachments/AttachmentThumbnail", () => ({
  AttachmentThumbnail: ({ id }: { id: string }) => (
    <span data-testid="thumb" data-id={id} />
  ),
}));

import { CoverPicker } from "../../src/components/attachments/CoverPicker";

beforeEach(() => catalogListMock.mockReset());
afterEach(cleanup);

const IMAGE = {
  id: "img1",
  content_type: "image/png",
  created_at: 0,
  filename: "pic.png",
  size: 10,
};
const PDF = {
  id: "pdf1",
  content_type: "application/pdf",
  created_at: 0,
  filename: "doc.pdf",
  size: 20,
};

function renderPicker(over: Partial<Parameters<typeof CoverPicker>[0]> = {}) {
  const props = {
    open: true,
    hasCover: false,
    onClose: vi.fn(),
    onPick: vi.fn(),
    onRemove: vi.fn(),
    ...over,
  };
  render(<CoverPicker {...props} />);
  return props;
}

describe("CoverPicker", () => {
  it("shows only image attachments in the grid", async () => {
    catalogListMock.mockResolvedValue([IMAGE, PDF]);
    renderPicker();
    const tiles = await screen.findAllByTestId("cover-picker.image");
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.getAttribute("data-att-id")).toBe("img1");
  });

  it("clicking a tile calls onPick with the attachment id + filename", async () => {
    catalogListMock.mockResolvedValue([IMAGE]);
    const { onPick } = renderPicker();
    const tile = await screen.findByTestId("cover-picker.image");
    fireEvent.click(tile);
    expect(onPick).toHaveBeenCalledWith({ id: "img1", filename: "pic.png" });
  });

  it("renders the empty state when there are no images", async () => {
    catalogListMock.mockResolvedValue([PDF]); // pdf filtered out → empty grid
    renderPicker();
    expect(await screen.findByTestId("cover-picker.empty")).toBeTruthy();
    expect(screen.queryByTestId("cover-picker.image")).toBeNull();
  });

  it("offers Remove cover only when a cover exists", async () => {
    catalogListMock.mockResolvedValue([IMAGE]);
    const { onRemove } = renderPicker({ hasCover: true });
    await screen.findByTestId("cover-picker.image");
    const remove = screen.getByTestId("cover-picker.remove");
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("hides Remove cover when there is no cover", async () => {
    catalogListMock.mockResolvedValue([IMAGE]);
    renderPicker({ hasCover: false });
    await screen.findByTestId("cover-picker.image");
    expect(screen.queryByTestId("cover-picker.remove")).toBeNull();
  });
});
