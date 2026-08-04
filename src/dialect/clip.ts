// Clip serializer — re-emits handed-off best-effort markdown as canonical-D1
// bytes (capture-extraction sub-feature, browser-extension epic).
//
// Spec: docs/spec/markdown-dialect.md §5 (canonical emit forms). Ledger:
// SYNC-7 (a clip is AUTHORED canonical-D1, NOT a C1-preserved import) +
// SYNC-11 (canonicalization runs DESKTOP-side via a NEW @lezer/markdown-tree
// → canonical-D1 serializer in the WebView dialect layer — this module).
//
// Posture (load-bearing):
//   - SINGLE PARSE AUTHORITY. The serializer parses via the shared `parser`
//     singleton (src/dialect/lezer/parser.ts) and NEVER constructs a second
//     @lezer/markdown instance. Spied on by tests.
//   - AUTHORED, not preserved. Unlike the C1 import path (§6), a clip may
//     renormalize bytes (canonical delimiters, collapsed whitespace) as long
//     as the emit re-parses to a structurally-identical tree. That round-trip
//     invariant — `emit → parser.parse(emit) → same tree shape` — is the
//     checkable definition of "canonical D1" (story 18). The two NORMALIZE
//     constructs below (Setext→ATX, reference-link→inline) re-parse to the
//     shape of their canonical EQUIVALENT (ATX / inline-link), not the source.
//   - PURE: the input string is never mutated; the function returns derived
//     bytes. NEVER throws except on no/empty input. NEVER fetches. NEVER
//     touches the graph or resolves `[[wikilinks]]` (that is desktop-ingest,
//     sub-feature 3 — SYNC-11).
//   - IDEMPOTENT: `serialize(serialize(x)) === serialize(x)` — a second pass is
//     a fixed point (modeled on src/editor/decorations/table-model.ts).
//
// The tree-walk scaffold mirrors src/dialect/html/emitNoteHtml.ts (block
// dispatch + inline dispatch) but emits markdown instead of HTML. Construct
// coverage grows as localized arms in `renderBlockNode` / `renderInlineNode` —
// never a rewrite of the walk:
//   - task 1: Paragraph + plain inline text
//   - task 2: headings (ATX + Setext→ATX) · bullet/ordered/nested lists · HR ·
//     emphasis family (`*`/`**`/`~~`) · inline + reference links (this slice)
//   - task 3: Table · task 4: FencedCode/CodeBlock · task 5: block math
//   - task 6: callouts/tasks/footnotes/highlights
//   - task 7: SAFE-DEGRADE + DROP (the never-broken-markdown guarantee). The
//     default/fallthrough arms are a deliberate, tested safety net: an
//     un-representable construct degrades to valid text / a fenced block (never
//     broken markdown), and the no-emit-form constructs are dropped, not
//     emitted — sub/superscript drop the markup but KEEP their wrapped text;
//     emoji + `%%comments%%` (inline + block) FULL-DROP (§6 lossy-strip);
//     definition lists degrade to plain-text lines (§3.1/§3.2/§5).

import type { SyntaxNode } from "@lezer/common";
import { parser } from "./lezer/parser";
import { foldLabel } from "@myne/editor/decorations/link-reference-collector";
import { CALLOUT_HEADER_RE, CALLOUT_HTML_TYPES } from "./html/callout-types";
import { HIGHLIGHT_CLASSES } from "@myne/editor/html/sanitize";
import {
  fitRow,
  parseDelimiterAlign,
  serializeTable,
  splitTableRow,
  type TableGrid,
} from "@myne/editor/decorations/table-model";
import {
  escapeLinkTitle,
  formatLinkDestination,
  normalizeParagraphWhitespace,
} from "./clip/escape";
import {
  type BlockMathRange,
  collectCodeRanges,
  emitBlockMath,
  emitInlineMath,
  findBlockMath,
  standaloneBlockMath,
} from "./clip/math";

// === Image reference seam contract (task 9 — SYNC-10 / SYNC-14) ============
//
// The desktop ingest seam this serializer emits FOR (consumed by sub-feature 3,
// currently Rust-blocked). The contract, in one place:
//
//   Each embedded image in the walked body emits a canonical markdown image
//   reference `![<alt>](clip-image:<N>)`, where <N> is the image's 0-based
//   DOCUMENT-ORDER index. The image BYTES ride the handoff envelope's
//   positional `image_bytes[]` array (SYNC-10, owned by sub-feature 1), captured
//   in-page in the SAME document order. So `clip-image:N` correlates 1:1 to
//   `image_bytes[N]` — ingest recovers N (parseClipImageRef), looks up the
//   bytes, calls `attachment_import{Bytes}`, and rewrites the ref IN PLACE to a
//   form-C embed `![[att:<id>|filename]]` (SYNC-14). Degrade-on-oversize /
//   non-image is importer-parity, ALSO sub-feature 3's job.
//
// WHY POSITIONAL INDEX, NOT URL. `image_bytes` is a `Vec<Vec<u8>>` (positional;
// `src-tauri/src/clipper/envelope.rs`), and the in-page capturer pushes bytes in
// body document order. A URL key is NOT robust: a data-URI has no stable short
// key (and would bloat the canonical body with its base64 payload), a
// relative/duplicate URL collides (two `<img src="dup.png">` would map to one
// bytes entry), and the source `src` may be a blob:/object URL that means
// nothing post-capture. The position is the ONLY stable 1:1 key into the
// positional bytes array — so the seam is index-keyed.
//
// CROSS-FEATURE NOTE. The `clip-image:` scheme is the contract sub-feature 3's
// rewrite and the extension's capturer (sub-feature 1) must agree on: the
// capturer's image enumeration order MUST match this serializer's
// document-order walk so index N lines up with `image_bytes[N]`. Today the
// extension's foundational `capture.ts` emits NO images (`image_bytes` rides
// empty), so this serializer is the FIRST definition of the reference shape;
// landing the image-capturing extension path (sub-feature 1/3) carries the
// matching emit + rewrite. This module emits ONLY the reference — it never
// imports an attachment, fetches bytes, or assigns an `att:<id>`.

/**
 * The URL scheme that marks a markdown image reference as a clip-captured image
 * correlated to the handoff envelope's positional `image_bytes[]`. The numeric
 * suffix is the image's 0-based document-order index. See the contract block
 * above; consumed by sub-feature 3's desktop ingest.
 */
export const CLIP_IMAGE_SCHEME = "clip-image:";

