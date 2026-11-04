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

import { locateFrontmatter } from "../../dialect/lezer/frontmatter";
import { isTagBody } from "../../dialect/lezer/inline-tag";
import { formatYamlStringScalar } from "../../dialect/surgery";
import { foldSegment } from "../../dialect/folderPath";
import {
  planSequenceItemInsert,
  planSequenceItemRemove,
} from "../../dialect/frontmatterSequence";
import { collectFrontmatterTags } from "../frontmatterTags";
import { cleanTagToken } from "./tagRanker";

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
 *  `changes: {from, to, insert}` takes directly. Structurally identical to
 *  `@myne/dialect`'s `SourceEdit` (the shared sequence engine's return shape). */
export interface TagAcceptEdit {
  /** Start offset in the note plaintext. */
  readonly from: number;
  /** End offset, exclusive (`=== from` for a pure insertion). */
  readonly to: number;
  /** Replacement text. */
  readonly insert: string;
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
 * The edit shape — synthesizing a whole `---\ntags:\n  - x\n---\n\n` block for a
 * note with no frontmatter, adding a `tags:` key to a block that lacks one,
 * appending an item to an existing block or flow sequence in that sequence's own
 * style, or promoting a lone scalar to a two-item block sequence — is the shared,
 * key-parameterized engine ({@link planSequenceItemInsert} for `tags`). This
 * function adds the tag-specific dedup half on top: the folded set the note
 * already claims, from frontmatter `tags:`/`tag:` (§3.7.6) AND inline `#tag` in
 * the body. Pure.
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

  // Where and how an item lands in `tags:` is the shared engine, which returns
  // null for the frontmatter shapes this writer refuses (mapping / block scalar
  // / multi-line flow).
  const edit = planSequenceItemInsert(doc, "tags");
  if (edit === null) return null;

  return { existingFolds, edit };
}

/**
 * Compute the edit that adds `newTag` to the note's frontmatter `tags:` list.
 *
 * Returns `null` when there is nothing to write: an empty accept, a tag that is
 * not a legal §3.7.2 body, a tag the note already carries under the fold (in
 * `tags:`, in `tag:`, or as an inline `#tag` in the body), or frontmatter
 * {@link planTagAccept} refuses to touch. Pure.
 */
export function computeTagAcceptEdit(
  doc: string,
  newTag: string,
): TagAcceptEdit | null {
  const cleaned = cleanTagToken(newTag);
  // The writer's half of the gate the reader already applies (myne-md/myne#1025):
  // `rankTagCandidates` drops a candidate that is not a legal tag body, so this
  // refuses only a caller that went around it. Writing `(#Writing with Markdown`
  // would land a tag that no inline `#tag` can ever match, and the note then
  // carries a tag its author cannot type. The removal path below stays ungated,
  // deliberately: cleaning up a junk tag a note already has must remain possible.
  if (!isTagBody(cleaned)) return null;
  const plan = planTagAccept(doc);
  if (plan === null || plan.existingFolds.has(foldSegment(cleaned))) return null;
  // The tag must read back as the exact string it was written as: an unquoted
  // `2026` / `true` / `null` would reach the tag index as a number, a bool or
  // nothing at all.
  return plan.edit(formatYamlStringScalar(cleaned));
}

/**
 * Compute the edit that takes `tag` back out of the note's frontmatter `tags:`
 * list — the inverse of {@link computeTagAcceptEdit}, and the only thing that
 * makes an automatic write reversible (myne-md/myne#908).
 *
 * The symmetry is deliberate and is why this is one call rather than a stored
 * copy of the previous document: the removal is recomputed against the CURRENT
 * text, so it survives the user typing after the write. It removes one item whose
 * folded value matches, collapses a `tags:` line left empty, and returns `null`
 * for the frontmatter shapes the writer refuses (mapping / block scalar /
 * multi-line flow) and for a tag the note does not carry.
 *
 * An inline `#tag` in the body is NOT removed: the accept path never writes one,
 * so one found there is the author's own prose and removing it would delete text
 * the user wrote. Pure.
 */
export function computeTagRemoveEdit(
  doc: string,
  tag: string,
): TagAcceptEdit | null {
  const cleaned = cleanTagToken(tag);
  if (cleaned.length === 0) return null;
  return planSequenceItemRemove(doc, "tags", foldSegment(cleaned));
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
