// New-note-from-template instantiation flow (MYND-190).
//
// The pure orchestration seam every "new note from template" surface converges
// on (SYNC-10, split-path). Given a template note id, a user-supplied name, and
// the active create-context folder, it:
//   1. reads the template, extracts its body (the content after the frontmatter);
//   2. renders the body's `{{...}}` tokens ONCE, eagerly, at the creation instant
//      via the TS variable engine (`{{title}}` from the name; date/time/datetime/
//      weekday in LOCAL time injected host-side; unknown tokens left literal);
//   3. writes the name as the new note's `title:` frontmatter (so this path skips
//      inline-rename) and threads the same `folder` a blank note would use;
//   4. creates the note via the existing `note_create` IPC as opaque plaintext —
//      no format change, no new magic byte / AAD touch, no new Tauri command.
// The created note carries NEITHER the template's `template:` flag NOR the
// template's own title — it is an ordinary note seeded from the template body.
//
// No clock/locale lives in the variable engine (`dialect/templateEngine.ts` is a
// pure mirror of the `#![no_std]` Rust engine). The clock + locale read happens
// HERE, host-side, in `buildRenderContext`.

import { renderTemplate, type RenderContext } from "../dialect/templateEngine";
import { patchFolderField, patchTitleField } from "../dialect";
import { locateFrontmatter } from "../dialect/lezer/frontmatter";
import { noteRead } from "./readNote";
import { noteCreate } from "./createNote";
import { normalizeFolderPath } from "../dialect/folderPath";
import {
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  formatLocalWeekday,
} from "./localDateTime";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Build the host-injected {@link RenderContext} from a wall-clock instant and a
 * note name. All time-derived fields are formatted in **local** time (so a note
 * created at 01:00 local in a positive UTC offset stamps today's local calendar
 * day, never the previous UTC day) via the shared `localDateTime` helpers — the
 * same source of truth the `/date` `/day` `/time` `/now` slash commands use.
 * `weekday` follows the host locale (the app-language proxy until an in-app
 * language setting lands).
 */
/** The period a note made by HAND belongs to: the single day it was made on.
 *
 * A named function rather than an inline `{ start: now, end: now }`, because the
 * two call sites that use it are making a claim (`{{period_start}}` and
 * `{{period_end}}` both mean today here) and an anonymous object literal reads
 * like a placeholder. It is also what lets `buildRenderContext`'s `period` be
 * required: the meaning did not disappear with the default, it moved to the
 * caller that means it. */
export function singleDay(now: Date): { start: Date; end: Date } {
  return { start: now, end: now };
}

export function buildRenderContext(
  now: Date,
  title: string,
  // REQUIRED, and that is the correction rather than an inconvenience. This
  // read `period?: {...}` with a `?? now` fallback below, which is the shape the
  // root `CLAUDE.md` records under "a guard parameter with a default value is an
  // opt-in guard": a future weekly or monthly create path that omits it renders
  // both period tokens as TODAY, with no type error, no failing test and a
  // plausible-looking title. Requiring it makes the compiler name every call
  // site, the way the Rust side already does. The single-day meaning is not
  // lost, it moved: `singleDay(now)` says it at the call site that means it.
  period: { start: Date; end: Date },
): RenderContext {
  return {
    title,
    date: formatLocalDate(now),
    time: formatLocalTime(now),
    datetime: formatLocalDateTime(now),
    weekday: formatLocalWeekday(now),
    // myne#177. Absent `period`, the period is the single day `now` falls on,
    // which is exactly right for a daily note and for a note made by hand, and
    // is why the two tokens are never empty. `{{date}}` is deliberately NOT
    // re-pointed at the period start: the same template file can be both a
    // weekly template and something instantiated by hand, and a token whose
    // meaning depended on the call site would make one file say two things.
    periodStart: formatLocalDate(period.start),
    periodEnd: formatLocalDate(period.end),
  };
}

/**
 * Extract a template note's body — the content after its frontmatter block.
 * Strips the single canonical blank-line separator the FM block leaves so the
 * rebuilt note doesn't accumulate a double blank line. Returns the whole input
 * unchanged when there is no frontmatter.
 */