/** A `clip-image:N` reference URL must be the scheme + a canonical base-10
 *  non-negative integer (no leading `+`/`-`, no leading zeros beyond `0`). */
const CLIP_IMAGE_INDEX_RE = /^(?:0|[1-9]\d*)$/;

/**
 * Build the seam reference URL for an image at document-order index `index`
 * (`![alt](clip-image:<index>)`). The single emitter of the scheme — the Image
 * arm and any future producer call this rather than string-building the prefix.
 */
export function clipImageRef(index: number): string {
  return `${CLIP_IMAGE_SCHEME}${index}`;
}

/**
 * Recover the positional index from a `clip-image:N` reference URL, or `null`
 * when `url` is not a well-formed clip-image ref (any other scheme, an empty or
 * non-canonical-integer suffix). The recogniser sub-feature 3's ingest uses to
 * match a ref back to its `image_bytes[]` entry — and the serializer itself
 * uses so an already-canonical ref survives a second pass unchanged.
 */
export function parseClipImageRef(url: string): number | null {
  if (!url.startsWith(CLIP_IMAGE_SCHEME)) return null;
  const suffix = url.slice(CLIP_IMAGE_SCHEME.length);
  return CLIP_IMAGE_INDEX_RE.test(suffix) ? Number(suffix) : null;
}

// === Public API ============================================================

/**
 * Re-emit handed-off best-effort markdown as canonical-D1 bytes.
 *
 * Throws on no/empty input (a clip with no extractable content is surfaced as a
 * structured no-content outcome upstream — task 10 — not fabricated into an
 * empty note here). Otherwise pure, total, and fetch-free.
 *
 * @param markdown the best-effort markdown handed off by the extension
 * @returns canonical-D1 markdown
 */
export function serializeClipMarkdown(markdown: string): string {
  if (markdown.length === 0) {
    throw new Error("serializeClipMarkdown: empty input");
  }
  if (markdown.trim().length === 0) {
    throw new Error("serializeClipMarkdown: no extractable content");
  }

  const tree = parser.parse(markdown);
  // Block `$$…$$` is a decoration range, not a parser node (math.ts), so it is
  // scanned out-of-band the way emitNoteHtml.ts does: code ranges first (a `$$`
  // inside a fence/span is content), then `findBlockMath` over the source.
  const codeRanges = collectCodeRanges(tree.topNode);
  const ctx: Ctx = {
    src: markdown,
    refs: collectLinkReferences(markdown, tree.topNode),
    blockMath: findBlockMath(markdown, codeRanges),
    blockMathEmitted: new Set(),
    imageIndex: { next: 0 },
  };
  return renderBlockChildren(ctx, tree.topNode);
}

// === Emit context ==========================================================

// Per-construct emit state rides here, growing exactly like emitNoteHtml.ts's
// `Ctx`. Task 2 adds `refs`: the folded `[ref]: url` definition table the
// reference-link→inline normalization resolves against. Later slices extend it
// (e.g. footnote numbering).
interface Ctx {
  readonly src: string;
  /** CommonMark-folded `[ref]: url` label → URL (first definition wins). */
  readonly refs: ReadonlyMap<string, string>;
  /** `$$…$$` block-math ranges (a decoration, not a node), code zones excluded. */
  readonly blockMath: readonly BlockMathRange[];
  /** Indices of block-math ranges already emitted, so a range is emitted once. */
  readonly blockMathEmitted: Set<number>;
  /** Document-order image counter — `next` is the index the NEXT `Image` arm
   *  reached by the walk claims, then increments. The walk visits images in
   *  block-then-inline (document) order, so the assigned indices correlate 1:1
   *  to the positional `image_bytes[]` the extension captures (task 9 seam). */
  readonly imageIndex: { next: number };
}

function slice(ctx: Ctx, node: SyntaxNode): string {
  return ctx.src.slice(node.from, node.to);
}

/** Syntax-mark node (never emitted as a block): `…Mark` / `…Marker` families. */
function isMarkName(name: string): boolean {
  return name.endsWith("Mark") || name.endsWith("Marker");
}

function childText(ctx: Ctx, node: SyntaxNode, name: string): string | null {
  const child = node.getChild(name);
  return child === null ? null : ctx.src.slice(child.from, child.to);
}

// === Scan pass: link reference definitions =================================

/**
 * Walk the document for `LinkReference` (`[ref]: url`) definition nodes and
 * build a `foldedLabel → URL` map (first definition wins, CommonMark rule),
 * mirroring emitNoteHtml.ts's `refs` scan. The reference-link→inline
 * normalization resolves usages against this table; an unresolved (dangling)
 * usage is left as literal text. The definition nodes themselves are never
 * emitted (they collapse into the inline link).
 */
function collectLinkReferences(
  src: string,
  top: SyntaxNode,
): ReadonlyMap<string, string> {
  const refs = new Map<string, string>();
  top.cursor().iterate((node) => {
    if (node.name !== "LinkReference") return undefined;
    const labelNode = node.node.getChild("LinkLabel");
    const urlNode = node.node.getChild("URL");
    if (labelNode !== null && urlNode !== null) {
      const folded = foldLabel(src.slice(labelNode.from, labelNode.to));
      const url = src.slice(urlNode.from, urlNode.to).trim();
      if (folded !== "" && !refs.has(folded)) refs.set(folded, url);
    }
    return false;
  });
  return refs;
}

// === Blocks ================================================================

/**
 * Walk a parent's block children, emit each, and join with canonical blank-line
 * separation (one empty line between blocks). The block-level dispatch entry —
 * `Document` children today, list-item bodies via `renderListItem`. Empty emits
 * are dropped so the join never produces a stray blank run.
 *
 * A run of adjacent same-canonical-kind lists is COALESCED into one canonical
 * list (single-newline-joined, with ordered numbering continuous across the
 * run): the parser splits a `* a` / `+ b` run — or a `1. a` / `1) b` run — into
 * two list blocks (the CommonMark marker-change rule), but both normalize to the
 * SAME canonical marker, so the authored emit is the one tight canonical list
 * they become. Emitting a blank line between them (or restarting the ordinal)
 * would re-parse to a different shape and break idempotency on the second pass.
 */
