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
import i18n from "@myne/editor/i18n";

const SVG_NS = "http://www.w3.org/2000/svg";

/** One child element of an icon: its tag plus the attributes to set on it. */
type IconNode = readonly [tag: string, attrs: Readonly<Record<string, string>>];

// Inner shapes (24x24, stroke="currentColor") for the callout icons. Local to
// keep the decoration self-contained (no edit to the shared ICON_PATHS).
//
// Descriptors, not markup: the children are built with `createElementNS` like
// every other icon in the tree (`slash/icons.ts`, `attachments/icons.ts`,
// `fenced-code.ts`, `toolbar/plugin.ts`, `lightbox.ts`) rather than parsed from
// an `innerHTML` string. Same geometry as before, one less parsing path to
// depend on (#376) and the house TB2 rule restored.
const ICONS: Record<string, readonly IconNode[]> = {
  info: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "M12 16v-4" }],
    ["path", { d: "M12 8h.01" }],
  ],
  pencil: [
    ["path", { d: "M12 20h9" }],
    ["path", { d: "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" }],
  ],
  lightbulb: [
    [
      "path",
      {
        d: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5",
      },
    ],
    ["path", { d: "M9 18h6" }],
    ["path", { d: "M10 22h4" }],
  ],
  check: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "m9 12 2 2 4-4" }],
  ],
  help: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" }],
    ["path", { d: "M12 17h.01" }],
  ],
  warn: [
    ["path", { d: "m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z" }],
    ["path", { d: "M12 9v4" }],
    ["path", { d: "M12 17h.01" }],
  ],
  x: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "m15 9-6 6" }],
    ["path", { d: "m9 9 6 6" }],
  ],
  zap: [
    [
      "path",
      {
        d: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",
      },
    ],
  ],
  todo: [["circle", { cx: "12", cy: "12", r: "10", "stroke-dasharray": "3 3" }]],
  list: [
    ["path", { d: "M8 6h13" }],
    ["path", { d: "M8 12h13" }],
    ["path", { d: "M8 18h13" }],
    ["path", { d: "M3 6h.01" }],
    ["path", { d: "M3 12h.01" }],
    ["path", { d: "M3 18h.01" }],
  ],
  quote: [
    ["path", { d: "M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 2-1 3-3 4" }],
    ["path", { d: "M19 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 2-1 3-3 4" }],
  ],
};

function el(tag: string, attrs: Readonly<Record<string, string>>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

interface CalloutType {
  readonly color: "info" | "success" | "warning" | "danger" | "accent";
  readonly icon: string;
  /** i18n key (under `editor.callout.label.*`) for the default title, resolved
   *  via `i18n.t()` when the decoration set is BUILT — the plugin's rebuild gate
   *  (`plugin-factory.ts`) watches doc / viewport / selection / focus / tree, not
   *  `languageChanged`, so a live re-label would need the builder re-run through
   *  `makeGatedDecorationPlugin`. It isn't wired; a switched language re-labels
   *  on the next rebuild (any edit, scroll or selection move). */
  readonly labelKey: string;
}

// Obsidian-full set (case-insensitive) → semantic color token + icon + default title.
const CALLOUT_TYPES: Record<string, CalloutType> = {
  note: { color: "accent", icon: "pencil", labelKey: "editor.callout.label.note" },
  info: { color: "info", icon: "info", labelKey: "editor.callout.label.info" },
  todo: { color: "info", icon: "todo", labelKey: "editor.callout.label.todo" },
  tip: { color: "success", icon: "lightbulb", labelKey: "editor.callout.label.tip" },
  hint: { color: "success", icon: "lightbulb", labelKey: "editor.callout.label.hint" },
  important: { color: "success", icon: "lightbulb", labelKey: "editor.callout.label.important" },
  success: { color: "success", icon: "check", labelKey: "editor.callout.label.success" },
  check: { color: "success", icon: "check", labelKey: "editor.callout.label.success" },
  done: { color: "success", icon: "check", labelKey: "editor.callout.label.done" },
  question: { color: "warning", icon: "help", labelKey: "editor.callout.label.question" },
  faq: { color: "warning", icon: "help", labelKey: "editor.callout.label.faq" },
  warning: { color: "warning", icon: "warn", labelKey: "editor.callout.label.warning" },
  caution: { color: "warning", icon: "warn", labelKey: "editor.callout.label.caution" },
  attention: { color: "warning", icon: "warn", labelKey: "editor.callout.label.attention" },
  failure: { color: "danger", icon: "x", labelKey: "editor.callout.label.failure" },
  fail: { color: "danger", icon: "x", labelKey: "editor.callout.label.failure" },
  missing: { color: "danger", icon: "x", labelKey: "editor.callout.label.missing" },
  danger: { color: "danger", icon: "zap", labelKey: "editor.callout.label.danger" },
  error: { color: "danger", icon: "zap", labelKey: "editor.callout.label.error" },
  bug: { color: "danger", icon: "x", labelKey: "editor.callout.label.bug" },
  example: { color: "accent", icon: "list", labelKey: "editor.callout.label.example" },
  quote: { color: "accent", icon: "quote", labelKey: "editor.callout.label.quote" },
  cite: { color: "accent", icon: "quote", labelKey: "editor.callout.label.quote" },
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
  /** Every field `toDOM` renders, so an equal widget really can keep its DOM.
   *  `labelKey` alone would let two types that share a default title but differ
   *  in icon/colour reuse each other's node — no such pair exists in
   *  `CALLOUT_TYPES` today, which is exactly why it would go unnoticed. */
  eq(other: CalloutHeaderWidget): boolean {
    return (
      other.title === this.title &&
      other.type.labelKey === this.type.labelKey &&
      other.type.icon === this.type.icon &&
      other.type.color === this.type.color
    );
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `cm-callout-title cm-callout-fg-${this.type.color}`;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.75");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of ICONS[this.type.icon] ?? ICONS.info) {
      svg.appendChild(el(tag, attrs));
    }
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
  // A Blockquote overlapping two visible ranges is entered once PER range, so
  // without this it contributes duplicate line decorations and — worse — a second
  // header widget over the identical span. `blockquote.ts` collapses the same
  // repeat with a Map/Set; this is the same guard. Keyed on the node's whole
  // extent, not just its start, so a nested quote sharing an offset with its
  // parent is still its own node.
  const seen = new Set<string>();

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Blockquote") return undefined;
        const key = `${node.from}:${node.to}`;
        if (seen.has(key)) return undefined;
        seen.add(key);
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
          const title = m[4].trim() !== "" ? m[4].trim() : i18n.t(type.labelKey);
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
