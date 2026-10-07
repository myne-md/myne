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

/**
 * One CSS rule's own declaration block, comments stripped.
 *
 * Exists because the assertions below used to slice from a selector to the END
 * of the stylesheet and ask whether a value was anywhere in the remainder —
 * which is a question every later rule can answer for you.
 */
function ruleBlock(css: string, selector: string): string {
  const at = css.indexOf(selector + " {");
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open)).replace(/\/\*[\s\S]*?\*\//g, "");
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

  it("frames the image without putting a card around it", () => {
    showAttachmentLightbox({ url: URL_A, alt: "x" });
    const bd = backdrop()!;
    const img = bd.querySelector("img.cm-attach-lightbox-img") as HTMLImageElement;
    const stage = bd.querySelector(".cm-attach-lightbox-stage");
    // There IS a wrapper now, and it has to be there: `mountZoom` fits the
    // image to `stage.clientWidth/clientHeight`, and on the backdrop that
    // measurement includes its padding — so the gutter was invisible to the
    // fit and the picture ran under the × and the zoom bar.
    expect(stage, "no stage to inset the picture into").not.toBeNull();
    expect(img.parentElement).toBe(stage);
    expect(stage!.parentElement).toBe(bd);
    // But it is a FRAME, not a card: the original property still holds, which
    // is that nothing draws a surface around the picture.
    const styleEl = document.getElementById("myne-attachment-insert-styles");
    const stageBlock = ruleBlock(styleEl!.textContent ?? "", ".cm-attach-lightbox-stage");
    for (const prop of [/box-shadow\s*:/, /border\s*:/, /background\s*:/, /padding\s*:/]) {
      expect(stageBlock, `${String(prop)} in ${stageBlock}`).not.toMatch(prop);
    }
  });

  it("caps the preview size (no full-bleed) and carries no white frame in CSS", () => {
    showAttachmentLightbox({ url: URL_A, alt: "x" });
    const styleEl = document.getElementById("myne-attachment-insert-styles");
    expect(styleEl).not.toBeNull();
    const css = styleEl!.textContent ?? "";

    // **Read the rule's own block.** This test used to slice from the
    // selector to the END OF THE STYLESHEET and assert `max-width: min(80vw,
    // 1100px)` / `max-height: 80vh` were "in" it. They were — in the PDF
    // surface's rule, hundreds of characters later. So a test named "caps the
    // preview size" passed for as long as the image rule has said
    // `max-width: 100%`, which is the full-bleed it claims to forbid.
    const imgBlock = ruleBlock(css, ".cm-attach-lightbox-img");
    expect(imgBlock).toContain("object-fit: contain");
    // The image fills its frame; the CAP is the frame, which is the only place
    // it can be, since the fit is computed from the frame's client box.
    expect(imgBlock).toContain("max-width: 100%");
    expect(imgBlock).toContain("max-height: 100%");

    const stageBlock = ruleBlock(css, ".cm-attach-lightbox-stage");
    // A max width, and a height bounded by insets that clear the chrome at
    // both ends — the × / Export row above and the zoom bar below. Asserted as
    // the RELATION rather than as three numbers: what must hold is that the
    // picture stops short of the viewport on every side.
    expect(stageBlock).toMatch(/width:\s*min\(/);
    expect(stageBlock).toMatch(/1600px/);
    const top = Number(/top:\s*(\d+)px/.exec(stageBlock)?.[1]);
    const bottom = Number(/bottom:\s*(\d+)px/.exec(stageBlock)?.[1]);
    // 56px down plus a 32px button is 88px of top chrome; the zoom bar is 20px
    // up and ~42px tall. Anything less and the picture is under them again.
    expect(top, stageBlock).toBeGreaterThanOrEqual(88);
    expect(bottom, stageBlock).toBeGreaterThanOrEqual(62);
    // No white frame on the image itself.
    for (const prop of [/box-shadow\s*:/, /border\s*:/, /background\s*:/, /padding\s*:/]) {
      expect(imgBlock).not.toMatch(prop);
    }
  });

  it("puts the picture on an OPAQUE backdrop, not a scrim", () => {
    // A 72% scrim left the app legible underneath, so a screenshot — which is
    // most of what gets previewed — was read against a tab strip and a sidebar
    // showing through it.
    showAttachmentLightbox({ url: URL_A, alt: "x" });
    const css = document.getElementById("myne-attachment-insert-styles")!.textContent ?? "";
    const block = ruleBlock(css, ".cm-attach-lightbox-backdrop");
    const bg = /background:\s*([^;]+);/.exec(block)?.[1]?.trim();
    expect(bg, block).toBeTruthy();
    // Opaque, however it is spelled. `rgba(…, 0.72)` is the defect; a bare
    // colour, or an alpha of 1, is not.
    const alpha = /rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec(bg!)?.[1];
    expect(alpha === undefined || Number(alpha) === 1, bg).toBe(true);
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
