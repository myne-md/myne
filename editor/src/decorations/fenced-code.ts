// Fenced code-block card for the Phase 1 editor (MYND-154 task 4).
//
// Grill Q2/Q3 (myne-agents/sessions/grill/2026-05-28-code-block-syntax-highlighting.md):
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
// which has no `view`) via the shared `editorFocusField`/`editorFocusTracker`
// (`cursor-aware.ts`); reveal is gated on `revealActive` (focused OR in-note
// find open), the same predicate table.ts uses, so a find-navigated match
// inside a folded fence un-folds (MYND-175).

import { syntaxTree } from "@codemirror/language";
import { TASK_QUERY_INFO } from "./task-query-block";
import {
  type EditorState,
  type Extension,
  type Range,
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
import { highlightCode } from "@lezer/highlight";
import {
  editorFocusChanged,
  editorFocusField,
  editorFocusTracker,
  revealActive,
  selectionTouchesLines,
} from "./cursor-aware";
import { QUOTE_BAR_STEP, quoteBarBackgroundCss } from "./blockquote";
import { resolveCodeLanguage } from "../code-languages";
import { codeHighlightStyle } from "../code-highlight";
import { getHost } from "../host";
import i18n from "@myne/editor/i18n";

/** Number of `Blockquote` ancestors above this fence (0 = top-level). > 0 routes
 *  the away-state render to `CodeInQuoteWidget` (a contained block widget that
 *  draws the quote's left bar(s) in a margin + an inset card), since the card
 *  block-replaces the fence lines and a block-replaced line can't carry the
 *  blockquote bar. Top-level (0) keeps the live per-line card. */
function quoteDepthOf(node: SyntaxNode): number {
  let depth = 0;
  for (let p = node.parent; p; p = p.parent) {
    if (p.name === "Blockquote") depth++;
  }
  return depth;
}

// MYND-154's `isNestedFence` top-level-only gate is lifted (MYND-155 follow-up):
// code inside a BLOCKQUOTE now renders via `CodeInQuoteWidget` (a read-only
// contained block widget matching Penpot `e--bq--code-inside`: bars in a left
// margin, code in an inset boxed card), keyed off `quoteDepthOf`. Everything
// else — top-level code AND code nested only in a plain list (no quote, so
// `quoteDepth === 0`) — keeps the live per-line card below. `blockquote.ts`
// paints the quote bars on the surrounding code lines so they align with the
// widget's margin bars.

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

// Borderless icon-only copy button that writes `source` (the inner code) to the
// clipboard and flips to a check for 1.2s. Shared by the top-level card-top bar
// and the nested code-in-quote card.
function makeCopyButton(source: string): HTMLButtonElement {
  const copy = document.createElement("button");
  copy.className = "cm-code-copy";
  copy.type = "button";
  copy.setAttribute("aria-label", i18n.t("editor.codeBlock.copyCode"));
  copy.appendChild(makeCopyIcon("copy"));
  copy.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    // Through the host seam rather than the raw WebView clipboard API
    // (myne-md/myne#390). This package cannot import `@tauri-apps/*` at all, so
    // the raw call was the only reach it had; the seam is what lets the clipboard
    // guard prohibit that API flat, with no standing exemption for the next copy
    // button to lean on. `getHost()` is called inside the handler, not at
    // decoration build time, so a code block still renders in a test that
    // installed no host.
    //
    // The prose here deliberately does not spell the banned identifier. The guard
    // is a plain string scan, which is the right shape for a prohibition: a
    // comment-aware one would be a scanner with a bypass, and a bypass in a
    // prohibition guard is worse than a false positive in one.
    //
    // The feedback stays here and stays exactly as it was: an in-place icon flip
    // on success, and nothing on refusal. Both are deliberate. The confirmation
    // sits on the control the user pressed, which a toast in the corner of the
    // window would be worse than, and this is DOM inside a CodeMirror decoration
    // rather than a React surface with a toast host to reach.
    void getHost()
      .clipboardWrite(source)
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
  return copy;
}

// Render `code` into `container` as one `<div>` per line, syntax-highlighted via
// the shared code HighlightStyle classes (colored by the injected
// `codeSyntaxHighlighting` stylesheet) when the language is known, else plain.
// textContent only — never innerHTML (TB2).
function renderHighlightedCode(
  container: HTMLElement,
  code: string,
  info: string,
): void {
  const lang = resolveCodeLanguage(info);
  let line = document.createElement("div");
  container.appendChild(line);
  const putText = (text: string, classes: string): void => {
    const span = document.createElement("span");
    if (classes) span.className = classes;
    span.textContent = text;
    line.appendChild(span);
  };
  const putBreak = (): void => {
    line = document.createElement("div");
    container.appendChild(line);
  };
  if (lang?.support) {
    const tree = lang.support.language.parser.parse(code);
    highlightCode(code, tree, codeHighlightStyle, putText, putBreak);
  } else {
    // Unknown / untagged language: plain monospace, split on newlines.
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) putBreak();
      putText(lines[i]!, "");
    }
  }
}

