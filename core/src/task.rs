// SPDX-License-Identifier: AGPL-3.0-only
//! The async-execution seam (`phase3-web-client` task 80).
//!
//! Every command core in this crate runs its filesystem and crypto work inside
//! `tokio::task::spawn_blocking`, and uses `tokio`'s timers for the sync tick,
//! the vault-creation session evictor and a handful of waits. On
//! `wasm32-unknown-unknown` there is **no multi-thread runtime and no blocking
//! pool**.
//!
//! ## The failure mode this exists to prevent
//!
//! `spawn_blocking` *compiles* for wasm32 with tokio's `rt` feature and then
//! **panics at runtime** — there is no pool to offload to. So the wasm build
//! goes green, every gate passes, and the first note the user saves kills the
//! Worker. That is the same shape as the clock problem
//! ([`crate::host::HostCtx::now_unix_secs`]): compiles, lies, and no compiler
//! catches it. A seam is the only thing that does.
//!
//! ## The two implementations
//!
//! **Native** delegates to tokio verbatim, so desktop and mobile behaviour is
//! byte-identical — the point is that this migration is a pure move, and the
//! native arm being a one-line forward is what makes that checkable by reading.
//!
//! **wasm** runs the closure **inline**. That is not a compromise: the Worker
//! *is* the dedicated off-main-thread context, so there is nothing to offload
//! to and offloading would mean posting to a second Worker for no gain. The
//! main thread is already free — which was the whole reason for the Worker
//! (`prd.md`, "Everything runs in a dedicated Worker": the ~0.5 s derivation
//! must not block the UI).
//!
//! What inline execution *does* mean is that a long operation occupies the
//! Worker's event loop while it runs. For the crypto and single-file IO these
//! call sites perform that is correct and desirable — they are the Worker's
//! whole job. A long *walk* (a vault-wide scan) is different, and
//! [`yield_now`] exists for it.

use core::fmt;

/// A blocking task failed to complete.
///
/// Deliberately opaque, and deliberately the **same** type on both arms: every
/// call site already collapses this to one variant (`JoinFailure`,
/// panic-equivalent semantics), so exposing tokio's richer error would let a
/// caller start depending on detail the wasm arm cannot supply.
pub struct JoinError {
    #[cfg(not(target_arch = "wasm32"))]
    inner: tokio::task::JoinError,
}

impl fmt::Debug for JoinError {
    #[cfg(not(target_arch = "wasm32"))]
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.inner, f)
    }

    #[cfg(target_arch = "wasm32")]
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JoinError")
    }
}

impl fmt::Display for JoinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("blocking task did not complete")
    }
}

impl std::error::Error for JoinError {}

/// Run a blocking closure and await its result.
///
/// Native: `tokio::task::spawn_blocking`. wasm: inline on the Worker's loop.
///
/// The `Send + 'static` bounds are kept on both arms even though the wasm arm
/// does not need them — dropping them there would let a call site compile for
/// wasm and fail for native, which inverts the whole point of a shared crate.
#[cfg(not(target_arch = "wasm32"))]
pub async fn run_blocking<F, R>(f: F) -> Result<R, JoinError>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|inner| JoinError { inner })
}

/// See the native arm. Runs inline; the Worker is already the off-main-thread
/// context, so there is nothing to offload to.
///
/// Never returns `Err`: an inline call either returns or the closure panics,
/// and a panic in wasm aborts the module rather than unwinding into a join
/// error. Callers keep their `Err(_) => JoinFailure` arm because it is correct
/// on the native arm and costs nothing here.
#[cfg(target_arch = "wasm32")]
pub async fn run_blocking<F, R>(f: F) -> Result<R, JoinError>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    Ok(f())
}

/// Yield to the event loop.
///
/// Native: `tokio::task::yield_now`. wasm: the same — tokio's `yield_now` is a
/// pure cooperative yield with no runtime driver behind it, so it works on the
/// Worker's loop unchanged.
///
/// Use this inside a long walk (a vault-wide scan, a bulk re-index) so the
/// Worker stays responsive to the message queue. It is a no-op-shaped call that
/// is easy to omit and hard to notice missing, which is why it is named on the
/// seam rather than left to each call site to remember.
pub async fn yield_now() {
    tokio::task::yield_now().await;
}

