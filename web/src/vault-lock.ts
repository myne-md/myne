// Single-tab vault lock (phase3-web-client task 21).
//
// Two tabs on one OPFS container would race and corrupt it: OPFS has no
// cross-context write coordination, the double-buffered singleton writes
// (task 18) assume exactly one writer choosing which buffer is next, and the
// per-note write-new-then-remove-old sequence (task 20) assumes nobody removes
// the old copy underneath it. So exactly one tab may hold a vault open, and the
// second must **report** rather than take over — taking over would move the
// corruption from "two writers" to "one writer whose files vanished".
//
// The primitive is the **Web Locks API**, not the ServiceWorker +
// BroadcastChannel construction Joplin uses. Web Locks is in every target
// browser, and it gets the hard part right for free: a lock is scoped to the
// agent cluster and is **released automatically when the holding context goes
// away** — tab closed, tab crashed, browser killed. A BroadcastChannel protocol
// has to detect that itself, which means a heartbeat, which means a timeout,
// which means a window where a crashed tab still looks alive and a healthy one
// looks dead. There is no such window here.
//
// What this module deliberately does NOT do: decide *when* to acquire. The
// caller acquires before the vault is opened and releases on lock/close, so a
// tab that never acquires never reaches a write path at all — "second tab never
// writes" is a property of the call order, not of a check inside each write.

/**
 * The id this client locks on (#254).
 *
 * A browser profile holds exactly ONE OPFS container per origin
 * (`decisions.md` 2026-07-26), so there is one thing to serialise and it needs
 * a stable name rather than a vault id read from inside the container — which
 * would require opening the container to learn which lock to take, i.e. the
 * race this lock exists to prevent. Web Locks are already origin-scoped, so
 * this constant only has to be stable, not unique across accounts.
 */
export const WEB_CONTAINER_ID = "container";

/** Lock name for a vault. Namespaced so it cannot collide with an unrelated lock. */
export function vaultLockName(vaultId: string): string {
  return `myne.vault.${vaultId}`;
}

/** A held vault lock. Releasing is idempotent. */
export interface VaultLock {
  readonly vaultId: string;
  /** Release the lock. Safe to call more than once. */
  release(): void;
}

export type AcquireResult =
  | { held: true; lock: VaultLock }
  | { held: false; reason: "open-elsewhere" }
  | { held: false; reason: "unsupported" };

/**
 * The slice of `navigator.locks` this module uses. Narrowed to an interface so
 * the tests can drive it — `LockManager` cannot be constructed, and a test that
 * needed two real browsing contexts would not be a unit test.
 */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode?: "exclusive" | "shared"; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown | null) => Promise<unknown>,
  ): Promise<unknown>;
}

function defaultLocks(): LockManagerLike | null {
  const n = globalThis.navigator as unknown as { locks?: LockManagerLike } | undefined;
  return n?.locks ?? null;
}

/**
 * Try to take the vault's exclusive lock, without waiting.
 *
 * `ifAvailable: true` is what makes this a *probe*: the callback runs
 * immediately either way, receiving `null` when another context holds the lock.
 * Waiting instead would hang the second tab's boot with no way to tell the user
 * why — and "the vault is open in another tab" is information, not an error to
 * retry silently.
 *
 * The lock is held until `release()`: the callback returns a promise that only
 * settles then. That is the Web Locks idiom for a long-held lock, and it is why
 * the callback here looks like it does nothing.
 */
export async function acquireVaultLock(
  vaultId: string,
  locks: LockManagerLike | null = defaultLocks(),
): Promise<AcquireResult> {
  if (!locks) return { held: false, reason: "unsupported" };

  const name = vaultLockName(vaultId);
  let releaseHeld: (() => void) | null = null;
  let released = false;

  // Resolves once we know whether the lock was granted. The request promise
  // itself does NOT tell us that — it settles when the callback's promise
  // settles, which for a granted lock is at release time.
  const granted = new Promise<boolean>((resolveGranted) => {
    void locks.request(name, { mode: "exclusive", ifAvailable: true }, (lock) => {
      if (lock === null) {
        resolveGranted(false);
        return Promise.resolve();
      }
      return new Promise<void>((resolveHold) => {
        releaseHeld = resolveHold;
        resolveGranted(true);
      });
    });
  });

  if (!(await granted)) return { held: false, reason: "open-elsewhere" };

  return {
    held: true,
    lock: {
      vaultId,
      release() {
        if (released) return;
        released = true;
        releaseHeld?.();
      },
    },
  };
}

/**
 * Resolve when the vault's lock becomes free — the "offer to reload when the
 * other tab closes" path.
 *
 * This is an ordinary (waiting) request that releases immediately on grant: we
 * want the *edge*, not the lock. Acquiring and holding here would mean a tab
 * sitting on a "vault is open elsewhere" screen silently stealing the lock the
 * moment the real tab closed, which would then block the user's *next* real
 * tab. So: observe, release, tell the caller.
 *
 * `signal` cancels the wait (the screen unmounted, the user navigated away).
 * An aborted wait rejects, which is the standard Web Locks behaviour and is
 * left un-swallowed so a caller cannot mistake "cancelled" for "now free".
 */
export async function waitForVaultLockRelease(
  vaultId: string,
  signal: AbortSignal,
  locks: LockManagerLike | null = defaultLocks(),
): Promise<void> {
  if (!locks) return;
  await locks.request(vaultLockName(vaultId), { mode: "exclusive", signal }, () =>
    Promise.resolve(),
  );
}
