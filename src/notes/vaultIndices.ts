// IPC wrappers + rebuild-on-unlock sweep + title/forward resolution for
// the VaultIndices backend (MYND-31 / A11).
//
// Build-B (design session 2026-06-07): dialect extraction stays TS-side
// (the single dialect source of truth); these wrappers feed the Rust
// VaultIndices (which owns the struct + query surface + persistence) and
// resolve via the SINGLE resolver (`resolveWikilink.ts`, §5.3) — no
// second resolver, so chip-vs-panel resolution can never diverge.

import { invoke } from "../platform/core";
import { foldSegment, normalizeFolderPath } from "../dialect/folderPath";
import { parse } from "../dialect/parse";
import {
  readArchivedFromFmBody,
  readConflictFromFmBody,
  readDeletedFromFmBody,
  readTemplateFromFmBody,
  readTrashedFromFmBody,
} from "../dialect";
import {
  isLiveNote,
  type NoteFlags,
} from "@myne/editor/host/notes/selectors";
import { extractLineTasks, type LineTask } from "../dialect/visitors/lineTasks";
import type { ParseResult, WikilinkRef } from "../dialect/types";
import { collectFrontmatterTags } from "./frontmatterTags";
import { bumpIndexNonce, getIndexNonce } from "./indexNonce";
import { noteRead } from "./readNote";
import {
  applyNoteAttachmentRefs,
  removeNoteAttachmentRefs,
} from "./attachmentRefs";
import {
  liveIdSet,
  resolveWikilink,
  type ResolverIndex,
  type ResolverNote,
  type WikilinkResolution,
} from "./resolveWikilink";
import {
  edgeToRef,
  extractWikilinkEdges,
  resolveEdges,
  type ForwardLink,
  type WikilinkEdge,
} from "./graphModel";
import { extractProperties, type PropertyEntry } from "./propertyTyping";
import type { StoredProperty } from "./queryEngine";

// The pure graph model — edge extraction, resolution and the `{nodes, edges}`
// build — moved to the shared `@myne/editor/host/notes/graphModel` (#199) so
// both clients answer "what does this link point at" once. Re-exported here so
// every existing import site keeps working; THIS module stays the IPC surface.
export {
  isMediaTarget,
  extractWikilinkEdges,
  resolveEdges,
  type WikilinkEdge,
  type ForwardLink,
} from "./graphModel";

/** A note tag — TS mirror of the Rust `TagEntry` (N2): the exact folded
 *  tag is the canonical key, with the note's original casing for display. */
export type TagEntry = {
  folded: string;
  display: string;
};

