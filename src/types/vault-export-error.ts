// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - core/src/io_failure_kind.rs                       (IoFailureKind)
//   - core/src/plugins/export/error.rs                  (VaultExportError)
//   - core/src/plugins/export/commands.rs               (VaultExportSummary,
//                                                        ExportProgressPayload)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `export`
 * Tauri plugin's `vault_export_markdown` command (MYND-211 — the
 * whole-vault plaintext markdown tree export).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * Variant set is closed; adding a variant is an IPC contract change
 * that requires updating both the Rust enum and this mirror in the
 * same change (the Rust-side exhaustiveness pin is
 * `vault_export_error_kind`).
 */
export type VaultExportError =
  /**
   * No vault is unlocked. The export decrypts plaintext, so unlike the
   * ciphertext-copying backup it is impossible while locked. Entry
   * points are gated on an unlocked vault; surfacing this is a router
   * bug.
   */
  | { kind: "VaultNotUnlocked" }
  /**
   * The capacity-1 lifecycle permit is held by an in-flight unlock /
   * change-password / delete / backup / export. Reject-never-queue:
   * the user retries after the other operation finishes.
   */
  | { kind: "AuthOperationInProgress" }
  /**
   * The resolved vault directory has no `vault.meta` — a stale/forged
   * explicit `vaultId`, or nothing at the sole-vault fallback path
   * (non-creating resolution, MYND-253).
   */
  | { kind: "VaultNotFound" }
  /**
   * The destination's parent directory does not exist or is not a
   * directory (the OS folder dialog normally guarantees it; this fires
   * when it vanished between confirm and write).
   */
  | { kind: "InvalidDestination" }
  /**
   * The destination canonicalizes into the app data directory / a
   * vault root — a plaintext tree inside Myne's own storage is always
   * refused (PRD story 11). UI: ask for another folder.
   */
  | { kind: "DestinationNotAllowed" }
  /**
   * Something already exists at the destination path itself. The
   * export never merges into or replaces an existing directory — the
   * user picks a fresh tree location.
   */
  | { kind: "DestinationAlreadyExists" }
  /**
   * AEAD-tag failure decrypting a note blob (non-distinguishing per
   * `protocol.md` §6.4). Skip-nothing-silently: one undecryptable note
   * fails the whole export with the destination untouched.
   */
  | { kind: "CannotDecrypt" }
  /**
   * A note's AEAD authenticity passed but its plaintext is not valid
   * UTF-8 — corruption surfaced, never exported as garbage bytes.
   */
  | { kind: "InvalidPlaintextEncoding" }
  /** `vault.meta` exists but does not parse (prefs/catalog identity). */
  | { kind: "InvalidVaultMeta" }
  /**
   * A referenced attachment id has no catalog entry, or its blob file
   * is gone — all-or-nothing, nothing published.
   */
  | { kind: "AttachmentMissing" }
  /** A referenced attachment blob exists but fails to decrypt. */
  | { kind: "AttachmentCorrupt" }
  /**
   * `vault_export_cancel` was invoked; the staging tree was discarded
   * and nothing appeared at the destination.
   */
  | { kind: "Cancelled" }
  /** Residual file-system IO failure (closed `IoFailureKind` only). */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** `spawn_blocking` join failure — "try again". */
  | { kind: "JoinFailure" };

/** Type-narrowing helper for the `Io` variant. */
export function isVaultExportIoError(
  e: VaultExportError,
): e is { kind: "Io"; detail: { io_error_kind: IoFailureKind } } {
  return e.kind === "Io";
}

/**
 * Counts-only summary resolved by `vault_export_markdown` — mirror of
 * the Rust `VaultExportSummary` (`plugins/export/commands.rs`). The
 * summary phase of the export modal renders these directly.
 */
export interface VaultExportSummary {
  /** Markdown files written into the tree. */
  notes: number;
  /** Attachment files written into `attachments/`. */
  attachments: number;
  /**
   * Directories materialized in the tree (note folders + ancestors +
   * deliberate empty folders; the reserved `attachments/` dir is not
   * counted).
   */
  folders: number;
  /** Notes excluded by their value-strict `trashed:` marker. */
  excluded_trashed: number;
  /** `snapshots/` files excluded (counted, never decrypted). */
  excluded_snapshots: number;
}

/**
 * Payload of the `export://progress` event — counts-only (DENY-list:
 * no paths, no titles, no ids). Mirror of `ExportProgressPayload`.
 */
export interface VaultExportProgress {
  /** Items completed in the current phase. */
  done: number;
  /** Total items in the current phase. */
  total: number;
  /** `"notes"` (decrypt + stage) or `"attachments"` (blob decrypt). */
  phase: "notes" | "attachments";
}

/** Event name carrying {@link VaultExportProgress} payloads. */
export const VAULT_EXPORT_PROGRESS_EVENT = "export://progress";
