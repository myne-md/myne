// HTML projection emitter for the Myne v0.1 dialect (MYND-255, note-export-pdf
// tasks 1+2).
//
// Projects a note's plaintext to a STANDALONE HTML document body — independent
// of the PDF capture step, reusable by any print/HTML-export/read-view surface.
// Coverage contract: docs/spec/markdown-dialect.md §3 (the construct
// inventory); golden-tested per construct under tests/dialect/html/.
//
// Postures (the load-bearing ones):
//   - ESCAPE BY DEFAULT. Text reaches the output through escape.ts; the only
//     pass-through HTML is vetted renderer output (KaTeX, mermaid's own
//     sanitized SVG, DOMPurify under the editor's 8-tag allowlist).
//   - PURE over the input: the emitter never mutates the plaintext (asserted
//     by the round-trip guard in tests).
//   - Frontmatter projects ONLY `title:` (→ `<h1 class="note-title">`); every
//     other FM field is dropped and the block itself is never rendered.
//   - Inline `#tags` render as plain text (SYNC-17 — no chip).
//   - Heavy renderers stay lazy (SYNC-4) — see renderers.ts.
//   - Link hrefs are scheme-allowlisted (http/https/mailto + scheme-less);
//     anything else renders as plain text. `attachment://` appears only on
//     image attachment embeds.
//
// Documented approximations (print projection, not a buffer mirror):
//   - A paragraph intersecting a `$$…$$` block-math range is replaced by the
//     math block (editor parity: the decoration block-replaces those lines).
//   - List "tightness": a list item with a single paragraph renders it bare;
//     two or more paragraphs each get a `<p>`.
//   - Task-list checkboxes are unicode glyphs (☐/☑) — they print reliably,
//     unlike form controls.
//   - HTML comment / processing-instruction blocks are omitted (invisible
//     content; Obsidian parity).
//   - Markdown images (`![alt](url)`) and non-attachment wikilink embeds
//     render as quiet placeholder spans — the export never fetches a remote
//     or raw-path resource (PRD story 7).

import type { SyntaxNode } from "@lezer/common";
import { parser } from "../lezer/parser";
import { locateFrontmatter } from "../lezer/frontmatter";
import { readTitleFromFmBody } from "../surgery";
import { foldLabel } from "../../editor/decorations/link-reference-collector";
import { SANITIZE_CONFIG } from "../../editor/html/sanitize";
import {
  attachmentUrl,
  parseAttachmentTarget,
} from "../../notes/attachmentRef";
import { escapeAttr, escapeHtml } from "./escape";
import {
  attachmentEmbedDisplayName,
  IMAGE_EXT_RE,
  type ExcludedAttachment,
} from "./attachment-classification";
import { CALLOUT_HEADER_RE, CALLOUT_HTML_TYPES } from "./callout-types";
import {
  type HeavyRenderers,
  loadHeavyRenderers,
  realSvgLayoutAvailable,
  type RendererNeeds,
} from "./renderers";

// === Public API ============================================================

// Image-vs-excluded classification lives in `attachment-classification.ts`
// (light module) so the PDF flow's pre-export notice shares it without
// loading this emitter; the type is re-exported for existing importers.
export type { ExcludedAttachment } from "./attachment-classification";

export interface EmitNoteHtmlOptions {
  /** Mermaid rendering: `"auto"` (render only when a real SVG layout engine is
   *  detected — never in jsdom/node), `"force"` (attempt regardless; tests
   *  inject a renderer via `setMermaidLoader`), `"off"`. Default `"auto"`.
   *  Failures always fall back to the monospace code card. */
  readonly mermaid?: "auto" | "force" | "off";
}

export interface EmitNoteHtmlResult {
  /** The document-body markup (block elements; no `<html>`/`<head>` shell). */
  readonly html: string;
  /** The frontmatter `title:` scalar, `null` when absent/empty. */
  readonly title: string | null;
  /** PDF + other non-image attachment embeds, deduplicated by id. */
  readonly excludedAttachments: readonly ExcludedAttachment[];
}

/** Project a note's plaintext to its standalone HTML document body. Async
 *  because the heavy renderers (KaTeX / mermaid / DOMPurify / code languages)
 *  are lazy-loaded on demand (SYNC-4). Never throws on note content; renderer
 *  load failures degrade to escaped text. */
