// Whole-vault export closed-enum → user-facing copy mapping (MYND-211;
// note-export-errors.ts / backup-errors.ts are the convention precedent).
//
// Honest copy discipline: strings stay inside threat-model §7 — plain
// statements of what happened, no "tamper-proof"/"safe forever". The
// engine is all-or-nothing (staging dir discarded, one atomic publish),
// so every failure line may honestly say nothing landed at the
// destination. The enum is closed on the Rust side
// (`src-tauri/src/plugins/export/error.rs`); the exhaustive switch makes
// a new variant a compile error here, and
// `tests/notes/vaultExportFlow.test.ts` pins non-empty, pairwise-distinct
// copy per variant at runtime.

import type { VaultExportError } from "../types/vault-export-error";
import {
  EXPORT_DESTINATION_UNUSABLE_MESSAGE,
  ioWriteErrorMessage,
} from "./note-export-errors";

/** `vault_export_markdown` failure → copy (the vault-export modal's
 *  setup-phase inline error line renders it). Hardcoded English (v1).
 *  The `e?.kind` access is deliberate: a null/undefined out-of-contract
 *  rejection must fall off the switch (→ the reducer's `??` fallback),
 *  never throw (note-export-errors.ts carries the same guard). */
export function vaultExportErrorMessage(e: VaultExportError): string {
  switch (e?.kind) {
    case "VaultNotUnlocked":
      // Entry points are gated on an unlocked vault — surfacing this is
      // a router bug, but the copy stays honest if it ever fires.
      return "The vault is locked. Unlock it, then try again.";
    case "AuthOperationInProgress":
      return "Another vault operation is in progress. Wait for it to finish, then try again.";
    case "VaultNotFound":
      return "No vault found to export.";
    case "InvalidDestination":
      return EXPORT_DESTINATION_UNUSABLE_MESSAGE;
    case "DestinationNotAllowed":
      // PRD story 11: a plaintext tree inside Myne's own storage is
      // always refused.
      return "That location is inside Myne's own storage. Choose a folder outside it.";
    case "DestinationAlreadyExists":
      // The engine never merges into or replaces an existing directory.
      return "Something already exists at that location. Choose a fresh spot for the export.";
    case "CannotDecrypt":
      // Non-distinguishing per protocol.md §6.4; all-or-nothing.
      return "A note could not be read, so nothing was exported.";
    case "InvalidPlaintextEncoding":
      return "A note's content looks damaged, so nothing was exported. Restore it from a backup.";
    case "InvalidVaultMeta":
      return "The vault's metadata could not be read, so nothing was exported.";
    case "AttachmentMissing":
      return "An attachment referenced by a note is missing, so nothing was exported.";
    case "AttachmentCorrupt":
      return "An attachment referenced by a note could not be read, so nothing was exported.";
    case "Cancelled":
      // The modal returns to setup quietly on cancel; this line exists
      // for completeness (e.g. a future toast surface), not as a scold.
      return "Export cancelled. Nothing was left at the destination.";
    case "Io":
      return ioWriteErrorMessage(e.detail.io_error_kind, "Could not write the export.");
    case "JoinFailure":
      return "Export failed unexpectedly. Nothing was left at the destination.";
  }
}
