// IPC wrappers + rebuild-on-unlock sweep + title/forward resolution for
// the VaultIndices backend (MYND-31 / A11).
//
// Build-B (design session 2026-06-07): dialect extraction stays TS-side
// (the single dialect source of truth); these wrappers feed the Rust
// VaultIndices (which owns the struct + query surface + persistence) and
// resolve via the SINGLE resolver (`resolveWikilink.ts`, §5.3) — no
// second resolver, so chip-vs-panel resolution can never diverge.

import { invoke } from "@tauri-apps/api/core";
import { extractBlockAnchors } from "@myne/editor";
import { foldSegment, normalizeFolderPath } from "../dialect/folderPath";
import { parse } from "../dialect/parse";
import type {
  ParseResult,
  WikilinkRef,
  WikilinkTargetKind,
} from "../dialect/types";
import { bumpIndexNonce } from "./indexNonce";
import { noteRead } from "./readNote";
import {
  applyNoteAttachmentRefs,
  removeNoteAttachmentRefs,
} from "./attachmentRefs";
import {
  liveIdSet,
  parseTarget,
  resolveWikilink,
  type ResolverNote,
  type WikilinkResolution,
} from "./resolveWikilink";
import { extractProperties, type PropertyEntry } from "./propertyTyping";
import type { StoredProperty } from "./queryEngine";

/**
 * One per-occurrence outbound wikilink edge — the TS mirror of the Rust
 * `WikilinkEdge` (serde camelCase both ways). Title-keyed (Model-2): no
 * resolved UUID; resolution runs TS-side at query time.
 */
export type WikilinkEdge = {
  target: string;
  targetKind: WikilinkTargetKind;
  /** Folded title-key of the target (§3.7.8 fold) — the backlink bucket
   *  key, computed here so Rust never folds (no Turkish divergence). */
  titleKey: string;
  anchor: string | null;
  blockId: string | null;
  alias: string | null;
  embed: boolean;
  byteStart: number;
  byteEnd: number;
};

/**
 * Known attachment/media extensions. An `![[…]]` embed whose target ends
 * with one of these is a media embed (E2) — excluded from BOTH the note
 * graph and broken-links. A WHITELIST, not "any non-`.md`", so dotted
 * note titles (`[[2024.review]]`, `[[v0.1]]`) are NOT false-excluded.
 */
const MEDIA_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
  ".pdf",
  ".mp3",
  ".m4a",
  ".wav",
  ".ogg",
  ".mp4",
  ".webm",
  ".mov",
];

