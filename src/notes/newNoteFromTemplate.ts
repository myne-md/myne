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
export function buildRenderContext(now: Date, title: string): RenderContext {
  return {
    title,
    date: formatLocalDate(now),
    time: formatLocalTime(now),
    datetime: formatLocalDateTime(now),
    weekday: formatLocalWeekday(now),
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
 */
export async function createNoteFromTemplate(
  templateId: string,
  name: string,
  folder: string | null = null,
  now: Date = new Date(),
): Promise<string> {
  const template = await noteRead(templateId);
  const body = extractTemplateBody(template);
  const rendered = renderTemplate(body, buildRenderContext(now, name));
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
