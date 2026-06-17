// Plain-text projection emitter for the Myne v0.1 dialect (note-export,
// MYND-340 task 1).
//
// Projects a note's plaintext markdown to a STRIPPED plain-text document
// — a genuinely lossy projection (Notesnook-parity plain text), distinct
// from the byte-verbatim `.md` export. Frontmatter, markdown syntax marks
// and embeds are dropped; the readable prose survives.
//
// This is a LOSSY projection (SYNC-2): unlike `.md` export it is NOT
// byte-stable, so the `%%`-comment strip (SYNC-1, owned by editor-comments
// #5) hooks here too once it lands. There is no `%%` token in v0.1; the
// emit path is left clean so #5 plugs in alongside `emitNoteHtml`.
//
// Postures (mirroring emitNoteHtml's coverage contract, src/dialect/html):
//   - PURE over the input: the emitter never mutates the plaintext.
//   - Frontmatter is dropped entirely (no `title:` projection — plain text
//     carries no document-title concept; the title belongs to the note's
//     own first heading if the author wrote one).
//   - Headings, emphasis, code marks, list markers, blockquote markers,
//     link/wikilink syntax → stripped to the readable text.
//   - Block structure → blank-line-separated paragraphs; list items →
//     one plain line each ("- " prefix kept so a list still reads as a
//     list); headings → bare text lines.
//   - Code-block BODIES are kept (the fence + info string are dropped).
//   - Tables flatten to tab-separated cell rows.
//   - Attachment / non-attachment embeds → dropped (no placeholder text):
//     a binary attachment has no plain-text projection. Markdown images
//     keep their alt text.

import type { SyntaxNode } from "@lezer/common";
import { parser } from "../lezer/parser";
import { locateFrontmatter } from "../lezer/frontmatter";
import { foldLabel } from "../../editor/decorations/link-reference-collector";

// === Public API ============================================================

/**
 * Project a note's plaintext markdown to a stripped plain-text document.
 * Synchronous and pure — no renderers, no IO. Never throws on note
 * content. Output uses `\n` line endings and ends without a trailing
 * newline (the caller adds one if it wants a POSIX text file).
 */
