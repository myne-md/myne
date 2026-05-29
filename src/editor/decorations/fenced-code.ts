// Fenced code-block card for the Phase 1 editor (MYND-154 task 4).
//
// Grill Q2/Q3 (agent-tooling/sessions/grill/2026-05-28-code-block-syntax-highlighting.md):
// the code block renders as an always-on CARD. The body is left as live
// document text styled with `Decoration.line` (NOT a whole-block widget like
// table.ts) so the task-3 nested parser colors it while typing.
//
// Cursor-aware reveal, scoped to the FENCE markers only (grill Q3):
//   - Away (editor not focused, or cursor outside the block): the opening fence
//     line is replaced by a card-top BAR widget carrying the language badge
//     (top-right), the body lines are carded, and the closing fence line is
//     hidden. The badge lives in the bar (a real container) rather than on a
//     body line, so it never collides with the fence-hide ranges.
//   - Editing (focused + a selection touches the block): the raw fence lines
//     are shown and every line is carded; no bar, no badge.
// Gated on a CLOSED fence (>= 2 CodeMark) — same signal as the task-3 coloring
// gate, so an unclosed fence shows neither card nor coloring.
//
// Focus is threaded into state (a block-replace set lives in a StateField,
// which has no `view`). A LOCAL focus field is used rather than sharing
// table.ts's, to avoid touching the shipped table feature.

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { selectionTouchesLines } from "./cursor-aware";
import { resolveCodeLanguage } from "../code-languages";

const NESTING_CONTAINERS = new Set([
  "Blockquote",
  "ListItem",
  "BulletList",
  "OrderedList",
]);

// A fence inside a list item or blockquote shares its lines with a list marker
// or quote bar; the always-on card (block-replace + line decorations) would
// collide with those (`Decoration.line` stacking, block-replace over a `> `
// line). The card is therefore gated to TOP-LEVEL fences (MYND-154 task 9 /
// grill: pixel-perfect nested cards are deferred). Nested fences still get
// syntax COLORING — that rides the separate parseMixed wrap in code-highlight.ts,
// which is unaffected by this gate.
function isNestedFence(node: SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (NESTING_CONTAINERS.has(p.name)) return true;
  }
  return false;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// Build a small line-icon (copy / check) via DOM — never innerHTML (TB2).
// stroke:currentColor so it inherits the button's color (incl. the "copied"
// success tint). Feather-style "copy" + "check" glyphs.
function makeCopyIcon(kind: "copy" | "check"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (kind === "copy") {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", "9");
    rect.setAttribute("y", "9");
    rect.setAttribute("width", "13");
    rect.setAttribute("height", "13");
    rect.setAttribute("rx", "2");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1");
    svg.append(rect, path);
  } else {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M20 6 9 17l-5-5");
    svg.append(path);
  }
  return svg;
}

// Card-top bar that replaces the opening fence line in the away state. Carries
// the language badge + a hover-revealed copy control (top-right). Decorative —
// never part of the document text, so a fence-to-fence copy stays byte-stable;
// the copy button writes the block's RAW source (fences + body), not any
// widget text (MYND-154 task 6).
class CodeCardBarWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly full: boolean,
    private readonly source: string,
    private readonly from: number,
  ) {
    super();
  }
  eq(other: CodeCardBarWidget): boolean {
    return (
      other.label === this.label &&
      other.full === this.full &&
      other.source === this.source &&
      other.from === this.from
    );
  }
  toDOM(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = this.full ? "cm-code-card-bar cm-code-card-bar-full" : "cm-code-card-bar";
    // Block identity, so the hover tracker can find this bar and toggle the
    // copy control's visibility when the mouse is anywhere over the block.
    bar.dataset.blockFrom = String(this.from);

    const copy = document.createElement("button");
    copy.className = "cm-code-copy";
    copy.type = "button";
    copy.setAttribute("aria-label", "Copy code");
    copy.appendChild(makeCopyIcon("copy")); // icon-only — no text label
    const source = this.source;
    copy.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard
        ?.writeText(source)
        .then(() => {
          copy.replaceChildren(makeCopyIcon("check"));
          copy.classList.add("cm-code-copy-done");
          setTimeout(() => {
            copy.replaceChildren(makeCopyIcon("copy"));
            copy.classList.remove("cm-code-copy-done");
          }, 1200);
        })
        .catch(() => {
          /* clipboard denied — leave the icon unchanged */
        });
    });

    const badge = document.createElement("span");
    badge.className = "cm-code-badge";
    badge.textContent = this.label; // textContent — never innerHTML (TB2)
    badge.setAttribute("aria-hidden", "true");

    bar.appendChild(copy);
    bar.appendChild(badge);
    return bar;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const hiddenFence = Decoration.replace({ block: true });
