// Tauri IPC wrappers for the mobile `attachments` plugin (MYA1 blob / MYC1
// catalog / ref graph; shared core in `myne-core::plugins::attachments`). Mobile
// registers the CRUD/refs/export commands plus the `attachment://` scheme and,
// since myne-md/myne#926, the MYE1 extracted-text read-back. Mirrors the desktop
// `src/lib/attachments.ts` DTOs so an attachment imported on mobile is
// byte-identical on desktop.

import { invoke } from "../platform/core";
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
 *  Mobile always uses a bytes arm (the file bytes are read in the WebView via a
 *  file `<input>`; the host re-sniffs the type, never trusts `filename`). */
export type ImportSource =
  | { kind: "bytes"; bytes: number[]; filename: string | null }
  | { kind: "bytes_b64"; bytes_b64: string; filename: string | null }
  | { kind: "path"; path: string };

/** Outcome of {@link attachmentCleanUnused} — mirror of Rust `CleanResult`. */
export interface CleanResult {
  deleted: number;
  skipped: number;
  bytes_reclaimed: number;
}

/** The allowlisted MIME set the host accepts (PNG/JPEG/GIF/WebP/SVG/PDF). */
export const ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf,video/mp4,video/webm";

/** Read the full attachments catalog (Slot::Unlocked-gated; empty on decode fail). */
export function catalogList(): Promise<CatalogEntry[]> {
  return invoke<CatalogEntry[]>("plugin:attachments|catalog_list");
}

/** Import bytes into the vault; sniffs + validates + dedups + encrypts MYA1. */
export function attachmentImport(source: ImportSource): Promise<ImportedAttachment> {
  return invoke<ImportedAttachment>("plugin:attachments|attachment_import", { source });
}

/** STANDARD base64 of `bytes`, built in blocks.
 *
 *  `String.fromCharCode(...bytes)` spreads one argument per byte and throws a
 *  `RangeError` once the buffer is past roughly a hundred kilobytes, so the
 *  buffer is walked in 8 KiB blocks. `btoa` is the WebView's own encoder, and
 *  what it emits is exactly what the Rust `bytes_b64` arm decodes. */
function toBase64(bytes: Uint8Array): string {
  const BLOCK = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += BLOCK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + BLOCK) as unknown as number[],
    );
  }
  return btoa(binary);
}

/** Read a picked `File` into bytes and import it.
 *
 *  Base64 rather than a JSON number array, and the reason is a memory one: see
 *  the Rust `ImportSource::BytesB64` doc. At the 64 MiB cap the array form asks
 *  the WebView for hundreds of megabytes of transient heap before a byte leaves
 *  the page, which is how an import becomes a jetsam kill on iOS instead of an
 *  error the user can read. Raw request bodies are not the answer here — Tauri
 *  does not deliver them on Android at all. */
export async function importFile(file: File): Promise<ImportedAttachment> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return attachmentImport({
    kind: "bytes_b64",
    bytes_b64: toBase64(buf),
    filename: file.name || null,
  });
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
 *  present the platform destination chooser so the user can pick where it goes
 *  (iOS share sheet, Android SAF picker since myne-md/myne#505). The Documents write
 *  always lands first, so the chooser is purely additive. */
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

/** The decrypted MYE1 entry: mirror of the Rust `AttachmentExtractedText`. */
export interface AttachmentExtractedText {
  /** The extracted text (an image's OCR output on mobile). PLAINTEXT of
   *  note-body class: DENY-listed, never logged or traced. */
  text: string;
  /** Producing extractor's source format, lowercased: "audio" | "pdf" | "docx" |
   *  "text" | "image" | "other". */
  source_format: string;
  /** True when the cache hit the 1 MiB cap and `text` is the head. */
  truncated: boolean;
}

/** Outcome of {@link attachmentReadExtractedText}.
 *
 *  Four arms rather than the desktop binding's `AttachmentExtractedText | null`,
 *  because the mobile surface has to tell two things apart that `null` collapses:
 *  a page with NO text (offer the image alone, blame nobody) and a vault that
 *  LOCKED under the sheet (stop, drop the plaintext, ask for the unlock). The
 *  difference is deliberate and is why this is not a twin of the desktop
 *  signature; the DECODED payload is the same one. */
export type ExtractedTextRead =
  /** A usable cache entry. An empty or whitespace-only one reads as `none`. */
  | { kind: "text"; entry: AttachmentExtractedText }
  /** No usable cache entry for this id: never extracted, extraction failed,
   *  generation-stale, or undecryptable. Not an error. */
  | { kind: "none" }
  /** `Slot` was not unlocked when the read arrived. */
  | { kind: "locked" }
  /** Anything else (host IO, a join failure). Retryable, and never reported as
   *  "no text" because a failure is not an empty page. */
  | { kind: "failed" };

/** Normalize the Rust error surface to the union above. Tauri serializes the
 *  `#[serde(tag = "kind")]` enum as `{ kind: "Locked" }`, but a unit variant can
 *  arrive as its bare identifier on some paths, so both spellings are read (the
 *  same normalization `transcribe.ts` uses for its own enum). */
function normalizeReadFailure(raw: unknown): "locked" | "failed" {
  const tag =
    typeof raw === "string"
      ? raw
      : raw !== null && typeof raw === "object" && "kind" in raw
        ? String((raw as { kind: unknown }).kind)
        : "";
  return tag.toLowerCase() === "locked" ? "locked" : "failed";
}

/**
 * Read one attachment's cached MYE1 extracted text (Slot::Unlocked-gated;
 * `protocol.md` § 9.15). On mobile the producer is the import's eager image OCR
 * (MYND-441), so this is how a photographed page's text becomes readable.
 *
 * The text decrypts in Rust RAM and crosses IPC as plaintext (note-body class).
 * Render it as inert, editable text: never as interpreted markdown or HTML, and
 * never in a log.
 */
export async function attachmentReadExtractedText(
  id: string,
): Promise<ExtractedTextRead> {
  try {
    const entry = await invoke<AttachmentExtractedText | null>(
      "plugin:attachments|attachment_read_extracted_text",
      { id },
    );
    if (entry === null || entry.text.trim().length === 0) return { kind: "none" };
    return { kind: "text", entry };
  } catch (raw) {
    return { kind: normalizeReadFailure(raw) };
  }
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
