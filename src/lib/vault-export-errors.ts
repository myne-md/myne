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

import i18n from "../i18n";
import type { VaultExportError } from "../types/vault-export-error";
import {
  exportDestinationUnusableMessage,
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
      return i18n.t("export.vault.errors.vaultLocked");
    case "AuthOperationInProgress":
      return i18n.t("export.vault.errors.authOperationInProgress");
    case "VaultNotFound":
      return i18n.t("export.vault.errors.vaultNotFound");
    case "InvalidDestination":
      return exportDestinationUnusableMessage();
    case "DestinationNotAllowed":
      // PRD story 11: a plaintext tree inside Myne's own storage is
      // always refused.
      return i18n.t("export.vault.errors.destinationNotAllowed");
    case "DestinationAlreadyExists":
      // The engine never merges into or replaces an existing directory.
      return i18n.t("export.vault.errors.destinationAlreadyExists");
    case "CannotDecrypt":
      // Non-distinguishing per protocol.md §6.4; all-or-nothing.
      return i18n.t("export.vault.errors.cannotDecrypt");
    case "InvalidPlaintextEncoding":
      return i18n.t("export.vault.errors.invalidPlaintextEncoding");
    case "InvalidVaultMeta":
      return i18n.t("export.vault.errors.invalidVaultMeta");
    case "AttachmentMissing":
      return i18n.t("export.vault.errors.attachmentMissing");
    case "AttachmentCorrupt":
      return i18n.t("export.vault.errors.attachmentCorrupt");
    case "Cancelled":
      // The modal returns to setup quietly on cancel; this line exists
      // for completeness (e.g. a future toast surface), not as a scold.
      return i18n.t("export.vault.errors.cancelled");
    case "Io":
      return ioWriteErrorMessage(
        e.detail.io_error_kind,
        i18n.t("export.vault.errors.ioWriteDefault"),
      );
    case "JoinFailure":
      return i18n.t("export.vault.errors.joinFailure");
  }
}
