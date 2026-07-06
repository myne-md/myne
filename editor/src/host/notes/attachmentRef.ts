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
// load order dependency. The attachment-id is a 32-byte value rendered as
// 64 lowercase hex chars (`spec/protocol.md` §9.9).

/** The scheme prefix that marks a wikilink target as an attachment ref. */
export const ATT_SCHEME = "att:";

/** 64 lowercase-hex chars = the 32-byte attachment-id (`protocol.md` §9.9). */
const ATT_ID_RE = /^[0-9a-f]{64}$/;

/** A parsed form-C embed. */
export interface AttachmentRef {
  /** The 64-char lowercase-hex attachment-id (without the `att:` prefix). */
  id: string;
  /** The display filename (the wikilink alias). May be empty if malformed. */
  filename: string;
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
export function emitAttachmentEmbed(id: string, filename: string): string {
  return `![[${ATT_SCHEME}${id}|${filename}]]`;
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
      out.push({ id, filename: m[2] ?? "" });
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
 * The custom-protocol URL that the editor/library use as an `<img src>` (or
 * pdf.js source) to fetch the decrypted bytes of an attachment. The Rust
 * `attachment://` handler decrypts in memory, re-sniffs the content-type,
 * and streams an allowlisted type — no plaintext ever touches disk
 * (`spec/protocol.md` §9.9, sync-ledger SYNC-4).
 */
export function attachmentUrl(id: string): string {
  return `attachment://${id}`;
}
