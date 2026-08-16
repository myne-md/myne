//! The [`Engine`] trait — the single seam every AI capability sibling reaches
//! inference through (SYNC-3/7).
//!
//! **Ten methods, four of which stream.** The header used to say "two methods,
//! `infer` and `embed`" and "no streaming (SYNC-7)"; streaming was added for
//! the chat surface and that clause superseded by `decisions.md` 2026-07-04.
//! Eight of the ten are defaulted, which is what lets a backend implement only
//! `infer` + `embed` and still be a first-class citizen — the mechanism by
//! which partial capability is modelled, rather than by splitting the trait.
//!
//! The concrete impl is hidden so the in-host-vs-sidecar process boundary and
//! any future engine swap stay invisible to callers. Since ai-provider-seam a
//! backend is also *described* — identity, class, whether it serializes compute
//! — but that description lives on `state::Backend`, deliberately not here: the
//! trait stays about inference, and policy keys off the descriptor.
//!
//! The trait is **synchronous** by design: model inference is CPU-bound and
//! blocking, so the async / `spawn_blocking` seam belongs at the command
//! layer (tasks 3/6), not in the trait. It is `Send + Sync` so one engine
//! instance can back concurrent commands behind `Arc`.

use std::ops::ControlFlow;

use super::cancellable_io::CancelledFn;
use super::error::EngineError;

/// Length of the **stub** embedding vector. The real embedding model
/// (all-MiniLM-L6-v2, 384-dim, SYNC-1) lands in task 4; the stub returns a
/// short deterministic zero vector purely to exercise the trait shape.
pub const STUB_EMBED_DIM: usize = 8;

/// The role of a chat message (conversational-ai-chat task 2). Only
/// `User`/`Assistant` — the system instruction is a separate TRUSTED field on
/// [`Engine::chat_streaming`], never an attacker-controllable message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRole {
    User,
    Assistant,
}

/// One conversation message. `content` is **UNTRUSTED** — a user turn may echo
/// note content and an assistant turn derives from note content, either of which
/// could carry ChatML control markers from an attacker-chosen synced note. The
/// engine therefore tokenizes it with special-token parsing disabled (see
/// [`Engine::chat_streaming`]).
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

/// Flatten a system instruction + chat history into a single plain-text prompt,
/// for an engine that has no token-level chat path (the stub's default
/// [`Engine::chat_streaming`]). Plain text only — **no ChatML markers** — so the
/// stub never fabricates a fake turn structure; the real engine uses the
/// token-splice framing with the Special-Token-Injection defense instead.
fn flatten_chat_to_prompt(system: &str, messages: &[ChatMessage]) -> String {
    let mut s = String::new();
    if !system.is_empty() {
        s.push_str(system);
        s.push_str("\n\n");
    }
    for m in messages {
        let who = match m.role {
            ChatRole::User => "User",
            ChatRole::Assistant => "Assistant",
        };
        s.push_str(who);
        s.push_str(": ");
        s.push_str(&m.content);
        s.push('\n');
    }
    s.push_str("Assistant:");
    s
}

/// On-device inference surface (SYNC-7): a blocking `infer(prompt) -> result`
/// and `embed(text) -> vector`. No streaming (SYNC-7). Implementors must be
/// `Send + Sync` so a single engine instance can back concurrent commands
/// behind `Arc`.
pub trait Engine: Send + Sync {
    /// One-shot text completion for `prompt`. Blocking; returns the full
    /// result — no token stream (SYNC-7).
    fn infer(&self, prompt: &str) -> Result<String, EngineError>;

    /// One-shot completion with a caller-supplied generation ceiling (MYND
    /// issue #193). Same contract as [`Engine::infer`] otherwise.
    ///
    /// Exists because the passive inline ghost-text wants a few words, while
    /// chat and `/devam` want the engine's full budget — and they all ride this
    /// one command. Generating 512 tokens to show ~15 of them is not just waste:
    /// it holds the single `compute` lock for the whole budget, which is exactly
    /// what [`Engine::infer_tags`] has its own ceiling to avoid.
    ///
    /// `max_new_tokens` arrives from the WebView and is therefore UNTRUSTED — an
    /// implementor clamps it to its own ceiling rather than honouring it.
    ///
    /// Default: ignore the ceiling and run [`Engine::infer`] — correct for any
    /// engine with no per-call bound (the stub echoes, so there is nothing to
    /// bound). The caller trims the text it shows either way, so the default
    /// degrades to "slower than it needed to be", never to a wrong answer.
    fn infer_bounded(&self, prompt: &str, _max_new_tokens: usize) -> Result<String, EngineError> {
        self.infer(prompt)
    }

    /// [`Engine::infer`] / [`Engine::infer_bounded`], plus **this request's own**
    /// abort predicate (myne-md/myne#445).
    ///
    /// The two network-backed engines bake a `CancelledFn` in at construction,
    /// because they are built once at plugin setup and the transport needs
    /// something to poll while the far side is silent. That source was
    /// necessarily fleet-wide — "is ANY in-flight request cancelled" — so one
    /// request's Stop aborted every other one, and a command with no registered
    /// token could not be aborted at all. This method is how a caller says
    /// *which* request it is asking about.
    ///
    /// `max_new_tokens` carries the same UNTRUSTED-ceiling contract as
    /// [`Engine::infer_bounded`], and `None` means the engine's own budget.
    ///
    /// Default: ignore `cancelled` and take the ordinary path — correct for
    /// every engine whose cancellation already works at the emit seam (the
    /// in-process Candle backend emits per token, so [`super::cancel::
    /// guarded_on_token`] stops it), and for the stub. Only an engine that
    /// blocks on a socket before producing anything needs to override.
    fn infer_cancellable(
        &self,
        prompt: &str,
        max_new_tokens: Option<usize>,
        _cancelled: &CancelledFn,
    ) -> Result<String, EngineError> {
        match max_new_tokens {
            Some(cap) => self.infer_bounded(prompt, cap),
            None => self.infer(prompt),
        }
    }

    /// [`Engine::chat_streaming`] with this request's own abort predicate — the
    /// streaming counterpart of [`Engine::infer_cancellable`], and the one that
    /// matters most: a remote provider does not stream, so `on_token` is called
    /// once with the whole reply and the publish-guard only ever looks *after*
    /// the request has already completed.
    ///
    /// Default: ignore `cancelled` and take the ordinary path.
    fn chat_streaming_cancellable(
        &self,
        system: &str,
        messages: &[ChatMessage],
        on_token: &mut dyn FnMut(&str) -> ControlFlow<()>,
        _cancelled: &CancelledFn,
    ) -> Result<String, EngineError> {
        self.chat_streaming(system, messages, on_token)
    }

