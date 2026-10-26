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
// hand-mirrored per the no-codegen note in `src/AGENTS.md`.

import type { Text } from "@codemirror/state";
import { getHost } from "../host";
import i18n from "@myne/editor/i18n";
import { emitAttachmentEmbed } from "@myne/editor/host/notes/attachmentRef";
import {
  type EmbedLayout,
  emptyEmbedLayout,
  parseEmbedAlias,
} from "@myne/dialect/embedLayout";
import { isMediaTarget } from "@myne/editor/host/notes/graphModel";
import { formatBytes, typeLabel } from "@myne/editor/host/components/attachments/format";

/** The success payload of `attachment_import` (mirrors Rust
 *  `ImportedAttachment`). Only the fields the insert path needs. */
// `ImportedAttachment` and `ImportSource` moved to the host seam (`../host`)
// with phase3-web-client task 76: they are now part of the contract a host
// implements, and defining them here while the host consumed them would have
// made this module a dependency of the seam rather than a consumer of it.
// Re-exported so every existing importer of `./insert` is unchanged.
export type { ImportedAttachment, ImportSource, PickedFile } from "../host";
import type { ImportSource, ImportedAttachment } from "../host";

/** Mirror of the Rust `AttachmentImportError` closed taxonomy (tag = "kind",
 *  content = "detail"). Hand-kept in lockstep with
 *  `core/src/plugins/attachments/error.rs`. */
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

let importFn: ImportFn = (source) => getHost().attachments.import(source);

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

// ---- compression notice --------------------------------------------------

/** Aggregate ingest-time-compression signal across a batch of import
 *  outcomes — the insert-time disclosure (PRD story 4). Multiple compressed
 *  images in one batch sum their before/after bytes into a single notice
 *  rather than stacking toasts (the toast surface shows one message at a
 *  time); the container-change flag is `true` if any of them changed. */
export interface CompressionSummary {
  readonly originalBytes: number;
  readonly finalBytes: number;
  readonly containerChanged: boolean;
  readonly contentType: string;
}

/**
 * Fold a batch of outcomes into one {@link CompressionSummary}, or `null`
 * when none of them actually compressed. `null` covers every case the notice
 * must stay silent for: the preference off, a dedup hit, an ineligible
 * source, or a transform that produced no improvement — `attachment_import`
 * (`core/src/plugins/attachments/commands.rs`) only ever sets
 * `original_size` when a fresh import's bytes actually got smaller.
 */
export function summarizeCompression(
  outcomes: readonly ImportOutcome[],
): CompressionSummary | null {
  return summarizeCompressedAttachments(
    outcomes.filter((o): o is Extract<ImportOutcome, { ok: true }> => o.ok).map((o) => o.attachment),
  );
}

/**
 * {@link summarizeCompression} over stored attachments directly, for the import
 * routes that never build an `ImportOutcome`.
 *
 * Compression is gated in shared core, so it fires on **every** import route —
 * paste, drop, `/attach`, import-&-convert, the cover picker, the vault
 * importer, the browser clipper. The disclosure obligation follows the
 * behaviour (`decisions.md` 2026-07-30: disclosure at import is what stands in
 * for a consent gate), so it has to be reachable from a route that has an
 * `ImportedAttachment` and nothing else. This is that entry point; every route
 * folds the same way rather than each computing its own idea of the notice.
 */
export function summarizeCompressedAttachments(
  attachments: readonly ImportedAttachment[],
): CompressionSummary | null {
  const compressed = attachments.filter((a) => a.original_size != null);
  if (compressed.length === 0) return null;
  // The format label names the container the swap produced, so it has to come
  // from an attachment that actually swapped — in a mixed batch the last
  // compressed import may be one that kept its container, and naming its type
  // would tell the user the wrong format.
  const swapped = compressed.filter((a) => a.container_changed === true);
  const labelled = swapped.length > 0 ? swapped : compressed;
  return {
    originalBytes: compressed.reduce((sum, a) => sum + (a.original_size ?? 0), 0),
    finalBytes: compressed.reduce((sum, a) => sum + a.size, 0),
    containerChanged: swapped.length > 0,
    contentType: labelled[labelled.length - 1].content_type,
  };
}

/** Render a {@link CompressionSummary} into the insert-time notice text
 *  (decision: reuse the existing attachment toast rather than a new surface).
 *  Mentions the container swap (e.g. PNG → WebP) only when one occurred, so
 *  a filename that silently changed extension does not arrive unannounced. */
export function compressionNoticeMessage(summary: CompressionSummary): string {
  const from = formatBytes(summary.originalBytes);
  const to = formatBytes(summary.finalBytes);
  return summary.containerChanged
    ? i18n.t("editor.attachment.compression.noticeContainerChanged", {
        format: typeLabel(summary.contentType),
        from,
        to,
      })
    : i18n.t("editor.attachment.compression.notice", { from, to });
}

