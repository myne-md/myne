// Attachment INSERT core (epic MYND-164, sub-feature attachment-insert).
//
// This module is the editor-side INSERT half of the attachment epic — the
// render half (form-C → inline image/PDF chip) lives in the sibling
// `editor/attachments/{catalog,widgets,pdf-render}` files. Everything here
// drives bytes-or-path → `attachment_import` (over IPC) → form-C embed at the
// cursor, shared by paste / WebView-drop / `/attach` picker / import-&-convert.
//
// Pure (no DOM) so the orchestration + auto-name + ref-parse + rewrite logic is
// unit-testable; the `EditorView` mutation helpers live alongside but take the
// view as a parameter. The single form-C emitter is `emitAttachmentEmbed`
// (`src/notes/attachmentRef.ts`) — SYNC-4, never re-implemented here.
//
// IPC: we call `invoke("plugin:attachments|attachment_import", …)` directly
// (NOT `src/lib/attachments.ts` — that file is owned by the library agent and
// may not exist). The command + its error taxonomy are defined Rust-side in
// `src-tauri/src/plugins/attachments/{commands,error}.rs`; the shapes below are
// hand-mirrored per the no-codegen note in `src/CLAUDE.md`.

import { invoke } from "@tauri-apps/api/core";
import i18n from "../../i18n";
import { emitAttachmentEmbed } from "../../notes/attachmentRef";

/** The success payload of `attachment_import` (mirrors Rust
 *  `ImportedAttachment`). Only the fields the insert path needs. */
export interface ImportedAttachment {
  readonly id: string;
  readonly content_type: string;
  readonly filename: string;
  readonly size: number;
  readonly created_at: number;
  readonly deduplicated: boolean;
}

/** The `source` argument to `attachment_import` (mirrors Rust `ImportSource`,
 *  internally tagged on `kind`). */
export type ImportSource =
  | { readonly kind: "bytes"; readonly bytes: number[]; readonly filename: string | null }
  | { readonly kind: "path"; readonly path: string };

/** Mirror of the Rust `AttachmentImportError` closed taxonomy (tag = "kind",
 *  content = "detail"). Hand-kept in lockstep with
 *  `src-tauri/src/plugins/attachments/error.rs`. */
export type AttachmentImportError =
  | { readonly kind: "Locked" }
  | { readonly kind: "Oversize"; readonly detail: { readonly cap_bytes: number } }
  | { readonly kind: "UnsupportedType" }
  | { readonly kind: "Io"; readonly detail: { readonly io_error_kind: string } }
  | { readonly kind: "InvalidVaultMeta" }
  | { readonly kind: "EncodeFailed" }
  | { readonly kind: "JoinFailure" };

/** The result of one import attempt — either the stored attachment or a
 *  reason it was skipped (used for multi-file partial-success accounting). */
export type ImportOutcome =
  | { readonly ok: true; readonly attachment: ImportedAttachment }
  | { readonly ok: false; readonly reason: SkipReason };

/** A coarse, user-facing reason an import was skipped, derived from the
 *  backend error taxonomy. `too-large` / `unsupported` are the two the
 *  multi-file toast names explicitly; everything else is `error`. */
export type SkipReason = "too-large" | "unsupported" | "locked" | "error";

/** Map a thrown `attachment_import` rejection to a coarse skip reason. The
 *  rejection may be the structured `AttachmentImportError`, or any other
 *  thrown value (treated as a generic error). */
export function skipReasonFromError(err: unknown): SkipReason {
  const kind = (err as { kind?: unknown } | null)?.kind;
  switch (kind) {
    case "Oversize":
      return "too-large";
    case "UnsupportedType":
      return "unsupported";
    case "Locked":
      return "locked";
    default:
      return "error";
  }
}

// ---- auto-name ----------------------------------------------------------

/** Two-digit zero-pad for the auto-name timestamp. */
function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * The shared `YYYY-MM-DD HH-MM-SS` stamp used by the attachment auto-names
 * (pasted image, recorded voice note). Locale-independent + filename-safe
 * (dashes, not colons). `now`-injectable for deterministic tests.
 */