export async function emitNoteHtml(
  plaintext: string,
  opts: EmitNoteHtmlOptions = {},
): Promise<EmitNoteHtmlResult> {
  const fm = locateFrontmatter(plaintext);
  const rawTitle =
    fm === null
      ? null
      : readTitleFromFmBody(plaintext.slice(fm.bodyStart, fm.bodyEnd));
  const title = rawTitle === null || rawTitle === "" ? null : rawTitle;
  const src = fm === null ? plaintext : plaintext.slice(fm.blockEnd);

  const tree = parser.parse(src);
  const scan = scanTree(src, tree.topNode);
  const blockMath = findBlockMath(src, scan.codeRanges);
  const inlineHtmlSpans = findInlineHtmlSpans(src, scan.codeRanges);

  const needs: RendererNeeds = {
    math: scan.hasInlineMath || blockMath.length > 0,
    code: scan.hasCode,
    html: scan.hasHtml,
    emoji: scan.hasEmoji,
    mermaid: scan.mermaidFences.length > 0,
  };
  const mermaidMode = opts.mermaid ?? "auto";
  const attemptMermaid =
    mermaidMode === "force" ||
    (mermaidMode === "auto" && realSvgLayoutAvailable());
  const renderers = await loadHeavyRenderers(needs, attemptMermaid);

  const mermaidSvg = new Map<number, string>();
  if (renderers.mermaid !== null) {
    for (let i = 0; i < scan.mermaidFences.length; i++) {
      const fence = scan.mermaidFences[i]!;
      try {
        const { svg, error } = await renderers.mermaid(
          `myne-export-mermaid-${i}`,
          fence.code,
        );
        if (error === null && svg !== "") mermaidSvg.set(fence.from, svg);
      } catch {
        // fall back to the code card for this fence
      }
    }
  }

  const ctx: Ctx = {
    src,
    renderers,
    refs: scan.refs,
    fnNumbers: scan.fnNumbers,
    fnEntries: scan.fnEntries,
    fnRefEmitted: new Set(),
    blockMath,
    blockMathEmitted: new Set(),
    inlineHtmlSpans,
    mermaidSvg,
    excluded: [],
    excludedIds: new Set(),
  };

  const parts: string[] = [];
  if (title !== null) {
    parts.push(`<h1 class="note-title">${escapeHtml(title)}</h1>`);
  }
  const body = renderBlockChildren(ctx, tree.topNode);
  if (body !== "") parts.push(body);
  const footnotes = renderFootnoteSection(ctx);
  if (footnotes !== "") parts.push(footnotes);

  return { html: parts.join("\n"), title, excludedAttachments: ctx.excluded };
}

// === Scan pass =============================================================

interface ByteRange {
  readonly from: number;
  readonly to: number;
}

interface BlockMathRange extends ByteRange {
  readonly latex: string;
}

interface FootnoteEntry {
  readonly id: string;
  readonly node: SyntaxNode;
}

interface Scan {
  readonly hasInlineMath: boolean;
  readonly hasCode: boolean;
  readonly hasHtml: boolean;
  readonly hasEmoji: boolean;
  readonly mermaidFences: ReadonlyArray<{ from: number; code: string }>;
  readonly codeRanges: readonly ByteRange[];
  /** CommonMark-folded label → URL (first definition wins). */
  readonly refs: ReadonlyMap<string, string>;
  /** footnote id → display number (only ids that HAVE a definition). */
  readonly fnNumbers: ReadonlyMap<string, number>;
  /** End-of-document entries: referenced defs in first-reference order, then
   *  unreferenced defs in source order (footnote-collector parity). */
  readonly fnEntries: readonly FootnoteEntry[];
}

function childText(
  src: string,
  node: SyntaxNode,
  name: string,
): string | null {
  const child = node.getChild(name);
  return child === null ? null : src.slice(child.from, child.to);
}

function scanTree(src: string, top: SyntaxNode): Scan {
  let hasInlineMath = false;
  let hasCode = false;
  let hasHtml = false;
  let hasEmoji = false;
  const mermaidFences: Array<{ from: number; code: string }> = [];
  const codeRanges: ByteRange[] = [];
  const refs = new Map<string, string>();
  const refOrder: string[] = [];
  const refSeen = new Set<string>();
  const defs = new Map<string, SyntaxNode>();

  top.cursor().iterate((node) => {
    switch (node.name) {
      case "InlineMath":
        hasInlineMath = true;
        return false;
      case "Emoji":
        hasEmoji = true;
        return false;
      case "HTMLBlock":
      case "HTMLTag":
        hasHtml = true;
        return undefined;
      case "InlineCode":
      case "CodeBlock":
        codeRanges.push({ from: node.from, to: node.to });
        return false;
      case "FencedCode": {
        codeRanges.push({ from: node.from, to: node.to });
        const info = childText(src, node.node, "CodeInfo") ?? "";
        const code = childText(src, node.node, "CodeText") ?? "";
        if (info.trim().toLowerCase() === "mermaid") {
          mermaidFences.push({ from: node.from, code });
        } else {
          hasCode = true;
        }
        return false;
      }
      case "LinkReference": {
        const label = childText(src, node.node, "LinkLabel");
        const url = childText(src, node.node, "URL");
        if (label !== null && url !== null) {
          const folded = foldLabel(label);
          if (folded !== "" && !refs.has(folded)) refs.set(folded, url.trim());
        }
        return false;
      }
      case "FootnoteReference": {
        const id = childText(src, node.node, "FootnoteLabel");
        if (id !== null && !refSeen.has(id)) {
          refSeen.add(id);
          refOrder.push(id);
        }
        return false;
      }
      case "FootnoteDefinition": {
        const id = childText(src, node.node, "FootnoteLabel");
        if (id !== null && !defs.has(id)) defs.set(id, node.node);
        return undefined; // body may contain refs/code/html — keep scanning
      }
      default:
        return undefined;
    }
  });

  const fnNumbers = new Map<string, number>();
  const fnEntries: FootnoteEntry[] = [];
  for (const id of refOrder) {
    const node = defs.get(id);
    if (node !== undefined) {
      fnEntries.push({ id, node });
      fnNumbers.set(id, fnEntries.length);
    }
  }
  for (const [id, node] of defs) {
    if (!refSeen.has(id)) {
      fnEntries.push({ id, node });
      fnNumbers.set(id, fnEntries.length);
    }
  }

  return {
    hasInlineMath,
    hasCode,
    hasHtml,
    hasEmoji,
    mermaidFences,
    codeRanges,
    refs,
    fnNumbers,
    fnEntries,
  };
}

