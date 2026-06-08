// File-picker insert (`/attach`, epic MYND-164, sub-feature attachment-insert;
// decision 4).
//
// Opens the native file picker (allowlist-filtered, multi-select), imports each
// chosen path via `attachment_import` (`{kind:"path"}` — the host reads the
// file + derives the display filename from the final path component), inserts a
// form-C embed per success at the cursor, and surfaces the same partial-success
// toast as paste/drop. A single command surface (not type-split): one `/attach`
// slash item + (at integration) one palette action share this entry point.
//
// `dialog:allow-open` is already granted in `src-tauri/capabilities/default.json`.

import { EditorView } from "@codemirror/view";
import { open } from "@tauri-apps/plugin-dialog";
import { type ImportSource, importMany, summarizeBatch } from "./insert";
import { insertEmbedsForOutcomes } from "./paste-drop";
import { showAttachmentToast } from "./toast";

/** The import allowlist as picker extension filters (raster + SVG + PDF). The
 *  host re-sniffs by content; this is just the OS dialog's display filter. */
const PICKER_FILTERS = [
  {
    name: "Attachments",
    extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf"],
  },
];

/** The dialog `open` call, isolated so tests can override it without Tauri. */
type OpenFn = () => Promise<string[] | null>;

let openFn: OpenFn = () =>
  open({ multiple: true, directory: false, filters: PICKER_FILTERS }) as Promise<
    string[] | null
  >;

/** Override the picker (tests only). Returns a restore fn. */
export function setPickerFn(fn: OpenFn): () => void {
  const prev = openFn;
  openFn = fn;
  return () => {
    openFn = prev;
  };
}

/**
 * Open the picker, import every chosen file by path, and insert form-C embeds
 * at `insertAt` (defaults to the current cursor). Cancelling the picker is a
 * silent no-op. Surfaces the partial-success toast for multi-file imports.
 */
export async function pickAndInsert(view: EditorView, insertAt?: number): Promise<void> {
  let selected: string[] | null;
  try {
    selected = await openFn();
  } catch {
    showAttachmentToast("Couldn't open the file picker.");
    return;
  }
  if (selected === null || selected.length === 0) return; // cancelled

  const at = insertAt ?? view.state.selection.main.head;
  const sources: ImportSource[] = selected.map((path) => ({ kind: "path", path }));
  const outcomes = await importMany(sources);

  insertEmbedsForOutcomes(view, outcomes, at);

  const summary = summarizeBatch(outcomes);
  if (summary !== null) showAttachmentToast(summary);
}
