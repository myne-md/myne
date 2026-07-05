// Minimal, safe Markdown model for the mobile editor's Reading mode — the
// counterpart to the desktop CodeMirror live/reading render. Deliberately a
// small block+inline parser (no HTML passthrough, so no XSS surface: the view
// renders a React token tree, never `dangerouslySetInnerHTML`). Covers the marks
// a note commonly uses; anything unrecognized falls through as plain text.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "wikilink"; target: string; label: string }
  | { kind: "attachment"; id: string; label: string };

export type Block =
  | { kind: "heading"; level: number; content: Inline[] }
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "quote"; content: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "hr" };

// Inline matcher table, tried in order at each position. `**` before `*` so a
// bold marker isn't misread as two italics.
const INLINE = [
  { re: /^`([^`]+)`/, make: (m: RegExpExecArray): Inline => ({ kind: "code", text: m[1] }) },
  {
    // Form-C attachment embed `![[att:<id>|<name>]]` — must precede the wikilink
    // rule so the leading `!` + `att:` target aren't split into text + wikilink.
    re: /^!\[\[att:([0-9a-f]{64})(?:\|([^\]\n]*))?\]\]/,
    make: (m: RegExpExecArray): Inline => ({ kind: "attachment", id: m[1], label: (m[2] ?? "").trim() }),
  },
  {
    re: /^\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]/,
    make: (m: RegExpExecArray): Inline => ({ kind: "wikilink", target: m[1].trim(), label: (m[2] ?? m[1]).trim() }),
  },
  { re: /^\[([^\]\n]+)\]\(([^)\s]+)\)/, make: (m: RegExpExecArray): Inline => ({ kind: "link", text: m[1], href: m[2] }) },
  { re: /^\*\*([^*\n]+)\*\*/, make: (m: RegExpExecArray): Inline => ({ kind: "bold", text: m[1] }) },
  { re: /^__([^_\n]+)__/, make: (m: RegExpExecArray): Inline => ({ kind: "bold", text: m[1] }) },
  { re: /^\*([^*\n]+)\*/, make: (m: RegExpExecArray): Inline => ({ kind: "italic", text: m[1] }) },
  { re: /^_([^_\n]+)_/, make: (m: RegExpExecArray): Inline => ({ kind: "italic", text: m[1] }) },
];

/** Tokenize one line of inline Markdown. Consecutive plain runs are coalesced. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push({ kind: "text", text: buf });
      buf = "";
    }
  };
  while (i < text.length) {
    const rest = text.slice(i);
    let matched: Inline | null = null;
    let len = 0;
    for (const { re, make } of INLINE) {
      const m = re.exec(rest);
      if (m) {
        matched = make(m);
        len = m[0].length;
        break;
      }
    }
    if (matched) {
      flush();
      out.push(matched);
      i += len;
    } else {
      buf += text[i];
      i += 1;
    }
  }
  flush();
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^(?:---+|\*\*\*+|___+)\s*$/;
const UL = /^[-*+]\s+(.*)$/;
const OL = /^\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^```/;

/** Parse note text into a flat list of blocks. Line-based and forgiving. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing fence
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, content: parseInline(h[2].trim()) });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    const firstUl = UL.exec(line);
    const firstOl = OL.exec(line);
    if (firstUl || firstOl) {
      const ordered = !!firstOl;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = ordered ? OL.exec(lines[i]) : UL.exec(lines[i]);
        if (!m) break;
        items.push(parseInline(m[1]));
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (QUOTE.test(line)) {
      const parts: string[] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]);
        if (!m) break;
        parts.push(m[1]);
        i += 1;
      }
      blocks.push({ kind: "quote", content: parseInline(parts.join(" ")) });
      continue;
    }

    // Paragraph: consume until a blank line or a block-starting line.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        l.trim() === "" ||
        FENCE.test(l) ||
        HEADING.test(l) ||
        HR.test(l) ||
        UL.test(l) ||
        OL.test(l) ||
        QUOTE.test(l)
      ) {
        break;
      }
      para.push(l);
      i += 1;
    }
    blocks.push({ kind: "paragraph", content: parseInline(para.join(" ")) });
  }

  return blocks;
}
