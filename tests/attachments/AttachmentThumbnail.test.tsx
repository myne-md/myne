// @vitest-environment jsdom
//
// AttachmentThumbnail tests (MYND-164 Fix 4) — PDF first-page wiring with the
// mandatory generic-icon fallback (SYNC-5), plus the image / non-image paths.
//
// `renderPdfFirstPage` is mocked so the PDF path is deterministic without
// pdf.js + a real canvas: a resolving mock proves the rendered page is shown,
// a rejecting mock proves the generic PDF icon fallback.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { AttachmentThumbnail } from "../../src/components/attachments/AttachmentThumbnail";
import { renderPdfFirstPage } from "../../src/editor/attachments/pdf-render";

vi.mock("../../src/editor/attachments/pdf-render", () => ({
  renderPdfFirstPage: vi.fn(),
}));

// `attachmentUrl` is pure (string build); keep the real impl so the URL passed
// to the renderer is the genuine `att://<id>` form.

const mockedRender = vi.mocked(renderPdfFirstPage);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AttachmentThumbnail — PDF", () => {
  it("renders the pdf.js first page when the render resolves", async () => {
    const canvas = document.createElement("canvas");
    canvas.toDataURL = () => "data:image/png;base64,RENDERED";
    mockedRender.mockResolvedValue(canvas);

    const { container } = render(
      <AttachmentThumbnail
        id="abc123"
        contentType="application/pdf"
        filename="report.pdf"
        size={160}
      />,
    );

    // It calls the reusable editor renderer with the attachment URL + width.
    expect(mockedRender).toHaveBeenCalledTimes(1);
    const arg = mockedRender.mock.calls[0]![0];
    expect(arg.url).toContain("abc123");
    expect(arg.width).toBe(160);

    // The `<img>` ELEMENT, not the `img` ROLE: the fallback icon carries
    // `role="img"` too (axe `aria-prohibited-attr`), so a role query answers
    // "is anything a graphic" and stops distinguishing the rendered page.
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("data:image/png;base64,RENDERED");
  });

  it("falls back to the generic PDF icon when the render rejects", async () => {
    mockedRender.mockRejectedValue(new Error("pdf.js unavailable"));

    const { container } = render(
      <AttachmentThumbnail
        id="def456"
        contentType="application/pdf"
        filename="broken.pdf"
        size={160}
      />,
    );

    // The fallback is the labelled "PDF document" icon box, never an <img>.
    await waitFor(() => {
      expect(screen.getByLabelText("PDF document")).toBeTruthy();
    });
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows the PDF icon placeholder while the render is in flight", () => {
    // A never-resolving promise keeps the component in its loading state.
    mockedRender.mockReturnValue(new Promise(() => {}));

    const { container } = render(
      <AttachmentThumbnail
        id="ghi789"
        contentType="application/pdf"
        filename="slow.pdf"
        size={160}
      />,
    );

    expect(screen.getByLabelText("PDF document")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("AttachmentThumbnail — non-PDF", () => {
  it("renders an <img> for images and never invokes the PDF renderer", () => {
    const { container } = render(
      <AttachmentThumbnail
        id="img001"
        contentType="image/png"
        filename="photo.png"
        size={160}
      />,
    );

    const img = container.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("photo.png");
    expect(mockedRender).not.toHaveBeenCalled();
  });

  it("renders the generic file icon for unknown types", () => {
    const { container } = render(
      <AttachmentThumbnail
        id="zip001"
        contentType="application/zip"
        filename="archive.zip"
        size={160}
      />,
    );

    expect(screen.getByLabelText("File")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(mockedRender).not.toHaveBeenCalled();
  });
});
