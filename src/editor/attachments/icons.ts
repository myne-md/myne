// Lucide line-icons built via DOM for the editor attachment widgets
// (MYND-164 / 147 / 149). Never `innerHTML` (TB2) — every glyph is composed
// from `createElementNS` children. 1.5px stroke, 24×24 viewBox, matching the
// design pass ("Lucide 1.5px icons"). `stroke: currentColor` so each icon
// inherits its chip's text color (accent / neutral / muted / danger).

const SVG_NS = "http://www.w3.org/2000/svg";

/** A line-icon glyph name → its child SVG element strings (path `d` only). */
type IconName = "image" | "image-off" | "file" | "file-warning";

function el(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * Build a 14×14 Lucide line-icon for an attachment chip. The size is fixed at
 * 14px so the glyph reads as a leading affordance next to 13px Inter text.
 */
export function makeAttachmentIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  switch (name) {
    case "image":
      svg.append(
        el("rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2" }),
        el("circle", { cx: "9", cy: "9", r: "2" }),
        el("path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }),
      );
      break;
    case "image-off":
      // Lucide "image-off": a struck-through image frame for a deleted attachment.
      svg.append(
        el("line", { x1: "2", y1: "2", x2: "22", y2: "22" }),
        el("path", { d: "M10.41 10.41a2 2 0 1 1-2.83-2.83" }),
        el("line", { x1: "13.5", y1: "13.5", x2: "6", y2: "21" }),
        el("line", { x1: "18", y1: "12", x2: "21", y2: "15" }),
        el("path", { d: "M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59" }),
        el("path", { d: "M21 15V5a2 2 0 0 0-2-2H9" }),
      );
      break;
    case "file":
      // Lucide "file": a generic document, used for the PDF icon-fallback.
      svg.append(
        el("path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }),
        el("path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }),
      );
      break;
    case "file-warning":
      // Lucide "file-warning": a document with a warning glyph — broken reference.
      svg.append(
        el("path", { d: "M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4" }),
        el("path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }),
        el("path", { d: "M5 18v-2" }),
        el("path", { d: "M5 22h.01" }),
      );
      break;
  }
  return svg;
}
