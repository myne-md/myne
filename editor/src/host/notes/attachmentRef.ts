// Shared form-C attachment-embed helpers (epic MYND-164).
//
// Form C is the Myne-native embed for an encrypted attachment:
//
//     ![[att:<attachment-id-hex>|<display filename>]]
//
// It is a wikilink *embed* (`![[ … ]]`) whose target carries the `att:`
// scheme prefix (routing resolution to the `vault.attachments` catalog,
// NOT the note index) and whose alias is the cosmetic display filename.
// Target-first per `spec/wikilink.md` §78; always emitted WITH an alias.
//
// This module is the SINGLE source of truth for emitting + recognizing
// form C, shared by:
//   - the editor resolver/renderer (sub-feature editor-image-embeds),
//   - paste / drag / picker insert + import-&-convert (attachment-insert),
//   - the library "insert into note" action (attachments-library).
//
// It is PURE (no IPC, no DOM) so every consumer can import it without a
// load order dependency — the one exception is `attachmentUrl`, which
// consults the Tauri global at CALL time (never at import time) to pick
// the platform's serving form, so importing still carries no load-order
// dependency. The attachment-id is a 32-byte value rendered as 64
// lowercase hex chars (`spec/protocol.md` §9.9).

import { getHost } from "../../host";
import {
  type EmbedLayout,
  emitEmbedAlias,
  emptyEmbedLayout,
  parseEmbedAlias,
} from "@myne/dialect/embedLayout";

/** The scheme prefix that marks a wikilink target as an attachment ref. */
export const ATT_SCHEME = "att:";

/** 64 lowercase-hex chars = the 32-byte attachment-id (`protocol.md` §9.9). */
const ATT_ID_RE = /^[0-9a-f]{64}$/;

/** A parsed form-C embed. */
export interface AttachmentRef {
  /** The 64-char lowercase-hex attachment-id (without the `att:` prefix). */
  id: string;
  /**
   * The display filename. This is the FIRST alias segment plus any later
   * unkeyed one, not the whole alias: an alias may carry layout segments
   * (`photo.png|w=300`), and a filename may itself contain a pipe
   * (`re|port.png`). `@myne/dialect/embedLayout` owns that split.
   */
  filename: string;
  /** The author's layout choices, or an all-null layout when there are none. */
  layout: EmbedLayout;
}

/** True iff `id` is a syntactically valid lowercase-hex attachment-id. */
export function isAttachmentId(id: string): boolean {
  return ATT_ID_RE.test(id);
}

/**
 * Emit the canonical form-C embed for an attachment. Always includes the
 * filename alias (the chip's display label); the `att:` prefix routes the
 * resolver to the catalog. Used by every insert path so there is exactly
 * one emitter (SYNC-4).
 */
export function emitAttachmentEmbed(
  id: string,
  filename: string,
  layout: EmbedLayout = emptyEmbedLayout(),
  unknown: readonly string[] = [],
): string {
  return `![[${ATT_SCHEME}${id}|${emitEmbedAlias(filename, layout, unknown)}]]`;
}

/**
 * Recognize an attachment ref from a wikilink *target* string (the bytes
 * between `[[`/`![[` and the `|` alias divider). Returns the id if the
 * target carries the `att:` prefix and the remainder is a valid id, else
 * `null` (an ordinary note wikilink, or a malformed att: target).
 *
 * The editor's wikilink extension calls this to decide whether a recognized
 * embed resolves against the attachments catalog vs the note index.
 */
export function parseAttachmentTarget(target: string): string | null {
  if (!target.startsWith(ATT_SCHEME)) return null;
  const id = target.slice(ATT_SCHEME.length);
  return ATT_ID_RE.test(id) ? id : null;
}

/**
 * Extract every form-C embed `![[att:<id>|…]]` referenced by a note body.
 * This is the TS twin of the Rust host `extract_att_ids` tokenizer
 * (reconcile.rs) — keep the two in lockstep (one tokenizer per SYNC-6).
 * Returns refs in document order, de-duplicated by id (the first
 * occurrence's alias wins); a missing/empty alias yields `filename: ""`.
 */
export function extractAttachmentRefs(body: string): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  const seen = new Set<string>();
  // `![[` + att:<64 hex> + optional `|alias` + `]]`
  const re = /!\[\[att:([0-9a-f]{64})(?:\|([^\]]*))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      // The alias is NOT the filename: it may carry layout segments, and the
      // filename itself may contain a pipe. Reading it whole here reported
      // `photo.png|w=300` as a filename, which then reached the tombstone
      // label, the menu and the export naming path.
      const { filename, layout } = parseEmbedAlias(m[2] ?? "");
      out.push({ id, filename, layout });
    }
  }
  return out;
}

/** Document-order, de-duplicated attachment-ids of a note body (the
 *  id projection of `extractAttachmentRefs`). */
export function extractAttachmentIds(body: string): string[] {
  return extractAttachmentRefs(body).map((r) => r.id);
}

/**
 * The canonical, platform-INDEPENDENT `attachment://<id>` form — the
 * stable projection contract of the standalone HTML export: the Rust
 * rewriter (`desktop_commands.rs::html_referenced_attachment_ids`) scans
 * for exactly this shape, so exports stay deterministic across platforms.
 * Runtime display surfaces must use [`attachmentUrl`] instead.
 */
export function canonicalAttachmentUrl(id: string): string {
  return `attachment://${id}`;
}

/**
 * The URL a display surface uses as an `<img src>` (or pdf.js source) to fetch
 * an attachment's decrypted bytes.
 *
 * **Delegates to the host** (phase3-web-client task 76). It used to call
 * `convertFileSrc(id, "attachment")` directly, which is a `@tauri-apps/*` import
 * at module scope — so it landed in any bundle reaching this file, Tauri or not.
 * Each host now answers in its own terms:
 *
 * - **Desktop / mobile** return the platform form of the `attachment://` custom
 *   protocol. The Rust handler decrypts in memory, RE-SNIFFS the content type
 *   from the decrypted bytes and serves only an allowlisted one — never
 *   `text/html` (`spec/protocol.md` §9.9, sync-ledger SYNC-4). MYND-519's
 *   per-platform form (`http://attachment.localhost/<id>` where a WebView cannot
 *   intercept a custom scheme) is the host's business now, not this file's.
 * - **A browser** has no custom protocol and mints an object URL from bytes the
 *   Worker decrypted (task 44).
 *
 * Outside any host — vitest/jsdom, a plain-browser dev boot before
 * `setEditorHost` — it falls back to the canonical literal rather than throwing,
 * because a missing image is a better failure here than a crashed render.
 */
export function attachmentUrl(id: string): string {
  try {
    return getHost().attachments.resolveRef(id);
  } catch {
    return canonicalAttachmentUrl(id);
  }
}