function inAnyRange(ranges: readonly ByteRange[], pos: number): boolean {
  return ranges.some((r) => pos >= r.from && pos < r.to);
}

// Block `$$…$$` is a decoration in the editor, not a parser node (math.ts) —
// same regex here, with code ranges excluded.
const BLOCK_MATH_RE = /\$\$([\s\S]*?)\$\$/g;

function findBlockMath(
  src: string,
  codeRanges: readonly ByteRange[],
): BlockMathRange[] {
  const out: BlockMathRange[] = [];
  BLOCK_MATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_MATH_RE.exec(src)) !== null) {
    const from = m.index;
    const to = m.index + m[0].length;
    if (inAnyRange(codeRanges, from) || inAnyRange(codeRanges, to - 1)) {
      continue;
    }
    out.push({ from, to, latex: m[1] ?? "" });
  }
  return out;
}

// Paired allowlisted inline spans, exactly the editor's embedded-html.ts
// recognizers (open/close kept in sync by the backref).
const INLINE_HTML_RE = /<(kbd|mark|sub|sup|abbr)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_HTML_FULL_RE = /^<(p|details)\b[^>]*>[\s\S]*<\/\1>\s*$/i;

function findInlineHtmlSpans(
  src: string,
  codeRanges: readonly ByteRange[],
): Map<number, ByteRange> {
  const spans = new Map<number, ByteRange>();
  INLINE_HTML_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_HTML_RE.exec(src)) !== null) {
    const from = m.index;
    if (inAnyRange(codeRanges, from)) continue;
    spans.set(from, { from, to: from + m[0].length });
  }
  return spans;
}

// === Emit context ==========================================================

interface Ctx {
  readonly src: string;
  readonly renderers: HeavyRenderers;
  readonly refs: ReadonlyMap<string, string>;
  readonly fnNumbers: ReadonlyMap<string, number>;
  readonly fnEntries: readonly FootnoteEntry[];
  readonly fnRefEmitted: Set<string>;
  readonly blockMath: readonly BlockMathRange[];
  readonly blockMathEmitted: Set<number>;
  readonly inlineHtmlSpans: ReadonlyMap<number, ByteRange>;
  readonly mermaidSvg: ReadonlyMap<number, string>;
  readonly excluded: ExcludedAttachment[];
  readonly excludedIds: Set<string>;
}

function slice(ctx: Ctx, node: SyntaxNode): string {
  return ctx.src.slice(node.from, node.to);
}

/** Syntax-mark node (never emitted): `…Mark` / `…Marker` families. */
function isMarkName(name: string): boolean {
  return name.endsWith("Mark") || name.endsWith("Marker");
}

function sanitizeWith(ctx: Ctx, raw: string): string | null {
  const purifier = ctx.renderers.purifier;
  if (purifier === null) return null;
  try {
    const safe = purifier.sanitize(raw, { ...SANITIZE_CONFIG });
    return safe === "" ? null : safe;
  } catch {
    return null; // fail closed → caller escapes the raw text
  }
}

// === Blocks ================================================================

interface BlockChildrenOptions {
  /** Callout body: clip the first paragraph to start at this offset (past the
   *  `[!type] title` header line). */
  readonly clipFirstParagraphFrom?: number;
}

