// @vitest-environment jsdom
//
// Mobile tap-to-open for inline images (MYND-594). Before this, `MarkdownView`
// rendered an `<img>` with NO handler — tapping an image on a phone did nothing,
// the worst case (smallest screen, least recourse). This pins the fix: tapping a
// rendered attachment image opens the SHARED @myne/editor lightbox (which now
// carries the zoom/pan the desktop reader gained in the same change).
//
// A component render (react-dom, no testing-library — mobile's convention) with
// the lightbox + attachment-URL modules mocked, so the assertion is purely
// "the tap calls the shared lightbox with this image's url/alt/id".

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

vi.mock("@myne/editor/attachments/lightbox", () => ({
  showAttachmentLightbox: vi.fn(),
}));
vi.mock("../src/lib/attachmentRef", () => ({
  attachmentSrc: (id: string) => `mock-attachment://${id}`,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { showAttachmentLightbox } from "@myne/editor/attachments/lightbox";
import { MarkdownView } from "../src/components/MarkdownView";

const ID = "a".repeat(64); // a valid 64-hex attachment id for the embed rule

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("MarkdownView inline image → shared lightbox (MYND-594)", () => {
  it("tapping a rendered attachment image opens the lightbox with its url/alt/id", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        createElement(MarkdownView, {
          text: `![[att:${ID}|photo.png]]`,
          onOpenWikilink: () => {},
          fontFamily: "var(--font-sans)",
          fontSize: 15,
        }),
      );
    });

    const img = container.querySelector<HTMLImageElement>(
      '[data-testid="markdown.image"]',
    );
    expect(img, "the attachment image should render (not the fallback chip)").not.toBeNull();

    img!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(showAttachmentLightbox).toHaveBeenCalledTimes(1);
    expect(showAttachmentLightbox).toHaveBeenCalledWith({
      url: `mock-attachment://${ID}`,
      alt: "photo.png",
      id: ID,
    });

    flushSync(() => root.unmount());
  });
});
