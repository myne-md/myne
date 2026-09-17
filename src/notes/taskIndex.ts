// Whole-vault task list with a single shared fetch (MYND-612, task 6).
//
// Rust returns every task record and filters nothing (no dates compared, no
// sorting, no tag matching) - a parameterized accessor would move the §3.6.4 type
// authority out of the dialect layer. So the whole list comes over once and every
// surface filters it locally.
//
// The single-fetch discipline is what makes that affordable. The index nonce bumps
// on every autosave, so without a shared cache three query blocks mounted in one
// note would each fetch - roughly once a second while the user types. This module
// holds ONE list, fetches it at most once per nonce, and lets every consumer
// subscribe to the same value.

import { invoke } from "../platform/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { archivedFolderKeys } from "./archivedFolders";
import { useIndexNonce } from "./indexNonce";
import type { TitleRecord } from "./loadNoteBatch";
import { liveCache, useSelectedNote, type NoteId } from "./sidebarState";
import { fromWire, type VaultTaskWire } from "./taskWire";
import { TASK_KIND_VALUE } from "../dialect";
import { usePrefs } from "../hooks/usePrefs";

/** One vault-wide line-task row, as the index returns it. */
export type VaultTask = {
  noteId: string;
  noteTitle: string | null;
  noteFolder: string | null;
  /**
   * Zero-based line of the task, or **`null` for a note-task** - a whole note
   * declared a unit of work (`kind: task`), which has no line to locate.
   *
   * The locator IS the discriminator, deliberately: locator present means a
   * write is line surgery, absent means it is a frontmatter patch. Keeping both
   * kinds in one vector concentrates that branch in the single writer instead of
   * making every reader surface remember to union two sources - where forgetting
   * is silent.
   */
  lineIndex: number | null;
  rawLine: string;
  completed: boolean;
  /** Set when the raw line exceeded the cap and is therefore truncated -
   *  the record is readable but NOT writable (MYND-612 task 5). */
  oversized: boolean;
  due?: string;
  repeat?: string;
  done?: string;
  priority?: string;
  remind?: string;
};

// The wire shape and its decoder live in `./taskWire`, not here: the conversion
// is every client's obligation, and this module is Tauri- and React-coupled, so
// a client with its own host cannot reach it. See that file for why the nulls
// exist and why they cannot be removed on the Rust side.

const EMPTY: readonly VaultTask[] = Object.freeze([]);

