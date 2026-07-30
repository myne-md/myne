// Whole-vault task list with a single shared fetch (MYND-612, task 6).
//
// Rust returns every task record and filters nothing (no dates compared, no
// sorting, no tag matching) — a parameterized accessor would move the §3.6.4 type
// authority out of the dialect layer. So the whole list comes over once and every
// surface filters it locally.
//
// The single-fetch discipline is what makes that affordable. The index nonce bumps
// on every autosave, so without a shared cache three query blocks mounted in one
// note would each fetch — roughly once a second while the user types. This module
// holds ONE list, fetches it at most once per nonce, and lets every consumer
// subscribe to the same value.

import { invoke } from "../platform/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { archivedFolderKeys } from "./archivedFolders";
import { useIndexNonce } from "./indexNonce";
import type { TitleRecord } from "./loadNoteBatch";
import { liveCache, useSelectedNote, type NoteId } from "./sidebarState";
import { TASK_KIND_VALUE } from "../dialect";
import { usePrefs } from "../hooks/usePrefs";

/** One vault-wide line-task row, as the index returns it. */
export type VaultTask = {
  noteId: string;
  noteTitle: string | null;
  noteFolder: string | null;
  /**
   * Zero-based line of the task, or **`null` for a note-task** — a whole note
   * declared a unit of work (`kind: task`), which has no line to locate.
   *
   * The locator IS the discriminator, deliberately: locator present means a
   * write is line surgery, absent means it is a frontmatter patch. Keeping both
   * kinds in one vector concentrates that branch in the single writer instead of
   * making every reader surface remember to union two sources — where forgetting
   * is silent.
   */
  lineIndex: number | null;
  rawLine: string;
  completed: boolean;
  /** Set when the raw line exceeded the cap and is therefore truncated —
   *  the record is readable but NOT writable (MYND-612 task 5). */
  oversized: boolean;
  due?: string;
  repeat?: string;
  done?: string;
  priority?: string;
  remind?: string;
};

/**
 * The wire shape, which is NOT the shape above: Rust's `Option<String>` fields
 * serialize as `null`, not as an absent key — `TaskRecord` deliberately carries
 * no `skip_serializing_if`, because the same struct is the on-disk `MYI1`
 * payload and dropping keys there would be a format change.
 *
 * So the boundary has to convert, and it is the only place that should have to.
 * `VaultTask` promises optional-or-absent, and consumers write the check that
 * promise invites — `remind === undefined` in the reminder scheduler,
 * `raw === undefined` in the date axis. A `null` walks straight through both
 * and reaches `.split(…)` / `.slice(…)` on a non-string. That is not
 * hypothetical: it is what this index started doing the moment it stopped
 * returning an empty list (MYND-644), and it surfaced as a repeating
 * unhandled rejection rather than as anything a surface could show.
 */
type VaultTaskWire = Omit<VaultTask, "due" | "repeat" | "done" | "priority" | "remind"> & {
  due?: string | null;
  repeat?: string | null;
  done?: string | null;
  priority?: string | null;
  remind?: string | null;
};

/** Drop the wire's `null`s so the typed shape above is true of every row. */
function fromWire(row: VaultTaskWire): VaultTask {
  const { due, repeat, done, priority, remind, ...rest } = row;
  return {
    ...rest,
    ...(due == null ? {} : { due }),
    ...(repeat == null ? {} : { repeat }),
    ...(done == null ? {} : { done }),
    ...(priority == null ? {} : { priority }),
    ...(remind == null ? {} : { remind }),
  };
}

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

/**
 * Fetch the vault's tasks unless the cache already covers `nonce` or a fetch for
 * it is already running. Failures leave the previous list in place rather than
 * emptying it — a transient IPC error should not make every task surface blank.
 */
async function ensureFetched(nonce: number): Promise<void> {
  if (cachedNonce === nonce || inflight !== null) return;
  inflight = (async () => {
    try {
      const rows = await invoke<VaultTaskWire[]>("plugin:vault-indices|vault_indices_tasks");
      cache = Object.freeze(rows.map(fromWire));
      cachedNonce = nonce;
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

/** Force the next read to re-fetch. Exposed for tests and for lock teardown. */
export function resetTaskIndexCache(): void {
  cache = EMPTY;
  cachedNonce = -1;
  inflight = null;
  emit();
}

/** The current shared list without subscribing — for non-React callers. */
export function peekVaultTasks(): readonly VaultTask[] {
  return cache;
}

/** Fetch on demand outside React (the reminder scheduler's catch-up pass). */
export async function fetchVaultTasks(nonce: number): Promise<readonly VaultTask[]> {
  await ensureFetched(nonce);
  return cache;
}

/**
 * Note ids carrying a task-list item — the `task:` search operator's leaf
 * resolver (MYND-303). With `query`, only tasks whose raw text contains it
 * (case-insensitive substring — a Slice-A approximation; the engine intersects
 * the result with the live set, so trash/template/archive exclusion is not this
 * function's job). A fresh index read per call, mirroring the `byTag` resolver.
 */
export async function noteIdsWithTask(
  query: string | undefined,
): Promise<string[]> {
  // The raw wire shape (`VaultTaskWire`) — but this reads only `noteId` +
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
 * **Ungated** — this is the raw index read. Task surfaces must use
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
 * an ordinary note — otherwise every meeting note with a date would silently
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
 * The Rust index is deliberately trash-blind — it indexes everything and
 * exclusion happens at *query* time, which is how every other index consumer
 * works (backlinks, graph, tag browser, saved views). Filtering at index time
 * would need a re-index on every trash/archive toggle.
 *
 * `liveCache` is the existing single gate and already covers all four states the
 * task asks for — trashed, template, archived, conflict — plus soft-deleted and
 * folder-archived notes. Reusing it rather than re-listing the predicates is the
 * point: a fifth exclusion added there must not need a second edit here.
 *
 * Note `resolverCache` would be the WRONG gate: it is archived-*inclusive* by
 * design (an archived note still resolves as a backlink target), and an archived
 * note's tasks should not appear in a task list.
 *
 * Drawing notes are excluded at extraction time, not here — see
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
