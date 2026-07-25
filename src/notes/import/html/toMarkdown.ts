// Importer — the DOM→markdown walker (importer-breadth epic, MYND-580).
//
// A pure walk over an ALREADY-SANITIZED, detached tree (`sanitize.ts` runs first,
// so `<script>`/`<iframe>`/`on*` cannot reach this code). Emits Myne-dialect
// markdown and names every construct it could not represent.
//
// SECOND IMPLEMENTATION, DELIBERATELY. `myne-clipper/src/content/capture.ts` is a
// dependency-free DOM→markdown walker solving the same problem in the extension's
// hostile page runtime. The grill (2026-07-25 Q3) chose NOT to extract a shared
// package — this is a second implementation, accepted as maintainability debt.
// Divergence is managed instead by the shared fixture corpus under
// `tests/notes/import/html-fixtures/`, which both implementations are pinned
// against (R1). If you change emit behaviour here, update the corpus and the
// clipper's expectations together.
//
// TABLE + LINK-DESTINATION EMIT ARE NOT REIMPLEMENTED HERE. Myne already has one
// canonical GFM table serializer (`@myne/editor/decorations/table-model`) and one
// link-destination formatter (`dialect/clip/escape`); `dialect/clip.ts` reuses both
// for markdown emit and this walker does the same, so there is exactly one
// definition of Myne's canonical table form and one of "a destination that survives
// re-parsing".
//
// LOSSY, NOT SILENT. Constructs with no dialect target are recorded in `lossy` and
// reported through the generated import-report note (MYND-585) rather than being
// dropped invisibly — the honesty rule the grill settled in Q4/Q9.

import { fitRow, serializeTable } from "@myne/editor/decorations/table-model";
import { formatLinkDestination } from "../../../dialect/clip/escape";
import { SAFE_URI_REGEXP } from "./sanitize";

export interface MarkdownResult {
  markdown: string;
  /** Sorted, de-duplicated construct names this document lost. */
  lossy: readonly string[];
}

/**
 * Inline elements that wrap their content in a fixed delimiter pair. Kept as a
 * table rather than four near-identical switch arms so the "empty inner → emit
 * nothing" rule has ONE definition instead of one per element.
 */
const WRAP: Readonly<Record<string, string>> = {
  strong: "**",
  b: "**",
  em: "*",
  i: "*",
  del: "~~",
  s: "~~",
  mark: "==",
};

/** Elements the dialect renders as embedded HTML (§8) — preserved as-is. */
const PASSTHROUGH_INLINE = new Set(["sub", "sup", "abbr", "kbd"]);

/** Inline elements: accumulated into the surrounding text run, never block-breaking. */
const INLINE = new Set([
  ...Object.keys(WRAP),
  ...PASSTHROUGH_INLINE,
  "a",
  "br",
  "code",
  "img",
  "span",
  "u",
]);

/** Transparent containers: contribute no markup of their own, just their children. */
const TRANSPARENT = new Set([
  "div", "section", "article", "main", "figure", "figcaption", "body", "html",
]);

/** Collapse whitespace runs in a text node the way HTML rendering would. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Escape characters that would otherwise be read as markdown syntax. */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, "\\$1");
}

class Walker {
  private readonly lossy = new Set<string>();

  /** Record a construct with no dialect target. */
  private lose(what: string): void {
    this.lossy.add(what);
  }

  /** Is this node part of a text run rather than a block of its own? */
  private static isInline(node: Node): boolean {
    if (node.nodeType === 3) return true; // Text
    if (node.nodeType !== 1) return false; // comments etc. contribute nothing
    return INLINE.has((node as Element).tagName.toLowerCase());
  }