export function fileNameTimestamp(now: Date): string {
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
    `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`
  );
}

/** The file extension implied by a clipboard image MIME, for the paste
 *  auto-name. Mirrors the host's `auto_filename` allowlist; defaults to
 *  `png` (the dominant clipboard-image type) when the MIME is unknown. */
export function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "application/pdf":
      return "pdf";
    default:
      return "png";
  }
}

/**
 * Auto-generate the display filename for a pasted image:
 * `Pasted image YYYY-MM-DD HH-MM-SS.<ext>` (decision 1; no prompt). The
 * extension is derived from the clipboard MIME. `now` is injectable for
 * deterministic tests.
 */
export function autoPasteName(mime: string, now: Date = new Date()): string {
  return `Pasted image ${fileNameTimestamp(now)}.${extensionForMime(mime)}`;
}

// ---- import over IPC ----------------------------------------------------

/** The IPC call, isolated so tests can override it without a Tauri runtime. */
type ImportFn = (source: ImportSource) => Promise<ImportedAttachment>;

let importFn: ImportFn = (source) =>
  invoke<ImportedAttachment>("plugin:attachments|attachment_import", { source });

/** Override the import IPC (tests only). Returns a restore fn. */
export function setImportFn(fn: ImportFn): () => void {
  const prev = importFn;
  importFn = fn;
  return () => {
    importFn = prev;
  };
}

/** Import one source, folding any rejection into an {@link ImportOutcome}
 *  (never throws) so multi-file callers get clean partial-success accounting. */
export async function importOne(source: ImportSource): Promise<ImportOutcome> {
  try {
    const attachment = await importFn(source);
    return { ok: true, attachment };
  } catch (err) {
    return { ok: false, reason: skipReasonFromError(err) };
  }
}

/** Import many sources in document order, preserving order in the result. */
export async function importMany(
  sources: readonly ImportSource[],
): Promise<readonly ImportOutcome[]> {
  const out: ImportOutcome[] = [];
  for (const source of sources) {
    out.push(await importOne(source));
  }
  return out;
}

// ---- toast summary ------------------------------------------------------

/** A single skip line for the toast summary, e.g. "1 skipped: too large". */
function skipPhrase(reason: SkipReason, count: number): string {
  const noun =
    reason === "too-large"
      ? i18n.t("editor.attachment.summary.reason.tooLarge")
      : reason === "unsupported"
        ? i18n.t("editor.attachment.summary.reason.unsupported")
        : reason === "locked"
          ? i18n.t("editor.attachment.summary.reason.locked")
          : i18n.t("editor.attachment.summary.reason.failed");
  return i18n.t("editor.attachment.summary.skipped", { count, noun });
}

/**
 * Build the partial-success toast summary from a batch of outcomes
 * (decision 3). Returns `null` when there is nothing worth announcing —
 * a single successful import is silent (the embed itself is the feedback).
 *
 * Examples:
 *   2 added · 1 skipped: too large
 *   1 added
 *   3 skipped: unsupported type
 */
export function summarizeBatch(outcomes: readonly ImportOutcome[]): string | null {
  const added = outcomes.filter((o) => o.ok).length;
  const skips = outcomes.filter((o): o is Extract<ImportOutcome, { ok: false }> => !o.ok);

  // A single clean success: no toast (the inserted embed is the feedback).
  if (skips.length === 0) {
    return added <= 1 ? null : i18n.t("editor.attachment.summary.added", { count: added });
  }

  // Group skips by reason, in a stable order.
  const order: SkipReason[] = ["too-large", "unsupported", "locked", "error"];
  const counts = new Map<SkipReason, number>();
  for (const s of skips) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const skipParts = order
    .filter((r) => counts.has(r))
    .map((r) => skipPhrase(r, counts.get(r)!));

  const parts: string[] = [];
  if (added > 0) parts.push(i18n.t("editor.attachment.summary.added", { count: added }));
  parts.push(...skipParts);
  return parts.join(" · ");
}

