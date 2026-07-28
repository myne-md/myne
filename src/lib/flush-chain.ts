// The write-everything-down chain, and the order it runs in
// (phase3-web-client tasks 93 + 43).
//
// # Why this is one function instead of two copies
//
// `Editor.tsx` ran this sequence in two places — the lock path (Lock button and
// the web idle auto-lock) and the exit path (`pagehide` / `visibilitychange`) —
// and the two were identical apart from one conditional step. Identical-apart-
// from-one-thing is the shape that drifts: the difference is incidental in the
// source, so a later edit to one copy reads as a fix rather than as a divergence.
//
// Here the difference is a parameter with a name, and the reason it exists is
// stated once.
//
// # The ordering is load-bearing
//
// Content first, conveniences after, and the reason is what survives a partial
// run. A flush that gets halfway must leave the vault's *content* correct and
// lose only things that can be rebuilt:
//
//   1. `flushAll` — note bodies. The only step whose loss is unrecoverable.
//   2. `persistWorkspace` — `MYW1`, the pane/tab descriptor. Convenience: losing
//      it reopens a default layout, not a damaged vault.
//   3. `persistVaultIndices` — `MYI1`. A rebuildable cache.
//   4. `flushGraphLayout` — `MYG1`. Likewise.
//
// Desktop already ran them in this order; the web arms match it deliberately so
// the two clients cannot disagree about what survives a half-finished exit.
//
// # Why the workspace step is skipped when hiding
//
// `protocol.md` §9.7.4 keeps `vault.workspace`'s mtime a **lock/quit signal**. A
// `visibilitychange` → hidden is a tab switch, which happens dozens of times an
// hour; writing the blob on each one turns its mtime into an editor-activity
// log — the exact leak the graceful-exit-only rule forecloses. Note content is
// still flushed there, because a hidden tab can be discarded without another
// event.
//
// # Every step is isolated, and that is the bug this file fixes
//
// The lock path used to be a bare `await` chain followed by the lock:
//
//     await flushAll();
//     await persistWorkspace();
//     …
//     await lockVault();
//
// A rejection from ANY step skipped every step after it **including the lock**.
// So a transient write failure did not merely lose a convenience blob — it
// cancelled the auto-lock: the idle deadline passed, the vault stayed unlocked,
// the keys stayed live in the Worker, and the editor stayed on screen with the
// plaintext mounted. The one path where failing open is least acceptable was
// the one that failed open, and nothing said so (the caller's `void` turned the
// rejection into an unhandled promise).
//
// So each step is caught individually: one failing step must not take the
// others down, and *nothing* here may prevent the caller from locking.

/** The four writers, injected so the ordering is testable without an editor. */
export interface FlushChainSteps {
  /** Note bodies across every pane. The only irrecoverable one. */
  flushAll: () => Promise<void> | void;
  /** `MYW1` pane/tab descriptor. Skipped when hiding — see the header. */
  persistWorkspace: () => Promise<void> | void;
  /** `MYI1` vault indices. Rebuildable. */
  persistVaultIndices: () => Promise<void> | void;
  /** `MYG1` graph-layout cache. Rebuildable. */
  flushGraphLayout: () => Promise<void> | void;
}

/** Why the chain is running. Governs the workspace step only. */
export type FlushReason =
  /** The vault is about to lock (button, or the web idle timer). */
  | "lock"
  /** The window/tab is going away. */
  | "closing"
  /** The tab was hidden but is still alive. NOT a quit. */
  | "hiding";

/** Which steps ran, and which threw. Returned rather than logged so a caller
 *  can decide — and so the tests can assert the order without a spy harness. */
export interface FlushChainResult {
  /** Step names in the order they were invoked. */
  readonly ran: readonly string[];
  /** Step names that threw. A non-empty list is not a reason to skip a lock. */
  readonly failed: readonly string[];
}

/**
 * Run the flush chain for `reason`.
 *
 * **Never rejects.** A caller's next action is normally to zeroize keys or let
 * the page go away, and neither may be skipped because a cache write failed.
 */
export async function runFlushChain(
  steps: FlushChainSteps,
  reason: FlushReason,
): Promise<FlushChainResult> {
  const ran: string[] = [];
  const failed: string[] = [];

  const step = async (name: string, fn: () => Promise<void> | void) => {
    ran.push(name);
    try {
      await fn();
    } catch {
      // Isolated on purpose. See the header: one failing writer must not take
      // the rest of the chain — or the caller's lock — with it.
      failed.push(name);
    }
  };

  await step("flushAll", steps.flushAll);
  if (reason !== "hiding") await step("persistWorkspace", steps.persistWorkspace);
  await step("persistVaultIndices", steps.persistVaultIndices);
  await step("flushGraphLayout", steps.flushGraphLayout);

  return { ran, failed };
}
