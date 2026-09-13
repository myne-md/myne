// The task chip's leading icon (myne-md/myne#656 item 4).
//
// Built with `createElementNS` rather than `innerHTML`, the same TB2 discipline
// `editor/src/slash/icons.ts` records, and the same 24x24 / 1.5px-stroke /
// `currentColor` family. One icon per field kind; for `priority` the icon also
// carries the LEVEL, so an icon-only priority chip (item 5) still distinguishes
// highest from lowest by shape rather than by colour alone.

const SVG_NS = "http://www.w3.org/2000/svg";

export type ChipIconKind = "due" | "remind" | "repeat" | "priority";

function el(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function paths(nodes: ReadonlyArray<readonly [string, string]>): SVGElement[] {
  return nodes.map(([tag, d]) => el(tag, { d }));
}

/**
 * The path set for one icon. Priority maps its five levels to five distinct
 * shapes (two chevrons up, one up, a dash, one down, two down), which is the
 * only encoding that survives a monochrome or colour-blind reading.
 */
function iconNodes(kind: ChipIconKind, value: string): SVGElement[] {
  if (kind === "due") {
    return [
      el("path", { d: "M8 2v4" }),
      el("path", { d: "M16 2v4" }),
      el("rect", { width: "18", height: "18", x: "3", y: "4", rx: "2" }),
      el("path", { d: "M3 10h18" }),
    ];
  }
  if (kind === "remind") {
    return [
      el("path", { d: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" }),
      el("path", { d: "M10.3 21a1.94 1.94 0 0 0 3.4 0" }),
    ];
  }
  if (kind === "repeat") {
    return [
      el("path", { d: "m17 2 4 4-4 4" }),
      el("path", { d: "M3 11v-1a4 4 0 0 1 4-4h14" }),
      el("path", { d: "m7 22-4-4 4-4" }),
      el("path", { d: "M21 13v1a4 4 0 0 1-4 4H3" }),
    ];
  }
  switch (value) {
    case "highest":
      return paths([
        ["path", "m17 11-5-5-5 5"],
        ["path", "m17 18-5-5-5 5"],
      ]);
    case "high":
      return paths([["path", "m18 15-6-6-6 6"]]);
    case "low":
      return paths([["path", "m6 9 6 6 6-6"]]);
    case "lowest":
      return paths([
        ["path", "m7 6 5 5 5-5"],
        ["path", "m7 13 5 5 5-5"],
      ]);
    case "medium":
    default:
      return paths([["path", "M5 12h14"]]);
  }
}

/** A 12px-styled (sized by CSS `1em`) chip icon for `kind`. */
export function taskChipIcon(kind: ChipIconKind, value: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "cm-task-chip-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.append(...iconNodes(kind, value));
  return svg;
}
