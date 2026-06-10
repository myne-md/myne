// Callout / admonition rendering (MYND-47, callouts).
//
// Promotes a `> [!TYPE]` blockquote into a styled callout container (colored
// left accent + tinted bg + icon + title) WITHOUT modifying `blockquote.ts`: it
// reads the same `Blockquote` nodes and adds a SEPARATE cursor-aware decoration
// layer, so blockquote's bars/`>`-hiding still apply and the line classes
// compose. The `> [!TYPE]` bytes are preserved (render-only, §6 C1); on-cursor
// the raw `[!TYPE]` marker reveals. Obsidian-full type set, case-insensitive,
// custom title supported; the foldable `+`/`-` marker is recognized (round-trip)
// and rendered expanded (interactive fold is a follow-up). Unknown type → plain
// blockquote (no promotion).

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { isCursorLine } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

// Inner SVG (24x24, stroke="currentColor") for the callout icons. Local to keep
// the decoration self-contained (no edit to the shared ICON_PATHS).
const ICONS: Record<string, string> = {
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  pencil:
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  lightbulb:
    '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  warn: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  x: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  todo: '<circle cx="12" cy="12" r="10" stroke-dasharray="3 3"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  quote:
    '<path d="M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 2-1 3-3 4"/><path d="M19 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 2-1 3-3 4"/>',
};

interface CalloutType {
  readonly color: "info" | "success" | "warning" | "danger" | "accent";
  readonly icon: string;
  readonly label: string;
}

// Obsidian-full set (case-insensitive) → semantic color token + icon + default title.
const CALLOUT_TYPES: Record<string, CalloutType> = {
  note: { color: "accent", icon: "pencil", label: "Note" },
  info: { color: "info", icon: "info", label: "Info" },
  todo: { color: "info", icon: "todo", label: "Todo" },
  tip: { color: "success", icon: "lightbulb", label: "Tip" },
  hint: { color: "success", icon: "lightbulb", label: "Hint" },
  important: { color: "success", icon: "lightbulb", label: "Important" },
  success: { color: "success", icon: "check", label: "Success" },
  check: { color: "success", icon: "check", label: "Success" },
  done: { color: "success", icon: "check", label: "Done" },
  question: { color: "warning", icon: "help", label: "Question" },
  faq: { color: "warning", icon: "help", label: "FAQ" },
  warning: { color: "warning", icon: "warn", label: "Warning" },
  caution: { color: "warning", icon: "warn", label: "Caution" },
  attention: { color: "warning", icon: "warn", label: "Attention" },
  failure: { color: "danger", icon: "x", label: "Failure" },
  fail: { color: "danger", icon: "x", label: "Failure" },
  missing: { color: "danger", icon: "x", label: "Missing" },
  danger: { color: "danger", icon: "zap", label: "Danger" },
  error: { color: "danger", icon: "zap", label: "Error" },
  bug: { color: "danger", icon: "x", label: "Bug" },
  example: { color: "accent", icon: "list", label: "Example" },
  quote: { color: "accent", icon: "quote", label: "Quote" },
  cite: { color: "accent", icon: "quote", label: "Quote" },
};

/** Match the callout header on a blockquote's first content line (after the
 *  leading `>` markers): `[!type]`, optional fold `+`/`-`, optional title. */
const HEADER_RE = /^(\s*>\s*)\[!(\w+)\]([+-]?)\s*(.*)$/;

class CalloutHeaderWidget extends WidgetType {
  constructor(
    private readonly type: CalloutType,
    private readonly title: string,
  ) {
    super();
  }
  eq(other: CalloutHeaderWidget): boolean {
    return other.title === this.title && other.type.label === this.type.label;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `cm-callout-title cm-callout-fg-${this.type.color}`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.75");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.innerHTML = ICONS[this.type.icon] ?? ICONS.info; // trusted local SVG
    span.appendChild(svg);
    const label = document.createElement("strong");
    label.textContent = this.title;
    span.appendChild(label);
    return span;
  }
}

function buildCalloutDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  const doc = view.state.doc;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Blockquote") return undefined;
        const firstLine = doc.lineAt(node.from);
        const m = HEADER_RE.exec(firstLine.text);
        if (m === null) return undefined;
        const type = CALLOUT_TYPES[m[2].toLowerCase()];
        if (type === undefined) return undefined; // unknown → plain blockquote

        // Colored container: a class on every line of the callout block (composes
        // with blockquote's own `.cm-blockquote` line decoration).
        const lastLine = doc.lineAt(node.to);
        for (let n = firstLine.number; n <= lastLine.number; n++) {
          const line = doc.line(n);
          decorations.push(
            Decoration.line({
              class: `cm-callout cm-callout-bg-${type.color}`,
            }).range(line.from),
          );
        }

        // Header: off-cursor, replace `[!type]<fold> <title>` with [icon] Title.
        if (!isCursorLine(view, firstLine.from, firstLine.to)) {
          const markerStart = firstLine.from + m[1].length; // after `> `
          const title = m[4].trim() !== "" ? m[4].trim() : type.label;
          decorations.push(
            Decoration.replace({
              widget: new CalloutHeaderWidget(type, title),
            }).range(markerStart, firstLine.to),
          );
        }
        return undefined;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort(
    (a, b) => a.from - b.from || a.value.startSide - b.value.startSide,
  );
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function calloutDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildCalloutDecorations);
}