export function emitNoteText(plaintext: string): string {
  const fm = locateFrontmatter(plaintext);
  const src = fm === null ? plaintext : plaintext.slice(fm.blockEnd);

  const tree = parser.parse(src);
  const ctx: Ctx = { src, refs: collectRefs(src, tree.topNode) };

  const blocks = renderBlockChildren(ctx, tree.topNode);
  // Block separation: one blank line between top-level blocks. Trailing /
  // leading blank lines are trimmed so a frontmatter-only or empty note
  // projects to "".
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

// === Reference link table ==================================================

interface Ctx {
  readonly src: string;
  /** CommonMark-folded label → URL (unused for text but resolves whether a
   *  reference link's display text should survive — it always does, since
   *  text projects the link TEXT regardless of resolution). */
  readonly refs: ReadonlyMap<string, string>;
}

function childText(src: string, node: SyntaxNode, name: string): string | null {
  const child = node.getChild(name);
  return child === null ? null : src.slice(child.from, child.to);
}

function collectRefs(src: string, top: SyntaxNode): Map<string, string> {
  const refs = new Map<string, string>();
  top.cursor().iterate((node) => {
    if (node.name === "LinkReference") {
      const label = childText(src, node.node, "LinkLabel");
      const url = childText(src, node.node, "URL");
      if (label !== null && url !== null) {
        const folded = foldLabel(label);
        if (folded !== "" && !refs.has(folded)) refs.set(folded, url.trim());
      }
      return false;
    }
    return undefined;
  });
  return refs;
}

// === Blocks ================================================================

function slice(ctx: Ctx, node: SyntaxNode): string {
  return ctx.src.slice(node.from, node.to);
}

/** Syntax-mark node (never emitted): `…Mark` / `…Marker` families. */
function isMarkName(name: string): boolean {
  return name.endsWith("Mark") || name.endsWith("Marker");
}

function renderBlockChildren(ctx: Ctx, parent: SyntaxNode): string[] {
  const parts: string[] = [];
  for (
    let child = parent.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (isMarkName(child.name)) continue;
    const text = renderBlockNode(ctx, child);
    if (text !== "") parts.push(text);
  }
  return parts;
}

function renderBlockNode(ctx: Ctx, node: SyntaxNode): string {
  switch (node.name) {
    case "Paragraph":
      return renderInline(ctx, node, node.from, node.to).trim();
    case "ATXHeading1":
    case "ATXHeading2":
    case "ATXHeading3":
    case "ATXHeading4":
    case "ATXHeading5":
    case "ATXHeading6":
      return renderHeading(ctx, node, "atx");
    case "SetextHeading1":
    case "SetextHeading2":
      return renderHeading(ctx, node, "setext");
    case "Blockquote":
      return renderBlockChildren(ctx, node).join("\n\n");
    case "BulletList":
    case "OrderedList":
      return renderList(ctx, node);
    case "FencedCode":
      return renderFencedCode(ctx, node);
    case "CodeBlock":
      return renderIndentedCode(ctx, node);
    case "Table":
      return renderTable(ctx, node);
    case "HorizontalRule":
      return "";
    case "DefinitionList":
      return renderDefinitionList(ctx, node);
    case "CommentBlock":
    case "ProcessingInstructionBlock":
      return ""; // invisible content — dropped (HTML/PDF parity)
    case "DialectCommentBlock":
      return ""; // `%%…%%` comment stripped on lossy projection (MYND-315, §6)
    case "HTMLBlock":
      // Raw HTML has no faithful plain-text projection; drop it.
      return "";
    case "LinkReference":
      return ""; // resolved definitions never render (CommonMark)
    case "FootnoteDefinition":
    case "FootnoteLabel":
      return ""; // footnote machinery — dropped from plain text
    case "Task":
      return renderInline(ctx, node, node.from, node.to).trim();
    default:
      return slice(ctx, node).trim();
  }
}

function renderHeading(
  ctx: Ctx,
  node: SyntaxNode,
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
  return renderInline(ctx, node, from, to).trim();
}

function renderList(ctx: Ctx, node: SyntaxNode): string {
  const lines: string[] = [];
  for (const item of node.getChildren("ListItem")) {
    lines.push(renderListItem(ctx, item));
  }
  return lines.join("\n");
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
    const text = renderInline(ctx, task, contentFrom, task.to).trim();
    const glyph = checked ? "[x]" : "[ ]";
    const rest = blocks
      .slice(1)
      .map((b) => renderBlockNode(ctx, b))
      .filter((s) => s !== "");
    return [`- ${glyph} ${text}`, ...rest].join("\n");
  }

  const parts: string[] = [];
  let leading = true;
  for (const b of blocks) {
    const text = renderBlockNode(ctx, b);
    if (text === "") continue;
    // First paragraph of the item gets the bullet prefix; trailing blocks
    // (nested lists, extra paragraphs) follow on their own lines.
    parts.push(leading ? `- ${text}` : text);
    leading = false;
  }
  return parts.join("\n");
}

function renderFencedCode(ctx: Ctx, node: SyntaxNode): string {
  const code = childText(ctx.src, node, "CodeText");
  return code ?? "";
}

function renderIndentedCode(ctx: Ctx, node: SyntaxNode): string {
  const lines = node
    .getChildren("CodeText")
    .map((c) => ctx.src.slice(c.from, c.to));
  return lines.length > 0 ? lines.join("\n") : slice(ctx, node);
}

function renderTable(ctx: Ctx, node: SyntaxNode): string {
  const rowText = (row: SyntaxNode): string =>
    row
      .getChildren("TableCell")
      .map((cell) => renderInline(ctx, cell, cell.from, cell.to).trim())
      .join("\t");
  const rows: string[] = [];
  const header = node.getChild("TableHeader");
  if (header !== null) rows.push(rowText(header));
  for (const r of node.getChildren("TableRow")) rows.push(rowText(r));
  return rows.join("\n");
}

function renderDefinitionList(ctx: Ctx, node: SyntaxNode): string {
  const lines: string[] = [];
  for (let c = node.firstChild; c !== null; c = c.nextSibling) {
    if (c.name === "DefinitionTerm") {
      lines.push(renderInline(ctx, c, c.from, c.to).trim());
    } else if (c.name === "DefinitionDesc") {
      lines.push(`  ${renderInline(ctx, c, c.from, c.to).trim()}`);
    }
  }
  return lines.join("\n");
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
    if (child.from > pos) out += ctx.src.slice(pos, child.from);
    out += renderInlineNode(ctx, child);
    pos = Math.min(Math.max(pos, child.to), to);
    child = child.nextSibling;
  }
  if (pos < to) out += ctx.src.slice(pos, to);
  return out;
}

