// Wiring for the import-&-convert command (epic MYND-164, sub-feature
// attachment-insert; decision 5).
//
// Provides the `RefImporter` that `convert.ts` orchestrates around: for each
// imported ref, try the literal/auto-resolve path first (hand it to
// `attachment_import` as a path source — the host reads the file). If the host
// can't read it (an `Io` rejection = source not found at that path), fall back
// to a single-select file picker so the user can point at the source; then
// import that. This auto-resolve→picker fallback adds NO new Tauri capability
// (no frontend `fs:exists` probe — the host's own read is the resolution test).
//
// `runImportAndConvert` is the command entry point — invoked from the editor
// keymap today; at integration it is the one-line palette action the parent
// agent adds (the deferred-palette TODO).

import { EditorView } from "@codemirror/view";
import { open } from "@tauri-apps/plugin-dialog";
import i18n from "@myne/editor/i18n";
import {
  type ImportSource,
  type ImportedAttachment,
  type ImportedImageRef,
  importOne,
} from "./insert";
import { type RefImporter, convertImportedRefs, importSkipNote } from "./convert";

const PICKER_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf"];

/** Single-file picker seam (tests override). Returns the chosen path or null. */
type PickOneFn = (ref: ImportedImageRef) => Promise<string | null>;

let pickOneFn: PickOneFn = async () => {
  // Resolve the filter label at usage time so a mid-session language switch is
  // reflected in the native picker (never frozen at module load).
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      {
        name: i18n.t("editor.attachment.convertCommand.pickerSourceFilter"),
        extensions: PICKER_EXTENSIONS,
      },
    ],
  });
  return typeof picked === "string" ? picked : null;
};

/** Override the single-file-picker seam (tests only). Returns a restore fn. */
export function setPickOneFn(fn: PickOneFn): () => void {
  const prev = pickOneFn;
  pickOneFn = fn;
  return () => {
    pickOneFn = prev;
  };
}

/** Import a path source, narrowing the outcome to the convert shape. */
async function importPath(
  path: string,
): Promise<{ ok: true; attachment: ImportedAttachment } | { ok: false; reason: string }> {
  const source: ImportSource = { kind: "path", path };
  const outcome = await importOne(source);
  if (outcome.ok) return { ok: true, attachment: outcome.attachment };
  return { ok: false, reason: outcome.reason };
}

/**
 * The picker-backed ref importer: auto-resolve the literal path; if that read
 * fails (the source isn't at the literal path), fall back to the picker; if
 * the user cancels the picker, the ref is "source not found". An oversize /
 * unsupported rejection is reported as-is and NOT retried via the picker (the
 * file was found, it's just not importable).
 */
export const pickerBackedImporter: RefImporter = async (ref: ImportedImageRef) => {
  const first = await importPath(ref.source);
  if (first.ok) return first;

  // An `error`/`io` reason means the literal path didn't read → offer the
  // picker. A `too-large`/`unsupported` reason means the file WAS read but is
  // not importable → don't re-prompt; report it.
  if (first.reason !== "error" && first.reason !== "locked") {
    return { ok: false, note: importSkipNote(first.reason) };
  }

  const picked = await pickOneFn(ref);
  if (picked === null) return { ok: false, note: importSkipNote("not-found") };

  const second = await importPath(picked);
  if (second.ok) return second;
  return { ok: false, note: importSkipNote(second.reason) };
};

/**
 * Run the import-&-convert command over the active note. Resolves + imports
 * sources via the picker-backed importer, then shows the mandatory
 * diff-preview, then (on confirm) rewrites every resolved ref to form C in one
 * transaction.
 *
 * TODO(palette insert action): this command + the `/attach` picker insert both
 * want a one-line command-palette entry in `src/commands/actions.ts` (e.g.
 * "Attach file…" → `pickAndInsert`, and "Convert imported attachments…" →
 * `runImportAndConvert`). That file is owned by the library agent; the parent
 * agent wires the palette entries at integration. The functions are exported +
 * ready; only the `CommandAction` registration is deferred.
 */
export function runImportAndConvert(view: EditorView): Promise<unknown> {
  return convertImportedRefs(view, pickerBackedImporter);
}
