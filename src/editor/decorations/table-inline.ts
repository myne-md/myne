// Hand-built inline-markdown renderer for table cells (MYND-162, task 3).
//
// Renders a NARROW subset — bold, italic, inline code, link — into DOM built
// with `createElement` / `textContent` ONLY, never `innerHTML` (TB2: no
// injection). The table widget is a block-replace widget, so it does not get the
// editor's live-text inline decorations for free; this is a second, deliberately
// minimal inline pipeline scoped to what cells need.
//
// Out-of-subset constructs (emoji, math `$x$`, footnotes `[^1]`, wikilinks
// `[[…]]`, attachment embeds) are NOT parsed — they render as literal text, so a
// cell never partially/ surprisingly renders. Links route through the same
// http/https/mailto allowlist as `autolink.ts`; a disallowed scheme (e.g.
// `javascript:`) renders as inert text with no navigable href.
//
// Known limitation: emphasis uses simple delimiter matching, not CommonMark's
// flanking rules — intraword `_` (e.g. `foo_bar_`) may emphasize where strict
// CommonMark would not. Acceptable for single-line cell content.

/**
 * Allowlist mirror of `autolink.ts`'s `resolveHref`: only http / https / mailto
 * get a clickable target; everything else → `null` (inert).
 */
export function tableLinkHref(raw: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (match === null) return null;
  const scheme = match[1]!.toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto" ? raw : null;
}

function el(tag: string, children: readonly Node[]): HTMLElement {
  const node = document.createElement(tag);
  for (const child of children) node.appendChild(child);
  return node;
}

/** Parse a cell's inline source into a flat list of DOM nodes (recursive for
 *  nested marks; code content is always literal). */
function inlineNodes(text: string): Node[] {
  const out: Node[] = [];
  let buf = "";
  let i = 0;
  const flush = (): void => {
    if (buf.length > 0) {
      out.push(document.createTextNode(buf));
      buf = "";
    }
  };

  while (i < text.length) {
    const ch = text[i]!;

    // Backslash escape: `\*`, `\_`, `` \` ``, `\[` … → literal next char.
    if (ch === "\\" && i + 1 < text.length && /[\\`*_[\]()~]/.test(text[i + 1]!)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    const rest = text.slice(i);

    // Inline code — inner content is literal (no nested parsing).
    const code = /^`([^`]+)`/.exec(rest);
    if (code !== null) {
      flush();
      out.push(el("code", [document.createTextNode(code[1]!)]));
      i += code[0].length;
      continue;
    }

    // Link `[text](url)` — text parsed recursively, url scheme-checked.
    const link = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(rest);
    if (link !== null) {
      flush();
      const href = tableLinkHref(link[2]!);
      const inner = inlineNodes(link[1]!);
      if (href !== null) {
        const anchor = el("a", inner);
        anchor.className = "cm-link";
        anchor.setAttribute("data-cm-url", href); // not `href`: inert in-webview, opened via opener
        out.push(anchor);
      } else {
        // Disallowed scheme → render the link text inertly, no anchor.
        for (const node of inner) out.push(node);
      }
      i += link[0].length;
      continue;
    }

    // Bold `**…**` / `__…__` (checked before italic so `**` wins over `*`).
    const strong = /^(\*\*|__)([^]+?)\1/.exec(rest);
    if (strong !== null) {
      flush();
      out.push(el("strong", inlineNodes(strong[2]!)));
      i += strong[0].length;
      continue;
    }

    // Italic `*…*` / `_…_`.
    const em = /^(\*|_)([^]+?)\1/.exec(rest);
    if (em !== null) {
      flush();
      out.push(el("em", inlineNodes(em[2]!)));
      i += em[0].length;
      continue;
    }

    buf += ch;
    i += 1;
  }

  flush();
  return out;
}

/**
 * Render a cell's inline source into `parent`, replacing its children. Safe by
 * construction — every text run goes through `createTextNode`, every element via
 * `createElement`; nothing is ever assigned to `innerHTML`.
 */
export function renderInlineCell(parent: HTMLElement, source: string): void {
  parent.replaceChildren(...inlineNodes(source));
}