function renderInlineNode(ctx: Ctx, node: SyntaxNode): string {
  if (isMarkName(node.name)) return "";
  switch (node.name) {
    case "Emphasis":
    case "StrongEmphasis":
    case "Strikethrough":
    case "Highlight":
    case "Subscript":
    case "Superscript":
      return renderInline(ctx, node, node.from, node.to);
    case "InlineCode": {
      const marks = node.getChildren("CodeMark");
      const first = marks[0];
      const last = marks[marks.length - 1];
      const cFrom = first !== undefined ? first.to : node.from;
      const cTo = last !== undefined && last.from > cFrom ? last.from : node.to;
      return ctx.src.slice(cFrom, cTo);
    }
    case "Link":
      return renderLink(ctx, node);
    case "Image":
      return renderImage(ctx, node);
    case "Autolink":
      return childText(ctx.src, node, "URL") ?? "";
    case "URL":
      return slice(ctx, node);
    case "Wikilink":
      return renderWikilink(ctx, node);
    case "FootnoteReference":
      return ""; // superscript marker — dropped from plain text
    case "InlineMath":
      return renderInlineMath(ctx, node);
    case "InlineTag":
      return slice(ctx, node); // plain text — SYNC-17, no chip (HTML parity)
    case "DialectComment":
      return ""; // `%%…%%` comment stripped on lossy projection (MYND-315, §6)
    case "Emoji":
      return slice(ctx, node); // keep the `:shortcode:` literal — no glyph map
    case "Escape":
      return ctx.src.slice(node.from + 1, node.to);
    case "Entity":
      return slice(ctx, node);
    case "HardBreak":
      return "\n";
    case "HTMLTag":
      return ""; // inline raw HTML has no plain-text projection
    case "Task":
      return renderInline(ctx, node, node.from, node.to);
    default:
      return renderInline(ctx, node, node.from, node.to);
  }
}

function renderLink(ctx: Ctx, node: SyntaxNode): string {
  // Keep the link TEXT only; the URL is dropped (a plain-text reader has
  // no clickable affordance — Notesnook plain-text parity).
  const marks = node.getChildren("LinkMark");
  const textFrom = marks[0]?.to ?? node.from;
  const textTo = marks[1]?.from ?? node.to;
  const text = renderInline(ctx, node, textFrom, textTo);
  return text.trim() === "" ? slice(ctx, node) : text;
}

function renderImage(ctx: Ctx, node: SyntaxNode): string {
  // Markdown image → its alt text (or empty); the path is dropped.
  const marks = node.getChildren("LinkMark");
  const altFrom = marks[0]?.to ?? node.from;
  const altTo = marks[1]?.from ?? node.to;
  return ctx.src.slice(altFrom, altTo).trim();
}

function renderWikilink(ctx: Ctx, node: SyntaxNode): string {
  const firstMark = node.getChild("WikilinkMark");
  const embed = firstMark !== null && slice(ctx, firstMark).startsWith("!");
  const target = childText(ctx.src, node, "WikilinkTarget") ?? "";
  const alias = childText(ctx.src, node, "WikilinkAlias");
  const heading = childText(ctx.src, node, "WikilinkHeading");
  const blockId = childText(ctx.src, node, "WikilinkBlockId");
  // Embeds (`![[…]]`) — attachment or note — have no plain-text body; drop.
  if (embed) return "";
  // Plain wikilink → its display text (alias when present, else target).
  const display =
    alias ??
    `${target}${heading !== null ? `#${heading}` : ""}${blockId !== null ? `^${blockId}` : ""}`;
  return display;
}

function renderInlineMath(ctx: Ctx, node: SyntaxNode): string {
  // Keep the LaTeX source (between the `$` marks) — plain text can't
  // render math, but the source is readable and lossless within the span.
  const marks = node.getChildren("MathMark");
  const first = marks[0];
  const last = marks[marks.length - 1];
  const from = first !== undefined ? first.to : node.from;
  const to = last !== undefined && last.from > from ? last.from : node.to;
  return ctx.src.slice(from, to);
}
