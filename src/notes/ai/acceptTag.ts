// Tag-accept write core (auto-tag-link MYND-411 task 5; the frontmatter writer
// wired up by on-device-tag-suggestion task 6). A pure helper that computes the
// minimal document edit landing an accepted tag — byte-identical to a hand-typed
// tag, no new writer, no new format.
//
// `computeTagAcceptEdit` is THE accept path for the tag-suggestion band, and the
// only one: a chip writes into frontmatter `tags:`, never an inline `#tag`. It
// is expressed as a minimal `{from,to,insert}` edit rather than a whole-document
// rewrite so the caller's cursor and selection survive an accept mid-typing, and
// so the note's other bytes are provably untouched (§6 C1 byte-stability for
// other keys).
//
// It is idempotent under the §3.7.8 fold (`foldSegment`) — accepting a tag
// already present (in any case/NFC variant, in `tags:`, `tag:` or as an inline
// `#tag`) is a no-op, so a chip can't produce a duplicate. Pure,
// model-independent.
//
// The document half of that decision is split out as {@link planTagAccept}: the
// band asks "would this chip land?" for every candidate on every keystroke, and
// the answer's expensive part (a YAML parse plus a whole-body inline-tag scan)
// depends only on the document, so it is computed once and shared.

import { load as parseYaml } from "js-yaml";

import {
  FRONTMATTER_DELIMITER,
  FRONTMATTER_OPENER,
  NEWLINE,
  locateFrontmatter,
} from "../../dialect/lezer/frontmatter";
import { formatYamlStringScalar } from "../../dialect/surgery";
import { foldSegment } from "../../dialect/folderPath";
import { collectFrontmatterTags } from "../frontmatterTags";
import { cleanTagToken } from "./tagRanker";

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
 * What accepting ANY tag into this document would do. Everything here is a
 * function of the document alone, so it is computed once and reused for every
 * candidate tag — the band asks "would this chip land?" for up to
 * `MAX_TAG_SUGGESTIONS` tags on every keystroke, and the YAML parse plus the
 * whole-body inline-tag scan are far too expensive to repeat per chip.
 */
export interface TagAcceptPlan {
  /** Folded keys the note already claims, from both sources the tag index
   *  unions (§3.7.6): frontmatter `tags:`/`tag:` and inline `#tag` in the BODY
   *  (frontmatter is skipped — a `#` there is a YAML comment, not a tag). A tag
   *  folding onto one of these is already present, so accepting it is a no-op. */
  readonly existingFolds: ReadonlySet<string>;
  /** The edit that lands an already-formatted sequence item. */
  readonly edit: (item: string) => TagAcceptEdit;
}

/**
 * Decide how a tag would be written into this document, or `null` when this
 * writer refuses to touch its frontmatter — YAML that does not parse, or a
 * `tags:` value that is a mapping / block scalar / multi-line flow sequence.
 * Mangling those would lose user data, so the accept is dropped instead.
 *
 * The plan reaches the right shape with the smallest edit: synthesizing a whole
 * `---\ntags:\n  - x\n---\n\n` block for a note with no frontmatter, adding a
 * `tags:` key to a block that lacks one, appending an item to an existing block
 * or flow sequence in that sequence's own style, or promoting a lone scalar to a
 * two-item block sequence. Pure.
 */
