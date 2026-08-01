// Frontmatter block/flow-sequence editing core (MYND — frontmatter list chips).
//
// The pure, key-parameterized YAML-editing engine behind two consumers that must
// stay byte-for-byte in step:
//   - `src/notes/ai/acceptTag.ts` — the AI tag-suggestion accept path, which
//     appends to frontmatter `tags:` and carries its own tag-identity dedup glue
//     (inline `#tag` scan + the singular `tag:` key) on top of this core; and
//   - the editor's frontmatter Properties widget, which renders ANY sequence-
//     valued key as chips and adds / removes items in place.
//
// `planSequenceItemInsert` is the extraction of what `planTagAccept` used to do
// inline: reach the target list with the smallest possible edit, synthesizing a
// whole `---\n<key>:\n  - x\n---\n\n` block for a note with no frontmatter,
// adding a `<key>:` line to a block that lacks one, appending an item to an
// existing block or flow sequence in that sequence's own style, or promoting a
// lone scalar to a two-item block sequence. `planSequenceItemRemove` is the
// symmetric inverse — delete one item, collapsing the key line when the last
// item goes. Both are pure and model-independent, and both REFUSE (return null)
// rather than mangle a mapping, a block scalar or a multi-line flow sequence.

import { load as parseYaml } from "js-yaml";

import {
  FRONTMATTER_DELIMITER,
  FRONTMATTER_OPENER,
  NEWLINE,
  locateFrontmatter,
} from "./lezer/frontmatter";
import { foldSegment } from "./folderPath";

/** A minimal replacement over the note plaintext — the shape CM6's
 *  `changes: {from, to, insert}` takes directly. */
export interface SourceEdit {
  /** Start offset in the note plaintext. */
  readonly from: number;
  /** End offset, exclusive (`=== from` for a pure insertion). */
  readonly to: number;
  /** Replacement text. */
  readonly insert: string;
}

/** The item indent a synthesized / promoted block sequence is written with. */
const ITEM_INDENT = "  ";

/** A block-sequence item line, at any indent. */
const SEQ_ITEM_RE = /^([ \t]*)-([ \t].*)?$/;

/** Escape a frontmatter key for embedding in a `RegExp`. Keys the widget can
 *  reach are `[a-zA-Z0-9_-]+`, but the core stays general. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A top-level (zero-indent) `<key>:` line. An indented one belongs to a nested
 *  mapping and is none of our business. */
function keyLineRe(key: string): RegExp {
  return new RegExp("^" + escapeRegExp(key) + "[ \\t]*:[ \\t]*(.*)$");
}

/** Split a trailing ` # comment` off a YAML value portion. A quoted value is
 *  returned whole (a `#` inside quotes is data, not a comment). */
