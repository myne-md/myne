// SPDX-License-Identifier: AGPL-3.0
//! Integration proof of the lowest-priority compute policy (MYND-651 task 11).
//!
//! [`super::compute_priority`]'s own tests cover the register in isolation, and
//! [`super::commands`]'s cover the two policy halves against engines that never
//! take a lock. Neither one can see the property the policy actually exists for,
//! because both run on a single thread with nothing contended: **a user who asks
//! for something while a background tag pass is running does not wait for it.**
//!
//! So this module contends for real — two threads, two runtimes, one engine
//! whose `compute` mutex is taken by every model call, exactly as
//! [`super::engine_candle::CandleEngine`] takes its own. The production halves
//! under test are the real ones: `suggest_tags_with_engine` threads the yield
//! probe into the engine and reports `Deferred`, `infer_with_engine` runs the
//! user's call, and the `interactive()` registration is the same single line the
//! `infer` command adds.
//!
//! **The two claims are not symmetric, and that is the point.**
//!   - *A user infer is not starved* is a **priority** property: both calls want
//!     the same lock, and the policy decides who gets it. Proved by contention.
//!   - *Note-open is not gated* is a **structural** property: opening a note
//!     decrypts a `MY01` blob and never touches the engine, so the tag pass
//!     cannot block it by construction. Proved by reading a real note out of a
//!     real vault while the tag pass is still holding the lock — a stronger
//!     statement than any ordering rule, because there is no ordering to get
//!     wrong.
//!
//! The engine is a stand-in (the production one cannot hold the lock for a
//! measurable window without a multi-hundred-megabyte GGUF in the tree), but it
//! is a stand-in for the *lock discipline* only: its `infer_tags` consults the
//! probe in the same three places `CandleEngine::infer_tags` does — before it
//! queues for `compute`, again after it acquires, and once per generated token.
//! The production engine's own first-half short-circuit is covered next to it in
//! `engine_candle.rs` (`infer_tags_yields_before_it_ever_queues_for_the_compute_lock`).
//!
//! Content-free like everything else on this path: no prompt, note body, or
//! reply is logged (DENY-list, `src-tauri/AGENTS.md`).

use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use zeroize::Zeroizing;

use super::commands::{infer_with_engine, suggest_tags_with_engine, TagGate};
use super::compute_priority::ComputePriority;
use super::engine::Engine;
use super::error::EngineError;

/// How long a bounded wait may run before the thing it waits for counts as
/// starved. Generous on purpose: the assertion is "it finished at all while a
/// background pass was in flight", not "it finished in N ms" — a wall-clock
/// budget is what makes concurrency tests flake on a loaded CI box. A regression
/// does not squeak past this; it hangs until the timeout and fails.
const WAIT: Duration = Duration::from_secs(10);

/// Cost of one fake "token". Small enough that a yielding pass looks
/// instantaneous, large enough that a NON-yielding one visibly holds the lock.
const TOKEN: Duration = Duration::from_millis(1);

/// Token budget of the fake tag pass — 60 s of holding if it never yields, i.e.
/// six times [`WAIT`]. A pass that ignored the probe could not finish inside the
/// bounded wait by accident.
const TAG_BUDGET: usize = 60_000;

/// Upper bound on tokens generated before the pass stands down, for the
/// starvation test. The break lands on the first probe after the user
/// registers, so the real number is the handful of tokens spent while the user
/// thread spawns; the bound is loose enough to survive a busy machine and still
/// two orders of magnitude below [`TAG_BUDGET`].
const PROMPT_YIELD_TOKENS: usize = 5_000;

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime")
}

/// The tag prompt these tests pass through. Real prompts embed the note body;
/// nothing here is content, so nothing here is a DENY-list concern.
fn tag_prompt() -> Zeroizing<String> {
    Zeroizing::new("Suggest tags for: standup notes".to_string())
}