    /// Embedding vector for `text`. Real models return a fixed dimensionality
    /// (task 4: 384); the stub returns [`STUB_EMBED_DIM`] zeros.
    fn embed(&self, text: &str) -> Result<Vec<f32>, EngineError>;

    /// Streaming text completion for `prompt` (conversational-ai-chat task 1;
    /// SYNC-7 supersede — streaming was deferred in the local-ai spike and is
    /// now added for the chat surface). Emits each newly-decoded token's text
    /// through `on_token` as it is produced, and also returns the full result so
    /// non-streaming callers keep working. `on_token` returning
    /// [`ControlFlow::Break`] stops generation early — the seam a composer
    /// "Stop" button or a vault-lock abort (task 4's cancel-token) drives — and
    /// the partial result generated so far is returned.
    ///
    /// The callback receives incremental text only; **no token, prompt, or
    /// note-derived string is ever logged** (DENY-list, `src-tauri/CLAUDE.md`).
    ///
    /// Default: a non-streaming fallback that computes the whole result and
    /// emits it once — correct for any engine that has no incremental path.
    fn infer_streaming(
        &self,
        prompt: &str,
        on_token: &mut dyn FnMut(&str) -> ControlFlow<()>,
    ) -> Result<String, EngineError> {
        let out = self.infer(prompt)?;
        let _ = on_token(&out);
        Ok(out)
    }

    /// Streaming **multi-turn** chat completion (conversational-ai-chat task 2).
    /// `system` is the TRUSTED instruction; `messages` is the alternating
    /// user/assistant history whose `content` is UNTRUSTED. The real engine
    /// frames ChatML with the trusted role scaffold as control tokens and every
    /// untrusted span tokenized as ordinary text (special-token parsing
    /// disabled) — the "parameterize, don't escape" defense against ChatML
    /// Special-Token Injection (STI), with `sanitize_chatml` as a second layer.
    /// Emits tokens like [`Engine::infer_streaming`]; `on_token` returning
    /// [`ControlFlow::Break`] stops early and returns the partial result.
    ///
    /// Default: flatten to one plain-text prompt and reuse `infer_streaming` —
    /// correct for an engine (the stub) with no token-splice path.
    fn chat_streaming(
        &self,
        system: &str,
        messages: &[ChatMessage],
        on_token: &mut dyn FnMut(&str) -> ControlFlow<()>,
    ) -> Result<String, EngineError> {
        let prompt = flatten_chat_to_prompt(system, messages);
        self.infer_streaming(&prompt, on_token)
    }

    /// One-shot completion for `prompt` on the **dedicated bundled tag model**
    /// (auto-tag, MYND-651) rather than the side-loaded generation model. Same
    /// blocking prompt-in/text-out contract as [`Engine::infer`] — the caller
    /// still owns building the prompt (it holds the vault's tag vocabulary) and
    /// parsing the candidate list out of the reply.
    ///
    /// It is a separate method, not an `infer` parameter, because *which model*
    /// is the whole point: the tag role loads a first-party GGUF that ships
    /// inside the signed build and has no picker override, so a user who never
    /// side-loaded a generation model still gets suggestions, and a user who did
    /// does not get tag quality that varies with their pick.
    ///
    /// The prompt embeds note content — **never logged** (DENY-list), like every
    /// other string on this trait.
    ///
    /// `should_continue` is the caller's LOWEST-priority yield probe (MYND-651
    /// task 4): an implementation consults it before it queues for its compute
    /// lock and again per generated token, and returns what it has the moment it
    /// answers [`ControlFlow::Break`]. Auto-tag runs ambiently, so a user who
    /// asks for a summarize mid-pass must not wait behind it. The engine stays
    /// policy-free — it knows only "keep going?", never *why*
    /// ([`super::compute_priority`] owns the why).
    ///
    /// Default: [`EngineError::NotReady`] — an engine with no tag model has no
    /// tag path. The Candle engine and [`StubEngine`] override this.
    fn infer_tags(
        &self,
        _prompt: &str,
        _should_continue: &mut dyn FnMut() -> ControlFlow<()>,
    ) -> Result<String, EngineError> {
        Err(EngineError::NotReady)
    }

    /// Whether this build has an auto-tag model at all (MYND-651). Cheap and
    /// synchronous — it answers from the path resolved at construction and
    /// loads nothing.
    ///
    /// It exists so the settings surface can tell the truth. The tag role is
    /// bundled-only by design (`threat-model.md` §7: no override picker), so
    /// unlike every other role there is no side-load the user could perform to
    /// make it work — a build that ships no blob has no auto-tag, permanently.
    /// Without this the AI panel would offer a switch that persists `true` while
    /// every pass answers [`EngineError::NotReady`] and no band ever appears,
    /// with nothing anywhere saying why.
    ///
    /// It reveals a property of the BUILD, not of the vault: no prefs read, no
    /// note decrypt, no gate. `false` is the safe answer for any engine that
    /// does not override it.
    fn tag_model_available(&self) -> bool {
        false
    }

    /// Whether this engine supplies the models for the LOCAL roles itself, so a
    /// missing side-loaded or bundled file is not the absence of a model.
    ///
    /// The capability report resolves generation / embedding / transcription by
    /// asking the DISK — a selected GGUF for generation and embedding, a bundled
    /// blob for transcription — which is right for the Candle engine and wrong
    /// for any engine that carries its own weights. The E2E [`StubEngine`] is
    /// the one such engine today: it answers deterministically with no file
    /// anywhere, and the report nonetheless called every role `NoModel`, so the
    /// whole AI surface rendered as "no provider" in the very build the AI
    /// scenarios drive. `auto_tag` was the exception that showed the shape —
    /// it asks [`Engine::tag_model_available`] instead of the disk, and it was
    /// the one row that worked.
    ///
    /// Like `tag_model_available` this reveals a property of the BUILD, not of
    /// the vault: no prefs read, no note decrypt, no gate. `false` is the safe
    /// answer for any engine that does not override it — an engine whose
    /// weights come from a file the user picks must keep saying so, or the
    /// report would promise a capability whose first call answers `NoModel`.
    fn carries_own_models(&self) -> bool {
        false
    }