function renderBlockChildren(
  ctx: Ctx,
  parent: SyntaxNode,
  options: BlockChildrenOptions = {},
): string {
  const parts: string[] = [];
  let clipPending = options.clipFirstParagraphFrom;
  for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
    if (isMarkName(child.name)) continue;

    // Block-math consumption: a block intersecting a `$$…$$` range is replaced
    // by the math block (emitted once per range).
    const mathIdx = ctx.blockMath.findIndex(
      (r) => child!.from < r.to && child!.to > r.from,
    );
    if (mathIdx !== -1) {
      if (!ctx.blockMathEmitted.has(mathIdx)) {
        ctx.blockMathEmitted.add(mathIdx);
        parts.push(renderBlockMath(ctx, ctx.blockMath[mathIdx]!));
      }
      continue;
    }

    if (clipPending !== undefined && child.name === "Paragraph") {
      const from = clipPending;
      clipPending = undefined;
      if (child.from < from) {
        if (from < child.to) {
          const inner = renderInline(ctx, child, from, child.to).trimStart();
          if (inner !== "") parts.push(`<p>${inner}</p>`);
        }
        continue;
      }
    }

    const html = renderBlockNode(ctx, child);
    if (html !== "") parts.push(html);
  }
  return parts.join("\n");
}

function renderBlockNode(ctx: Ctx, node: SyntaxNode): string {
  switch (node.name) {
    case "Paragraph":
      return renderParagraph(ctx, node);
    case "ATXHeading1":
    case "ATXHeading2":
    case "ATXHeading3":
    case "ATXHeading4":
    case "ATXHeading5":
    case "ATXHeading6":
      return renderHeading(ctx, node, Number(node.name.slice(-1)), "atx");
    case "SetextHeading1":
      return renderHeading(ctx, node, 1, "setext");
    case "SetextHeading2":
      return renderHeading(ctx, node, 2, "setext");
    case "Blockquote":
      return renderBlockquote(ctx, node);
    case "BulletList":
      return renderList(ctx, node, false);
    case "OrderedList":
      return renderList(ctx, node, true);
    case "FencedCode":
      return renderFencedCode(ctx, node);
    case "CodeBlock":
      return renderIndentedCode(ctx, node);
    case "Table":
      return renderTable(ctx, node);
    case "HorizontalRule":
      return "<hr>";
    case "DefinitionList":
      return renderDefinitionList(ctx, node);
    case "HTMLBlock":
      return renderHtmlBlock(ctx, node);
    case "CommentBlock":
    case "ProcessingInstructionBlock":
      return ""; // invisible content — omitted
    case "LinkReference":
      return ""; // resolved definitions never render (CommonMark)
    case "FootnoteDefinition":
      return ""; // collected into the end-of-document section
    case "FootnoteLabel":
      return ""; // the `[^id]:` identifier — part of the marker, never body
    case "Task":
      // Reached only outside a list item (degenerate); render as a paragraph.
      return `<p>${renderInline(ctx, node, node.from, node.to)}</p>`;
    default:
      // Unknown block: escaped source, never raw pass-through.
      return `<p>${escapeHtml(slice(ctx, node))}</p>`;
  }
}

function renderParagraph(ctx: Ctx, node: SyntaxNode): string {
  const sole = soleNonImageAttachmentEmbed(ctx, node);
  if (sole !== null) {
    return renderAttachmentEmbed(ctx, sole.id, sole.filename, true);
  }
  const inner = renderInline(ctx, node, node.from, node.to);
  return `<p>${inner}</p>`;
}

function renderHeading(
  ctx: Ctx,
  node: SyntaxNode,
  level: number,
  kind: "atx" | "setext",
): string {
  const marks = node.getChildren("HeaderMark");
  let from = node.from;
  let to = node.to;
  if (kind === "atx") {
    const first = marks[0];
    if (first !== undefined) from = first.to;
    const last = marks[marks.length - 1];
    if (last !== undefined && last.from > from) to = last.from;
  } else {
    const underline = marks[0];
    if (underline !== undefined) to = underline.from;
  }
  while (from < to && /\s/.test(ctx.src[from]!)) from++;
  while (to > from && /\s/.test(ctx.src[to - 1]!)) to--;
  return `<h${level}>${renderInline(ctx, node, from, to)}</h${level}>`;
}

function renderBlockquote(ctx: Ctx, node: SyntaxNode): string {
  const lineEnd = ctx.src.indexOf("\n", node.from);
  const firstLineEnd = lineEnd === -1 || lineEnd > node.to ? node.to : lineEnd;
  const header = CALLOUT_HEADER_RE.exec(ctx.src.slice(node.from, firstLineEnd));
  if (header !== null) {
    const type = CALLOUT_HTML_TYPES[header[2]!.toLowerCase()];
    if (type !== undefined) {
      const title = header[4]!.trim() !== "" ? header[4]!.trim() : type.label;
      const body = renderBlockChildren(ctx, node, {
        clipFirstParagraphFrom: firstLineEnd + 1,
      });
      const cls = `callout callout-${header[2]!.toLowerCase()} callout-tone-${type.tone}`;
      const titleHtml = `<p class="callout-title">${escapeHtml(title)}</p>`;
      return body === ""
        ? `<div class="${cls}">\n${titleHtml}\n</div>`
        : `<div class="${cls}">\n${titleHtml}\n${body}\n</div>`;
    }
  }
  const inner = renderBlockChildren(ctx, node);
  return `<blockquote>\n${inner}\n</blockquote>`;
}

