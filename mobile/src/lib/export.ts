// IPC bindings for the mobile `export` plugin — whole-vault → plaintext Markdown
// tree (shared core in `myne-core::plugins::export`). The Rust command decrypts
// every note + attachment and writes a folder tree to `destination`; on mobile
// we target the app's Documents directory, since there is no native folder
// picker. Mirrors the desktop DTOs.
//
// Where that leaves the user, per platform: on iOS the directory is invisible in
// the Files app (no `UIFileSharingEnabled`) and the share sheet is the only route
// to it; on Android it is `Android/data/<pkg>/files/Documents`, which the system
// Files app has refused to navigate into since API 30, and the Android share
// sheet is not implemented (myne-md/myne#505). Neither platform hands the user a
// browsable copy on a current OS. See `../platform/path.ts` for the definition
// site of that claim.
//
// The directory is excluded from platform cloud backup on both — a whole-vault
// plaintext export is every note, and it was going to iCloud / Google Drive until
// myne-md/myne#491. See `mobile/src-tauri/src/backup_exclude.rs`.

import { invoke } from "../platform/core";
import { documentDir, join } from "../platform/path";

/** Result of {@link vaultExportMarkdown} — mirror of Rust `VaultExportSummary`. */
export interface VaultExportSummary {
  notes: number;
  attachments: number;
  folders: number;
  excluded_trashed: number;
  excluded_snapshots: number;
}

/** Export the vault (or a `folder:` subtree) to a plaintext Markdown tree at
 *  `destination` (a non-existent directory path; the backend stages + publishes
 *  atomically). */
export function vaultExportMarkdown(
  destination: string,
  scope?: string | null,
  vaultId?: string | null,
): Promise<VaultExportSummary> {
  return invoke<VaultExportSummary>("plugin:export|vault_export_markdown", {
    destination,
    scope: scope ?? null,
    vaultId: vaultId ?? null,
  });
}

/** Cooperatively cancel an in-flight export (idempotent). */
export function vaultExportCancel(): Promise<void> {
  return invoke("plugin:export|vault_export_cancel");
}

/** A fresh, non-existent destination under the app's Documents dir, stamped
 *  with the local date/time so repeated exports never collide. Returns both the
 *  absolute path (for the command) and a short label (for the UI). */
export async function defaultExportDestination(): Promise<{ path: string; label: string }> {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}`;
  const name = `Myne Export ${stamp}`;
  const path = await join(await documentDir(), name);
  return { path, label: `Documents/${name}` };
}
