// "Link this mention" write (knowledge-graph-ux #2 / MYND-196 task 4, SYNC-15
// invariant). Inserting `[[Title]]` into a mentioning note routes through the
// single canonical write path (`saveNote` → dialect-surgery, which stamps
// `updated:`). The insertion transform is matcher-consistent with
// `unlinkedMentions.ts`: it wraps the first contiguous, word-boundary, fold-
// identity occurrence in the note BODY (frontmatter is skipped) and preserves
// the original prose casing via a `[[Title|matched]]` alias when it differs.
//
// SYNC-15: NEVER write to an open+dirty note via disk (a last-writes-win disk
// save would clobber unsaved edits). The single-pane v1.1 editor exposes no
// live-buffer injection hook, so the fallback is the open-dirty GUARD (surface
// "save first"), NOT a defer/queue. `decideLinkWriteRoute` is the pure gate.

import { foldedTokenSpans, foldedWords } from "./foldTokens";
import { locateFrontmatter } from "../dialect/lezer/frontmatter";
import { noteRead } from "./readNote";
import { saveNote } from "./saveNote";

/** Spans of existing `[[…]]` wikilinks — a candidate match overlapping one of
 *  these must be skipped, else we'd nest `]]` (forbidden) and corrupt the note. */
const WIKILINK_RE = /\[\[[\s\S]*?\]\]/g;

function wikilinkSpans(s: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(s)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Wrap the FIRST safe body occurrence of `title` (contiguous folded-word phrase,
 * word-boundary) as a wikilink. Skips the frontmatter block AND any occurrence
 * that falls inside an existing `[[…]]` (wrapping there would produce malformed
 * nested links). Preserves the matched prose via a `[[Title|matched]]` alias
 * when it differs — but only when the matched span is free of wikilink
 * metacharacters (`[`, `]`, `|`), else it drops the alias rather than emit a
 * broken link. Returns the body UNCHANGED when there is no safe occurrence (the
 * caller then skips the write rather than stamping a no-op). Pure.
 */
export function insertWikilink(body: string, title: string): string {
  const titleFolds = foldedWords(title);
  if (titleFolds.length === 0) return body;

  const fm = locateFrontmatter(body);
  const bodyOffset = fm ? fm.blockEnd : 0;
  const tokens = foldedTokenSpans(body.slice(bodyOffset));
  const links = wikilinkSpans(body);

  outer: for (let i = 0; i + titleFolds.length <= tokens.length; i += 1) {
    for (let j = 0; j < titleFolds.length; j += 1) {
      if (tokens[i + j].fold !== titleFolds[j]) continue outer;
    }
    const start = bodyOffset + tokens[i].start;
    const end = bodyOffset + tokens[i + titleFolds.length - 1].end;
    // Skip a match that overlaps an existing wikilink (no nesting).
    if (links.some((l) => start < l.end && end > l.start)) continue;
    const matched = body.slice(start, end);
    const safeAlias = matched !== title && !/[[\]|]/.test(matched);
    const replacement = safeAlias
      ? `[[${title}|${matched}]]`
      : `[[${title}]]`;
    return body.slice(0, start) + replacement + body.slice(end);
  }
  return body;
}

export type LinkWriteRoute = "disk" | "guard";

/**
 * SYNC-15 routing gate. `guard` when the target is the currently-open note with
 * unsaved edits — disk-writing it would clobber the live buffer. Otherwise
 * `disk`. (Self is already excluded from the mention candidates, so this is
 * forward-safety for a future multi-pane editor.) Pure.
 */
export function decideLinkWriteRoute(
  targetNoteId: string,
  openNoteId: string | null,
  openNoteDirty: boolean,
): LinkWriteRoute {
  if (openNoteId !== null && targetNoteId === openNoteId && openNoteDirty) {
    return "guard";
  }
  return "disk";
}

/** Thrown when the target note is open+dirty and there is no buffer hook to
 *  write through — the UI surfaces "save first" rather than clobbering edits. */
export class OpenDirtyGuardError extends Error {
  readonly noteId: string;
  constructor(noteId: string) {
    super("Cannot link into an open note with unsaved edits — save it first.");
    this.name = "OpenDirtyGuardError";
    this.noteId = noteId;
  }
}

/**
 * Insert `[[titleToLink]]` into the mentioning note `targetNoteId`. Guards an
 * open+dirty target (throws {@link OpenDirtyGuardError} BEFORE any IPC), else
 * reads the body, wraps the first mention, and writes via the canonical
 * `saveNote` path (which stamps `updated:`).
 *
 * Returns `true` when a link was actually written, `false` when the transform
 * was a NO-OP (no raw occurrence — e.g. the mention only existed inside an
 * existing wikilink, or the body changed since the verify). The caller MUST
 * honor `false` by restoring its optimistically-removed row, else the UI lies
 * ("linked" but nothing was written).
 */
export async function linkMention(
  targetNoteId: string,
  titleToLink: string,
  ctx: { openNoteId: string | null; openNoteDirty: boolean },
): Promise<boolean> {
  if (
    decideLinkWriteRoute(targetNoteId, ctx.openNoteId, ctx.openNoteDirty) ===
    "guard"
  ) {
    throw new OpenDirtyGuardError(targetNoteId);
  }
  const body = await noteRead(targetNoteId);
  const next = insertWikilink(body, titleToLink);
  if (next === body) return false; // nothing inserted — caller restores the row
  await saveNote(targetNoteId, next);
  return true;
}
