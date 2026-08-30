//! Tauri-managed live spell state (MYND-262 task 5 + MYND-266 tasks 4-5).
//!
//! Holds the in-RAM [`SpellEngine`] (active-language dictionaries + folded
//! personal/ignore sets used for fast `check`) alongside the canonical
//! [`PersonalDictionaryData`] (the NFC-original words, the source of truth for
//! persistence). Both are plaintext-derived: loaded on unlock, zeroized on lock
//! (the `SearchIndexState` residency discipline, § 9.6.5 / § 9.13).
//!
//! One `Mutex` guards both so the engine's folded view never drifts from the
//! persisted data. Locked WITHOUT an `.await` held (callers lock after their
//! async core returns), so `std::sync::Mutex` is correct; a poisoned lock
//! degrades to empty/no-op rather than panicking — a spell hiccup must never
//! take down a note write or a lock teardown.

use super::dictionary::PersonalDictionaryData;
use super::{SpellEngine, SpellWord};

/// The guarded runtime: the engine (dicts + folded sets) + the canonical data +
/// the set of languages a lazy load has already been attempted for (so a dict
/// that is absent or fails to parse is not re-read on every scan).
#[derive(Default)]
struct SpellRuntime {
    engine: SpellEngine,
    data: PersonalDictionaryData,
    attempted: std::collections::HashSet<String>,
    /// Whether `data` reflects a SUCCESSFUL read of `vault.dictionary` (#255).
    ///
    /// `false` means "we do not know what is on disk" — either nothing has been
    /// hydrated yet, or the hydrate failed on a blob that exists. Both are
    /// states in which a write would persist an empty set over a file nobody
    /// managed to read; `vault.dictionary` is not synced, so only a
    /// `.myne-backup` restore would bring it back.
    hydrated: bool,
}

/// Tauri-managed handle to the live spell engine + personal dictionary.
#[derive(Default)]
pub struct SpellState {
    inner: std::sync::Mutex<SpellRuntime>,
}

impl SpellState {
    /// Load (or replace) a language dictionary from its Hunspell `.aff`/`.dic`.
    pub fn load_language(&self, lang: &str, aff: &str, dic: &str) -> Result<(), String> {
        let mut rt = self.inner.lock().map_err(|_| "spell lock poisoned")?;
        rt.engine.load_language(lang, aff, dic)
    }

    /// Which of `requested` need a lazy load: not already loaded AND not already
    /// attempted this session. Marks the returned languages as attempted under
    /// the same lock so a concurrent scan + a permanently-absent/unparseable dict
    /// are each only ever read once. The caller does the file I/O lock-free, then
    /// inserts via [`load_language`]. Empty on a poisoned lock.
    pub fn languages_to_load(&self, requested: &[String]) -> Vec<String> {
        let Ok(mut rt) = self.inner.lock() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for lang in requested {
            if !rt.engine.is_loaded(lang) && !rt.attempted.contains(lang) {
                rt.attempted.insert(lang.clone());
                out.push(lang.clone());
            }
        }
        out
    }

    /// Keep loaded-set == `active`: drop dictionaries for deactivated languages
    /// and forget their "attempted" mark so re-enabling lazy-reloads. No-op on a
    /// poisoned lock.
    pub fn retain_languages(&self, active: &[String]) {
        if let Ok(mut rt) = self.inner.lock() {
            let active: std::collections::HashSet<String> = active.iter().cloned().collect();
            rt.engine.retain_languages(&active);
            rt.attempted.retain(|lang| active.contains(lang));
        }
    }

    /// Replace the personal/ignore words from a decoded payload (unlock hydrate).
    /// Sets BOTH the canonical data and the engine's folded lookup sets.
    pub fn hydrate_words(&self, data: PersonalDictionaryData) {
        if let Ok(mut rt) = self.inner.lock() {
            rt.engine
                .set_personal_words(data.personal_words.iter().cloned());
            rt.engine
                .set_ignore_words(data.ignore_words.iter().cloned());
            rt.data = data;
            // Only a completed read sets this. The caller passes data ONLY on a
            // successful read (an absent blob is a successful read of nothing);
            // a failed one never reaches here, leaving the flag false.
            rt.hydrated = true;
        }
    }