function renderBlockChildren(ctx: Ctx, parent: SyntaxNode): string {
  const blocks: SyntaxNode[] = [];
  for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
    if (!isMarkName(child.name)) blocks.push(child);
  }

  const parts: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    // Block `$$…$$` math: a block that IS a `$$…$$` range (modulo whitespace)
    // is replaced by the canonical multi-line block, emitted once per range —
    // mirroring how emitNoteHtml.ts threads `findBlockMath` into its walk. A
    // block that merely CONTAINS a `$$` alongside prose is left to the normal
    // path (the `$$` survives as literal bytes since it is not a parser node).
    const mathRange = standaloneBlockMath(ctx.src, block, ctx.blockMath);
    if (mathRange !== null) {
      const idx = ctx.blockMath.indexOf(mathRange);
      if (!ctx.blockMathEmitted.has(idx)) {
        ctx.blockMathEmitted.add(idx);
        parts.push(emitBlockMath(mathRange));
      }
      continue;
    }
    if (block.name === "BulletList" || block.name === "OrderedList") {
      // Coalesce the maximal run of same-kind lists into one canonical list.
      const ordered = block.name === "OrderedList";
      const lines: string[] = [];
      let ordinal = 0;
      let j = i;
      for (; j < blocks.length && blocks[j]!.name === block.name; j++) {
        ordinal = appendListItems(ctx, blocks[j]!, ordered, 0, ordinal, lines);
      }
      i = j - 1;
      parts.push(lines.join("\n"));
      continue;
    }
    const md = renderBlockNode(ctx, block);
    if (md !== "") parts.push(md);
  }
  return parts.join("\n\n");
}

/**
 * Emit one block node. Constructs with no Myne emit form are handled by task-7
 * arms (`DialectCommentBlock` → drop; `DefinitionList` → plain-text degrade);
 * any other not-yet-handled block falls to the default arm — the deliberate
 * safe-degrade net — which degrades to the paragraph emit (valid markdown,
 * round-trip-safe, never thrown on).
 */
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
      // Setext underline recognized-on-parse → NORMALIZED to ATX on emit (a
      // clip is AUTHORED content, not a C1-bound import — §5 "Setext is
      // recognized on parse but never emitted").
      return renderHeading(ctx, node, 1, "setext");
    case "SetextHeading2":
      return renderHeading(ctx, node, 2, "setext");
    case "BulletList":
    case "OrderedList":
      // Top-level lists are emitted by renderBlockChildren (it coalesces a run
      // of same-kind lists). A list reached HERE is nested inside another block
      // (e.g. a degenerate degrade), so emit it standalone.
      return renderList(ctx, node, node.name === "OrderedList", 0);
    case "HorizontalRule":
      return "---"; // §5 canonical (normalizes `***` / `___`)
    case "LinkReference":
      // A resolved `[ref]: url` definition collapses into its inline link (the
      // reference-link→inline normalization); the definition line is dropped.
      return "";
    case "Table":
      return renderTable(ctx, node);
    case "FencedCode":
      return renderFencedCode(ctx, node);
    case "CodeBlock":
      // Indented code is recognized on parse but NEVER emitted (§5) — a clip is
      // authored content, so it normalizes to the canonical fenced form.
      return renderIndentedCode(ctx, node);
    // --- task 5: block `$$…$$` math is NOT a node — it is consumed at the
    //     block-walk level in renderBlockChildren (a decoration range, detected
    //     via findBlockMath); there is no block-math case here.
    // --- task 6: Blockquote (callouts), Task (task lists), FootnoteDefinition
    case "Blockquote":
      return renderBlockquote(ctx, node);
    case "FootnoteDefinition":
      return renderFootnoteDefinition(ctx, node);
    // --- task 7: DROP / safe-degrade constructs with no Myne emit form.
    case "DialectCommentBlock":
      // Block / multi-line `%%…%%` comment: same §6 lossy-projection strip as
      // the inline form — FULL-DROPPED (content + markup). renderBlockChildren
      // drops empty emits, so the comment leaves no stray blank line. An
      // UNTERMINATED block `%%` never reaches here (the parser reverts it to a
      // Paragraph, §6 inert rule), so its bytes survive via the Paragraph arm.
      return "";
    case "DefinitionList":
      // Pandoc definition list (`Term` / `: Def`): §3.1 marks it never-emitted
      // (no authoring affordance produces one), but the term + definition TEXT
      // is meaningful content. Safe-degrade to plain text lines, DROPPING the
      // `:` markers — never a broken half-list. Re-parses to a clean Paragraph.
      return renderDefinitionList(ctx, node);
    default:
      // Safe-degrade safety net (deliberate, not accidental): an unknown /
      // not-yet-handled block degrades to a paragraph of its inline text —
      // valid markdown, round-trip-safe, never thrown on. A block whose raw
      // content cannot be modeled as prose still emits inert text here rather
      // than broken markup; a future slice replaces this with a real arm.
      return renderParagraph(ctx, node);
  }
}

/**
 * Safe-degrade a `DefinitionList` (no Myne emit form, §3.1) to plain text. The
 * term and each definition's text are kept as readable prose (so no content is
 * lost), but the leading `:` markers are DROPPED — a `: Definition` line would
 * otherwise re-parse as a definition marker and resurrect the list. Inline
 * content inside the term / definitions re-canonicalizes through the inline
 * walk. The lines are joined into a single normalized paragraph so the emit
 * re-parses to a clean `Paragraph`, never a broken or re-recognized list.
 */
function renderDefinitionList(ctx: Ctx, node: SyntaxNode): string {
  const parts: string[] = [];
  for (let c = node.firstChild; c !== null; c = c.nextSibling) {
    if (c.name === "DefinitionTerm" || c.name === "DefinitionDesc") {
      const text = normalizeParagraphWhitespace(
        renderInline(ctx, c, c.from, c.to),
      );
      if (text !== "") parts.push(text);
    }
    // DefinitionMarker (`:`) is dropped — it carries no content.
  }
  return parts.join(" ");
}

function renderParagraph(ctx: Ctx, node: SyntaxNode): string {
  const inner = renderInline(ctx, node, node.from, node.to);
  return normalizeParagraphWhitespace(inner);
}

/**
 * Emit a heading as canonical ATX (`# `…`###### `). An ATX source is stripped
 * of its opening `#…` mark and any optional closing `#…` run; a Setext source
 * (underline `===` / `---`) is NORMALIZED to the same ATX form — the content
 * window ends at the underline `HeaderMark`. Mirrors emitNoteHtml.ts's
 * `renderHeading` content-window extraction, emitting markdown.
 */
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
    // Setext: the single HeaderMark is the underline; content precedes it.
    const underline = marks[0];
    if (underline !== undefined) to = underline.from;
  }
  while (from < to && /\s/u.test(ctx.src[from]!)) from++;
  while (to > from && /\s/u.test(ctx.src[to - 1]!)) to--;
  // Heading content collapses internal whitespace (an authored single line).
  const inner = normalizeParagraphWhitespace(renderInline(ctx, node, from, to));
  return `${"#".repeat(level)} ${inner}`;
}