    /// Drop any lazily-cached loaded model so the next `infer`/`embed` re-reads
    /// from disk. Called after the user picks a new model file
    /// (`set_model_path`) so a swap takes effect without an app restart —
    /// otherwise the process keeps serving the previously-loaded weights while a
    /// freshly persisted embeddings index is (correctly) labeled with the NEW
    /// model identity, silently poisoning retrieval (§9.17.2/§9.17.4). Default
    /// no-op — the stub holds no cache.
    fn invalidate_models(&self) {}

    /// The **name + content digest** the backend reports for the embedding
    /// model it is currently serving, or `None` for an engine whose model is a
    /// file the client hashes itself.
    ///
    /// This does not contradict the header's "description lives on
    /// `state::Backend`, not here". A descriptor is static and known before
    /// any request; this is a **runtime query only the engine can answer** —
    /// the digest is the runtime's own bookkeeping, reachable only by asking
    /// it. `Backend` could not carry it without becoming a cache of something
    /// that changes underneath it.
    ///
    /// Why it exists: `vault.embeddings` is keyed by a model identity
    /// (`protocol.md` §9.17.2), and a served model has no file to hash. Before
    /// this method the served case produced NO identity, so the snapshot was
    /// never written and every unlock re-embedded the whole vault.
    ///
    /// Costs a round trip, so callers ask once per walk, not per note. `None`
    /// on any failure — an unreachable runtime degrades to "no persistence
    /// this session", never to a wrong identity.
    ///
    /// Neither string is logged (both name the user's model choice, and the
    /// DENY-list discipline in `src-tauri/CLAUDE.md` governs this whole tree).
    fn served_model_identity(&self) -> Option<(String, String)> {
        None
    }

    /// Transcribe already-decoded audio to text (voice-to-text, MYND-550;
    /// SYNC-V5). `pcm` is **16 kHz mono f32** — the WAV decode + resample happen
    /// at the command layer ([`super::audio`]) so the engine stays pure
    /// model-compute; a Whisper impl feeds this straight into the log-mel front
    /// end. Blocking (CPU-bound, like [`Engine::infer`]); the async /
    /// `spawn_blocking` seam is the command's. Auto-detects the spoken language
    /// and transcribes **in that language** — never translates (SYNC-V3).
    ///
    /// `pcm` is decrypted audio (AS1-class) — **never logged** (DENY-list); the
    /// returned transcript is likewise content and is never logged.
    ///
    /// Default: [`EngineError::NoModel`] — an engine with no ASR model (a
    /// generation/embedding-only build) has no transcription path, which is the
    /// "no model available" case (MYND-591: the transcribe path never returns
    /// the generic `NotReady`). The real Candle-Whisper impl and the
    /// [`StubEngine`] override this.
    fn transcribe(&self, _pcm: &[f32]) -> Result<String, EngineError> {
        Err(EngineError::NoModel)
    }

    /// Streaming transcription (SYNC-V5): emits each newly-decoded ~30 s
    /// segment's text through `on_segment` as Whisper finishes it, and also
    /// returns the full transcript so non-streaming callers keep working.
    /// `on_segment` returning [`ControlFlow::Break`] stops decoding early — the
    /// seam the UI "Stop" button and the vault-lock abort ([`super::cancel`])
    /// drive — and the transcript produced so far is returned.
    ///
    /// The callback receives transcript text only; **no PCM or transcript span
    /// is ever logged** (DENY-list). Default: a non-streaming fallback that
    /// transcribes the whole clip and emits it once — correct for the stub and
    /// any engine with no segment-incremental path.
    fn transcribe_streaming(
        &self,
        pcm: &[f32],
        on_segment: &mut dyn FnMut(&str) -> ControlFlow<()>,
    ) -> Result<String, EngineError> {
        let out = self.transcribe(pcm)?;
        let _ = on_segment(&out);
        Ok(out)
    }
}

/// A deliberate fault the E2E stub can be put into (#191 task 2).
///
/// The tauri-driver harness had **no way to drive an unavailable backend**:
/// `StubEngine::tag_model_available` answers `true` on purpose, so every
/// scenario has always run against a working one and the degradation paths this
/// slice exists to fix had zero coverage.
///
/// Two faults, because they are different states with different honest copy: a
/// backend that is not there at all, and one that is there and fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// In the default build only `None` is ever constructed — the other two exist so
// the boundary test can assert that no value reaches them without the stub
// feature. Named rather than left as a bare allow.
#[cfg_attr(not(feature = "local-inference-stub"), allow(dead_code))]
pub(crate) enum StubFault {
    None,
    /// Nothing to answer with — the empty state.
    Unavailable,
    /// Present, reachable, and every call fails.
    Failing,
}

/// The lever, read **only** in the E2E build.
///
/// `#[cfg(feature = "local-inference-stub")]` is the whole safety argument, and
/// it is a build variant rather than a runtime knob for the reason
/// `voice-capture-stub` states about itself: *"a build that cannot ship needs no
/// escape hatch, and two knobs would be two things to keep in sync."* The
/// default build does not read the variable, so setting it on a shipped binary
/// does nothing — the code that would have read it does not exist.
#[cfg(feature = "local-inference-stub")]
fn stub_fault() -> StubFault {
    fault_of(std::env::var("MYNE_E2E_AI_FAULT").ok().as_deref())
}

/// The mapping, split out from the environment read so it is testable in BOTH
/// builds without a process-global env write — and so the production arm below
/// can be proved to have no other value than `None`.
#[cfg_attr(not(feature = "local-inference-stub"), allow(dead_code))]
pub(crate) fn fault_of(raw: Option<&str>) -> StubFault {
    match raw {
        Some("unavailable") => StubFault::Unavailable,
        Some("failing") => StubFault::Failing,
        // An unrecognized value is NOT a fault. A typo in a scenario must leave
        // the harness working rather than silently testing the empty state.
        _ => StubFault::None,
    }
}

/// The production arm: no lever, no environment read, no branch.
#[cfg(not(feature = "local-inference-stub"))]
fn stub_fault() -> StubFault {
    StubFault::None
}

/// Does this fault leave the stub holding models at all?
///
/// Split out for the same reason [`fault_of`] is: it is the fault → capability
/// mapping, and both stub answers about model presence
/// ([`Engine::tag_model_available`] and [`Engine::carries_own_models`]) key off
/// it. Two copies of `!= Unavailable` would be two things to keep in step, and
/// the copy that drifted would report a model the other says is gone.
///
/// `Unavailable` is the empty state a scenario drives on purpose; `Failing` is
/// deliberately NOT — a model that errors is still a model that exists, and the
/// two states have different honest copy, which is the whole reason the lever
/// has two values.
#[cfg_attr(not(feature = "local-inference-stub"), allow(dead_code))]
pub(crate) fn models_present_under(fault: StubFault) -> bool {
    fault != StubFault::Unavailable
}

