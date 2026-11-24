// Spec: docs/spec/markdown-dialect.md (D1 — GFM + footnote + wikilink +
// frontmatter + inline-tag, see §3.5 / §3.6 / §3.7).

/** Half-open byte range [start, end). */
export type ByteRange = {
  start: number;
  end: number;
};

export type ParseErrorSeverity = "error" | "warning";

/** Adapted from js-yaml's YAMLException. */
export type YamlParseError = {
  kind: "yaml";
  severity: "error";
  message: string;
  line: number;
  column: number;
  byteOffset: number;
};

export type FrontmatterUnclosedError = {
  kind: "frontmatter-unclosed";
  severity: "error";
  message: string;
  openerLine: number;
};

export type WikilinkUnclosedError = {
  kind: "wikilink-unclosed";
  severity: "warning";
  message: string;
  byteOffset: number;
};

export type FencedCodeUnclosedError = {
  kind: "fenced-code-unclosed";
  severity: "warning";
  message: string;
  openerLine: number;
};

export type ParseError =
  | YamlParseError
  | FrontmatterUnclosedError
  | WikilinkUnclosedError
  | FencedCodeUnclosedError;

// `raw === null` means no FM block detected. `parsed === null` with `raw !==
// null` means YAML was malformed; `error` carries the YAMLException-derived
// ParseError so consumers can fall back to raw text.
export type Frontmatter = {
  raw: string | null;
  parsed: Record<string, unknown> | null;
  byteRange: ByteRange | null;
  error: ParseError | null;
};

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type HeadingRef = {
  level: HeadingLevel;
  text: string;
  raw: string;
  byteRange: ByteRange;
};

export type WikilinkTargetKind = "title" | "vault-path";

export type WikilinkRef = {
  raw: string;
  byteRange: ByteRange;
  embed: boolean;
  target: string;
  targetKind: WikilinkTargetKind;
  alias: string | null;
  heading: string | null;
  blockId: string | null;
};

// `tag` is the raw source string with the leading `#` stripped,
// **un-normalized** — NFC + case-fold are the consuming index layer's
// responsibility (B10.4) per the 2026-05-09 grill addendum.
export type InlineTagRef = {
  raw: string;
  tag: string;
  byteRange: ByteRange;
};

// Markdown `![alt](src)` form ONLY. The `![[image.png]]` wikilink-embed form
// lives under `WikilinkRef` with `embed: true`. `src` is verbatim source bytes
// (no URL decoding, no path resolution).
export type MediaRef = {
  raw: string;
  byteRange: ByteRange;
  alt: string;
  src: string;
};

// Always returned; `parse()` never throws. `errors[]` is body-side errors;
// frontmatter `error` is per-frontmatter-block.
export type ParseResult = {
  frontmatter: Frontmatter;
  headings: HeadingRef[];
  wikilinks: WikilinkRef[];
  inlineTags: InlineTagRef[];
  mediaRefs: MediaRef[];
  fullText: string;
  errors: ParseError[];
};