let cache: readonly VaultTask[] = EMPTY;
/** The nonce `cache` was built for; -1 until the first fetch settles. */
let cachedNonce = -1;
/** In-flight fetch, so N consumers mounting together produce one call. */
let inflight: Promise<void> | null = null;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether two decoded task lists are byte-for-byte the same record set. */
function sameTasks(a: readonly VaultTask[], b: readonly VaultTask[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.noteId !== y.noteId ||
      x.noteTitle !== y.noteTitle ||
      x.noteFolder !== y.noteFolder ||
      x.lineIndex !== y.lineIndex ||
      x.rawLine !== y.rawLine ||
      x.completed !== y.completed ||
      x.oversized !== y.oversized ||
      x.due !== y.due ||
      x.repeat !== y.repeat ||
      x.done !== y.done ||
      x.priority !== y.priority ||
      x.remind !== y.remind
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Fetch the vault's tasks unless the cache already covers `nonce` or a fetch for
 * it is already running. Failures leave the previous list in place rather than
 * emptying it - a transient IPC error should not make every task surface blank.
 *
 * **Silent when nothing changed.** The index nonce bumps on EVERY note autosave,
 * so a vault-wide list refetched and rebuilt its whole array - a new identity,
 * which invalidates every downstream memo and re-renders every row - roughly once
 * a second while the user typed in an unrelated note. Comparing the decoded set
 * and keeping the OLD array (no `emit()`) means a no-task edit no longer churns
 * the panel at all. `cachedNonce` still advances, so the un-changed fetch is not
 * retried.
 */
async function ensureFetched(nonce: number): Promise<void> {
  if (cachedNonce === nonce || inflight !== null) return;
  inflight = (async () => {
    try {
      const rows = await invoke<VaultTaskWire[]>("plugin:vault-indices|vault_indices_tasks");
      const next = rows.map(fromWire);
      cachedNonce = nonce;
      if (sameTasks(cache, next)) return;
      cache = Object.freeze(next);
      emit();
    } catch {
      // Leave `cache` and `cachedNonce` alone: a failed fetch retries on the
      // next nonce rather than clearing the surfaces.
    } finally {
      inflight = null;
    }
  })();
  await inflight;
}

/**
 * Force the next read to re-fetch.
 *
 * Called from `lockVault()` - the frontend lock choke point - because the
 * backend wipes `VaultIndicesState` on lock and `cachedNonce` is module state
 * that survives the editor unmount. Also used by tests.
 */
export function resetTaskIndexCache(): void {
  cache = EMPTY;
  cachedNonce = -1;
  inflight = null;
  emit();
}

/** The current shared list without subscribing - for non-React callers. */
export function peekVaultTasks(): readonly VaultTask[] {
  return cache;
}

/** Fetch on demand outside React (the reminder scheduler's catch-up pass). */
export async function fetchVaultTasks(nonce: number): Promise<readonly VaultTask[]> {
  await ensureFetched(nonce);
  return cache;
}

/**
 * Note ids carrying a task-list item - the `task:` search operator's leaf
 * resolver (MYND-303). With `query`, only tasks whose raw text contains it
 * (case-insensitive substring - a Slice-A approximation; the engine intersects
 * the result with the live set, so trash/template/archive exclusion is not this
 * function's job). A fresh index read per call, mirroring the `byTag` resolver.
 */
export async function noteIdsWithTask(
  query: string | undefined,
): Promise<string[]> {
  // The raw wire shape (`VaultTaskWire`) - but this reads only `noteId` +
  // `rawLine`, both required strings on both shapes, so no `fromWire` needed.
  const rows = await invoke<VaultTaskWire[]>("plugin:vault-indices|vault_indices_tasks");
  const q = query?.trim().toLowerCase();
  const ids = new Set<string>();
  for (const row of rows) {
    if (q && q !== "" && !row.rawLine.toLowerCase().includes(q)) continue;
    ids.add(row.noteId);
  }
  return [...ids];
}

/**
 * The vault's line-tasks, shared across every consumer. Re-reads on the existing
 * SYNC-5 index-changed nonce; N mounted consumers cause one fetch per change, not
 * N.
 *
 * **Ungated** - this is the raw index read. Task surfaces must use
 * {@link useLiveVaultTasks} instead, so trash/template/archive/conflict exclusion
 * happens in exactly one place.
 */
function useAllVaultTasks(): readonly VaultTask[] {
  const nonce = useIndexNonce();
  useEffect(() => {
    void ensureFetched(nonce);
  }, [nonce]);
  return useSyncExternalStore(subscribe, peekVaultTasks, peekVaultTasks);
}

/**
 * Note-task rows for every live note carrying the class marker (MYND-612 task 4).
 *
 * **The predicate is the marker alone.** A note that merely carries a due date is
 * an ordinary note - otherwise every meeting note with a date would silently
 * become a task. And it is value-strict: a user's own `kind: Task` or
 * `kind: "task"` does not qualify, exactly as the reader that produced
 * `TitleRecord.kind` decided.
 */
export function noteTasksFromCache(
  cache: ReadonlyMap<NoteId, TitleRecord>,
  archivedKeys: readonly string[],
): VaultTask[] {
  const out: VaultTask[] = [];
  for (const record of liveCache(cache, archivedKeys).values()) {
    if (record.kind !== TASK_KIND_VALUE) continue;
    const done = record.done ?? undefined;
    out.push({
      noteId: record.noteUuid,
      noteTitle: record.title,
      noteFolder: record.folder,
      // Empty locator: the whole note is the task.
      lineIndex: null,
      rawLine: "",
      completed: done !== undefined,
      oversized: false,
      ...(done === undefined ? {} : { done }),
    });
  }
  return out;
}

/**
 * Keep only tasks whose note is in the working set (MYND-612, task 5→7).
 *
 * The Rust index is deliberately trash-blind - it indexes everything and
 * exclusion happens at *query* time, which is how every other index consumer
 * works (backlinks, graph, tag browser, saved views). Filtering at index time
 * would need a re-index on every trash/archive toggle.
 *
 * `liveCache` is the existing single gate and already covers all four states the
 * task asks for - trashed, template, archived, conflict - plus soft-deleted and
 * folder-archived notes. Reusing it rather than re-listing the predicates is the
 * point: a fifth exclusion added there must not need a second edit here.
 *
 * Note `resolverCache` would be the WRONG gate: it is archived-*inclusive* by
 * design (an archived note still resolves as a backlink target), and an archived
 * note's tasks should not appear in a task list.
 *
 * Drawing notes are excluded at extraction time, not here - see
 * `dialect/src/visitors/lineTasks.ts`. Duplicating that would be a second site.
 */
export function filterTasksToLiveSet(
  tasks: readonly VaultTask[],
  cache: ReadonlyMap<NoteId, TitleRecord>,
  archivedKeys: readonly string[],
): VaultTask[] {
  const live = liveCache(cache, archivedKeys);
  return tasks.filter((task) => live.has(task.noteId as NoteId));
}

/**
 * The task list every surface should read: shared-fetched and gated through the
 * single live-set exclusion. The ungated hook is intentionally not exported.
 */
export function useLiveVaultTasks(): readonly VaultTask[] {
  const all = useAllVaultTasks();
  const { cache } = useSelectedNote();
  const { prefs } = usePrefs();
  const archivedKeys = useMemo(
    () => archivedFolderKeys(prefs.archived_folders),
    [prefs.archived_folders],
  );
  return useMemo(
    () => [
      ...filterTasksToLiveSet(all, cache, archivedKeys),
      ...noteTasksFromCache(cache, archivedKeys),
    ],
    [all, cache, archivedKeys],
  );
}
