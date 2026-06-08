// @vitest-environment jsdom
//
// Click-to-preview lightbox (MYND-164 dogfooding fix #3).
//
//   - opens a centered backdrop + full-size <img> using the same attachment URL
//   - Esc closes it
//   - a click on the dimmed backdrop closes it
//   - a click on the image itself does NOT close it
//   - opening a second lightbox replaces the first (only one ever open)

import { afterEach, describe, expect, it } from "vitest";
import {
  dismissAttachmentLightbox,
  showAttachmentLightbox,
} from "../../src/editor/attachments/lightbox";

const URL_A = "attachment://" + "a".repeat(64);
const URL_B = "attachment://" + "b".repeat(64);

afterEach(() => {
  dismissAttachmentLightbox();
});

function backdrop(): HTMLElement | null {
  return document.querySelector(".cm-attach-lightbox-backdrop");
}

describe("attachment lightbox", () => {
  it("opens a backdrop with a full-size image at the attachment URL", () => {
    showAttachmentLightbox({ url: URL_A, alt: "photo.png" });
    const bd = backdrop();
    expect(bd).not.toBeNull();
    expect(bd!.getAttribute("role")).toBe("dialog");
    expect(bd!.getAttribute("aria-modal")).toBe("true");
    const img = bd!.querySelector("img.cm-attach-lightbox-img") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(URL_A);
    expect(img!.alt).toBe("photo.png");
  });

  it("closes on Escape", () => {
    showAttachmentLightbox({ url: URL_A, alt: "x" });
    expect(backdrop()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(backdrop()).toBeNull();
  });

  it("closes when the dimmed backdrop is clicked", () => {
    showAttachmentLightbox({ url: URL_A, alt: "x" });
    const bd = backdrop()!;
    // mousedown with target === backdrop closes.
    const ev = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(ev, "target", { value: bd });
    bd.dispatchEvent(ev);
    expect(backdrop()).toBeNull();
  });

  it("does NOT close when the image itself is clicked", () => {
    showAttachmentLightbox({ url: URL_A, alt: "x" });
    const bd = backdrop()!;
    const img = bd.querySelector("img")!;
    const ev = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(ev, "target", { value: img });
    bd.dispatchEvent(ev);
    expect(backdrop()).not.toBeNull();
  });

  it("replaces an open lightbox when opened again (only one at a time)", () => {
    showAttachmentLightbox({ url: URL_A, alt: "a" });
    showAttachmentLightbox({ url: URL_B, alt: "b" });
    const all = document.querySelectorAll(".cm-attach-lightbox-backdrop");
    expect(all.length).toBe(1);
    const img = all[0]!.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(URL_B);
  });

  it("renders an explicit close button with a DOM-built (non-innerHTML) x icon", () => {
    showAttachmentLightbox({ url: URL_A, alt: "x" });
    const bd = backdrop()!;
    const btn = bd.querySelector("button.cm-attach-lightbox-close") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toBe("Close preview");
    // The glyph is a real SVG element (createElementNS), not an emoji / text.
    const svg = btn!.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg!.querySelectorAll("path").length).toBe(2);
    // No emoji / textual ×.
    expect(btn!.textContent).toBe("");
  });

  it("closes when the close button is clicked", () => {
    showAttachmentLightbox({ url: URL_A, alt: "x" });
    const btn = backdrop()!.querySelector(
      "button.cm-attach-lightbox-close",
    ) as HTMLButtonElement;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(backdrop()).toBeNull();
  });

  it("has no white-frame wrapper around the image — image is a direct backdrop child", () => {
    showAttachmentLightbox({ url: URL_A, alt: "x" });
    const bd = backdrop()!;
    const img = bd.querySelector("img.cm-attach-lightbox-img") as HTMLImageElement;
    // The image's direct parent is the backdrop itself, not an intermediate
    // framed/padded box.
    expect(img.parentElement).toBe(bd);
  });

  it("caps the preview size (no full-bleed) and carries no white frame in CSS", () => {
    showAttachmentLightbox({ url: URL_A, alt: "x" });
    const styleEl = document.getElementById("myne-attachment-insert-styles");
    expect(styleEl).not.toBeNull();
    const css = styleEl!.textContent ?? "";
    const imgRule = css.slice(css.indexOf(".cm-attach-lightbox-img"));
    expect(imgRule).toContain("max-width: min(80vw, 1100px)");
    expect(imgRule).toContain("max-height: 80vh");
    expect(imgRule).toContain("object-fit: contain");
    // No white frame on the image: no border / background / box-shadow /
    // padding *declarations* (strip the comment first so its prose doesn't
    // trip the property check).
    const imgBlock = imgRule
      .slice(0, imgRule.indexOf("}"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(imgBlock).not.toMatch(/box-shadow\s*:/);
    expect(imgBlock).not.toMatch(/border\s*:/);
    expect(imgBlock).not.toMatch(/background\s*:/);
    expect(imgBlock).not.toMatch(/padding\s*:/);
  });

  it("Escape listener is removed after close (no leak on second Esc)", () => {
    showAttachmentLightbox({ url: URL_A, alt: "x" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    // A second Escape with nothing open must not throw.
    expect(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    ).not.toThrow();
    expect(backdrop()).toBeNull();
  });
});