/// Sleep for a duration.
///
/// **The wasm arm exists now** (phase3-web-client task 84). It used to be
/// native-only on the argument that every caller sat in a host-gated module —
/// that stopped being true when the browser transport made the sync engine's
/// retry backoff reachable, and `std::thread::sleep`, which those call sites
/// use today, **panics on wasm32** exactly like the clocks do.
#[cfg(not(target_arch = "wasm32"))]
pub async fn sleep(duration: std::time::Duration) {
    tokio::time::sleep(duration).await;
}

// ── the OTHER sleep: blocking, in-cycle (task 84) ────────────────────────────
//
// `sleep` above is asynchronous and yields, which is right for the waits BETWEEN
// sync cycles. The sync engine's retry backoff is a different case: it sits in
// synchronous helpers calling synchronous `engine::*` functions, because the
// transport is synchronous by design (`web/wasm/src/sync_transport.rs` records
// why). Inside a cycle the Worker is already blocked on the request, so yielding
// buys nothing — and making those helpers async would re-open the very decision
// the transport settled.
//
// The wasm arm is therefore a BLOCKING wait, which a Worker can do:
// `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)`. That needs
// `SharedArrayBuffer`, which needs cross-origin isolation — already a hard
// requirement of the web client (`web/csp.ts` sets COOP `same-origin` + COEP;
// `docs/self-host-web.md` lists dropping either as a misconfiguration), so this
// adds no new deployment constraint.
//
/// Block the current thread for `duration`.
///
/// The synchronous counterpart of [`sleep`], for code that is synchronous by
/// design rather than by accident — see the note above.
///
/// Native: `std::thread::sleep`, which is what the call sites used before this
/// existed, so the desktop and mobile behaviour is byte-identical.
#[cfg(not(target_arch = "wasm32"))]
pub fn block_sleep(duration: std::time::Duration) {
    std::thread::sleep(duration);
}

/// The wasm blocking-waiter, supplied by the embedder (`Atomics.wait`).
///
/// A `fn` rather than an implementation, for the same reason as [`Sleeper`]:
/// `myne-core` gains no JS glue.
#[cfg(target_arch = "wasm32")]
pub type BlockingWaiter = fn(std::time::Duration);

#[cfg(target_arch = "wasm32")]
static BLOCKING_WAITER: std::sync::OnceLock<BlockingWaiter> = std::sync::OnceLock::new();

/// Install the wasm blocking-waiter. Called once at startup, beside the async
/// sleeper and the transport factory.
#[cfg(target_arch = "wasm32")]
pub fn set_blocking_waiter(waiter: BlockingWaiter) {
    let _ = BLOCKING_WAITER.set(waiter);
}

/// Block for `duration`.
///
/// Panics if no waiter was installed, for exactly the reason [`sleep`] does: a
/// backoff that does not wait is a hot retry loop against a server that is
/// already rate-limiting, and it looks like it worked.
#[cfg(target_arch = "wasm32")]
pub fn block_sleep(duration: std::time::Duration) {
    let waiter = BLOCKING_WAITER
        .get()
        .expect("task::set_blocking_waiter was not called at startup — see core/src/task.rs");
    waiter(duration);
}

/// The wasm sleeper, supplied by the embedder.
///
/// A `fn` returning a boxed future rather than a direct implementation, for the
/// same reason `vault_io` and `HostCtx` are traits: **`myne-core` gains no JS
/// glue**. `setTimeout` lives in the entry crate, which is the crate whose job
/// is the JS boundary; core only knows that someone can wait.
///
/// Not `Send`: a browser future holds `JsValue`s and cannot be, which is also
/// why the wasm arm of every seam in this crate is `?Send`.
#[cfg(target_arch = "wasm32")]
pub type Sleeper =
    fn(std::time::Duration) -> core::pin::Pin<Box<dyn core::future::Future<Output = ()>>>;

#[cfg(target_arch = "wasm32")]
static SLEEPER: std::sync::OnceLock<Sleeper> = std::sync::OnceLock::new();

/// Install the wasm sleeper. Called once at Worker startup, beside the transport
/// factory — the two are installed together precisely so neither can be
/// forgotten alone.
#[cfg(target_arch = "wasm32")]
pub fn set_sleeper(sleeper: Sleeper) {
    let _ = SLEEPER.set(sleeper);
}

/// Sleep for a duration.
///
/// Panics if no sleeper was installed, and that is the lesser of two bad
/// options. Returning immediately would look like it worked and would turn the
/// sync engine's exponential backoff into a **hot retry loop against the
/// server** — a client that hammers an endpoint precisely when it is already
/// rate-limiting. A dead Worker with a message naming the missing installation
/// is diagnosable; a silent hot loop is not, and it is a load the server feels.
#[cfg(target_arch = "wasm32")]
pub async fn sleep(duration: std::time::Duration) {
    let sleeper = SLEEPER
        .get()
        .expect("task::set_sleeper was not called at startup — see core/src/task.rs");
    sleeper(duration).await;
}

