// The task index's wire boundary: what `vault_indices_tasks` actually returns,
// and the one conversion from it to the shape `VaultTask` declares.
//
// This lives apart from `taskIndex.ts` because `taskIndex.ts` is Tauri- and
// React-coupled (the platform seam, the nonce hook, the sidebar's live set) and
// therefore cannot be shared with a client that has its own host. The decoder
// has to be shared: the conversion is a statement about how the Rust struct
// serializes, so a second copy is a second answer to a question with one, and it
// drifts the day `TaskRecord` gains a sixth `Option<String>` field.
//
// Two invariants a later editor must not break:
//
//   1. This is NOT "strip every null". `lineIndex`, `noteTitle` and `noteFolder`
//      are legitimately `T | null` on `VaultTask`, and `lineIndex: null` is the
//      note-task DISCRIMINATOR — a decoder that stripped it would turn every
//      note-task into a malformed line-task. Only the five `Option<String>`
//      fields below are converted.
//   2. The Rust side cannot stop emitting these nulls. `TaskRecord` carries no
//      `skip_serializing_if` because the same struct is the on-disk `MYI1`
//      payload, and dropping keys there would be a format change. So the
//      conversion is permanent, and this is its one home.

import type { VaultTask } from "./taskIndex";

/**
 * The wire shape, which is NOT `VaultTask`: Rust's `Option<String>` fields
 * serialize as `null`, not as an absent key.
 *
 * `VaultTask` promises optional-or-absent, and consumers write the check that
 * promise invites — `remind === undefined` in the reminder scheduler,
 * `raw === undefined` in the date axis. A `null` walks straight through both
 * and reaches `.split(…)` / `.slice(…)` on a non-string. That is not
 * hypothetical: it is what this index started doing the moment it stopped
 * returning an empty list (MYND-644), and it surfaced as a repeating unhandled
 * rejection rather than as anything a surface could show — and again as a
 * render crash on the one task filter that shows undated rows
 * (myne-md/myne-mobile#36).
 */
export type VaultTaskWire = Omit<VaultTask, "due" | "repeat" | "done" | "priority" | "remind"> & {
  due?: string | null;
  repeat?: string | null;
  done?: string | null;
  priority?: string | null;
  remind?: string | null;
};

/**
 * Drop the wire's `null`s so the typed shape is true of every row.
 *
 * Every client's fetch maps through this. A client that casts the wire rows to
 * `VaultTask[]` instead is not skipping a formality — it is asserting something
 * about its data that is false.
 */
export function fromWire(row: VaultTaskWire): VaultTask {
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
