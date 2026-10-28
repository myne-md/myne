// myne-md/myne#936: recovering a clip's page title out of its wire body.
//
// `clipTitleFromMarkdownBody` feeds every clip composer's managed `title:`. The
// cases that matter are the ones where getting it wrong is SILENT: an article
// whose own `<h1>` sits below the first line must not become the note's name, a
// page with no title must stay untitled rather than borrow a section heading,
// and the extension's line-start escape must not land a backslash in a name the
// user reads and renames.

import { describe, expect, it } from "vitest";

import { clipTitleFromMarkdownBody } from "../../src/clip/clipTitleFromMarkdownBody";

describe("clipTitleFromMarkdownBody", () => {
  it("takes the title from the leading `# ` heading (the content-clip shape)", () => {
    // `captureClip` emits `# <document.title>` then a blank line then the body.
    expect(
      clipTitleFromMarkdownBody("# Example Page\n\nThe article text.\n"),
    ).toBe("Example Page");
  });

  it("takes it from the bookmark shape too (title, blank line, bare URL)", () => {
    expect(
      clipTitleFromMarkdownBody("# Example Page\n\nhttps://example.com/p\n"),
    ).toBe("Example Page");
  });

  it("returns `\"\"` when the body has NO leading heading (empty page title)", () => {
    // An empty `document.title` means the capture emits no heading at all.
    expect(clipTitleFromMarkdownBody("Just the article text.\n")).toBe("");
    expect(clipTitleFromMarkdownBody("")).toBe("");
  });

  it("ignores a heading that is not the FIRST line: that one is article content", () => {
    // A page with no title whose article opens with `<h1>Introduction</h1>`
    // captures as `Introduction` in the body. It must not become the note's
    // name: a section heading is not a title, and the note stays untitled.
    expect(
      clipTitleFromMarkdownBody("Some lede paragraph.\n\n# Introduction\n\nBody.\n"),
    ).toBe("");
  });

  it("returns `\"\"` for a bare `#` with no heading text", () => {
    expect(clipTitleFromMarkdownBody("#\n\nBody.\n")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(clipTitleFromMarkdownBody("#   Spaced Out   \n\nBody.\n")).toBe(
      "Spaced Out",
    );
  });

  it("drops ONE leading escape backslash in front of a block marker", () => {
    // The extension's `escapeLineStart` prefixes `#`, `>`, `-`, `*`, `+` and
    // `N.` so a page-controlled title cannot inject markdown structure. The
    // note's name must be the title the page actually had.
    expect(clipTitleFromMarkdownBody("# \\#Not A Heading\n\nBody.\n")).toBe(
      "#Not A Heading",
    );
    expect(clipTitleFromMarkdownBody("# \\> quoted start\n\nBody.\n")).toBe(
      "> quoted start",
    );
    expect(clipTitleFromMarkdownBody("# \\- dash start\n\nBody.\n")).toBe(
      "- dash start",
    );
    expect(clipTitleFromMarkdownBody("# \\* star start\n\nBody.\n")).toBe(
      "* star start",
    );
    expect(clipTitleFromMarkdownBody("# \\+ plus start\n\nBody.\n")).toBe(
      "+ plus start",
    );
    expect(clipTitleFromMarkdownBody("# \\1. numbered start\n\nBody.\n")).toBe(
      "1. numbered start",
    );
  });

  it("leaves a backslash that is NOT a line-start escape alone", () => {
    // `C:\Users` is a real title, not an escaped marker. Only a backslash in
    // front of a markdown block marker is the extension's escape.
    expect(clipTitleFromMarkdownBody("# C:\\Users\\me\n\nBody.\n")).toBe(
      "C:\\Users\\me",
    );
    // A title the user really did start with a backslash and a digit-dot pair
    // that is not a list marker stays intact.
    expect(clipTitleFromMarkdownBody("# \\v1.2 notes\n\nBody.\n")).toBe(
      "\\v1.2 notes",
    );
  });

  it("takes only the first line of a multi-line heading-less body", () => {
    expect(clipTitleFromMarkdownBody("# One\n# Two\n")).toBe("One");
  });

  it("normalizes a CRLF first line", () => {
    // The wire body is UTF-8 text the extension assembled on a host that may use
    // either convention; a stray `\r` must not ride into the note's name.
    expect(clipTitleFromMarkdownBody("# Example Page\r\n\r\nBody.\r\n")).toBe(
      "Example Page",
    );
  });
});
