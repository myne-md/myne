// SPDX-License-Identifier: AGPL-3.0-only
//! Singleton write barrier (myne-md/myne#711 task 15).
//!
//! The `NTV5` to `NTV6` migration and the group-rotation reseal re-seal every
//! shared singleton (`vault.prefs`, `vault.search`, `vault.attachments`,
//! `vault.workspace`, `vault.dictionary`, `vault.indices`, `vault.themes`,
//! `vault.graph`) from the old KEK tier to the new one. A concurrent write to
//! any of them, landing between the reseal's read and its commit, is silently
//! lost, and the crash journal then describes a state that no longer matches
//! disk. The Grill 3 review recorded exactly this window; it was overridden
//! while the reseal ran once at migration, and task 15 closes it now that the
//! same reseal runs on every member removal.
//!
//! The per-plugin write mutexes were the obvious fix, but only five of the
//! eight singletons have one, and `vault.dictionary` is written by the
//! desktop-only spell plugin, outside this crate. So the barrier is a single
//! process-global `RwLock` instead: the reseal holds it EXCLUSIVELY for the
//! whole operation, and every shared-singleton read-modify-write holds it
//! SHARED. Shared holders do not block each other, so ordinary concurrent
//! singleton writes keep their existing per-plugin serialization; only the
//! reseal is exclusive against all of them at once.
//!
//! A writer MUST hold the shared side across its ENTIRE read-modify-write, not
//! just the final write, or a reseal can still interleave.

use std::sync::{Arc, OnceLock};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

fn barrier() -> &'static Arc<RwLock<()>> {
    static B: OnceLock<Arc<RwLock<()>>> = OnceLock::new();
    B.get_or_init(|| Arc::new(RwLock::new(())))
}

/// Hold the SHARED side across a shared-singleton read-modify-write. Many
/// writers may hold it at once; only [`exclusive`] excludes them.
pub async fn shared() -> OwnedRwLockReadGuard<()> {
    barrier().clone().read_owned().await
}

/// Hold the EXCLUSIVE side across a whole shared-singleton reseal. Blocks until
/// every in-flight singleton write has finished and refuses new ones until the
/// returned guard drops (after the commit marker is written).
pub async fn exclusive() -> OwnedRwLockWriteGuard<()> {
    barrier().clone().write_owned().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// The barrier's contract, proven without `try_write`: while a shared
    /// holder exists, an exclusive acquisition does NOT resolve; once the
    /// shared holder drops, it does. `try_write` is not a valid probe here
    /// because it races with the multi-threaded runtime's scheduler under the
    /// full parallel `--lib` run, which is what made the earlier version flaky.
    #[test]
    fn shared_blocks_exclusive_and_releases_it() {
        crate::test_support::block_on(async {
            let a = shared().await;
            let b = shared().await;

            // Spawn an exclusive acquisition and give it a chance to run. It
            // must NOT complete while `a` and `b` are held.
            let acquired = Arc::new(AtomicBool::new(false));
            let flag = acquired.clone();
            let waiter = tokio::spawn(async move {
                let _g = exclusive().await;
                flag.store(true, Ordering::SeqCst);
            });
            // Yield so the spawned task reaches the write lock and blocks.
            for _ in 0..64 {
                tokio::task::yield_now().await;
            }
            assert!(
                !acquired.load(Ordering::SeqCst),
                "exclusive must not resolve while a shared holder exists"
            );

            // Drop one holder: still blocked (the other remains).
            drop(a);
            for _ in 0..64 {
                tokio::task::yield_now().await;
            }
            assert!(
                !acquired.load(Ordering::SeqCst),
                "exclusive must stay blocked while any shared holder remains"
            );

            // Drop the last holder: the exclusive acquisition now resolves.
            drop(b);
            waiter.await.expect("the exclusive waiter should complete");
            assert!(
                acquired.load(Ordering::SeqCst),
                "exclusive resolves once every shared holder drops"
            );
        });
    }
}
