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
import {
  clearInsertPlaceholder,
  insertPlaceholderPos,
  showInsertPlaceholder,
} from "./insert-placeholder";
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
  const at = insertAt ?? view.state.selection.main.head;

  // Anchor at a CM-MAPPED position BEFORE opening the picker (myne#332).
  //
  // `/attach` hands in the slash trigger's offset, and a native file dialog has
  // no time bound at all — so by the time it returns, the caret has typically
  // moved and any edit above the trigger has shifted every later offset. The
  // embed then landed before the text the user had just typed, or mid-word at
  // an unrelated spot, possibly off-screen; the clamp to `doc.length` kept the
  // dispatch in range but not correct, and the wrong content was autosaved with
  // no error surfaced.
  //
  // The placeholder is the same change-mapped anchor the paste and drop routes
  // already use — this was the one import route without one. It has to go up
  // BEFORE the await, not between the picker and the import, because the whole
  // window that moves the document is the one the dialog is open for.
  // Decoration-only, so the note bytes stay clean whatever happens next.
  const token = showInsertPlaceholder(view, at, "importing");
  const anchored = (): number => insertPlaceholderPos(view, token) ?? at;

  let selected: PickedFile[] | null;
  try {
    selected = await openFn();
  } catch {
    clearInsertPlaceholder(view, token);
    showAttachmentToast(i18n.t("editor.attachment.picker.openFailed"), "error");
    return;
  }
  if (selected === null || selected.length === 0) {
    clearInsertPlaceholder(view, token); // cancelled
    return;
  }

  const sources: ImportSource[] = selected.map((file) => ({ kind: "picked", file }));
  let outcomes;
  let insertPos = at;
  try {
    outcomes = await importMany(sources);
  } finally {
    insertPos = anchored();
    clearInsertPlaceholder(view, token);
  }

  insertEmbedsForOutcomes(view, outcomes, insertPos);

  const message = importToastMessage(outcomes);
  if (message !== null) showAttachmentToast(message);
}