    /// Does `data` reflect a successful read of the on-disk dictionary (#255)?
    ///
    /// The write paths ask before persisting: a write derived from an
    /// un-hydrated set would overwrite a blob that exists and was merely
    /// unreadable this once (an AV/backup tool holding a handle, a permission
    /// change, an EIO). A poisoned lock answers `false` — the protective
    /// direction.
    pub fn is_hydrated(&self) -> bool {
        self.inner.lock().map(|rt| rt.hydrated).unwrap_or(false)
    }

    /// Batch-check words against `langs` (empty on a poisoned lock).
    pub fn check_batch(&self, words: &[String], langs: &[String]) -> Vec<SpellWord> {
        self.inner
            .lock()
            .map(|rt| rt.engine.check_batch(words, langs))
            .unwrap_or_default()
    }

    /// Add a personal word; returns the updated canonical data for the caller to
    /// persist (or `None` on a poisoned lock). Updates the engine's folded set
    /// immediately so the squiggle clears without waiting for the disk write.
    pub fn add_personal(&self, word: &str) -> Option<PersonalDictionaryData> {
        let mut rt = self.inner.lock().ok()?;
        rt.data.add_personal(word);
        let snapshot = rt.data.clone();
        rt.engine
            .set_personal_words(snapshot.personal_words.iter().cloned());
        Some(snapshot)
    }

    /// Merge a whole word list into the personal set in ONE lock acquisition,
    /// returning the snapshot to persist and how many words were genuinely NEW.
    ///
    /// Exists for the vault import (myne-md/myne#464), and both halves of the
    /// signature are the reason.
    ///
    /// The COUNT: `add_personal` cannot report newness (it pushes and lets the
    /// encoder dedup), so a caller looping over it could only count its own
    /// calls. The import report then told the user it had brought 500 words
    /// across when the two vaults shared 480 of them. Folded comparison, the
    /// same `foldSegment`-shaped rule the lookup layer uses, because "Myne" and
    /// "myne" are not two words to a user.
    ///
    /// The BATCH: the per-word command persists the whole `vault.dictionary`
    /// blob, so carrying 500 words meant 500 AEAD seals and 500 fsyncs, in
    /// sequence, each behind its own IPC round trip. One merge, one persist.
    pub fn merge_personal(&self, words: &[String]) -> Option<(PersonalDictionaryData, usize)> {
        let mut rt = self.inner.lock().ok()?;
        let mut present: std::collections::HashSet<String> = rt
            .data
            .personal_words
            .iter()
            .map(|w| w.to_lowercase())
            .collect();
        let mut added = 0usize;
        for word in words {
            if !present.insert(word.to_lowercase()) {
                continue;
            }
            rt.data.add_personal(word);
            added += 1;
        }
        let snapshot = rt.data.clone();
        rt.engine
            .set_personal_words(snapshot.personal_words.iter().cloned());
        Some((snapshot, added))
    }

    /// Add an ignore word; returns the updated canonical data to persist.
    pub fn add_ignore(&self, word: &str) -> Option<PersonalDictionaryData> {
        let mut rt = self.inner.lock().ok()?;
        rt.data.add_ignore(word);
        let snapshot = rt.data.clone();
        rt.engine
            .set_ignore_words(snapshot.ignore_words.iter().cloned());
        Some(snapshot)
    }

    /// Snapshot the canonical data (for persistence). Empty on a poisoned lock.
    pub fn snapshot_data(&self) -> PersonalDictionaryData {
        self.inner
            .lock()
            .map(|rt| rt.data.clone())
            .unwrap_or_default()
    }