export function isMediaTarget(target: string): boolean {
  const lastSegment = target.split("/").pop() ?? target;
  const lower = lastSegment.toLowerCase();
  return MEDIA_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** A note tag — TS mirror of the Rust `TagEntry` (N2): the exact folded
 *  tag is the canonical key, with the note's original casing for display. */
export type TagEntry = {
  folded: string;
  display: string;
};

/** One imported `^block-id` anchor — TS mirror of the Rust `BlockAnchor`
 *  (MYND-382). Enumerate-only: surfaces markers that already exist (import),
 *  never mints one. `preview` is the tagged block's first-line text (picker
 *  secondary line). serde camelCase. */
export type BlockAnchorEntry = {
  blockId: string;
  preview: string;
};

/** Max characters of block text kept as the picker preview line. */
const BLOCK_ANCHOR_PREVIEW_CAP = 120;

/** The line-tail marker grammar (mirrors `extractBlockAnchors`) — used only to
 *  strip the ` ^id` suffix from a preview line. */
const BLOCK_MARKER_TAIL = /(?:^|[ \t])\^[A-Za-z0-9-]+[ \t]*$/;

/**
 * Enumerate a note's imported `^block-id` anchors as `{blockId, preview}`
 * entries for the vault-wide `[[^^` index (MYND-382). Reuses the single dialect
 * scanner `extractBlockAnchors` for the marker grammar, then derives each
 * preview from the tagged block's line (marker stripped, whitespace-collapsed,
 * capped). Enumerate-only — mints nothing.
 */
export function extractBlockAnchorEntries(body: string): BlockAnchorEntry[] {
  return extractBlockAnchors(body).map(({ blockId, from }) => {
    const nl = body.indexOf("\n", from);
    const line = body.slice(from, nl === -1 ? undefined : nl);
    let preview = line.replace(BLOCK_MARKER_TAIL, "").replace(/\s+/g, " ").trim();
    // An own-line marker (`^id` alone on its line) is Obsidian's form for a
    // NON-paragraph block (table / list / callout / code): the marker refers to
    // the PRECEDING block, so the marker line strips to empty. Fall back to the
    // nearest preceding non-empty line so the picker still shows a real preview.
    if (preview === "") preview = precedingNonEmptyLine(body, from);
    return { blockId, preview: preview.slice(0, BLOCK_ANCHOR_PREVIEW_CAP) };
  });
}

/** The nearest non-empty line strictly before offset `from` (a marker line's
 *  start), whitespace-collapsed — the preview for an own-line block marker. */
function precedingNonEmptyLine(body: string, from: number): string {
  const before = body.slice(0, from > 0 ? from - 1 : 0);
  const lines = before.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.replace(/\s+/g, " ").trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** Pull frontmatter `tags:` / `tag:` values, coercing to strings. Accepts a
 *  single scalar, a YAML list, or numbers (frontmatter numeric tags are
 *  valid — §3.7.6 — unlike inline `#1984` which the parser already rejects). */
function collectFrontmatterTags(
  parsed: Record<string, unknown> | null,
): string[] {
  if (parsed === null) return [];
  const out: string[] = [];
  const consume = (raw: unknown): void => {
    if (typeof raw === "string") out.push(raw);
    else if (typeof raw === "number") out.push(String(raw));
    else if (Array.isArray(raw)) for (const item of raw) consume(item);
  };
  consume(parsed["tags"]);
  consume(parsed["tag"]);
  return out;
}

/**
 * Build the note's tag list: inline `#tags` (already numeric-rejected +
 * exclusion-zone-filtered by the lezer parser) ∪ frontmatter `tags:`
 * (YAML list, numerics allowed). Source-agnostic union (U1), folded TS-side
 * (§3.7.8), deduped by folded key (first display wins for this note; the
 * cross-note display representative is chosen deterministically in
 * `tag_tree`).
 */
export function extractTags(parsed: ParseResult): TagEntry[] {
  const seen = new Set<string>();
  const out: TagEntry[] = [];
  const push = (display: string): void => {
    const trimmed = display.trim();
    if (trimmed.length === 0) return;
    const folded = foldSegment(trimmed);
    if (folded.length === 0 || seen.has(folded)) return;
    seen.add(folded);
    out.push({ folded, display: trimmed });
  };
  for (const t of parsed.inlineTags) push(t.tag);
  for (const ft of collectFrontmatterTags(parsed.frontmatter.parsed)) push(ft);
  return out;
}

/**
 * Build the per-occurrence edge list from a note's parsed wikilinks.
 * Classification: `![[image.png]]`-style attachment embeds are skipped
 * (E2 — not note edges, kept out of broken-links); `![[Note]]` note
 * embeds become edges flagged `embed`; anchors/aliases/byte ranges are
 * carried verbatim. self-links are kept (the UI filters them).
 */
export function extractWikilinkEdges(
  wikilinks: ReadonlyArray<WikilinkRef>,
): WikilinkEdge[] {
  const edges: WikilinkEdge[] = [];
  for (const w of wikilinks) {
    if (w.embed && isMediaTarget(w.target)) {
      continue; // attachment embed — owned by the future media pipeline
    }
    edges.push({
      target: w.target,
      targetKind: w.targetKind,
      // Fold the parsed title via the SAME parse the resolver uses, so the
      // bucket key matches a note's own folded title-key (single source).
      titleKey: foldSegment(parseTarget(w).title),
      anchor: w.heading,
      blockId: w.blockId,
      alias: w.alias,
      embed: w.embed,
      byteStart: w.byteRange.start,
      byteEnd: w.byteRange.end,
    });
  }
  return edges;
}

/** Upsert a note's index contribution (title + folder + wikilink edges + tags
 *  + typed frontmatter properties). */
export async function vaultIndicesApply(
  noteId: string,
  title: string | null,
  folder: string | null,
  wikilinks: ReadonlyArray<WikilinkEdge>,
  tags: ReadonlyArray<TagEntry>,
  properties: ReadonlyArray<PropertyEntry>,
  blockAnchors: ReadonlyArray<BlockAnchorEntry>,
): Promise<void> {
  await invoke<void>("plugin:vault-indices|vault_indices_apply", {
    noteId,
    title,
    folder,
    // The note's own folded title-key (§3.7.8 fold, TS-side like the edge
    // title-keys) — the in-degree side of the orphan query (MYND-197).
    titleKey: title === null ? null : foldSegment(title),
    wikilinks,
    tags,
    // Build-B (MYND-271): TS types every frontmatter property (§3.6.4); Rust
    // stores these opaque pre-typed values and never parses YAML (TB9).
    properties,
    // MYND-382: enumerate-only imported block anchors for the `[[^^` picker.
    blockAnchors,
  });
  // SYNC-5: bump the index-changed nonce AFTER the slice updated (single
  // post-mutation chokepoint) so reader surfaces re-query.
  bumpIndexNonce();
}

/**
 * Whole-vault edge dump (MYND-197): `[noteId, edges][]` for every indexed
 * note, resolved once TS-side by the graph adapter. The CLIENT must route by
 * note count BEFORE calling this — a vault over the render cap takes the
 * per-note BFS subgraph path instead (the Rust side applies only a defensive
 * edge-ceiling, not the render cap).
 */
export async function vaultIndicesAllEdges(): Promise<
  Array<[string, WikilinkEdge[]]>
> {
  return await invoke<Array<[string, WikilinkEdge[]]>>(
    "plugin:vault-indices|vault_indices_all_edges",
  );
}

/**
 * Structurally-isolated ("orphan") note ids (MYND-197 / SYNC-13) — zero raw
 * in+out edges. A degree-0 index query, so the orphans-only graph view works
 * at any vault size without the edge dump. (Notes whose only links are broken
 * are not flagged here — that resolved-orphan refinement is TS-side, deferred.)
 */
export async function vaultIndicesOrphans(): Promise<string[]> {
  return await invoke<string[]>("plugin:vault-indices|vault_indices_orphans");
}

/** One resolved vault-wide block anchor — TS mirror of the Rust
 *  `VaultBlockAnchor` (MYND-382). The `[[^^` picker row: which note carries the
 *  anchor (id + title) + the block id + preview. Opening inserts a
 *  `[[<note>^blockId]]` deep-link. */
export type VaultBlockAnchor = {
  noteId: string;
  noteTitle: string | null;
  noteFolder: string | null;
  blockId: string;
  preview: string;
};

/**
 * Every imported `^block-id` anchor across the vault (MYND-382, the `[[^^`
 * picker). Enumerate-only — surfaces markers that already exist (import), never
 * mints one. The picker sorts + filters these TS-side; resolution stays TS-side.
 */
export async function vaultBlockAnchors(): Promise<VaultBlockAnchor[]> {
  return await invoke<VaultBlockAnchor[]>(
    "plugin:vault-indices|vault_indices_block_anchors",
  );
}

/** Every note carrying a frontmatter property named `key`, as
 *  `[noteId, StoredProperty]` (MYND-272 / the Saved Views query engine's by-key
 *  primitive). Mirrors the Rust `vault_indices_property_values` accessor (#1) —
 *  the opaque pre-typed values; the engine compares them type-awarely TS-side. */
export async function vaultIndicesPropertyValues(
  key: string,
): Promise<Array<[string, StoredProperty]>> {
  return await invoke<Array<[string, StoredProperty]>>(
    "plugin:vault-indices|vault_indices_property_values",
    { key },
  );
}

/** Remove a hard-deleted note from the index. Trash does NOT route here —
 *  a trashed note stays indexed and is filtered TS-side via `isTrashed`. */
export async function vaultIndicesRemove(noteId: string): Promise<void> {
  // MYND-169 SYNC-6: drop the note from the attachment reference graph in
  // lockstep with the VaultIndices removal (hard-delete / empty-trash).
  // Best-effort + independent (its own try/catch) so a reconcile hiccup
  // never blocks the VaultIndices removal.
  void removeNoteAttachmentRefs(noteId);
  await invoke<void>("plugin:vault-indices|vault_indices_remove", { noteId });
  bumpIndexNonce(); // SYNC-5: chokepoint bump, after the slice updated.
}

/**
 * Persist the live in-RAM VaultIndices to the encrypted `vault.indices`
 * (`MYI1`) blob (Task 8 / MYND-271). Best-effort — call on graceful lock /
 * quit (alongside the workspace persist). A failure leaves the RAM index
 * intact; the next unlock rebuilds the missing delta.
 */
export async function vaultIndicesPersist(): Promise<void> {
  await invoke<void>("plugin:vault-indices|vault_indices_persist");
}

/**
 * Load the `vault.indices` blob on unlock (the fast path) and return the
 * **stale** note ids (changed / new since the snapshot) for the caller to
 * re-apply. Unchanged notes are already populated into the store by the host;
 * deleted notes are dropped. An absent / undecodable / stale blob → every
 * on-disk note is returned stale → a full rebuild (the cache is never
 * authoritative, §9.8.4 / SYNC-1).
 */
export async function vaultIndicesHydrate(): Promise<string[]> {
  return await invoke<string[]>("plugin:vault-indices|vault_indices_hydrate");
}

/** Derive `{title, folder}` from a parsed note's frontmatter — the same
 *  shape the sidebar derives (frontmatter `title:` string else null; no
 *  H1 fallback; `folder:` normalized), so the index's title/folder match
 *  the resident note-set the resolver runs against. */
function deriveTitleFolder(parsed: ParseResult): {
  title: string | null;
  folder: string | null;
} {
  const fm = parsed.frontmatter.parsed;
  const title =
    fm !== null && typeof fm["title"] === "string" ? (fm["title"] as string) : null;
  const rawFolder = fm !== null ? fm["folder"] : undefined;
  const folder = normalizeFolderPath(
    typeof rawFolder === "string" ? rawFolder : null,
  );
  return { title, folder };
}

/**
 * Re-index a single note from an in-hand body (decrypt-free — used on the
 * editor-save path where the body is already in V8). Parses once, derives
 * title/folder + edges + tags, and applies. Best-effort: a parse/apply
 * failure is swallowed and self-healed by the next reconcile.
 */
export async function reindexNoteFromBody(
  noteId: string,
  body: string,
): Promise<void> {
  try {
    const parsed = parse(body);
    const { title, folder } = deriveTitleFolder(parsed);
    await vaultIndicesApply(
      noteId,
      title,
      folder,
      extractWikilinkEdges(parsed.wikilinks),
      extractTags(parsed),
      // §3.6.4 typed properties from the raw frontmatter (re-parsed CORE-schema
      // TS-side; deriveTitleFolder above reads the project-default parse).
      extractProperties(parsed.frontmatter.raw),
      // MYND-382: imported `^block-id` anchors for the vault-wide `[[^^` picker.
      extractBlockAnchorEntries(body),
    );
  } catch {
    // Best-effort — self-healed by a later apply / the next reconcile.
  }
  // MYND-169 SYNC-6: in lockstep with the VaultIndices reindex above, push
  // the note's attachment references (form-C `![[att:<id>|…]]` embeds) to the
  // attachment reference graph. Independent best-effort — its own
  // try/catch lives in `applyNoteAttachmentRefs`, so a reconcile hiccup
  // never affects the VaultIndices apply (or vice-versa). Self-heals on the
  // next rebuild-on-unlock sweep.
  void applyNoteAttachmentRefs(noteId, body);
}

/** Re-index a single note by reading + parsing its body (for lifecycle
 *  events where the body isn't already in hand — create / rename / move). */
export async function reindexNote(noteId: string): Promise<void> {
  try {
    await reindexNoteFromBody(noteId, await noteRead(noteId));
  } catch {
    // Best-effort — `note_read` failure self-heals on the next reconcile.
  }
}

/**
 * Rebuild-on-unlock sweep (Build-B). Re-indexes every note (`note_read` +
 * `parse` + `apply`) — the reconcile + self-heal path. Best-effort per
 * note; boot is never blocked (fire-and-forget at the call site).
 */
export async function rebuildVaultIndices(
  noteIds: readonly string[],
): Promise<void> {
  for (const id of noteIds) {
    await reindexNote(id);
  }
}

/**
 * Unlock sweep with the `MYI1` fast path (Task 8 / MYND-271). Loads the
 * persisted `vault.indices` blob via {@link vaultIndicesHydrate} — the host
 * populates the store with the unchanged-note records and returns only the
 * **stale** (changed / new) ids — then re-applies just those (`reindexNote`).
 * The unchanged notes are NOT re-read or re-parsed, which is the whole point
 * of the persisted projection. On any hydrate failure (no blob / IPC error)
 * it falls back to a full rebuild over `allIds` — the cache is never
 * authoritative (§9.8.4 / SYNC-1). Best-effort; boot is never blocked.
 */
export async function hydrateVaultIndicesOnUnlock(
  allIds: readonly string[],
): Promise<void> {
  let stale: readonly string[];
  try {
    // The host returns all on-disk ids as stale when the blob is absent /
    // undecodable, so a cold vault still does a full reindex here.
    stale = await vaultIndicesHydrate();
  } catch {
    // Command-level failure (slot / IO) — fall back to a full rebuild.
    stale = allIds;
  }
  for (const id of stale) {
    await reindexNote(id);
  }
}

/** A note's outbound link with its resolution (resolved or broken). */
export type ForwardLink = {
  edge: WikilinkEdge;
  resolution: WikilinkResolution;
};

/** Reconstruct a `WikilinkRef` from a stored edge so the single resolver
 *  can resolve it (plain-B — exactly the render-time resolution path). */
function edgeToRef(edge: WikilinkEdge): WikilinkRef {
  return {
    raw: `[[${edge.target}]]`,
    byteRange: { start: edge.byteStart, end: edge.byteEnd },
    embed: edge.embed,
    target: edge.target,
    targetKind: edge.targetKind,
    alias: edge.alias,
    heading: edge.anchor,
    blockId: edge.blockId,
  };
}

/**
 * Forward links of a note (`forward(id)` query). Fetches the raw edges
 * from Rust, then resolves each against the resident note-set via the
 * single resolver — returning both resolved and broken targets.
 */
export async function forward(
  noteId: string,
  notes: ReadonlyArray<ResolverNote>,
): Promise<ForwardLink[]> {
  const edges = await invoke<WikilinkEdge[]>(
    "plugin:vault-indices|vault_indices_forward",
    { noteId },
  );
  return resolveEdges(edges, notes);
}

/**
 * Resolve a batch of raw edges against the resident note-set via the SINGLE
 * resolver (the render-time path) — the shared core of `forward()` and the
 * graph adapter's whole-vault build (so the bulk dump resolves identically to
 * the per-note query; no second resolver). Pure (no IPC).
 */
export function resolveEdges(
  edges: ReadonlyArray<WikilinkEdge>,
  notes: ReadonlyArray<ResolverNote>,
): ForwardLink[] {
  return edges.map((edge) => ({
    edge,
    resolution: resolveWikilink(edgeToRef(edge), notes),
  }));
}

/** One backlink source note + its occurrences pointing at the queried
 *  note (the superset shape — a count UI reads `groups.length`, a
 *  per-occurrence UI expands `occurrences`). */
export type BacklinkGroup = {
  sourceUuid: string;
  sourceTitle: string | null;
  occurrences: WikilinkEdge[];
};

/**
 * Backlinks of a note (`backlinks(id)` query). Fetches every candidate
 * edge naming the note's folded title-key from Rust, resolves each via
 * the single resolver (so collision/ambiguity is handled exactly as at
 * render time), keeps those that actually resolve to `noteId`, and groups
 * by source note. Returns `[]` for an untitled note (nothing can link to
 * it by title). Self-links are included (the UI filters them if desired).
 */
export async function backlinks(
  noteId: string,
  notes: ReadonlyArray<ResolverNote>,
): Promise<BacklinkGroup[]> {
  const target = notes.find((n) => n.noteUuid === noteId);
  if (target === undefined || target.title === null) return [];
  const titleKey = foldSegment(target.title);
  const candidates = await invoke<Array<{ source: string; edge: WikilinkEdge }>>(
    "plugin:vault-indices|vault_indices_backlink_candidates",
    { titleKey },
  );

  // T3 trash exclusion: `notes` is the LIVE (non-trashed) resolver set, so
  // (a) a candidate from a trashed source is dropped here, and (b) resolving
  // against `notes` means a link to a trashed note never resolves (it reads
  // broken). The Rust index stays trash-blind; exclusion is entirely here.
  const liveIds = liveIdSet(notes);
  const groups = new Map<string, BacklinkGroup>();
  for (const candidate of candidates) {
    if (!liveIds.has(candidate.source)) continue; // trashed source
    const res = resolveWikilink(edgeToRef(candidate.edge), notes);
    if (res.status !== "resolved" || res.noteUuid !== noteId) continue;
    let group = groups.get(candidate.source);
    if (group === undefined) {
      const sourceNote = notes.find((n) => n.noteUuid === candidate.source);
      group = {
        sourceUuid: candidate.source,
        sourceTitle: sourceNote?.title ?? null,
        occurrences: [],
      };
      groups.set(candidate.source, group);
    }
    group.occurrences.push(candidate.edge);
  }
  return [...groups.values()];
}

/**
 * Note ids tagged with `tag` or any descendant (subtree-inclusive). The
 * tag is folded TS-side (§3.7.8) before the call so write-fold ==
 * query-fold — Rust does a plain exact/prefix match. The Rust index is
 * trash-blind; pass `liveIds` (the non-trashed id set, derived from the
 * existing `isTrashed` marker) to exclude trashed members (T3).
 */
export async function byTag(
  tag: string,
  liveIds?: ReadonlySet<string>,
): Promise<string[]> {
  const ids = await invoke<string[]>(
    "plugin:vault-indices|vault_indices_by_tag",
    { foldedTag: foldSegment(tag) },
  );
  return liveIds === undefined ? ids : ids.filter((id) => liveIds.has(id));
}

/** One node of the tag tree — TS mirror of the Rust `TagTreeNode`. */
export type TagTreeNode = {
  key: string;
  display: string;
  depth: number;
  directCount: number;
  subtreeCount: number;
};

/** The full tag tree (nodes with direct + subtree counts + deterministic
 *  display), derived Rust-side from the stored exact folded tags (N2). */
export async function tagTree(): Promise<TagTreeNode[]> {
  return await invoke<TagTreeNode[]>("plugin:vault-indices|vault_indices_tag_tree");
}

/**
 * Resolve a bare title (with an optional folder hint) to a note via the
 * single §5.3 resolver. plain-B: resolution runs TS-side over the
 * resident note-set, so there is exactly one resolver shared by render-
 * time chips and the index's query path. A title-only hint resolves by
 * title; a folder hint is a collision disambiguator only (§5.3).
 */
export function resolveTitle(
  title: string,
  folderHint: string | null,
  notes: ReadonlyArray<ResolverNote>,
): WikilinkResolution {
  const target = folderHint !== null ? `${folderHint}${title}.md` : title;
  const ref: WikilinkRef = {
    raw: `[[${target}]]`,
    byteRange: { start: 0, end: 0 },
    embed: false,
    target,
    targetKind: folderHint !== null ? "vault-path" : "title",
    alias: null,
    heading: null,
    blockId: null,
  };
  return resolveWikilink(ref, notes);
}
