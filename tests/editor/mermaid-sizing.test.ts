// @vitest-environment jsdom
//
// Mermaid sizing + font (myne-md/myne#629). Sibling of
// `mermaid-security.test.ts`, which covers the same `initialize` config from the
// other side.
//
// Two properties, and each is tested where it actually lives:
//
//   • SIZING is corrected on the LIVE SVG NODE, after the card's `innerHTML`,
//     not in the config and not on the string. Not the config, because
//     `useMaxWidth` lives on `BaseDiagramConfig`, which 26 diagram configs
//     extend with no global switch: a config-side fix means enumerating
//     families, and a test of one means listing those families a second time,
//     which is a roster compared against a copy of itself. Not the string,
//     because re-parsing mermaid's sanitized output and re-serialising it before
//     an `innerHTML` sink means the bytes the sanitizer produced are no longer
//     the bytes injected, which is the documented precondition for
//     mutation-XSS. `giveNaturalSize` therefore takes a card and is tested
//     against one, including on every shape it must refuse to touch.
//
//   • FONT must resolve the SAME in `document.body` (where mermaid measures,
//     since `mermaid.render` is called with no container) and inside
//     `.cm-editor` (where the SVG is displayed). `inherit` resolves differently
//     in those two places, sans at one and mono at the other, so every
//     `getBBox()` was taken against the wrong font. A `:root` custom property
//     has one value in both. That one IS config, so it is read back from
//     `initialize`.

import { describe, expect, it, vi } from "vitest";

interface InitConfig {
  fontFamily?: string;
  themeVariables?: { fontFamily?: string };
}
const initCalls: InitConfig[] = [];

vi.mock("mermaid", () => ({
  default: {
    initialize: (cfg: InitConfig) => {
      initCalls.push(cfg);
    },
    render: async (_id: string, code: string) => ({ svg: `<svg>${code}</svg>` }),
  },
}));

const { giveNaturalSize } = await import("../../src/editor/decorations/mermaid");
const { loadMermaidRenderer } = await import("../../src/editor/mermaid/render-mermaid");

/** A card holding what mermaid emits under its `useMaxWidth` default. */
function cardWith(svg: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "cm-mermaid-card";
  card.innerHTML = svg;
  return card;
}

function mermaidOutput(width: number, height: number, extraStyle = ""): string {
  return (
    `<svg aria-roledescription="flowchart-v2" viewBox="0 0 ${width} ${height}" ` +
    `style="max-width: ${width}px;${extraStyle}" width="100%"><g></g></svg>`
  );
}

const svgOf = (card: HTMLElement): SVGElement => card.querySelector("svg")!;

describe("giveNaturalSize", () => {
  it("replaces the percentage width with the viewBox's own pixel size", () => {
    const card = cardWith(mermaidOutput(4210, 880));
    giveNaturalSize(card);
    expect(svgOf(card).getAttribute("width")).toBe("4210");
    expect(svgOf(card).getAttribute("height")).toBe("880");
  });

  it("drops the inline max-width, which is what outranked the stylesheet", () => {
    // The card's `overflow-x: auto` cannot engage while this is present, which
    // is the whole mechanism of the reported bug.
    const card = cardWith(mermaidOutput(4210, 880));
    giveNaturalSize(card);
    expect(svgOf(card).getAttribute("style") ?? "").not.toMatch(/max-width/i);
  });

  it("keeps any other inline declaration mermaid set", () => {
    const card = cardWith(mermaidOutput(300, 200, " background-color: rgb(1, 2, 3);"));
    giveNaturalSize(card);
    const style = svgOf(card).getAttribute("style") ?? "";
    expect(style).toContain("background-color");
    expect(style).not.toMatch(/max-width/i);
  });

  it("is family-agnostic: the same shape from any diagram type is corrected", () => {
    // The point of doing this on the node: `gitGraph`, `sankey`, `block`,
    // `requirement` and the rest never had to be named anywhere. A config-side
    // fix reached twelve of mermaid's 26 families.
    const card = cardWith(
      '<svg aria-roledescription="gitGraph" viewBox="0 0 900 400" style="max-width: 900px;" width="100%"><g/></svg>',
    );
    giveNaturalSize(card);
    expect(svgOf(card).getAttribute("width")).toBe("900");
  });

  describe("refuses to touch what it cannot trust", () => {
    // A diagram at the wrong size is cosmetic; a diagram this function broke is
    // not. Each of these must come back exactly as mermaid drew it.
    const untouched = (svg: string) => {
      const card = cardWith(svg);
      const before = card.innerHTML;
      giveNaturalSize(card);
      expect(card.innerHTML).toBe(before);
    };

    it("no viewBox", () => {
      untouched('<svg width="100%" style="max-width: 10px;"><g/></svg>');
    });

    it("a viewBox that is not four numbers", () => {
      untouched('<svg viewBox="0 0 900" width="100%"><g/></svg>');
    });

    it("a zero-sized viewBox", () => {
      untouched('<svg viewBox="0 0 0 0" width="100%"><g/></svg>');
    });

    it("a non-numeric viewBox", () => {
      untouched('<svg viewBox="0 0 wide tall" width="100%"><g/></svg>');
    });

    it("a card with no svg in it at all", () => {
      const card = cardWith("<pre>graph TD</pre>");
      expect(() => giveNaturalSize(card)).not.toThrow();
      expect(card.innerHTML).toBe("<pre>graph TD</pre>");
    });

    it("a box past the ceiling, which note content chooses", () => {
      // `threat-model.md` §7 treats a note as attacker-influenceable, and the
      // viewBox is mermaid's layout of note content. Mermaid's own
      // `width="100%"` capped the box whatever the diagram claimed; taking the
      // real width removes that cap, so the ceiling restates it.
      untouched('<svg viewBox="0 0 400000 400000" width="100%" style="max-width: 400000px;"><g/></svg>');
    });
  });
});

describe("mermaid font config", () => {
  it("names a font that resolves identically where mermaid measures and where the SVG is shown", async () => {
    await loadMermaidRenderer();
    expect(initCalls.length).toBeGreaterThan(0);
    const cfg = initCalls[initCalls.length - 1]!;
    // A `:root` custom property is what makes the two contexts agree; `inherit`,
    // the value that broke it, is legal CSS that resolves against whichever
    // ancestor the element happens to have.
    expect(cfg.fontFamily).toMatch(/^var\(--[a-z-]+\)$/);
    expect(cfg.themeVariables?.fontFamily).toBe(cfg.fontFamily);
  });
});
