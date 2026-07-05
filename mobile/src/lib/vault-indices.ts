// Tauri IPC for the vault-indices plugin (MYI1 — backlinks/graph/tags, shared
// `myne-core::plugins::vault_indices`). The mobile WebView extracts each note's
// links/tags TS-side and pushes them to the in-RAM index (`vault_indices_apply`),
// then reads the graph back (`all_edges` / `backlink_candidates` / `orphans`) —
// so link resolution uses the backend's Turkish-correct folded title-keys
// (`foldSegment`), not the old client `toLowerCase`. Struct fields are serde
// camelCase both ways.

import { invoke } from "@tauri-apps/api/core";

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
    properties: [],
  });
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