// The vault-wide picker halves that are not desktop-specific, meaning the
// `[[##` heading row/entry types with their join and the `[[^^` block-anchor
// types with their per-note extraction, moved to
// `@myne/editor/host/notes/{vaultHeadings,blockAnchors}` (myne-md/myne#452), so
// the mobile client answers them with this code rather than a copy of it. Same
// move `graphModel` made in #199, and re-exported here for the same reason:
// THIS module stays the IPC surface and every existing import site keeps
// working unchanged.
// Sub-entries, not the barrel: `@myne/editor` re-exports CMEditor +
// myneExtensions, and this module is on the boot path (editor-host ->
// vaultIndices), so a barrel import would drag the whole CodeMirror graph into
// the first-load bundle. Both modules below are CodeMirror-free (`blockAnchors`
// reaches `wikilink/anchor`, which depends only on `@myne/dialect`). Keep these
// paths; do not collapse them to `@myne/editor`.
import {
  extractBlockAnchorEntries,
  type BlockAnchorEntry,
  type VaultBlockAnchor,
} from "@myne/editor/host/notes/blockAnchors";
import type { HeadingEntry, VaultHeadingRow } from "@myne/editor/host/notes/vaultHeadings";
export { extractBlockAnchorEntries };
export type { BlockAnchorEntry, VaultBlockAnchor, HeadingEntry, VaultHeadingRow };

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
 * The note's working-set flags, read exactly as the sidebar cache reads them
 * (SYNC-1): the five shared dialect readers, over the same frontmatter body
 * `loadNoteBatch` hands them.
 *
 * **Not exported** (review finding): the comment here used to say a test held it
 * to `isLiveNote` directly and no test imported it, which is worse than either
 * half. The behaviour is pinned where it is OBSERVABLE instead,
 * `tests/notes/vaultIndices.test.ts`'s "the working-set (`live`) leg" block drives
 * the real `reindexNoteFromBody` and asserts the `live` value it sends for every
 * marker, which is the stronger test: this function is the one place a note's
 * liveness is computed **for the index**, and the agent's scope reads that answer
 * rather than forming a second opinion about it (myne-md/myne#848).
 */
function noteFlagsFromParsed(parsed: ParseResult): NoteFlags {
  const fmBody = parsed.frontmatter.raw ?? "";
  return {
    trashed: readTrashedFromFmBody(fmBody),
    deleted: readDeletedFromFmBody(fmBody),
    archived: readArchivedFromFmBody(fmBody),
    template: readTemplateFromFmBody(fmBody),
    conflict: readConflictFromFmBody(fmBody),
  };
}

/**
 * `isLiveNote` over {@link noteFlagsFromParsed}, the sidebar tree's working
 * set. One predicate, used by the index producer so the agent's scope and the
 * tree can never disagree about which notes exist.
 */
export function liveNote(parsed: ParseResult): boolean {
  return isLiveNote(noteFlagsFromParsed(parsed));
}

/** Upsert a note's index contribution (title + folder + wikilink edges + tags
 *  + typed frontmatter properties + line-tasks). */
export async function vaultIndicesApply(
  noteId: string,
  title: string | null,
  folder: string | null,
  wikilinks: ReadonlyArray<WikilinkEdge>,
  tags: ReadonlyArray<TagEntry>,
  properties: ReadonlyArray<PropertyEntry>,
  blockAnchors: ReadonlyArray<BlockAnchorEntry>,
  tasks: ReadonlyArray<LineTask>,
  headings: ReadonlyArray<HeadingEntry>,
  /**
   * Whether this note is in the user's WORKING SET (myne-md/myne#848).
   * `liveNote(parsed)` at every call site, so the Rust index carries the
   * sidebar's own verdict rather than deriving one.
   */
  live: boolean,
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
    // MYND-612: the note's line-tasks, typed TS-side. Sent unconditionally —
    // `[]` included — because `apply` has replace semantics: a note whose last
    // task was just deleted must overwrite the stored vector, and an omitted
    // field would rely on Rust's `unwrap_or_default()` meaning the same thing.
    // Saying it explicitly keeps the wire honest about what this client knows.
    tasks,
    // myne#216: the note's headings, for the vault-wide `[[##` picker. Sent
    // unconditionally for the same replace-semantics reason as `tasks` — a note
    // whose last heading was just deleted must overwrite the stored vector.
    headings,
    // myne-md/myne#848: the sidebar's working-set verdict, so the agent's scope
    // resolves against what the tree shows instead of re-deriving liveness from
    // the markers in Rust.
    live,
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

/** Every heading in the vault as `{noteId, text, level}` (myne#216) — the one
 *  query behind the `[[##` picker, replacing a read-and-parse of every note.
 *  Trash-blind: the caller joins against the resident note-set, which is where
 *  trashed/template exclusion lives for every surface. */
export async function vaultHeadings(): Promise<VaultHeadingRow[]> {
  return await invoke<VaultHeadingRow[]>(
    "plugin:vault-indices|vault_indices_headings",
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

/** Every DISTINCT frontmatter property key present across the vault — the
 *  saved-view authoring UI's groupBy / sort / column picker source. Mirrors the
 *  Rust `vault_indices_property_keys` accessor (sorted + deduped). */
export async function vaultIndicesPropertyKeys(): Promise<string[]> {
  return await invoke<string[]>(
    "plugin:vault-indices|vault_indices_property_keys",
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
      // MYND-612: line-tasks. The extractor re-parses rather than reusing the
      // tree above, because `parse()` keeps its tree local — one extra lezer
      // pass per save, which is below measurement next to the IPC round-trip.
      // It owns its own exclusions (frontmatter, drawing-class notes, the raw
      // cap), so nothing here filters what it returns.
      extractLineTasks(body),
      // myne#216: headings for the vault-wide `[[##` picker. Unlike the two
      // extractors above this adds NO parse — `parse()` already enumerated them
      // (with the frontmatter guard applied), so this is a map over a result
      // that is already in hand. That is the whole reason the picker can stop
      // re-reading every note in the vault on every index change.
      parsed.headings.map((h) => ({ text: h.text, level: h.level })),
      // myne-md/myne#848: the sidebar's own working-set verdict, over the parse
      // already in hand. This is what lets the agent's scope be the set the tree
      // shows, rather than a second reader of the marker set.
      liveNote(parsed),
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
  // SYNC-5 chokepoint bump — this IS a bulk mutation of the index slice, and it
  // was the one mutation path that never announced itself (myne#277).
  //
  // The per-note bumps above only fire for notes the blob reported STALE. After
  // a graceful lock the blob was persisted moments earlier, so nothing is stale,
  // so nothing bumped — and the nonce did not advance across the whole
  // lock→unlock cycle even though the index had been wiped and refilled
  // underneath it. Readers keyed on the nonce therefore answered from a cache
  // describing the previous session.
  //
  // It also closes the race that made the pane render EMPTY: this function is
  // fire-and-forget, so a reader that fetched before it finished cached `[]`
  // from the cleared index. With a bump at the end, that reader re-queries.
  bumpIndexNonce();
}

/**
 * Forward links of a note (`forward(id)` query). Fetches the raw edges
 * from Rust, then resolves each against the resident note-set via the
 * single resolver — returning both resolved and broken targets.
 */
export async function forward(
  noteId: string,
  notes: ReadonlyArray<ResolverNote>,
  index?: ResolverIndex,
): Promise<ForwardLink[]> {
  const edges = await invoke<WikilinkEdge[]>(
    "plugin:vault-indices|vault_indices_forward",
    { noteId },
  );
  return resolveEdges(edges, notes, index);
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
  index?: ResolverIndex,
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
    const res = resolveWikilink(edgeToRef(candidate.edge), notes, index);
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

/**
 * Memo for [`tagTree`], keyed on the index-changed nonce (SYNC-5).
 *
 * Five surfaces read the full tag tree (the palette, the filter builder, the
 * graph view, the tag browser and the editor host), and `useTagSuggestions`
 * fires one more read per `#`. Each was an independent IPC round-trip returning
 * the same bytes, because the tree only changes when the index does. Keying the
 * cache on `getIndexNonce()` collapses them to one round-trip per mutation,
 * and a bump (every index mutation goes through the single chokepoint) makes
 * the next read re-fetch, so a tag accepted mid-session still appears.
 */
let tagTreeCache: { nonce: number; promise: Promise<TagTreeNode[]> } | null = null;

/** The full tag tree (nodes with direct + subtree counts + deterministic
 *  display), derived Rust-side from the stored exact folded tags (N2).
 *  Memoized on the index-changed nonce (see `tagTreeCache`). */
export async function tagTree(): Promise<TagTreeNode[]> {
  const nonce = getIndexNonce();
  if (tagTreeCache !== null && tagTreeCache.nonce === nonce) {
    return tagTreeCache.promise;
  }
  const promise = invoke<TagTreeNode[]>("plugin:vault-indices|vault_indices_tag_tree");
  tagTreeCache = { nonce, promise };
  // A rejected promise must not be cached for the rest of the nonce: a
  // transient slot/IO failure would otherwise be re-thrown on every reader
  // until the next index mutation. Clearing lets the next caller retry.
  promise.catch(() => {
    if (tagTreeCache !== null && tagTreeCache.promise === promise) tagTreeCache = null;
  });
  return promise;
}

/** Test-only: drop the memo so a spec starts from a clean cache. A nonce reset
 *  alone would leave a same-nonce entry behind (both start at 0). */
export function __resetTagTreeForTest(): void {
  tagTreeCache = null;
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