/// An engine that serializes every model call behind ONE `compute` mutex, the
/// way the Candle engine has to on Metal, and whose tag pass consults the yield
/// probe in the same three places.
///
/// It does no model work — a "token" is a sleep — because the thing under test
/// is who holds the lock and for how long, not what comes out.
struct SerializedEngine {
    /// The single lock every call takes. `CandleEngine::compute`'s stand-in.
    compute: Mutex<()>,
    /// Signalled once, from inside the generation loop, the moment the tag pass
    /// holds `compute` and has produced a token. A test that raced the user's
    /// call against the pass's *startup* would prove nothing about contention,
    /// so nothing starts until this fires.
    holding: Mutex<mpsc::Sender<()>>,
    /// Tokens generated by the tag pass, so a test can tell "stood down early"
    /// from "ran its whole budget".
    steps: Arc<AtomicUsize>,
    /// Lets a test end a pass that is deliberately never yielded to.
    stop: Arc<AtomicBool>,
    /// Set as the tag pass drops `compute`. Read to prove a note-open completed
    /// while the lock was still held rather than after it was released.
    released: Arc<AtomicBool>,
}

impl Engine for SerializedEngine {
    fn infer(&self, prompt: &str) -> Result<String, EngineError> {
        // The user's call contends for the same lock the tag pass holds — this
        // is the whole reason the test is an integration test.
        let _compute = self.compute.lock().unwrap_or_else(|p| p.into_inner());
        Ok(format!("user-infer: {prompt}"))
    }

    fn infer_tags(
        &self,
        _prompt: &str,
        should_continue: &mut dyn FnMut() -> ControlFlow<()>,
    ) -> Result<String, EngineError> {
        // Half one, mirroring `CandleEngine::infer_tags`: don't even QUEUE for
        // the lock while interactive work is pending.
        if should_continue().is_break() {
            return Ok(String::new());
        }
        let _compute = self.compute.lock().unwrap_or_else(|p| p.into_inner());
        // Half two: re-check after the wait — a call that arrived while we
        // queued must not pay for the (here elided) model load.
        if should_continue().is_break() {
            return Ok(String::new());
        }
        // Half three: per generated token.
        let mut out = String::new();
        for n in 0..TAG_BUDGET {
            if should_continue().is_break() {
                break;
            }
            if self.stop.load(Ordering::SeqCst) {
                break;
            }
            self.steps.fetch_add(1, Ordering::SeqCst);
            out.push_str("tag,");
            if n == 0 {
                // Holding the lock and generating: the test may now proceed.
                let _ = self.holding.lock().expect("holding channel").send(());
            }
            std::thread::sleep(TOKEN);
        }
        self.released.store(true, Ordering::SeqCst);
        Ok(out)
    }
}

/// One engine plus the handles a test needs to drive it.
struct Harness {
    engine: Arc<dyn Engine>,
    holding: mpsc::Receiver<()>,
    steps: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    released: Arc<AtomicBool>,
}

fn harness() -> Harness {
    let (tx, holding) = mpsc::channel();
    let steps = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let released = Arc::new(AtomicBool::new(false));
    Harness {
        engine: Arc::new(SerializedEngine {
            compute: Mutex::new(()),
            holding: Mutex::new(tx),
            steps: Arc::clone(&steps),
            stop: Arc::clone(&stop),
            released: Arc::clone(&released),
        }),
        holding,
        steps,
        stop,
        released,
    }
}

/// Start a background auto-tag pass through the real command core and return
/// its join handle. Nothing about it is user-initiated — it registers no
/// interactive guard, exactly like the ambient pass it stands for.
fn spawn_tag_pass(
    engine: Arc<dyn Engine>,
    pri: ComputePriority,
) -> std::thread::JoinHandle<Result<String, EngineError>> {
    std::thread::spawn(move || {
        rt().block_on(suggest_tags_with_engine(
            engine,
            pri,
            TagGate::Allowed,
            tag_prompt(),
        ))
    })
}