// Replaces the opening fence line in the away state. The language badge + the
// hover-revealed copy control sit in a cluster FLOATED into the card's top-right
// corner (theme: the bar is a 0-height overlay, the cluster is absolute) so they
// take no vertical row of their own — the first code line keeps the same 16px top
// inset as the other three edges (the "2× top padding" fix). Decorative — never
// part of the document text, so a fence-to-fence copy stays byte-stable; the copy
// button writes the block's RAW source, not any widget text (MYND-154 task 6).
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

    // Badge + copy in one corner cluster (paper-2 backed so it occludes any code
    // text that runs under it).
    const cluster = document.createElement("div");
    cluster.className = "cm-code-bar-cluster";

    const copy = makeCopyButton(this.source);

    const badge = document.createElement("span");
    badge.className = "cm-code-badge";
    badge.textContent = this.label; // textContent — never innerHTML (TB2)
    badge.setAttribute("aria-hidden", "true");

    cluster.appendChild(copy);
    cluster.appendChild(badge);
    bar.appendChild(cluster);
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

// Read-only contained card for a fenced code block nested in a blockquote/list
// (Penpot `e--bq--code-inside`). The block is block-replaced by this single
// element (away state), so we re-highlight the code here (it is no longer live
// document text). DOM: a wrapper padded by the quote margin, an absolutely-
// positioned bars strip painting `depth` `--line-2` bars in that margin (aligned
// with blockquote.ts's bars on the lines above/below), and an inset boxed card
// with the language badge + copy top-right and the highlighted code.
class CodeInQuoteWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly info: string,
    private readonly code: string,
    private readonly quoteDepth: number,
    private readonly from: number,
  ) {
    super();
  }
  eq(other: CodeInQuoteWidget): boolean {
    return (
      other.label === this.label &&
      other.info === this.info &&
      other.code === this.code &&
      other.quoteDepth === this.quoteDepth &&
      other.from === this.from
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-code-quote-wrap";
    const margin = this.quoteDepth * QUOTE_BAR_STEP;
    wrap.style.paddingLeft = `${margin}px`;

    // Click-to-edit: the widget is a block-replace (read-only), so clicking it
    // places the cursor at the block's source start and focuses — that touches
    // the block's lines, which drops the widget and reveals raw `> ```…` source
    // for editing (same pattern as the table widget). The copy button stops its
    // own clicks, so skip when the target is inside it.
    wrap.addEventListener("mousedown", (event) => {
      if ((event.target as HTMLElement).closest(".cm-code-copy")) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });

    const bars = document.createElement("div");
    bars.className = "cm-code-quote-bars";
    bars.style.cssText = `width:${margin}px;${quoteBarBackgroundCss(this.quoteDepth)}`;
    wrap.appendChild(bars);

    const card = document.createElement("div");
    card.className = "cm-code-quote-card";

    const badgeWrap = document.createElement("div");
    badgeWrap.className = "cm-code-quote-badge";
    const badge = document.createElement("span");
    badge.className = "cm-code-badge";
    badge.textContent = this.label; // textContent — never innerHTML (TB2)
    badge.setAttribute("aria-hidden", "true");
    badgeWrap.appendChild(badge);
    badgeWrap.appendChild(makeCopyButton(this.code));
    card.appendChild(badgeWrap);

    const codeEl = document.createElement("div");
    // Strip a single trailing newline so the last code row isn't an empty line.
    renderHighlightedCode(codeEl, this.code.replace(/\n$/, ""), this.info);
    card.appendChild(codeEl);

    wrap.appendChild(card);
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function badgeLabel(state: EditorState, node: { node: import("@lezer/common").SyntaxNode }): string {
  const infoNode = node.node.getChild("CodeInfo");
  const info = infoNode ? state.doc.sliceString(infoNode.from, infoNode.to) : "";
  const lang = resolveCodeLanguage(info);
  return (lang ? lang.name : info.trim()) || i18n.t("editor.codeBlock.defaultBadge");
}

/**
 * Decoration set for the current state, as a pure function of `(state,
 * revealAllowed)` so the reveal decision is testable without driving DOM focus.
 * `revealAllowed` is `revealActive(state)` (editor focused OR in-note find open),
 * so navigating find onto a match inside a folded fence reveals it (MYND-175).
 * Uses `Decoration.set(_, true)` (self-sorting) rather than a RangeSetBuilder
 * because a card mixes line decorations, block-replace, and a widget.
 */
export function buildCodeBlockDecorations(
  state: EditorState,
  revealAllowed: boolean,
): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return undefined;
      // Closed fence only (>= 2 CodeMark). Unclosed → no card (grill Q11).
      if (node.node.getChildren("CodeMark").length < 2) return false;

      // Mermaid blocks (MYND-49) are rendered by the mermaid decoration as a
      // diagram, not as a code card — skip here so the two block-replaces don't
      // collide. (On a render failure the mermaid widget falls back to its own
      // monospace card, so nothing is lost.)
      const mInfo = node.node.getChild("CodeInfo");
      if (
        mInfo !== null &&
        doc.sliceString(mInfo.from, mInfo.to).trim().toLowerCase() === "mermaid"
      ) {
        return false;
      }

      // Task-query blocks (MYND-617) render as a live list, not as a code card
      // — the same one-line skip, for the same reason: two block-replaces over
      // one range collide.
      if (
        mInfo !== null &&
        doc.sliceString(mInfo.from, mInfo.to).trim().toLowerCase() === TASK_QUERY_INFO
      ) {
        return false;
      }

      const quoteDepth = quoteDepthOf(node.node);
      const openLine = doc.lineAt(node.from);
      const closeLine = doc.lineAt(node.to);
      const revealed =
        revealAllowed && selectionTouchesLines(state, openLine.number, closeLine.number);

      // Nested in a blockquote/list → a contained read-only widget (away) that
      // draws bars-in-margin + an inset card; raw source on reveal (the
      // surrounding quote bars are painted by blockquote.ts). Top-level (depth 0)
      // falls through to the live per-line card below.
      if (quoteDepth > 0) {
        if (revealed) return false;
        const infoNode = node.node.getChild("CodeInfo");
        const info = infoNode ? doc.sliceString(infoNode.from, infoNode.to) : "";
        const codeText = node.node.getChild("CodeText");
        const code = codeText ? doc.sliceString(codeText.from, codeText.to) : "";
        decos.push(
          Decoration.replace({
            block: true,
            widget: new CodeInQuoteWidget(
              badgeLabel(state, node),
              info,
              code,
              quoteDepth,
              node.from,
            ),
          }).range(openLine.from, closeLine.to),
        );
        return false;
      }

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
        // The bar is now a 0-height overlay (the badge floats in the corner), so
        // the FIRST body line is the card's visual top: it carries the top border
        // + radius + 16px top padding, matching the other three edges.
        const deco =
          n === bodyFirst && n === bodyLast
            ? cardBodyOnly
            : n === bodyFirst
              ? cardBodyTop
              : n === bodyLast
                ? cardBodyBottom
                : cardBody;
        decos.push(deco.range(line.from));
      }
      decos.push(hiddenFence.range(lastBody.to, closeLine.to));
      return false;
    },
  });
  return Decoration.set(decos, true);
}

const codeBlockField = StateField.define<DecorationSet>({
  create(state) {
    return buildCodeBlockDecorations(state, revealActive(state));
  },
  update(decorations, tr) {
    const selectionChanged = !tr.startState.selection.eq(tr.state.selection);
    const focusChanged = editorFocusChanged(tr);
    // Lezer parses async; rebuild on background parse advances too (see table.ts).
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!tr.docChanged && !selectionChanged && !focusChanged && !treeChanged) {
      return decorations;
    }
    return buildCodeBlockDecorations(tr.state, revealActive(tr.state));
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
  // Order: the shared focus field must update before codeBlockField reads it
  // (via `revealActive`). `editorFocusField`/`editorFocusTracker` dedupe by
  // identity with the other cursor-aware decorations that also include them.
  return [editorFocusField, editorFocusTracker, codeBlockField, codeBlockHoverTracker];
}
