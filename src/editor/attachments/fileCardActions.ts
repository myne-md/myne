// Action handlers for the generic file-card overflow menu (MYND-173):
// Export (Save As), Rename, Remove from note, Reveal in library.
//
// Kept out of `widgets.ts` so the widget DOM construction stays free of IPC /
// dialog imports. Each handler is called from the card's menu with the live
// `EditorView` (CM6 hands it to `WidgetType.toDOM(view)`).

import { syntaxTree } from "@codemirror/language";
import { type EditorState } from "@codemirror/state";
import { type EditorView } from "@codemirror/view";
import { save } from "@tauri-apps/plugin-dialog";
import { attachmentExport, attachmentRename } from "../../lib/attachments";
import { parseAttachmentTarget } from "../../notes/attachmentRef";
import { parseWikilinkParts } from "../wikilink/chip-widget";
import { addCatalogRows, catalogField } from "./catalog";
import { promptForName } from "./renamePrompt";
import { showAttachmentToast } from "./toast";

/** Event fired by the card's "Reveal in library" action. `Editor.tsx` listens
 *  and switches the center view to the attachments library. */
export const REVEAL_ATTACHMENT_EVENT = "myne:reveal-attachment";

/**
 * Export (Save As) one attachment's decrypted bytes. Opens the native save
 * dialog with the filename as the default; cancelling is a silent no-op. The
 * plaintext is decrypted + written entirely host-side (it never re-enters the
 * WebView). Type-agnostic — the single shared action behind both the file-card
 * Export menu item and the image/PDF lightbox Save-As button (both MYND-173).
 */
export async function exportAttachment(id: string, filename: string): Promise<void> {
  let dest: string | null;
  try {
    dest = await save({ defaultPath: filename });
  } catch {
    showAttachmentToast("Couldn't open the save dialog.");
    return;
  }
  if (dest === null) return; // cancelled
  try {
    // The OS save dialog already confirmed any overwrite → overwrite = true.
    await attachmentExport(id, dest, true);
    showAttachmentToast(`Exported ${filename}.`);
  } catch {
    showAttachmentToast(`Couldn't export ${filename}.`);
  }
}

/**
 * Rename the attachment's catalog filename (the single source of truth;
 * MYND-173 Q8). Optimistically updates the editor catalog so the card
 * re-renders with the new name without a note reload.
 */
export async function renameFileCard(
  view: EditorView,
  id: string,
  currentName: string,
): Promise<void> {
  // The Tauri WebView no-ops `window.prompt`; use the in-WebView prompt modal.
  const next = await promptForName(currentName);
  if (next === null) return; // cancelled
  const trimmed = next.trim();
  if (trimmed === "" || trimmed === currentName) return;
  try {
    await attachmentRename(id, trimmed);
    const current = view.state.field(catalogField, false) ?? null;
    const row = current?.get(id);
    if (row !== undefined) {
      addCatalogRows(view, [
        { id, contentType: row.contentType, filename: trimmed, size: row.size },
      ]);
    }
    showAttachmentToast(`Renamed to ${trimmed}.`);
  } catch {
    showAttachmentToast("Couldn't rename the attachment.");
  }
}

/**
 * Remove THIS embed from the current note. The underlying blob is NOT deleted
 * (orphans are reclaimed later by the existing clean-unused flow). The embed is
 * located by the card's live document position (`posAtDOM` maps an atomic
 * replace widget to its range) and resolved through the syntax tree, so a
 * prior doc edit that shifted it cannot misfire onto a different occurrence —
 * if the position no longer resolves to this id's embed, the action is a no-op.
 */
export function removeFileCard(
  view: EditorView,
  cardEl: HTMLElement,
  id: string,
): void {
  const span = attachmentEmbedRangeAt(view.state, view.posAtDOM(cardEl), id);
  if (span === null) return;
  view.dispatch({ changes: span, userEvent: "delete.attachment-embed" });
}

/** Fire the reveal-in-library event; `Editor.tsx` (a `window` listener) opens
 *  the library. Dispatched as a bubbling event on `view.dom`, matching the
 *  `myne-open-tag` / `myne-open-wikilink` CM6→React bridge precedent. */
export function revealFileCard(view: EditorView, id: string): void {
  view.dom.dispatchEvent(
    new CustomEvent(REVEAL_ATTACHMENT_EVENT, { detail: { id }, bubbles: true }),
  );
}

/**
 * The `{ from, to }` range of the attachment embed for `id` at document
 * position `pos`, or `null` if `pos` does not resolve to that embed. Reuses the
 * canonical wikilink/attachment parsers (`parseWikilinkParts` +
 * `parseAttachmentTarget`) and the syntax tree — the same primitives the embed
 * decorator uses — rather than re-deriving the `![[att:…]]` grammar.
 */
function attachmentEmbedRangeAt(
  state: EditorState,
  pos: number,
  id: string,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    from: Math.max(0, pos - 1),
    to: Math.min(state.doc.length, pos + 1),
    enter: (node) => {
      if (node.name !== "Wikilink") return undefined;
      const parts = parseWikilinkParts(state, node.from, node.to);
      if (
        parts.isEmbed &&
        parts.target !== null &&
        parseAttachmentTarget(parts.target) === id
      ) {
        found = { from: node.from, to: node.to };
        return false;
      }
      return undefined;
    },
  });
  return found;
}
