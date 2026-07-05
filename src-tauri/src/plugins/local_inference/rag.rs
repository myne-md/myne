//! RAG context assembly + Q&A answer service (semantic-search-qa task 6,
//! SYNC-3/7, §9.6.5). Takes a natural-language question, retrieves the top-k
//! chunks via task 5, assembles a grounding context **entirely in RAM from
//! already-decrypted, non-excluded chunks**, wraps it in a grounding prompt, and
//! calls the **blocking** `Engine.infer` (no streaming). Returns the answer plus
//! the source `{note_id, byte-range}` set for citation.
//!
//! ## Never persisted, zeroized by scope
//!
//! The assembled context + prompt are AS1-class plaintext derivatives. They are
//! held under [`Zeroizing`] and never outlive the call — the service is
//! **stateless** (holds nothing between calls), so its buffers wipe on function
//! return via RAII, i.e. "dropped on lock" is satisfied for free (there is no
//! resident buffer for a lock-time teardown to reach). Nothing is written to
//! disk or log (DENY-list discipline — never log a chunk, prompt, question, or
//! `note_id`).
//!
//! ## Consumer-agnostic seams
//!
//! Like [`super::retrieval`], the service takes closures rather than reaching
//! into prefs / the resident-body store / the engine directly: `embed` +
//! `infer` are the `Engine` seams (stub in tests), `is_excluded` is the
//! `ai_excluded_folders` predicate, and `resolve_chunk_text` maps a retrieved
//! `{note_id, byte-range}` back to its already-decrypted text (the caller backs
//! it with the resident note bodies). A chunk whose text can't be resolved
//! (note since evicted) is skipped, not faked.

#![cfg_attr(not(test), allow(dead_code))]

use zeroize::Zeroizing;

use myne_core::plugins::notes::note_id::NoteId;

use super::engine::{ChatMessage, ChatRole};
use super::retrieval::top_k_matches;
use super::vector_store::{AiVectorStore, ChunkKey};

/// A grounded answer plus the chunks it was grounded on, for citation.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    /// The model's answer text.
    pub answer: String,
    /// The `{note_id, byte-range}` chunks that formed the grounding context, in
    /// retrieval rank order — the citation set.
    pub sources: Vec<ChunkKey>,
}

/// Assemble the grounding prompt from a question + the resolved context chunks.
/// Returns a [`Zeroizing`] string so the assembled plaintext wipes on drop. The
/// instruction pins the model to the supplied context (grounded QA, not free
/// generation). Pure.
pub fn assemble_rag_prompt(question: &str, chunks: &[Zeroizing<String>]) -> Zeroizing<String> {
    let mut s = String::new();
    s.push_str(
        "Answer the question using ONLY the context below. \
         If the context does not contain the answer, say you don't know. \
         Answer in the language of the question.\n\nContext:\n",
    );
    for (i, c) in chunks.iter().enumerate() {
        s.push('[');
        s.push_str(&(i + 1).to_string());
        s.push_str("] ");
        s.push_str(c.as_str());
        s.push_str("\n\n");
    }
    s.push_str("Question: ");
    s.push_str(question);
    s.push_str("\nAnswer:");
    Zeroizing::new(s)
}

/// Answer `question` grounded in the resident vault. Embeds the question once,
/// retrieves top-k non-excluded chunks (task 5), resolves each to its already-
/// decrypted text, assembles the grounding prompt (under [`Zeroizing`]), and
/// calls the blocking `infer`. Returns the answer + the resolved source set.
///
/// `embed` / `infer` are the `Engine` seams; `is_excluded` the exclusion
/// predicate; `resolve_chunk_text` maps a retrieved key to its resident text
/// (returns `None` to skip an unresolvable chunk). Errors from `embed`/`infer`
/// propagate unchanged.
#[allow(clippy::too_many_arguments)]
pub fn answer_question<E>(
    question: &str,
    store: &AiVectorStore,
    k: usize,
    is_excluded: impl Fn(&NoteId) -> bool,
    mut embed: impl FnMut(&str) -> Result<Vec<f32>, E>,
    resolve_chunk_text: impl Fn(&ChunkKey) -> Option<Zeroizing<String>>,
    mut infer: impl FnMut(&str) -> Result<String, E>,
) -> Result<Answer, E> {
    let query_vec = embed(question)?;
    let matches = top_k_matches(&query_vec, store, k, is_excluded);

    let mut chunk_texts: Vec<Zeroizing<String>> = Vec::new();
    let mut sources: Vec<ChunkKey> = Vec::new();
    for m in &matches {
        if let Some(text) = resolve_chunk_text(&m.key) {
            chunk_texts.push(text);
            sources.push(m.key);
        }
    }

    let prompt = assemble_rag_prompt(question, &chunk_texts);
    let answer = infer(prompt.as_str())?;
    Ok(Answer { answer, sources })
}

