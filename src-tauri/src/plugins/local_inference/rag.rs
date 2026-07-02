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
}