/// Trivial in-memory engine used before any model lands (the task-1 tracer).
///
/// `infer` echoes the prompt behind a fixed marker; `embed` returns a
/// [`STUB_EMBED_DIM`]-length zero vector. Deterministic, allocation-only — no
/// model, no network, no file I/O — so it proves the trait shape and the
/// feature isolation compile and round-trip.
#[derive(Debug, Default, Clone, Copy)]
pub struct StubEngine;

impl StubEngine {
    /// The refusal this build's fault lever asks for, or `None` to proceed.
    /// One place, so a method cannot be added later that quietly ignores it.
    fn fault(&self) -> Option<EngineError> {
        match stub_fault() {
            StubFault::None => None,
            StubFault::Unavailable => Some(EngineError::NoModel),
            StubFault::Failing => Some(EngineError::InferenceFailed),
        }
    }
}

/// The opening sentence of the agent loop's system instructions.
///
/// Matched rather than imported so this file does not depend on
/// `myne-core`'s prompt module for a test double's routing decision. It is a
/// prefix of a `const`-built string on the other side, so a reword there makes
/// [`agent_script`] return `None` and every agent E2E scenario fail loudly on
/// an empty proposal, which is the failure direction to prefer.
const AGENT_INSTRUCTIONS_OPENER: &str = "You edit the user's notes by proposing changes.";