/**
 * Emit a `Blockquote` as canonical `> `-prefixed lines. A blockquote whose
 * first source line standardizes to a `[!type]` callout header (recognized via
 * the shared `CALLOUT_HEADER_RE` / `CALLOUT_HTML_TYPES` the HTML emitter uses)
 * emits the canonical callout header line `> [!type] <title>` (lower-cased type,
 * §5) followed by the canonical-rendered body; an unrecognized type or a plain
 * blockquote emits the body with no header. Each body block is rendered through
 * the normal block walk and then `> `-prefixed line-by-line, so nested
 * constructs re-canonicalize and the emit re-parses to a `Blockquote` of the
 * same callout-ness. Blank separator lines inside the quote become bare `>`.
 */
function renderBlockquote(ctx: Ctx, node: SyntaxNode): string {
  const lineEnd = ctx.src.indexOf("\n", node.from);
  const firstLineEnd = lineEnd === -1 || lineEnd > node.to ? node.to : lineEnd;
  const header = CALLOUT_HEADER_RE.exec(ctx.src.slice(node.from, firstLineEnd));

  let headerLine: string | null = null;
  let clipFrom: number | null = null;
  if (header !== null) {
    const type = header[2]!.toLowerCase();
    if (CALLOUT_HTML_TYPES[type] !== undefined) {
      const title = header[4]!.trim();
      headerLine = title === "" ? `[!${type}]` : `[!${type}] ${title}`;
      clipFrom = firstLineEnd + 1;
    }
  }

  const body = renderBlockquoteBody(ctx, node, clipFrom);
  const bodyLines = body === "" ? [] : body.split("\n");
  const lines = headerLine !== null ? [headerLine, ...bodyLines] : bodyLines;
  if (lines.length === 0) return ">";
  return lines.map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
}

/**
 * Render a blockquote's body block children, optionally clipping the first
 * paragraph to start at `clipFrom` (past a callout header line). Mirrors
 * emitNoteHtml.ts's `clipFirstParagraphFrom` handling, emitting markdown.
 */
function renderBlockquoteBody(
  ctx: Ctx,
  node: SyntaxNode,
  clipFrom: number | null,
): string {
  const parts: string[] = [];
  let clipPending = clipFrom;
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (isMarkName(child.name)) continue;
    if (child.name === "Paragraph") {
      let from = child.from;
      if (clipPending !== null) {
        if (child.from < clipPending) from = clipPending;
        clipPending = null;
      }
      if (from < child.to) {
        const inner = renderBlockquoteParagraph(ctx, child, from);
        if (inner !== "") parts.push(inner);
      }
      continue;
    }
    if (clipPending !== null) clipPending = null;
    const md = renderBlockNode(ctx, child);
    if (md !== "") parts.push(md);
  }
  return parts.join("\n\n");
}

/**
 * Render a paragraph INSIDE a blockquote over `[from, paragraph.to)`, preserving
 * its source line breaks as separate lines (the caller `> `-prefixes each). A
 * `> a\n> b` quote parses to ONE paragraph spanning two quoted lines (the second
 * `>` is an interior `QuoteMark` the inline walk drops); collapsing it to a
 * single line would lose that interior mark and change the tree shape, so each
 * source line is rendered + whitespace-collapsed independently and re-joined
 * with `\n`, reproducing the per-line `> ` structure on re-parse.
 */
function renderBlockquoteParagraph(
  ctx: Ctx,
  para: SyntaxNode,
  from: number,
): string {
  const lines: string[] = [];
  let lineStart = from;
  while (lineStart < para.to) {
    let nl = ctx.src.indexOf("\n", lineStart);
    if (nl === -1 || nl > para.to) nl = para.to;
    const line = normalizeParagraphWhitespace(
      renderInline(ctx, para, lineStart, nl),
    );
    if (line !== "") lines.push(line);
    lineStart = nl + 1;
  }
  return lines.join("\n");
}

/**
 * Emit a `FootnoteDefinition` (`[^id]: body`) canonically: the `[^id]: ` marker
 * followed by its rendered nested block body. The label rides verbatim (any
 * non-whitespace id is legal, §3.4); a multi-block body (the composite node's
 * nested content) is rendered through the block walk and joined under the
 * marker. Continuation lines of the lead paragraph hang at the definition's
 * canonical indent so the emit re-parses to the same `FootnoteDefinition`.
 */
function renderFootnoteDefinition(ctx: Ctx, node: SyntaxNode): string {
  const label = childText(ctx, node, "FootnoteLabel") ?? "";
  const blocks: SyntaxNode[] = [];
  for (let c = node.firstChild; c !== null; c = c.nextSibling) {
    if (!isMarkName(c.name) && c.name !== "FootnoteLabel") blocks.push(c);
  }
  const rendered = blocks
    .map((b) => renderBlockNode(ctx, b))
    .filter((s) => s !== "");
  if (rendered.length === 0) return `[^${label}]:`;
  // The first block opens on the marker line; every CONTINUATION line is
  // indented `FOOTNOTE_CONT_INDENT` (4) columns so the body stays inside the
  // composite `FootnoteDefinition` on re-parse (the Pandoc/GitHub continuation
  // rule the footnote config enforces) — without it a 2nd block escapes the
  // footnote and the round-trip shape breaks.
  const body = rendered.join("\n\n");
  const [first, ...rest] = body.split("\n");
  const indented = [first, ...rest.map((l) => (l === "" ? "" : `${FOOTNOTE_CONT_INDENT}${l}`))];
  return `[^${label}]: ${indented.join("\n")}`;
}

/** The 4-column continuation indent a multi-block footnote body hangs at (the
 *  Pandoc/GitHub rule the `Footnote` config's composite continuation enforces;
 *  mirrors `src/dialect/lezer/footnote.ts::FOOTNOTE_CONT_INDENT`). */
const FOOTNOTE_CONT_INDENT = "    ";