// ---- imported filename-only ref parse (import-&-convert) ----------------

/** A located filename-only image ref in the note body — the kind the
 *  import-&-convert command rewrites to form C. */
export interface ImportedImageRef {
  /** Embed form: `![[image.png]]` (Obsidian wikilink embed). */
  readonly kind: "wikilink-embed" | "markdown-image";
  /** Byte offset of the ref's first char in the doc. */
  readonly from: number;
  /** Byte offset one past the ref's last char. */
  readonly to: number;
  /** The raw matched text (for the diff preview's "before" line). */
  readonly raw: string;
  /** The source path/filename to resolve + import (the link target). */
  readonly source: string;
  /** The alias/alt to carry into the form-C display filename, if any. */
  readonly alias: string | null;
}

// `![[ target ]]` where target is NOT already an `att:` ref. Captures an
// optional `|alias`. Non-att embeds only — a form-C embed is left untouched.
const WIKILINK_EMBED_RE = /!\[\[(?!att:)([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
// `![alt](path)` markdown image. Captures alt + path. Excludes URLs with a
// scheme (http:, https:, data:, attachment:) — those are not local files.
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/** True if a markdown-image destination looks like a remote/data URL rather
 *  than a local file path (which import-&-convert cannot resolve). */
function isUrlLike(dest: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(dest.trim());
}

/**
 * Find every imported filename-only image ref in `body` — the
 * `![[image.png]]` wikilink-embed and `![alt](path)` markdown-image forms,
 * in document order. Form-C embeds (`![[att:…]]`) and URL-bearing markdown
 * images are excluded (nothing to convert). Pure; the convert command feeds
 * the result into the diff preview.
 */
export function findImportedImageRefs(body: string): readonly ImportedImageRef[] {
  const out: ImportedImageRef[] = [];

  WIKILINK_EMBED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_EMBED_RE.exec(body)) !== null) {
    const target = m[1].trim();
    if (target === "") continue;
    out.push({
      kind: "wikilink-embed",
      from: m.index,
      to: m.index + m[0].length,
      raw: m[0],
      source: target,
      alias: m[2]?.trim() || null,
    });
  }

  MARKDOWN_IMAGE_RE.lastIndex = 0;
  while ((m = MARKDOWN_IMAGE_RE.exec(body)) !== null) {
    const dest = m[2].trim();
    if (dest === "" || isUrlLike(dest)) continue;
    out.push({
      kind: "markdown-image",
      from: m.index,
      to: m.index + m[0].length,
      raw: m[0],
      source: dest,
      alias: m[1].trim() || null,
    });
  }

  // Document order so the diff preview reads top-to-bottom and the
  // single-transaction rewrite applies offsets back-to-front safely.
  out.sort((a, b) => a.from - b.from);
  return out;
}

/** The display filename to carry into the form-C alias for a converted ref:
 *  prefer the explicit alias, else the source's final path component. */
export function displayNameForRef(ref: ImportedImageRef): string {
  if (ref.alias !== null && ref.alias !== "") return ref.alias;
  const parts = ref.source.split(/[/\\]/);
  return parts[parts.length - 1] || ref.source;
}

/** One planned rewrite: the located ref + the form-C text that replaces it,
 *  produced after the source has been resolved + imported (id minted). */
export interface PlannedRewrite {
  readonly ref: ImportedImageRef;
  /** The form-C replacement text `![[att:<id>|filename]]`. */
  readonly replacement: string;
}

/** Build the form-C replacement text for a converted ref under an imported id. */
export function planRewrite(ref: ImportedImageRef, imported: ImportedAttachment): PlannedRewrite {
  // Prefer the catalog filename the host stored (auto/derived), falling back
  // to the ref's own display name. Either way the byte change is confined to
  // the matched ref span (byte-preserving everywhere else — markdown-dialect
  // C1 is honored: this is post-import, user-initiated, diff-previewed).
  const filename = imported.filename || displayNameForRef(ref);
  return { ref, replacement: emitAttachmentEmbed(imported.id, filename) };
}
