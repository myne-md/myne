// Obsidian importer — media-ref handling (hybrid auto-ingest, SYNC-7).
//
// Sub-feature 4 of the obsidian-importer epic (MYND-52), tasks 1–3.
//
// For each LOCAL media ref in an imported note body (found via the shipped
// `findImportedImageRefs` — `![[image.png]]` / `![alt](path)`), the importer
// either INGESTS it (resolvable + allowlisted + in-cap → `attachment_import`,
// then rewrite in place to form C `![[att:<id>|filename]]`, the exact form the
// shipped import-&-convert produces) or falls back to a placeholder comment +
// an omitted-by-type tally (audio/video/missing/oversize/unsupported). The
// resolve+import step is injected as a `RefImporter` so this module is unit-
// testable and adds no Tauri capability; the real importer resolves the path
// against the source vault dir and calls `attachment_import {kind:"path"}` (the
// host reads it — SYNC-1, never WebView fs-read).
//
// REMOTE URLs: `findImportedImageRefs` excludes URL-bearing refs (`http(s):`,
// `data:`, etc.), so remote media is left as raw markdown — never fetched (the
// anti-feature is upheld) and never placeholder-rewritten (more C1-preserving
// than replacing valid portable markdown). It is therefore not in the omitted
// tally. This is a deliberate, documented deviation from the task's
// "remote → placeholder": the shipped ref-finder's URL exclusion makes
// leave-raw the faithful behavior.
//
// C1: every byte outside the rewritten ref spans + residual placeholders is
// preserved verbatim (the SYNC-9 sanctioned-diff allowlist).

import {
  findImportedImageRefs,
  planRewrite,
  tallyCompression,
  type CompressionTally,
  type ImportedImageRef,
  type ImportedAttachment,
} from "../../editor/attachments/insert";

export type MediaClass = "image" | "pdf" | "audio" | "video" | "other";

/** Per-class counts (SVG counts under `image`; the axis is the user-meaningful media class). */
export interface MediaByType {
  image: number;
  pdf: number;
  audio: number;
  video: number;
  other: number;
}

export interface MediaCounts {
  ingested: MediaByType;
  omitted: MediaByType;
}

export function emptyMediaByType(): MediaByType {
  return { image: 0, pdf: 0, audio: 0, video: 0, other: 0 };
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "mkv", "avi"]);

/** Classify a media source path by extension into a user-meaningful class. */
export function classifyMediaType(source: string): MediaClass {
  const base = source.split(/[/\\]/).pop() ?? source;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  return "other";
}

/** Resolve + import one ref's source. Injected (real impl = resolve-against-
 *  source-dir + `attachment_import {kind:"path"}`; tests inject a fake). */
export type RefImporter = (
  ref: ImportedImageRef,
) => Promise<{ ok: true; attachment: ImportedAttachment } | { ok: false }>;

/** The placeholder comment that replaces a non-ingestable local media ref. */
export function placeholderComment(ref: ImportedImageRef): string {
  return `<!-- omitted attachment: ${ref.source} -->`;
}

interface TextEdit {
  from: number;
  to: number;
  replacement: string;
}

/** Apply edits to `body` back-to-front (descending `from`) so offsets stay
 *  valid. Byte-preserving outside the edited spans. */
export function applyTextRewrites(body: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.from - a.from);
  let out = body;
  for (const e of ordered) {
    out = out.slice(0, e.from) + e.replacement + out.slice(e.to);
  }
  return out;
}

export interface MediaResult {
  /** The body with ingestable refs rewritten to form C + residual refs placeholder-commented. */
  body: string;
  counts: MediaCounts;
  /** How much ingest-time image compression this note's media pass performed.
   *  Compression is gated in shared core, so an import ingests through exactly
   *  the same transform a paste does — and `decisions.md` 2026-07-30 makes a
   *  notice at import the thing that stands in for a consent gate, so a route
   *  that imports in bulk owes the user a tally rather than silence. Additive,
   *  so the engine folds it across every note it creates. */
  compression: CompressionTally;
}

/**
 * Process the local media refs in an imported note body: ingest the ingestable
 * subset (rewrite to form C) and placeholder-comment the residual, returning the
 * transformed body + the ingested/omitted-by-type counts (the SYNC-2 media slice).
 */
export async function processImportedMedia(
  body: string,
  importRef: RefImporter,
): Promise<MediaResult> {
  const refs = findImportedImageRefs(body);
  const ingested = emptyMediaByType();
  const omitted = emptyMediaByType();
  const edits: TextEdit[] = [];
  const stored: ImportedAttachment[] = [];

  for (const ref of refs) {
    const cls = classifyMediaType(ref.source);
    const outcome = await importRef(ref);
    if (outcome.ok) {
      const { replacement } = planRewrite(ref, outcome.attachment);
      edits.push({ from: ref.from, to: ref.to, replacement });
      ingested[cls]++;
      stored.push(outcome.attachment);
    } else {
      edits.push({ from: ref.from, to: ref.to, replacement: placeholderComment(ref) });
      omitted[cls]++;
    }
  }

  return {
    body: applyTextRewrites(body, edits),
    counts: { ingested, omitted },
    compression: tallyCompression(stored),
  };
}
