// desktop-ingest task 7 — the "clipped to root — view" success-notice builder
// (MYND-442, browser-extension epic, sub-feature `desktop-ingest`).
//
// WHAT THIS IS
// ------------
// The PURE projection from an `accepted` clip result to the success notice's
// content: the message line, the omitted-by-type tally (when media degraded),
// and the `noteId` the "view" affordance opens. Factored out of the React
// listener so the no-omission / with-omission notice shapes are unit-testable
// without a Tauri runtime or a DOM. No React, no IPC, no I/O — `(result) ->
// { message, tally, noteId }`.
//
// WHY A PROMINENT TALLY
// ---------------------
// A single clip losing its hero image is surprising (unlike a bulk import,
// where a per-type loss in a 200-note run is expected churn). So when ANY
// media was omitted, the notice renders a per-type tally PROMINENTLY — one
// labelled line per omitted class, driven straight off `result.counts.omitted`
// (the `MediaCounts` from `ingestClipImages`). With no omissions the tally is
// `null` and the notice is the bare "clipped to root — view" line.

import {
  CLIP_NOTICE_ROOT_MESSAGE,
  CLIP_NOTICE_VIEW_ACTION,
  clipOmittedTallyLine,
} from "../lib/load-bearing-copy";

import {
  compressionTallyMessage,
  emptyCompressionTally,
  type CompressionTally,
} from "../editor/attachments/insert";
import type { MediaByType, MediaClass, MediaCounts } from "../notes/import/media";
import type { ClipIngestResult } from "./assembleClip";

/** One omitted-by-type tally row: the media class + how many were dropped. */
export interface ClipNoticeTallyEntry {
  readonly mediaClass: MediaClass;
  readonly count: number;
  /** The rendered, load-bearing line for this entry (e.g. "1 image omitted"). */
  readonly line: string;
}

/** The fully-resolved success-notice content for an accepted clip. */
export interface ClipNotice {
  /** The primary line — the clip landed at the vault root. */
  readonly message: string;
  /** The label of the "view" affordance that opens the new note. */
  readonly viewLabel: string;
  /** The new note's id — what the "view" affordance opens. */
  readonly noteId: string;
  /** The per-type omitted tally, or `null` when nothing was omitted. A
   *  non-null tally always has ≥1 entry (the empty case collapses to `null`). */
  readonly tally: readonly ClipNoticeTallyEntry[] | null;
  /** The ingest-time-compression disclosure line, or `null` when nothing was
   *  compressed. A clipped image runs through the same shared-core transform a
   *  pasted one does — the original bytes are not kept — and `decisions.md`
   *  2026-07-30 makes a notice at import the thing that stands in for a consent
   *  gate, so the clip notice owes it too. i18n'd, unlike the omitted tally
   *  above: that one is load-bearing copy pinned by E2E literal equality, this
   *  one is ordinary user-facing text. */
  readonly compressionLine: string | null;
}

// The stable presentation order of the media classes in the tally — the image
// class first (the surprising hero-image loss), then the rest. Keyed off the
// `MediaByType` axis so a new class can never silently drop out of the tally.
const TALLY_ORDER: readonly MediaClass[] = ["image", "pdf", "audio", "video", "other"];

/**
 * Project an accepted clip result to its success-notice content.
 *
 * @param result the `accepted` clip result — carries the new `noteId` and the
 *   `MediaCounts` (ingested + omitted-by-type) from the assembly pass.
 * @returns the notice's message + view label + noteId + the omitted tally
 *   (`null` when no media was omitted, so the notice is the bare root line).
 */
export function buildClipNotice(result: {
  readonly noteId: string;
  readonly counts: MediaCounts;
  /** Optional so the many existing callers that predate ingest-time
   *  compression stay valid; absent reads as "nothing compressed". */
  readonly compression?: CompressionTally;
}): ClipNotice {
  return {
    message: CLIP_NOTICE_ROOT_MESSAGE,
    viewLabel: CLIP_NOTICE_VIEW_ACTION,
    noteId: result.noteId,
    tally: buildTally(result.counts.omitted),
    compressionLine: compressionTallyMessage(result.compression ?? emptyCompressionTally()),
  };
}

/**
 * Build the per-type omitted tally from the `omitted` counts. Returns `null`
 * when every class is zero (no omissions → bare notice); otherwise one entry
 * per non-zero class, in {@link TALLY_ORDER}. Each entry's `line` is the
 * load-bearing rendered string (E2E asserts it by literal equality).
 */
function buildTally(omitted: MediaByType): readonly ClipNoticeTallyEntry[] | null {
  const entries: ClipNoticeTallyEntry[] = [];
  for (const mediaClass of TALLY_ORDER) {
    const count = omitted[mediaClass];
    if (count > 0) {
      entries.push({ mediaClass, count, line: clipOmittedTallyLine(mediaClass, count) });
    }
  }
  return entries.length > 0 ? entries : null;
}

/** Narrow an arbitrary clip result to its accepted arm, or `null`. A small
 *  convenience so the listener can guard + build in one step. */
export function noticeFromResult(result: ClipIngestResult): ClipNotice | null {
  return result.kind === "accepted" ? buildClipNotice(result) : null;
}