#[test]
fn a_user_infer_is_not_starved_by_a_running_tag_pass() {
    let h = harness();
    let pri = ComputePriority::default();

    let tag = spawn_tag_pass(Arc::clone(&h.engine), pri.clone());
    // Only once the pass genuinely holds `compute` and is generating does the
    // user's call mean anything — before that there is no contention to survive.
    h.holding
        .recv_timeout(WAIT)
        .expect("the tag pass never reached the compute lock");

    // The user asks for a summarize. These two lines ARE the `infer` command:
    // register for the length of the call, then run the shared core.
    let (done_tx, done) = mpsc::channel();
    let user_engine = Arc::clone(&h.engine);
    let user_pri = pri.clone();
    let user = std::thread::spawn(move || {
        let _interactive = user_pri.interactive();
        // The third argument is a real registered request handle: `#445` made
        // one obtainable only from a `CancelGuard`, precisely so a command
        // cannot reach an engine without a token the vault lock can find.
        let reg = crate::plugins::local_inference::cancel::CancelRegistry::default();
        let guard = reg.begin(crate::plugins::local_inference::cancel::CancelReach::LockOnly);
        let out = rt().block_on(infer_with_engine(
            user_engine,
            "summarize this".to_string(),
            None,
            guard.request_cancel(),
        ));
        let _ = done_tx.send(out);
    });

    // The claim. A pass that held `compute` for its budget would blow this wait
    // by 50 seconds; one that never dropped the lock would never answer at all.
    let out = done
        .recv_timeout(WAIT)
        .expect("the user's infer was starved behind the background tag pass");
    assert_eq!(out, Ok("user-infer: summarize this".to_string()));
    user.join().expect("user thread");

    let tagged = tag.join().expect("tag thread");
    assert_eq!(
        tagged,
        Err(EngineError::Deferred),
        "a yielded pass reports Deferred — never its partial text as if it were a finished set"
    );
    let steps = h.steps.load(Ordering::SeqCst);
    assert!(
        steps > 0,
        "the pass must have been mid-generation when the user arrived, or nothing was contended"
    );
    assert!(
        steps < PROMPT_YIELD_TOKENS,
        "the pass ran {steps} tokens of its {TAG_BUDGET} budget — it did not stand down promptly"
    );
}

#[test]
fn opening_a_note_is_not_gated_on_a_running_tag_pass() {
    use crate::paths::notes_dir_under;
    use crate::plugins::vault_unlock::state::{
        fixture_unlocked_with_keys, test_vault_id, VaultRuntimeState,
    };
    use crate::test_support::ScopedTempDir;
    use myne_core::plugins::notes::commands::{note_create_with_dir, note_read_with_dir};

    // Byte-pattern fixture keys, as everywhere else that drives the CRUD core.
    const ROOT: u8 = 0x07;
    const ITEMS: u8 = 0x09;
    const ITEMS_ID: u8 = 0x01;

    let scratch = ScopedTempDir::new("tag-pass-note-open").expect("tempdir");
    let notes_dir = notes_dir_under(scratch.path()).expect("notes dir");
    let state = Arc::new(VaultRuntimeState::default());
    let plaintext = "# standup\nthe body a tag pass must never be able to hide";

    let note_id = rt().block_on(async {
        state
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(ROOT, ITEMS, ITEMS_ID),
            )
            .await;
        note_create_with_dir(
            notes_dir.clone(),
            &state,
            plaintext.to_string(),
            &myne_core::vault_io::StdVaultIo,
            &myne_core::host::NoopHost,
        )
        .await
        .expect("fixture note")
    });

    let h = harness();
    // Nobody registers interactive work in this test, so the pass yields to
    // nothing: it holds `compute` until it is told to stop. That is the whole
    // point — the note read must not be waiting on it.
    let tag = spawn_tag_pass(Arc::clone(&h.engine), ComputePriority::default());
    h.holding
        .recv_timeout(WAIT)
        .expect("the tag pass never reached the compute lock");

    // Open the note for real: the production command core, a real AEAD decrypt
    // of a real `MY01` blob, on its own runtime — while the lock is held.
    let (read_tx, read) = mpsc::channel();
    let read_state = Arc::clone(&state);
    let read_dir = notes_dir.clone();
    let reader = std::thread::spawn(move || {
        let out = rt().block_on(note_read_with_dir(
            read_dir,
            &read_state,
            note_id,
            &myne_core::vault_io::StdVaultIo,
            &myne_core::host::NoopHost,
        ));
        let _ = read_tx.send(out);
    });

    let body = read
        .recv_timeout(WAIT)
        .expect("note-open blocked behind the background tag pass");
    assert_eq!(body.expect("the fixture note must decrypt"), plaintext);
    reader.join().expect("reader thread");

    // And it came back while the pass was STILL holding the lock — the read did
    // not merely win a race against a pass that had already finished.
    assert!(
        !h.released.load(Ordering::SeqCst),
        "the tag pass had already released `compute`; this run proves nothing about contention"
    );

    h.stop.store(true, Ordering::SeqCst);
    let tagged = tag.join().expect("tag thread");
    assert!(
        tagged.is_ok(),
        "a pass nobody interrupted completes normally, got {tagged:?}"
    );
    assert!(
        h.steps.load(Ordering::SeqCst) > 0,
        "the pass must have been generating for the read to have been concurrent with it"
    );
}