/**
 * Emit a GFM `Table` node as a faithful canonical pipe table — header row, an
 * alignment/delimiter row derived from the parsed per-column alignments, then
 * body rows — REUSING the canonical single-space-padded serialization the
 * editable-table feature pins (`src/editor/decorations/table-model.ts`). This
 * is the SAME helper chain `buildTableModel` (table.ts) drives, so the clip
 * serializer and the editor emit byte-identical canonical tables; the only
 * difference is we slice row text off `ctx.src` (a plain string) rather than an
 * `EditorState`. Columns, rows, per-column alignment, and pipe-escaping all
 * survive the round-trip; the emit is single-space padded, never re-padded to
 * content width.
 *
 * The bridge mirrors the parser's own row decomposition: the column count is
 * canonically the direct-child delimiter row's; the header and body rows are
 * `fitRow`-fit to it (extra cells dropped, missing cells empty). A `TableCell`'s
 * inline content (emphasis, links) is re-canonicalized through the inline walk,
 * then `serializeTable`'s `escapeCell` re-escapes any literal `|` so the emitted
 * table re-parses to the same column structure. A defensive fall-through to the
 * raw source slice covers a `Table` missing its header/delimiter child (the
 * parser only emits `Table` when both exist, so this should not happen).
 */
function renderTable(ctx: Ctx, node: SyntaxNode): string {
  let headerSrc: string | null = null;
  let delimiterSrc: string | null = null;
  const bodySrcs: string[] = [];

  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "TableHeader") {
      headerSrc = renderRowCells(ctx, child);
    } else if (child.name === "TableDelimiter") {
      // The whole separator row is the single direct-child `TableDelimiter`
      // node (per-pipe delimiters live nested inside TableHeader/TableRow).
      delimiterSrc = slice(ctx, child);
    } else if (child.name === "TableRow") {
      bodySrcs.push(renderRowCells(ctx, child));
    }
  }

  if (headerSrc === null || delimiterSrc === null) {
    return slice(ctx, node); // defensive: malformed table → verbatim source
  }

  const align = parseDelimiterAlign(delimiterSrc);
  const columns = align.length;
  const grid: TableGrid = {
    align,
    rows: [
      fitRow(splitTableRow(headerSrc), columns),
      ...bodySrcs.map((src) => fitRow(splitTableRow(src), columns)),
    ],
  };
  return serializeTable(grid);
}

/**
 * Reconstruct one table row as a `splitTableRow`-parseable pipe line, with each
 * `TableCell`'s inline content re-canonicalized through the inline walk (so
 * `_a_` / `__b__` inside a cell emit as `*a*` / `**b**`, links go inline, etc.).
 *
 * The inline walk preserves any source `\|` escape verbatim (the `Escape` node
 * slices through unchanged), so the reconstructed line is exactly the shape
 * `splitTableRow` expects: it splits on UN-escaped pipes and unescapes `\|` →
 * `|` to display form, and `serializeTable`'s `escapeCell` then re-escapes on
 * emit. Escaping therefore round-trips through the canonical helpers — this fn
 * never hand-escapes, so a source `\|` is never double-escaped.
 */
function renderRowCells(ctx: Ctx, row: SyntaxNode): string {
  const cells: string[] = [];
  for (const cell of row.getChildren("TableCell")) {
    cells.push(renderInline(ctx, cell, cell.from, cell.to).trim());
  }
  return `| ${cells.join(" | ")} |`;
}

/**
 * Emit a bullet (`- `) or ordered (`1. `) list at nesting `depth` as a single
 * string. Canonical marker, 2-space-per-level indent, ordered items renumbered
 * 1.,2.,… — items joined by single newlines (a tight authored list). Used for a
 * nested list (where numbering always restarts at 1); a top-level run is
 * emitted by `renderBlockChildren` via `appendListItems` (continuous numbering).
 */
function renderList(
  ctx: Ctx,
  node: SyntaxNode,
  ordered: boolean,
  depth: number,
): string {
  const lines: string[] = [];
  appendListItems(ctx, node, ordered, depth, 0, lines);
  return lines.join("\n");
}

/**
 * Append a list node's items to `lines`, indented for `depth`, numbering ordered
 * items continuously from `startOrdinal`. Returns the next ordinal so a caller
 * coalescing a run of same-kind sibling lists keeps the numbering continuous
 * (the authored single-list result). A nested list re-enters at `depth + 1`.
 */
function appendListItems(
  ctx: Ctx,
  node: SyntaxNode,
  ordered: boolean,
  depth: number,
  startOrdinal: number,
  lines: string[],
): number {
  const indent = "  ".repeat(depth);
  let ordinal = startOrdinal;
  for (const item of node.getChildren("ListItem")) {
    ordinal++;
    const marker = ordered ? `${ordinal}. ` : "- ";
    lines.push(renderListItem(ctx, item, marker, indent, depth));
  }
  return ordinal;
}

/**
 * Emit one list item: `<indent><marker><content>`, with nested lists rendered
 * one level deeper on their own lines. The item's own paragraph(s) are emitted
 * inline-joined to the marker; non-list child blocks degrade through
 * `renderBlockNode` (valid markdown). Continuation lines of the lead content
 * are hung under the marker's text column (canonical indentation).
 */
function renderListItem(
  ctx: Ctx,
  item: SyntaxNode,
  marker: string,
  indent: string,
  depth: number,
): string {
  const leadParts: string[] = [];
  const nestedParts: string[] = [];
  for (let c = item.firstChild; c !== null; c = c.nextSibling) {
    if (isMarkName(c.name)) continue;
    if (c.name === "BulletList") {
      nestedParts.push(renderList(ctx, c, false, depth + 1));
    } else if (c.name === "OrderedList") {
      nestedParts.push(renderList(ctx, c, true, depth + 1));
    } else if (c.name === "Task") {
      // GFM task-list item: a `Task` node wraps the `[ ]`/`[x]` checkbox and the
      // item's inline content. Emit canonical `[x]` (lowercase, §3.3 / §5) for a
      // checked marker, `[ ]` for an unchecked one, then the rendered content.
      const taskMark = c.getChild("TaskMarker");
      const checked = taskMark !== null && /x/iu.test(slice(ctx, taskMark));
      const contentFrom = taskMark !== null ? taskMark.to : c.from;
      const inner = normalizeParagraphWhitespace(
        renderInline(ctx, c, contentFrom, c.to),
      );
      leadParts.push(`${checked ? "[x]" : "[ ]"} ${inner}`.trimEnd());
    } else if (c.name === "Paragraph") {
      leadParts.push(normalizeParagraphWhitespace(renderInline(ctx, c, c.from, c.to)));
    } else {
      // Other block content inside the item (degrade to a valid emit).
      const md = renderBlockNode(ctx, c);
      if (md !== "") leadParts.push(md);
    }
  }
  const lead = leadParts.join(" ");
  let out = `${indent}${marker}${lead}`;
  for (const nested of nestedParts) {
    if (nested !== "") out += `\n${nested}`;
  }
  return out;
}