/// Run an **async** operation whose inner work blocks, and await its result.
///
/// The distinction from [`run_blocking`] is real and cost the sync cycle a
/// rewrite to find (phase3-web-client task 84). `run_blocking` takes a closure
/// that RETURNS a value; on wasm it runs inline, so that closure can never
/// await. The sync cycle is an `async fn` (its sidecar IO is on the storage
/// seam, which is async because OPFS handle acquisition is) whose transport
/// calls block. That is neither shape, and forcing it into either is wrong on
/// one target:
///
/// * Native: awaiting it on an executor worker would park a tokio worker thread
///   on a network round trip — up to the transport's 60 s deadline. So it goes
///   on the blocking pool and is driven there with `Handle::current().block_on`,
///   which is the documented way to run async work from a blocking context.
/// * wasm: there is no blocking pool and no second thread to hand it to. The
///   Worker blocking IS the design — the transport is synchronous XHR in a
///   dedicated Worker by decision (task 35) — so the future is simply awaited,
///   and the blocking happens inside it exactly where it is supposed to.
///
/// Takes a **factory** rather than a future so the native arm can construct the
/// future on the blocking thread. That also keeps the `Send` bound where it
/// belongs: the factory must be `Send` (it crosses to the pool), the future need
/// not be (it never leaves the thread that built it).
#[cfg(not(target_arch = "wasm32"))]
pub async fn run_blocking_future<Factory, Fut, R>(factory: Factory) -> Result<R, JoinError>
where
    Factory: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = R>,
    R: Send + 'static,
{
    tokio::task::spawn_blocking(move || tokio::runtime::Handle::current().block_on(factory()))
        .await
        .map_err(|inner| JoinError { inner })
}

/// See the native arm. Awaits the future directly; the Worker is already the
/// thread that is meant to block.
///
/// Never returns `Err` — there is no join to fail. Callers keep their `Err(_)`
/// arm because it is correct natively and costs nothing here.
#[cfg(target_arch = "wasm32")]
pub async fn run_blocking_future<Factory, Fut, R>(factory: Factory) -> Result<R, JoinError>
where
    Factory: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = R>,
    R: Send + 'static,
{
    Ok(factory().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Matches the crate's existing async-test idiom (`prefs::commands::rt`) —
    /// a current-thread runtime plus `block_on`, rather than `#[tokio::test]`,
    /// which would need a new dev-dependency feature for no gain.
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    #[test]
    fn run_blocking_returns_the_closure_value() {
        assert_eq!(rt().block_on(run_blocking(|| 6 * 7)).unwrap(), 42);
    }

    #[test]
    fn run_blocking_preserves_a_nested_result() {
        // Every call site has the shape `Result<Result<T, E>, JoinError>` and
        // matches `Err(_)` as JoinFailure. Pin that the seam does not flatten it.
        rt().block_on(async {
            let ok: Result<Result<u8, &str>, JoinError> = run_blocking(|| Ok(1u8)).await;
            assert!(matches!(ok, Ok(Ok(1))));
            let inner: Result<Result<u8, &str>, JoinError> = run_blocking(|| Err("nope")).await;
            assert!(matches!(inner, Ok(Err("nope"))));
        });
    }

    #[test]
    fn a_panicking_closure_becomes_a_join_error_on_the_native_arm() {
        // The `JoinFailure` arm every command carries is reachable, and this is
        // what reaches it.
        let r: Result<(), JoinError> = rt().block_on(run_blocking(|| panic!("boom")));
        assert!(r.is_err());
    }

    #[test]
    fn yield_now_is_a_plain_cooperative_yield() {
        // A no-op would still let this test's own `assert!` compile, so the
        // property is that the await point actually hands control back to the
        // executor: the spawned task below runs only if `yield_now` yields.
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        rt().block_on(async {
            let ran = Arc::new(AtomicBool::new(false));
            let flag = ran.clone();
            tokio::spawn(async move {
                flag.store(true, Ordering::SeqCst);
            });
            yield_now().await;
            assert!(
                ran.load(Ordering::SeqCst),
                "yield_now must let a ready task run before it resumes"
            );
        });
    }
}