export function extractTemplateBody(plaintext: string): string {
  const fm = locateFrontmatter(plaintext);
  if (fm === null) return plaintext;
  let body = plaintext.slice(fm.blockEnd);
  if (body.startsWith("\n")) body = body.slice(1);
  return body;
}

/**
 * Instantiate a new note from a template: render the template body's tokens,
 * title it with `name`, place it in `folder` (null = the vault root, exactly
 * where a blank note from the same context would land), and create it via
 * `note_create`. Returns the new `NoteId`. `name` must be non-blank — an empty
 * name is not a valid entry into this flow (`{{title}}` is only meaningful with a
 * real title). Rejects with whatever `noteRead` / `noteCreate` propagate.
 *
 * `now` is REQUIRED, and deliberately so (`CLAUDE.md`, "A guard parameter with a
 * default value is an opt-in guard"). It used to default to `new Date()`, which
 * meant a test could pass a fixed instant and prove the rendering while the two
 * production call sites went on reading the wall clock, unchecked — and one of
 * them, the daily-notes branch, had already resolved the note's TITLE from a
 * different `new Date()` a few statements earlier, so a call straddling midnight
 * would stamp yesterday's title on a note whose `{{date}}` said today. The
 * mobile twin (`mobile/src/lib/daily.ts`) has always required it; the compiler
 * now names every desktop site instead of excusing them in advance.
 */
export async function createNoteFromTemplate(
  templateId: string,
  name: string,
  // No defaults on either, and `period` required below: reaching `period` means
  // passing both positionally, so the defaults these two used to carry were
  // already dead the moment that parameter landed. Removing them says so.
  folder: string | null,
  now: Date,
  // LAST, and deliberately: this parameter was added after the function had
  // positional callers, and inserting it before `now` re-bound every one of
  // them silently (`tests/` is outside `tsc`'s `include`, so only Vitest reads
  // those call sites).
  //
  // REQUIRED for the reason `buildRenderContext`'s own parameter is. A caller
  // that means "today" says `singleDay(now)` rather than saying nothing.
  period: { start: Date; end: Date },
): Promise<string> {
  const template = await noteRead(templateId);
  const body = extractTemplateBody(template);
  const rendered = renderTemplate(body, buildRenderContext(now, name, period));
  return await createNoteFromBody(rendered, name, folder);
}

/**
 * Create a blank note titled `name` in `folder` (null = root) via the existing
 * `note_create` IPC — an empty body, no template, no token rendering. Used by
 * the daily-notes flow's "no daily template" branch (MYND-191): a daily note
 * created blank with only the date as its title. Returns the new `NoteId`.
 */
export async function createBlankNamedNote(
  name: string,
  folder: string | null = null,
): Promise<string> {
  return await createNoteFromBody("", name, folder);
}

/**
 * Shared tail of {@link createNoteFromTemplate} / {@link createBlankNamedNote}:
 * title `body` with `name`, file it in `folder` (null = root), and create it via
 * the existing `note_create` IPC. A blank note is just "template-with-empty-body"
 * — keeping the title/folder surgery + create in one place so an ordering change
 * lands once.
 */
/** Create a note from an explicit body + title + folder. Exported for the
 *  drag-drop markdown import (MYND-629), which has the same shape as a
 *  template instantiation: known body, known name, known destination. */
export async function createNoteFromBody(
  body: string,
  name: string,
  folder: string | null,
): Promise<string> {
  // Wide annotation: TS 6.0's typed-array buffer generic otherwise rejects
  // reassigning the bare-`Uint8Array` patch returns onto the `<ArrayBuffer>`
  // that `encoder.encode()` infers.
  let bytes: Uint8Array = encoder.encode(body);
  bytes = patchTitleField(bytes, name);
  const normalizedFolder = normalizeFolderPath(folder);
  if (normalizedFolder !== null) {
    bytes = patchFolderField(bytes, normalizedFolder);
  }
  return await noteCreate(decoder.decode(bytes), normalizedFolder);
}
