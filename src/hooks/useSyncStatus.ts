// `useSyncStatus` — the runtime sync status + manual "sync now" trigger
// (MYND-424 task 10). Wired to the real `sync` Tauri plugin:
// `plugin:sync|sync_status` (read) + `plugin:sync|sync_now` (trigger).
//
// The backend derives the status honestly from whether an endpoint is
// configured until the engine loop is live over a real transport (task 2,
// R3-blocked): `disabled` when unconfigured, else `idle`. The four live states
// (`syncing` / `error` / `conflicts`) light up once the loop lands — this hook's
// API does not change. `syncNow()` shows a brief local `syncing` state for
// responsiveness, then reflects whatever the command returns.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../platform/core";
import { subscribeToEvents } from "../lib/subscribe";

/** The runtime sync status (mirrors the Rust `SyncRuntimeStatus`). */
export type SyncStatus =
  | { state: "disabled" }
  | { state: "not_enrolled" }
  | { state: "pending" }
  | { state: "idle" }
  | { state: "syncing" }
  | { state: "error"; detail: string }
  | { state: "conflicts"; count: number };

/** Status-poll cadence for the indicator (ms). Cheap read-only command. */
const STATUS_POLL_MS = 5000;

export interface SyncStatusHook {
  /** The current status; `null` until the first read resolves. */
  status: SyncStatus | null;
  /** Trigger an immediate sync; resolves with the resulting status. */
  syncNow: () => Promise<void>;
  /** True while a manual `syncNow()` is in flight. */
  busy: boolean;
}

async function readStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>("plugin:sync|sync_status");
}

/**
 * Whether two reads are the same answer.
 *
 * Every poll deserializes a fresh object, so `Object.is` never matches and each
 * tick re-rendered every subscriber to paint an identical frame. On the editor
 * screen that subtree is the sidebar: `NoteList` -> `VirtualList` -> ~30
 * un-memoized `NoteRow`s, once per poller per five seconds, for nothing.
 *
 * `useUnsyncedEdits`, read at the same level on the same beat, has done this
 * since it was written and says why in its own comment. This hook did not, so a
 * caller adding one beside it silently gave back the property that one protects.
 */
/**
 * Every key of `T`, as a literal the compiler REQUIRES to be complete.
 *
 * This is the mechanism behind `sameStatus`'s claim, and it exists because the
 * two shapes that read as if they carried it do not. An exhaustive `switch` with
 * a `never` default catches a new STATE. Comparing `a.state === b.state` per arm
 * catches nothing about payloads. Neither notices a FIELD added to a variant
 * that already exists, which is the failure this function's comment names: the
 * indicator freezing on its first value with nothing reporting it.
 *
 * A mapped type with `-?` makes the key literal at each call site fail to
 * compile the moment its variant grows a field, which is the compile error the
 * comment promised. Verified by adding `lastSyncedAt` to the `idle` variant and
 * watching `tsc` name the arm.
 */
type AllKeys<T> = { [K in keyof T]-?: true };

/** Field-by-field equality over EVERY key of `T`, listed at the call site. */
function sameFields<T extends object>(a: T, b: T, keys: AllKeys<T>): boolean {
  return (Object.keys(keys) as Array<keyof T>).every((k) => a[k] === b[k]);
}

function sameStatus(a: SyncStatus | null, b: SyncStatus): boolean {
  if (a === null) return false;
  // EXHAUSTIVE, with a `never` default, rather than two comparisons and an
  // unconditional `return true`. This function decides whether a poll result
  // reaches React at all, so the failure mode when a state gains a payload (a
  // `lastSyncedAt` on `idle`, a progress count on `syncing`) is the indicator
  // freezing on its first value with nothing reporting it, on the one readout a
  // user consults to decide whether their notes are on the server.
  //
  // Each arm narrows BOTH sides in its own condition rather than narrowing `a`
  // and casting `b`. The casts were the point: an earlier version of this
  // comment claimed the compiler narrowed `b` off `a.state`, so a new field
  // would fail to compile here. It does not, and an `as Extract<…>` is exactly
  // what stops a missing field from being an error.
  //
  // `sameFields` is what makes the claim true now. Its key literal must list
  // every field of the narrowed variant, so a payload added to one becomes a
  // compile error at that arm.
  switch (a.state) {
    case "error":
      return b.state === "error" && sameFields(a, b, { state: true, detail: true });
    case "conflicts":
      return b.state === "conflicts" && sameFields(a, b, { state: true, count: true });
    // Payload-free today, and listed one per line rather than collapsed into a
    // default, so adding a STATE to the union fails to compile below while
    // adding a FIELD to one of these fails to compile at its own arm.
    case "disabled":
      return b.state === "disabled" && sameFields(a, b, { state: true });
    case "not_enrolled":
      return b.state === "not_enrolled" && sameFields(a, b, { state: true });
    case "pending":
      return b.state === "pending" && sameFields(a, b, { state: true });
    case "idle":
      return b.state === "idle" && sameFields(a, b, { state: true });
    case "syncing":
      return b.state === "syncing" && sameFields(a, b, { state: true });
    default: {
      const exhaustive: never = a;
      return exhaustive;
    }
  }
}

export function useSyncStatus(): SyncStatusHook {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      readStatus()
        .then((s) => {
          if (mounted.current) setStatus((prev) => (sameStatus(prev, s) ? prev : s));
        })
        .catch(() => {
          /* leave the last-known status; a transient read failure is not an
             engine error — the engine reports its own `error` state. */
        });
    };
    tick();
    timer = setInterval(tick, STATUS_POLL_MS);
    // Re-read immediately when enrollment changes (e.g. a local reset) so the
    // indicator does not lag a whole poll interval behind the device panel.
    // Re-read promptly on enrollment changes AND on the engine's status-changed
    // nudge (MYND-461: the loop/sync_now emit `sync://status-changed` when they
    // publish Syncing/Error/clear), so the dot updates without waiting a whole
    // poll interval.
    const unsubscribe = subscribeToEvents(
      ["sync://enrollment-changed", "sync://status-changed"],
      tick,
    );
    return () => {
      mounted.current = false;
      if (timer) clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const syncNow = useCallback(async () => {
    setBusy(true);
    // No optimistic fake `syncing` (MYND-461): the engine now publishes a REAL
    // in-flight `Syncing` state (the loop + sync_now write it to the status cell),
    // so the dot reflects real engine state and the button's `busy` flag alone
    // signals the manual click. Faking `syncing` here would show "Synced ·" become
    // a fake spin even when nothing is really in flight.
    try {
      const next = await invoke<SyncStatus>("plugin:sync|sync_now");
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) {
        setStatus({ state: "error", detail: "sync_failed" });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  return { status, syncNow, busy };
}
