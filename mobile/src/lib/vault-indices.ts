// Tauri IPC for the vault-indices plugin (MYI1 — backlinks/graph/tags, shared
// `myne-core::plugins::vault_indices`). The mobile WebView extracts each note's
// links/tags TS-side and pushes them to the in-RAM index (`vault_indices_apply`),
// then reads the graph back (`all_edges` / `backlink_candidates` / `orphans`) —
// so link resolution uses the backend's Turkish-correct folded title-keys
// (`foldSegment`), not the old client `toLowerCase`. Struct fields are serde
// camelCase both ways.

import { invoke } from "../platform/core";
import type { LineTask } from "../dialect/visitors/lineTasks";
import type { PropertyEntry } from "@myne/editor/host/notes/propertyTyping";
import type { StoredProperty } from "@myne/editor/host/notes/queryEngine";
// The `[[##` and `[[^^` wire types come from the shared package rather than
// being re-declared here, for the reason the `WikilinkEdge` note below states
// (myne-md/myne#199): a second declaration of a wire type is a second answer
// waiting to drift. Both were desktop-only until myne-md/myne#452; they are
// re-exported so a mobile call site names them without a second import path.
import type { HeadingEntry, VaultHeadingRow } from "@myne/editor/host/notes/vaultHeadings";
import type { BlockAnchorEntry, VaultBlockAnchor } from "@myne/editor/host/notes/blockAnchors";
export type { HeadingEntry, VaultHeadingRow, BlockAnchorEntry, VaultBlockAnchor };

// One outbound wikilink edge — mirror of Rust `WikilinkEdge` (camelCase). The
// local re-declaration is gone (myne-md/myne#199): it typed `targetKind` as a
// bare `string` while the shared model types it as the `WikilinkTargetKind`
// union, and a second declaration of a wire type is a second answer waiting to
// drift. Re-exported so the IPC call sites here read unchanged.
export type { WikilinkEdge } from "@myne/editor/host/notes/graphModel";
import type { WikilinkEdge } from "@myne/editor/host/notes/graphModel";

/** A folded tag — mirror of Rust `TagEntry`. */
export interface TagEntry {
  folded: string;
  display: string;
}

/** A candidate backlink (source note + its matching edge). */
export interface CandidateEdge {
  source: string;
  edge: WikilinkEdge;
}

/** The full apply payload for one note. */
export interface IndexRecord {
  noteId: string;
  title: string | null;
  folder: string | null;
  titleKey: string | null;
  wikilinks: WikilinkEdge[];
  tags: TagEntry[];
  /** §3.6.4 typed frontmatter properties (MYND-271). Feeds the by-key property
   *  accessor the saved-view query engine reads for groupBy / sort / columns /
   *  the `property` filter leaf. Previously always `[]` — a saved view could
   *  only filter by tag/folder/search on mobile; now it reaches parity. */
  properties: PropertyEntry[];
  /** The note's line-tasks (MYND-612), typed by the shared dialect extractor.
   *  Same story as `properties` above: the field existed on the Rust side from
   *  the start but no client filled it, so every mobile task surface — the
   *  Tasks tab, the note-scoped panel, and the reminder scheduler that reads
   *  the same index — listed nothing at all. */
  tasks: LineTask[];
  /** The note's imported `^block-id` anchors (MYND-382), for the vault-wide
   *  `[[^^` picker. Enumerate-only: these are markers that already exist in the
   *  body (typically an Obsidian import); Myne mints none. */
  blockAnchors: BlockAnchorEntry[];
  /** The note's headings (myne#216), for the vault-wide `[[##` picker. Same
   *  story as `tasks` and `blockAnchors`: the Rust field has existed since
   *  myne#216 and no mobile client filled it, so every record mobile wrote
   *  stored an empty vector and the picker that reads them back opened with
   *  zero rows. Unlike the other two this costs no extra pass, since
   *  `extractRecord`'s single `parse()` already enumerated them. */
  headings: HeadingEntry[];
  /** Whether this note is in the user's working set (myne-md/myne#848):
   *  `isLiveNote(readNoteFlags(body))`, the same predicate `EditorFlow` filters
   *  the list with. The agent's scope resolves against this on every client, so
   *  a trashed/template/archived note is outside a run's reach here exactly as
   *  it is on desktop. */
  live: boolean;
}

