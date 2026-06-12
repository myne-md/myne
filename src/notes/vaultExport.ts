// IPC wrappers for the `export` Tauri plugin (MYND-211 — whole-vault
// plaintext markdown tree export, the importer's mirror).
//
// Deliberate, user-initiated plaintext egress across TB3: the backend
// decrypts the unlocked vault's live notes (and their referenced
// attachments) into an Obsidian-shape folder tree at a user-chosen
// destination. `destination` must come from the OS folder dialog
// (`dialog:allow-open` with `directory: true`) — the dialog IS the
// consent source; the destination itself is the NEW tree directory and
// must not exist yet (the engine never merges into or replaces an
// existing directory — `DestinationAlreadyExists` is the distinct
// rejection).
//
// The tree appears at the destination only when complete: the engine
// stages into a sibling directory and publishes via one atomic rename,
// so a crash / cancel mid-export leaves nothing at the chosen location.
// Progress arrives as counts-only `export://progress` events (see
// `VAULT_EXPORT_PROGRESS_EVENT` in `src/types/vault-export-error.ts`).

import { invoke } from "@tauri-apps/api/core";
import type { VaultExportSummary } from "../types/vault-export-error";

/**
 * Export the vault as a plaintext markdown tree at `destination`.
 *
 * - `vaultId` — explicit vault to export, or `null` for the active
 *   unlocked vault (the engine requires an unlocked vault either way:
 *   plaintext export is impossible without keys).
 * - `destination` — absolute path of the NEW tree directory (must not
 *   exist; its parent must). From the OS folder dialog.
 * - `scope` — `null` exports the whole vault; a canonical
 *   trailing-slash folder path (e.g. `"Projects/Sub/"`) exports only
 *   that subtree, rooted at the subtree's contents.
 *
 * Resolves with the counts-only `VaultExportSummary`; rejects with a
 * `VaultExportError` (see `src/types/vault-export-error.ts`).
 */
export async function vaultExportMarkdown(
  vaultId: string | null,
  destination: string,
  scope: string | null,
): Promise<VaultExportSummary> {
  return invoke<VaultExportSummary>("plugin:export|vault_export_markdown", {
    vaultId,
    destination,
    scope,
  });
}

/**
 * Cooperatively cancel the in-flight markdown export, if any.
 * Idempotent. The export rejects with `{ kind: "Cancelled" }` at its
 * next check and discards the staging tree — an interrupted export can
 * never be mistaken for a complete one.
 */
export async function vaultExportCancel(): Promise<void> {
  await invoke<void>("plugin:export|vault_export_cancel");
}
