// Frontend half of the native file share/save bridge (MYND-475). Every mobile
// export/download flow first writes its file to the app's Documents directory,
// then calls `shareFile(path)` to offer the user a native destination chooser.
//
// That directory is NOT browsable on either platform on a current OS: iOS
// declares no `UIFileSharingEnabled`, so `Documents` is invisible in the Files
// app, and Android's copy is `Android/data/<pkg>/files/Documents`, which the
// system Files app has refused to navigate into since API 30. So the chooser is
// the user's ONLY route to the file on both: iOS's share sheet, and since
// myne-md/myne#505 Android's Storage Access Framework picker, where the user
// picks the destination and the bytes are written there. Before #505 the Android
// arm was a documented no-op and an export on Android was unreachable by
// construction. Either way the directory is excluded from platform cloud backup
// (myne-md/myne#491, `backup_exclude.rs`).
//
// This emits `share-file` to the Rust setup hook (`src-tauri/src/lib.rs`), whose
// `share_file::present` dispatches per platform (iOS:
// `UIActivityViewController` → "Save to Files", main thread; Android: the SAF
// picker through the committed Kotlin in `tauri-plugin-save-file`, background
// task, because its plugin round-trip deadlocks from the main thread). Mirrors
// the fire-and-forget `emit` contract of the PDF export path: the chooser
// appearing is the user feedback, and the already-saved Documents copy means a
// dismissal is never a silent no-op.
//
// Dismissing the chooser keeps that copy and claims nothing else: this function
// resolves as soon as the event is emitted, so no caller may read it as "the user
// saved it somewhere". A screen that wants to say where the file went has to ask,
// and today no platform lets it (myne-md/myne#504).

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
    /* The file is already saved in Documents; the chooser is additive. */
  }
}