function renderList(ctx: Ctx, node: SyntaxNode, ordered: boolean): string {
  const items: string[] = [];
  for (const item of node.getChildren("ListItem")) {
    items.push(renderListItem(ctx, item));
  }
  if (!ordered) return `<ul>\n${items.join("\n")}\n</ul>`;
  const firstMark = node.firstChild?.getChild("ListMark");
  const start =
    firstMark !== null && firstMark !== undefined
      ? Number.parseInt(slice(ctx, firstMark), 10)
      : 1;
  const startAttr =
    Number.isFinite(start) && start !== 1 ? ` start="${start}"` : "";
  return `<ol${startAttr}>\n${items.join("\n")}\n</ol>`;
}

function renderListItem(ctx: Ctx, item: SyntaxNode): string {
  const blocks: SyntaxNode[] = [];
  for (let c = item.firstChild; c !== null; c = c.nextSibling) {
    if (!isMarkName(c.name)) blocks.push(c);
  }
  const task = blocks[0]?.name === "Task" ? blocks[0] : null;
  if (task !== null) {
    const marker = task.getChild("TaskMarker");
    const checked = marker !== null && /x/i.test(slice(ctx, marker));
    const contentFrom = marker === null ? task.from : marker.to;
    const inner = renderInline(ctx, task, contentFrom, task.to).trimStart();
    const rest = blocks
      .slice(1)
      .map((b) => renderBlockNode(ctx, b))
      .filter((s) => s !== "");
    const glyph = checked ? "☑" : "☐";
    const body = [
      `<span class="task-checkbox" aria-hidden="true">${glyph}</span> ${inner}`,
      ...rest,
    ].join("\n");
    return `<li class="task-list-item" data-checked="${checked}">${body}</li>`;
  }

  const paragraphCount = blocks.filter((b) => b.name === "Paragraph").length;
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.name === "Paragraph" && paragraphCount <= 1) {
      const sole = soleNonImageAttachmentEmbed(ctx, b);
      parts.push(
        sole !== null
          ? renderAttachmentEmbed(ctx, sole.id, sole.filename, false)
          : renderInline(ctx, b, b.from, b.to),
      );
    } else {
      const html = renderBlockNode(ctx, b);
      if (html !== "") parts.push(html);
    }
  }
  return `<li>${parts.join("\n")}</li>`;
}

function renderFencedCode(ctx: Ctx, node: SyntaxNode): string {
  const info = childText(ctx.src, node, "CodeInfo") ?? "";
  const code = childText(ctx.src, node, "CodeText") ?? "";
  if (info.trim().toLowerCase() === "mermaid") {
    const svg = ctx.mermaidSvg.get(node.from);
    if (svg !== undefined) {
      return `<figure class="mermaid-diagram">${svg}</figure>`;
    }
    // jsdom / load failure / parse error → monospace code card (editor parity).
    return `<pre class="code-card mermaid-fallback"><code>${escapeHtml(code)}</code></pre>`;
  }
  const langToken = info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const langAttr = langToken === "" ? "" : ` data-lang="${escapeAttr(langToken)}"`;
  const highlighted = ctx.renderers.highlight?.(code, info) ?? null;
  const inner = highlighted ?? escapeHtml(code);
  return `<pre class="code-card"${langAttr}><code>${inner}</code></pre>`;
}

function renderIndentedCode(ctx: Ctx, node: SyntaxNode): string {
  const lines = node
    .getChildren("CodeText")
    .map((c) => ctx.src.slice(c.from, c.to));
  const code = lines.length > 0 ? lines.join("\n") : slice(ctx, node);
  return `<pre class="code-card"><code>${escapeHtml(code)}</code></pre>`;
}

type CellAlign = "left" | "center" | "right" | null;

function renderTable(ctx: Ctx, node: SyntaxNode): string {
  // The alignment row is the TableDelimiter that is a DIRECT child of Table
  // (cell pipes are TableDelimiter children of TableHeader/TableRow).
  const delim = node.getChild("TableDelimiter");
  const aligns: CellAlign[] = [];
  if (delim !== null) {
    const cells = slice(ctx, delim)
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|");
    for (const cell of cells) {
      const t = cell.trim();
      if (t.startsWith(":") && t.endsWith(":")) aligns.push("center");
      else if (t.endsWith(":")) aligns.push("right");
      else if (t.startsWith(":")) aligns.push("left");
      else aligns.push(null);
    }
  }
  const cellHtml = (cell: SyntaxNode, idx: number, tag: "th" | "td"): string => {
    const align = aligns[idx] ?? null;
    const style = align === null ? "" : ` style="text-align:${align}"`;
    return `<${tag}${style}>${renderInline(ctx, cell, cell.from, cell.to)}</${tag}>`;
  };
  const rowHtml = (row: SyntaxNode, tag: "th" | "td"): string => {
    const cells = row
      .getChildren("TableCell")
      .map((cell, i) => cellHtml(cell, i, tag));
    return `<tr>${cells.join("")}</tr>`;
  };
  const parts: string[] = ["<table>"];
  const header = node.getChild("TableHeader");
  if (header !== null) parts.push(`<thead>${rowHtml(header, "th")}</thead>`);
  const rows = node.getChildren("TableRow");
  if (rows.length > 0) {
    parts.push(`<tbody>${rows.map((r) => rowHtml(r, "td")).join("")}</tbody>`);
  }
  parts.push("</table>");
  return parts.join("\n");
}