/** Replace-semantics upsert of a note's index contribution. */
export function vaultIndicesApply(r: IndexRecord): Promise<void> {
  return invoke("plugin:vault-indices|vault_indices_apply", {
    noteId: r.noteId,
    title: r.title,
    folder: r.folder,
    titleKey: r.titleKey,
    wikilinks: r.wikilinks,
    tags: r.tags,
    properties: r.properties,
    // Sent unconditionally, `[]` included: apply replaces the whole record, so
    // a note whose last task was deleted must overwrite the stored vector.
    tasks: r.tasks,
    // Both sent unconditionally for exactly that reason. Omitting a field is
    // NOT the same as sending `[]`, even though Rust's `unwrap_or_default()`
    // maps them to the same value today: a note whose last heading was just
    // deleted must overwrite the stored vector, and relying on the default to
    // mean "the client has none" would leave a stale heading in the picker the
    // moment that default changed.
    blockAnchors: r.blockAnchors,
    headings: r.headings,
    // myne-md/myne#848: the working-set verdict, so a run's scope on the phone
    // is the list the phone shows.
    live: r.live,
  });
}

/** Every heading in the vault as `{noteId, text, level}` (myne#216): the one
 *  query behind the `[[##` picker. Trash-blind, so the caller joins against the
 *  resident note-set, which is where trashed/template exclusion lives for every
 *  surface (`joinVaultHeadings`). */
export function vaultIndicesHeadings(): Promise<VaultHeadingRow[]> {
  return invoke<VaultHeadingRow[]>("plugin:vault-indices|vault_indices_headings");
}

/** Every imported `^block-id` anchor across the vault (MYND-382): the one query
 *  behind the `[[^^` picker. Enumerate-only, so it surfaces markers that already
 *  exist and never mints one.
 *
 *  **Join these before rendering them, with `joinVaultBlockAnchors`.** Like every
 *  other query on this plugin the dump is trash-blind, so a row arrives for a
 *  trashed, template or conflict-copy note too, and a `[[^^` row is a DEEP LINK:
 *  rendering one unjoined offers to point a live note at a trashed one. The rows
 *  DO carry a `noteTitle` and `noteFolder` of their own, and that is a trap
 *  rather than a shortcut: they are as old as that note's last apply, and the
 *  picker emits a path from them, so the join deliberately takes both from the
 *  resident note-set instead. This docstring said the opposite for one review
 *  round (myne-md/myne#452). */
export function vaultIndicesBlockAnchors(): Promise<VaultBlockAnchor[]> {
  return invoke<VaultBlockAnchor[]>("plugin:vault-indices|vault_indices_block_anchors");
}

/** Every note carrying a frontmatter property named `key`, as
 *  `[noteId, StoredProperty]` — the saved-view query engine's by-key primitive.
 *  Mirrors the desktop wrapper + the Rust `vault_indices_property_values`
 *  accessor; the engine compares the opaque pre-typed values type-awarely. */
export function vaultIndicesPropertyValues(
  key: string,
): Promise<Array<[string, StoredProperty]>> {
  return invoke<Array<[string, StoredProperty]>>(
    "plugin:vault-indices|vault_indices_property_values",
    { key },
  );
}

/** Every DISTINCT frontmatter property key present across the vault — the
 *  saved-view authoring UI's groupBy / sort / column picker source. Mirrors the
 *  desktop wrapper + the Rust `vault_indices_property_keys` accessor. */
export function vaultIndicesPropertyKeys(): Promise<string[]> {
  return invoke<string[]>("plugin:vault-indices|vault_indices_property_keys");
}

/** Drop a hard-deleted note from the index. */
export function vaultIndicesRemove(noteId: string): Promise<void> {
  return invoke("plugin:vault-indices|vault_indices_remove", { noteId });
}

/** Whole-vault edge dump: `[noteId, edges][]`. */
export function vaultIndicesAllEdges(): Promise<[string, WikilinkEdge[]][]> {
  return invoke<[string, WikilinkEdge[]][]>("plugin:vault-indices|vault_indices_all_edges");
}

/** Candidate backlinks for a folded title-key. */
export function vaultIndicesBacklinkCandidates(titleKey: string): Promise<CandidateEdge[]> {
  return invoke<CandidateEdge[]>("plugin:vault-indices|vault_indices_backlink_candidates", { titleKey });
}

/** Degree-0 note ids. */
export function vaultIndicesOrphans(): Promise<string[]> {
  return invoke<string[]>("plugin:vault-indices|vault_indices_orphans");
}
