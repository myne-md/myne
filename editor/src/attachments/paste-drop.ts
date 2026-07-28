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
import { emitAttachmentEmbed } from "@myne/editor/host/notes/attachmentRef";
import {
  type ImportOutcome,
  type ImportSource,
  autoPasteName,
  importMany,
  summarizeBatch,
} from "./insert";
import { getHost } from "../host";
import { showAttachmentToast } from "./toast";
import { addCatalogRows } from "./catalog";
import {
  clearInsertPlaceholder,
  insertPlaceholderPos,
  showInsertPlaceholder,
} from "./insert-placeholder";

/** A file pulled off a clipboard or datatransfer, ready to import. */
interface PendingFile {
  readonly source: ImportSource;
  readonly filename: string | null;
}

/**
 * Turn one `File` into an import source, preferring the host's handle path.
 *
 * Two shapes, and which one is used is the host's answer rather than a platform
 * test here (phase3-web-client task 67):
 *
 *  - `pickedFromDropped` present → the host moves the file itself. On web that
 *    means the `File` handle crosses to the Worker and the CONTENT is read
 *    there, so a 64 MiB drop never becomes a 64-million-element array on the
 *    page — which is what `readFileBytes` below would do, and what made this
 *    path an out-of-memory risk in a browser rather than merely a slow one.
 *  - absent → the byte path, unchanged. Desktop takes this branch, so its
 *    behaviour is not merely preserved, it is the same code it always ran.
 */
async function pendingFrom(file: File, autoName: string | null): Promise<PendingFile> {
  const filename = file.name && file.name.trim() !== "" ? file.name : autoName;
  const mint = getHost().attachments.pickedFromDropped;
  if (mint !== undefined) {
    const picked = mint(file, filename ?? undefined);
    if (picked !== null) return { source: { kind: "picked", file: picked }, filename };
  }
  return {
    source: { kind: "bytes", bytes: await readFileBytes(file), filename },
    filename,
  };
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
  // Extract EVERY File synchronously while the DataTransfer is still live: after
  // the first `await` below the clipboard store enters protected mode and
  // `getAsFile()` returns null for the 2nd+ items, silently dropping all files
  // but the first on a multi-file paste. (collectFromDrop is immune because
  // `data.files` snapshots real File objects that outlive the event.)
  const files = Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
  const out: PendingFile[] = [];
  for (const file of files) {
    // A pasted screenshot has an empty `name`; auto-generate per decision 1.
    out.push(await pendingFrom(file, autoPasteName(file.type, now)));
  }
  return out;
}

/** Collect importable files from a drop's `files` list (multi-file, decision 3). */
async function collectFromDrop(data: DataTransfer): Promise<PendingFile[]> {
  const out: PendingFile[] = [];
  for (const file of Array.from(data.files)) {
    out.push(await pendingFrom(file, autoPasteName(file.type)));
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
  const sources: ImportSource[] = pending.map((p) => p.source);

  // Optimistic in-editor feedback: a clean "Importing…" progress chip at the
  // cursor while the bytes are read + encrypted + stored. Decoration-only — the
  // note bytes stay clean, so nothing is ever persisted for the placeholder.
  const token = showInsertPlaceholder(view, insertAt, "importing");
  let outcomes: readonly ImportOutcome[];
  // Insert at the placeholder's CURRENT position, not the stale `insertAt`:
  // concurrent edits during the async import move the placeholder (a CM6
  // change-mapped position), so the raw offset can land the embed in the wrong
  // place. Capture the mapped position before clearing the placeholder.
  let insertPos = insertAt;
  try {
    outcomes = await importMany(sources);
  } finally {
    insertPos = insertPlaceholderPos(view, token) ?? insertAt;
    clearInsertPlaceholder(view, token);
  }

  insertEmbedsForOutcomes(view, outcomes, insertPos);

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
