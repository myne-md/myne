// Tauri IPC wrappers for the `attachments` plugin (MYND-169 / MYND-170).
//
// Mirrors the Rust DTOs + error enums in:
//   - src-tauri/src/plugins/attachments/commands.rs (ImportSource,
//     ImportedAttachment, CatalogEntry, attachment_rename)
//   - src-tauri/src/plugins/attachments/error.rs    (AttachmentImportError,
//     CatalogListError, AttachmentDeleteError, AttachmentRenameError)
//
// No mock layer (src/CLAUDE.md "Tauri command bindings") — the real
// commands are invoked directly. Signature drift between these wrappers
// and the Rust `#[command]` definitions has no automated canary yet;
// keep them in lockstep by hand.
//
// All five commands are Slot::Unlocked-gated on the Rust side. Catalog
// reads fall back to an empty list on decode failure (§ 9.10.4), so
// `catalogList` only rejects on the slot gate / a vault.meta read error.

import { invoke } from "@tauri-apps/api/core";
import type { IoFailureKind } from "../types/vault-unlock-error";

/** One catalog row — TS mirror of the Rust `CatalogEntry`. */
export interface CatalogEntry {
  /** Attachment-id, 64-char lowercase hex (the `attachment://<id>` path). */
  id: string;
  /** Import-time MIME hint (display only; the served header is re-sniffed). */
  content_type: string;
  /** Creation timestamp (UNIX seconds). */
  created_at: number;
  /** Display filename. */
  filename: string;
  /** File size in bytes. */
  size: number;
}

/**
 * The success payload of {@link attachmentImport} — TS mirror of the Rust
 * `ImportedAttachment`. Carries the stored id + metadata so the caller can
 * render the attachment immediately without a follow-up `catalogList`.
 */
export interface ImportedAttachment {
  /** Content-addressed attachment-id, 64-char lowercase hex. */
  id: string;
  /** Re-sniffed allowlisted MIME (authoritative). */
  content_type: string;
  /** Display filename stored in the catalog. */
  filename: string;
  /** File size in bytes. */
  size: number;
  /** Creation timestamp (UNIX seconds). For a dedup hit, the original's. */
  created_at: number;
  /** `true` when the id already existed (dedup hit — no new blob written). */
  deduplicated: boolean;
}

/**
 * The `source` argument to {@link attachmentImport} — TS mirror of the Rust
 * `ImportSource` (internally-tagged serde discriminated union). `bytes` is
 * the paste / in-WebView drop path; `path` is the native picker / OS-drop
 * path (the host reads the file). The content-type is always re-sniffed
 * host-side, never trusted from `filename`.
 */
export type ImportSource =
  | { kind: "bytes"; bytes: number[]; filename: string | null }
  | { kind: "path"; path: string };

/** Error surface of {@link attachmentImport} — mirror of `AttachmentImportError`. */
export type AttachmentImportError =
  | { kind: "Locked" }
  | { kind: "Oversize"; detail: { cap_bytes: number } }
  | { kind: "UnsupportedType" }
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  | { kind: "InvalidVaultMeta" }
  | { kind: "EncodeFailed" }
  | { kind: "JoinFailure" };

/** Error surface of {@link catalogList} — mirror of `CatalogListError`. */
export type CatalogListError =
  | { kind: "Locked" }
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  | { kind: "InvalidVaultMeta" };

/** Error surface of {@link attachmentDelete} — mirror of `AttachmentDeleteError`. */
export type AttachmentDeleteError =
  | { kind: "Locked" }
  | { kind: "InvalidId" }
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  | { kind: "InvalidVaultMeta" }
  | { kind: "EncodeFailed" };

/** Error surface of {@link attachmentRename} — mirror of `AttachmentRenameError`. */
export type AttachmentRenameError =
  | { kind: "Locked" }
  | { kind: "InvalidId" }
  | { kind: "EmptyFilename" }
  | { kind: "AttachmentNotFound" }
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  | { kind: "InvalidVaultMeta" }
  | { kind: "EncodeFailed" };

/**
 * Read the full attachments catalog for the library UI. Slot::Unlocked-
 * gated; falls back to an empty list on any catalog decode failure
 * (§ 9.10.4) — only the slot gate / a vault.meta read surface as a
 * rejection ({@link CatalogListError}).
 */
export async function catalogList(): Promise<CatalogEntry[]> {
  return await invoke<CatalogEntry[]>("plugin:attachments|catalog_list");
}

/**
 * Import a file into the vault (Slot::Unlocked-gated). Sniffs + validates
 * the type against the PNG/JPEG/GIF/WebP/SVG/PDF allowlist, enforces the
 * 64 MiB cap, content-addresses + dedups, else encrypts the MYA1 blob +
 * upserts the MYC1 catalog. Rejects with {@link AttachmentImportError}.
 */
export async function attachmentImport(
  source: ImportSource,
): Promise<ImportedAttachment> {
  return await invoke<ImportedAttachment>("plugin:attachments|attachment_import", {
    source,
  });
}

/**
 * Explicitly delete one attachment (Slot::Unlocked-gated): unlinks the blob
 * + removes the catalog entry. NO auto-GC — this is a deliberate user
 * action. Idempotent on an absent id. Rejects with
 * {@link AttachmentDeleteError}.
 */
export async function attachmentDelete(id: string): Promise<void> {
  await invoke<void>("plugin:attachments|attachment_delete", { id });
}

/**
 * Rename one attachment's catalog display filename (Slot::Unlocked-gated).
 * Free-form — duplicates are allowed (the content-addressed id is the key;
 * the filename is a cosmetic label). Only the catalog entry's filename
 * changes; the blob + id are untouched. Rejects with
 * {@link AttachmentRenameError}.
 */
export async function attachmentRename(
  id: string,
  filename: string,
): Promise<void> {
  await invoke<void>("plugin:attachments|attachment_rename", { id, filename });
}
