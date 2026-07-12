import { describe, expect, it } from "vitest";
import { buildSelectionCardSvg, svgToDataUri } from "../../src/lib/noteImageCard";

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

describe("svgToDataUri", () => {
  it("produces an inspectable, decodable data URI", () => {
    const uri = svgToDataUri("<svg/>");
    expect(uri.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(uri.slice("data:image/svg+xml;charset=utf-8,".length))).toBe("<svg/>");
  });
});