// ---------------------------------------------------------------------------
// Multi-turn chat grounding (conversational-ai-chat task 3)
// ---------------------------------------------------------------------------

/// Budget bounds for a chat-grounding assembly so the framed prompt stays inside
/// the small local model's context window.
#[derive(Debug, Clone, Copy)]
pub struct ChatBudget {
    /// Keep at most this many trailing history messages (sliding window).
    pub max_history_messages: usize,
    /// Total grounding-context character cap: chunks are added in rank order
    /// until the next would exceed it; an over-long top chunk is truncated (on a
    /// char boundary) to fit the remaining budget.
    pub max_context_chars: usize,
}

impl Default for ChatBudget {
    fn default() -> Self {
        // ~8 trailing messages (4 exchanges) + ~6k context chars (~1.5k tokens)
        // leaves room for the history turns + the generation inside a small
        // quantized model's window. Tunable; not load-bearing.
        Self {
            max_history_messages: 8,
            max_context_chars: 6000,
        }
    }
}

/// A grounded chat request ready for `Engine::chat_streaming`: the trusted
/// grounding `system` message carrying the retrieved context (held under
/// [`Zeroizing`] — it embeds note plaintext), the budget-trimmed conversation
/// `messages` (trailing history + the new user turn), and the `sources` the
/// answer is grounded on (for citation). The engine treats `system` + every
/// message `content` as UNTRUSTED (task 2's token-level STI defense), so the
/// retrieved chunks cannot escape their turn.
pub struct GroundedChat {
    pub system: Zeroizing<String>,
    pub messages: Vec<ChatMessage>,
    pub sources: Vec<ChunkKey>,
}

/// Grounding instruction pinned to the retrieved context — the chat variant of
/// [`assemble_rag_prompt`], but framed as a SYSTEM message (the question is a
/// separate user turn in the conversation now). Held under [`Zeroizing`] because
/// it embeds chunk plaintext.
fn assemble_grounding_system(chunks: &[Zeroizing<String>]) -> Zeroizing<String> {
    let mut s = String::new();
    if chunks.is_empty() {
        // No relevant note context (chit-chat, a greeting, or an off-note
        // question — the relevance gate dropped weak matches). Behave as a normal
        // helpful assistant rather than refusing; stay honest about uncertainty.
        s.push_str(
            "You are a helpful assistant inside the user's private note app. \
             Respond helpfully and conversationally. If the user asks about their \
             own notes but you have no relevant excerpts, say so honestly instead \
             of inventing note content. Answer in the user's language.",
        );
        return Zeroizing::new(s);
    }
    // Relevant note excerpts were retrieved — prefer them for anything about the
    // user's notes, but still answer general questions from knowledge (hybrid).
    s.push_str(
        "You are a helpful assistant inside the user's private note app. When the \
         note excerpts below are relevant, base your answer on them and rely on \
         them for anything about the user's own notes. If they don't cover the \
         question, answer from general knowledge and be honest about what you are \
         unsure of. Answer in the user's language.\n\nNotes:\n",
    );
    for (i, c) in chunks.iter().enumerate() {
        s.push('[');
        s.push_str(&(i + 1).to_string());
        s.push_str("] ");
        s.push_str(c.as_str());
        s.push_str("\n\n");
    }
    Zeroizing::new(s)
}