export function planTagAccept(doc: string): TagAcceptPlan | null {
  const fm = locateFrontmatter(doc);

  const existingFolds = new Set<string>();
  if (fm !== null) {
    let parsed: unknown;
    try {
      parsed = parseYaml(doc.substring(fm.bodyStart, fm.bodyEnd));
    } catch {
      return null; // unparseable frontmatter — refuse rather than compound it
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const value of collectFrontmatterTags(parsed as Record<string, unknown>)) {
        existingFolds.add(foldSegment(cleanTagToken(value)));
      }
    }
  }
  for (const fold of inlineTagFolds(doc.substring(fm?.blockEnd ?? 0))) {
    existingFolds.add(fold);
  }

  // State A — no frontmatter block at all: synthesize one.
  if (fm === null) {
    return {
      existingFolds,
      edit: (item) => ({
        from: 0,
        to: 0,
        insert:
          FRONTMATTER_OPENER +
          "tags:" + NEWLINE +
          ITEM_INDENT + "- " + item + NEWLINE +
          FRONTMATTER_DELIMITER + NEWLINE +
          NEWLINE,
      }),
    };
  }

  const bodyStart = fm.bodyStart;
  const bodyEnd = fm.bodyEnd;
  const lines = doc.substring(bodyStart, bodyEnd).split(NEWLINE);
  const keyIndex = lines.findIndex((l) => TAGS_KEY_RE.test(l));

  // State B — a block with no top-level `tags:` key: append the key at its end.
  if (keyIndex === -1) {
    return {
      existingFolds,
      edit: (item) => ({
        from: bodyEnd,
        to: bodyEnd,
        insert: "tags:" + NEWLINE + ITEM_INDENT + "- " + item + NEWLINE,
      }),
    };
  }

  const keyLine = lines[keyIndex]!;
  const { value, comment } = splitComment(TAGS_KEY_RE.exec(keyLine)![1]!);
  const trimmed = value.trim();
  const keyFrom = bodyStart + lineOffset(lines, keyIndex);

  // State C1 — a flow sequence on the key line: `tags: [a, b]` → `[a, b, x]`.
  if (trimmed.startsWith("[")) {
    const close = trimmed.lastIndexOf("]");
    if (close !== trimmed.length - 1) return null; // multi-line flow — refuse
    const head = trimmed.slice(0, close).replace(/[ \t]+$/, "");
    const separator = head.slice(1).trim() === "" ? "" : ", ";
    return {
      existingFolds,
      edit: (item) => ({
        from: keyFrom,
        to: keyFrom + keyLine.length,
        insert: "tags: " + head + separator + item + "]" + comment,
      }),
    };
  }

  // A mapping or a block scalar under `tags:` — refuse rather than mangle.
  if (trimmed.startsWith("{") || trimmed.startsWith("|") || trimmed.startsWith(">")) {
    return null;
  }

  // State C2 — a scalar on the key line: promote it to a block sequence, keeping
  // the existing value's own bytes as the first item.
  if (trimmed !== "") {
    return {
      existingFolds,
      edit: (item) => ({
        from: keyFrom,
        to: keyFrom + keyLine.length,
        insert:
          "tags:" + comment + NEWLINE +
          ITEM_INDENT + "- " + trimmed + NEWLINE +
          ITEM_INDENT + "- " + item,
      }),
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
  const from = bodyStart + lineOffset(lines, anchor) + lines[anchor]!.length;
  const indent = itemIndent;
  return {
    existingFolds,
    edit: (item) => ({ from, to: from, insert: NEWLINE + indent + "- " + item }),
  };
}

/**
 * Compute the edit that adds `newTag` to the note's frontmatter `tags:` list.
 *
 * Returns `null` when there is nothing to write — an empty accept, a tag the
 * note already carries under the fold (in `tags:`, in `tag:`, or as an inline
 * `#tag` in the body), or frontmatter {@link planTagAccept} refuses to touch.
 * Pure.
 */
export function computeTagAcceptEdit(
  doc: string,
  newTag: string,
): TagAcceptEdit | null {
  const cleaned = cleanTagToken(newTag);
  if (cleaned.length === 0) return null;
  const plan = planTagAccept(doc);
  if (plan === null || plan.existingFolds.has(foldSegment(cleaned))) return null;
  // The tag must read back as the exact string it was written as: an unquoted
  // `2026` / `true` / `null` would reach the tag index as a number, a bool or
  // nothing at all.
  return plan.edit(formatYamlStringScalar(cleaned));
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
