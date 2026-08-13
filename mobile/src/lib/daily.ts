// Daily notes — the mobile port of the desktop `src/notes/dailyNote.ts` +
// `newNoteFromTemplate.ts`. Pure resolver (clock injected as `now`) + create
// helpers over the byte-exact template engine + frontmatter surgery, so a daily
// note created on mobile matches desktop (folder/title/template identical).

import { renderTemplate } from "../dialect/templateEngine";
import { patchTitleField, patchFolderField } from "../dialect/surgery";
import { locateFrontmatter } from "../dialect/lezer/frontmatter";
import { normalizeFolderPath, foldSegment, folderKey } from "../dialect/folderPath";
import {
  formatLocalDate,
  formatLocalTime,
  formatLocalDateTime,
  formatLocalWeekday,
} from "./localDateTime";
import { noteRead, noteCreate } from "./notes";
import { stampUpdated } from "./note-organize";

export const DEFAULT_DAILY_FOLDER = "Daily/";
export const DEFAULT_DAILY_DATE_FORMAT = "YYYY-MM-DD";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Format `now` into a date title. Tokens `YYYY`/`MM`/`DD` (local clock),
 *  longest-first; other chars pass through. */
export function formatDailyDate(now: Date, format: string): string {
  return format
    .replace(/YYYY/g, String(now.getFullYear()))
    .replace(/MM/g, pad2(now.getMonth() + 1))
    .replace(/DD/g, pad2(now.getDate()));
}

export type DailyResolution =
  | { kind: "open"; id: string; dateTitle: string }
  | { kind: "create"; dateTitle: string; folder: string | null };

/** A live note candidate for daily-note matching. */
export interface DailyCandidate {
  id: string;
  title: string;
  folder: string | null;
}

/** Idempotent open-or-create resolver for today's note. Pure (clock = `now`).
 *  Match = folder + date-title under case-fold. Caller passes only LIVE notes. */
export function resolveTodayNote(
  now: Date,
  dailyDateFormat: string | null,
  dailyFolder: string | null,
  notes: readonly DailyCandidate[],
): DailyResolution {
  const dateTitle = formatDailyDate(now, dailyDateFormat ?? DEFAULT_DAILY_DATE_FORMAT);
  const folderNorm = normalizeFolderPath(dailyFolder ?? DEFAULT_DAILY_FOLDER);
  const wantFolder = folderNorm == null ? "" : foldSegment(folderNorm);
  const wantTitle = foldSegment(dateTitle);
  for (const n of notes) {
    if (folderKey(n.folder) !== wantFolder) continue;
    if (foldSegment(n.title) !== wantTitle) continue;
    return { kind: "open", id: n.id, dateTitle };
  }
  return { kind: "create", dateTitle, folder: folderNorm };
}

// ── Create ──────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();

function buildRenderContext(now: Date, title: string) {
  return {
    title,
    date: formatLocalDate(now),
    time: formatLocalTime(now),
    datetime: formatLocalDateTime(now),
    weekday: formatLocalWeekday(now),
  };
}

/** Strip the template's frontmatter block (+ one leading blank line). */
function extractTemplateBody(plaintext: string): string {
  const fm = locateFrontmatter(plaintext);
  if (fm === null) return plaintext;
  let body = plaintext.slice(fm.blockEnd);
  if (body.startsWith("\n")) body = body.slice(1);
  return body;
}

async function createNoteFromBody(body: string, name: string, folder: string | null): Promise<string> {
  let bytes: Uint8Array = enc.encode(body);
  bytes = patchTitleField(bytes, name);
  const nf = normalizeFolderPath(folder);
  if (nf !== null) bytes = patchFolderField(bytes, nf);
  return await noteCreate(stampUpdated(dec.decode(bytes)));
}

/** Create a blank note with a given title + folder; resolves to the new id. */
export async function createBlankNamedNote(name: string, folder: string | null): Promise<string> {
  return createNoteFromBody("", name, folder);
}

/** Instantiate a template note (render `{{tokens}}`) with a title + folder. The
 *  new note carries neither the template's `template:` flag nor its title. */
export async function createNoteFromTemplate(
  templateId: string,
  name: string,
  folder: string | null,
  now: Date,
): Promise<string> {
  const body = extractTemplateBody(await noteRead(templateId));
  const rendered = renderTemplate(body, buildRenderContext(now, name));
  return createNoteFromBody(rendered, name, folder);
}