  /**
   * A URL is emitted only if it is http/https/mailto/relative. The sanitizer's
   * `ALLOWED_URI_REGEXP` already drops the rest; this is the layer that REPORTS,
   * and the belt to that suspenders (a sanitizer-config regression cannot leak a
   * `javascript:` URL into note text through here).
   */
  private safeUrl(raw: string | null): string | null {
    const url = (raw ?? "").trim();
    if (url.length === 0) return null;
    // Test the form with ALL whitespace and control characters removed, not the
    // raw string: `java\nscript:alert(1)` is a scheme the raw regex would pass
    // (the newline breaks the scheme match) but that a browser reads as
    // `javascript:`. DOMPurify already strips such an attribute upstream, so this
    // is not the live control — but this layer is documented as the backstop
    // against a sanitizer-config regression, and it has to actually hold that.
    // The ORIGINAL string is what gets emitted; only the test is collapsed.
    if (!SAFE_URI_REGEXP.test(url.replace(/[\s\u0000-\u001f]/gu, ""))) {
      this.lose("unsafe-url");
      return null;
    }
    // Keep the destination re-parseable: a URL with spaces or unbalanced parens
    // would otherwise emit `[x](my file.html)`, which is not a link.
    return formatLinkDestination(url);
  }

  /** Render an element's children as one inline string. */
  private inline(node: Node): string {
    let out = "";
    for (const child of Array.from(node.childNodes)) {
      out += this.inlineNode(child);
    }
    return out;
  }

