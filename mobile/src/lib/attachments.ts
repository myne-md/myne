// Tauri IPC wrappers for the mobile `attachments` plugin (MYA1 blob / MYC1
// catalog / ref graph — shared core in `myne-core::plugins::attachments`). Mobile
// registers the 10 CRUD/refs/export commands (no voice, no text-extraction) +
// the `attachment://` scheme. Mirrors the desktop `src/lib/attachments.ts` DTOs
// so an attachment imported on mobile is byte-identical on desktop.

import { invoke } from "@tauri-apps/api/core";
import type { IoFailureKind } from "../types/vault-unlock-error";
import { shareFile } from "./share";

/** One catalog row — mirror of the Rust `CatalogEntry`. */
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

/** Success payload of {@link attachmentImport} — mirror of `ImportedAttachment`. */
export interface ImportedAttachment {
  id: string;
  content_type: string;
  filename: string;
  size: number;
  created_at: number;
  /** `true` when the id already existed (dedup hit — no new blob written). */
  deduplicated: boolean;
}

/** The `source` arg to {@link attachmentImport} — mirror of Rust `ImportSource`.
 *  Mobile always uses the `bytes` path (the file bytes are read in the WebView
 *  via a file `<input>`; the host re-sniffs the type, never trusts `filename`). */
export type ImportSource =
  | { kind: "bytes"; bytes: number[]; filename: string | null }
  | { kind: "path"; path: string };

/** Outcome of {@link attachmentCleanUnused} — mirror of Rust `CleanResult`. */
export interface CleanResult {
  deleted: number;
  skipped: number;
  bytes_reclaimed: number;
}

/** The allowlisted MIME set the host accepts (PNG/JPEG/GIF/WebP/SVG/PDF). */
export const ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf";

/** Read the full attachments catalog (Slot::Unlocked-gated; empty on decode fail). */
export function catalogList(): Promise<CatalogEntry[]> {
  return invoke<CatalogEntry[]>("plugin:attachments|catalog_list");
}

/** Import bytes into the vault; sniffs + validates + dedups + encrypts MYA1. */
export function attachmentImport(source: ImportSource): Promise<ImportedAttachment> {
  return invoke<ImportedAttachment>("plugin:attachments|attachment_import", { source });
}

/** Read a picked `File` into bytes and import it. */
export async function importFile(file: File): Promise<ImportedAttachment> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return attachmentImport({ kind: "bytes", bytes: Array.from(buf), filename: file.name || null });
}

/** Delete one attachment (unlink blob + catalog entry). Idempotent. */
export function attachmentDelete(id: string): Promise<void> {
  return invoke("plugin:attachments|attachment_delete", { id });
}

/** Rename one attachment's catalog display filename (cosmetic; id unchanged). */
export function attachmentRename(id: string, filename: string): Promise<void> {
  return invoke("plugin:attachments|attachment_rename", { id, filename });
}

/** Decrypt one attachment's bytes to a destination path, then (mobile, MYND-475)
 *  present the native share sheet so the user can pick where to save it. The
 *  Documents write always lands first, so the share is purely additive. */
export async function attachmentExport(id: string, destination: string, overwrite: boolean): Promise<void> {
  await invoke("plugin:attachments|attachment_export", { id, destination, overwrite });
  await shareFile(destination);
}

/** Catalog entries referenced by zero live notes (fail-closed). */
export function attachmentUnusedList(): Promise<CatalogEntry[]> {
  return invoke<CatalogEntry[]>("plugin:attachments|attachment_unused_list");
}

/** Cryptographically erase the confirmed-unused attachments; re-verifies refs. */
export function attachmentCleanUnused(ids: string[]): Promise<CleanResult> {
  return invoke<CleanResult>("plugin:attachments|attachment_clean_unused", { ids });
}

/** Replace a note's attachment-reference set in the RAM ref graph. */
export function attachmentRefsApply(noteId: string, attachmentIds: string[]): Promise<void> {
  return invoke("plugin:attachments|attachment_refs_apply", { noteId, attachmentIds });
}

/** Drop a hard-deleted note from the ref graph. */
export function attachmentRefsRemove(noteId: string): Promise<void> {
  return invoke("plugin:attachments|attachment_refs_remove", { noteId });
}

/** Note-ids referencing an attachment ("used in N notes"). */
export function attachmentRefsReferencing(attachmentId: string): Promise<string[]> {
  return invoke<string[]>("plugin:attachments|attachment_refs_referencing", { attachmentId });
}

/** Error surface shared across the commands (mirror of the Rust enums). */
export type AttachmentError =
  | { kind: "Locked" }
  | { kind: "Oversize"; detail: { cap_bytes: number } }
  | { kind: "UnsupportedType" }
  | { kind: "InvalidId" }
  | { kind: "NotFound" }
  | { kind: "AttachmentNotFound" }
  | { kind: "EmptyFilename" }
  | { kind: "Corrupt" }
  | { kind: "TargetAlreadyExists" }
  | { kind: "InvalidDestination" }
  | { kind: "NoteScanFailed" }
  | { kind: "InvalidVaultMeta" }
  | { kind: "EncodeFailed" }
  | { kind: "JoinFailure" }
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } };
