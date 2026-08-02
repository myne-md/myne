// Lucide line-icons for the slash menu, composed via `createElementNS` (never
// innerHTML, TB2). Same 24×24 / 1.5px-stroke / currentColor family as the
// attachment icons. Only the commands whose text-glyph icon read poorly get an
// SVG (date/day/time/now were indistinguishable letters; table/to-do/attach/
// voice/wiki-link were unclear symbols); H1–H6, quote, etc. stay text glyphs.

const SVG_NS = "http://www.w3.org/2000/svg";

export type SlashIconName =
  | "calendar" // Date
  | "sun" // Day (weekday)
  | "clock" // Time
  | "alarm-clock" // Now (date + time)
  | "table" // Table
  | "check-square" // To-do list
  | "repeat" // Repeat (task recurrence)
  | "flag" // Priority
  | "paperclip" // Attach file
  | "mic" // Voice note
  | "link-2" // Wiki link (a chain/connection)
  | "pencil"; // Drawing (inline canvas)

function el(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Build a 16×16 Lucide line-icon for a slash-menu row. */
export function makeSlashIcon(name: SlashIconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  switch (name) {
    case "calendar":
      svg.append(
        el("path", { d: "M8 2v4" }),
        el("path", { d: "M16 2v4" }),
        el("rect", { width: "18", height: "18", x: "3", y: "4", rx: "2" }),
        el("path", { d: "M3 10h18" }),
      );
      break;
    case "sun":
      svg.append(
        el("circle", { cx: "12", cy: "12", r: "4" }),
        el("path", { d: "M12 2v2" }),
        el("path", { d: "M12 20v2" }),
        el("path", { d: "m4.93 4.93 1.41 1.41" }),
        el("path", { d: "m17.66 17.66 1.41 1.41" }),
        el("path", { d: "M2 12h2" }),
        el("path", { d: "M20 12h2" }),
        el("path", { d: "m6.34 17.66-1.41 1.41" }),
        el("path", { d: "m19.07 4.93-1.41 1.41" }),
      );
      break;
    case "clock":
      svg.append(
        el("circle", { cx: "12", cy: "12", r: "10" }),
        el("polyline", { points: "12 6 12 12 16 14" }),
      );
      break;
    case "alarm-clock":
      svg.append(
        el("circle", { cx: "12", cy: "13", r: "8" }),
        el("path", { d: "M12 9v4l2 2" }),
        el("path", { d: "M5 3 2 6" }),
        el("path", { d: "m22 6-3-3" }),
        el("path", { d: "m6 19-2 2" }),
        el("path", { d: "m18 19 2 2" }),
      );
      break;
    case "table":
      svg.append(
        el("path", { d: "M12 3v18" }),
        el("rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }),
        el("path", { d: "M3 9h18" }),
        el("path", { d: "M3 15h18" }),
      );
      break;
    case "check-square":
      svg.append(
        el("rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }),
        el("polyline", { points: "8 12 11 15 16 9" }),
      );
      break;
    case "repeat":
      svg.append(
        el("path", { d: "m17 2 4 4-4 4" }),
        el("path", { d: "M3 11v-1a4 4 0 0 1 4-4h14" }),
        el("path", { d: "m7 22-4-4 4-4" }),
        el("path", { d: "M21 13v1a4 4 0 0 1-4 4H3" }),
      );
      break;
    case "flag":
      svg.append(
        el("path", { d: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" }),
        el("line", { x1: "4", y1: "22", x2: "4", y2: "15" }),
      );
      break;
    case "paperclip":
      svg.append(
        el("path", {
          d: "M13.234 20.252 21 12.3a4.5 4.5 0 0 0-6.364-6.364L4.5 16.036a3 3 0 0 0 4.243 4.242l7.778-7.778a1.5 1.5 0 0 0-2.121-2.121L7.05 16.95",
        }),
      );
      break;
    case "mic":
      svg.append(
        el("path", { d: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" }),
        el("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }),
        el("line", { x1: "12", y1: "19", x2: "12", y2: "22" }),
      );
      break;
    case "link-2":
      svg.append(
        el("path", { d: "M9 17H7A5 5 0 0 1 7 7h2" }),
        el("path", { d: "M15 7h2a5 5 0 1 1 0 10h-2" }),
        el("line", { x1: "8", y1: "12", x2: "16", y2: "12" }),
      );
      break;
    case "pencil":
      svg.append(
        el("path", {
          d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
        }),
        el("path", { d: "m15 5 4 4" }),
      );
      break;
  }
  return svg;
}
