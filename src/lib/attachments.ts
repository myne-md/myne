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

import { invoke } from "../platform/core";
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
  /** Byte length before ingest-time compression (`ingest-image-compression`),
   *  present only when a fresh import actually got smaller. Optional (rather
   *  than `| null`) so the many existing test fixtures built before this
   *  field existed stay valid without an edit. */
  original_size?: number | null;
  /** `true` only when `original_size` is set and the re-encode also changed
   *  the container (e.g. PNG → WebP). */
  container_changed?: boolean;
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

/** Error surface of {@link attachmentExport} — mirror of `AttachmentExportError`. */
export type AttachmentExportError =
  | { kind: "Locked" }
  | { kind: "InvalidId" }
  | { kind: "NotFound" }
  | { kind: "Corrupt" }
  | { kind: "TargetAlreadyExists" }
  | { kind: "InvalidDestination" }
  | { kind: "InvalidVaultMeta" }
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  | { kind: "JoinFailure" };

/** Error surface of {@link attachmentUnusedList} — mirror of `AttachmentUnusedListError`. */
export type AttachmentUnusedListError =
  | { kind: "Locked" }
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  | { kind: "InvalidVaultMeta" }
  | { kind: "NoteScanFailed" }
  /** This device has not finished syncing, so the unused set would be computed
   *  over a fraction of the corpus (phase3-web-client task 89). */
  | { kind: "CorpusIncomplete" }
  | { kind: "JoinFailure" };

/** Error surface of {@link attachmentCleanUnused} — mirror of `AttachmentCleanUnusedError`. */
export type AttachmentCleanUnusedError =
  | { kind: "Locked" }
  | { kind: "InvalidId" }
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  | { kind: "InvalidVaultMeta" }
  | { kind: "NoteScanFailed" }
  /** See {@link AttachmentUnusedListError}. Re-checked at the destructive step,
   *  because the list is advisory and storage can shrink between the two. */
  | { kind: "CorpusIncomplete" }
  | { kind: "EncodeFailed" }
  | { kind: "JoinFailure" };

/** Success payload of {@link attachmentReadText} — the decrypted preview text. */
export interface AttachmentTextPreview {
  /** Decrypted UTF-8 text (lossily decoded), truncated at the preview cap. */
  text: string;
  /** True when the source exceeded the cap and `text` holds only the head. */
  truncated: boolean;
}

/** Error surface of {@link attachmentReadText} — mirror of `AttachmentReadTextError`. */
export type AttachmentReadTextError =
  | { kind: "Locked" }
  | { kind: "NotFound" }
  | { kind: "Denied" }
  | { kind: "Io" };

/** Outcome of {@link attachmentCleanUnused} — TS mirror of the Rust `CleanResult`. */
export interface CleanResult {
  /** Attachments removed from the catalog (logically deleted). */
  deleted: number;
  /** Requested ids NOT removed — now referenced (TOCTOU) or already gone. */
  skipped: number;
  /** Bytes freed by the blob unlinks that succeeded this call. */
  bytes_reclaimed: number;
}

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

/**
 * Export one attachment's **decrypted** bytes to a user-chosen `destination`
 * (Slot::Unlocked-gated). The caller opens the native Save dialog (TS-side,
 * via the platform seam's dialog module) and passes the chosen path plus the
 * `overwrite` consent. The plaintext is decrypted in Rust RAM and written to
 * the destination; it never crosses back into the WebView. Type-agnostic —
 * the generic file-card Export action and the image/PDF Save-As affordance
 * both call it. Rejects with {@link AttachmentExportError}
 * (`TargetAlreadyExists` when `overwrite` is false and the path exists).
 */
export async function attachmentExport(
  id: string,
  destination: string,
  overwrite: boolean,
): Promise<void> {
  await invoke<void>("plugin:attachments|attachment_export", {
    id,
    destination,
    overwrite,
  });
}

/**
 * List the **unused** attachments — catalog entries referenced by zero live
 * notes (Slot::Unlocked-gated). Backs the "Clean unused attachments" review
 * dialog. Computed authoritatively host-side (decrypts + scans every note);
 * "unused" includes never-inserted imports, and shared/deduped attachments
 * referenced by any remaining note are excluded. **Fail-closed**: if a note
 * cannot be read/decrypted the call rejects with `NoteScanFailed`
 * ({@link AttachmentUnusedListError}) rather than under-reporting references.
 */
export async function attachmentUnusedList(): Promise<CatalogEntry[]> {
  return await invoke<CatalogEntry[]>("plugin:attachments|attachment_unused_list");
}

/**
 * Erase the confirmed unused attachments (Slot::Unlocked-gated, irreversible
 * cryptographic erase — no trash). Re-verifies each id is still referenced by
 * zero notes before erasing, so a re-referenced or already-gone id is counted
 * in `skipped`, not deleted. Drops survivors from the catalog (catalog-first)
 * then unlinks their blobs. Rejects with {@link AttachmentCleanUnusedError}
 * ({@link AttachmentCleanUnusedError.NoteScanFailed} aborts with nothing
 * deleted). Returns a {@link CleanResult} summary.
 */
export async function attachmentCleanUnused(ids: string[]): Promise<CleanResult> {
  return await invoke<CleanResult>("plugin:attachments|attachment_clean_unused", {
    ids,
  });
}

/**
 * Decrypt one attachment's plaintext as TEXT for a Tier-1 inline preview
 * (MYND-268; Slot::Unlocked-gated). Returns lossy UTF-8 text capped at the
 * preview limit (`truncated` flags a larger source). The text decrypts in Rust
 * RAM and crosses IPC as plaintext (note-body class) — render it in a read-only
 * viewer, never as interpreted content. Rejects with {@link AttachmentReadTextError}.
 */
export async function attachmentReadText(id: string): Promise<AttachmentTextPreview> {
  return await invoke<AttachmentTextPreview>("plugin:attachments|attachment_read_text", {
    id,
  });
}

/** A Tier-2 attachment parsed into a safe structured model — mirror of the Rust
 *  `StructuredContent`. A row-major grid (xlsx) or a heading/paragraph block
 *  list (docx). Only the model crosses IPC (never raw bytes / HTML). */
export type StructuredContent =
  | { kind: "grid"; rows: string[][] }
  | { kind: "blocks"; blocks: { heading_level: number | null; text: string }[] };

/**
 * Decrypt + parse a Tier-2 attachment (`kind` = "xlsx" | "docx") into a safe
 * structured model for inline preview (MYND-268 Tier-2; Slot::Unlocked-gated).
 * Parsing happens in Rust (zip + quick-xml); render the returned model with
 * plain components — it carries no raw bytes or HTML. Rejects with
 * {@link AttachmentReadTextError}.
 */
export async function attachmentReadStructured(
  id: string,
  kind: "xlsx" | "docx",
): Promise<StructuredContent> {
  return await invoke<StructuredContent>("plugin:attachments|attachment_read_structured", {
    id,
    kind,
  });
}