const cardBody = Decoration.line({ class: "cm-code-card-body" });
const cardBodyTop = Decoration.line({ class: "cm-code-card-body cm-code-card-top" });
const cardBodyBottom = Decoration.line({ class: "cm-code-card-body cm-code-card-bottom" });
const cardBodyOnly = Decoration.line({
  class: "cm-code-card-body cm-code-card-top cm-code-card-bottom",
});

function badgeLabel(state: EditorState, node: { node: import("@lezer/common").SyntaxNode }): string {
  const infoNode = node.node.getChild("CodeInfo");
  const info = infoNode ? state.doc.sliceString(infoNode.from, infoNode.to) : "";
  const lang = resolveCodeLanguage(info);
  return (lang ? lang.name : info.trim()) || "code";
}

/**
 * Decoration set for the current state, as a pure function of `(state,
 * focused)` so the reveal decision is testable without driving DOM focus.
 * Uses `Decoration.set(_, true)` (self-sorting) rather than a RangeSetBuilder
 * because a card mixes line decorations, block-replace, and a widget.
 */
export function buildCodeBlockDecorations(
  state: EditorState,
  focused: boolean,
): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return undefined;
      // Closed fence only (>= 2 CodeMark). Unclosed → no card (grill Q11).
      if (node.node.getChildren("CodeMark").length < 2) return false;
      // Nested in a list/blockquote → skip the card (coloring still applies);
      // see isNestedFence. Non-breaking; pixel-perfect nested card deferred.
      if (isNestedFence(node.node)) return false;

      const openLine = doc.lineAt(node.from);
      const closeLine = doc.lineAt(node.to);
      const revealed =
        focused && selectionTouchesLines(state, openLine.number, closeLine.number);

      if (revealed) {
        // Editing: show raw fence + body, card every line, no bar/badge.
        for (let n = openLine.number; n <= closeLine.number; n++) {
          const line = doc.line(n);
          const deco =
            openLine.number === closeLine.number
              ? cardBodyOnly
              : n === openLine.number
                ? cardBodyTop
                : n === closeLine.number
                  ? cardBodyBottom
                  : cardBody;
          decos.push(deco.range(line.from));
        }
        return false;
      }

      // Away: replace the opening fence with a card-top bar (badge + copy),
      // card the body, hide the closing fence.
      const label = badgeLabel(state, node);
      // Copy target = the INNER code (the CodeText body), NOT the fence markers
      // or language info — the user wants `Copy` to yield just the code.
      const codeText = node.node.getChild("CodeText");
      const source = codeText ? doc.sliceString(codeText.from, codeText.to) : "";
      const bodyFirst = openLine.number + 1;
      const bodyLast = closeLine.number - 1;

      if (bodyLast < bodyFirst) {
        // Empty block (```lang\n```): one self-contained bar (rounded all round)
        // replacing both fence lines.
        decos.push(
          Decoration.replace({
            block: true,
            widget: new CodeCardBarWidget(label, true, source, node.from),
          }).range(openLine.from, closeLine.to),
        );
        return false;
      }

      // Replace the fence line's CONTENT only ([from, to], not through the next
      // line's start). Ending the block-replace at the next line's start
      // swallows that line's `Decoration.line` (CM associates a line decoration
      // at a position that is also a block-replace boundary with the replaced
      // block) — which left the first body line uncarded.
      decos.push(
        Decoration.replace({
          block: true,
          widget: new CodeCardBarWidget(label, false, source, node.from),
        }).range(openLine.from, openLine.to),
      );
      const lastBody = doc.line(bodyLast);
      for (let n = bodyFirst; n <= bodyLast; n++) {
        const line = n === bodyLast ? lastBody : doc.line(n);
        decos.push((n === bodyLast ? cardBodyBottom : cardBody).range(line.from));
      }
      decos.push(hiddenFence.range(lastBody.to, closeLine.to));
      return false;
    },
  });
  return Decoration.set(decos, true);
}

