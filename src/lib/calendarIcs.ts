// `.ics` exchange for the calendar: one file out, one file in (myne-md/myne#1037).
//
// The codec is `@myne/client-core`'s (`client-core/src/ics.ts`) and it is the ONE
// parser, shared by every client. This module is the part around it that touches
// a platform: a save dialog and a write, an open dialog and a read.
//
// # Why the host does the IO on desktop
//
// The bytes of a picked file must not make a round trip through the WebView
// (`editor/src/host.ts` `PickedFile`, TB3), and the file the user imports is
// attacker-supplied in the ordinary case (a shared invite), so the size cap has
// to be enforced while reading rather than after loading. Both are why the read is
// `plugin:export|import_text_file` and not a `FileReader` in the page.
//
// # Why the browser client has no import here
//
// `nativeSaveAs` is the capability this module gates on, and the browser client is
// in its ABSENT set: it has no path-taking save dialog, so an export would have to
// leave through the download seam (which `deliverFile` does, and this uses), and an
// import would need its own ingest. Writing the export arm and leaving the import
// door open on one side and not the other is the half-open shape the view-manifest
// export refuses by name, so the pair is desktop-only until the browser gets a
// matching ingest.
//
// # What this does NOT decide
//
// Nothing about what an event is: a row from the range read maps to an `IcsEvent`
// field for field, and an imported event goes to disk through `createEvent`, the
// same writer a click in the grid uses. A second writer would be a second opinion
// about the note's bytes.

import {
  ICS_BYTE_CAP,
  exportEvents,
  importEvents,
  type IcsEvent,
  type IcsImport,
} from "@myne/client-core";
import { invoke } from "../platform/core";
import { has } from "../platform/capabilities";
import { save as saveFileDialog } from "../platform/dialog";
import { pickFiles } from "../platform/filePicker";
import { deliverFile } from "../platform/download";
import { pathOf } from "./picked-file";
import type { CalendarRow } from "../notes/vaultIndices";

/** What a file read or written through the host answers. */
type ImportedText = { readonly name: string; readonly content: string };

/**
 * How wide the export's window is, in wall-clock dates.
 *
 * 1990-2100, not "everything": an export is "my calendar", and a note dated 1974 or
 * 2099 still belongs in it, but the host expands every series into one row per
 * occurrence before the caller collapses them back to one row per series. A
 * three-century window is therefore a request for tens of thousands of rows the
 * exporter throws away, and the read is the expensive half.
 *
 * A date outside the window is REFUSED rather than filtered here, so the user learns
 * the bound instead of exporting a file that silently omits their 1974 event.
 */
const EXPORT_WINDOW_START = "1990-01-01";
const EXPORT_WINDOW_END = "2100-12-31";

/**
 * Whether this host can IMPORT an `.ics` file.
 *
 * Import needs a path-taking open dialog, which the browser client has none of
 * (`icsImport` is in its ABSENT set). Export is deliberately not behind this
 * gate: a download needs no dialog, so the browser exports through
 * `platform/download.ts` and only the import affordance is hidden there.
 */
export function canImportIcs(): boolean {
  return has("icsImport");
}

/**
 * The rows to write, as `.ics` events.
 *
 * **A projected occurrence is skipped.** The host returns one row per instant a
 * repeating event lands on, and the file must carry the SERIES once with its
 * rule (`repeat`), or an import would create one note per week forever. The row
 * that carries the series is the one with no `occurrenceOf`, which is also the
 * one a write targets, so the two agree by construction.
 *
 * `uid` is the note's own `uid:` when it has one, because that is the identity the
 * file this event came from carried, and matching on it is what makes a re-import
 * idempotent. A hand-authored event has none, and its NOTE ID stands in: stable
 * across renames and unique in the vault, so a round trip through Myne still
 * matches on the way back in.
 */
function rowsToIcsEvents(rows: readonly CalendarRow[]): IcsEvent[] {
  return rows
    .filter((row) => row.occurrenceOf === null)
    .map((row) => ({
      uid: row.uid ?? row.noteId,
      title: row.title ?? "",
      start: row.start,
      end: row.end,
      allDay: row.allDay,
      // A rule outside the closed vocabulary is not exported as a rule: writing
      // it back would tell the next reader it is one.
      repeat: row.repeatUnrecognized ? null : row.repeat,
      description: null,
      remind: row.remind,
      calendar: row.calendar,
    }));
}