// === Code ==================================================================

/**
 * Longest run of N consecutive backtick characters anywhere in `code`. Drives
 * degrade-safe fence/delimiter selection — the emitted delimiter must be longer
 * than this so the fence cannot be closed early by a backtick run in the body.
 */
function longestBacktickRun(code: string): number {
  let max = 0;
  const matches = code.match(/`+/gu);
  if (matches !== null) {
    for (const m of matches) if (m.length > max) max = m.length;
  }
  return max;
}

/**
 * Emit a `FencedCode` node as a canonical ```-fenced block. The info string
 * (language hint, `CodeInfo`) rides VERBATIM; the code body (`CodeText`) is
 * preserved BYTE-EXACT — no escaping, no whitespace normalization (it is a code
 * zone, §3.7.5). A `~~~` source fence normalizes to ``` (the §5 canonical), and
 * the fence length is degrade-safe: one longer than the longest backtick run in
 * the body (minimum 3), so a body containing a ``` run re-parses as one block.
 * Mirrors emitNoteHtml.ts::renderFencedCode's child extraction (CodeInfo →
 * hint, CodeText → body), emitting markdown rather than HTML.
 */
function renderFencedCode(ctx: Ctx, node: SyntaxNode): string {
  const info = childText(ctx, node, "CodeInfo") ?? "";
  const code = childText(ctx, node, "CodeText") ?? "";
  return fenceCode(info, code);
}

/**
 * Emit an indented `CodeBlock` (recognized on parse, §5 "never emitted") as the
 * canonical fenced form. The de-indented body is the join of the per-line
 * `CodeText` slices (each already starts past the 4-space code indent and
 * carries its own trailing newline), so the body is byte-exact and deeper
 * indentation survives. No language hint — an indented block carries none.
 */
function renderIndentedCode(ctx: Ctx, node: SyntaxNode): string {
  const lines = node.getChildren("CodeText").map((c) => slice(ctx, c));
  const code = lines.length > 0 ? lines.join("") : slice(ctx, node);
  return fenceCode("", code);
}

/** Wrap `code` in a ```-fence with `info`, choosing a degrade-safe fence
 *  length (> the longest inner backtick run, minimum 3). */
function fenceCode(info: string, code: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(code) + 1));
  const open = info === "" ? fence : `${fence}${info}`;
  return code === "" ? `${open}\n${fence}` : `${open}\n${code}\n${fence}`;
}

// === Inline ================================================================

/**
 * Walk the inline children of `parent` over the byte window `[from, to)`,
 * interleaving plain source text (the gaps between recognized inline nodes)
 * with the emit of each inline node. Mirrors emitNoteHtml.ts::renderInline so
 * inline-construct arms slot into `renderInlineNode` without touching this
 * traversal.
 */
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
    if (child.to <= from) {
      child = child.nextSibling;
      continue;
    }
    if (child.from >= to) break;
    // A node that STARTED before this window and extends into it was already
    // emitted WHOLE by the window that contained its start — `renderInlineNode`
    // renders a node's full range, not the slice (myne#322). Its tail here is
    // therefore not ours to emit again.
    //
    // Without this, the trailing `slice(pos, to)` below re-emitted the raw
    // source of the straddling node's remainder. For a blockquote whose
    // emphasis, strong, strikethrough, link or code span crosses a line break —
    // exactly what Turndown produces for `<blockquote><em>a<br>b</em></blockquote>`
    // — the caller re-prefixes that leftover into a fabricated NESTED
    // blockquote: `> *a\n> b*` serialized to `> *a b*\n> > b*`. Both
    // invariants this module declares load-bearing fail on those inputs, and
    // the second pass diverges further still.
    if (child.from < from) {
      pos = Math.max(pos, Math.min(child.to, to));
      child = child.nextSibling;
      continue;
    }
    if (child.from < pos) {
      child = child.nextSibling;
      continue;
    }
    if (child.from > pos) out += ctx.src.slice(pos, child.from);
    out += renderInlineNode(ctx, child);
    pos = Math.min(Math.max(pos, child.to), to);
    child = child.nextSibling;
  }
  if (pos < to) out += ctx.src.slice(pos, to);
  return out;
}

/**
 * Emit one inline node. The emphasis family normalizes its delimiters to the §5
 * canonical forms (`*`/`**`/`~~`); links emit the canonical `[text](url)` inline
 * form (a reference usage resolves through `ctx.refs`); an `Image` emits the
 * canonical `![alt](clip-image:N)` seam reference (task 9 — the alt text is kept,
 * the URL is replaced by the positional `image_bytes[]` correlation index, NOT
 * the source `src`). Constructs with NO Myne
 * emit form (`Subscript`/`Superscript`/`Emoji`/`DialectComment`, §3.2 / §5) are
 * DROPPED (task 7): sub/superscript drop the markup but keep their wrapped text,
 * emoji + comments full-drop. Recognize-only nodes (`Escape`, `Entity`, …) and
 * any not-yet-handled inline node fall to the default arm — the deliberate
 * safe-degrade net — which re-emits raw source bytes (already inert in place →
 * round-trip-safe) or recurses into children. Never broken markup, never throws.
 */
