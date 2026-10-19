// The MYI1 lifecycle that is not an IPC wrapper: hydrating the persisted
// structured index, seeding the delta tracker from that result, and flushing
// the write back to `vault.indices` at the client's exit seams.
//
// Why this is a module rather than two effects inside `EditorFlow`:
//
//   - **Ordering is the whole feature.** The delta sweep assumes it starts from
//     an empty tracker and therefore sends the entire corpus. Once the host has
//     hydrated the persisted records, the sweep must be told which notes the
//     host ALREADY holds, or the fast path costs exactly what the rebuild it
//     replaces costs. The tracker seed and the sweep's gate are one contract,
//     and this is where it is written down and tested.
//   - **A write that races a newer apply must not land last.** Persist takes a
//     snapshot of the Rust store at call time, so two overlapping calls can
//     complete out of order and leave the older snapshot on disk. Writes are
//     serialized here: a second flush waits for the one in flight, and a change
//     that arrives mid-write leaves the index dirty, so the next flush writes
//     again.
//   - **The hydrate latch has to survive React StrictMode.** Two concurrent
//     hydrate calls are not harmless idempotence: the second `bulk_replace`s
//     the persisted records over any apply that landed between the two, and
//     the tracker has already marked those notes applied, so nothing re-sends
//     them. Concurrent callers share one promise instead.
//
// **The cadence is the exit seams, never per edit** (`protocol.md` §9.8.5).
// Manual lock/quit may flush (persist-then-wipe); idle auto-lock skips the
// flush and the next unlock rebuilds the missing delta; mobile's ordinary exit
// is a backgrounding, so the app-background seam flushes too. A settle timer
// was tried and removed: it turned the blob's mtime into an editing-activity
// log (`docs/threat-model.md` §7's `vault.workspace` posture) for a cache whose
// staleness costs one slower unlock.
//
// `vault.indices` is a Class-3 rebuildable cache (`sync-protocol.md` §9, never
// synced) and the Rust side treats every failure as fall-to-rebuild. Nothing
// here can lose data: the worst case is a slower next unlock.

import type { DeltaItem, IndexDeltaTracker } from "./index-delta";
import { hydrateVaultIndicesBlob, persistVaultIndicesBlob } from "./vault-indices";

/** Once-per-unlock-session hydration. `null` means the command itself failed
 *  (slot / IO), which the caller must treat as a full rebuild. Cleared by
 *  {@link resetVaultIndicesLifecycle}, so the next unlock re-reads. */
let hydration: Promise<string[] | null> | null = null;

/**
 * Hydrate `MYI1` once per unlock session, sharing the in-flight read between
 * callers. Returns the stale note ids, or `null` when the command failed (the
 * caller then leaves the tracker empty and the sweep rebuilds in full).
 *
 * Best-effort by construction: a failed hydrate is the specification's own
 * fall-to-rebuild path (§9.8.4), not an error to surface.
 */
export function hydrateVaultIndicesOnce(): Promise<string[] | null> {
  hydration ??= hydrateVaultIndicesBlob().catch(() => null);
  return hydration;
}

/**
 * Seed the delta tracker with the notes the host just loaded from the blob.
 *
 * `corpus` must describe the notes as they were on disk when the hydrate scan
 * ran: the boot-time read, not whatever the editor holds a moment later. An
 * edit that lands during the hydrate then differs from its seeded signature
 * and the next sweep re-applies it, which is the safe direction. Marking a
 * changed note as applied would leave the Rust record stale for the session.
 *
 * `staleIds` are deliberately NOT marked: the sweep's `diff` reports them
 * because their signature is absent, which is exactly the re-apply the host
 * asked for. An id that is stale AND outside the live set has no sweep to
 * report it, so the caller drops that record instead (see
 * `hydrateIndicesFromBlob` in `EditorFlow`).
 */