/** A sensible filename for a save dialog: never a path, never user-typed. */
function icsFilename(day: string): string {
  return `myne-calendar-${day}.ics`;
}

/**
 * Write `rows` as one `.ics` file.
 *
 * Resolves `"saved"` (reported in a toast by basename only), `"cancelled"` when
 * the dialog was dismissed, which writes nothing and says nothing, or `"failed"`.
 */
export async function exportIcsFile(
  rows: readonly CalendarRow[],
  day: string,
): Promise<"saved" | "cancelled" | "failed"> {
  const events = rowsToIcsEvents(rows);
  if (events.length === 0) {
    toastIdle();
    return "failed";
  }
  const text = exportEvents(events);
  const name = icsFilename(day);

  if (!has("nativeSaveAs")) {
    // The browser's arm: one user-initiated download, same bytes, same file name.
    try {
      await deliverFile(name, new TextEncoder().encode(text), "text/calendar");
    } catch {
      toastFailed();
      return "failed";
    }
    toastSaved(name, events.length);
    return "saved";
  }

  const target = await saveFileDialog({
    defaultPath: name,
    filters: [{ name: "iCalendar", extensions: ["ics"] }],
  });
  if (typeof target !== "string") return "cancelled";
  try {
    // The dialog's own "Replace" prompt is the consent, the same rule every
    // export in this tree follows.
    await invoke<void>("plugin:text-file|export_text_file", {
      content: text,
      targetPath: target,
      overwrite: true,
    });
  } catch {
    toastFailed();
    return "failed";
  }
  const basename = target.split(/[/\\]/).pop() ?? target;
  toastSaved(basename, events.length);
  return "saved";
}

/**
 * Read one `.ics` file the user picks.
 *
 * Resolves `null` when the picker was dismissed, and the codec's own answer
 * otherwise: a refusal is a named condition the caller reports, and half an
 * import is worse than none.
 */
export async function readIcsFile(): Promise<{
  readonly name: string;
  readonly result: IcsImport;
} | null> {
  const picked = await pickFiles({
    extensions: ["ics"],
    filterLabel: "iCalendar",
  });
  const file = picked?.[0];
  if (file === undefined) return null;
  const imported: ImportedText = await invoke<ImportedText>(
    "plugin:text-file|import_text_file",
    { targetPath: pathOf(file) },
  );
  // The zone is the device's own, and the conversion happens once, here: the
  // note stores the wall clock that instant reads as on this machine
  // (`decisions/editor/0793`).
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { name: imported.name, result: importEvents(imported.content, { zone }) };
}

/** The read cap, so a caller can say what the bound is rather than "too large". */
export const ICS_IMPORT_CAP_BYTES = ICS_BYTE_CAP;

function toastSaved(filename: string, count: number): void {
  void import("../i18n").then(({ default: i18n }) => {
    void import("../components/toast/toastStore").then(({ toast }) => {
      toast({
        message: i18n.t("calendar.exported", { filename, count }),
        variant: "success",
        testId: "calendar.ics-toast",
      });
    });
  });
}

function toastFailed(): void {
  void import("../i18n").then(({ default: i18n }) => {
    void import("../components/toast/toastStore").then(({ toast }) => {
      toast({
        message: i18n.t("calendar.exportFailed"),
        variant: "error",
        testId: "calendar.ics-toast",
      });
    });
  });
}

function toastIdle(): void {
  void import("../i18n").then(({ default: i18n }) => {
    void import("../components/toast/toastStore").then(({ toast }) => {
      toast({
        message: i18n.t("calendar.exportEmpty"),
        variant: "error",
        testId: "calendar.ics-toast",
      });
    });
  });
}

/** The visible window an export covers, so a caller does not restate it. */
export const ICS_EXPORT_WINDOW = {
  start: EXPORT_WINDOW_START,
  end: EXPORT_WINDOW_END,
} as const;
