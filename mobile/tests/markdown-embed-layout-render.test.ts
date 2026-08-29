// @vitest-environment jsdom
//
// What the mobile renderer actually DOES with a form-C embed's layout segments
// (myne-md/myne#518). `attachment-embed.test.ts` pins the token: that the alias
// is split and that `layout.alt` keeps `""` distinct from `null`. This pins the
// half that a user can see, because the two are independently breakable: the
// token carried the layout whole for a while before any renderer read it, and
// the phone drew every note at default size while the tests were green.
//
// A component render (react-dom, no testing-library, mobile's convention) with
// the attachment-URL and lightbox modules mocked, so the assertions are about
// the DOM this component produced and nothing else.

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

import { MarkdownView } from "../src/components/MarkdownView";

const ID = "a".repeat(64);

function renderEmbed(alias: string): HTMLImageElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      createElement(MarkdownView, {
        text: `![[att:${ID}|${alias}]]`,
        onOpenWikilink: () => {},
        fontFamily: "var(--font-sans)",
        fontSize: 15,
      }),
    );
  });
  const img = container.querySelector<HTMLImageElement>('[data-testid="markdown.image"]');
  expect(img, "the attachment image should render, not the fallback chip").not.toBeNull();
  return img!;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("MarkdownView applies an authored embed layout (myne-md/myne#518)", () => {
  it("applies an absolute width, and keeps the max-width cap beside it", () => {
    // The cap is the half that is easy to drop: a note laid out on a wide
    // screen with `w=4000` must still fit a phone column.
    const img = renderEmbed("cat.png|w=300");
    expect(img.style.width).toBe("300px");
    expect(img.style.maxWidth).toBe("100%");
  });

  it("applies a percentage width", () => {
    const img = renderEmbed("cat.png|w=50%");
    expect(img.style.width).toBe("50%");
    expect(img.style.maxWidth).toBe("100%");
  });

  it("applies a height", () => {
    expect(renderEmbed("cat.png|h=200").style.height).toBe("200px");
  });

  it.each([
    ["left", "0px", "auto"],
    ["right", "auto", "0px"],
    ["center", "auto", "auto"],
  ])("aligns %s with auto margins", (align, left, right) => {
    const img = renderEmbed(`cat.png|align=${align}`);
    expect(img.style.marginLeft).toBe(left);
    expect(img.style.marginRight).toBe(right);
  });

  it("leaves an unsized embed with no width and no height of its own", () => {
    const img = renderEmbed("cat.png");
    expect(img.style.width).toBe("");
    expect(img.style.height).toBe("");
    // The default `max-width: 100%` is unconditional and stays.
    expect(img.style.maxWidth).toBe("100%");
  });
});

describe("MarkdownView honours wikilink.md §5.1 on the accessible name", () => {
  it("uses an authored alt as the accessible name", () => {
    const img = renderEmbed("cat.png|alt=A cat asleep");
    expect(img.getAttribute("alt")).toBe("A cat asleep");
    expect(img.getAttribute("role")).toBeNull();
  });

  it("falls back to the filename when the author wrote no alt", () => {
    const img = renderEmbed("cat.png");
    expect(img.getAttribute("alt")).toBe("cat.png");
    expect(img.getAttribute("role")).toBeNull();
  });

  it("treats an authored EMPTY alt as decorative, not as a missing one", () => {
    // §5.1's second clause, and the one this surface used to fail: `alt=`
    // announced the filename. An empty `alt` alone is the HTML spelling of
    // decorative; `role="presentation"` states it for a reader that would
    // otherwise fall back to the `src`, mirroring `applyEmbedAltText` in the
    // editor.
    const img = renderEmbed("cat.png|alt=");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("role")).toBe("presentation");
  });

  it("keeps decorative and absent distinct, which is the whole rule", () => {
    // The comparison a `||` would fail: each case reads plausibly on its own.
    const decorative = renderEmbed("cat.png|alt=");
    const absent = renderEmbed("cat.png");
    expect(decorative.getAttribute("alt")).not.toBe(absent.getAttribute("alt"));
    expect(decorative.getAttribute("role")).not.toBe(absent.getAttribute("role"));
  });
});