/** An additive ingest-time-compression count, for the routes that import in
 *  BULK and report a summary rather than a per-batch toast (the vault importer,
 *  the browser clipper). Additive on purpose: those routes accumulate across
 *  many notes/pages and cannot hold every {@link CompressionSummary} to fold at
 *  the end, and unlike a summary this carries no format label — naming one
 *  container across hundreds of images would be noise at best and wrong at
 *  worst. */
export interface CompressionTally {
  readonly count: number;
  readonly originalBytes: number;
  readonly finalBytes: number;
}

/** The zero tally — the correct state for a route that imported nothing. */
export function emptyCompressionTally(): CompressionTally {
  return { count: 0, originalBytes: 0, finalBytes: 0 };
}

/** Tally the compressed subset of `attachments`. Uncompressed imports
 *  contribute nothing, so an all-uncompressed batch yields the zero tally and
 *  the surface stays silent. */
export function tallyCompression(
  attachments: readonly ImportedAttachment[],
): CompressionTally {
  let count = 0;
  let originalBytes = 0;
  let finalBytes = 0;
  for (const a of attachments) {
    if (a.original_size == null) continue;
    count += 1;
    originalBytes += a.original_size;
    finalBytes += a.size;
  }
  return { count, originalBytes, finalBytes };
}

/** Merge two tallies. */
export function addCompressionTally(
  a: CompressionTally,
  b: CompressionTally,
): CompressionTally {
  return {
    count: a.count + b.count,
    originalBytes: a.originalBytes + b.originalBytes,
    finalBytes: a.finalBytes + b.finalBytes,
  };
}

/** Render a {@link CompressionTally} as the bulk-import disclosure line, or
 *  `null` when nothing was compressed — a notice that appears when nothing
 *  happened is how a user learns to stop reading notices. */
export function compressionTallyMessage(tally: CompressionTally): string | null {
  if (tally.count === 0) return null;
  return i18n.t("editor.attachment.compression.bulkNotice", {
    count: tally.count,
    from: formatBytes(tally.originalBytes),
    to: formatBytes(tally.finalBytes),
  });
}

/**
 * The ONE toast message a finished batch deserves, or `null` for silence.
 *
 * The toast surface shows a single message at a time (`toast.ts` replaces the
 * visible one), so the composition happens here rather than by calling
 * `showAttachmentToast` twice and letting the second win.
 *
 * Both parts are kept when both fire — they answer different questions and
 * neither substitutes for the other. Drop five images, four over the 64 MiB
 * cap and one compressed, and "Compressed to WebP: 149 KiB → 40 KiB" alone
 * would be a true sentence that hides the more actionable fact: four files did
 * not arrive. The compression disclosure leads because it is the irreversible
 * half, and the skip count follows, joined with the same `" · "` separator
 * `summarizeBatch` already uses between its own parts.
 *
 * Every insert path (paste, drop, `/attach`) announces through this, so the
 * composition is a decision stated once instead of a call-order convention
 * copied between call sites.
 */
export function importToastMessage(outcomes: readonly ImportOutcome[]): string | null {
  const compression = summarizeCompression(outcomes);
  const batch = summarizeBatch(outcomes);
  if (compression === null) return batch;
  const notice = compressionNoticeMessage(compression);
  return batch === null ? notice : `${notice} · ${batch}`;
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
  /** The author's layout choices recovered from the ref (myne#409): an
   *  Obsidian `|300` / `|300x200` dimension on a wikilink embed, or the alt
   *  text of a markdown image. Empty when the ref carried neither. */
  readonly layout: EmbedLayout;
  /** The alias/alt to carry into the form-C display filename, if any. */
  readonly alias: string | null;
}

