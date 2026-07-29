// Task-surface scope: one folder AND any of several tags (MYND-616, task 3).
//
// FOLDER is single-select and **subtree-inclusive**; TAGS are multi-select and
// **OR'd**; folder and tags are **AND'd**.
//
// Tags are OR'd because a user picking two tags almost always means "work in
// either of these areas". AND'ing them returns empty for most selections — most
// notes carry one of a user's top-level tags, not several — and a selector that
// usually yields nothing reads as a broken feature rather than a precise one.
//
// **No new query leaf.** Everything here is expressible with the closed leaves
// the saved-views work already froze (`inFolder`, `hasTag`, `and`, `or`, `all`),
// and `scopeToFilter` below produces exactly that node so the claim is checkable
// rather than asserted. The panel itself evaluates locally — the task list is
// already in memory, so round-tripping through the async query engine would buy
// nothing — but the two must agree, which is why both live in this file.
//
// Folding goes through `folderKey` / `foldSegment`, the same helpers the write
// path uses, so query-fold == write-fold and a Turkish dotted-I folder or tag
// cannot match here and miss there (§3.7.8).

import { folderKey, foldSegment } from "../dialect/folderPath";
import type { FilterNode } from "../lib/prefs";
import type { VaultTask } from "./taskIndex";

/**
 * What the scope selector holds.
 *
 * `folder: null` means the whole vault; an empty `tags` list means "any tag",
 * not "no tags" — an empty selection cannot be a constraint.
 */
export type TaskScope = {
  readonly folder: string | null;
  readonly tags: readonly string[];
};

export const EMPTY_SCOPE: TaskScope = { folder: null, tags: [] };

/** Whether the scope constrains anything at all. */
export function isScopeEmpty(scope: TaskScope): boolean {
  return scope.folder === null && scope.tags.length === 0;
}

/**
 * Whether `folder` is inside `scope.folder`, subtree-inclusive.
 *
 * Prefix matching on the folded canonical key, which is the `inFolder` leaf's
 * own rule (SYNC-8 / Q2-A) and the same shape `collectSubtreeNoteIdsFromCache`
 * uses for archived folders. Prefix matching on the **key** rather than the raw
 * path is what makes `Projects` not match `Projects-Archive`: both keys carry
 * the trailing separator, so the prefix test is segment-aligned.
 */
export function folderInScope(scopeFolder: string | null, noteFolder: string | null): boolean {
  if (scopeFolder === null) return true;
  const scopeKey = folderKey(scopeFolder);
  if (scopeKey === "") return true; // root selected == whole vault
  return folderKey(noteFolder).startsWith(scopeKey);
}

/**
 * Whether a note's tags satisfy the scope's tag selection.
 *
 * Subtree-inclusive per tag, matching `byTag`: selecting `#area` includes
 * `#area/sub`, because a user who filters by a parent tag means the area, not
 * the literal string. Multiple selected tags are OR'd.
 */
export function tagsInScope(
  scopeTags: readonly string[],
  noteTags: readonly string[],
): boolean {
  if (scopeTags.length === 0) return true;
  const folded = noteTags.map((t) => foldSegment(t));
  return scopeTags.some((selected) => {
    const key = foldSegment(selected);
    if (key === "") return true;
    return folded.some((tag) => tag === key || tag.startsWith(`${key}/`));
  });
}

/** Folder AND tags. Both must hold; each is permissive when unset. */
export function noteInScope(
  scope: TaskScope,
  noteFolder: string | null,
  noteTags: readonly string[],
): boolean {
  return folderInScope(scope.folder, noteFolder) && tagsInScope(scope.tags, noteTags);
}

/**
 * Narrow a task list to a scope.
 *
 * `tagsOf` is injected rather than fetched, because the tag index is an async
 * IPC surface and this must stay a pure, testable predicate — and because the
 * caller already holds a per-note tag lookup for other reasons.
 */
export function filterTasksByScope(
  tasks: readonly VaultTask[],
  scope: TaskScope,
  tagsOf: (noteId: string) => readonly string[],
): VaultTask[] {
  if (isScopeEmpty(scope)) return [...tasks];
  return tasks.filter((task) => noteInScope(scope, task.noteFolder, tagsOf(task.noteId)));
}

/**
 * The scope expressed as a **closed-leaf** filter node.
 *
 * This is the checkable form of "no new query leaf is introduced": every scope
 * the selector can express is one of these nodes, and the node type is the one
 * saved views already froze. It is also what a future surface that must go
 * through the query engine (rather than filtering an in-memory list) would use.
 */
export function scopeToFilter(scope: TaskScope): FilterNode {
  const clauses: FilterNode[] = [];
  if (scope.folder !== null) clauses.push({ kind: "inFolder", path: scope.folder });
  if (scope.tags.length === 1) {
    clauses.push({ kind: "hasTag", tag: scope.tags[0]! });
  } else if (scope.tags.length > 1) {
    clauses.push({
      kind: "or",
      children: scope.tags.map((tag) => ({ kind: "hasTag", tag }) as const),
    });
  }

  if (clauses.length === 0) return { kind: "all" };
  if (clauses.length === 1) return clauses[0]!;
  return { kind: "and", children: clauses };
}

/** Toggle a tag in the multi-select, preserving selection order. */
export function toggleScopeTag(scope: TaskScope, tag: string): TaskScope {
  const key = foldSegment(tag);
  const present = scope.tags.some((t) => foldSegment(t) === key);
  return {
    ...scope,
    tags: present ? scope.tags.filter((t) => foldSegment(t) !== key) : [...scope.tags, tag],
  };
}