/// Keep at most `max` trailing messages (sliding window over history).
fn trailing_window(history: &[ChatMessage], max: usize) -> Vec<ChatMessage> {
    let start = history.len().saturating_sub(max);
    history[start..].to_vec()
}

/// Truncate `s` to at most `max_chars` characters, never splitting a multi-byte
/// char.
fn clip_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        s.chars().take(max_chars).collect()
    }
}

/// Frame a grounded chat request from ALREADY-resolved context chunks. Applies
/// the [`ChatBudget`] char cap (chunks kept in rank order until the cap; the
/// boundary chunk truncated to fit), builds the grounding `system` message, and
/// frames the trailing-window history + the new user turn. Pure — no retrieval,
/// no I/O. Shared by [`assemble_chat_grounding`] (sync-resolve path) and the
/// streaming command (which reads note bodies async before calling this).
///
/// `chunks[i]` corresponds to `sources[i]` (parallel, rank order). Chunks are
/// placed in `system` verbatim; the engine's `chat_streaming` treats `system` as
/// untrusted (sanitize + special-token-off), so no chunk can escape its turn —
/// the sanitize discipline lives at the token boundary (task 2), not here.
pub fn frame_grounded_chat(
    history: &[ChatMessage],
    question: &str,
    chunks: &[Zeroizing<String>],
    sources: &[ChunkKey],
    budget: ChatBudget,
) -> GroundedChat {
    let mut kept_chunks: Vec<Zeroizing<String>> = Vec::new();
    let mut kept_sources: Vec<ChunkKey> = Vec::new();
    let mut used_chars = 0usize;
    for (c, s) in chunks.iter().zip(sources.iter()) {
        let remaining = budget.max_context_chars.saturating_sub(used_chars);
        if remaining == 0 {
            break; // context budget spent — drop the rest
        }
        let clipped = clip_chars(c.as_str(), remaining);
        used_chars += clipped.chars().count();
        kept_chunks.push(Zeroizing::new(clipped));
        kept_sources.push(*s);
    }

    let system = assemble_grounding_system(&kept_chunks);

    let mut messages = trailing_window(history, budget.max_history_messages);
    messages.push(ChatMessage {
        role: ChatRole::User,
        content: question.to_string(),
    });

    GroundedChat {
        system,
        messages,
        sources: kept_sources,
    }
}

