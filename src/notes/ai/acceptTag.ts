// Tag-accept write cores (auto-tag-link MYND-411 task 5; the frontmatter writer
// wired up by on-device-tag-suggestion task 6). Pure helpers that compute the
// post-accept frontmatter tag list or the post-accept body for an inline `#tag`
// insert — byte-identical to a hand-typed tag, no new writer, no new format.
//
// `computeTagAcceptEdit` is THE accept path for the tag-suggestion band: a chip
// writes into frontmatter `tags:`, never an inline `#tag`. It is expressed as a
// minimal `{from,to,insert}` edit rather than a whole-document rewrite so the
// caller's cursor and selection survive an accept mid-typing, and so the note's
// other bytes are provably untouched (§6 C1 byte-stability for other keys).
// `appendInlineTag` is NOT a second accept path — it survives only as the
// helper the (superseded) chat-tab surface used, and goes with it.
//
// All three are idempotent under the §3.7.8 fold (`foldSegment`) — accepting a
// tag already present (in any case/NFC variant, in `tags:`, `tag:` or as an
// inline `#tag`) is a no-op, so a chip can't produce a duplicate. Pure,
// model-independent.

import { load as parseYaml } from "js-yaml";

import { formatYamlScalar } from "../../dialect";
import { locateFrontmatter } from "../../dialect/lezer/frontmatter";
import { foldSegment } from "../../dialect/folderPath";

/**
 * Clean an accepted tag token: trim + strip a single leading `#` + trim. The
 * suggestion display form the ranker emits is already bare, but a defensive
 * clean keeps the write path robust. (Mirrors `tagRanker.cleanTagToken`.)
 */
function cleanAcceptedTag(raw: string): string {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return bare.trim();
}

/**
 * Compute the frontmatter `tags:` list after accepting `newTag`. Appends the
 * cleaned tag unless an existing tag already folds onto it (idempotent — no
 * near-duplicate). Returns the existing list unchanged when the tag is empty or
 * already present. Existing display casing is preserved; the appended tag keeps
 * its own cleaned casing. Pure.
 */
export function computeTagsAfterAccept(
  existingTags: readonly string[],
  newTag: string,
): string[] {
  const cleaned = cleanAcceptedTag(newTag);
  if (cleaned.length === 0) return [...existingTags];
  const key = foldSegment(cleaned);
  const present = existingTags.some((t) => foldSegment(cleanAcceptedTag(t)) === key);
  return present ? [...existingTags] : [...existingTags, cleaned];
}

/**
 * Append an inline `#tag` to a note body, byte-identical to a hand-typed tag.
 * Idempotent under the fold: if the body already contains the tag as an inline
 * `#tag` token (whitespace/end-delimited, fold-compared) it is returned
 * unchanged. Otherwise a single ` #tag` is appended with one separating space
 * (or none if the body is empty / already ends in whitespace). Pure.
 */
export function appendInlineTag(body: string, newTag: string): string {
  const cleaned = cleanAcceptedTag(newTag);
  if (cleaned.length === 0) return body;
  const key = foldSegment(cleaned);

  // Already present as an inline `#tag` token?
  if (inlineTagFolds(body).has(key)) return body;

  const sep = body.length === 0 || /\s$/u.test(body) ? "" : " ";
  return `${body}${sep}#${cleaned}`;
}

// === the accept-to-frontmatter writer ===

const NEWLINE = "\n";
const FRONTMATTER_DELIMITER = "---";
/** The item indent a synthesized / promoted block sequence is written with. */
const ITEM_INDENT = "  ";

/** Inline `#tag` tokens, folded. Delimited by start/whitespace on the left and
 *  the token charset on the right — the same shape the lezer tagger recognizes. */
function inlineTagFolds(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(/(^|\s)#([\p{L}\p{N}/_-]+)/gu)) {
    out.add(foldSegment(m[2]!));
  }
  return out;
}

/** Frontmatter `tags:` / `tag:` values, coercing scalars the way the tag index
 *  does (`src/notes/vaultIndices.ts::collectFrontmatterTags` — numbers are valid
 *  frontmatter tags, §3.7.6). Kept local so this writer stays IPC-free. */
function frontmatterTagValues(parsed: Record<string, unknown>): string[] {
  const out: string[] = [];
  const consume = (raw: unknown): void => {
    if (typeof raw === "string") out.push(raw);
    else if (typeof raw === "number") out.push(String(raw));
    else if (Array.isArray(raw)) for (const item of raw) consume(item);
  };
  consume(parsed["tags"]);
  consume(parsed["tag"]);
  return out;
}

/** Format an accepted tag as a YAML sequence item value. Quotes like
 *  {@link formatYamlScalar}, and ALSO quotes a tag YAML would re-type away from
 *  the exact string (`2026` → int, `true` → bool, `null` → null) — the reader
 *  (`js-yaml`, default schema) would otherwise hand the tag index a non-string
 *  and the tag would read back different or vanish. Same reasoning as
 *  `formatYamlTitleScalar` in the dialect's surgery module. */
