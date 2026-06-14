//! In-RAM payload stash + readiness rendezvous for the PDF export
//! pipeline (MYND-255 task 4).
//!
//! One single-slot session: the main window's `pdf_export_render`
//! stashes the emitted HTML here, the hidden `pdf-export` window
//! fetches it via `pdf_export_payload` and signals layout settle via
//! `pdf_export_ready`; the render command awaits that signal before
//! driving the native capture. The stash is `Zeroizing`-wrapped note
//! plaintext (same secret class as the editor buffer — see
//! `src-tauri/CLAUDE.md` "Plaintext IPC" pattern) and is cleared on
//! BOTH ends of every flight: at render finalize (success or failure)
//! and from every lock-teardown site via
//! [`super::teardown_on_lock`] (the `workspace::clear_staged_descriptor`
//! precedent), so a lock mid-export wipes the payload and cancels the
//! in-flight wait.
//!
//! A `std::sync::Mutex` (not `tokio`) so the teardown sites can wipe
//! synchronously; the guard is only ever held for a trivial
//! assign/clone, never across an `.await` (poison-tolerant like the
//! workspace stash).

use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::Notify;
use zeroize::Zeroizing;

use super::error::PdfExportError;

/// Session phase. `Cancelled` is sticky until the owning render
/// command observes it and `reset()`s — so a teardown firing between
/// `begin` and `wait_ready` is never lost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    AwaitingReady,
    Ready,
    Cancelled,
}

struct Inner {
    /// Emitted HTML body (note plaintext projection) + the note title
    /// for the hidden page's `document.title`. BOTH halves are
    /// `Zeroizing` — the title is plaintext-derived (frontmatter
    /// `title:`, the MYND-31 title-wipe precedent) — so the stash wipes
    /// on drop; the IPC clone handed to the hidden window is the
    /// accepted V8-side copy (TB2/A7 posture).
    payload: Option<(Zeroizing<String>, Option<Zeroizing<String>>)>,
    phase: Phase,
}

/// Outcome of [`PdfExportState::wait_ready`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitOutcome {
    /// The hidden page signalled `pdf_export_ready`.
    Ready,
    /// A lock-teardown cleared the session mid-flight.
    Cancelled,
    /// The readiness deadline elapsed.
    TimedOut,
}

/// Managed single-slot session state for the `pdf-export` plugin.
pub struct PdfExportState {
    inner: Mutex<Inner>,
    notify: Notify,
}

impl Default for PdfExportState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                payload: None,
                phase: Phase::Idle,
            }),
            notify: Notify::new(),
        }
    }
}

