// Form-C attachment-embed helpers (mobile mirror of desktop
// `src/notes/attachmentRef.ts`, epic MYND-164). Form C is the Myne-native
// embed for an encrypted attachment:
//
//     ![[att:<attachment-id-hex>|<display filename>]]
//
// A wikilink *embed* whose target carries the `att:` scheme prefix (routing to
// the vault.attachments catalog, NOT the note index) and whose alias is the
// cosmetic display filename. Byte-identical to desktop so an attachment
// embedded on mobile renders on desktop and rides sync unchanged. Pure — no
// IPC; `attachmentSrc` consults the Tauri global at CALL time only.

import { emitAttachmentEmbed as sharedEmitAttachmentEmbed } from "@myne/editor/host/notes/attachmentRef";
import { convertFileSrc } from "../platform/core";
import { hasTauriHost } from "./app-window";

/** The scheme prefix that marks a wikilink target as an attachment ref. */
export const ATT_SCHEME = "att:";

/** 64 lowercase-hex chars = the 32-byte attachment-id (`protocol.md` §9.9). */
const ATT_ID_RE = /^[0-9a-f]{64}$/;

/** True iff `id` is a syntactically valid lowercase-hex attachment-id. */
export function isAttachmentId(id: string): boolean {
  return ATT_ID_RE.test(id);
}

/** Emit the canonical form-C embed (always with the filename alias). */
export function emitAttachmentEmbed(id: string, filename: string): string {
  // Delegates rather than restating the template. This copy used to be a bare
  // interpolation while desktop's routed the alias through `emitEmbedAlias`,
  // so the two clients' "byte-exact by construction" claim was a comment: a
  // filename carrying a `]` produced an embed no reader accepts here and a
  // sanitized one there. `@myne/editor` already resolves from this tree.
  return sharedEmitAttachmentEmbed(id, filename);
}

/** Recognize an attachment id from a wikilink target (the bytes before `|`).
 *  Returns the id when the target is `att:<valid-id>`, else null. */
export function parseAttachmentTarget(target: string): string | null {
  const t = target.trim();
  if (!t.startsWith(ATT_SCHEME)) return null;
  const id = t.slice(ATT_SCHEME.length);
  return isAttachmentId(id) ? id : null;
}

/** The in-app decrypt URL the `attachment://` scheme resolves (matches desktop —
 *  the handler decrypts in RAM + re-sniffs the served content-type).
 *
 *  Platform-aware (MYND-519): Android WebView cannot intercept custom
 *  schemes — Tauri serves registered protocols there as
 *  `http://attachment.localhost/<id>`, so a literal `attachment://<id>`
 *  dies in the WebView before reaching the Rust handler. Inside Tauri this
 *  delegates to `convertFileSrc` (iOS emits `attachment://localhost/<id>`;
 *  `extract_id` in the shared scheme_core accepts every form); outside
 *  Tauri (vitest/browser dev) it falls back to the literal. */
export function attachmentSrc(id: string): string {
  if (hasTauriHost()) {
    return convertFileSrc(id, "attachment");
  }
  return `attachment://${id}`;
}

/** All attachment ids embedded in a note body (deduped, in first-seen order). */
export function extractAttachmentIds(body: string): string[] {
  const re = /!\[\[att:([0-9a-f]{64})(?:\|[^\]\n]*)?\]\]/g;
  const seen = new Set<string>();
  const out: string[] = [];
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}