function formatYamlTagItem(value: string): string {
  const plain = formatYamlScalar(value);
  if (plain !== value) return plain; // already escalated to a quoted form
  let reTyped: boolean;
  try {
    reTyped = parseYaml(value) !== value;
  } catch {
    reTyped = true;
  }
  if (!reTyped) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A minimal replacement over the note plaintext — the shape CM6's
 *  `changes: {from, to, insert}` takes directly. */
export interface TagAcceptEdit {
  /** Start offset in the note plaintext. */
  readonly from: number;
  /** End offset, exclusive (`=== from` for a pure insertion). */
  readonly to: number;
  /** Replacement text. */
  readonly insert: string;
}

/** A top-level (zero-indent) `tags:` key line. An indented one belongs to a
 *  nested mapping and is none of our business. */
const TAGS_KEY_RE = /^tags[ \t]*:[ \t]*(.*)$/;
/** A block-sequence item line, at any indent. */
const SEQ_ITEM_RE = /^([ \t]*)-([ \t].*)?$/;

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

/**
 * Compute the edit that adds `newTag` to the note's frontmatter `tags:` list.
 *
 * Returns `null` when there is nothing to write — an empty accept, a tag the
 * note already carries under the fold (in `tags:`, in `tag:`, or as an inline
 * `#tag` in the body), or frontmatter this writer refuses to touch (YAML that
 * does not parse, or a `tags:` value that is a mapping / block scalar /
 * multi-line flow sequence — mangling those would lose user data, so the accept
 * is dropped instead).
 *
 * Otherwise it produces the smallest edit that reaches the right shape:
 * synthesizing a whole `---\ntags:\n  - x\n---\n\n` block for a note with no
 * frontmatter, adding a `tags:` key to a block that lacks one, appending an item
 * to an existing block or flow sequence in that sequence's own style, or
 * promoting a lone scalar to a two-item block sequence. Pure.
 */
export function computeTagAcceptEdit(
  doc: string,
  newTag: string,
): TagAcceptEdit | null {
  const cleaned = cleanAcceptedTag(newTag);
  if (cleaned.length === 0) return null;

  const fm = locateFrontmatter(doc);

  // Everything the note already claims as a tag, from both sources the tag index
  // unions (§3.7.6): frontmatter `tags:`/`tag:` and inline `#tag` in the BODY
  // (frontmatter is skipped — a `#` there is a YAML comment, not a tag).
  const existing: string[] = [];
  if (fm !== null) {
    let parsed: unknown;
    try {
      parsed = parseYaml(doc.substring(fm.bodyStart, fm.bodyEnd));
    } catch {
      return null; // unparseable frontmatter — refuse rather than compound it
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing.push(...frontmatterTagValues(parsed as Record<string, unknown>));
    }
  }
  for (const fold of inlineTagFolds(doc.substring(fm?.blockEnd ?? 0))) {
    existing.push(fold);
  }

  // The fold/idempotence decision routes through the existing core: it grows the
  // list only for a genuinely-new tag, and the item it appended is what we write.
  const next = computeTagsAfterAccept(existing, cleaned);
  if (next.length === existing.length) return null;
  const item = formatYamlTagItem(next[next.length - 1]!);

  // State A — no frontmatter block at all: synthesize one.
  if (fm === null) {
    return {
      from: 0,
      to: 0,
      insert:
        FRONTMATTER_DELIMITER + NEWLINE +
        "tags:" + NEWLINE +
        ITEM_INDENT + "- " + item + NEWLINE +
        FRONTMATTER_DELIMITER + NEWLINE +
        NEWLINE,
    };
  }

  const fmBody = doc.substring(fm.bodyStart, fm.bodyEnd);
  const lines = fmBody.split(NEWLINE);
  const keyIndex = lines.findIndex((l) => TAGS_KEY_RE.test(l));

  // State B — a block with no top-level `tags:` key: append the key at its end.
  if (keyIndex === -1) {
    return {
      from: fm.bodyEnd,
      to: fm.bodyEnd,
      insert: "tags:" + NEWLINE + ITEM_INDENT + "- " + item + NEWLINE,
    };
  }

  const keyLine = lines[keyIndex]!;
  const { value, comment } = splitComment(TAGS_KEY_RE.exec(keyLine)![1]!);
  const trimmed = value.trim();

  // State C1 — a flow sequence on the key line: `tags: [a, b]` → `[a, b, x]`.
  if (trimmed.startsWith("[")) {
    const close = trimmed.lastIndexOf("]");
    if (close !== trimmed.length - 1) return null; // multi-line flow — refuse
    const head = trimmed.slice(0, close).replace(/[ \t]+$/, "");
    const inner = head.slice(1).trim();
    const newValue = head + (inner === "" ? "" : ", ") + item + "]";
    const from = fm.bodyStart + lineOffset(lines, keyIndex);
    return { from, to: from + keyLine.length, insert: "tags: " + newValue + comment };
  }

  // A mapping or a block scalar under `tags:` — refuse rather than mangle.
  if (trimmed.startsWith("{") || trimmed.startsWith("|") || trimmed.startsWith(">")) {
    return null;
  }

  // State C2 — a scalar on the key line: promote it to a block sequence, keeping
  // the existing value's own bytes as the first item.
  if (trimmed !== "") {
    const from = fm.bodyStart + lineOffset(lines, keyIndex);
    return {
      from,
      to: from + keyLine.length,
      insert:
        "tags:" + comment + NEWLINE +
        ITEM_INDENT + "- " + trimmed + NEWLINE +
        ITEM_INDENT + "- " + item,
    };
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
    // A more-indented non-item line under `tags:` is a nested mapping or a
    // continuation: refuse rather than guess.
    if (lastItem === -1 && /^[ \t]+\S/.test(lines[i]!)) return null;
    break;
  }
  const anchor = lastItem === -1 ? keyIndex : lastItem;
  const from = fm.bodyStart + lineOffset(lines, anchor) + lines[anchor]!.length;
  return { from, to: from, insert: NEWLINE + itemIndent + "- " + item };
}

/**
 * {@link computeTagAcceptEdit} applied to the document — the whole post-accept
 * plaintext, or `doc` unchanged when there is nothing to write. The convenience
 * form for callers that hold a string rather than a CM6 document. Pure.
 */
export function applyTagAccept(doc: string, newTag: string): string {
  const edit = computeTagAcceptEdit(doc, newTag);
  if (edit === null) return doc;
  return doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to);
}