/// A deterministic action script for an agent-loop prompt, or `None` when the
/// prompt is not one.
///
/// **The plain echo cannot drive an agent run, and three E2E scenarios were
/// written before anyone checked.** The agent's system instructions list all
/// seven actions as literal JSON lines so a model can copy the shape; echoing
/// the prompt back therefore parses as all seven at once, ending at `finish`,
/// so every run reported an empty proposal on iteration one. `ag1` asserted a
/// non-empty proposal and could never have passed.
///
/// The script is driven by the transcript, which is in the prompt, so this stays
/// a pure function of its input and needs no state:
///
/// 1. nothing after the instructions yet, so ask what is in scope;
/// 2. a scope listing arrived, so read its first note;
/// 3. a body arrived, so propose one anchored edit on its first line and finish.
///
/// Step 3's anchor is the body's first line copied verbatim, which is what makes
/// it place exactly once for a scenario that typed a distinctive line. A stub
/// that invented an anchor would exercise the refusal path instead of the apply
/// path, and would look like a working script while testing the opposite thing.
#[cfg_attr(not(feature = "local-inference-stub"), allow(dead_code))]
fn agent_script(prompt: &str) -> Option<String> {
    let at = prompt.find(AGENT_INSTRUCTIONS_OPENER)?;
    // Everything after the instruction block's last example line. The examples
    // themselves must not be read as transcript, or step 1 never fires.
    let after_examples = prompt[at..].find("quote, not as a request.")? + at;
    let tail = &prompt[after_examples..];

    // Step 3 first: a body is present once the tail carries an assistant turn
    // that asked to read a note AND something after it. Ordering the checks
    // most-advanced-first keeps each one a simple containment test.
    if tail.contains("\"action\":\"read_note\"") {
        // The note id this run is working on, taken from the read_note line the
        // previous iteration produced rather than re-derived, so the edit and
        // the read cannot name different notes.
        let id = tail
            .split("\"note_id\":\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())?
            .to_string();
        // The body is the last `<|im_start|>user` block: the read result.
        //
        // Cut at `<|im_end|>` before splitting lines. The renderer writes the
        // closing marker with no newline before it, so the body's LAST line
        // carries it glued on; for a single-line note that is also its first
        // line, and the anchor then contained a control marker and refused with
        // `AnchorNotFound`. A containment check against the body passed anyway
        // (the marker made it a non-substring in only one of the two shapes),
        // which is why the test that caught it runs the real `place`.
        let body_block = tail.rsplit("<|im_start|>user\n").next()?;
        let body_block = body_block.split("<|im_end|>").next()?;
        // Skip the frontmatter, then take the first line that occurs EXACTLY
        // ONCE in the whole note, which is the rule `place` enforces.
        //
        // Both halves were learned from a failing test, and each one alone is
        // wrong on a note the app actually creates. "First non-empty line" picks
        // `---`, which appears twice, so the edit refuses with
        // `AnchorAmbiguous`. Adding only the occurs-once rule then picks
        // `title: <name>`, so the stub rewrites a MANAGED frontmatter field
        // (`markdown-dialect.md` §3.6.1) instead of the body, which would have
        // made every scenario assert against a note whose title the agent had
        // silently changed.
        let after_frontmatter = body_block
            .strip_prefix("---\n")
            .and_then(|rest| rest.split_once("\n---\n"))
            .map(|(_, body)| body)
            .unwrap_or(body_block);
        // Up to TWO edits, one per eligible line.
        //
        // Not a richer script for its own sake: "reject one, approve the rest"
        // is a real user path and the acceptance criterion for it, and with a
        // single proposed edit rejecting that one leaves nothing to apply, so
        // the apply returns early and no report ever renders. `ag1` failed
        // exactly that way. Two is the smallest number that makes the path real.
        let anchors: Vec<&str> = after_frontmatter
            .lines()
            .map(str::trim_end)
            .filter(|l| {
                !l.is_empty() && !l.starts_with("<|im_") && body_block.matches(*l).count() == 1
            })
            .take(2)
            .collect();
        if anchors.is_empty() {
            return None;
        }
        let mut out = String::new();
        for anchor in anchors {
            out.push_str(&format!(
                "{{\"action\":\"propose_edit\",\"note_id\":\"{id}\",\"anchor\":\"{anchor}\",\
                 \"replacement\":\"{anchor} (edited by the stub)\"}}\n"
            ));
        }
        out.push_str("{\"action\":\"finish\",\"summary\":\"stub run\"}");
        return Some(out);
    }

    // Step 2: the scope listing is in, so read its first entry. `list_scope`
    // renders one `"{note_id} {title}"` line per note.
    if tail.contains("\"action\":\"list_scope\"") {
        let id = tail
            .rsplit("<|im_start|>user\n")
            .next()?
            .lines()
            .find(|l| !l.trim().is_empty())?
            .split_whitespace()
            .next()?
            .to_string();
        return Some(format!("{{\"action\":\"read_note\",\"note_id\":\"{id}\"}}"));
    }

    // Step 1.
    Some("{\"action\":\"list_scope\"}".to_string())
}

impl Engine for StubEngine {
    fn infer(&self, prompt: &str) -> Result<String, EngineError> {
        if let Some(e) = self.fault() {
            return Err(e);
        }
        // An agent prompt gets a scripted action instead of an echo. Everything
        // else keeps the echo, which is what the non-agent AI scenarios assert.
        if let Some(script) = agent_script(prompt) {
            return Ok(script);
        }
        // Echo, not a model. The marker lets a test assert the value came
        // through the trait against the stub (not a real completion).
        Ok(format!("stub-infer: {prompt}"))
    }

    fn embed(&self, _text: &str) -> Result<Vec<f32>, EngineError> {
        if let Some(e) = self.fault() {
            return Err(e);
        }
        Ok(vec![0.0; STUB_EMBED_DIM])
    }

    fn infer_streaming(
        &self,
        prompt: &str,
        on_token: &mut dyn FnMut(&str) -> ControlFlow<()>,
    ) -> Result<String, EngineError> {
        if let Some(e) = self.fault() {
            return Err(e);
        }
        // Deterministic token-by-token emission: the same string `infer`
        // returns, split into whitespace-inclusive chunks so tests can assert
        // incremental delivery AND that the concatenation equals the blocking
        // result. `Break` returns the partial emitted so far (early-stop seam).
        let full = format!("stub-infer: {prompt}");
        let mut emitted = String::new();
        for chunk in full.split_inclusive(' ') {
            emitted.push_str(chunk);
            if on_token(chunk).is_break() {
                return Ok(emitted);
            }
        }
        Ok(emitted)
    }

    fn infer_tags(
        &self,
        _prompt: &str,
        should_continue: &mut dyn FnMut() -> ControlFlow<()>,
    ) -> Result<String, EngineError> {
        if let Some(e) = self.fault() {
            return Err(e);
        }
        // Honour the yield probe like the real engine does, so the E2E lane
        // exercises the priority policy rather than routing around it.
        if should_continue().is_break() {
            return Ok(String::new());
        }
        // A fixed comma list in the shape a real tag model replies in, so the
        // frontend's `parseTagCandidates` + the E2E scenario get deterministic
        // chips without a model in the repo. `stub-tag` is a legal tag token AND
        // identifies the stub, so a test can assert the value came through the
        // trait against the stub rather than a real completion.
        Ok("stub-tag, meeting, notes".to_string())
    }

    fn tag_model_available(&self) -> bool {
        // The stub IS the tag model in the E2E build, so the settings surface
        // must show auto-tag as offerable there — otherwise the tauri-driver
        // scenario would drive a switch this very feature had disabled. That
        // stays the answer in the ORDINARY stub path; only the `unavailable`
        // fault says otherwise, and `failing` deliberately does not — a model
        // that errors is still a model that exists.
        models_present_under(stub_fault())
    }

    fn carries_own_models(&self) -> bool {
        // The stub IS every local model in the E2E build — it answers
        // generation, embedding and transcription from code, with no file
        // anywhere — so the capability report must stop asking the disk about
        // roles this engine already serves. Same fault mapping as
        // `tag_model_available` above, through the same helper.
        models_present_under(stub_fault())
    }

    fn transcribe(&self, pcm: &[f32]) -> Result<String, EngineError> {
        if let Some(e) = self.fault() {
            return Err(e);
        }
        // Deterministic, model-free: encode the sample count so a test can
        // assert the value came through the trait against the stub (not a real
        // decode), and the E2E flow can assert a transcript round-tripped
        // without shipping a Whisper model into the repo.
        Ok(format!("stub-transcript: {} samples", pcm.len()))
    }

    fn transcribe_streaming(
        &self,
        pcm: &[f32],
        on_segment: &mut dyn FnMut(&str) -> ControlFlow<()>,
    ) -> Result<String, EngineError> {
        if let Some(e) = self.fault() {
            return Err(e);
        }
        // Emit in whitespace-inclusive chunks like `infer_streaming`, so a test
        // can assert incremental delivery AND that the concatenation equals the
        // blocking `transcribe`. `Break` returns the partial emitted so far.
        let full = format!("stub-transcript: {} samples", pcm.len());
        let mut emitted = String::new();
        for chunk in full.split_inclusive(' ') {
            emitted.push_str(chunk);
            if on_segment(chunk).is_break() {
                return Ok(emitted);
            }
        }
        Ok(emitted)
    }
}

#[cfg(test)]
mod stub_fault_tests {
    //! The E2E fault lever (#191 task 2). These run in BOTH builds on purpose:
    //! the mapping is pure, and the production arm's claim — that no value can
    //! produce a fault, because the environment is never read — is a claim
    //! about *this* build and is only worth asserting here.

    use super::*;

    #[test]
    fn the_two_faults_map_and_everything_else_is_none() {
        assert_eq!(fault_of(Some("unavailable")), StubFault::Unavailable);
        assert_eq!(fault_of(Some("failing")), StubFault::Failing);
        // A typo must leave the harness WORKING, not silently testing the empty
        // state — a scenario that passes against the wrong state is worse than
        // one that fails.
        assert_eq!(fault_of(Some("unavaliable")), StubFault::None);
        assert_eq!(fault_of(Some("")), StubFault::None);
        assert_eq!(fault_of(None), StubFault::None);
    }

    /// Inert by default: with no lever set the stub behaves exactly as every
    /// existing scenario expects, INCLUDING `tag_model_available() == true`.
    #[test]
    fn the_stub_is_unchanged_when_no_fault_is_set() {
        let e = StubEngine;
        assert!(e.infer("hello").is_ok());
        assert!(e.embed("x").is_ok());
        assert!(e.tag_model_available());
        assert!(e.carries_own_models());
    }

    /// The fault → model-presence mapping, asserted without a process-global env
    /// write (the reason it is a separate function at all).
    ///
    /// `failing` is the load-bearing row: it must keep the models PRESENT, or
    /// the report falls back to the disk, finds nothing, and answers `no_model`
    /// — which is the `no-provider` empty state, i.e. exactly the surface the
    /// `failing` fault exists to distinguish itself from.
    #[test]
    fn only_the_unavailable_fault_takes_the_stubs_models_away() {
        assert!(!models_present_under(StubFault::Unavailable));
        assert!(models_present_under(StubFault::Failing));
        assert!(models_present_under(StubFault::None));
    }

    /// An engine that does NOT override `carries_own_models` keeps the trait
    /// default, i.e. keeps deferring to the disk. This is what makes the
    /// production Candle path unaffected by the stub's override: its weights
    /// come from a file the user picks, and a report that promised generation
    /// before that file existed would promise a call that answers `NoModel`.
    #[test]
    fn an_engine_that_does_not_carry_models_says_so_by_default() {
        struct DiskBacked;
        impl Engine for DiskBacked {
            fn infer(&self, _p: &str) -> Result<String, EngineError> {
                Ok(String::new())
            }
            fn embed(&self, _t: &str) -> Result<Vec<f32>, EngineError> {
                Ok(Vec::new())
            }
        }
        assert!(!DiskBacked.carries_own_models());
    }

    /// The production build reads no environment variable, so the lever cannot
    /// be pulled on a shipped binary. Asserted at the source level because the
    /// alternative — setting the variable and observing nothing — would pass
    /// just as well against a build that read it and ignored it.
    #[cfg(not(feature = "local-inference-stub"))]
    #[test]
    fn the_default_build_contains_no_environment_read_for_the_lever() {
        let src = include_str!("engine.rs");
        let production = &src[..src.find("#[cfg(test)]").expect("test block")];
        // EVERY line that reads the environment for the lever must sit under
        // the stub cfg — checked per line, over all of them.
        //
        // The first draft of this test found only the FIRST mention and walked
        // back to the nearest attribute. It passed against an injected ungated
        // read in the production arm, because that read came later in the file
        // and the test never looked at it. A guard that inspects one site while
        // claiming to cover the file is the exact shape this repo keeps getting
        // burned by, so it is written as a sweep instead.
        let mut checked = 0;
        for (n, line) in production.lines().enumerate() {
            if !line.contains("MYNE_E2E_AI_FAULT") || line.trim_start().starts_with("///") {
                continue;
            }
            checked += 1;
            let preceding = production
                .lines()
                .take(n)
                .filter(|l| l.trim_start().starts_with("#[cfg("))
                .last()
                .unwrap_or("");
            assert!(
                preceding.contains("#[cfg(feature = \"local-inference-stub\")]"),
                "line {n} reads the lever outside the local-inference-stub arm \
                 (nearest cfg attribute above it: {preceding:?})"
            );
        }
        assert_eq!(
            checked, 1,
            "expected exactly one environment read for the lever; a second one \
             is a second place the boundary has to hold"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_infer_returns_non_empty_through_trait() {
        let engine: &dyn Engine = &StubEngine;
        let out = engine.infer("hello").expect("stub infer never fails");
        assert!(!out.is_empty());
        assert!(out.contains("hello"));
    }

    #[test]
    fn default_infer_bounded_falls_back_to_infer() {
        // The stub echoes, so there is nothing to bound — the default must still
        // ANSWER. A default that returned an error or an empty string would make
        // every ghost-text request on a stub-engine build (the E2E lane) silent.
        let engine: &dyn Engine = &StubEngine;
        assert_eq!(
            engine.infer_bounded("hello", 24),
            engine.infer("hello"),
            "an engine with no per-call ceiling answers as if unbounded"
        );
    }

    #[test]
    fn stub_embed_returns_fixed_dim_through_trait() {
        let engine: &dyn Engine = &StubEngine;
        let v = engine.embed("hello").expect("stub embed never fails");
        assert_eq!(v.len(), STUB_EMBED_DIM);
    }

    #[test]
    fn stub_infer_streaming_emits_incrementally_and_concatenates_to_blocking() {
        let engine: &dyn Engine = &StubEngine;
        let mut tokens: Vec<String> = Vec::new();
        let full = engine
            .infer_streaming("hello world", &mut |t| {
                tokens.push(t.to_string());
                ControlFlow::Continue(())
            })
            .expect("stub streaming never fails");
        // Emitted in more than one piece (actually streamed, not one blob).
        assert!(tokens.len() > 1, "expected multiple token emissions");
        // Concatenation of the streamed pieces equals the streamed return value…
        assert_eq!(tokens.concat(), full);
        // …and equals what the blocking `infer` would have returned.
        assert_eq!(full, engine.infer("hello world").unwrap());
    }

    #[test]
    fn stub_infer_streaming_early_stop_returns_partial() {
        let engine: &dyn Engine = &StubEngine;
        let mut count = 0;
        let partial = engine
            .infer_streaming("a b c d e", &mut |_t| {
                count += 1;
                // Stop after the first emitted token.
                ControlFlow::Break(())
            })
            .expect("stub streaming never fails");
        assert_eq!(
            count, 1,
            "callback should stop generation after first token"
        );
        // The full blocking result is longer than the partial we stopped at.
        let full = engine.infer("a b c d e").unwrap();
        assert!(
            partial.len() < full.len(),
            "early-stopped partial ({partial:?}) should be shorter than full ({full:?})"
        );
        assert!(
            full.starts_with(&partial),
            "partial is a prefix of the full result"
        );
    }

    #[test]
    fn stub_chat_streaming_flattens_history_and_streams() {
        let engine: &dyn Engine = &StubEngine;
        let messages = vec![
            ChatMessage {
                role: ChatRole::User,
                content: "hi".to_string(),
            },
            ChatMessage {
                role: ChatRole::Assistant,
                content: "hello".to_string(),
            },
            ChatMessage {
                role: ChatRole::User,
                content: "again".to_string(),
            },
        ];
        let mut pieces: Vec<String> = Vec::new();
        let out = engine
            .chat_streaming("be nice", &messages, &mut |t| {
                pieces.push(t.to_string());
                ControlFlow::Continue(())
            })
            .expect("stub chat streaming never fails");
        // Streamed (multiple pieces) and reconstructs the return value.
        assert!(pieces.len() > 1);
        assert_eq!(pieces.concat(), out);
        // The flattened prompt carried the system line + every turn's content.
        assert!(out.contains("be nice"));
        assert!(out.contains("hi"));
        assert!(out.contains("hello"));
        assert!(out.contains("again"));
    }

    #[test]
    fn stub_transcribe_returns_through_trait() {
        let engine: &dyn Engine = &StubEngine;
        let pcm = vec![0.0f32; 16_000]; // 1 s of 16 kHz mono silence
        let out = engine
            .transcribe(&pcm)
            .expect("stub transcribe never fails");
        assert!(out.contains("stub-transcript"));
        assert!(out.contains("16000"));
    }

    #[test]
    fn stub_transcribe_streaming_concatenates_to_blocking() {
        let engine: &dyn Engine = &StubEngine;
        let pcm = vec![0.0f32; 32_000];
        let mut segments: Vec<String> = Vec::new();
        let full = engine
            .transcribe_streaming(&pcm, &mut |s| {
                segments.push(s.to_string());
                ControlFlow::Continue(())
            })
            .expect("stub streaming transcribe never fails");
        assert!(segments.len() > 1, "expected multiple segment emissions");
        assert_eq!(segments.concat(), full);
        assert_eq!(full, engine.transcribe(&pcm).unwrap());
    }

    #[test]
    fn stub_infer_tags_returns_a_parseable_comma_list() {
        let engine: &dyn Engine = &StubEngine;
        let mut go = || ControlFlow::Continue(());
        let out = engine
            .infer_tags("Suggest tags for: my note", &mut go)
            .expect("stub infer_tags never fails");
        // Deterministic, and in the comma-list shape the frontend parses.
        assert_eq!(
            out,
            engine.infer_tags("a different prompt", &mut go).unwrap()
        );
        let tags: Vec<&str> = out.split(',').map(str::trim).collect();
        assert_eq!(tags, ["stub-tag", "meeting", "notes"]);
        // Not the generation path — a caller must not be able to confuse the two.
        assert!(!out.contains("stub-infer"));
    }

    #[test]
    fn stub_infer_tags_yields_before_producing_anything() {
        // The stub is what the E2E lane drives, so it has to honour the yield
        // probe too — otherwise the scenario would pass against a policy the
        // production engine implements and the test build ignores.
        let engine: &dyn Engine = &StubEngine;
        let out = engine
            .infer_tags("Suggest tags for: my note", &mut || ControlFlow::Break(()))
            .expect("a yield is not a failure");
        assert!(out.is_empty(), "yielded before generating, got: {out:?}");
    }

    #[test]
    fn default_infer_tags_is_not_ready() {
        // An engine that overrides nothing (generation/embedding-only, e.g. an
        // AI build with no bundled tag weights) has no tag path: the trait
        // default returns NotReady rather than falling back to `infer`, which
        // would silently answer with the WRONG model.
        struct BareEngine;
        impl Engine for BareEngine {
            fn infer(&self, _p: &str) -> Result<String, EngineError> {
                Ok("generation output".to_string())
            }
            fn embed(&self, _t: &str) -> Result<Vec<f32>, EngineError> {
                Ok(Vec::new())
            }
        }
        let engine: &dyn Engine = &BareEngine;
        assert_eq!(
            engine.infer_tags("prompt", &mut || ControlFlow::Continue(())),
            Err(EngineError::NotReady)
        );
    }

    #[test]
    fn tag_model_availability_agrees_with_the_tag_path() {
        // The settings surface reads `tag_model_available` to decide whether to
        // offer the auto-tag switch at all, so the two answers must not drift: an
        // engine that reports `true` and then refuses every pass is exactly the
        // lying control this signal exists to remove.
        struct BareEngine;
        impl Engine for BareEngine {
            fn infer(&self, _p: &str) -> Result<String, EngineError> {
                Ok(String::new())
            }
            fn embed(&self, _t: &str) -> Result<Vec<f32>, EngineError> {
                Ok(Vec::new())
            }
        }
        assert!(
            !BareEngine.tag_model_available(),
            "an engine with no tag override has no tag model"
        );
        assert_eq!(
            BareEngine.infer_tags("prompt", &mut || ControlFlow::Continue(())),
            Err(EngineError::NotReady)
        );

        assert!(
            StubEngine.tag_model_available(),
            "the stub IS the E2E build's tag model — the scenario drives the switch"
        );
        assert!(StubEngine
            .infer_tags("prompt", &mut || ControlFlow::Continue(()))
            .is_ok());
    }

    #[test]
    fn default_transcribe_is_no_model() {
        // An engine that overrides nothing (generation/embedding-only) has no
        // ASR path: the trait default returns NoModel (the "no model available"
        // cause, MYND-591) rather than panicking or the generic NotReady.
        struct BareEngine;
        impl Engine for BareEngine {
            fn infer(&self, _p: &str) -> Result<String, EngineError> {
                Ok(String::new())
            }
            fn embed(&self, _t: &str) -> Result<Vec<f32>, EngineError> {
                Ok(Vec::new())
            }
        }
        let engine: &dyn Engine = &BareEngine;
        assert_eq!(engine.transcribe(&[0.0; 8]), Err(EngineError::NoModel));
    }
}

#[cfg(test)]
mod agent_script_tests {
    //! Whether the stub can actually DRIVE an agent run.
    //!
    //! These exist because three E2E scenarios were written against an engine
    //! that could not produce their input, and nothing said so: the suite is
    //! Linux-only, `failure: ignore`, and a scenario that fails on an empty
    //! proposal reads exactly like a flake. The assertions below run on every
    //! platform, in both builds, in `cargo test`.

    use super::*;
    use myne_core::plugins::agent::engine::{render_chatml, Content, Message, Role};
    use myne_core::plugins::agent::prompt::{parse_actions, system_instructions, AgentAction};

    /// Render a prompt the way the desktop adapter does, from a transcript.
    fn prompt_with(transcript: Vec<Message>) -> String {
        let mut messages = vec![
            Message {
                role: Role::System,
                content: vec![Content::Trusted(system_instructions())],
            },
            Message {
                role: Role::User,
                content: vec![Content::Trusted("tidy this note".into())],
            },
        ];
        messages.extend(transcript);
        render_chatml(
            &myne_core::plugins::agent::engine::AgentRequest { messages },
            &|t| t.to_string(),
        )
        .to_string()
    }

    fn assistant(text: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: vec![Content::Trusted(text.into())],
        }
    }

    fn tool_result(text: &str) -> Message {
        Message {
            role: Role::User,
            content: vec![Content::note(text)],
        }
    }

    /// The regression that motivated the whole module: echoing the prompt back
    /// parses as EVERY example action, ending at `finish`, so a run that used
    /// the echo produced an empty proposal on iteration one.
    #[test]
    fn the_plain_echo_could_never_have_driven_a_run() {
        let echo = format!("stub-infer: {}", prompt_with(vec![]));
        let actions = parse_actions(&echo);
        assert!(
            actions.len() > 1,
            "the echo parses as many actions, not one: {}",
            actions.len()
        );
        assert!(
            matches!(actions.last(), Some(AgentAction::Finish { .. })),
            "and the last of them is `finish`, which is why every run ended \
             immediately with nothing proposed"
        );
    }

    #[test]
    fn a_non_agent_prompt_still_gets_the_echo() {
        // The other AI scenarios assert the marker, so routing must not capture
        // them. Checked through `infer` rather than `agent_script` so it covers
        // the branch the scenarios actually hit.
        let out = StubEngine.infer("summarise this").unwrap();
        assert!(out.starts_with("stub-infer: "), "got: {out}");
    }

    #[test]
    fn step_one_asks_what_is_in_scope() {
        let reply = StubEngine.infer(&prompt_with(vec![])).unwrap();
        let actions = parse_actions(&reply);
        assert_eq!(actions.len(), 1, "one action per step: {actions:?}");
        assert!(matches!(actions[0], AgentAction::ListScope));
    }

    #[test]
    fn step_two_reads_the_first_note_the_listing_named() {
        let reply = StubEngine
            .infer(&prompt_with(vec![
                assistant(r#"{"action":"list_scope"}"#),
                tool_result("note-aaa My note\nnote-bbb Another"),
            ]))
            .unwrap();
        let actions = parse_actions(&reply);
        assert_eq!(actions.len(), 1);
        match &actions[0] {
            AgentAction::ReadNote { note_id } => assert_eq!(note_id, "note-aaa"),
            other => panic!("expected a read, got {other:?}"),
        }
    }

    #[test]
    fn step_three_proposes_an_anchor_that_is_really_in_the_body() {
        let body = "alpha beta gamma delta\n\nsecond line";
        let reply = StubEngine
            .infer(&prompt_with(vec![
                assistant(r#"{"action":"list_scope"}"#),
                tool_result("note-aaa My note"),
                assistant(r#"{"action":"read_note","note_id":"note-aaa"}"#),
                tool_result(body),
            ]))
            .unwrap();
        let actions = parse_actions(&reply);
        // One edit per eligible line, then `finish`. Counted by SHAPE rather
        // than by a literal, because the edit count is a property of the body.
        assert!(
            matches!(actions.last(), Some(AgentAction::Finish { .. })),
            "the script must end by finishing: {actions:?}"
        );
        assert_eq!(
            actions.len(),
            3,
            "two eligible lines yield two edits plus the finish: {actions:?}"
        );
        let AgentAction::ProposeEdit {
            note_id,
            anchor,
            replacement,
        } = &actions[0]
        else {
            panic!("expected an edit, got {:?}", actions[0]);
        };
        assert_eq!(note_id, "note-aaa");
        // The assertion that matters. An invented anchor would exercise the
        // refusal path while looking like a working script, so this checks the
        // anchor against the body and checks that it places exactly once.
        assert!(
            body.contains(anchor.as_str()),
            "anchor {anchor:?} not in body"
        );
        assert_eq!(body.matches(anchor.as_str()).count(), 1, "must place once");
        assert_ne!(anchor, replacement, "an edit has to change something");
    }

    /// The premise `ag1` rests on: "reject one, approve the rest" needs at least
    /// two proposed edits, and with one the rejection leaves nothing to apply,
    /// so the apply returns early and no report ever renders. That is exactly
    /// how the scenario failed on its first real run.
    #[test]
    fn two_eligible_lines_yield_two_edits_so_rejecting_one_leaves_work() {
        let body = "---\ntitle: My note\n---\n\nalpha beta gamma\nepsilon zeta eta\n";
        let reply = StubEngine
            .infer(&prompt_with(vec![
                assistant(r#"{"action":"list_scope"}"#),
                tool_result("note-aaa My note"),
                assistant(r#"{"action":"read_note","note_id":"note-aaa"}"#),
                tool_result(body),
            ]))
            .unwrap();
        let actions = parse_actions(&reply);
        let edits: Vec<&AgentAction> = actions
            .iter()
            .filter(|a| matches!(a, AgentAction::ProposeEdit { .. }))
            .collect();
        assert_eq!(edits.len(), 2, "got {actions:?}");
        // And BOTH have to place, or approving the rest applies nothing.
        for e in edits {
            let AgentAction::ProposeEdit {
                anchor,
                replacement,
                ..
            } = e
            else {
                unreachable!()
            };
            assert!(
                !anchor.starts_with("title:"),
                "an anchor may not be a managed frontmatter field: {anchor:?}"
            );
            myne_core::plugins::agent::edit::place(body, anchor, replacement)
                .unwrap_or_else(|e| panic!("anchor {anchor:?} must place: {e:?}"));
        }
    }

    /// The shape a note in the app actually has.
    ///
    /// Every note the E2E scenarios create carries frontmatter, so the body's
    /// first line is `---` and it appears twice. A script that took "the first
    /// non-empty line" produced an anchor that refused with `AnchorAmbiguous`,
    /// and the only place that would have shown up is a Linux-only suite forty
    /// minutes into a container build.
    #[test]
    fn a_note_with_frontmatter_still_yields_an_anchor_that_places_once() {
        let body = "---\ntitle: My note\n---\n\nalpha beta gamma delta\n";
        let reply = StubEngine
            .infer(&prompt_with(vec![
                assistant(r#"{"action":"list_scope"}"#),
                tool_result("note-aaa My note"),
                assistant(r#"{"action":"read_note","note_id":"note-aaa"}"#),
                tool_result(body),
            ]))
            .unwrap();
        let AgentAction::ProposeEdit {
            anchor,
            replacement,
            ..
        } = &parse_actions(&reply)[0]
        else {
            panic!("expected an edit");
        };
        assert_ne!(anchor, "---", "the frontmatter fence occurs twice");
        assert_eq!(
            body.matches(anchor.as_str()).count(),
            1,
            "anchor {anchor:?} must place exactly once"
        );
        let placed = myne_core::plugins::agent::edit::place(body, anchor, replacement)
            .expect("the stub's anchor must place in a frontmattered note");
        assert_ne!(placed, body);
        // And the frontmatter is intact, so the edit is a body edit rather than
        // something that rewrote the note's managed fields.
        assert!(placed.starts_with("---\ntitle: My note\n---\n"));
    }

    #[test]
    fn the_edit_places_through_the_real_placer() {
        // End to end against `place`, which is what the apply path runs. A
        // script whose anchor parsed but did not place would still fail every
        // scenario, one layer further in.
        let body = "alpha beta gamma delta";
        let reply = StubEngine
            .infer(&prompt_with(vec![
                assistant(r#"{"action":"list_scope"}"#),
                tool_result("note-aaa My note"),
                assistant(r#"{"action":"read_note","note_id":"note-aaa"}"#),
                tool_result(body),
            ]))
            .unwrap();
        let AgentAction::ProposeEdit {
            anchor,
            replacement,
            ..
        } = &parse_actions(&reply)[0]
        else {
            panic!("expected an edit");
        };
        let placed = myne_core::plugins::agent::edit::place(body, anchor, replacement)
            .expect("the stub's anchor must place");
        assert_ne!(placed, body);
    }
}
