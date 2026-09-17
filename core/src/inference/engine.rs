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

/// One agent reply, plus whether the provider says it was cut off.
///
/// The bool exists because the token ceiling this branch introduced creates a
/// failure mode it also has to answer for: a reply stopped at the ceiling is
/// usually broken JSON, so it parses to zero actions, and the loop's generic
/// "No valid action found" tells the model to fix a format error it did not
/// make while a barren strike is spent. Carrying the reason up is what lets the
/// loop say the true thing instead.
#[derive(Clone)]
pub struct AgentReply {
    /// What the model said, as far as it got.
    pub text: String,
    /// True only when the provider itself reported a length stop. Never
    /// inferred from the text: a reply can be short because the answer was
    /// short, and guessing would tell a model that answered correctly to answer
    /// more briefly.
    pub truncated: bool,
}

/// Prints a shape, for the reason [`AgentCompletion`]'s hand-written `Debug`
/// does one crate over: `text` is the raw model reply, which carries the anchors
/// and replacements the model copied verbatim out of decrypted note bodies, and
/// a derived `Debug` puts that wherever a `{:?}` happens to be, including a
/// panic message or an `assert_eq!` diff, without anyone deciding to put it
/// there. Nothing formats one today, so this closes a trap rather than a leak,
/// which is the cheapest moment to close one.
impl std::fmt::Debug for AgentReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentReply")
            .field(
                "text",
                &format_args!("<{} chars>", self.text.chars().count()),
            )
            .field("truncated", &self.truncated)
            .finish()
    }
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

    /// The agent loop's request, which may carry a generation ceiling.
    ///
    /// **A separate method rather than a parameter on the arm above**, so that
    /// "this request is the agent's" is visible at the call site rather than
    /// inferred from an argument, and so that an engine with no ceiling to
    /// impose inherits the default and changes nothing. Only `RemoteEngine`
    /// overrides it: a local model's ceiling is the machine's, and the stub has
    /// no generation to bound.
    fn chat_agent_cancellable(
        &self,
        system: &str,
        messages: &[ChatMessage],
        on_token: &mut dyn FnMut(&str) -> ControlFlow<()>,
        cancelled: &CancelledFn,
    ) -> Result<AgentReply, EngineError> {
        // `truncated: false` is a claim, not a placeholder: this arm imposes no
        // ceiling, so nothing here can cut a reply off. An engine that grows one
        // owes this method an override rather than a `false` it inherited.
        self.chat_streaming_cancellable(system, messages, on_token, cancelled)
            .map(|text| AgentReply {
                text,
                truncated: false,
            })
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
    /// inside the build itself and has no picker override, so a user who never
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

/// The most recent user turn, or `""`.
#[cfg_attr(not(feature = "local-inference-stub"), allow(dead_code))]
fn last_user_of(messages: &[ChatMessage]) -> &str {
    messages
        .iter()
        .rev()
        .find(|m| m.role == ChatRole::User)
        .map(|m| m.content.as_str())
        .unwrap_or("")
}

/// The answer to `probe::probe_request`, or `None` when this is not the probe.
///
/// The probe names the note, quotes the line to change and quotes what it
/// should become, so all three are read out of the prompt. Hard-coding them
/// would make the stub pass a probe it was no longer being asked.
#[cfg_attr(not(feature = "local-inference-stub"), allow(dead_code))]
fn probe_answer(user: &str) -> Option<String> {
    const MARK: &str = "This is the whole of note ";
    let note_id = user.split(MARK).nth(1)?.split(':').next()?.trim();
    // `changes the line "<target>" to "<replacement>"`.
    let tail = user.split("changes the line ").nth(1)?;
    let mut quoted = tail.split('"');
    quoted.next()?; // before the first quote
    let target = quoted.next()?;
    quoted.next()?; // ` to `
    let replacement = quoted.next()?;
    Some(format!(
        "{{\"action\":\"propose_edit\",\"note_id\":\"{note_id}\",\"anchor\":\"{target}\",\
         \"replacement\":\"{replacement}\"}}"
    ))
}

/// The first note id anywhere in a tool result, past whatever prose frames it.
///
/// A tool result is `<host prose>` then the payload (myne-md/myne#574), and the
/// payload's lines are `<note_id> <title>`. So the id is not at a known offset
/// and this searches for it by parsing, which is what makes a reworded frame
/// move nothing.
///
/// **Scanned by POSITION, not by line or by whitespace token, and the wire
/// format is why.** `chat_shape` concatenates a message's spans with no
/// separator at all (`src-tauri/src/plugins/agent/adapters.rs`), so the prose
/// does not end in a newline and the payload's first id is GLUED to the end of
/// the prose sentence: the whitespace token there is `need.01a047c1-...`, not
/// the id, and no line begins with an id when the scope holds one note, which
/// is the ordinary case. Two earlier versions of this function missed that in
/// those two ways, and each had a test whose fixture supplied a separator the
/// wire never carries.
///
/// `Uuid::try_parse` rather than a hand-rolled shape check: the note store
/// issues canonical hyphenated UUIDs, `uuid` is already a direct dependency,
/// and the hand-rolled version wrote the dash positions out twice and had no
/// right boundary, so a longer hex run answered with a truncated 36-character
/// prefix. The boundary check is the other half of that: a candidate whose next
/// byte is still hex or a dash is part of something longer and is not an id.
///
/// Parsing is not resolving. The stub has no note store to ask, so an id that
/// parses and names nothing is still possible; the loop refuses it with a
/// sentence naming the right one. What must not happen is the opposite, an
/// English word passing as an id, which is the defect this replaces. The
/// prose's own `` `<note_id> <title>` `` placeholder does not parse, so the
/// frame cannot answer for the payload.
#[cfg_attr(not(feature = "local-inference-stub"), allow(dead_code))]
fn first_note_id(text: &str) -> Option<&str> {
    text.char_indices()
        .filter(|(_, c)| c.is_ascii_hexdigit())
        .find_map(|(i, _)| {
            let candidate = text.get(i..i + 36)?;
            if uuid::Uuid::try_parse(candidate).is_err() {
                return None;
            }
            // Not a prefix of something longer.
            let next = text.as_bytes().get(i + 36);
            match next {
                Some(b) if b.is_ascii_hexdigit() || *b == b'-' => None,
                _ => Some(candidate),
            }
        })
}

/// What a `read_note` answer turned out to be.
#[cfg_attr(not(feature = "local-inference-stub"), allow(dead_code))]
enum Framed<'a> {
    /// Host prose was found and its stated length located the note.
    Note(&'a str),
    /// It carries the frame's opening words but the length could not be read,
    /// so the note's start is unknown. Answering nothing is the loud failure;
    /// answering the whole message is how the host's own sentence became an
    /// anchor (myne-md/myne#596).
    Unreadable,
    /// No frame at all: a bare note body, which is what the unit tests pass.
    Bare,
}

/// Split a `read_note` answer into the note, using the length the host states.
///
/// The frame is `read_note returned the body of that note, N characters, and it
/// follows. …` and `chat_shape` concatenates spans with no separator, so the
/// note is the final N CHARACTERS (not bytes: the count the host writes is
/// `chars().count()`).
#[cfg_attr(not(feature = "local-inference-stub"), allow(dead_code))]
/// `read_note`'s answer (`core/src/plugins/agent/run_loop.rs`).
const READ_NOTE_OPENER: &str = "read_note returned the body of that note,";
/// The OPENING message for a single-note scope, which carries the body before
/// anything asks for it (myne-md/myne#578).
const OPENING_NOTE_OPENER: &str = "Your scope is one note. Its id is ";
const OPENING_NOTE_ID_TAIL: &str = " and its whole text follows";
const OPENING_NOTE_LEN_MARKER: &str = "The text is ";

/// The note inside whichever frame the host used, by the length the host stated.
///
/// **There are TWO frames, and knowing only one of them is what broke `ag1`,
/// `ag3` and `ag4` at once.** myne-md/myne#578 made the loop OPEN with the
/// listing and, when the scope is exactly one note, that note's body, so the
/// model "does not need list_scope or read_note". This function knew only
/// `read_note`'s wording, so the opening message read as `Framed::Bare`, the
/// whole host sentence counted as the note, `unique_body_lines` found no line
/// that occurs once in it, step 3 answered `None`, and the script fell back to
/// walking `list_scope` then `read_note` anyway. The host then answered the
/// re-read with "You have already read that note in this run", the stub took
/// THAT sentence for the body, and proposed a single edit anchored on host
/// prose: one edit where `ag1` needs two, an anchor that cannot `place` so
/// `ag4`'s apply never completes and its dialog never dismisses, and no
/// `title:` line for `ag3`'s trash branch so no proposal rendered at all.
fn note_after_frame(body: &str) -> Framed<'_> {
    if body.starts_with(READ_NOTE_OPENER) {
        let Some(chars) = body
            .split_once(READ_NOTE_OPENER)
            .and_then(|(_, rest)| rest.split_once(" characters"))
            .and_then(|(count, _)| count.trim().parse::<usize>().ok())
        else {
            return Framed::Unreadable;
        };
        return note_tail(body, chars);
    }
    if body.starts_with(OPENING_NOTE_OPENER) {
        // `split_once` rather than `rsplit_once`: the prose comes FIRST, so the
        // first marker is the host's own. A note whose text happens to contain
        // "The text is 12 characters:" would otherwise redefine the boundary.
        let Some(chars) = body
            .split_once(OPENING_NOTE_LEN_MARKER)
            .and_then(|(_, rest)| rest.split_once(" characters:"))
            .and_then(|(count, _)| count.trim().parse::<usize>().ok())
        else {
            return Framed::Unreadable;
        };
        return note_tail(body, chars);
    }
    Framed::Bare
}