impl PdfExportState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Stage a payload and open the session. Rejects with
    /// [`PdfExportError::ExportInProgress`] when a session is already
    /// active (single-slot; the UI serializes exports — bug-canary).
    pub fn begin(
        &self,
        html: Zeroizing<String>,
        title: Option<Zeroizing<String>>,
    ) -> Result<(), PdfExportError> {
        let mut inner = self.lock();
        if inner.phase != Phase::Idle {
            return Err(PdfExportError::ExportInProgress);
        }
        inner.payload = Some((html, title));
        inner.phase = Phase::AwaitingReady;
        Ok(())
    }

    /// Clone the staged payload for the hidden window's
    /// `pdf_export_payload` fetch. `None` when no session is active
    /// (stale window, or a teardown wiped it). The plain-`String`
    /// clones are the IPC-bound copies (accepted V8-side posture); the
    /// stash itself stays `Zeroizing`.
    pub fn fetch_payload(&self) -> Option<(String, Option<String>)> {
        let inner = self.lock();
        inner
            .payload
            .as_ref()
            .map(|(html, title)| (html.to_string(), title.as_ref().map(|t| t.to_string())))
    }

    /// Clone the staged title for the post-capture footer stamp
    /// (`super::footer`). The clone stays `Zeroizing` end-to-end
    /// (plaintext-derived, the MYND-31 title-wipe precedent). `None`
    /// when no session is active or the note carries no title — the
    /// stamper then falls back to "Untitled", matching the export
    /// flows' filename fallback.
    pub fn title_for_stamp(&self) -> Option<Zeroizing<String>> {
        self.lock()
            .payload
            .as_ref()
            .and_then(|(_, title)| title.clone())
    }

    /// Hidden-page readiness signal. Returns `false` when no session
    /// is awaiting readiness (stale window / cancelled session).
    pub fn signal_ready(&self) -> bool {
        let mut inner = self.lock();
        if inner.phase != Phase::AwaitingReady {
            return false;
        }
        inner.phase = Phase::Ready;
        drop(inner);
        self.notify.notify_waiters();
        true
    }

    /// Lock-teardown wipe: drop the `Zeroizing` payload and cancel any
    /// in-flight wait. Sync + infallible (called from the same five
    /// teardown sites as `workspace::clear_staged_descriptor`). A
    /// no-op on an idle session.
    pub fn clear_for_teardown(&self) {
        let mut inner = self.lock();
        inner.payload = None; // Zeroizing drop wipes the plaintext
        if matches!(inner.phase, Phase::AwaitingReady | Phase::Ready) {
            inner.phase = Phase::Cancelled;
            drop(inner);
            self.notify.notify_waiters();
        }
    }

    /// Close the session at render finalize (success or failure):
    /// wipe the payload, return to `Idle`. Only the owning render
    /// command calls this.
    pub fn reset(&self) {
        let mut inner = self.lock();
        inner.payload = None;
        inner.phase = Phase::Idle;
    }

    /// Await the hidden page's readiness signal, the teardown
    /// cancellation, or the deadline — whichever first. Registers the
    /// waiter before each phase check so a notify between check and
    /// await is never lost.
    pub async fn wait_ready(&self, timeout: Duration) -> WaitOutcome {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Arm the waiter BEFORE reading the phase: a notify that
            // fires after this point wakes the pinned future.
            notified.as_mut().enable();
            match self.lock().phase {
                Phase::Ready => return WaitOutcome::Ready,
                Phase::Cancelled => return WaitOutcome::Cancelled,
                Phase::Idle | Phase::AwaitingReady => {}
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return WaitOutcome::TimedOut;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    fn payload(s: &str) -> Zeroizing<String> {
        Zeroizing::new(s.to_string())
    }

    #[test]
    fn stash_fetch_ready_reset_lifecycle() {
        let state = PdfExportState::default();
        assert!(state.fetch_payload().is_none(), "idle stash is empty");

        state
            .begin(payload("<p>hi</p>"), Some(payload("Title")))
            .expect("begin on idle succeeds");
        let (html, title) = state.fetch_payload().expect("staged payload fetchable");
        assert_eq!(html, "<p>hi</p>");
        assert_eq!(title.as_deref(), Some("Title"));
        // Fetch is a clone, not a take — a hidden-page reload can
        // refetch until the session closes.
        assert!(state.fetch_payload().is_some());

        assert!(state.signal_ready(), "ready accepted while awaiting");
        assert!(!state.signal_ready(), "second ready is a stale no-op");

        state.reset();
        assert!(state.fetch_payload().is_none(), "reset wipes the stash");
        // Session reusable after reset.
        state
            .begin(payload("x"), None)
            .expect("begin after reset succeeds");
    }

    #[test]
    fn second_begin_while_active_is_export_in_progress() {
        let state = PdfExportState::default();
        state.begin(payload("a"), None).expect("first begin");
        let err = state.begin(payload("b"), None).expect_err("second begin");
        assert!(matches!(err, PdfExportError::ExportInProgress));
        // The original payload is untouched.
        assert_eq!(state.fetch_payload().expect("payload").0, "a");
    }

    #[test]
    fn teardown_clears_payload_and_cancels_wait() {
        let state = PdfExportState::default();
        state.begin(payload("secret"), None).expect("begin");
        state.clear_for_teardown();
        assert!(
            state.fetch_payload().is_none(),
            "lock teardown wipes the stashed plaintext"
        );
        // The cancellation is sticky: the in-flight wait observes it.
        rt().block_on(async {
            let outcome = state.wait_ready(Duration::from_secs(5)).await;
            assert_eq!(outcome, WaitOutcome::Cancelled);
        });
        // ...and a ready from a stale window is rejected.
        assert!(!state.signal_ready());
        // reset() (the owning command's finalize) reopens the slot.
        state.reset();
        state
            .begin(payload("next"), None)
            .expect("begin after reset");
    }

    #[test]
    fn teardown_on_idle_session_is_a_noop() {
        let state = PdfExportState::default();
        state.clear_for_teardown();
        // Still Idle — a fresh begin works (no sticky Cancelled).
        state
            .begin(payload("a"), None)
            .expect("begin after idle teardown");
    }

    #[test]
    fn wait_ready_resolves_on_ready_signal() {
        let state = std::sync::Arc::new(PdfExportState::default());
        state.begin(payload("a"), None).expect("begin");
        rt().block_on(async {
            let waiter = {
                let state = state.clone();
                tokio::spawn(async move { state.wait_ready(Duration::from_secs(5)).await })
            };
            // Let the waiter arm, then signal.
            tokio::task::yield_now().await;
            assert!(state.signal_ready());
            let outcome = waiter.await.expect("waiter join");
            assert_eq!(outcome, WaitOutcome::Ready);
        });
    }

    #[test]
    fn wait_ready_times_out_without_signal() {
        let state = PdfExportState::default();
        state.begin(payload("a"), None).expect("begin");
        rt().block_on(async {
            // Paused-time would be nicer but the deadline is ms-scale.
            let outcome = state.wait_ready(Duration::from_millis(20)).await;
            assert_eq!(outcome, WaitOutcome::TimedOut);
        });
    }

    #[test]
    fn ready_before_wait_is_observed() {
        // The hidden page can settle layout and signal BEFORE the
        // render command starts awaiting — the phase check (not just
        // the notify edge) carries the signal.
        let state = PdfExportState::default();
        state.begin(payload("a"), None).expect("begin");
        assert!(state.signal_ready());
        rt().block_on(async {
            let outcome = state.wait_ready(Duration::from_secs(5)).await;
            assert_eq!(outcome, WaitOutcome::Ready);
        });
    }
}
