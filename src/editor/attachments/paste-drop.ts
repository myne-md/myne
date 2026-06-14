// Paste + WebView-drop insert handlers (epic MYND-164, sub-feature
// attachment-insert; decisions 1, 2, 3).
//
// Both surfaces feed the SAME bytes → `attachment_import` → form-C-at-cursor
// pipeline (SYNC-10): paste pulls image bytes from the clipboard; drop pulls
// `File` bytes from the HTML5 `DataTransfer`. Native OS drag-drop stays OFF
// (`dragDropEnabled: false`) — we only intercept WebView HTML5 DnD here, which
// is why this never collides with the sidebar's note-reorder DnD (that DnD
// targets the sidebar tree, never the editor content DOM; we only act when the
// drop lands on the editor AND carries files).
//
// These are CM6 `domEventHandlers`. A handler returns `true` only when it
// actually consumes the event (clipboard/datatransfer carried importable
// files) — otherwise it returns `false` so normal text paste / text drop keeps
// working untouched.

import { EditorView } from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import { emitAttachmentEmbed } from "../../notes/attachmentRef";
import {
  type ImportOutcome,
  type ImportSource,
  autoPasteName,
  importMany,
  summarizeBatch,
} from "./insert";
import { showAttachmentToast } from "./toast";
import { addCatalogRows } from "./catalog";
import {
  clearInsertPlaceholder,
  showInsertPlaceholder,
} from "./insert-placeholder";

/** A file pulled off a clipboard or datatransfer, ready to import. */
interface PendingFile {
  readonly bytes: number[];
  readonly filename: string | null;
  readonly mime: string;
}

// Since MYND-173 the host accepts ANY file bytes (a non-allowlisted type is
// stored as an opaque, export-only attachment), so every file the user
// explicitly pastes or drops is importable — there is no MIME pre-filter.
// What still guards against hijacking a plain TEXT paste/drop is the
// `kind:"file"` item check (paste) and the `files.length` check (drop): a
// text paste carries only `kind:"string"` items and an empty `files` list,
// and a sidebar note-reorder drag carries no files at all.

/** Read a `File`/`Blob` into a plain number[] (the IPC byte shape). */
async function readFileBytes(file: Blob): Promise<number[]> {
  const buf = await file.arrayBuffer();
  return Array.from(new Uint8Array(buf));
}

/** Collect importable files from a clipboard's `items`, auto-naming images
 *  that arrive without a filename (the screenshot-paste case, decision 1). */
async function collectFromClipboard(
  data: DataTransfer,
  now: Date = new Date(),
): Promise<PendingFile[]> {
  const out: PendingFile[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null) continue;
    const bytes = await readFileBytes(file);
    // A pasted screenshot has an empty `name`; auto-generate per decision 1.
    const filename = file.name && file.name.trim() !== ""
      ? file.name
      : autoPasteName(file.type, now);
    out.push({ bytes, filename, mime: file.type });
  }
  return out;
}

/** Collect importable files from a drop's `files` list (multi-file, decision 3). */
async function collectFromDrop(data: DataTransfer): Promise<PendingFile[]> {
  const out: PendingFile[] = [];
  for (const file of Array.from(data.files)) {
    const bytes = await readFileBytes(file);
    const filename = file.name && file.name.trim() !== ""
      ? file.name
      : autoPasteName(file.type);
    out.push({ bytes, filename, mime: file.type });
  }
  return out;
}

/** The import + insert pipeline shared by paste + drop. Imports all pending
 *  files, inserts a form-C embed per success at `insertAt` (in order), and
 *  surfaces a partial-success toast. Exported for direct testing. */
export async function importAndInsert(
  view: EditorView,
  pending: readonly PendingFile[],
  insertAt: number,
): Promise<readonly ImportOutcome[]> {
  const sources: ImportSource[] = pending.map((p) => ({
    kind: "bytes",
    bytes: p.bytes,
    filename: p.filename,
  }));

  // Optimistic in-editor feedback: a clean "Importing…" progress chip at the
  // cursor while the bytes are read + encrypted + stored. Decoration-only — the
  // note bytes stay clean, so nothing is ever persisted for the placeholder.
  const token = showInsertPlaceholder(view, insertAt, "importing");
  let outcomes: readonly ImportOutcome[];
  try {
    outcomes = await importMany(sources);
  } finally {
    clearInsertPlaceholder(view, token);
  }

  insertEmbedsForOutcomes(view, outcomes, insertAt);

  const summary = summarizeBatch(outcomes);
  if (summary !== null) showAttachmentToast(summary);
  return outcomes;
}

/**
 * Insert one form-C embed per successful import, in document order, at
 * `insertAt`. A single transaction so the whole batch is one undo step. If
 * more than one embed is inserted they are newline-separated.
 */
export function insertEmbedsForOutcomes(
  view: EditorView,
  outcomes: readonly ImportOutcome[],
  insertAt: number,
): void {
  const successes = outcomes.filter(
    (o): o is Extract<ImportOutcome, { ok: true }> => o.ok,
  );
  if (successes.length === 0) return;
  // Seed the editor catalog cache with the imported rows so each embed below
  // resolves to its image IMMEDIATELY — otherwise it renders a stale "deleted"
  // tombstone until a note-reopen reloads the catalog. Covers paste, drop, and
  // the /attach picker (all route through here).
  addCatalogRows(
    view,
    successes.map((o) => ({
      id: o.attachment.id,
      contentType: o.attachment.content_type,
      filename: o.attachment.filename,
      size: o.attachment.size,
    })),
  );
  const embeds = successes.map((o) =>
    emitAttachmentEmbed(o.attachment.id, o.attachment.filename),
  );
  const insert = embeds.join("\n");
  // Clamp the anchor — the async round-trip may outlive a doc edit.
  const at = Math.min(insertAt, view.state.doc.length);
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor: at + insert.length },
    userEvent: "input.attachment-insert",
  });
}

/**
 * The CM6 extension: paste + drop DOM handlers. Returns `true` (consumed)
 * only when importable files were found, leaving plain text paste/drop alone.
 */
export function attachmentPasteDropExtension(): Extension {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const data = event.clipboardData;
      if (data === null) return false;
      // Only hijack when the clipboard carries a file item (image/file
      // paste). A normal text paste has no `kind:"file"` items → fall through.
      const hasFile = Array.from(data.items).some((i) => i.kind === "file");
      if (!hasFile) return false;
      event.preventDefault();
      const insertAt = view.state.selection.main.head;
      void collectFromClipboard(data).then((pending) => {
        if (pending.length > 0) void importAndInsert(view, pending, insertAt);
      });
      return true;
    },
    drop: (event, view) => {
      const data = event.dataTransfer;
      // Act only when the drop carries files; otherwise let CM handle it
      // (e.g. dragged text). A sidebar note-reorder drag carries no files, so
      // it is never intercepted here.
      if (data === null || data.files.length === 0) return false;
      event.preventDefault();
      // Insert at the drop coordinates if resolvable, else at the cursor.
      const dropPos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const insertAt = dropPos ?? view.state.selection.main.head;
      void collectFromDrop(data).then((pending) => {
        if (pending.length > 0) void importAndInsert(view, pending, insertAt);
      });
      return true;
    },
  });
}