// `![[ target ]]` where target is NOT already an `att:` ref. Captures an
// optional `|alias`. Non-att embeds only — a form-C embed is left untouched.
const WIKILINK_EMBED_RE = /!\[\[(?!att:)([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
// The bare link target: the dialect's wikilink parser splits `#heading` and
// `^block-id` off the target, and this raw-text regex does not, so strip the
// first anchor marker before asking whether the target names media. First `#`
// or `^` wins, matching `dialect/src/lezer/wikilink.ts`.
const EMBED_ANCHOR_RE = /[#^]/;
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
 *
 * A `![[…]]` embed whose target does NOT name media is a **note embed**, and
 * it is excluded here — it is not an image ref, so there is nothing to import
 * and nothing to rewrite. Myne treats `![[Note]]` as first class everywhere
 * else (`extractWikilinkEdges` keeps it as a graph edge flagged `embed`,
 * rename propagation rewrites inside it, `markdown-dialect.md` §3.5 lists the
 * form), and this was the one path with no concept of a note target: the
 * media pipeline resolved `Meeting Notes` against the media index, missed,
 * and replaced the whole span with `<!-- omitted attachment: … -->` — losing
 * the embed and its graph edge, and reporting it as missing media
 * (myne-md/myne#223). Discrimination is `isMediaTarget`'s whitelist, the same
 * one the graph model uses, so a dotted note title (`![[2024.review]]`) is
 * not false-excluded and a hand-typed `![[Note.md]]` reads as the note it is.
 *
 * The `![alt](path)` arm keeps taking any local path: markdown-image syntax
 * is unambiguously a media form, and gating it on the whitelist would drop
 * legitimate images with unlisted extensions.
 */
export function findImportedImageRefs(body: string): readonly ImportedImageRef[] {
  const out: ImportedImageRef[] = [];

  WIKILINK_EMBED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_EMBED_RE.exec(body)) !== null) {
    const target = m[1].trim();
    if (target === "") continue;
    const anchor = target.search(EMBED_ANCHOR_RE);
    const bare = anchor === -1 ? target : target.slice(0, anchor);
    if (!isMediaTarget(bare)) continue; // note embed — left byte-for-byte alone
    // An Obsidian image embed spends its alias on the DIMENSION
    // (`![[photo.png|300]]`, `![[photo.png|300x200]]`), not on a display name.
    // Read as an alias it became the filename after import and the author's
    // chosen width was gone with nothing in the summary saying so (myne#409).
    const alias = m[2]?.trim() || null;
    const dimension = alias === null ? null : parseObsidianDimension(alias);
    out.push({
      kind: "wikilink-embed",
      from: m.index,
      to: m.index + m[0].length,
      raw: m[0],
      source: target,
      // A dimension is NOT a display name, so it must not fall through to
      // `displayNameForRef` and become the filename.
      alias: dimension === null ? alias : null,
      layout: dimension ?? emptyEmbedLayout(),
    });
  }

  MARKDOWN_IMAGE_RE.lastIndex = 0;
  while ((m = MARKDOWN_IMAGE_RE.exec(body)) !== null) {
    const dest = m[2].trim();
    if (dest === "" || isUrlLike(dest)) continue;
    const alt = m[1].trim();
    out.push({
      kind: "markdown-image",
      from: m.index,
      to: m.index + m[0].length,
      raw: m[0],
      source: dest,
      alias: alt || null,
      // Markdown-image alt text IS alt text. Carrying it into `alt=` is
      // lossless even when it contains a pipe, because `alt=` is terminal.
      layout: alt === "" ? emptyEmbedLayout() : { ...emptyEmbedLayout(), alt },
    });
  }

  // Document order so the diff preview reads top-to-bottom and the
  // single-transaction rewrite applies offsets back-to-front safely.
  out.sort((a, b) => a.from - b.from);
  return out;
}


/** Obsidian's image-embed dimension alias: `300` or `300x200`. Lower-case `x`,
 *  matching Obsidian. Validated through OUR closed grammar rather than a second
 *  copy of the range rules, so an out-of-range import is refused by exactly the
 *  same bound an in-app edit is. Returns null when the alias is an ordinary
 *  display name (`![[diagram.png|My Diagram]]`), which stays an alias. */
function parseObsidianDimension(alias: string): EmbedLayout | null {
  const m = /^(\d+)(?:x(\d+))?$/.exec(alias);
  if (m === null) return null;
  const probe = m[2] === undefined ? `x|w=${m[1]}` : `x|w=${m[1]}|h=${m[2]}`;
  const { layout, dropped } = parseEmbedAlias(probe);
  if (dropped.length > 0) return null;
  return layout;
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
  return { ref, replacement: emitAttachmentEmbed(imported.id, filename, ref.layout) };
}

/**
 * Place freshly-emitted embed text on a line of its own (myne-md/myne#604).
 *
 * # Why the INSERT path and not the renderer
 *
 * The renderer draws an embed as a block only when the source has it alone on
 * its line (`embedIsAlone`), and CodeMirror will not accept a block decoration
 * on anything narrower than whole lines. So "an embed gets its own row" is half
 * a rendering rule and half this: what Myne itself writes is what Myne can then
 * draw well.
 *
 * # Why this is not a byte-stability violation
 *
 * `markdown-dialect.md` §6 C1 binds the PARSER: a note's existing bytes survive
 * a round trip unchanged. This is Myne composing its own output at the moment
 * the user asks for an attachment, which is the same latitude every other
 * insertion in the editor has. An embed already in a note is never moved.
 *
 * # The rule
 *
 * A newline is added only where one is actually needed. Whitespace before the
 * cursor is left alone rather than trimmed, so a screenshot pasted at the indent
 * under a task item stays at that indent, which `embedIsAlone` accepts because
 * it compares against the trimmed line.
 */
export function ownLineInsertion(
  doc: Text,
  at: number,
  text: string,
): { readonly insert: string; readonly anchor: number } {
  const line = doc.lineAt(at);
  const before = doc.sliceString(line.from, at);
  const after = doc.sliceString(at, line.to);
  const prefix = before.trim() === "" ? "" : "\n";
  const suffix = after.trim() === "" ? "" : "\n";
  return { insert: `${prefix}${text}${suffix}`, anchor: at + prefix.length + text.length };
}
