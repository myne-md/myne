// @vitest-environment jsdom
//
// Overflow-menu parity on inline image / PDF embeds (myne-md/myne#409 task 1).
//
// Before this, `AttachmentImageWidget` and `AttachmentPdfWidget` built no menu
// at all, so an embedded image could not be renamed, exported, removed or
// revealed while the generic file card, the audio player and the text preview
// all could. These assert the two embed widgets now carry the same four rows,
// through the same shared `buildOverflowMenu`.
//
// This lives in the Vitest-DOM layer rather than in `e2e/` on purpose. The
// tauri-driver suite covers the IMAGE menu end-to-end (`embed-overflow-menu`),
// where a real fixture PNG genuinely decrypts and decodes in WebKit; the PDF
// side has no importable fixture in the tree, and manufacturing one would make
// the scenario's outcome depend on whether the magic-byte sniffer and pdf.js
// both accept a hand-rolled document in the container. The widget contract is
// the same for both, and it is cheap and deterministic to pin here.

import { afterEach, describe, expect, it } from "vitest";
import { type CatalogRow } from "../../src/editor/attachments/catalog";
import {
  type Mounted,
  mountEmbeds,
  openEmbedMenu,
  unmountEmbeds,
} from "./_attachment-mount";

const RASTER_ID = "a".repeat(64);
const PDF_ID = "b".repeat(64);

const ROWS: CatalogRow[] = [
  { id: RASTER_ID, contentType: "image/png", filename: "photo.png", size: 12 },
  { id: PDF_ID, contentType: "application/pdf", filename: "doc.pdf", size: 34 },
];




let mounted: Mounted | null = null;

/** Mount against the fixed catalog above, recording it for teardown. */
async function mount(doc: string): Promise<Mounted> {
  mounted = await mountEmbeds(doc, ROWS);
  return mounted;
}

afterEach(() => {
  unmountEmbeds(mounted);
  mounted = null;
});

function q(root: ParentNode, testid: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${testid}"]`);
}

describe("embed overflow menu (myne#409)", () => {
  it("an image embed carries the four file actions", async () => {
    mounted = await mount(`![[att:${RASTER_ID}|photo.png]]`, ROWS);
    const menu = openEmbedMenu(mounted.host, "attachment-image");

    for (const row of ["export", "rename", "remove", "reveal"]) {
      expect(
        q(menu, `attachment-image.${row}`),
        `attachment-image.${row} row should exist`,
      ).not.toBeNull();
    }
  });

  it("a PDF embed carries the same four file actions", async () => {
    mounted = await mount(`![[att:${PDF_ID}|doc.pdf]]`, ROWS);
    const menu = openEmbedMenu(mounted.host, "attachment-pdf");

    for (const row of ["export", "rename", "remove", "reveal"]) {
      expect(
        q(menu, `attachment-pdf.${row}`),
        `attachment-pdf.${row} row should exist`,
      ).not.toBeNull();
    }
  });

  it("the menu announces as a menu with named items", async () => {
    mounted = await mount(`![[att:${RASTER_ID}|photo.png]]`, ROWS);
    const button = q(mounted.host, "attachment-image.menu-button");
    expect(button?.getAttribute("aria-haspopup")).toBe("menu");
    expect(button?.getAttribute("aria-expanded")).toBe("false");

    const menu = openEmbedMenu(mounted.host, "attachment-image");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    for (const item of menu.querySelectorAll('[role="menuitem"]')) {
      expect(item.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("destroying the view closes an open menu so its document listener cannot outlive the DOM", async () => {
    mounted = await mount(`![[att:${RASTER_ID}|photo.png]]`, ROWS);
    openEmbedMenu(mounted.host, "attachment-image");
    expect(q(document.body, "attachment-image.menu")).not.toBeNull();

    unmountEmbeds(mounted);
    mounted = null;

    expect(
      q(document.body, "attachment-image.menu"),
      "widget destroy() must tear the body-mounted menu down",
    ).toBeNull();
  });

  // myne#409 proposed splitting further segments in `dialect/src/lezer/wikilink.ts`.
  // That would be a regression rather than the fix: `WikilinkAlias` is read by
  // `parseWikilinkParts`, which serves EVERY wikilink, so an ordinary note link
  // with two pipes would lose everything after the second one from its chip
  // label. The segment split belongs in the form-C consumer, and this pins the
  // property that makes that the right call.
  it("does not change an ordinary note wikilink with more than one pipe", async () => {
    mounted = await mount("[[Note|A|B]]", ROWS);
    const chip = mounted.host.querySelector(".cm-wikilink-chip, [data-testid^='wikilink']");
    expect(chip, "a note wikilink should still render a chip").not.toBeNull();
    expect(chip?.textContent).toContain("A|B");
  });

  it("the image is still clickable for the lightbox, and the menu button is not the image", async () => {
    mounted = await mount(`![[att:${RASTER_ID}|photo.png]]`, ROWS);
    const img = q(mounted.host, "attachment-image");
    const button = q(mounted.host, "attachment-image.menu-button");
    expect(img).not.toBeNull();
    expect(button).not.toBeNull();
    expect(img?.contains(button as Node)).toBe(false);
  });
});
