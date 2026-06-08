// @vitest-environment jsdom
//
// Lightbox PDF mode (epic MYND-164).
//
// `showAttachmentLightbox({ kind: "pdf" })` mounts the scrollable multi-page
// reader instead of an <img>, at the bigger size, with the same × / Esc /
// backdrop-click close. The reader is torn down (cleanup) on dismiss. The
// reader itself (`mountPdfScroller`) is mocked — jsdom can't run pdf.js; we
// assert the wiring (surface present, scroller invoked with the right url +
// bigger page width, cleanup called on close).

import { afterEach, describe, expect, it, vi } from "vitest";

const { cleanup, mountPdfScroller } = vi.hoisted(() => {
  const cleanup = vi.fn();
  return { cleanup, mountPdfScroller: vi.fn(() => cleanup) };
});
vi.mock("../../src/editor/attachments/pdf-reader", () => ({
  mountPdfScroller,
}));

import {
  dismissAttachmentLightbox,
  showAttachmentLightbox,
} from "../../src/editor/attachments/lightbox";

const URL = "attachment://" + "d".repeat(64);

afterEach(() => {
  dismissAttachmentLightbox();
  vi.clearAllMocks();
});

function backdrop(): HTMLElement | null {
  return document.querySelector(".cm-attach-lightbox-backdrop");
}

describe("attachment lightbox — PDF mode", () => {
  it("mounts the scrollable reader (no <img>) at the bigger page width", () => {
    showAttachmentLightbox({ url: URL, alt: "report.pdf", kind: "pdf" });
    const bd = backdrop();
    expect(bd).not.toBeNull();
    expect(bd!.classList.contains("cm-attach-lightbox-backdrop-pdf")).toBe(true);
    expect(bd!.getAttribute("role")).toBe("dialog");

    // The reader surface is present; no <img>.
    const surface = bd!.querySelector(".cm-attach-lightbox-pdf");
    expect(surface).not.toBeNull();
    expect(bd!.querySelector("img.cm-attach-lightbox-img")).toBeNull();

    // mountPdfScroller was invoked with the surface, the attachment URL, and a
    // bigger page width than the inline 320.
    expect(mountPdfScroller).toHaveBeenCalledTimes(1);
    const [arg0, arg1] = mountPdfScroller.mock.calls[0]!;
    expect(arg0).toBe(surface);
    expect((arg1 as { url: string }).url).toBe(URL);
    expect((arg1 as { pageWidth: number }).pageWidth).toBeGreaterThan(320);
  });

  it("tears the reader down on Escape", () => {
    showAttachmentLightbox({ url: URL, alt: "x", kind: "pdf" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(backdrop()).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("tears the reader down on a backdrop click", () => {
    showAttachmentLightbox({ url: URL, alt: "x", kind: "pdf" });
    const bd = backdrop()!;
    const ev = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(ev, "target", { value: bd });
    bd.dispatchEvent(ev);
    expect(backdrop()).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("tears the reader down via the × close button", () => {
    showAttachmentLightbox({ url: URL, alt: "x", kind: "pdf" });
    const btn = backdrop()!.querySelector(
      "button.cm-attach-lightbox-close",
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(backdrop()).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("renders the icon fallback in the surface when the reader errors", () => {
    // Drive the onError callback synchronously.
    mountPdfScroller.mockImplementationOnce((_surface, opts) => {
      (opts as { onError?: (e: unknown) => void }).onError?.(
        new Error("pdf.js unavailable"),
      );
      return cleanup;
    });
    showAttachmentLightbox({ url: URL, alt: "x", kind: "pdf" });
    const fb = backdrop()!.querySelector(".cm-attach-lightbox-pdf-fallback");
    expect(fb).not.toBeNull();
    expect(fb!.textContent).toBe("PDF");
  });

  it("defaults to image mode (no scroller) when kind is omitted", () => {
    showAttachmentLightbox({ url: URL, alt: "photo.png" });
    const bd = backdrop()!;
    expect(bd.querySelector("img.cm-attach-lightbox-img")).not.toBeNull();
    expect(mountPdfScroller).not.toHaveBeenCalled();
  });
});