function renderInlineNode(ctx: Ctx, node: SyntaxNode): string {
  if (isMarkName(node.name)) return "";
  switch (node.name) {
    case "Emphasis":
      return `*${renderInlineChildrenBetweenMarks(ctx, node)}*`;
    case "StrongEmphasis":
      return `**${renderInlineChildrenBetweenMarks(ctx, node)}**`;
    case "Strikethrough":
      return `~~${renderInlineChildrenBetweenMarks(ctx, node)}~~`;
    case "Link":
      return renderLink(ctx, node);
    case "Image":
      return renderImage(ctx, node);
    case "InlineCode":
      return renderInlineCode(ctx, node);
    case "InlineMath":
      return renderInlineMath(ctx, node);
    // --- task 6: Highlight,
    //     FootnoteReference · task 7: Subscript/Superscript/Emoji (drop)
    case "Highlight":
      // Default-color highlight → canonical `==text==` (§5). The content between
      // the `==` marks is walked inline so nested constructs re-canonicalize.
      return `==${renderInlineChildrenBetweenMarks(ctx, node)}==`;
    case "FootnoteReference":
      return renderFootnoteReference(ctx, node);
    case "HTMLTag":
      // A color highlight is the closed embedded form `<mark class="hl-*">…`;
      // the opening `<mark>` tag is canonicalized to the closed-set form (an
      // out-of-set / multi-token / missing class degrades to a bare `<mark>`,
      // never an arbitrary class). Every other HTML tag (incl. `</mark>`) rides
      // verbatim — already inert bytes, round-trip-safe.
      return renderHtmlTag(ctx, node);
    // --- task 7: DROP constructs with no Myne emit form (§3.2 / §5 mark these
    //     "recognize-and-render-only, never emitted"). The MARKUP is dropped;
    //     for sub/superscript the wrapped readable text is meaningful prose and
    //     is KEPT, so the `~`/`^` marks vanish (re-canonicalizing any nested
    //     construct) and `H~2~O` emits as `H2O`. Emoji + comments carry no
    //     emit-keepable text, so they FULL-DROP (below).
    case "Subscript":
    case "Superscript":
      return renderInlineChildrenBetweenMarks(ctx, node);
    case "Emoji":
      // `:name:` is a LEAF node — its bytes ARE the markup, there is no inner
      // text to keep. Emitting the literal `:name:` would re-parse as an Emoji
      // (preservation, not a drop), so it is FULL-DROPPED (§3.2: authoring
      // inserts the glyph directly; the shortcode is never emitted).
      return "";
    case "DialectComment":
      // Inline `%%…%%` comment: an editor-only note-to-self that §6 STRIPS from
      // every lossy projection. A clip is an authored canonical-D1 projection,
      // so the comment AND its content are FULL-DROPPED (not leaked as prose).
      // An UNTERMINATED `%%` never reaches here — the parser leaves it as plain
      // text (no node), so its bytes pass through the default text path (§6
      // inert rule), correctly.
      return "";
    default:
      // Safe-degrade safety net (deliberate, not accidental): an unknown /
      // not-yet-handled inline node emits its readable content — recurse into
      // children when it has any (so nested recognized constructs still
      // canonicalize), else its raw source bytes (already inert in place →
      // they re-parse as text). Never broken markup, never a throw.
      return node.firstChild === null
        ? slice(ctx, node)
        : renderInline(ctx, node, node.from, node.to);
  }
}

/**
 * Emit an emphasis/strikethrough node's content — the window between its first
 * and last delimiter mark — so the canonical delimiter (supplied by the caller)
 * replaces a non-canonical source delimiter (`_`/`__`). The content itself is
 * walked inline so nested constructs (bold-in-italic, a link inside bold)
 * re-canonicalize too.
 */
function renderInlineChildrenBetweenMarks(ctx: Ctx, node: SyntaxNode): string {
  const first = node.firstChild;
  const last = node.lastChild;
  const from = first !== null && isMarkName(first.name) ? first.to : node.from;
  const to = last !== null && isMarkName(last.name) ? last.from : node.to;
  return renderInline(ctx, node, from, to);
}

/**
 * Emit a link as the canonical inline form `[text](url)` (optionally with a
 * `"title"`). An inline link's URL/title come straight off the node; a
 * reference-style link (`[text][ref]`, collapsed `[text][]`, or shortcut
 * `[ref]`) is NORMALIZED to inline by resolving its label through `ctx.refs`.
 * A dangling reference (no matching definition) is left as literal source text.
 */
function renderLink(ctx: Ctx, node: SyntaxNode): string {
  const marks = node.getChildren("LinkMark");
  const textFrom = marks[0]?.to ?? node.from;
  const textTo = marks[1]?.from ?? node.to;
  const text = renderInline(ctx, node, textFrom, textTo);

  const url = childText(ctx, node, "URL");
  if (url !== null) {
    // Inline link: emit canonically, preserving a title if present.
    const rawTitle = childText(ctx, node, "LinkTitle");
    const dest = formatLinkDestination(url);
    if (rawTitle !== null && rawTitle.length >= 2) {
      // LinkTitle includes its surrounding quotes; canonicalize to `"…"`,
      // escaping any embedded quote/backslash so the title cannot close early.
      const inner = escapeLinkTitle(rawTitle.slice(1, -1));
      return `[${text}](${dest} "${inner}")`;
    }
    return `[${text}](${dest})`;
  }

  // Reference link → inline normalization. The label is the explicit
  // `[ref]`/`[]` child, or — for the shortcut form — the link text itself.
  const labelNode = node.getChild("LinkLabel");
  const rawLabel =
    labelNode !== null ? slice(ctx, labelNode) : ctx.src.slice(textFrom, textTo);
  const folded =
    foldLabel(rawLabel) === ""
      ? foldLabel(ctx.src.slice(textFrom, textTo))
      : foldLabel(rawLabel);
  const target = ctx.refs.get(folded);
  if (target === undefined) return slice(ctx, node); // dangling → literal
  return `[${text}](${formatLinkDestination(target)})`;
}

/**
 * Emit an `Image` node as the canonical seam reference `![<alt>](clip-image:N)`
 * (task 9 — the desktop-ingest attachment seam, SYNC-10 / SYNC-14). The image's
 * 0-based DOCUMENT-ORDER index N is claimed off `ctx.imageIndex` (the walk
 * reaches images in document order), so N correlates 1:1 to the positional
 * `image_bytes[]` the extension captures in the same order — sub-feature 3's
 * ingest recovers N (`parseClipImageRef`), looks up the bytes, and rewrites this
 * ref in place to a form-C `![[att:<id>|filename]]` embed.
 *
 * The ALT text is preserved (it is the ingest-side filename hint / display
 * label) and re-canonicalized through the inline walk, so nested emphasis in the
 * alt normalizes too. The source `src` (URL / data-URI / relative path) is
 * DROPPED — it is never the correlation key (the contract block at the top of
 * this module justifies index-over-URL), and dropping it keeps a data-URI's
 * base64 payload out of the canonical body (the bytes ride `image_bytes[]`).
 *
 * This emits ONLY the reference: no attachment import, no byte fetch, no
 * `att:<id>` assignment — those are sub-feature 3's job (Rust-blocked). Both the
 * inline `![alt](src)` form and the reference `![alt][ref]` form converge to the
 * same `clip-image:N` reference (a clip is authored content, §5 normalizes
 * recognized-not-emitted reference forms to inline). An already-canonical
 * `clip-image:N` ref re-parses as an `Image` and re-claims the same positional
 * index on a second pass, so the emit is round-trip-stable and idempotent.
 */
