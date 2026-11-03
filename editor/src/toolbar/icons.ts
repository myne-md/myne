// Lucide line-icons for the selection toolbar (issue #970, item 2).
//
// The toolbar used to draw its buttons as TEXT glyphs: `B`, `S`, `<>` and `↗`
// in the button's own font, with the italic and strikethrough ones faked by
// `font-style` and `text-decoration`. At 28px beside a real editor that reads as
// plain prose sitting on a surface rather than as controls, and two of the four
// were indistinguishable from the letter the user had selected. Every button now
// carries a glyph from the same family the rest of the app draws.
//
// **Composed via `createElementNS`, never `innerHTML`**, the staggering TB2
// discipline `editor/src/slash/icons.ts` records, and the reason this file is a
// second DOM table rather than an import of `host/lib/icons.ts`: that table is
// markup strings consumed by React's `<Icon>` (which owns the `{__html}`
// identity rule, myne-md/myne#894). The editor builds raw DOM outside React, so
// it composes nodes. The `d` literals below are the same values, and the family
// is the same Lucide set (MIT) at the same 24x24 / 1.5px-stroke / currentColor
// geometry, so the two tables draw one icon language. A name added on one side
// and not the other is a missed copy, not a second style.

const SVG_NS = "http://www.w3.org/2000/svg";

/** Every glyph the selection toolbar draws. */
export type ToolbarIconName =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "highlight"
  | "link"
  | "bullet-list"
  | "numbered-list"
  | "checklist"
  | "quote"
  | "wikilink"
  | "export-image"
  | "chevron-down";

function el(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** The child shapes of one glyph. Lucide's own paths, verbatim. */
function shapes(name: ToolbarIconName): SVGElement[] {
  switch (name) {
    case "bold":
      return [
        el("path", { d: "M14 12a4 4 0 0 0 0-8H6v8" }),
        el("path", { d: "M15 20a4 4 0 0 0 0-8H6v8Z" }),
      ];
    case "italic":
      return [
        el("line", { x1: "19", y1: "4", x2: "10", y2: "4" }),
        el("line", { x1: "14", y1: "20", x2: "5", y2: "20" }),
        el("line", { x1: "15", y1: "4", x2: "9", y2: "20" }),
      ];
    case "strike":
      // Lucide `strikethrough`: the S stroke is cut by a rule, so the glyph says
      // "cross this out" without spelling the letter.
      return [
        el("path", { d: "M16 4H9a3 3 0 0 0-2.83 4" }),
        el("path", { d: "M14 12a4 4 0 0 1 0 8H6" }),
        el("line", { x1: "4", y1: "12", x2: "20", y2: "12" }),
      ];
    case "code":
      return [
        el("polyline", { points: "16 18 22 12 16 6" }),
        el("polyline", { points: "8 6 2 12 8 18" }),
      ];
    case "highlight":
      // Lucide `highlighter`: a marker nib over the line it marks.
      return [
        el("path", { d: "m9 11-6 6v3h9l3-3" }),
        el("path", { d: "m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" }),
      ];
    case "link":
      return [
        el("path", {
          d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
        }),
        el("path", {
          d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
        }),
      ];
    case "bullet-list":
      return [
        el("line", { x1: "8", y1: "6", x2: "21", y2: "6" }),
        el("line", { x1: "8", y1: "12", x2: "21", y2: "12" }),
        el("line", { x1: "8", y1: "18", x2: "21", y2: "18" }),
        el("line", { x1: "3", y1: "6", x2: "3.01", y2: "6" }),
        el("line", { x1: "3", y1: "12", x2: "3.01", y2: "12" }),
        el("line", { x1: "3", y1: "18", x2: "3.01", y2: "18" }),
      ];
    case "numbered-list":
      // Lucide `list-ordered`: stamped numerals where `bullet-list` keeps dots.
      // A digit rather than a bullet is the whole distinction, so the two paths
      // are drawn as strokes at text scale.
      return [
        el("line", { x1: "10", y1: "6", x2: "21", y2: "6" }),
        el("line", { x1: "10", y1: "12", x2: "21", y2: "12" }),
        el("line", { x1: "10", y1: "18", x2: "21", y2: "18" }),
        el("path", { d: "M4 6h1v4" }),
        el("path", { d: "M4 10h2" }),
        el("path", { d: "M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" }),
      ];
    case "checklist":
      return [
        el("rect", { x: "3", y: "5", width: "6", height: "6", rx: "1" }),
        el("path", { d: "m3 17 2 2 4-4" }),
        el("path", { d: "M13 6h8" }),
        el("path", { d: "M13 12h8" }),
        el("path", { d: "M13 18h8" }),
      ];
    case "quote":
      return [
        el("path", {
          d: "M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z",
        }),
        el("path", {
          d: "M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z",
        }),
      ];
    case "wikilink":
      // Lucide `brackets`: the doubled square the `[[note]]` syntax is written
      // in. Distinct from `link`'s chain on purpose: one makes a URL, the other
      // points at another note, and they are two different promises.
      return [
        el("path", { d: "M8 3H7a2 2 0 0 0-2 2v5.5" }),
        el("path", { d: "M16 3h1a2 2 0 0 1 2 2v5.5" }),
        el("path", { d: "M8 21H7a2 2 0 0 1-2-2v-5.5" }),
        el("path", { d: "M16 21h1a2 2 0 0 0 2-2v-5.5" }),
      ];
    case "export-image":
      return [
        el("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }),
        el("circle", { cx: "8.5", cy: "8.5", r: "1.5" }),
        el("path", { d: "M21 15l-5-5L5 21" }),
      ];
    case "chevron-down":
      // Only the block-type opener draws it (the one control that expands).
      return [el("path", { d: "m6 9 6 6 6-6" })];
  }
}

/** Build one 15x15 glyph for a toolbar button.
 *
 *  `currentColor` and no fill, so the button's own colour (including the ACTIVE
 *  tint) paints the glyph and nothing has to be re-stated for dark palettes. */
export function makeToolbarIcon(name: ToolbarIconName, size = 15): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.append(...shapes(name));
  return svg;
}