function renderDefinitionList(ctx: Ctx, node: SyntaxNode): string {
  const parts: string[] = [];
  for (let c = node.firstChild; c !== null; c = c.nextSibling) {
    if (c.name === "DefinitionTerm") {
      parts.push(`<dt>${renderInline(ctx, c, c.from, c.to)}</dt>`);
    } else if (c.name === "DefinitionDesc") {
      parts.push(`<dd>${renderInline(ctx, c, c.from, c.to)}</dd>`);
    }
  }
  return `<dl>\n${parts.join("\n")}\n</dl>`;
}

function renderHtmlBlock(ctx: Ctx, node: SyntaxNode): string {
  const raw = slice(ctx, node);
  if (BLOCK_HTML_FULL_RE.test(raw)) {
    const safe = sanitizeWith(ctx, raw);
    if (safe !== null) return `<div class="embedded-html-block">${safe}</div>`;
  }
  // Off-allowlist (or sanitizer unavailable): plain escaped text (§3.1).
  return `<p class="raw-html">${escapeHtml(raw)}</p>`;
}

function renderBlockMath(ctx: Ctx, range: BlockMathRange): string {
  const raw = ctx.src.slice(range.from, range.to);
  const math = ctx.renderers.math;
  if (math !== null) {
    const { html, error } = math(range.latex.trim(), true);
    if (error === null) return `<div class="math math-block">${html}</div>`;
  }
  // Invalid LaTeX (or renderer unavailable): raw source, never KaTeX's red node.
  return `<div class="math math-error">${escapeHtml(raw)}</div>`;
}

// === Footnote end-of-document section ======================================

function renderFootnoteSection(ctx: Ctx): string {
  if (ctx.fnEntries.length === 0) return "";
  const items = ctx.fnEntries.map((entry, i) => {
    const body = renderBlockChildren(ctx, entry.node);
    return `<li class="footnote-item" id="fn-${i + 1}">${body}</li>`;
  });
  return `<section class="footnotes">\n<ol class="footnote-list">\n${items.join("\n")}\n</ol>\n</section>`;
}

// === Inline ================================================================

function renderInline(
  ctx: Ctx,
  parent: SyntaxNode,
  from: number,
  to: number,
): string {
  let out = "";
  let pos = from;
  let child = parent.firstChild;
  while (child !== null) {
    if (child.to <= from || child.from < pos) {
      child = child.nextSibling;
      continue;
    }
    if (child.from >= to) break;
    if (child.from > pos) out += escapeHtml(ctx.src.slice(pos, child.from));

    // Paired allowlisted inline HTML span (`<kbd>…</kbd>` …): sanitize the
    // whole span and skip every child it covers (editor embedded-html parity).
    if (child.name === "HTMLTag") {
      const span = ctx.inlineHtmlSpans.get(child.from);
      if (span !== undefined && span.to <= to) {
        const safe = sanitizeWith(ctx, ctx.src.slice(span.from, span.to));
        if (safe !== null) {
          out += `<span class="embedded-html">${safe}</span>`;
          pos = span.to;
          child = child.nextSibling;
          continue;
        }
      }
    }

    out += renderInlineNode(ctx, child);
    pos = Math.min(Math.max(pos, child.to), to);
    child = child.nextSibling;
  }
  if (pos < to) out += escapeHtml(ctx.src.slice(pos, to));
  return out;
}