/// The last `chars` characters of `body`, which is where every frame puts the
/// note: the host states the length and appends the text with no separator.
fn note_tail(body: &str, chars: usize) -> Framed<'_> {
    let total = body.chars().count();
    let Some(skip) = total.checked_sub(chars) else {
        return Framed::Unreadable;
    };
    match body.char_indices().nth(skip) {
        Some((at, _)) => Framed::Note(&body[at..]),
        // The stated length is the whole message, which cannot be true of a
        // framed one. An EMPTY note reaches here too (`chars` 0, `skip` total),
        // and answering `Unreadable` for it is right: there is no body to anchor
        // in, which is the state `append_to_note` exists for.
        None => Framed::Unreadable,
    }
}

/// The id of the note the model has in hand, from EITHER frame.
///
/// The assistant's own `read_note` action is preferred, so the edit and the read
/// cannot name different notes. The opening message is the fallback, because on
/// the turn it arrives there is no assistant turn at all.
fn note_id_in_hand<'a>(last_assistant: &'a str, last_user: &'a str) -> Option<&'a str> {
    if let Some(id) = last_assistant
        .split("\"note_id\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
    {
        return Some(id);
    }
    last_user
        .strip_prefix(OPENING_NOTE_OPENER)
        .and_then(|rest| rest.split_once(OPENING_NOTE_ID_TAIL))
        .map(|(id, _)| id)
}

/// Body lines that occur EXACTLY ONCE in the whole note, frontmatter skipped.
///
/// Both halves were learned from a failing test, and both are the rule `place`
/// enforces rather than stub convenience: "first non-empty line" picks `---`,
/// which appears twice and refuses with `AnchorAmbiguous`; adding only the
/// occurs-once rule then picks `title: <name>`, so the stub would rewrite a
/// MANAGED frontmatter field (`markdown-dialect.md` §3.6.1) instead of the body.
///
/// Shared by the trash branch and by step 3 below, because the two producing
/// different anchors from the same note is a difference nothing would report.
#[cfg_attr(not(feature = "local-inference-stub"), allow(dead_code))]
fn unique_body_lines(body: &str) -> std::vec::IntoIter<&str> {
    // **The note does not start at offset zero any more** (myne-md/myne#596).
    // `read_note`'s answer is host prose then the body (myne-md/myne#574), and
    // `chat_shape` concatenates a message's spans with NO separator, so the
    // note's opening `---` is glued to the end of that sentence.
    // `strip_prefix("---\n")` therefore matched nothing, the frontmatter was
    // never skipped, and the first "unique line" this yielded was the host's
    // own sentence with `---` stuck to it: an anchor that occurs nowhere in the
    // note, so every proposed edit was refused at apply time.
    //
    // **The boundary is MEASURED, not guessed at.** Two guesses were tried and
    // both were wrong in their own direction. Requiring the fence at offset
    // zero missed it entirely. Locating the fence anywhere reads a note with no
    // frontmatter as all frame (a supported state:
    // `core/src/plugins/agent/tools.rs` takes the frontmatter slice as an
    // `Option`), and it cuts at the wrong `---` in a note whose body has
    // thematic breaks.
    //
    // The host publishes the answer. `read_note`'s sentence states the note's
    // length in characters and says the text follows, so the note is exactly
    // the last N characters of the message. Reading that is not a guess, and it
    // is right for a note with no frontmatter, a note with thematic breaks, and
    // a note whose body happens to contain the word the frame starts with.
    //
    // Framed but unreadable answers NOTHING rather than falling back, which is
    // the discipline `first_note_id` above follows: a reworded frame fails at
    // the gate instead of offering the host's own sentence as an anchor, which
    // is the defect this whole hunk exists to close. A message with no frame at
    // all is a unit-test fixture passing a bare body, and is used as-is.
    let note = match note_after_frame(body) {
        Framed::Note(note) => note,
        Framed::Unreadable => return Vec::new().into_iter(),
        Framed::Bare => body,
    };
    let after_frontmatter = note
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n"))
        .map(|(_, rest)| rest)
        .unwrap_or(note);
    after_frontmatter
        .lines()
        .map(str::trim_end)
        // Uniqueness is asked of the NOTE, not of the framed message: a line
        // the host's prose happens to repeat is still unique in the note, and
        // `place` grades the anchor against the note.
        .filter(|l| !l.is_empty() && note.matches(*l).count() == 1)
        .collect::<Vec<_>>()
        .into_iter()
}

/// A deterministic action script for an agent-loop request, or `None` when the
/// request is not one.
///
/// **Takes the STRUCTURE, not a rendered prompt.** The first version parsed a
/// flat string for `<|im_start|>user` markers, which worked only because the
/// agent adapter was flattening its request and calling `infer`. Fixing that
/// (the adapter now uses the role-structured surface, so the app's own
/// instruction reaches the system slot instead of sitting in a user turn beside
/// note text) would have silently broken this: the default `chat_streaming`
/// renders `User: ` / `Assistant: ` prefixes and no ChatML markers at all, so
/// every rsplit here would have matched nothing and the anchor would have come
/// out of the wrong part of the transcript. Reading `(system, messages)` is
/// what the real engines get, so the stub cannot drift from them by shape.
///
/// **The plain echo cannot drive an agent run**, which is why any of this
/// exists: the agent's system instructions list all seven actions as literal
/// JSON lines so a model can copy the shape, so echoing them back parses as all
/// seven at once, ending at `finish` with an empty proposal. Three scenarios
/// asserted a non-empty proposal and could never have passed.
///
/// The script, driven by the transcript so it stays a pure function:
///
/// 1. nothing said yet, so ask what is in scope;
/// 2. a scope listing arrived, so read its first note;
/// 3. a body arrived, so propose one anchored edit per eligible line and finish.
#[cfg_attr(not(feature = "local-inference-stub"), allow(dead_code))]
fn agent_script(system: &str, messages: &[ChatMessage]) -> Option<String> {
    if !system.contains(AGENT_INSTRUCTIONS_OPENER) {
        return None;
    }
    // **The probe comes through here too, and it is not a run.** `probe_request`
    // uses the same system instructions, so without this branch the script
    // answered the probe with `list_scope`, the probe graded that `WrongAction`,
    // every attempt failed and the composer refused to offer agent mode at all.
    // Every agent E2E scenario went red on a Send button that never enabled.
    //
    // That is the capability gate WORKING: it is supposed to refuse a backend
    // that cannot produce one anchored edit on demand. The stub has to be able
    // to, or it is modelling a model Myne would decline.
    //
    // Answered by READING the request rather than by echoing a memorised
    // constant: the target and replacement are quoted in the prompt, so the stub
    // replies to what it was asked. A probe reworded past this parse fails
    // loudly, at the gate, rather than passing on a stale answer.
    if let Some(reply) = probe_answer(last_user_of(messages)) {
        return Some(reply);
    }

    let last_assistant = messages
        .iter()
        .rev()
        .find(|m| m.role == ChatRole::Assistant)
        .map(|m| m.content.as_str())
        .unwrap_or("");
    let last_user = last_user_of(messages);

    // **Two task-keyed branches, so `ag3` and `ag5` exercise something.**
    // Both scenarios returned early with a `console.warn` when the stub did not
    // produce their condition, and the stub never did: the script emitted only
    // `list_scope`, `read_note`, `propose_edit` and `finish`. They passed green
    // while testing nothing, permanently, and one of them covers the trash
    // carve-out, which is the single control `0515` and `threat-model.md` §7
    // call structural rather than behavioural. The scenario comment said the
    // engine's script was not the suite's to set; the stub lives in this repo
    // and this branch already scripts it, so that was not true either.
    //
    // Keyed off the task text rather than off a flag, so the scenario asks for
    // what it needs in the same sentence a user would type, and a scenario that
    // stops asking stops getting it.
    let task = messages
        .iter()
        .find(|m| m.role == ChatRole::User)
        .map(|m| m.content.as_str())
        .unwrap_or("");

    // A memory write, asked once (myne-md/myne#697, `memory.e2e.ts`). Keyed
    // off the task text like the task-keyed branches below, so the scenario
    // asks for what it needs in the sentence a user would type. Fires on the
    // FIRST turn only (no `remember` in the transcript yet): the loop's
    // one-write-per-run counter would refuse a second, and re-emitting it
    // would turn the scenario's settle wait into a refusal transcript. The
    // `finish` rides the same reply because a remember-only run proposes no
    // edits: without it the run would idle for another provider round-trip
    // before settling, and the marker wait would measure patience rather
    // than the write.
    if task.contains("remember this")
        && !messages
            .iter()
            .any(|m| m.content.contains("\"action\":\"remember\""))
    {
        return Some(
            "{\"action\":\"remember\",\"text\":\"The user prefers terse answers.\"}\n\
             {\"action\":\"finish\",\"summary\":\"stub remember run\"}}"
                .to_string(),
        );
    }

    // **What the model has in hand, from EITHER frame the host uses.**
    //
    // The branches below used to key on `last_assistant` naming a `read_note`,
    // which was the only way a body could arrive before myne-md/myne#578 made
    // the loop pre-answer both tools for a single-note scope. Keying on the
    // ANSWER rather than on the question is what lets the script propose on the
    // turn the body actually arrives, instead of asking for a re-read the host
    // refuses. `note_after_frame` carries the full account of that failure.
    let note_in_hand: Option<&str> = match note_after_frame(last_user) {
        Framed::Note(note) => Some(note),
        // A bare message is a unit-test fixture passing a body directly, and it
        // is a body only when the assistant asked for one.
        Framed::Bare if last_assistant.contains("\"action\":\"read_note\"") => Some(last_user),
        Framed::Bare | Framed::Unreadable => None,
    };

    // A scope expansion, asked once: as soon as the host has said what is in
    // scope, and before any edit is proposed.
    //
    // **The trigger is the ANSWER, not the question.** This used to require the
    // previous assistant turn to have asked `list_scope`, which stopped being
    // reachable the moment the script learned to propose straight from the
    // opening message: a single-note scope pre-answers `list_scope`
    // (myne-md/myne#578), so the stub no longer asks it and `ag5` went from
    // `dialog` to `settled` with the expansion path never entered. The host
    // having answered is what this branch actually depends on, and the guard
    // below is still what keeps it to exactly one request per run.
    if task.contains("other folders")
        && last_user != task
        && !messages
            .iter()
            .any(|m| m.content.contains("\"action\":\"request_scope\""))
    {
        return Some(
            "{\"action\":\"request_scope\",\"folder\":\"Projects\",\
             \"reason\":\"the task mentions other folders\"}"
                .to_string(),
        );
    }

    // A trashing edit, and an ORDINARY one beside it.
    //
    // The pair is the whole point. The carve-out under review is "the bulk
    // approve carries the rest and leaves the trashing edit alone", and a
    // proposal holding only the trashing edit cannot show the "rest" half:
    // `approveAll` sends an empty list, the apply returns early on it, and no
    // report renders. The scenario then times out on a report that was never
    // going to appear, which reads as a product defect and is a harness one.
    if task.contains("trash this") && note_in_hand.is_some() {
        let id = note_id_in_hand(last_assistant, last_user)?;
        let body = note_in_hand?;
        // The frontmatter's own title line is the anchor for the trashing edit,
        // because appending a `trashed:` line after it is what trashing a note
        // actually looks like at the byte level (`markdown-dialect.md` §3.6.1).
        let title_line = body
            .lines()
            .map(str::trim_end)
            .find(|l| l.starts_with("title:") && body.matches(*l).count() == 1)?;
        // The ordinary one anchors in the BODY, under the same occurs-exactly-
        // once rule `place` enforces.
        let plain = unique_body_lines(body).next()?;
        return Some(format!(
            "{{\"action\":\"propose_edit\",\"note_id\":\"{id}\",\"anchor\":\"{plain}\",\
             \"replacement\":\"{plain} (edited by the stub)\"}}\n\
             {{\"action\":\"propose_edit\",\"note_id\":\"{id}\",\"anchor\":\"{title_line}\",\
             \"replacement\":\"{title_line}\\ntrashed: 2026-08-16T12:00:00Z\"}}\n\
             {{\"action\":\"finish\",\"summary\":\"stub trash run\"}}"
        ));
    }

    // An append, which is the only verb that can write into an EMPTY note.
    //
    // **Checked before the general read_note branch, and it has to be.** That
    // branch derives its anchors from the body with `unique_body_lines`, so on a
    // note with no body it finds none and returns `None`: the stub falls silent
    // and the scenario times out on a review screen that was never coming. An
    // append needs nothing from the body, which is the property under test.
    //
    // Keyed off the task text like its two siblings above, so the scenario asks
    // for what it needs in the sentence a user would type.
    if task.contains("append") {
        // No `note_in_hand` guard, deliberately: an EMPTY note frames as
        // `Unreadable` (a stated length of zero), and writing into one is the
        // whole of what this verb is for. The id is the only thing it needs, so
        // an id from either frame is enough and a turn without one falls
        // through to the steps below rather than answering.
        let id = note_id_in_hand(last_assistant, last_user)?;
        return Some(format!(
            "{{\"action\":\"append_to_note\",\"note_id\":\"{id}\",\
             \"text\":\"appended by the stub\"}}\n\
             {{\"action\":\"finish\",\"summary\":\"stub append run\"}}"
        ));
    }

    // Step 3: a note body is in this user turn, whether the previous turn asked
    // for it or the host opened with it. Checked before step 2 so each check
    // stays a simple containment.
    if let Some(body) = note_in_hand {
        // The id the previous turn named where there is one, rather than
        // re-derived, so the edit and the read cannot name different notes.
        let id = note_id_in_hand(last_assistant, last_user)?;
        // Up to TWO edits, one per eligible line. Not richness for its own
        // sake: "reject one, approve the rest" is a real user path and an
        // acceptance criterion, and with a single proposed edit rejecting it
        // leaves nothing to apply, so the apply returns early and no report
        // renders. `ag1` failed exactly that way.
        let anchors: Vec<&str> = unique_body_lines(body).take(2).collect();
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
    //
    // **The listing is no longer the whole message, and taking its first line
    // silently produced a wrong id for months** (myne-md/myne#596).
    // myne-md/myne#574 framed every tool result as host prose FIRST and payload
    // after, so the first non-empty line became
    // `list_scope returned the 1 note(s) in your scope, ...` and this read
    // `list_scope` as a note id. Nothing refused loudly: the loop answered "that
    // note is not in your scope", the stub produced the same wrong id on the
    // next turn, three barren iterations ended the run `stalled` with an empty
    // proposal, and an empty proposal opens no review screen (myne-md/myne#568)
    // so all six scenarios in `agent-run.e2e.ts` timed out waiting for
    // `agentReview.screen`, every run.
    //
    // So it looks for the first thing anywhere in the message that PARSES as a
    // note id, rather than trusting a position, and returns `None` when it
    // finds none. `None` is the loud failure this arm lacked: the stub then
    // answers nothing for a shape it does not understand, instead of
    // confidently naming a note that does not exist. `first_note_id` states why
    // the scan is positional rather than per line or per whitespace token.
    if last_assistant.contains("\"action\":\"list_scope\"") {
        let id = first_note_id(last_user)?;
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
        // Echo, not a model. The marker lets a test assert the value came
        // through the trait against the stub (not a real completion).
        //
        // The agent does NOT come through here: it uses the role-structured
        // surface, so its script lives in this type's `chat_streaming` below.
        // Intercepting an agent-shaped prompt here as well would be a branch
        // nothing reaches, which is the kind of code that outlives its reason.
        Ok(format!("stub-infer: {prompt}"))
    }

    /// The role-structured surface, which is what the agent uses.
    ///
    /// Implemented rather than inherited: the trait default flattens
    /// `(system, messages)` into one `User: ` / `Assistant: ` string and calls
    /// `infer`, which would throw away exactly the structure an agent script has
    /// to read, and would also make this stub a worse model of the two real
    /// arms than it needs to be. A non-agent caller falls through to that
    /// default's behaviour, so the chat scenarios keep asserting the echo.
    fn chat_streaming(
        &self,
        system: &str,
        messages: &[ChatMessage],
        on_token: &mut dyn FnMut(&str) -> ControlFlow<()>,
    ) -> Result<String, EngineError> {
        if let Some(e) = self.fault() {
            return Err(e);
        }
        if let Some(script) = agent_script(system, messages) {
            let _ = on_token(&script);
            return Ok(script);
        }
        let prompt = flatten_chat_to_prompt(system, messages);
        self.infer_streaming(&prompt, on_token)
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
    //!
    //! They drive `chat_streaming`, which is the surface the agent adapter
    //! actually calls, rather than the helper underneath it. An earlier version
    //! tested a flat-prompt helper, and it would have kept passing after the
    //! adapter moved to the role-structured surface while the stub answered
    //! nothing usable.

    use super::*;
    use crate::plugins::agent::prompt::{parse_actions, system_instructions, AgentAction};

    fn turn(role: ChatRole, content: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: content.to_string(),
        }
    }

    /// Ask the stub the way the agent adapter does.
    fn ask(messages: &[ChatMessage]) -> String {
        let mut sink = |_: &str| ControlFlow::Continue(());
        StubEngine
            .chat_streaming(&system_instructions(None), messages, &mut sink)
            .expect("the stub answers")
    }

    /// The regression that motivated the whole module: echoing the prompt back
    /// parses as EVERY example action, ending at `finish`, so a run that used
    /// the echo produced an empty proposal on iteration one.
    /// The stub must PASS the capability probe, driven through the real
    /// `run_probe` and the real grader.
    ///
    /// This is the test the composer's gate made necessary and its absence made
    /// expensive: wiring `agentCapability()` into the composer (which is what
    /// makes the anchored format's right to refuse a near-miss mean anything)
    /// disabled Send until the probe passes, and the stub answered the probe
    /// with `list_scope` because `probe_request` carries the same system
    /// instructions a run does. Every agent E2E scenario went red on a button
    /// that never enabled, one container build later.
    ///
    /// Asserted through `run_probe` rather than by inspecting the reply, because
    /// the reply being well-formed is not the claim. The claim is that the
    /// grader accepts it.
    #[test]
    fn the_stub_passes_the_capability_probe_it_is_asked() {
        use crate::plugins::agent::engine::{
            AgentCompletion, AgentEngine, AgentRequest, AgentRequestClass,
        };
        use crate::plugins::agent::error::AgentError;
        use crate::plugins::agent::probe::{run_probe, AttemptVerdict, ProbeThreshold};

        /// The stub behind the agent seam, mapped by the REAL `chat_shape` the
        /// desktop adapter uses. A second mapping written here would let this
        /// test pass while the shipped one was wrong, which is the whole shape
        /// this suite exists to catch.
        struct StubBehindTheSeam;
        #[async_trait::async_trait]
        impl AgentEngine for StubBehindTheSeam {
            async fn complete(
                &self,
                _class: AgentRequestClass,
                request: &AgentRequest,
            ) -> Result<AgentCompletion, AgentError> {
                let (system, messages) =
                    crate::inference::agent_adapter::chat_shape(request, &|s: &str| s.to_string());
                let mut sink = |_: &str| ControlFlow::Continue(());
                let reply = StubEngine
                    .chat_streaming(&system, &messages, &mut sink)
                    .map_err(|_| AgentError::ReadFailed)?;
                Ok(AgentCompletion {
                    truncated: false,
                    reply,
                    chars_off_device: None,
                })
            }
        }

        let verdict = crate::test_support::block_on(run_probe(
            &StubBehindTheSeam,
            ProbeThreshold {
                attempts: 3,
                required: 2,
                provisional: false,
            },
            // This test is about the stub clearing the bar, not about progress.
            &|_| {},
        ))
        .expect("the probe runs");
        assert!(
            verdict.passed,
            "the stub must be a backend Myne would offer agent mode on: {verdict:?}"
        );
        // **Every attempt that RAN was clean**, which is what this was always
        // about; it used to say `passes == 3` and the number was a coincidence
        // of the probe running every attempt regardless. Since the early exit
        // (myne-md/myne#575) the bar of 2 settles it at 2, so asserting 3 would
        // be asserting that the saving does not happen.
        assert!(
            verdict
                .attempts
                .iter()
                .all(|a| *a == AttemptVerdict::Passed),
            "the stub must not miss a single attempt it was asked: {verdict:?}"
        );
        assert_eq!(verdict.passes as usize, verdict.attempts.len());
    }

    /// The host frames every tool result with prose BEFORE the payload
    /// (myne-md/myne#574), so the listing does not start at line one.
    ///
    /// Both directions, because the defect this replaces was silent in exactly
    /// one of them: the old code took the first line's first token, which after
    /// that change is the word `list_scope`, and emitted it as a note id. The
    /// loop refused it, the stub produced the same wrong id on the next turn,
    /// and the run ended `stalled` with an empty proposal, which opens no
    /// review screen, so all six `agent-run.e2e.ts` scenarios timed out on
    /// `agentReview.screen` for months (myne-md/myne#596). Nothing was red: the
    /// suite is manual and pre-release since myne-md/myne#579.
    #[test]
    fn the_note_id_is_found_past_the_hosts_framing() {
        // **The real wire shape, and note the missing separator.** `chat_shape`
        // concatenates a message's spans with nothing between them, so the
        // payload's first id is GLUED to the end of the prose sentence. A
        // fixture that puts a `\n` there is a fixture describing a wire that
        // does not exist. The first version of this test did exactly that,
        // passed, and left the suite failing on the single-note scope, which is
        // the ordinary case.
        let framed = "list_scope returned the 2 note(s) in your scope, one per line as \
                      `<note_id> <title>`. Read one with read_note, or finish if you \
                      already have what you need.\
                      01a047c1-1acd-7ba1-bc49-1e168836411c Shopping list\n\
                      01a047c1-b6ce-7c42-be02-e87e303cff2d Reading list";
        assert_eq!(
            first_note_id(framed),
            Some("01a047c1-1acd-7ba1-bc49-1e168836411c"),
        );
        // **The rejection cases are what earn their place here**, and two
        // `assert_ne!`s against `"list_scope"` and the prose's own
        // `` `<note_id>`` placeholder used to sit above them. Both were already
        // implied by the equality assertion three lines up, so they proved
        // nothing the first assertion had not. A test may not claim more
        // coverage than its inputs give it.
        //
        // A framed message whose payload holds no id answers `None` rather than
        // something confident, which is what makes the stub fail loudly on a
        // shape it does not understand.
        assert_eq!(
            first_note_id(
                "list_scope returned the 0 note(s) in your scope, one per line as \
                 `<note_id> <title>`."
            ),
            None,
        );
        assert_eq!(
            first_note_id("no identifiers in this sentence at all"),
            None
        );
        // A hex-only token of the wrong length is not an id, so a stray hash in
        // a title cannot be mistaken for one.
        assert_eq!(first_note_id("deadbeef a title"), None);
        // Nor is a PREFIX of a longer hex run. The hand-rolled shape check this
        // replaced had no right boundary and answered with a truncated
        // 36-character slice of the run.
        assert_eq!(
            first_note_id("01a047c1-1acd-7ba1-bc49-1e168836411cffff a title"),
            None,
        );
    }

    /// The body arrives glued to `read_note`'s sentence too, so the anchor the
    /// stub picks has to come from the NOTE and not from the frame.
    ///
    /// Without this, `unique_body_lines` failed its `strip_prefix("---\n")`,
    /// never skipped the frontmatter, and offered the host's own sentence as an
    /// anchor, which occurs nowhere in the note, so every edit it proposed was
    /// refused at apply time and the scenarios' "the note changed" assertions
    /// could not pass.
    #[test]
    fn the_anchor_comes_from_the_note_not_from_the_framing() {
        // The stated length is COMPUTED, never written by hand. The host writes
        // `chars().count()` of the note, and a hand-typed number puts the
        // boundary mid-word: the first draft of this fixture said 42 and the
        // first anchor came back as `"te"`, the tail of `title: My note`.
        let note = "---\ntitle: My note\n---\nalpha beta gamma\ndelta epsilon zeta";
        let framed = format!(
            "read_note returned the body of that note, {} characters, and it follows. \
             Propose an edit whose anchor is copied exactly from it, or finish and say \
             what you found.{note}",
            note.chars().count(),
        );
        let anchors: Vec<&str> = unique_body_lines(&framed).collect();
        assert_eq!(anchors, vec!["alpha beta gamma", "delta epsilon zeta"]);
        // The frame must not be offered as an anchor, and neither must the
        // managed frontmatter field.
        assert!(
            !anchors.iter().any(|a| a.contains("read_note returned")),
            "the host's sentence is not in the note: {anchors:?}",
        );
        assert!(
            !anchors.iter().any(|a| a.starts_with("title:")),
            "a managed frontmatter field is not an anchor: {anchors:?}",
        );

        // **A note with NO frontmatter still works**, because the boundary is
        // the length the host states rather than a `---` somewhere in the text.
        // A frontmatter-less note is a supported state, and an earlier fix that
        // located the fence read one of them as all frame.
        let note = "alpha beta gamma\ndelta epsilon zeta";
        let no_frontmatter = format!(
            "read_note returned the body of that note, {} characters, and it follows. \
             Propose an edit whose anchor is copied exactly from it, or finish and say \
             what you found.{note}",
            note.chars().count(),
        );
        assert_eq!(
            unique_body_lines(&no_frontmatter).collect::<Vec<_>>(),
            vec!["alpha beta gamma", "delta epsilon zeta"],
        );

        // **A note whose BODY carries thematic breaks.** The fence-locating
        // version cut at the first `---` it saw, which is a rule in the body,
        // and silently dropped everything before and between them.
        let ruled = "intro line\n---\nbody after rule\n---\ntail line";
        let framed_ruled = format!(
            "read_note returned the body of that note, {} characters, and it follows. \
             Propose an edit whose anchor is copied exactly from it, or finish and say \
             what you found.{ruled}",
            ruled.chars().count(),
        );
        assert_eq!(
            unique_body_lines(&framed_ruled).collect::<Vec<_>>(),
            vec!["intro line", "body after rule", "tail line"],
            "a thematic break is not frontmatter",
        );

        // **A frame whose length cannot be read yields nothing, loudly.** The
        // alternative is falling back to the whole message, which is how the
        // host's own sentence became an anchor in the first place.
        assert_eq!(
            unique_body_lines(
                "read_note returned the body of that note, some characters, and it \
                 follows.alpha beta gamma"
            )
            .collect::<Vec<_>>(),
            Vec::<&str>::new(),
        );
    }

    /// The same fact one layer up: the SCRIPT, given a framed listing, asks to
    /// read the note the listing named.
    ///
    /// `first_note_id`'s own test could pass while step 2 called something else,
    /// so this drives `agent_script` with the message shape the loop actually
    /// produces and asserts on the id in the reply.
    #[test]
    fn the_script_reads_the_note_the_framed_listing_named() {
        let id = "01a047c1-1acd-7ba1-bc49-1e168836411c";
        let messages = vec![
            ChatMessage {
                role: ChatRole::User,
                content: "tidy this note".to_string(),
            },
            ChatMessage {
                role: ChatRole::Assistant,
                content: "{\"action\":\"list_scope\"}".to_string(),
            },
            ChatMessage {
                role: ChatRole::User,
                // No separator before the id: `chat_shape` concatenates spans
                // raw, and a single-note scope is the case a per-line scan
                // could never answer.
                content: format!(
                    "list_scope returned the 1 note(s) in your scope, one per line as \
                     `<note_id> <title>`. Read one with read_note, or finish if you \
                     already have what you need.{id} Shopping list"
                ),
            },
        ];
        let reply = agent_script(AGENT_INSTRUCTIONS_OPENER, &messages)
            .expect("the script answers a framed listing");
        assert!(reply.contains("\"action\":\"read_note\""), "{reply}");
        assert!(
            reply.contains(id),
            "the reply must name the listed note: {reply}"
        );
        assert!(
            !reply.contains("\"note_id\":\"list_scope\""),
            "the framing's first word must never be sent as a note id: {reply}",
        );
    }

    #[test]
    fn a_reworded_probe_is_not_answered_from_memory() {
        // The answer is READ out of the prompt. A probe this parse no longer
        // understands must fail at the gate rather than pass on a stale reply.
        assert!(probe_answer("nothing like the probe").is_none());
    }

    #[test]
    fn the_plain_echo_could_never_have_driven_a_run() {
        let echo = format!("stub-infer: {}", system_instructions(None));
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
    fn a_non_agent_chat_still_gets_the_echo() {
        // The chat scenarios assert the marker, so routing must not capture
        // them. Driven through `chat_streaming` because that is where the
        // agent branch now lives and therefore where it could over-reach.
        let mut sink = |_: &str| ControlFlow::Continue(());
        let out = StubEngine
            .chat_streaming(
                "You are a helpful assistant.",
                &[turn(ChatRole::User, "summarise this")],
                &mut sink,
            )
            .unwrap();
        assert!(out.contains("stub-infer: "), "got: {out}");
    }

    #[test]
    fn infer_is_a_pure_echo_again() {
        // The agent no longer reaches `infer`, so it carries no agent branch.
        let out = StubEngine.infer(&system_instructions(None)).unwrap();
        assert!(out.starts_with("stub-infer: "), "got: {}", &out[..40]);
    }

    /// The two task-keyed branches `ag3` and `ag5` depend on, asserted here so a
    /// failure names the branch rather than arriving as a container timeout
    /// forty minutes later.
    #[test]
    fn a_task_naming_other_folders_requests_a_scope_expansion() {
        let reply = ask(&[
            turn(ChatRole::User, "look in my other folders too"),
            turn(ChatRole::Assistant, r#"{"action":"list_scope"}"#),
            turn(ChatRole::User, "note-aaa My note"),
        ]);
        let actions = parse_actions(&reply);
        assert_eq!(actions.len(), 1, "got {actions:?}");
        match &actions[0] {
            AgentAction::RequestScope { folder, reason } => {
                assert!(!folder.is_empty());
                assert!(!reason.is_empty());
            }
            other => panic!("expected a scope request, got {other:?}"),
        }
    }

    /// The `remember this` branch `memory.e2e.ts` depends on, asserted here
    /// so a failure names the branch rather than arriving as a container
    /// timeout forty minutes later.
    #[test]
    fn a_task_asking_to_remember_writes_memory_then_finishes() {
        let reply = ask(&[turn(ChatRole::User, "please remember this for later")]);
        let actions = parse_actions(&reply);
        assert_eq!(actions.len(), 2, "got {actions:?}");
        match &actions[0] {
            AgentAction::Remember { text, .. } => {
                assert!(!text.is_empty());
            }
            other => panic!("expected a remember, got {other:?}"),
        }
        assert!(
            matches!(actions[1], AgentAction::Finish { .. }),
            "got {actions:?}"
        );
    }

    /// The one-write-per-run shape: a transcript that already holds a
    /// `remember` must not get a second one from the stub.
    #[test]
    fn a_second_remember_is_not_re_emitted() {
        let reply = ask(&[
            turn(ChatRole::User, "please remember this for later"),
            turn(
                ChatRole::Assistant,
                r#"{"action":"remember","text":"The user prefers terse answers."}"#,
            ),
            turn(ChatRole::User, "remember saved memory entry [abc123]"),
        ]);
        assert!(
            !reply.contains("\"action\":\"remember\""),
            "the stub must not re-emit remember, got: {reply}"
        );
    }

    #[test]
    fn a_task_naming_trash_proposes_an_edit_that_writes_the_marker() {
        let body = "---\ntitle: My note\n---\n\nalpha beta gamma\n";
        let reply = ask(&[
            turn(ChatRole::User, "trash this note"),
            turn(ChatRole::Assistant, r#"{"action":"list_scope"}"#),
            turn(ChatRole::User, "note-aaa My note"),
            turn(
                ChatRole::Assistant,
                r#"{"action":"read_note","note_id":"note-aaa"}"#,
            ),
            turn(ChatRole::User, body),
        ]);
        let actions = parse_actions(&reply);
        // **BOTH halves, and the pair is the point.** The scenario this feeds
        // asserts that a bulk approve carries the ordinary edits and leaves the
        // trashing one alone, so a proposal holding only the trashing edit
        // cannot show the "carries" half at all: the bulk action sends an empty
        // list, the apply returns early on it, and no report renders.
        let mut trashing = 0;
        let mut ordinary = 0;
        for action in &actions {
            let AgentAction::ProposeEdit {
                anchor,
                replacement,
                ..
            } = action
            else {
                continue;
            };
            // Checked through the real placer and the real detector rather than
            // by reading the string, so the claim is about what applying the
            // edit DOES.
            let placed = crate::plugins::agent::edit::place(body, anchor, replacement)
                .expect("the anchor must place");
            if crate::plugins::agent::hide::edit_hides_note(body, &placed) {
                trashing += 1;
            } else {
                ordinary += 1;
            }
        }
        assert_eq!(
            trashing, 1,
            "exactly one edit the carve-out refuses: {actions:?}"
        );
        assert_eq!(
            ordinary, 1,
            "and exactly one the bulk approve carries: {actions:?}"
        );
    }

    #[test]
    fn step_one_asks_what_is_in_scope() {
        let actions = parse_actions(&ask(&[turn(ChatRole::User, "tidy this")]));
        assert_eq!(actions.len(), 1, "one action per step: {actions:?}");
        assert!(matches!(actions[0], AgentAction::ListScope));
    }

    /// **The fixture is the framed listing the host really sends, and that is
    /// the point of this edit** (myne-md/myne#596). It used to be
    /// `"note-aaa My note\nnote-bbb Another"`, a bare payload with invented
    /// ids, which is a shape `list_scope` stopped producing when
    /// myne-md/myne#574 put host prose in front of every tool result. So the
    /// test modelled a world two changes old, passed, and left step 2 sending
    /// the word `list_scope` as a note id in the world that exists. Real ids are
    /// the note store's hyphenated UUIDs; using one here is what makes the
    /// assertion mean something.
    #[test]
    fn step_two_reads_the_first_note_the_listing_named() {
        let first = "01a047c1-1acd-7ba1-bc49-1e168836411c";
        let reply = ask(&[
            turn(ChatRole::User, "tidy this"),
            turn(ChatRole::Assistant, r#"{"action":"list_scope"}"#),
            turn(
                ChatRole::User,
                &format!(
                    "list_scope returned the 2 note(s) in your scope, one per line as \
                     `<note_id> <title>`. Read one with read_note, or finish if you \
                     already have what you need.\
                     {first} My note\n\
                     01a047c1-b6ce-7c42-be02-e87e303cff2d Another"
                ),
            ),
        ]);
        let actions = parse_actions(&reply);
        assert_eq!(actions.len(), 1);
        match &actions[0] {
            AgentAction::ReadNote { note_id } => assert_eq!(note_id, first),
            other => panic!("expected a read, got {other:?}"),
        }
    }

    fn after_read(body: &str) -> Vec<AgentAction> {
        parse_actions(&ask(&[
            turn(ChatRole::User, "tidy this"),
            turn(ChatRole::Assistant, r#"{"action":"list_scope"}"#),
            turn(ChatRole::User, "note-aaa My note"),
            turn(
                ChatRole::Assistant,
                r#"{"action":"read_note","note_id":"note-aaa"}"#,
            ),
            turn(ChatRole::User, body),
        ]))
    }

    #[test]
    fn step_three_proposes_an_anchor_that_is_really_in_the_body() {
        let body = "alpha beta gamma delta\n\nsecond line";
        let actions = after_read(body);
        assert!(
            matches!(actions.last(), Some(AgentAction::Finish { .. })),
            "the script must end by finishing: {actions:?}"
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
        assert!(
            body.contains(anchor.as_str()),
            "anchor {anchor:?} not in body"
        );
        assert_eq!(body.matches(anchor.as_str()).count(), 1, "must place once");
        assert_ne!(anchor, replacement, "an edit has to change something");
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
        let actions = after_read(body);
        let AgentAction::ProposeEdit {
            anchor,
            replacement,
            ..
        } = &actions[0]
        else {
            panic!("expected an edit");
        };
        assert_ne!(anchor, "---", "the frontmatter fence occurs twice");
        assert_eq!(
            body.matches(anchor.as_str()).count(),
            1,
            "anchor {anchor:?} must place exactly once"
        );
        let placed = crate::plugins::agent::edit::place(body, anchor, replacement)
            .expect("the stub's anchor must place in a frontmattered note");
        assert_ne!(placed, body);
        // And the frontmatter is intact, so the edit is a body edit rather than
        // something that rewrote the note's managed fields. This assertion is
        // the one that caught the second wrong version; checking that the
        // anchor placed was not enough.
        assert!(placed.starts_with("---\ntitle: My note\n---\n"));
    }

    /// The premise `ag1` rests on: "reject one, approve the rest" needs at least
    /// two proposed edits, and with one the rejection leaves nothing to apply,
    /// so the apply returns early and no report ever renders. That is exactly
    /// how the scenario failed on its first real run.
    #[test]
    fn two_eligible_lines_yield_two_edits_so_rejecting_one_leaves_work() {
        let body = "---\ntitle: My note\n---\n\nalpha beta gamma\nepsilon zeta eta\n";
        let actions = after_read(body);
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
            crate::plugins::agent::edit::place(body, anchor, replacement)
                .unwrap_or_else(|e| panic!("anchor {anchor:?} must place: {e:?}"));
        }
    }

    /// The same premise as the test above, over the message shape `ag1` actually
    /// produces: FRAMED by `read_note`'s prose and carrying frontmatter.
    ///
    /// The test above passes a BARE body, which `note_after_frame` classifies as
    /// `Framed::Bare` and uses as-is, so it exercises neither the length-derived
    /// note boundary nor the frontmatter skip. `the_anchor_comes_from_the_note_
    /// not_from_the_framing` drives the framed path but asks only for the anchor
    /// LIST; nothing asked the framed path for two PROPOSED EDITS that both
    /// place, which is the one property `ag1` rests on.
    ///
    /// The frame is built the way `run_loop.rs` builds it: prose then body, no
    /// separator, because `chat_shape` concatenates a message's spans.
    #[test]
    fn a_framed_frontmattered_two_line_note_still_yields_two_placing_edits() {
        let note = "---\ntitle: ag1note\n---\nalpha beta gamma delta\nepsilon zeta eta theta";
        let framed = format!(
            "read_note returned the body of that note, {} characters, and it follows. \
             Propose an edit whose anchor is copied exactly from it, or finish and say \
             what you found.{note}",
            note.chars().count(),
        );
        let actions = parse_actions(&ask(&[
            turn(ChatRole::User, "tidy this note"),
            turn(ChatRole::Assistant, r#"{"action":"list_scope"}"#),
            turn(ChatRole::User, "note-aaa ag1note"),
            turn(
                ChatRole::Assistant,
                r#"{"action":"read_note","note_id":"note-aaa"}"#,
            ),
            turn(ChatRole::User, &framed),
        ]));
        let edits: Vec<&AgentAction> = actions
            .iter()
            .filter(|a| matches!(a, AgentAction::ProposeEdit { .. }))
            .collect();
        assert_eq!(edits.len(), 2, "got {actions:?}");
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
            crate::plugins::agent::edit::place(note, anchor, replacement)
                .unwrap_or_else(|e| panic!("anchor {anchor:?} must place: {e:?}"));
        }
    }

    /// The OPENING message carries the body for a single-note scope, so the
    /// script must propose on the FIRST turn, with no assistant turn behind it.
    ///
    /// This is the shape `ag1`, `ag3` and `ag4` actually run in
    /// (myne-md/myne#578), and nothing here drove it: every other test in this
    /// module hands the body over after an assistant `read_note`. Walking
    /// `list_scope` then `read_note` anyway earns the host's "you have already
    /// read that note" refusal, and the script then anchors an edit on that
    /// sentence. The prose is built to `opening_scope`'s wording in
    /// `core/src/plugins/agent/run_loop.rs`; if that wording moves, this fails
    /// by name rather than the suite going quietly red three scenarios later.
    #[test]
    fn the_opening_single_note_message_is_proposed_from_on_the_first_turn() {
        let note = "---\ntitle: ag1note\n---\nalpha beta gamma delta\nepsilon zeta eta theta";
        let opening = format!(
            "Your scope is one note. Its id is note-aaa and its whole text \
             follows, so you do not need list_scope or read_note. Answer the \
             user's question from it, or propose an edit whose anchor is copied \
             exactly from it, then finish. The text is {} characters:{note}",
            note.chars().count(),
        );
        let actions = parse_actions(&ask(&[
            turn(ChatRole::User, "tidy this note"),
            turn(ChatRole::User, &opening),
        ]));
        let edits: Vec<&AgentAction> = actions
            .iter()
            .filter(|a| matches!(a, AgentAction::ProposeEdit { .. }))
            .collect();
        assert_eq!(
            edits.len(),
            2,
            "the opening body must be proposed from at once: {actions:?}"
        );
        for e in edits {
            let AgentAction::ProposeEdit {
                note_id,
                anchor,
                replacement,
            } = e
            else {
                unreachable!()
            };
            // The id comes out of the opening prose, since no assistant turn
            // named one.
            assert_eq!(note_id, "note-aaa", "got {e:?}");
            // The anchor is the NOTE's, never the host's sentence. This is the
            // assertion that fails when the frame goes unrecognised: the whole
            // message then counts as the note.
            assert!(
                !anchor.contains("Your scope is one note"),
                "an anchor may not be host prose: {anchor:?}"
            );
            crate::plugins::agent::edit::place(note, anchor, replacement)
                .unwrap_or_else(|e| panic!("anchor {anchor:?} must place: {e:?}"));
        }
    }

    /// `ag5`'s premise, on the opening message: a task that names other folders
    /// asks for the scope BEFORE it proposes anything.
    ///
    /// Written because nothing here held it. Teaching the script to propose from
    /// the opening message took this branch's trigger away with it (it keyed on
    /// the stub having asked `list_scope`, which a pre-answered scope means it
    /// never does), every test in this module still passed, and `ag5` was the
    /// only thing that noticed — after a container build and nine specs. The
    /// expansion is the injection-reachable path `docs/decisions/ai/0518` puts a
    /// user gate in front of, so "unreachable" is the one way it must not fail.
    #[test]
    fn a_task_naming_other_folders_requests_scope_before_proposing() {
        let note = "---\ntitle: ag5note\n---\nalpha beta gamma delta\nepsilon zeta eta theta";
        let opening = format!(
            "Your scope is one note. Its id is note-aaa and its whole text \
             follows, so you do not need list_scope or read_note. Answer the \
             user's question from it, or propose an edit whose anchor is copied \
             exactly from it, then finish. The text is {} characters:{note}",
            note.chars().count(),
        );
        let actions = parse_actions(&ask(&[
            turn(ChatRole::User, "tidy the notes in other folders too"),
            turn(ChatRole::User, &opening),
        ]));
        assert!(
            actions
                .iter()
                .any(|a| matches!(a, AgentAction::RequestScope { .. })),
            "the expansion must be asked for, not skipped: {actions:?}"
        );
        assert!(
            !actions
                .iter()
                .any(|a| matches!(a, AgentAction::ProposeEdit { .. })),
            "and it must be asked BEFORE anything is proposed: {actions:?}"
        );
    }
}