  private inlineNode(node: Node): string {
    if (node.nodeType === 3 /* Text */) {
      return escapeInline(normalizeText(node.textContent ?? ""));
    }
    if (node.nodeType !== 1 /* Element */) return "";
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    const wrap = WRAP[tag];
    if (wrap !== undefined) {
      const inner = this.inline(el).trim();
      return inner.length > 0 ? `${wrap}${inner}${wrap}` : "";
    }
    if (PASSTHROUGH_INLINE.has(tag)) {
      return `<${tag}>${this.inline(el)}</${tag}>`;
    }

    switch (tag) {
      case "br":
        return "  \n";
      case "u":
        // No underline form in the dialect (§3.2) — keep the text, name the loss.
        this.lose("underline");
        return this.inline(el);
      case "code": {
        // Inline code is verbatim: no markdown escaping inside a code span.
        const raw = el.textContent ?? "";
        return raw.length > 0 ? `\`${raw.replace(/`/g, "")}\`` : "";
      }
      case "a": {
        const href = this.safeUrl(el.getAttribute("href"));
        const text = this.inline(el).trim();
        if (href === null) return text; // link dropped, text preserved
        return text.length > 0 ? `[${text}](${href})` : `<${href}>`;
      }
      case "img": {
        const src = this.safeUrl(el.getAttribute("src"));
        if (src === null) return "";
        const alt = escapeInline(normalizeText(el.getAttribute("alt") ?? "").trim());
        return `![${alt}](${src})`;
      }
      default:
        // A block element reached in inline context: flatten to its text.
        return this.inline(el);
    }
  }

  /** Render a `<table>` through the canonical GFM serializer. */
  private table(el: Element): string {
    const grid = Array.from(el.querySelectorAll("tr")).map((tr) =>
      Array.from(tr.children)
        .filter((c) => {
          const t = c.tagName.toLowerCase();
          return t === "td" || t === "th";
        })
        // A cell cannot span lines in a pipe table, so collapse to one line here;
        // pipe-escaping is the serializer's job.
        .map((c) => normalizeText(this.inline(c)).trim()),
    );
    const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
    if (width === 0) {
      this.lose("empty-table");
      return "";
    }
    // GFM needs a header row and a delimiter line, so a table whose first row is
    // all <td> still gets one — a header-less pipe table does not parse at all.
    return serializeTable({
      align: Array.from({ length: width }, () => null),
      rows: grid.map((r) => fitRow(r, width)),
    });
  }

  /** Render a list, tracking nesting depth for indentation. */
  private list(el: Element, depth: number): string {
    const ordered = el.tagName.toLowerCase() === "ol";
    const indent = "  ".repeat(depth);
    const items = Array.from(el.children).filter(
      (c) => c.tagName.toLowerCase() === "li",
    );
    const out: string[] = [];
    items.forEach((li, i) => {
      // Split an <li> into its own inline content vs any nested list, which must
      // emit on its own lines after the item text at depth+1.
      const nested: Element[] = [];
      let own = "";
      for (const child of Array.from(li.childNodes)) {
        if (child.nodeType === 1) {
          const t = (child as Element).tagName.toLowerCase();
          if (t === "ul" || t === "ol") {
            nested.push(child as Element);
            continue;
          }
        }
        own += this.inlineNode(child);
      }
      const marker = ordered ? `${i + 1}.` : "-";
      out.push(`${indent}${marker} ${normalizeText(own).trim()}`.trimEnd());
      for (const sub of nested) out.push(this.list(sub, depth + 1));
    });
    return out.join("\n");
  }

  /** Walk a block-level element, appending emitted blocks to `blocks`. */
  private block(el: Element, blocks: string[]): void {
    const tag = el.tagName.toLowerCase();

    if (TRANSPARENT.has(tag)) {
      this.children(el, blocks);
      return;
    }

    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const inner = this.inline(el).trim();
        if (inner.length > 0) blocks.push(`${"#".repeat(Number(tag[1]))} ${inner}`);
        return;
      }
      case "p": {
        const inner = this.inline(el).trim();
        if (inner.length > 0) blocks.push(inner);
        return;
      }
      case "ul":
      case "ol": {
        const list = this.list(el, 0);
        if (list.length > 0) blocks.push(list);
        return;
      }
      case "blockquote": {
        const inner: string[] = [];
        this.children(el, inner);
        const quoted = inner
          .join("\n\n")
          .split("\n")
          .map((l) => (l.length > 0 ? `> ${l}` : ">"))
          .join("\n");
        if (quoted.trim().length > 1) blocks.push(quoted);
        return;
      }
      case "pre": {
        // Fenced code: VERBATIM. Never escaped, never whitespace-collapsed, and
        // never post-processed — a blank line inside the user's code is theirs.
        // (A `language-x` class is already gone: the sanitizer drops `class`
        // outside the highlight enum, so there is no info string to recover.)
        const raw = el.textContent ?? "";
        if (raw.trim().length > 0) {
          blocks.push(`\`\`\`\n${raw.replace(/\n+$/, "")}\n\`\`\``);
        }
        return;
      }
      case "table": {
        const t = this.table(el);
        if (t.length > 0) blocks.push(t);
        return;
      }
      case "hr":
        blocks.push("---");
        return;
      case "details":
      case "summary":
        // Natively supported embedded HTML (§8) — preserve verbatim.
        blocks.push(el.outerHTML);
        return;
      default:
        // Unknown block: keep the content, name the construct.
        this.lose(tag);
        this.children(el, blocks);
        return;
    }
  }

  /**
   * Walk a container's children, COALESCING consecutive inline/text siblings into
   * one block.
   *
   * This is the load-bearing rule, and it belongs here rather than in `block()`.
   * Emitting one block per inline node would shred `<div><b>a</b> b <i>c</i></div>`
   * into three paragraphs — which matters because ENML uses `<div>` as its
   * PARAGRAPH element, so every Evernote note would arrive fragmented. Coalescing
   * at the container level fixes that for EVERY container at once (transparent
   * divs, blockquotes, and unknown blocks alike) instead of special-casing one
   * tag class. Caught by the `10-enml-body` conformance fixture.
   */
  private children(el: Node, blocks: string[]): void {
    let run = "";
    const flush = (): void => {
      const text = run.trim();
      if (text.length > 0) blocks.push(text);
      run = "";
    };
    for (const child of Array.from(el.childNodes)) {
      if (Walker.isInline(child)) {
        run += this.inlineNode(child);
        continue;
      }
      flush(); // the inline run ends where a real block begins
      if (child.nodeType === 1) this.block(child as Element, blocks);
    }
    flush();
  }

  /** Convert a sanitized, detached root into markdown + the lossy list. */
  run(root: Node): MarkdownResult {
    const blocks: string[] = [];
    this.children(root, blocks);
    // No post-hoc whitespace pass: every push site above already emits a trimmed,
    // non-empty block, and a global blank-line collapse here would reach INSIDE a
    // fenced code block and delete the user's blank lines.
    return { markdown: blocks.join("\n\n").trim(), lossy: [...this.lossy].sort() };
  }
}

/**
 * Convert an already-sanitized, detached tree to Myne-dialect markdown.
 *
 * Pure: reads the tree, mutates nothing, attaches nothing to `document`.
 */
export function domToMarkdown(root: Node): MarkdownResult {
  return new Walker().run(root);
}