function renderInlineNode(ctx: Ctx, node: SyntaxNode): string {
  if (isMarkName(node.name)) return "";
  switch (node.name) {
    case "Emphasis":
      return `<em>${renderInline(ctx, node, node.from, node.to)}</em>`;
    case "StrongEmphasis":
      return `<strong>${renderInline(ctx, node, node.from, node.to)}</strong>`;
    case "Strikethrough":
      return `<del>${renderInline(ctx, node, node.from, node.to)}</del>`;
    case "Highlight":
      return `<mark class="highlight">${renderInline(ctx, node, node.from, node.to)}</mark>`;
    case "Subscript":
      return `<sub>${renderInline(ctx, node, node.from, node.to)}</sub>`;
    case "Superscript":
      return `<sup>${renderInline(ctx, node, node.from, node.to)}</sup>`;
    case "InlineCode": {
      const marks = node.getChildren("CodeMark");
      const first = marks[0];
      const last = marks[marks.length - 1];
      const from = first !== undefined ? first.to : node.from;
      const to = last !== undefined && last.from > from ? last.from : node.to;
      return `<code>${escapeHtml(ctx.src.slice(from, to))}</code>`;
    }
    case "Link":
      return renderLink(ctx, node);
    case "Image":
      return renderImage(ctx, node);
    case "Autolink": {
      const url = childText(ctx.src, node, "URL") ?? "";
      return renderAnchor(autolinkHref(url), escapeHtml(url), null);
    }
    case "URL": {
      const url = slice(ctx, node);
      return renderAnchor(autolinkHref(url), escapeHtml(url), null);
    }
    case "Wikilink":
      return renderWikilink(ctx, node);
    case "FootnoteReference":
      return renderFootnoteReference(ctx, node);
    case "InlineMath":
      return renderInlineMath(ctx, node);
    case "InlineTag":
      return escapeHtml(slice(ctx, node)); // plain text — SYNC-17, no chip
    case "Emoji": {
      const raw = slice(ctx, node);
      const name = raw.slice(1, -1);
      const glyph =
        ctx.renderers.emoji !== null &&
        Object.prototype.hasOwnProperty.call(ctx.renderers.emoji, name)
          ? ctx.renderers.emoji[name]
          : undefined;
      return glyph !== undefined ? escapeHtml(glyph) : escapeHtml(raw);
    }
    case "Escape":
      return escapeHtml(ctx.src.slice(node.from + 1, node.to));
    case "Entity":
      return slice(ctx, node); // already an HTML entity
    case "HardBreak":
      return "<br>\n";
    case "HTMLTag":
      return escapeHtml(slice(ctx, node)); // unpaired / off-allowlist → text
    case "Task":
      return renderInline(ctx, node, node.from, node.to);
    default:
      return renderInline(ctx, node, node.from, node.to);
  }
}

// --- links -----------------------------------------------------------------

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function safeHref(url: string): string | null {
  const m = SCHEME_RE.exec(url);
  if (m === null) return url; // relative / fragment — inert in a document
  return SAFE_SCHEMES.has(m[0].toLowerCase()) ? url : null;
}

function autolinkHref(url: string): string | null {
  if (SCHEME_RE.test(url)) return safeHref(url);
  if (url.includes("@")) return `mailto:${url}`;
  return `http://${url}`;
}

function renderAnchor(
  href: string | null,
  textHtml: string,
  title: string | null,
): string {
  if (href === null) return textHtml; // unsafe scheme → plain text
  const titleAttr = title === null ? "" : ` title="${escapeAttr(title)}"`;
  return `<a href="${escapeAttr(href)}"${titleAttr}>${textHtml}</a>`;
}

function renderLink(ctx: Ctx, node: SyntaxNode): string {
  const marks = node.getChildren("LinkMark");
  const textFrom = marks[0]?.to ?? node.from;
  const textTo = marks[1]?.from ?? node.to;
  const textHtml = renderInline(ctx, node, textFrom, textTo);

  const url = childText(ctx.src, node, "URL");
  if (url !== null) {
    const rawTitle = childText(ctx.src, node, "LinkTitle");
    const title =
      rawTitle !== null && rawTitle.length >= 2
        ? rawTitle.slice(1, -1)
        : rawTitle;
    return renderAnchor(safeHref(url), textHtml, title);
  }

  // Reference link: full `[text][label]`, collapsed `[text][]`, or shortcut
  // `[text]` — resolved by CommonMark folded-label rules; a dangling reference
  // renders as literal text (editor parity).
  const labelNode = node.getChild("LinkLabel");
  const rawLabel =
    labelNode !== null ? slice(ctx, labelNode) : ctx.src.slice(textFrom, textTo);
  const folded = foldLabel(rawLabel);
  const effective =
    folded === "" ? foldLabel(ctx.src.slice(textFrom, textTo)) : folded;
  const target = ctx.refs.get(effective);
  if (target === undefined) return escapeHtml(slice(ctx, node));
  return renderAnchor(safeHref(target), textHtml, null);
}

function renderImage(ctx: Ctx, node: SyntaxNode): string {
  // Markdown images are never fetched (no remote/raw-path loads in an export);
  // they project to a quiet placeholder carrying the alt text (or URL).
  const marks = node.getChildren("LinkMark");
  const altFrom = marks[0]?.to ?? node.from;
  const altTo = marks[1]?.from ?? node.to;
  const alt = ctx.src.slice(altFrom, altTo).trim();
  const url = childText(ctx.src, node, "URL") ?? "";
  const label = alt !== "" ? alt : url;
  return `<span class="embed-placeholder">${escapeHtml(label)}</span>`;
}

// --- wikilinks + attachment embeds ------------------------------------------

const PDF_EXT_RE = /\.pdf$/i;