function splitComment(value: string): { value: string; comment: string } {
  if (value.startsWith("#")) return { value: "", comment: value };
  if (value.startsWith('"') || value.startsWith("'")) return { value, comment: "" };
  const m = /^(.*?)([ \t]+#.*)$/.exec(value);
  return m === null ? { value, comment: "" } : { value: m[1]!, comment: m[2]! };
}

/** Byte offset of line `index` within a `"\n"`-split line list. */
function lineOffset(lines: readonly string[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i += 1) offset += lines[i]!.length + NEWLINE.length;
  return offset;
}

/** Decode a single raw YAML item token to its logical string, for display and
 *  fold-matching. Uses js-yaml so `"2026"` → `2026`, `'a b'` → `a b`, `work` →
 *  `work`; a number/bool decodes to its string form. Falls back to the trimmed
 *  raw token when the fragment does not parse. */
function decodeItem(raw: string): string {
  const trimmed = raw.trim();
  try {
    const v = parseYaml(trimmed);
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * The decoded item list of every top-level sequence-valued (array) key in the
 * frontmatter, keyed by key name, or `null` when there is no frontmatter or its
 * YAML does not parse. Scalar and mapping values are omitted — only arrays land
 * here. This is the display source for the Properties widget's chips; the item
 * strings are the logical (quote-decoded) values.
 */
export function readFrontmatterSequences(
  doc: string,
): Map<string, string[]> | null {
  const fm = locateFrontmatter(doc);
  if (fm === null) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(doc.substring(fm.bodyStart, fm.bodyEnd));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const out = new Map<string, string[]>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    out.set(
      key,
      value.map((v) =>
        typeof v === "string" ? v : v === null ? "" : String(v),
      ),
    );
  }
  return out;
}

/**
 * How appending an item to `key`'s sequence would edit this document, or `null`
 * when the writer refuses to touch the frontmatter — YAML that does not parse
 * (checked by the caller that also needs the parse), or a `key:` value that is a
 * mapping / block scalar / multi-line flow sequence. The returned closure takes
 * an ALREADY-FORMATTED YAML scalar (caller applies `formatYamlStringScalar`), so
 * the item reads back as the exact string it was written as. Pure.
 */
export function planSequenceItemInsert(
  doc: string,
  key: string,
): ((item: string) => SourceEdit) | null {
  const fm = locateFrontmatter(doc);
  const KEY_RE = keyLineRe(key);

  // State A — no frontmatter block at all: synthesize one.
  if (fm === null) {
    return (item) => ({
      from: 0,
      to: 0,
      insert:
        FRONTMATTER_OPENER +
        key + ":" + NEWLINE +
        ITEM_INDENT + "- " + item + NEWLINE +
        FRONTMATTER_DELIMITER + NEWLINE +
        NEWLINE,
    });
  }

  const bodyStart = fm.bodyStart;
  const bodyEnd = fm.bodyEnd;
  const lines = doc.substring(bodyStart, bodyEnd).split(NEWLINE);
  const keyIndex = lines.findIndex((l) => KEY_RE.test(l));

  // State B — a block with no top-level `<key>:` line: append the key at its end.
  if (keyIndex === -1) {
    return (item) => ({
      from: bodyEnd,
      to: bodyEnd,
      insert: key + ":" + NEWLINE + ITEM_INDENT + "- " + item + NEWLINE,
    });
  }

  const keyLine = lines[keyIndex]!;
  const { value, comment } = splitComment(KEY_RE.exec(keyLine)![1]!);
  const trimmed = value.trim();
  const keyFrom = bodyStart + lineOffset(lines, keyIndex);

  // State C1 — a flow sequence on the key line: `<key>: [a, b]` → `[a, b, x]`.
  if (trimmed.startsWith("[")) {
    const close = trimmed.lastIndexOf("]");
    if (close !== trimmed.length - 1) return null; // multi-line flow — refuse
    const head = trimmed.slice(0, close).replace(/[ \t]+$/, "");
    const separator = head.slice(1).trim() === "" ? "" : ", ";
    return (item) => ({
      from: keyFrom,
      to: keyFrom + keyLine.length,
      insert: key + ": " + head + separator + item + "]" + comment,
    });
  }

  // A mapping or a block scalar under `<key>:` — refuse rather than mangle.
  if (trimmed.startsWith("{") || trimmed.startsWith("|") || trimmed.startsWith(">")) {
    return null;
  }

  // State C2 — a scalar on the key line: promote it to a block sequence, keeping
  // the existing value's own bytes as the first item.
  if (trimmed !== "") {
    return (item) => ({
      from: keyFrom,
      to: keyFrom + keyLine.length,
      insert:
        key + ":" + comment + NEWLINE +
        ITEM_INDENT + "- " + trimmed + NEWLINE +
        ITEM_INDENT + "- " + item,
    });
  }

  // State C3 — an empty value: a block sequence follows, or nothing does.
  let lastItem = -1;
  let itemIndent = ITEM_INDENT;
  for (let i = keyIndex + 1; i < lines.length; i += 1) {
    const seq = SEQ_ITEM_RE.exec(lines[i]!);
    if (seq !== null) {
      if (lastItem === -1) itemIndent = seq[1]!;
      else if (seq[1] !== itemIndent) break; // a nested sequence — stop here
      lastItem = i;
      continue;
    }
    // A more-indented non-item line under `<key>:` is a nested mapping or a
    // continuation: refuse rather than guess.
    if (lastItem === -1 && /^[ \t]+\S/.test(lines[i]!)) return null;
    break;
  }
  const anchor = lastItem === -1 ? keyIndex : lastItem;
  const from = bodyStart + lineOffset(lines, anchor) + lines[anchor]!.length;
  const indent = itemIndent;
  return (item) => ({ from, to: from, insert: NEWLINE + indent + "- " + item });
}

/**
 * How removing the item whose folded value equals `targetFold` from `key`'s
 * sequence would edit this document, or `null` when there is no such item or the
 * value is a shape this core refuses to touch (mapping / block scalar / multi-
 * line flow). Deleting the last remaining item collapses the `<key>:` line too,
 * so no empty `<key>:` is left behind. Pure.
 */
export function planSequenceItemRemove(
  doc: string,
  key: string,
  targetFold: string,
): SourceEdit | null {
  const fm = locateFrontmatter(doc);
  if (fm === null) return null;
  const KEY_RE = keyLineRe(key);
  const bodyStart = fm.bodyStart;
  const bodyEnd = fm.bodyEnd;
  const lines = doc.substring(bodyStart, bodyEnd).split(NEWLINE);
  const keyIndex = lines.findIndex((l) => KEY_RE.test(l));
  if (keyIndex === -1) return null;

  const keyLine = lines[keyIndex]!;
  const { value, comment } = splitComment(KEY_RE.exec(keyLine)![1]!);
  const trimmed = value.trim();
  const keyFrom = bodyStart + lineOffset(lines, keyIndex);

  // Byte offset just past the key line, including its own newline (the whole
  // `<key>:` line region, used when collapsing an emptied sequence).
  const keyLineEndWithNl = keyFrom + keyLine.length + NEWLINE.length;

  // Flow sequence: `<key>: [a, b]`.
  if (trimmed.startsWith("[")) {
    const close = trimmed.lastIndexOf("]");
    if (close !== trimmed.length - 1) return null; // multi-line flow — refuse
    let parsedFlow: unknown;
    try {
      parsedFlow = parseYaml(trimmed); // decodes items, quoted commas included
    } catch {
      return null;
    }
    if (!Array.isArray(parsedFlow)) return null;
    const items = parsedFlow.map((v) =>
      typeof v === "string" ? v : v === null ? "" : String(v),
    );
    const remaining: string[] = [];
    let removed = false;
    for (const item of items) {
      if (!removed && foldSegment(item) === targetFold) {
        removed = true;
        continue;
      }
      remaining.push(item);
    }
    if (!removed) return null;
    if (remaining.length === 0) {
      // Collapse the whole key line (drop its trailing newline too).
      return { from: keyFrom, to: keyLineEndWithNl, insert: "" };
    }
    const rebuilt = remaining.map((v) => formatFlowItem(v)).join(", ");
    return {
      from: keyFrom,
      to: keyFrom + keyLine.length,
      insert: key + ": [" + rebuilt + "]" + comment,
    };
  }

  // Mapping / block scalar — refuse.
  if (trimmed.startsWith("{") || trimmed.startsWith("|") || trimmed.startsWith(">")) {
    return null;
  }

  // Scalar on the key line: `<key>: work`. Removing it (when it matches) drops
  // the whole key line.
  if (trimmed !== "") {
    if (foldSegment(decodeItem(trimmed)) !== targetFold) return null;
    return { from: keyFrom, to: keyLineEndWithNl, insert: "" };
  }

  // Block sequence under an empty `<key>:` value.
  const itemLines: number[] = [];
  let itemIndent: string | null = null;
  for (let i = keyIndex + 1; i < lines.length; i += 1) {
    const seq = SEQ_ITEM_RE.exec(lines[i]!);
    if (seq !== null) {
      if (itemIndent === null) itemIndent = seq[1]!;
      else if (seq[1] !== itemIndent) break; // a nested sequence — stop here
      itemLines.push(i);
      continue;
    }
    if (itemIndent === null && /^[ \t]+\S/.test(lines[i]!)) return null; // nested map
    break;
  }
  if (itemLines.length === 0) return null;

  let matchLine = -1;
  for (const i of itemLines) {
    const seq = SEQ_ITEM_RE.exec(lines[i]!)!;
    const rawItem = (seq[2] ?? "").trim();
    if (foldSegment(decodeItem(rawItem)) === targetFold) {
      matchLine = i;
      break;
    }
  }
  if (matchLine === -1) return null;

  // Last remaining item: collapse the key line AND the item line together.
  if (itemLines.length === 1) {
    const itemFrom = bodyStart + lineOffset(lines, matchLine);
    const itemEndWithNl = itemFrom + lines[matchLine]!.length + NEWLINE.length;
    return { from: keyFrom, to: itemEndWithNl, insert: "" };
  }

  // Otherwise drop just the matched item line, including its trailing newline.
  const from = bodyStart + lineOffset(lines, matchLine);
  const to = from + lines[matchLine]!.length + NEWLINE.length;
  return { from, to, insert: "" };
}

/** Re-serialize a decoded flow-sequence item, quoting so it reads back as the
 *  exact string. Mirrors `formatYamlStringScalar` without importing it (this
 *  module stays free of `surgery`'s larger surface) — the same conservative
 *  rule: quote when a bare emission would be unsafe or re-typed. */
function formatFlowItem(value: string): string {
  const needsQuote =
    value.length === 0 ||
    /^[\s\-?:[\]{}#&*!|>'"%@`]/.test(value) ||
    /\s$/.test(value) ||
    /[,[\]{}]/.test(value) ||
    /: |\s#|\n|\r/.test(value) ||
    reTypes(value);
  if (!needsQuote) return value;
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Would YAML re-type the bare scalar to a non-string? */
function reTypes(value: string): boolean {
  try {
    return parseYaml(value) !== value;
  } catch {
    return true;
  }
}
