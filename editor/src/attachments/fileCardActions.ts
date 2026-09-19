// Action handlers for the generic file-card overflow menu (MYND-173):
// Export (Save As), Rename, Remove from note, Reveal in library.
//
// Kept out of `widgets.ts` so the widget DOM construction stays free of IPC /
// dialog imports. Each handler is called from the card's menu with the live
// `EditorView` (CM6 hands it to `WidgetType.toDOM(view)`).

import { syntaxTree } from "@codemirror/language";
import { type EditorState } from "@codemirror/state";
import { type EditorView } from "@codemirror/view";
import i18n from "@myne/editor/i18n";
import { attachmentExport, attachmentRename, pickExportDestination } from "@myne/editor/host/lib/attachments";
import { parseAttachmentTarget } from "@myne/editor/host/notes/attachmentRef";
import { parseWikilinkParts } from "../wikilink/chip-widget";
import { addCatalogRows, catalogField } from "./catalog";
import { promptForName } from "./renamePrompt";
import { showAttachmentToast } from "./toast";

/** Event fired by the card's "Reveal in library" action. `Editor.tsx` listens
 *  and switches the center view to the attachments library. */
export const REVEAL_ATTACHMENT_EVENT = "myne:reveal-attachment";

/**
 * Export (Save As) one attachment's decrypted bytes. The HOST decides the
 * destination: desktop opens a native save dialog with the filename as the
 * default and cancelling is a silent no-op, while mobile has no dialog at all
 * and returns a path under its export directory, sanitized host-side, which may
 * differ from `filename`. The plaintext is decrypted and written entirely
 * host-side (it never re-enters the WebView). Type-agnostic, the single shared
 * action behind both the file-card Export menu item and the image/PDF lightbox
 * Save-As button (both MYND-173).
 */
export async function exportAttachment(id: string, filename: string): Promise<void> {
  let dest: string | null;
  try {
    // Host-picked destination: desktop opens a native Save dialog, mobile
    // returns a Documents path (no picker). The plaintext is decrypted + written
    // entirely host-side (it never re-enters the WebView).
    dest = await pickExportDestination(filename);
  } catch {
    // The string this renders is deliberately NOT "Couldn't open the save
    // dialog." any more (myne#517). Desktop opens one; mobile has none, and
    // `pickExportDestination` there is a host call that can REFUSE, including
    // when the export directory's platform-backup exclusion does not read back
    // as set. Telling a phone user that a dialog failed names an affordance the
    // platform does not have, and sends a support report hunting for it.
    //
    // What this still cannot do is distinguish that security refusal from a full
    // disk: both arrive here as a rejected promise and both render as one
    // sentence. Giving the refusal its own string needs a new key in 32
    // catalogs; the host-side kind reaches the console in the meantime.
    showAttachmentToast(i18n.t("editor.attachment.actions.saveDialogFailed"), "error");
    return;
  }
  if (dest === null) return; // cancelled
  // The file that will actually exist, which is NOT always the `filename`
  // argument. Mobile sanitizes host-side, so an attachment named `../../x`
  // lands as `_.._x` and one named `..pdf` lands under the caller's fallback;
  // naming the argument in the toast reports a file that is not there. Desktop's
  // dialog can rename too. Derived from the destination rather than passed back
  // through the seam, because the destination is what the host committed to.
  const written = dest.split(/[\\/]/).pop() || filename;
  try {
    // `overwrite = true`. On DESKTOP the OS save dialog already asked. On mobile
    // nothing asked, and that is a real gap rather than a nicety: two exports
    // whose sanitized basenames collide overwrite each other silently, which the
    // caller-supplied fallback makes reachable for odd names as well as for
    // genuinely identical ones. Closing it needs a non-clobbering destination or
    // a confirmation the host seam has no way to express today, so the toast
    // naming the REAL file is what makes the collision visible in the meantime.
    await attachmentExport(id, dest, true);
    showAttachmentToast(
      i18n.t("editor.attachment.actions.exported", { filename: written }),
      "success",
    );
  } catch {
    showAttachmentToast(
      i18n.t("editor.attachment.actions.exportFailed", { filename: written }),
      "error",
    );
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
    showAttachmentToast(i18n.t("editor.attachment.actions.renamed", { name: trimmed }), "success");
  } catch {
    showAttachmentToast(i18n.t("editor.attachment.actions.renameFailed"), "error");
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
export function attachmentEmbedRangeAt(
  state: EditorState,
  pos: number,
  id: string,
): { from: number; to: number; alias: string } | null {
  let found: { from: number; to: number; alias: string } | null = null;
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
        // The alias is returned rather than discarded: a caller that needs it
        // would otherwise re-derive the `![[att:…|alias]]` byte layout by hand,
        // which is exactly what this function's existence is meant to prevent.
        found = { from: node.from, to: node.to, alias: parts.alias ?? "" };
        return false;
      }
      return undefined;
    },
  });
  return found;
}