const setCodeFocus = StateEffect.define<boolean>();

const codeFocusField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCodeFocus)) return effect.value;
    }
    return value;
  },
});

const codeFocusTracker = EditorView.focusChangeEffect.of((_state, focusing) =>
  setCodeFocus.of(focusing),
);

const codeBlockField = StateField.define<DecorationSet>({
  create(state) {
    return buildCodeBlockDecorations(state, state.field(codeFocusField));
  },
  update(decorations, tr) {
    const selectionChanged = !tr.startState.selection.eq(tr.state.selection);
    const focusChanged = tr.effects.some((e) => e.is(setCodeFocus));
    // Lezer parses async; rebuild on background parse advances too (see table.ts).
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!tr.docChanged && !selectionChanged && !focusChanged && !treeChanged) {
      return decorations;
    }
    return buildCodeBlockDecorations(tr.state, tr.state.field(codeFocusField));
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});

// Reveal the copy control when the mouse is anywhere over a code block (not
// just the bar). There is no single card container element (the card is line
// decorations + a bar widget), so a CSS `:hover` can't span the block — this
// tracks the pointer, resolves the enclosing FencedCode, and toggles
// `is-hovered` on that block's bar (found by its data-block-from). Direct DOM
// toggle (no decoration rebuild) keeps the "copied" check from resetting on
// mouse move.
const codeBlockHoverTracker = ViewPlugin.fromClass(
  class {
    private hovered: number | null = null;
    constructor(readonly view: EditorView) {
      view.dom.addEventListener("mousemove", this.onMove);
      view.dom.addEventListener("mouseleave", this.onLeave);
    }
    private readonly onMove = (event: MouseEvent): void => {
      const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      let from: number | null = null;
      if (pos != null) {
        for (
          let node: import("@lezer/common").SyntaxNode | null = syntaxTree(
            this.view.state,
          ).resolveInner(pos, 0);
          node;
          node = node.parent
        ) {
          if (node.name === "FencedCode") {
            from = node.from;
            break;
          }
        }
      }
      if (from !== this.hovered) this.setHovered(from);
    };
    private readonly onLeave = (): void => this.setHovered(null);
    private setHovered(from: number | null): void {
      const sel = (f: number): string => `.cm-code-card-bar[data-block-from="${f}"]`;
      if (this.hovered !== null) {
        this.view.contentDOM.querySelector(sel(this.hovered))?.classList.remove("is-hovered");
      }
      this.hovered = from;
      if (from !== null) {
        this.view.contentDOM.querySelector(sel(from))?.classList.add("is-hovered");
      }
    }
    destroy(): void {
      this.view.dom.removeEventListener("mousemove", this.onMove);
      this.view.dom.removeEventListener("mouseleave", this.onLeave);
    }
  },
);

export function fencedCodeDecorations(): Extension {
  // Order: the focus field must update before codeBlockField reads it.
  return [codeFocusField, codeFocusTracker, codeBlockField, codeBlockHoverTracker];
}
