// SPDX-License-Identifier: AGPL-3.0-only
//! One implementation of "a socket read that observes cancellation and bounds
//! silence", shared by both AI network arms (ai-remote-providers task 6).
//!
//! **Why a wrapper at all.** `CancelToken` is checked at the **emit seam** — the
//! point where a token is handed to the caller — and a request that has
//! produced no token yet has no emit seam. So "Stop" and the vault-lock
//! teardown did nothing until the first byte arrived. That is a correctness
//! gap, not only a UX one: a generation must not outlive the lock that dropped
//! the transcript it is writing into. On a metered remote provider it is also a
//! bill that keeps running after the user pressed Stop.
//!
//! **Bound the silence, not the length.** The socket carries a SHORT read
//! deadline ([`POLL_INTERVAL`]); this wrapper turns repeated short waits into
//! one long wait that re-checks cancellation between them, and gives up only
//! after [`idle_timeout`] has passed **with no byte received**. A total-duration
//! cap would kill the successful case that takes longest, which is exactly the
//! case a user is most invested in — the myne#222 lesson applied rather than
//! copied, since sync's rule ("a deadline must cover the server's WORK") was
//! written for a request/response API and here the work *is* the transfer.
//!
//! Generic and **owning**, so it composes both ways: the loopback arm borrows a
//! `&TcpStream`, and the TLS arm needs an owned `Read + Write` to hand rustls's
//! `StreamOwned`. One type serves both; two would be two chances for one of
//! them to stop checking the flag.

use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Answers "has this request been cancelled?" — polled *between* socket waits,
/// which is what makes an abort work before the first token exists.
pub type CancelledFn = Arc<dyn Fn() -> bool + Send + Sync>;

/// How often the read wakes while waiting, so the cancel flag is observed
/// between waits rather than only at the emit seam. Also the value the caller
/// must set as the socket's read timeout — a longer socket timeout makes this
/// wrapper coarser, not broken.
pub const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// A reader/writer that bounds silence and observes cancellation.
///
/// `idle_timeout` is per-instance rather than a constant here: the two arms
/// answer to different physics (a loopback model on this machine versus a
/// provider across the internet), and baking one number in would make one of
/// them wrong. Each arm names its own and argues for it at the declaration.
pub struct CancellableStream<S> {
    inner: S,
    cancelled: CancelledFn,
    idle_timeout: Duration,
    last_progress: Instant,
}

impl<S> CancellableStream<S> {
    pub fn new(inner: S, cancelled: CancelledFn, idle_timeout: Duration) -> Self {
        Self {
            inner,
            cancelled,
            idle_timeout,
            last_progress: Instant::now(),
        }
    }

    /// The error a cancelled read produces. Named so a caller can tell "the
    /// user stood this down" from "the far side broke" — the loopback arm maps
    /// it to `Deferred` rather than to a failure the user must act on.
    pub fn is_cancelled_error(e: &std::io::Error) -> bool {
        e.kind() == std::io::ErrorKind::Other && e.to_string() == CANCELLED
    }
}

const CANCELLED: &str = "cancelled";

impl<S: Read> Read for CancellableStream<S> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            // Checked FIRST, before every wait — so a cancel that arrives while
            // the far side is thinking is seen within one poll interval rather
            // than at the first byte.
            if (self.cancelled)() {
                return Err(std::io::Error::other(CANCELLED));
            }
            match self.inner.read(buf) {
                Ok(n) => {
                    if n > 0 {
                        self.last_progress = Instant::now();
                    }
                    return Ok(n);
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    if self.last_progress.elapsed() >= self.idle_timeout {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "idle deadline",
                        ));
                    }
                    // Loop: wait again, re-checking cancellation first.
                }
                Err(e) => return Err(e),
            }
        }
    }
}

impl<S: Write> Write for CancellableStream<S> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if (self.cancelled)() {
            return Err(std::io::Error::other(CANCELLED));
        }
        self.inner.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// A reader that never produces a byte and always reports a timed-out wait
    /// — the shape of a provider that accepted the connection and is thinking.
    struct SilentReader;
    impl Read for SilentReader {
        fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
            std::thread::sleep(Duration::from_millis(20));
            Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "wait"))
        }
    }

    #[test]
    fn silence_beyond_the_idle_deadline_is_a_timeout() {
        let never = Arc::new(|| false) as CancelledFn;
        let mut s = CancellableStream::new(SilentReader, never, Duration::from_millis(120));
        let started = Instant::now();
        let err = s.read(&mut [0u8; 8]).expect_err("must give up");
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        // The deadline is real, not merely a variant: it fires close to the
        // budget rather than after some unrelated wait.
        assert!(
            started.elapsed() < Duration::from_millis(600),
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_cancel_is_observed_before_any_byte_arrives() {
        // The whole point: the far side has sent nothing, so there is no emit
        // seam and the old process-global check would never run.
        let flag = Arc::new(AtomicBool::new(false));
        let f = Arc::clone(&flag);
        let cancelled = Arc::new(move || f.load(Ordering::SeqCst)) as CancelledFn;
        std::thread::spawn({
            let flag = Arc::clone(&flag);
            move || {
                std::thread::sleep(Duration::from_millis(50));
                flag.store(true, Ordering::SeqCst);
            }
        });
        // An idle timeout far beyond the cancel, so a pass cannot be the
        // deadline firing early and being mistaken for a cancel.
        let mut s = CancellableStream::new(SilentReader, cancelled, Duration::from_secs(30));
        let started = Instant::now();
        let err = s.read(&mut [0u8; 8]).expect_err("must abort");
        assert!(
            CancellableStream::<SilentReader>::is_cancelled_error(&err),
            "expected the cancelled error, got {err:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "cancel must be prompt; took {:?}",
            started.elapsed()
        );
    }

    /// Progress resets the clock — a slow drip of bytes must NOT hit the idle
    /// deadline, because bounding the silence and bounding the length are
    /// different things and only the first is wanted.
    #[test]
    fn a_dribbling_reader_never_hits_the_idle_deadline() {
        struct Dribble(u8);
        impl Read for Dribble {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(Duration::from_millis(30));
                if self.0 == 0 {
                    return Ok(0);
                }
                self.0 -= 1;
                buf[0] = b'x';
                Ok(1)
            }
        }
        let never = Arc::new(|| false) as CancelledFn;
        // Each chunk arrives AFTER a wait longer than the deadline would allow
        // if the clock were not reset by progress.
        let mut s = CancellableStream::new(Dribble(5), never, Duration::from_millis(50));
        let mut out = Vec::new();
        s.read_to_end(&mut out)
            .expect("a dripping reader completes");
        assert_eq!(out, b"xxxxx");
    }

    #[test]
    fn a_cancelled_write_does_not_reach_the_socket() {
        let cancelled = Arc::new(|| true) as CancelledFn;
        let mut sink: Vec<u8> = Vec::new();
        {
            let mut s = CancellableStream::new(&mut sink, cancelled, Duration::from_secs(1));
            let err = s.write(b"prompt bytes").expect_err("must refuse");
            assert!(CancellableStream::<&mut Vec<u8>>::is_cancelled_error(&err));
        }
        assert!(sink.is_empty(), "a cancelled request must send nothing");
    }
}
