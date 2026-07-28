// @vitest-environment jsdom
//
// jsdom for `URL.createObjectURL` / `Blob`, which the object-url helper needs
// (phase3-web-client task 97).
import { describe, expect, it, vi } from "vitest";
import { buildSelectionCardSvg, svgToObjectUrl } from "../../src/lib/noteImageCard";

// MYND-361 note→image — the pure SVG share-card builder (the DOM→canvas raster
// step is the runtime piece, not covered here).
describe("buildSelectionCardSvg", () => {
  const opts = { contentWidth: 200, contentHeight: 100, padding: 24, background: "#1a1a17" };

  it("sizes the card as content + 2×padding", () => {
    const svg = buildSelectionCardSvg("<p>hi</p>", opts);
    expect(svg).toContain('width="248"'); // 200 + 2*24
    expect(svg).toContain('height="148"'); // 100 + 2*24
    expect(svg).toContain('viewBox="0 0 248 148"');
  });

  it("fills the background and insets the foreignObject by the padding", () => {
    const svg = buildSelectionCardSvg("<p>hi</p>", opts);
    expect(svg).toContain('fill="#1a1a17"');
    expect(svg).toContain('<foreignObject x="24" y="24" width="200" height="100">');
  });

  it("embeds the content xhtml verbatim", () => {
    expect(buildSelectionCardSvg("<p>alpha</p>", opts)).toContain("<p>alpha</p>");
  });

  it("escapes XML attribute values (background / font)", () => {
    const svg = buildSelectionCardSvg("<p/>", { ...opts, background: '"><script>x' });
    expect(svg).not.toContain('"><script>');
    expect(svg).toContain("&quot;&gt;&lt;script&gt;x");
  });
});

describe("svgToObjectUrl", () => {
  // Was `svgToDataUri` until phase3-web-client task 97. The change is not a
  // refactor: that one call shape was the only reason the web client's CSP
  // carried `img-src … data:`, which contradicted task 44's criterion that the
  // policy admit object URLs *without* admitting `data:` content.
  it("mints an object URL carrying the SVG's own type", () => {
    const seen: Blob[] = [];
    const created = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((b: Blob | MediaSource) => {
        seen.push(b as Blob);
        return "blob:test/1";
      });
    try {
      expect(svgToObjectUrl("<svg/>")).toBe("blob:test/1");
      expect(created).toHaveBeenCalledTimes(1);
      expect(seen[0]!.type).toBe("image/svg+xml");
    } finally {
      created.mockRestore();
    }
  });

  it("produces a NEW url per call, so one revoke cannot kill another's image", () => {
    // The property that makes caller-owned revocation safe. With a shared or
    // cached url, the QR panel unmounting would blank a rasterisation in flight.
    const urls = new Set([svgToObjectUrl("<svg/>"), svgToObjectUrl("<svg/>")]);
    expect(urls.size).toBe(2);
    for (const u of urls) URL.revokeObjectURL(u);
  });
});