function renderImage(ctx: Ctx, node: SyntaxNode): string {
  const marks = node.getChildren("LinkMark");
  // `![` is marks[0]; the alt window ends at the `]` mark (marks[1]). Mirrors
  // emitNoteHtml.ts::renderImage's alt-window extraction.
  const altFrom = marks[0]?.to ?? node.from;
  const altTo = marks[1]?.from ?? node.to;
  const alt = renderInline(ctx, node, altFrom, altTo).trim();
  const index = ctx.imageIndex.next++;
  return `![${alt}](${clipImageRef(index)})`;
}

/**
 * Emit an `InlineCode` span in the canonical backtick form, content BYTE-EXACT
 * (a code zone — never escaped or whitespace-collapsed). The delimiter is the
 * shortest backtick run that does NOT appear inside the content (one longer than
 * the longest inner run, minimum 1); when the content contains a backtick the
 * delimiter is ≥2 and a single space pads each side (the CommonMark canonical
 * `` ` `` `` rule — the pad lets a leading/trailing or run-adjacent backtick sit
 * in the content without forging a delimiter). Mirrors emitNoteHtml.ts's
 * InlineCode mark-window extraction.
 */
function renderInlineCode(ctx: Ctx, node: SyntaxNode): string {
  const marks = node.getChildren("CodeMark");
  const first = marks[0];
  const last = marks[marks.length - 1];
  const from = first !== undefined ? first.to : node.from;
  const to = last !== undefined && last.from > from ? last.from : node.to;
  const content = stripCodeSpanPad(ctx.src.slice(from, to));
  const delim = "`".repeat(longestBacktickRun(content) + 1);
  // Pad only when the content carries a backtick (CommonMark canonical) — a
  // plain span stays the tight `code` form.
  const pad = content.includes("`") ? " " : "";
  return `${delim}${pad}${content}${pad}${delim}`;
}

/**
 * Emit an `InlineMath` (`$…$`) node as canonical-D1 inline math. The mark-to-
 * mark LaTeX rides VERBATIM (a math zone — never whitespace-collapsed or
 * escaped) when it is §3.2-tokenizer-legal as a `$content$` span, so Myne's own
 * `$`-tokenizer re-parses it to an identical `InlineMath`. Otherwise it
 * SAFE-DEGRADES to inert literal text (escaped `$`) that re-parses as text,
 * never as a mis-parseable span. The legality check + emit live in `clip/math.ts`
 * (`emitInlineMath`); this fn just extracts the mark-window. A parsed InlineMath
 * has legal endpoints by construction (the tokenizer guarantees it), so the
 * degrade is a defensive floor — correctness over cleverness.
 */
function renderInlineMath(ctx: Ctx, node: SyntaxNode): string {
  const marks = node.getChildren("MathMark");
  const first = marks[0];
  const last = marks[marks.length - 1];
  const from = first !== undefined ? first.to : node.from;
  const to = last !== undefined && last.from > from ? last.from : node.to;
  return emitInlineMath(ctx.src.slice(from, to));
}

/**
 * Emit a `FootnoteReference` (`[^id]`) canonically. The id rides verbatim from
 * the `FootnoteLabel` child (any non-whitespace string is a legal identifier,
 * §3.4); the `[^` / `]` marks are re-synthesized so the emit re-parses to the
 * same `FootnoteReference`. A malformed reference (no label) falls back to its
 * raw source bytes — already inert, round-trip-safe.
 */
function renderFootnoteReference(ctx: Ctx, node: SyntaxNode): string {
  const label = childText(ctx, node, "FootnoteLabel");
  return label === null ? slice(ctx, node) : `[^${label}]`;
}

// The closed multi-color-highlight class set (decisions.md 2026-06-15), sourced
// from the SANITIZER's `HIGHLIGHT_CLASSES` — the single closed vocabulary the
// `<mark class="hl-*">` form is constrained to (NOT re-derived or widened here).
const HL_CLASS_SET: ReadonlySet<string> = new Set(HIGHLIGHT_CLASSES);

// An opening `<mark …>` tag (not the self-closing `</mark>`). Captures the
// attribute block so the `class` can be extracted + constrained.
const MARK_OPEN_RE = /^<mark\b([^>]*)>$/iu;
// A `class="…"` / `class='…'` attribute inside the tag's attribute block.
const MARK_CLASS_RE = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/iu;

/**
 * Canonicalize an `HTMLTag` node. The only tag we rewrite is an opening
 * `<mark …>`: a color highlight carries exactly ONE token from the closed
 * `hl-*` set (the sanitizer's `HIGHLIGHT_CLASSES`, decisions.md 2026-06-15) on a
 * `<mark>` and nothing else. So we emit `<mark class="hl-X">` when the source
 * `class` is exactly one allowlisted token, and a BARE `<mark>` otherwise —
 * mirroring the sanitizer's `uponSanitizeAttribute` hook, which drops an
 * out-of-set / multi-token class and every non-`class` attribute, falling the
 * element back to the default-yellow render. We NEVER emit an arbitrary class.
 * Every other tag (including `</mark>`) is left byte-exact (inert source bytes).
 */
function renderHtmlTag(ctx: Ctx, node: SyntaxNode): string {
  const raw = slice(ctx, node);
  const open = MARK_OPEN_RE.exec(raw);
  if (open === null) return raw; // not an opening <mark …> — verbatim
  const attrs = open[1] ?? "";
  const classMatch = MARK_CLASS_RE.exec(attrs);
  const value = (classMatch?.[2] ?? classMatch?.[3] ?? "").trim();
  // Exactly one allowlisted `hl-*` token survives; anything else → bare <mark>.
  return value !== "" && HL_CLASS_SET.has(value)
    ? `<mark class="${value}">`
    : "<mark>";
}

/**
 * Strip the CommonMark code-span pad: a span whose content has exactly one
 * leading AND one trailing space (and is not entirely whitespace) drops one
 * space from each end to recover the logical content. Applied before re-padding
 * so a second serialize pass is a fixed point (idempotency) — without it the
 * pad I add on pass 1 would be re-read as content and re-padded on pass 2.
 */
function stripCodeSpanPad(content: string): string {
  if (
    content.length >= 2 &&
    content.startsWith(" ") &&
    content.endsWith(" ") &&
    content.trim() !== ""
  ) {
    return content.slice(1, -1);
  }
  return content;
}