    /// Zeroize-equivalent teardown on lock: clear the engine (dicts + folded
    /// sets) and the canonical data. No-op on a poisoned lock.
    pub fn clear(&self) {
        if let Ok(mut rt) = self.inner.lock() {
            rt.engine.clear();
            rt.data = PersonalDictionaryData::default();
            rt.attempted.clear();
            // A cleared state knows nothing about any vault's disk contents
            // (#255) — the next vault's hydrate is what makes writing safe
            // again.
            rt.hydrated = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn langs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    const EN_AFF: &str = "SET UTF-8\n";
    const EN_DIC: &str = "2\nhello\nworld\n";

    fn loaded() -> SpellState {
        let s = SpellState::default();
        s.load_language("en-US", EN_AFF, EN_DIC).expect("load");
        s
    }

    #[test]
    fn add_personal_makes_word_correct_and_returns_snapshot() {
        let s = loaded();
        assert!(s.check_batch(&langs(&["Myne"]), &langs(&["en-US"]))[0].misspelled);
        let snap = s.add_personal("Myne").expect("add");
        assert_eq!(snap.personal_words, vec!["Myne"]);
        // Folded match: "myne"/"MYNE" also correct now.
        assert!(!s.check_batch(&langs(&["myne"]), &langs(&["en-US"]))[0].misspelled);
    }

    #[test]
    fn add_ignore_suppresses_misspelling() {
        let s = loaded();
        assert!(s.check_batch(&langs(&["helllo"]), &langs(&["en-US"]))[0].misspelled);
        s.add_ignore("helllo").expect("ignore");
        assert!(!s.check_batch(&langs(&["helllo"]), &langs(&["en-US"]))[0].misspelled);
    }

    #[test]
    fn hydrate_sets_both_engine_and_data() {
        let s = loaded();
        let data = PersonalDictionaryData {
            personal_words: vec!["Foo".into()],
            ignore_words: vec!["bar".into()],
        };
        s.hydrate_words(data);
        assert!(!s.check_batch(&langs(&["foo"]), &langs(&["en-US"]))[0].misspelled);
        assert_eq!(s.snapshot_data().personal_words, vec!["Foo"]);
    }

    #[test]
    fn clear_wipes_engine_and_data() {
        let s = loaded();
        s.add_personal("Myne").unwrap();
        s.clear();
        assert!(s.snapshot_data().is_empty());
        // With dicts cleared too, every word is now "misspelled".
        assert!(s.check_batch(&langs(&["hello"]), &langs(&["en-US"]))[0].misspelled);
    }

    const DE_AFF: &str = "SET UTF-8\n";
    const DE_DIC: &str = "1\nhaus\n";

    #[test]
    fn languages_to_load_skips_loaded_and_attempted() {
        let s = SpellState::default();
        // Nothing loaded yet → both are due, and marked attempted.
        assert_eq!(
            s.languages_to_load(&langs(&["en-US", "de"])),
            vec!["en-US".to_string(), "de".to_string()]
        );
        // Second call: already attempted → none (no repeated file I/O).
        assert!(s.languages_to_load(&langs(&["en-US", "de"])).is_empty());
        // A genuinely loaded language is also skipped.
        s.load_language("en-US", DE_AFF, "1\nhello\n").unwrap();
        assert!(s.languages_to_load(&langs(&["en-US"])).is_empty());
    }

    #[test]
    fn retain_languages_drops_deactivated_and_reallows_load() {
        let s = SpellState::default();
        s.load_language("en-US", EN_AFF, EN_DIC).unwrap();
        s.load_language("de", DE_AFF, DE_DIC).unwrap();
        assert!(!s.check_batch(&langs(&["haus"]), &langs(&["de"]))[0].misspelled);
        // Mark both attempted so we can prove retain un-marks the dropped one.
        let _ = s.languages_to_load(&langs(&["en-US", "de"]));

        s.retain_languages(&langs(&["en-US"]));
        // de dict dropped → its word is misspelled again.
        assert!(s.check_batch(&langs(&["haus"]), &langs(&["de"]))[0].misspelled);
        // de is re-attemptable (attempted mark pruned); en-US stays attempted.
        assert_eq!(s.languages_to_load(&langs(&["de"])), vec!["de".to_string()]);
        assert!(s.languages_to_load(&langs(&["en-US"])).is_empty());
    }

    #[test]
    fn clear_resets_attempted_marks() {
        let s = SpellState::default();
        let _ = s.languages_to_load(&langs(&["en-US"]));
        s.clear();
        // After lock teardown, the next unlock re-attempts the load.
        assert_eq!(
            s.languages_to_load(&langs(&["en-US"])),
            vec!["en-US".to_string()]
        );
    }
}
