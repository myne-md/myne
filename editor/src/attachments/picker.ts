// File-picker insert (`/attach`, epic MYND-164, sub-feature attachment-insert;
// decision 4).
//
// Opens the native file picker (all files, multi-select), imports each chosen
// path via `attachment_import` (`{kind:"path"}` — the host reads the file +
// derives the display filename from the final path component), inserts a
// form-C embed per success at the cursor, and surfaces the same partial-success
// toast as paste/drop. A single command surface (not type-split): one `/attach`
// slash item + (at integration) one palette action share this entry point.
//
// Since MYND-173 the host accepts any file bytes (a non-allowlisted type is
// stored as an opaque, export-only attachment), so the picker no longer
// restricts the dialog to image/PDF extensions — `filters` is omitted and the
// native dialog offers all files.
//
// `dialog:allow-open` is already granted in `src-tauri/capabilities/default.json`.

import { EditorView } from "@codemirror/view";
import { getHost, type PickedFile } from "../host";
import i18n from "@myne/editor/i18n";
import { type ImportSource, importMany, importToastMessage } from "./insert";
import { insertEmbedsForOutcomes } from "./paste-drop";
import { showAttachmentToast } from "./toast";

/** The picker call, isolated so tests can override it without a host.
 *
 * Yields opaque {@link PickedFile} handles rather than path strings
 * (phase3-web-client task 76) — a browser picker produces a `File`, and a
 * path-shaped seam compiles on web and fails at runtime. */
type OpenFn = () => Promise<PickedFile[] | null>;

let openFn: OpenFn = async () => {
  const pick = getHost().attachments.pickFiles;
  // A host with no picker at all: treat as "cancelled" rather than throwing.
  // The `/attach` command is gated on the same absence upstream; this is the
  // belt for a stale keybinding reaching a host that cannot pick.
  if (pick === undefined) return null;
  return pick({ multiple: true });
};

/** Override the picker (tests only). Returns a restore fn. */
export function setPickerFn(fn: OpenFn): () => void {
  const prev = openFn;
  openFn = fn;
  return () => {
    openFn = prev;
  };
}

/**
 * Open the picker, import every chosen file, and insert form-C embeds at
 * `insertAt` (defaults to the current cursor). Cancelling the picker is a
 * silent no-op. Surfaces the partial-success toast for multi-file imports.
 */
export async function pickAndInsert(view: EditorView, insertAt?: number): Promise<void> {
  let selected: PickedFile[] | null;
  try {
    selected = await openFn();
  } catch {
    showAttachmentToast(i18n.t("editor.attachment.picker.openFailed"));
    return;
  }
  if (selected === null || selected.length === 0) return; // cancelled

  const at = insertAt ?? view.state.selection.main.head;
  const sources: ImportSource[] = selected.map((file) => ({ kind: "picked", file }));
  const outcomes = await importMany(sources);

  insertEmbedsForOutcomes(view, outcomes, at);

  const message = importToastMessage(outcomes);
  if (message !== null) showAttachmentToast(message);
}