export function seedIndexTrackerFromHydration<T extends DeltaItem>(
  tracker: IndexDeltaTracker,
  corpus: readonly T[],
  staleIds: readonly string[],
): void {
  const stale = new Set(staleIds);
  for (const item of corpus) {
    if (stale.has(item.id)) continue;
    tracker.markApplied(item);
  }
}

let dirty = false;
let inFlight: Promise<void> | null = null;
/** The owner's "make the RAM index level with disk" pass (applied and
 *  registered by `EditorFlow`). Every exit seam runs it before writing: persist
 *  pairs a manifest scanned from disk with the records the store holds, so a
 *  record left behind by the sweep's 400 ms debounce would otherwise be written
 *  under a fresh `content_nonce` and read as unchanged on the next unlock. */
let leveller: (() => Promise<void>) | null = null;
/** One warning per session is bounded; the index is a cache, so a repeated
 *  failure is not news and a warning per exit seam would be log spam. */
let warned = false;

/** One warning per session for any MYI1 failure: the index is a cache, so a
 *  repeat is not news, and a warning per seam would be log spam. Exported for
 *  the callers whose own catch would otherwise be silent. */
export function warnVaultIndicesFailure(err: unknown): void {
  warnOnce(err);
}

function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  const detail = err instanceof Error ? err.message : String(err ?? "");
  console.warn(
    `[vault-indices] persist failed; the index is a rebuildable cache and will be rebuilt on the next unlock${detail === "" ? "" : `: ${detail}`}`,
  );
}

function write(): Promise<void> {
  if (inFlight !== null) return inFlight;
  if (!dirty) return Promise.resolve();
  dirty = false;
  inFlight = persistVaultIndicesBlob()
    .catch(warnOnce)
    .finally(() => {
      // A change that landed while this write was in flight moved the RAM
      // index after the snapshot this write took. It re-set `dirty`, so the
      // next flush writes again rather than considering the store persisted.
      inFlight = null;
    });
  return inFlight;
}

/**
 * Mark the RAM index as changed since the last write. Called after a sweep
 * that actually moved the backend index and after an open note's record is
 * applied at a flush, so an app that never edited writes nothing at all.
 */
export function noteVaultIndicesChanged(): void {
  dirty = true;
}

/**
 * Register the pass that makes the RAM index level with disk (`EditorFlow`'s
 * pending delta over the live corpus). The exit seam awaits it, so all three
 * lock and exit paths inherit the ordering from one place instead of each
 * remembering it. `null` on unmount.
 */
export function setVaultIndicesExitSeamLeveller(fn: (() => Promise<void>) | null): void {
  leveller = fn;
}

/**
 * Write now: the app-background, manual-lock and vault-switch seam. Levels the
 * store with disk first, awaits an in-flight write, then writes. Best-effort:
 * a refusal never throws, and a failed leveling pass writes nothing at all
 * (a lagging record under a fresh nonce is the one shape the next hydrate
 * cannot detect).
 */
export async function flushVaultIndicesPersistNow(): Promise<void> {
  if (leveller !== null) {
    try {
      await leveller();
    } catch {
      return;
    }
  }
  if (inFlight !== null) await inFlight;
  if (dirty) await write();
}

/**
 * Return the module to its pre-unlock state: drop the dirty flag and re-arm
 * the hydration latch. Called from `lockVault()` and on a vault change. An
 * in-flight write is not cancellable and is left to settle; after the lock it
 * is refused by `Slot::Unlocked` and swallowed as designed.
 */
export function resetVaultIndicesLifecycle(): void {
  dirty = false;
  hydration = null;
  warned = false;
  // The leveller is the mounted owner's, not the session's: a lock does not
  // unmount `EditorFlow`, so clearing it here would leave the next seam
  // unlevelled. It is cleared on unmount instead.
}

/** Test-only reset, including the in-flight handle so a spec can start from a
 *  clean module. Production paths use {@link resetVaultIndicesLifecycle}. */
export function __resetVaultIndicesLifecycleForTest(): void {
  resetVaultIndicesLifecycle();
  inFlight = null;
}