/// Assemble a grounded multi-turn chat request. Embeds `question` **once**,
/// retrieves top-k non-excluded chunks, resolves each to its already-decrypted
/// text (skipping unresolvable), then frames via [`frame_grounded_chat`]. Does
/// NOT call the engine; streaming happens at the command layer (task 5).
/// `embed` / `is_excluded` / `resolve_chunk_text` are the same seams as
/// [`answer_question`]. `embed`'s error propagates unchanged.
#[allow(clippy::too_many_arguments)]
pub fn assemble_chat_grounding<E>(
    history: &[ChatMessage],
    question: &str,
    store: &AiVectorStore,
    k: usize,
    budget: ChatBudget,
    is_excluded: impl Fn(&NoteId) -> bool,
    mut embed: impl FnMut(&str) -> Result<Vec<f32>, E>,
    resolve_chunk_text: impl Fn(&ChunkKey) -> Option<Zeroizing<String>>,
) -> Result<GroundedChat, E> {
    let query_vec = embed(question)?;
    let matches = top_k_matches(&query_vec, store, k, is_excluded);

    let mut chunks: Vec<Zeroizing<String>> = Vec::new();
    let mut sources: Vec<ChunkKey> = Vec::new();
    for m in &matches {
        let Some(text) = resolve_chunk_text(&m.key) else {
            continue; // note evicted since retrieval — skip, don't fake
        };
        chunks.push(text);
        sources.push(m.key);
    }

    Ok(frame_grounded_chat(
        history, question, &chunks, &sources, budget,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nid(last: &str) -> NoteId {
        NoteId::parse(&format!("01970e83-4f2f-7000-8000-0000000000{last}")).unwrap()
    }

    fn key(note: NoteId, start: usize, end: usize) -> ChunkKey {
        ChunkKey {
            note_id: note,
            start,
            end,
        }
    }

    fn zs(s: &str) -> Zeroizing<String> {
        Zeroizing::new(s.to_string())
    }

    #[test]
    fn assemble_prompt_contains_question_context_and_grounding_instruction() {
        let chunks = [zs("the sky is blue"), zs("grass is green")];
        let p = assemble_rag_prompt("what color is the sky?", &chunks);
        assert!(p.contains("what color is the sky?"));
        assert!(p.contains("the sky is blue"));
        assert!(p.contains("grass is green"));
        assert!(p.to_lowercase().contains("only the context"));
    }

    #[test]
    fn assemble_prompt_with_no_context_still_well_formed() {
        let p = assemble_rag_prompt("q?", &[]);
        assert!(p.contains("Question: q?"));
        assert!(p.contains("Context:"));
    }

    #[test]
    fn answer_embeds_once_infers_once_and_returns_sources() {
        let mut store = AiVectorStore::new();
        let n = nid("21");
        store.insert_vector(key(n, 0, 5), vec![1.0, 0.0]); // best match
        store.insert_vector(key(n, 5, 10), vec![0.0, 1.0]);

        let mut embeds = 0;
        let embed = |_: &str| -> Result<Vec<f32>, ()> {
            embeds += 1;
            Ok(vec![1.0, 0.0])
        };
        let resolve = |kkey: &ChunkKey| -> Option<Zeroizing<String>> {
            if *kkey == key(n, 0, 5) {
                Some(zs("blue chunk"))
            } else {
                Some(zs("other chunk"))
            }
        };
        let mut infers = 0;
        let infer = |prompt: &str| -> Result<String, ()> {
            infers += 1;
            assert!(prompt.contains("blue chunk"));
            Ok("it is blue".to_string())
        };

        let ans = answer_question("color?", &store, 1, |_| false, embed, resolve, infer).unwrap();
        assert_eq!(ans.answer, "it is blue");
        assert_eq!(ans.sources, vec![key(n, 0, 5)]);
        assert_eq!(embeds, 1, "query embedded once");
        assert_eq!(infers, 1, "generated once (blocking)");
    }

    #[test]
    fn excluded_notes_never_enter_the_context_or_sources() {
        let mut store = AiVectorStore::new();
        let keep = nid("22");
        let excluded = nid("23");
        store.insert_vector(key(excluded, 0, 5), vec![1.0, 0.0]); // best but excluded
        store.insert_vector(key(keep, 0, 5), vec![0.9, 0.1]);

        let embed = |_: &str| -> Result<Vec<f32>, ()> { Ok(vec![1.0, 0.0]) };
        let resolve = |_: &ChunkKey| -> Option<Zeroizing<String>> { Some(zs("text")) };
        let infer = |_: &str| -> Result<String, ()> { Ok("answer".to_string()) };

        let ans =
            answer_question("q?", &store, 5, |id| *id == excluded, embed, resolve, infer).unwrap();
        assert!(ans.sources.iter().all(|k| k.note_id != excluded));
        assert_eq!(ans.sources, vec![key(keep, 0, 5)]);
    }

    #[test]
    fn unresolvable_chunk_is_skipped_not_faked() {
        let mut store = AiVectorStore::new();
        let n = nid("24");
        store.insert_vector(key(n, 0, 5), vec![1.0, 0.0]);
        store.insert_vector(key(n, 5, 10), vec![0.9, 0.1]);

        let embed = |_: &str| -> Result<Vec<f32>, ()> { Ok(vec![1.0, 0.0]) };
        // Only the first chunk resolves; the second was evicted.
        let resolve = |kkey: &ChunkKey| -> Option<Zeroizing<String>> {
            if *kkey == key(n, 0, 5) {
                Some(zs("present"))
            } else {
                None
            }
        };
        let infer = |_: &str| -> Result<String, ()> { Ok("a".to_string()) };

        let ans = answer_question("q?", &store, 5, |_| false, embed, resolve, infer).unwrap();
        assert_eq!(ans.sources, vec![key(n, 0, 5)], "unresolved chunk dropped");
    }

    #[test]
    fn propagates_embed_error_without_calling_infer() {
        let store = AiVectorStore::new();
        let embed = |_: &str| -> Result<Vec<f32>, &'static str> { Err("embed down") };
        let resolve = |_: &ChunkKey| -> Option<Zeroizing<String>> { None };
        let mut infer_called = false;
        let infer = |_: &str| -> Result<String, &'static str> {
            infer_called = true;
            Ok("x".to_string())
        };
        let out = answer_question("q?", &store, 1, |_| false, embed, resolve, infer);
        assert_eq!(out.err(), Some("embed down"));
        assert!(!infer_called, "infer must not run after an embed failure");
    }

    #[test]
    fn propagates_infer_error() {
        let mut store = AiVectorStore::new();
        store.insert_vector(key(nid("25"), 0, 5), vec![1.0, 0.0]);
        let embed = |_: &str| -> Result<Vec<f32>, &'static str> { Ok(vec![1.0, 0.0]) };
        let resolve = |_: &ChunkKey| -> Option<Zeroizing<String>> { Some(zs("t")) };
        let infer = |_: &str| -> Result<String, &'static str> { Err("infer down") };
        let out = answer_question("q?", &store, 1, |_| false, embed, resolve, infer);
        assert_eq!(out.err(), Some("infer down"));
    }

    // ---- assemble_chat_grounding (task 3) ----------------------------------

    fn msg(role: ChatRole, content: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: content.to_string(),
        }
    }

    #[test]
    fn chat_grounding_embeds_once_retrieves_and_frames_new_turn() {
        let mut store = AiVectorStore::new();
        let n = nid("31");
        store.insert_vector(key(n, 0, 5), vec![1.0, 0.0]); // best
        store.insert_vector(key(n, 5, 10), vec![0.0, 1.0]);

        let mut embeds = 0;
        let embed = |_: &str| -> Result<Vec<f32>, ()> {
            embeds += 1;
            Ok(vec![1.0, 0.0])
        };
        let resolve = |kk: &ChunkKey| -> Option<Zeroizing<String>> {
            if *kk == key(n, 0, 5) {
                Some(zs("the sky is blue"))
            } else {
                Some(zs("grass is green"))
            }
        };
        let history = vec![msg(ChatRole::User, "hi"), msg(ChatRole::Assistant, "hello")];
        let g = assemble_chat_grounding(
            &history,
            "what color is the sky?",
            &store,
            1,
            ChatBudget::default(),
            |_| false,
            embed,
            resolve,
        )
        .unwrap();

        assert_eq!(embeds, 1, "query embedded once");
        // system carries the grounding instruction + the top chunk (hybrid — the
        // note excerpts are labelled and the model is told to prefer them).
        assert!(g.system.contains("the sky is blue"));
        assert!(g.system.contains("Notes:"));
        assert!(g.system.to_lowercase().contains("note excerpts"));
        // messages = history + the new user turn (question last, role User).
        assert_eq!(g.messages.len(), 3);
        assert_eq!(g.messages.last().unwrap().role, ChatRole::User);
        assert_eq!(g.messages.last().unwrap().content, "what color is the sky?");
        assert_eq!(g.sources, vec![key(n, 0, 5)]);
    }

    #[test]
    fn chat_grounding_excludes_notes_from_context_and_sources() {
        let mut store = AiVectorStore::new();
        let keep = nid("32");
        let excluded = nid("33");
        store.insert_vector(key(excluded, 0, 5), vec![1.0, 0.0]); // best but excluded
        store.insert_vector(key(keep, 0, 5), vec![0.9, 0.1]);
        let embed = |_: &str| -> Result<Vec<f32>, ()> { Ok(vec![1.0, 0.0]) };
        let resolve = |_: &ChunkKey| -> Option<Zeroizing<String>> { Some(zs("text")) };
        let g = assemble_chat_grounding(
            &[],
            "q?",
            &store,
            5,
            ChatBudget::default(),
            |id| *id == excluded,
            embed,
            resolve,
        )
        .unwrap();
        assert!(g.sources.iter().all(|k| k.note_id != excluded));
        assert_eq!(g.sources, vec![key(keep, 0, 5)]);
    }

    #[test]
    fn chat_grounding_skips_unresolvable_chunks() {
        let mut store = AiVectorStore::new();
        let n = nid("34");
        store.insert_vector(key(n, 0, 5), vec![1.0, 0.0]);
        store.insert_vector(key(n, 5, 10), vec![0.9, 0.1]);
        let embed = |_: &str| -> Result<Vec<f32>, ()> { Ok(vec![1.0, 0.0]) };
        let resolve = |kk: &ChunkKey| -> Option<Zeroizing<String>> {
            if *kk == key(n, 0, 5) {
                Some(zs("present"))
            } else {
                None
            }
        };
        let g = assemble_chat_grounding(
            &[],
            "q?",
            &store,
            5,
            ChatBudget::default(),
            |_| false,
            embed,
            resolve,
        )
        .unwrap();
        assert_eq!(
            g.sources,
            vec![key(n, 0, 5)],
            "unresolved chunk dropped, not faked"
        );
    }

    #[test]
    fn chat_grounding_history_sliding_window_keeps_last_n() {
        let mut store = AiVectorStore::new();
        store.insert_vector(key(nid("35"), 0, 5), vec![1.0, 0.0]);
        let embed = |_: &str| -> Result<Vec<f32>, ()> { Ok(vec![1.0, 0.0]) };
        let resolve = |_: &ChunkKey| -> Option<Zeroizing<String>> { Some(zs("t")) };
        let history: Vec<ChatMessage> = (0..10)
            .map(|i| {
                msg(
                    if i % 2 == 0 {
                        ChatRole::User
                    } else {
                        ChatRole::Assistant
                    },
                    &format!("m{i}"),
                )
            })
            .collect();
        let budget = ChatBudget {
            max_history_messages: 4,
            max_context_chars: 6000,
        };
        let g = assemble_chat_grounding(
            &history,
            "newq",
            &store,
            1,
            budget,
            |_| false,
            embed,
            resolve,
        )
        .unwrap();
        // last 4 trailing history (m6..m9) + the new user turn.
        assert_eq!(g.messages.len(), 5);
        assert_eq!(g.messages[0].content, "m6");
        assert_eq!(g.messages[4].content, "newq");
    }

    #[test]
    fn chat_grounding_context_budget_caps_chars() {
        let mut store = AiVectorStore::new();
        let n = nid("36");
        store.insert_vector(key(n, 0, 5), vec![1.0, 0.0]);
        store.insert_vector(key(n, 5, 10), vec![0.9, 0.1]);
        let embed = |_: &str| -> Result<Vec<f32>, ()> { Ok(vec![1.0, 0.0]) };
        let resolve = |_: &ChunkKey| -> Option<Zeroizing<String>> { Some(zs("abcdefghij")) }; // 10 chars
        let budget = ChatBudget {
            max_history_messages: 8,
            max_context_chars: 10,
        };
        let g = assemble_chat_grounding(&[], "q?", &store, 5, budget, |_| false, embed, resolve)
            .unwrap();
        // Only the first chunk fits the 10-char budget; the second is dropped.
        assert_eq!(g.sources.len(), 1);
        assert!(g.system.contains("abcdefghij"));
    }

    #[test]
    fn chat_grounding_propagates_embed_error_without_resolving() {
        let store = AiVectorStore::new();
        let embed = |_: &str| -> Result<Vec<f32>, &'static str> { Err("embed down") };
        // Cell so the probe stays an `Fn` (interior mutability) — the bound
        // requires `Fn`, and resolve must never run after an embed failure.
        let resolved = std::cell::Cell::new(false);
        let resolve = |_: &ChunkKey| -> Option<Zeroizing<String>> {
            resolved.set(true);
            None
        };
        let out = assemble_chat_grounding(
            &[],
            "q?",
            &store,
            1,
            ChatBudget::default(),
            |_| false,
            embed,
            resolve,
        );
        assert_eq!(out.err(), Some("embed down"));
        assert!(!resolved.get(), "no chunk resolved after an embed failure");
    }
}
