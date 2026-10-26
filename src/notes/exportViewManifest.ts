// Export one saved view as a `.myneview` manifest (view-manifests task 8).
//
// WHAT LEAVES, AND WHEN. A manifest is the user's own view definition, and this
// is deliberate, user-initiated egress of it (TB3's exception, one file per
// action). The OS save dialog names the destination and its own "Replace" prompt
// carries the overwrite consent, exactly like every other export in this tree.
// Nothing here runs on its own: a save is a click, and a cancelled dialog writes
// nothing and says nothing.
//
// WHY THE HOST WRITES THE BYTES. `plugin:prefs|export_view_manifest` encodes with
// `protocol::canonical_encode_saved_view` — the same encoder `vault.prefs` uses.
// A TypeScript `JSON.stringify` would be a second opinion about the canonical
// bytes, and the import path compares bytes, so the file this writes and the file
// an import reads have to agree on more than their values. It also keeps the
// plaintext on the Rust side of the WebView boundary until it is on disk.
//
// DESKTOP ONLY, and the gate is capability-based rather than a try/catch: the
// browser client has no path-taking save dialog, so the affordance is hidden
// where `nativeSaveAs` is absent (the export suite's established shape).
// Delivering this file through the browser's download seam is a separate flow
// with a separate arm, and it is not this one: on web a `.myneview` cannot yet be
// imported either, so the door is closed on both sides rather than half-open.

import { save as saveFileDialog } from "../platform/dialog";
import { has } from "../platform/capabilities";
import { toast } from "../components/toast/toastStore";
import i18n from "../i18n";
import { exportViewManifestFile, type SavedView } from "../lib/prefs";

/** Whether this host can export a manifest at all (a path-taking save dialog). */
export function canExportViewManifest(): boolean {
  return has("nativeSaveAs");
}

/** Default filename for the save dialog. Only path separators are sanitized:
 *  the OS dialog owns everything else, the same rule the note exports follow. */
export function manifestFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed === "" ? i18n.t("notes.views.untitledView") : trimmed;
  return `${base.replace(/[/\\]/g, "_")}.myneview`;
}

/**
 * Ask where to write `view` and write it.
 *
 * Resolves `"saved"` with the destination's basename reported in a toast,
 * `"cancelled"` when the dialog was dismissed (a silent no-op: backing out is
 * free), and `"failed"` when the write was refused or the disk failed, with one
 * plain sentence and no path.
 */
export async function exportViewManifest(
  view: SavedView,
): Promise<"saved" | "cancelled" | "failed"> {
  if (!canExportViewManifest()) return "failed";
  const target = await saveFileDialog({
    defaultPath: manifestFilename(view.name),
    filters: [
      {
        name: i18n.t("notes.viewSettings.exportFilterName"),
        extensions: ["myneview"],
      },
    ],
  });
  if (typeof target !== "string") return "cancelled";
  try {
    // The dialog's own "Replace" prompt is the consent (SYNC-2).
    await exportViewManifestFile(view, target, true);
  } catch {
    toast({
      message: i18n.t("notes.viewSettings.exportFailed"),
      variant: "error",
      testId: "view-settings.export-toast",
    });
    return "failed";
  }
  // The basename only, never the full path: the toast is a receipt, and the
  // directory a user picked is not something to leave on screen.
  const basename = target.split(/[/\\]/).pop() ?? target;
  toast({
    message: i18n.t("notes.viewSettings.exported", { filename: basename }),
    variant: "success",
    testId: "view-settings.export-toast",
  });
  return "saved";
}
