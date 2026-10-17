// Import markdown files dropped onto a sidebar folder (MYND-629).
//
// Getting a handful of `.md` files into a specific folder previously meant the
// full importer flow — pick a source, point it at a directory, map folders —
// which is built for migrating a vault, not for the far commoner "I have three
// notes here, put them in that folder". Dropping them is the gesture people
// already try first.
//
// This is deliberately NOT the importer. No adapter, no folder mapping, no
// import report: each file becomes one note, filed where it was dropped, with
// its filename as the title. Anything larger than that is still the importer's
// job, and the source picker remains the way in.
//
// Native OS drag-drop stays OFF (`dragDropEnabled: false` in
// `tauri.conf.json`), so the WebView receives the drop as an ordinary HTML5
// `DataTransfer` and we read the bytes in-process. No filesystem path ever
// crosses IPC, and nothing here can reach outside what the user dropped.

import { createNoteFromBody } from "./newNoteFromTemplate";

/** Extensions accepted as note bodies. Everything else is skipped — an image
 *  belongs in the attachment pipeline, not as a note. */
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".txt"];

/**
 * Refuse anything implausible as a hand-authored note before reading it, so a
 * mis-drop of a large binary cannot stall the WebView decoding it as text.
 * Well past any real markdown file.
 */
const MAX_BYTES = 8 * 1024 * 1024;

export interface DropImportResult {
  /** Notes created, in drop order. */
  created: string[];
  /** Files rejected, with the reason, for the caller's summary. */
  skipped: Array<{ name: string; reason: "type" | "too-large" | "failed" }>;
}

function isMarkdownFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Filename without its extension — the note's title. */
function titleFromFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.trim() === "" ? name : stem.trim();
}

/**
 * Create one note per dropped markdown file, filed into `folder` (`null` = the
 * vault root).
 *
 * Best-effort per file: one unreadable file does not abandon the rest, because
 * a partial import the user can see is better than an all-or-nothing failure
 * on a drop of ten. Files are imported sequentially — `note_create` is a disk
 * write per note, and a parallel burst on a large drop would contend for the
 * same vault directory for no user-visible gain.
 */
export async function importDroppedMarkdown(
  files: readonly File[],
  folder: string | null,
): Promise<DropImportResult> {
  const result: DropImportResult = { created: [], skipped: [] };

  for (const file of files) {
    if (!isMarkdownFile(file)) {
      result.skipped.push({ name: file.name, reason: "type" });
      continue;
    }
    if (file.size > MAX_BYTES) {
      result.skipped.push({ name: file.name, reason: "too-large" });
      continue;
    }
    try {
      const body = await file.text();
      const id = await createNoteFromBody(body, titleFromFilename(file.name), folder);
      result.created.push(id);
    } catch {
      // Reason deliberately coarse: the caller surfaces a count, and the
      // underlying error can carry a filesystem path (secret-handling
      // discipline), so it must not be threaded into the UI.
      result.skipped.push({ name: file.name, reason: "failed" });
    }
  }

  return result;
}
