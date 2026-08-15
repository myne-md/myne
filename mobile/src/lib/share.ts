// Frontend half of the native file share/save bridge (MYND-475). Every mobile
// export/download flow first writes its file to the app's Documents directory,
// then calls `shareFile(path)` to offer the user a native destination chooser.
//
// That directory is NOT equally reachable on the two platforms, and the comment
// here used to imply it was. iOS declares no `UIFileSharingEnabled`, so
// `Documents` is invisible in the Files app and this share sheet is the user's
// only route to the file; Android exposes the directory through the system Files
// app but has no share sheet yet (below). Either way the directory is excluded
// from platform cloud backup — myne-md/myne#491, `backup_exclude.rs`.
//
// This emits `share-file` to the Rust setup hook (`src-tauri/src/lib.rs`), which
// presents the platform share sheet on the main thread (iOS:
// `UIActivityViewController` → "Save to Files"; Android: documented no-op for
// now, the file stays in Documents). Mirrors the fire-and-forget `emit`
// contract of the PDF export path — the sheet appearing is the user feedback,
// and the already-saved Documents copy means a cancel is never a silent no-op
// (on iOS the user cannot browse to that copy, so a cancel there does leave them
// without a reachable file; myne-md/myne#491 filed a follow-up for the label
// that claims otherwise).

import { emit } from "../platform/event";
import { HAS_TAURI } from "./app-window";

/**
 * Present the native share/save sheet for an already-written file (or export
 * folder) at absolute `path`. No-op in browser dev (no Tauri host). Best-effort:
 * failures to present are swallowed — the file is already saved where the caller
 * wrote it, so this only ever *adds* a destination-chooser affordance.
 */
export async function shareFile(path: string): Promise<void> {
  if (!HAS_TAURI) return;
  try {
    await emit("share-file", { path });
  } catch {
    /* The file is already saved in Documents; the share sheet is additive. */
  }
}
