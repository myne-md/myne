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

// The file picker — mocked so the upload path is drivable without a host.
const pickFilesMock = vi.fn();
vi.mock("../../src/platform/filePicker", () => ({
  pickFiles: (opts: unknown) => pickFilesMock(opts),
}));

// The thumbnail decrypts via `attachment://`; in jsdom we only care that a tile
// exists per image, so stub it to a marker.
vi.mock("../../src/components/attachments/AttachmentThumbnail", () => ({
  AttachmentThumbnail: ({ id }: { id: string }) => (
    <span data-testid="thumb" data-id={id} />
  ),
}));

import { CoverPicker } from "../../src/components/attachments/CoverPicker";
import { setImportFn } from "../../src/editor/attachments/insert";
import { dismissAttachmentToast } from "../../src/editor/attachments/toast";

beforeEach(() => {
  catalogListMock.mockReset();
  pickFilesMock.mockReset();
});
afterEach(() => {
  cleanup();
  dismissAttachmentToast();
});

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

describe("CoverPicker — ingest-time compression disclosure", () => {
  // A cover image is imported through the same shared-core path a pasted one
  // is, so it is downscaled and re-encoded on the same terms and the original
  // bytes are not kept. `decisions.md` 2026-07-30 makes a notice at import the
  // thing that stands in for a consent gate — which means it is owed on every
  // route that imports, not only the ones inside the editor.
  const picked = [{ kind: "picked", name: "shot.png" }];

  async function clickUpload() {
    catalogListMock.mockResolvedValue([]);
    const props = renderPicker();
    fireEvent.click(await screen.findByTestId("cover-picker.upload"));
    // Let the picker promise + the import promise settle.
    await new Promise((r) => setTimeout(r, 0));
    return props;
  }

  it("shows the notice when the import was compressed", async () => {
    pickFilesMock.mockResolvedValue(picked);
    const restore = setImportFn(async () => ({
      id: "a".repeat(64),
      content_type: "image/webp",
      filename: "shot.webp",
      size: 300,
      created_at: 0,
      deduplicated: false,
      original_size: 2400,
      container_changed: true,
    }));
    const props = await clickUpload();
    restore();
    expect(props.onPick).toHaveBeenCalled();
    expect(document.querySelector(".cm-attach-toast")?.textContent).toBe(
      "Compressed to WebP: 2.3 KiB → 300 B",
    );
  });

  it("stays silent when the import was not compressed", async () => {
    pickFilesMock.mockResolvedValue(picked);
    const restore = setImportFn(async () => ({
      id: "b".repeat(64),
      content_type: "image/png",
      filename: "shot.png",
      size: 300,
      created_at: 0,
      deduplicated: false,
    }));
    const props = await clickUpload();
    restore();
    expect(props.onPick).toHaveBeenCalled();
    expect(document.querySelector(".cm-attach-toast")).toBeNull();
  });
});
