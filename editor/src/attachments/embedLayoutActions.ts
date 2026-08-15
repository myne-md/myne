// Writing form-C embed layout segments back into the note (myne#409 task 5).
//
// This is the ONLY authoring path for `w=` / `h=` / `align=` / `alt=`, and that
// is a hard fact rather than a convenience: a form-C embed is strictly atomic
// with no source-lift, so the caret never enters it and the `att:<hash>` token
// is never exposed as editable text. A user cannot type `|w=300` into an
// existing embed. Either these actions write it, or nothing does.
//
// Every write goes through `@myne/dialect/embedLayout`'s single emitter, and
// every write is one CodeMirror transaction, so one undo restores the previous
// layout exactly.

import { type EditorView } from "@codemirror/view";
import {
  type EmbedLayout,
  parseEmbedAlias,
  sameEmbedLayout,
} from "@myne/dialect/embedLayout";
import { emitAttachmentEmbed } from "@myne/editor/host/notes/attachmentRef";
import { attachmentEmbedRangeAt } from "./fileCardActions";

/** The current filename + layout of the embed hosted by `hostEl`, or null. */
export function readEmbedLayout(
  view: EditorView,
  hostEl: HTMLElement,
  id: string,
): { filename: string; layout: EmbedLayout; unknown: readonly string[]; from: number; to: number } | null {
  // Located by LIVE document position and re-resolved through the syntax tree,
  // exactly as `removeFileCard` does. A text search for the embed would misfire
  // onto a different occurrence of the same attachment in the same note.
  const span = attachmentEmbedRangeAt(view.state, view.posAtDOM(hostEl), id);
  if (span === null) return null;
  // The alias comes from the syntax tree, not from slicing the raw source. The
  // hand-rolled version of this ("first pipe, minus the trailing `]]`") was a
  // third site hardcoding the form-C byte layout, and it swallowed a `#heading`
  // or `^blockid` anchor that the tree models separately.
  const { filename, layout, unknown } = parseEmbedAlias(span.alias);
  return { filename, layout, unknown, from: span.from, to: span.to };
}

/**
 * Apply `mutate` to this embed's layout and write the result back in ONE
 * transaction. A no-op when the position no longer resolves to this embed, and
 * a no-op when the mutation changes nothing (so re-selecting an inactive row
 * does not push an empty entry onto the undo stack).
 */
export function updateEmbedLayout(
  view: EditorView,
  hostEl: HTMLElement,
  id: string,
  mutate: (current: EmbedLayout) => EmbedLayout,
): void {
  const current = readEmbedLayout(view, hostEl, id);
  if (current === null) return;

  const next = mutate(current.layout);
  if (sameEmbedLayout(next, current.layout)) return;

  view.dispatch({
    changes: {
      from: current.from,
      to: current.to,
      // `current.unknown` is carried through verbatim. Without it, every layout
      // edit would delete a segment written by a newer client (or a fragment of
      // a filename containing both a pipe and an equals sign).
      insert: emitAttachmentEmbed(id, current.filename, next, current.unknown),
    },
    userEvent: "input.attachment-embed-layout",
  });
}

/** True iff `layout` already carries exactly this width, so the row is active
 *  and selecting it again should clear rather than rewrite. */
export function hasWidth(layout: EmbedLayout, px: number | null, percent: number | null): boolean {
  return layout.widthPx === px && layout.widthPercent === percent;
}

/** Set a pixel width, or clear both width forms when it is already active. */
export function toggleWidthPx(px: number) {
  return (current: EmbedLayout): EmbedLayout =>
    hasWidth(current, px, null)
      ? { ...current, widthPx: null, widthPercent: null }
      : { ...current, widthPx: px, widthPercent: null };
}

/** Set a percentage width, or clear it when it is already active. */
export function toggleWidthPercent(percent: number) {
  return (current: EmbedLayout): EmbedLayout =>
    hasWidth(current, null, percent)
      ? { ...current, widthPx: null, widthPercent: null }
      : { ...current, widthPx: null, widthPercent: percent };
}

/** Set an alignment, or clear it when it is already active. */
export function toggleAlign(align: NonNullable<EmbedLayout["align"]>) {
  return (current: EmbedLayout): EmbedLayout => ({
    ...current,
    align: current.align === align ? null : align,
  });
}

/** Set (or clear) the alt text. An empty string is a REAL value: it marks the
 *  image decorative. Clearing back to the filename default is `null`. */
export function setAlt(alt: string | null) {
  return (current: EmbedLayout): EmbedLayout => ({ ...current, alt });
}

/**
 * Validate a custom-size string against the SAME closed grammar the parser
 * enforces, by round-tripping it through the parser rather than re-implementing
 * the rules. Returns null when the value is not accepted, so the caller can
 * refuse it visibly instead of writing something the parser would then drop.
 */
export function parseWidthInput(
  raw: string,
): { px: number | null; percent: number | null } | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const { layout, dropped } = parseEmbedAlias(`x|w=${trimmed}`);
  if (dropped.length > 0) return null;
  if (layout.widthPx === null && layout.widthPercent === null) return null;
  return { px: layout.widthPx, percent: layout.widthPercent };
}
