// Which notes actually changed since the last time an index accepted them
// (myne-mobile#41).
//
// Both backend indices — MYI1 vault-indices and the MYS1 search index — are fed
// from React effects keyed on the `bodies` map. That map is replaced wholesale
// on every load, so its identity changes even when every body is byte-identical,
// and the effects answered that by re-sending the entire vault: one
// `extractRecord` parse plus one `vault_indices_apply` per note, plus the whole
// corpus through `search_index_replace`. Saving one note cost work proportional
// to the vault.
//
// A tracker sits between the corpus and the index and answers "what moved?".
// The effects then send only that. It is deliberately a separate module rather
// than an inline `useRef` in `EditorFlow`: this is the invariant that keeps the
// index feed proportional to the edit, and it is worth being able to test on its
// own — and worth a future call site inheriting rather than reinventing.
//
// Two properties are load-bearing:
//
//   - `diff` is PURE. Nothing is recorded until `markApplied` / `markRemoved`,
//     which the caller invokes only after the backend accepted that note. A
//     failed or cancelled apply therefore reappears in the next diff instead of
//     being silently skipped forever.
//   - The stored signature holds a REFERENCE to the body string the corpus
//     already holds — no second copy of any plaintext, and no lifetime beyond
//     the component that owns the tracker (unmounting on lock drops it; `reset`
//     is for the vault-switch path that keeps the component mounted).
//
// Cost note, stated honestly: comparing bodies is a string compare, so a diff
// after a full reload walks the corpus once (a memcmp, no parse, no decrypt, no
// IPC). After a surgical single-note update the unchanged bodies are the *same*
// string instances, which compares in constant time. Either way it is orders
// below the parse-and-IPC-per-note it replaces.

/** One note as the indices see it: identity plus everything a record derives from. */
export interface DeltaItem {
  id: string;
  title: string;
  folder: string | null;
  body: string;
}

/** What moved since the last accepted state. `changed` keeps the caller's own
 *  item type so it can carry extra fields through the diff untouched. */
export interface IndexDelta<T> {
  changed: T[];
  removed: string[];
}

interface Signature {
  title: string;
  folder: string | null;
  body: string;
}

export interface IndexDeltaTracker {
  /** New + modified items, and the ids that left the corpus. Pure — call
   *  `markApplied` / `markRemoved` to record what the backend accepted. */
  diff<T extends DeltaItem>(items: readonly T[]): IndexDelta<T>;
  /** Record that the index now holds this exact item. */
  markApplied(item: DeltaItem): void;
  /** Record that the index no longer holds this id. */
  markRemoved(id: string): void;
  /** Forget everything — vault switch / lock. The next diff reports the whole
   *  corpus as changed, which is what re-seeds an emptied index. */
  reset(): void;
  /** True until the first item is accepted. The search index uses this to pick
   *  its corpus-level seed (`search_index_replace`) over a delta apply: with no
   *  prior state there is nothing to delta against. */
  isEmpty(): boolean;
}

export function createIndexDeltaTracker(): IndexDeltaTracker {
  const applied = new Map<string, Signature>();

  return {
    diff<T extends DeltaItem>(items: readonly T[]): IndexDelta<T> {
      const changed: T[] = [];
      const present = new Set<string>();

      for (const item of items) {
        present.add(item.id);
        const prev = applied.get(item.id);
        if (
          prev === undefined ||
          prev.title !== item.title ||
          prev.folder !== item.folder ||
          prev.body !== item.body
        ) {
          changed.push(item);
        }
      }

      const removed: string[] = [];
      for (const id of applied.keys()) {
        if (!present.has(id)) removed.push(id);
      }

      return { changed, removed };
    },

    markApplied(item: DeltaItem): void {
      applied.set(item.id, { title: item.title, folder: item.folder, body: item.body });
    },

    markRemoved(id: string): void {
      applied.delete(id);
    },

    reset(): void {
      applied.clear();
    },

    isEmpty(): boolean {
      return applied.size === 0;
    },
  };
}
