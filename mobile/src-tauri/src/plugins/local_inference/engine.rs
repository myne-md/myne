// SPDX-License-Identifier: AGPL-3.0-only
//! The [`Engine`] trait — the single seam every AI capability sibling reaches
//! inference through (SYNC-3/7). The impl
//! (a stub now, Candle then a sandboxed sidecar later) is hidden so the
//! in-host-vs-sidecar process boundary and any future engine swap stay
//! invisible to callers.
//!
//! The trait is **synchronous** by design: model inference is CPU-bound and
//! blocking, so the async / `spawn_blocking` seam belongs at the command
//! layer (tasks 3/6), not in the trait. It is `Send + Sync` so one engine
//! instance can back concurrent commands behind `Arc`.

// The Engine trait is ported whole from desktop, so the generation/chat surface
// (infer/chat, ChatMessage, StubEngine) is present but unused
// on this transcription-only mobile port until the UI (task 7) wires cancel. A
// /simplify pass can strip the chat/gen surface; until then, don't warn.
#![allow(dead_code, unused_imports)] // MYND-563 scaffolding: unwired until tasks 6/7, dead in test builds too

use std::ops::ControlFlow;

use super::error::EngineError;

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

/// On-device inference surface (SYNC-7): a blocking `infer(prompt) -> result`.
/// No streaming (SYNC-7). Implementors must be
/// `Send + Sync` so a single engine instance can back concurrent commands
/// behind `Arc`.
pub trait Engine: Send + Sync {
    /// One-shot text completion for `prompt`. Blocking; returns the full
    /// result — no token stream (SYNC-7).
    fn infer(&self, prompt: &str) -> Result<String, EngineError>;

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
    /// note-derived string is ever logged** (DENY-list, `src-tauri/AGENTS.md`).
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

    /// Drop any lazily-cached loaded model so the next `infer` re-reads
    /// from disk. Called after the user picks a new model file
    /// (`set_model_path`) so a swap takes effect without an app restart —
    /// otherwise the process keeps serving the previously-loaded weights. Default
    /// no-op — the stub holds no cache.
    fn invalidate_models(&self) {}

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
    /// Default: [`EngineError::NotReady`] — an engine with no ASR model (a
    /// generation-only build) has no transcription path. The real
    /// Candle-Whisper impl and the [`StubEngine`] override this.
    fn transcribe(&self, _pcm: &[f32]) -> Result<String, EngineError> {
        Err(EngineError::NotReady)
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

/// Trivial in-memory engine used before any model lands (the task-1 tracer).
///
/// `infer` echoes the prompt behind a fixed marker. Deterministic,
/// allocation-only — no
/// model, no network, no file I/O — so it proves the trait shape and the
/// feature isolation compile and round-trip.
#[derive(Debug, Default, Clone, Copy)]
pub struct StubEngine;

impl Engine for StubEngine {
    fn infer(&self, prompt: &str) -> Result<String, EngineError> {
        // Echo, not a model. The marker lets a test assert the value came
        // through the trait against the stub (not a real completion).
        Ok(format!("stub-infer: {prompt}"))
    }

    fn infer_streaming(
        &self,
        prompt: &str,
        on_token: &mut dyn FnMut(&str) -> ControlFlow<()>,
    ) -> Result<String, EngineError> {
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

    fn transcribe(&self, pcm: &[f32]) -> Result<String, EngineError> {
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
    fn default_transcribe_is_not_ready() {
        // An engine that overrides nothing (generation-only) has no
        // ASR path: the trait default returns NotReady rather than panicking.
        struct BareEngine;
        impl Engine for BareEngine {
            fn infer(&self, _p: &str) -> Result<String, EngineError> {
                Ok(String::new())
            }
        }
        let engine: &dyn Engine = &BareEngine;
        assert_eq!(engine.transcribe(&[0.0; 8]), Err(EngineError::NotReady));
    }
}