function wikilinkParts(
  ctx: Ctx,
  node: SyntaxNode,
): {
  embed: boolean;
  target: string;
  alias: string | null;
  display: string;
} {
  const firstMark = node.getChild("WikilinkMark");
  const embed = firstMark !== null && slice(ctx, firstMark).startsWith("!");
  const target = childText(ctx.src, node, "WikilinkTarget") ?? "";
  const alias = childText(ctx.src, node, "WikilinkAlias");
  const heading = childText(ctx.src, node, "WikilinkHeading");
  const blockId = childText(ctx.src, node, "WikilinkBlockId");
  const display =
    alias ??
    `${target}${heading !== null ? `#${heading}` : ""}${blockId !== null ? `^${blockId}` : ""}`;
  return { embed, target, alias, display };
}

function renderWikilink(ctx: Ctx, node: SyntaxNode): string {
  const { embed, target, alias, display } = wikilinkParts(ctx, node);
  if (embed) {
    const attId = parseAttachmentTarget(target);
    if (attId !== null) {
      return renderAttachmentEmbed(ctx, attId, alias ?? "", false);
    }
    // Non-attachment embed (`![[Note]]` / `![[image.png]]`): quiet placeholder.
    return `<span class="embed-placeholder">${escapeHtml(display)}</span>`;
  }
  // Plain styled span, no href — there is nothing to navigate to in a PDF.
  return `<span class="wikilink">${escapeHtml(display)}</span>`;
}

function collectExcluded(ctx: Ctx, id: string, filename: string): void {
  if (ctx.excludedIds.has(id)) return;
  ctx.excludedIds.add(id);
  ctx.excluded.push({ id, filename });
}

/**
 * Form-C attachment embed (`![[att:<64hex>|filename]]`). Image-ness is the
 * shared extension-allowlist classification (`attachment-classification.ts`
 * — also the source of the flow's pre-export notice). PDFs and every other
 * extension are NOT inlined: they render a placeholder line and join
 * `excludedAttachments`.
 */
function renderAttachmentEmbed(
  ctx: Ctx,
  id: string,
  filename: string,
  asBlock: boolean,
): string {
  const name = attachmentEmbedDisplayName(filename);
  if (IMAGE_EXT_RE.test(name)) {
    return `<img class="att-image" src="${escapeAttr(attachmentUrl(id))}" alt="${escapeAttr(name)}">`;
  }
  collectExcluded(ctx, id, name);
  const excludedPdf = PDF_EXT_RE.test(name);
  const cls = excludedPdf ? "att-excluded" : "att-placeholder";
  const text = excludedPdf
    ? `PDF attachment "${name}" not included`
    : `Attachment "${name}" not included`;
  const tag = asBlock ? "p" : "span";
  return `<${tag} class="${cls}">${escapeHtml(text)}</${tag}>`;
}

/** Paragraph that consists solely of one non-image attachment embed (modulo
 *  whitespace) — promoted to a block-level placeholder line. */
function soleNonImageAttachmentEmbed(
  ctx: Ctx,
  paragraph: SyntaxNode,
): { id: string; filename: string } | null {
  const child = paragraph.firstChild;
  if (child === null || child.nextSibling !== null) return null;
  if (child.name !== "Wikilink") return null;
  const before = ctx.src.slice(paragraph.from, child.from);
  const after = ctx.src.slice(child.to, paragraph.to);
  if (before.trim() !== "" || after.trim() !== "") return null;
  const { embed, target, alias } = wikilinkParts(ctx, child);
  if (!embed) return null;
  const id = parseAttachmentTarget(target);
  if (id === null) return null;
  const filename = alias ?? "";
  if (IMAGE_EXT_RE.test(attachmentEmbedDisplayName(filename))) return null;
  return { id, filename };
}

// --- footnote references -----------------------------------------------------

function renderFootnoteReference(ctx: Ctx, node: SyntaxNode): string {
  const id = childText(ctx.src, node, "FootnoteLabel");
  const n = id !== null ? ctx.fnNumbers.get(id) : undefined;
  if (id === null || n === undefined) {
    return escapeHtml(slice(ctx, node)); // orphan reference → literal
  }
  const first = !ctx.fnRefEmitted.has(id);
  if (first) ctx.fnRefEmitted.add(id);
  const idAttr = first ? ` id="fnref-${n}"` : "";
  return `<sup class="footnote-ref"><a${idAttr} href="#fn-${n}">${n}</a></sup>`;
}

// --- inline math --------------------------------------------------------------

function renderInlineMath(ctx: Ctx, node: SyntaxNode): string {
  const marks = node.getChildren("MathMark");
  const first = marks[0];
  const last = marks[marks.length - 1];
  const from = first !== undefined ? first.to : node.from;
  const to = last !== undefined && last.from > from ? last.from : node.to;
  const latex = ctx.src.slice(from, to);
  const math = ctx.renderers.math;
  if (math !== null) {
    const { html, error } = math(latex, false);
    if (error === null) return `<span class="math math-inline">${html}</span>`;
  }
  return `<span class="math math-error">${escapeHtml(slice(ctx, node))}</span>`;
}
