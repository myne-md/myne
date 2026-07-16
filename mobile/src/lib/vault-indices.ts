// Tauri IPC for the vault-indices plugin (MYI1 — backlinks/graph/tags, shared
// `myne-core::plugins::vault_indices`). The mobile WebView extracts each note's
// links/tags TS-side and pushes them to the in-RAM index (`vault_indices_apply`),
// then reads the graph back (`all_edges` / `backlink_candidates` / `orphans`) —
// so link resolution uses the backend's Turkish-correct folded title-keys
// (`foldSegment`), not the old client `toLowerCase`. Struct fields are serde
// camelCase both ways.

import { invoke } from "@tauri-apps/api/core";
import type { PropertyEntry } from "@myne/editor/host/notes/propertyTyping";
import type { StoredProperty } from "@myne/editor/host/notes/queryEngine";

/** One outbound wikilink edge — mirror of Rust `WikilinkEdge` (camelCase). */
export interface WikilinkEdge {
  target: string;
  targetKind: string; // "title" | "vault-path"
  titleKey: string; // foldSegment(target) — the backlink bucket key
  anchor: string | null;
  blockId: string | null;
  alias: string | null;
  embed: boolean;
  byteStart: number;
  byteEnd: number;
}

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
  });
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
