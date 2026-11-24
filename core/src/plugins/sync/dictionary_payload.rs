// SPDX-License-Identifier: AGPL-3.0-only
//! The typed inner payload of `vault.dictionary` (`protocol.md` §9.13.2) and its
//! `sync-protocol.md` §10.2.1 merge (myne-md/myne#640).
//!
//! The crypto codec (`protocol::dictionary_blob`) stays **payload-agnostic**: it
//! owns the `MYD1`/`MYD5` envelope, the `dict_format_version` byte and the AEAD,
//! and treats the inner plaintext as opaque bytes. This module is the typed layer
//! that reads and writes those bytes, and it lives in `myne-core` because the two
//! consumers are on opposite sides of the crate boundary, the sync phase merges
//! the payload here, and the desktop spell plugin persists it, while the shared
//! crate is the one thing both depend on.
//!
//! ## Two generations
//!
//! * [`PersonalDictionaryV1`] is the `0x01` payload: two canonical word sets.
//! * [`PersonalDictionaryData`] is the `0x02` payload: the same two sets plus a
//!   **per-word removal clock** map, `"<set>/<word>" -> epoch-milliseconds`.
//!
//! The version byte is the codec's; this module never sees it and never writes
//! one. A caller that has just decoded a blob asks the codec
//! (`protocol::dictionary_blob::dictionary_blob_format`) which decoder to run.
//!
//! ## Why a clock, and why per word
//!
//! A clockless union cannot express a removal: an entry present on one side and
//! absent on the other is indistinguishable between "never had it" and "deleted
//! it", so the union restores the peer's copy and the deletion undoes itself. The
//! fix is the one myne-md/myne#613 landed for the `vault.prefs` set fields, a
//! stamped absence, with the single-sided decision delegated to
//! [`super::prefs_merge::single_sided_clock_rule`] so there is one implementation
//! of the rule rather than two.
//!
//! The clock is **per word**, namespaced by set (`personal_words/<word>`,
//! `ignore_words/<word>`), not per set. A per-set clock would make one word's
//! removal race every other word's add in the same set, so an add on one device
//! and a removal on another could not both be represented; §10.2's per-entry
//! granularity is the same choice for the same reason.
//!
//! Clocks are retained **indefinitely**, exactly as §10.2 does for the prefs
//! sets: a tombstone whose entry neither side holds is kept, because dropping it
//! lets a third device that still holds the entry at an older clock resurrect
//! what two others deleted. The cost is stated in `protocol.md` §9.13.4 beside
//! the size budget rather than left implied.
//!
//! ## Canonical form
//!
//! Word sets are NFC-normalized, lexicographically sorted and exact-deduped on
//! encode (the §9.13.2 discipline, unchanged from `0x01`). Clock keys carry the
//! same NFC word, so two devices cannot derive different keys for one word. Case
//! folding is deliberately NOT applied here: it is the spell lookup layer's job
//! (`spell::SpellEngine::fold`), and the codec stores exact NFC bytes.

use std::collections::BTreeMap;
use std::sync::OnceLock;
use tokio::sync::Mutex;

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

/// The personal-words set name, used as the clock-key namespace prefix.
pub const PERSONAL_WORDS_FIELD: &str = "personal_words";
/// The ignore-words set name, used as the clock-key namespace prefix.
pub const IGNORE_WORDS_FIELD: &str = "ignore_words";

/// The `dict_format_version 0x01` inner payload: two canonical word sets.
///
/// Kept as a first-class type rather than a decode-only shim because a `0x01`
/// blob must stay readable (the codec decodes both generations) and the two
/// shapes are genuinely different: this one has no clock field at all, so a
/// payload that was written before myne-md/myne#640 parses as a legacy union
/// whose entries carry no clock (absent = 0).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonalDictionaryV1 {
    /// User-added words that count as correctly spelled.
    pub personal_words: Vec<String>,
    /// Vault-wide ignore set (suppressed even if otherwise misspelled).
    pub ignore_words: Vec<String>,
}

/// The `dict_format_version 0x02` inner payload: the two word sets plus a
/// per-word removal-clock map.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonalDictionaryData {
    /// User-added words that count as correctly spelled.
    pub personal_words: Vec<String>,
    /// Vault-wide ignore set (suppressed even if otherwise misspelled).
    pub ignore_words: Vec<String>,
    /// `"<set>/<word>" -> epoch-milliseconds of the last membership change`.
    ///
    /// A key whose word is in NEITHER set is a **tombstone**: the word was
    /// removed and the clock is what makes the removal beat a peer's older copy.
    /// A key whose word IS present is the add stamp that lets a re-add beat its
    /// own tombstone. Absent = 0 (a `0x01`-era entry).
    pub removal_clocks: BTreeMap<String, u64>,
}

/// NFC-normalize, sort, and exact-dedup a word list (the `deliberate_folders`
/// canonical discipline, §9.13.2). Folded-identity dedup is the lookup layer's
/// job, not the codec's, this preserves distinct display forms and only
/// collapses exact duplicates.
fn canonical_words(words: &[String]) -> Vec<String> {
    let mut v: Vec<String> = words.iter().map(|w| w.nfc().collect::<String>()).collect();
    v.sort();
    v.dedup();
    v
}

/// Per-family write serialization, the `prefs::commands::write_mutex` shape.
///
/// `vault.dictionary` has TWO independent read-merge-write callers: the desktop
/// spell plugin (`src-tauri/src/spell/sync.rs`) and the sync engine's
/// `sync_dictionary_phase`. `singleton_quiesce::shared()` is a read guard, so it
/// keeps a reseal out but does NOT order those two against each other, and a
/// merge computed from a pre-write read can land after the other writer and drop
/// the peer's word. Both callers take this before they read (myne-md/myne#640).
pub fn write_mutex() -> &'static Mutex<()> {
    static MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
    MUTEX.get_or_init(|| Mutex::new(()))
}

/// Decode either inner generation of a `vault.dictionary` payload into the
/// current shape. The ONE dispatch: the sync phase and the desktop host both
/// call this, so a `0x03` costs one edit rather than three that can disagree.
///
/// `format` is the blob's `dict_format_version` byte. `None` (an unknown or
/// absent format) and a payload that does not parse both answer `None`, which
/// every caller keeps as the §9.13.4 "refuse, do not treat as empty" posture.
pub fn decode_dictionary_payload(
    format: Option<u8>,
    plaintext: &[u8],
) -> Option<PersonalDictionaryData> {
    match format {
        Some(protocol::DICTIONARY_BLOB_FORMAT_V1) => {
            PersonalDictionaryV1::decode(plaintext).map(PersonalDictionaryV1::into_current)
        }
        Some(protocol::DICTIONARY_BLOB_FORMAT_V2) => PersonalDictionaryData::decode(plaintext),
        _ => None,
    }
}

/// The clock key of one set entry: `"<set>/<NFC word>"`. The one constructor, so
/// the stamper and the merge cannot derive different keys for one entry, the
/// `set_fold`/`set_entry_identity` discipline one family over.
pub fn clock_key(set: &str, word: &str) -> String {
    let nfc: String = word.nfc().collect();
    format!("{set}/{nfc}")
}

impl PersonalDictionaryV1 {
    /// Serialize to canonical postcard bytes.
    pub fn encode(&self) -> Vec<u8> {
        let canonical = PersonalDictionaryV1 {
            personal_words: canonical_words(&self.personal_words),
            ignore_words: canonical_words(&self.ignore_words),
        };
        postcard::to_allocvec(&canonical).unwrap_or_default()
    }

    /// Deserialize from postcard bytes. `None` on a malformed payload (the
    /// caller keeps the §9.13.4 / #255 posture).
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        postcard::from_bytes(bytes).ok()
    }

    /// Promote to the `0x02` shape: every entry survives with no clock (absent =
    /// 0), which is exactly how a pre-feature entry loses to the first clocked
    /// write.
    pub fn into_current(self) -> PersonalDictionaryData {
        PersonalDictionaryData {
            personal_words: self.personal_words,
            ignore_words: self.ignore_words,
            removal_clocks: BTreeMap::new(),
        }
    }
}

impl PersonalDictionaryData {
    /// Serialize to canonical postcard bytes: word sets NFC/sorted/deduped,
    /// clock keys NFC-normalized and sorted (a `BTreeMap` is ordered), duplicate
    /// keys collapsed to their maximum clock.
    pub fn encode(&self) -> Vec<u8> {
        let canonical = self.canonicalized();
        postcard::to_allocvec(&canonical).unwrap_or_default()
    }

    /// Deserialize from postcard bytes. `None` on a malformed payload.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        postcard::from_bytes(bytes).ok()
    }

    /// [`Self::encode`] without the empty-on-failure collapse, for callers that
    /// WRITE what they encode: a postcard failure there would replace the
    /// user's dictionary with an empty one on disk and on the server, which is
    /// indistinguishable from "no words" (myne-md/myne#640).
    pub fn try_encode(&self) -> Option<Vec<u8>> {
        postcard::to_allocvec(&self.canonicalized()).ok()
    }

    /// The canonical form of this payload, the exact bytes [`Self::encode`]
    /// writes. Used by the merge (so two devices cannot compare differently
    /// canonicalized views) and by the tests.
    pub fn canonicalized(&self) -> Self {
        let mut clocks: BTreeMap<String, u64> = BTreeMap::new();
        for (key, clock) in &self.removal_clocks {
            let canonical = match key.split_once('/') {
                Some((set, word)) => clock_key(set, word),
                None => key.clone(),
            };
            let entry = clocks.entry(canonical).or_insert(0);
            *entry = (*entry).max(*clock);
        }
        PersonalDictionaryData {
            personal_words: canonical_words(&self.personal_words),
            ignore_words: canonical_words(&self.ignore_words),
            removal_clocks: clocks,
        }
    }

    /// True when the payload carries no words AND no tombstones.
    ///
    /// **A payload holding only tombstones is NOT empty**, and that is
    /// load-bearing: `persist_payload_to_dir` deletes the file when the payload
    /// is empty, so answering `true` for a tombstone-only payload would delete
    /// the very bytes that make a removal converge. It would look correct on the
    /// removing device (the word is gone either way) and silently restore the
    /// word on every other one.
    pub fn is_empty(&self) -> bool {
        self.personal_words.is_empty()
            && self.ignore_words.is_empty()
            && self.removal_clocks.is_empty()
    }

    /// Add a personal word, stamping `now_ms` as its add clock (an add must
    /// carry a clock of its own, or a re-added word loses to its own tombstone
    /// forever, the #613 rule).
    pub fn add_personal(&mut self, word: &str, now_ms: u64) {
        let nfc: String = word.nfc().collect();
        self.personal_words.push(nfc.clone());
        self.removal_clocks
            .insert(clock_key(PERSONAL_WORDS_FIELD, &nfc), now_ms);
    }

    /// Add an ignore word, stamping `now_ms`.
    pub fn add_ignore(&mut self, word: &str, now_ms: u64) {
        let nfc: String = word.nfc().collect();
        self.ignore_words.push(nfc.clone());
        self.removal_clocks
            .insert(clock_key(IGNORE_WORDS_FIELD, &nfc), now_ms);
    }

    /// Remove a personal word, stamping `now_ms` as the removal clock and leaving
    /// the clock behind as the tombstone.
    pub fn remove_personal(&mut self, word: &str, now_ms: u64) {
        let nfc: String = word.nfc().collect();
        self.personal_words.retain(|w| w != &nfc);
        self.removal_clocks
            .insert(clock_key(PERSONAL_WORDS_FIELD, &nfc), now_ms);
    }

    /// Remove an ignore word, stamping `now_ms`.
    pub fn remove_ignore(&mut self, word: &str, now_ms: u64) {
        let nfc: String = word.nfc().collect();
        self.ignore_words.retain(|w| w != &nfc);
        self.removal_clocks
            .insert(clock_key(IGNORE_WORDS_FIELD, &nfc), now_ms);
    }

    /// The clock of one set entry, absent = 0.
    pub fn clock_of(&self, set: &str, word: &str) -> u64 {
        self.removal_clocks
            .get(&clock_key(set, word))
            .copied()
            .unwrap_or(0)
    }
}

/// The `sync-protocol.md` §10.2.1 merge of two `vault.dictionary` payloads.
///
/// **Union with per-word removal clocks.** An entry either side holds survives,
/// UNLESS the side that does not hold it carries a strictly greater clock for
/// that word, that is a deletion rather than "never had it". Equal clocks keep
/// the entry (the recoverable direction: an entry that survives one extra round
/// can be deleted again, while one dropped by a clock collision cannot be
/// recovered). Every clock is carried forward (the maximum), including the ones
/// whose word is in neither input, because those are the tombstones.
///
/// Deterministic, commutative and idempotent: the result depends only on the
/// two inputs' canonical forms, which is what keeps two devices at the same
/// bytes and stops the CAS ping-pong.
pub fn merge_personal_dictionaries(
    local: &PersonalDictionaryData,
    remote: &PersonalDictionaryData,
) -> PersonalDictionaryData {
    let local = local.canonicalized();
    let remote = remote.canonicalized();

    let mut clocks: BTreeMap<String, u64> = BTreeMap::new();
    // Retain EVERY clock from both sides first, tombstone-only keys included.
    // Building this map from the two word sets instead would visit only entries
    // somebody still holds and delete the rest, which is the #613 review finding
    // one family over.
    for (key, clock) in local
        .removal_clocks
        .iter()
        .chain(remote.removal_clocks.iter())
    {
        let entry = clocks.entry(key.clone()).or_insert(0);
        *entry = (*entry).max(*clock);
    }

    let personal_words = merge_word_set(
        PERSONAL_WORDS_FIELD,
        &local,
        &remote,
        &local.personal_words,
        &remote.personal_words,
        &mut clocks,
    );
    let ignore_words = merge_word_set(
        IGNORE_WORDS_FIELD,
        &local,
        &remote,
        &local.ignore_words,
        &remote.ignore_words,
        &mut clocks,
    );

    PersonalDictionaryData {
        personal_words,
        ignore_words,
        removal_clocks: clocks,
    }
}

/// One set's half of [`merge_personal_dictionaries`].
fn merge_word_set(
    set: &str,
    local: &PersonalDictionaryData,
    remote: &PersonalDictionaryData,
    local_set: &[String],
    remote_set: &[String],
    clocks: &mut BTreeMap<String, u64>,
) -> Vec<String> {
    use std::collections::BTreeSet;

    let local_entries: BTreeSet<&String> = local_set.iter().collect();
    let remote_entries: BTreeSet<&String> = remote_set.iter().collect();
    let mut out: Vec<String> = Vec::new();
    for word in local_entries.union(&remote_entries) {
        let key = clock_key(set, word);
        match (
            local_entries.contains(*word),
            remote_entries.contains(*word),
        ) {
            (true, true) => {
                // Held by both: no membership conflict. Carry the greater clock
                // forward so a later removal on either device has something to
                // beat.
                let carried = local
                    .removal_clocks
                    .get(&key)
                    .copied()
                    .unwrap_or(0)
                    .max(remote.removal_clocks.get(&key).copied().unwrap_or(0));
                if carried > 0 {
                    clocks.insert(key, carried);
                }
                out.push((*word).clone());
            }
            (true, false) => {
                let present = local.removal_clocks.get(&key).copied().unwrap_or(0);
                let absent = remote.removal_clocks.get(&key).copied().unwrap_or(0);
                if super::prefs_merge::single_sided_clock_rule(&key, present, absent, clocks) {
                    out.push((*word).clone());
                }
            }
            (false, true) => {
                let present = remote.removal_clocks.get(&key).copied().unwrap_or(0);
                let absent = local.removal_clocks.get(&key).copied().unwrap_or(0);
                if super::prefs_merge::single_sided_clock_rule(&key, present, absent, clocks) {
                    out.push((*word).clone());
                }
            }
            (false, false) => unreachable!("word came from one of the two sets"),
        }
    }
    out.sort();
    out
}

/// The CLOCKLESS union a `dict_format_version 0x01` reader performs, the
/// mixed-fleet model, and deliberately a separate function rather than a flag on
/// the real merge.
///
/// A client predating myne-md/myne#640 has no clock field, so its merge is a
/// pure set union: it cannot represent a removal and it strips any tombstone it
/// receives (it rebuilds the payload from its own two vectors). Modelling that
/// here lets the mixed-fleet sentence in `sync-protocol.md` §10.2.1 be MEASURED ,
/// the word a `0x02` device deleted comes back, instead of asserted.
pub fn legacy_clockless_union(
    legacy: &PersonalDictionaryData,
    peer: &PersonalDictionaryData,
) -> PersonalDictionaryData {
    let legacy = legacy.canonicalized();
    let peer = peer.canonicalized();
    let mut personal: Vec<String> = legacy.personal_words.clone();
    personal.extend(peer.personal_words.iter().cloned());
    let mut ignore: Vec<String> = legacy.ignore_words.clone();
    ignore.extend(peer.ignore_words.iter().cloned());
    PersonalDictionaryData {
        personal_words: canonical_words(&personal),
        ignore_words: canonical_words(&ignore),
        // A `0x01` reader carries no clocks at all, this is the half that
        // makes a removal non-convergent against it.
        removal_clocks: BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dict(personal: &[&str], ignore: &[&str]) -> PersonalDictionaryData {
        PersonalDictionaryData {
            personal_words: personal.iter().map(|s| s.to_string()).collect(),
            ignore_words: ignore.iter().map(|s| s.to_string()).collect(),
            removal_clocks: BTreeMap::new(),
        }
    }

    /// The published `dictionary-merge` vectors, run against the one merge the
    /// sync phase uses (`sync-protocol.md` §10.2.1 + `protocol.md` §9.13.2).
    ///
    /// Skips when the companion is not cloned, matching the `chats-merge`
    /// precedent, and `MYNE_VECTORS_REQUIRED=1` inverts the skip. Every case runs
    /// in BOTH argument orders, so commutativity is structural. The expected
    /// bytes are compared as the CANONICAL encoding, so a port whose merge is
    /// right and whose encoder is not still fails.
    #[test]
    fn dictionary_merge_matches_every_published_vector() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../myne-test-vectors/vectors/dictionary-merge/v0.1/cases.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            assert!(
                std::env::var_os("MYNE_VECTORS_REQUIRED").is_none(),
                "MYNE_VECTORS_REQUIRED is set but the dictionary-merge vectors are absent at {}",
                path.display(),
            );
            eprintln!(
                "[skip] dictionary-merge vectors absent at {}",
                path.display()
            );
            return;
        };
        let doc: serde_json::Value = serde_json::from_str(&raw).expect("vectors parse as JSON");
        assert_eq!(doc["schema"], "dictionary-merge");
        assert_eq!(doc["protocol_version"], "v0.1");
        let cases = doc["cases"]
            .as_array()
            .expect("vectors carry a cases array");
        assert!(
            !cases.is_empty(),
            "dictionary-merge vectors must not be empty"
        );

        fn side(case: &serde_json::Value, id: &str, field: &str) -> PersonalDictionaryData {
            let hex = case[field]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing {field}"));
            let bytes = protocol::hex::decode_lower_vec(hex)
                .unwrap_or_else(|| panic!("[{id}] {field} is lowercase hex"));
            PersonalDictionaryData::decode(&bytes)
                .unwrap_or_else(|| panic!("[{id}] {field} decodes as a 0x02 payload"))
        }

        for case in cases {
            let id = case["vector_id"]
                .as_str()
                .expect("case carries a vector_id");
            assert_eq!(
                case["case_kind"].as_str(),
                Some("merge"),
                "[{id}] is the single case kind this category carries"
            );
            let local = side(case, id, "input_local_hex");
            let remote = side(case, id, "input_remote_hex");
            let expected = side(case, id, "expected_merged_hex");
            let expected_hex = case["expected_merged_hex"].as_str().unwrap();

            let once = merge_personal_dictionaries(&local, &remote);
            assert_eq!(once, expected, "[{id}] merge");
            assert_eq!(
                protocol::hex::encode_lower(&once.encode()),
                expected_hex,
                "[{id}] the merged payload re-encodes to the published canonical bytes"
            );
            assert_eq!(
                merge_personal_dictionaries(&remote, &local),
                expected,
                "[{id}] merge, swapped (commutativity)"
            );
        }
    }

    #[test]
    fn v1_round_trips_and_promotes_with_no_clocks() {
        let v1 = PersonalDictionaryV1 {
            personal_words: vec!["Myne".into(), "tokio".into()],
            ignore_words: vec!["helllo".into()],
        };
        let back = PersonalDictionaryV1::decode(&v1.encode()).expect("decode v1");
        assert_eq!(back, v1);
        let current = back.into_current();
        assert_eq!(current.personal_words, vec!["Myne", "tokio"]);
        assert!(current.removal_clocks.is_empty());
    }

    #[test]
    fn v2_round_trips_with_clocks() {
        let mut d = dict(&["Myne"], &["helllo"]);
        d.add_personal("Myne", 10);
        d.remove_ignore("helllo", 20);
        let back = PersonalDictionaryData::decode(&d.encode()).expect("decode v2");
        assert_eq!(back.personal_words, vec!["Myne"]);
        assert!(back.ignore_words.is_empty());
        assert_eq!(
            back.removal_clocks
                .get(&clock_key(IGNORE_WORDS_FIELD, "helllo")),
            Some(&20)
        );
    }

    #[test]
    fn tombstone_only_payload_is_not_empty() {
        let mut d = PersonalDictionaryData::default();
        d.remove_personal("ghost", 5);
        assert!(
            !d.is_empty(),
            "a tombstone-only payload must be persisted, or the removal never converges"
        );
    }

    #[test]
    fn nfc_normalizes_on_add_and_on_clock_keys() {
        let mut d = PersonalDictionaryData::default();
        d.add_personal("cafe\u{0301}", 1);
        let canonical = d.canonicalized();
        assert_eq!(canonical.personal_words, vec!["caf\u{00e9}"]);
        assert!(canonical
            .removal_clocks
            .contains_key(&clock_key(PERSONAL_WORDS_FIELD, "caf\u{00e9}")));
    }

    /// The acceptance criterion: a word added on one device reaches the other
    /// within one round (one merge).
    #[test]
    fn an_added_word_reaches_the_peer_in_one_round() {
        let mut a = PersonalDictionaryData::default();
        a.add_personal("vodozemac", 100);
        let b = PersonalDictionaryData::default();
        let merged = merge_personal_dictionaries(&a, &b);
        assert_eq!(merged.personal_words, vec!["vodozemac"]);
        assert_eq!(merged, merge_personal_dictionaries(&b, &a));
    }

    /// The reproduction sequence, at the merge level: add on A, sync, remove on
    /// A, two rounds, the word stays gone.
    #[test]
    fn a_removed_word_stays_gone_over_two_rounds() {
        // Round 1: A adds, both converge.
        let mut a = PersonalDictionaryData::default();
        a.add_personal("myne", 100);
        let mut b = merge_personal_dictionaries(&a, &PersonalDictionaryData::default());
        a = merge_personal_dictionaries(&a, &b);
        assert_eq!(a.personal_words, vec!["myne"]);
        assert_eq!(b.personal_words, vec!["myne"]);

        // Round 2: A removes at a later clock.
        a.remove_personal("myne", 300);
        b = merge_personal_dictionaries(&b, &a);
        assert!(b.personal_words.is_empty(), "the removal must propagate");
        a = merge_personal_dictionaries(&a, &b);
        assert!(a.personal_words.is_empty(), "the word stays gone on A too");
        assert_eq!(
            a.removal_clocks
                .get(&clock_key(PERSONAL_WORDS_FIELD, "myne")),
            Some(&300),
            "the tombstone is retained even though neither side holds the word"
        );
    }

    /// Commutativity over the new entries, including a tie.
    #[test]
    fn merge_is_commutative() {
        let mut a = dict(&["alpha", "beta"], &[]);
        a.add_personal("alpha", 10);
        let mut b = dict(&["beta", "gamma"], &[]);
        b.add_personal("gamma", 10);
        assert_eq!(
            merge_personal_dictionaries(&a, &b),
            merge_personal_dictionaries(&b, &a)
        );
    }

    /// Idempotence: merging a payload with itself changes nothing.
    #[test]
    fn merge_is_idempotent() {
        let mut a = dict(&["alpha"], &["beta"]);
        a.add_personal("alpha", 7);
        a.remove_ignore("beta", 9);
        assert_eq!(merge_personal_dictionaries(&a, &a), a.canonicalized());
    }

    /// A tombstone retained when NEITHER side holds the entry still beats a
    /// third device's older live copy. Without retention the third device
    /// resurrects the word, which is the #613 review finding.
    #[test]
    fn a_retained_tombstone_beats_a_third_devices_older_copy() {
        let mut tombstone = PersonalDictionaryData::default();
        tombstone.remove_personal("ghost", 300);
        let mut offline = dict(&["ghost"], &[]);
        offline.add_personal("ghost", 100);
        let merged = merge_personal_dictionaries(&tombstone, &offline);
        assert!(merged.personal_words.is_empty());
    }

    /// A re-add must beat its own tombstone, which is what the add stamp is for.
    #[test]
    fn a_re_added_word_beats_its_own_tombstone() {
        let mut a = PersonalDictionaryData::default();
        a.remove_personal("myne", 100);
        let mut b = PersonalDictionaryData::default();
        b.add_personal("myne", 200);
        let merged = merge_personal_dictionaries(&a, &b);
        assert_eq!(merged.personal_words, vec!["myne"]);
    }

    /// The mixed-fleet rule, MEASURED: a `0x01` reader's clockless union restores
    /// the word a `0x02` device deleted, so a dictionary removal does not
    /// converge until every device is upgraded. The spec owes its users this
    /// sentence; this is what keeps the sentence honest.
    #[test]
    fn a_v1_reader_restores_a_removed_word() {
        let mut a = PersonalDictionaryData::default();
        a.remove_personal("myne", 300);
        // The legacy device still holds the word, with no clock at all.
        let legacy = dict(&["myne"], &[]);
        // What the legacy device's own merge produces (its clockless union), which
        // it then pushes back.
        let legacy_result = legacy_clockless_union(&legacy, &a);
        assert_eq!(
            legacy_result.personal_words,
            vec!["myne"],
            "the documented mixed-fleet restore: a legacy peer cannot carry a tombstone"
        );
        // The upgraded device's merge still drops it, so the two devices now
        // DISAGREE about the word: the legacy one re-adds it on every round and
        // the upgraded one drops it on every round. That is what "does not
        // converge until every device is upgraded" means, and it is asserted
        // rather than described.
        let upgraded_view = merge_personal_dictionaries(&a, &legacy_result);
        assert!(
            upgraded_view.personal_words.is_empty(),
            "the upgraded device keeps the word gone"
        );
        assert_ne!(
            upgraded_view, legacy_result,
            "the fleet is not converged while a legacy peer is in it"
        );
        assert_eq!(
            merge_personal_dictionaries(&legacy_result, &a),
            upgraded_view,
            "both argument orders agree; the disagreement is between the two devices' \
             own rules, not between two orderings of one merge"
        );
    }

    /// Emits the proposed `myne-test-vectors` cases for the `0x02` payload and
    /// its merge, as pretty-printed JSON at
    /// `/tmp/myne_dictionary_merge_vectors.json`, ready to paste into
    /// `myne-test-vectors/vectors/dictionary-merge/v0.1/cases.json`.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act. Run with:
    /// `cargo test -p myne-core --lib emit_dictionary_merge_vectors_for_paste -- --ignored`
    #[test]
    #[ignore]
    fn emit_dictionary_merge_vectors_for_paste() {
        extern crate std;
        use std::fmt::Write as _;

        fn hex(bytes: &[u8]) -> String {
            let mut s = String::with_capacity(bytes.len() * 2);
            for b in bytes {
                let _ = write!(s, "{b:02x}");
            }
            s
        }

        fn payload(view: &PersonalDictionaryData) -> String {
            hex(&view.canonicalized().encode())
        }

        fn case(
            out: &mut String,
            slug: &str,
            description: &str,
            local: &PersonalDictionaryData,
            remote: &PersonalDictionaryData,
            expected: &PersonalDictionaryData,
            comma: bool,
        ) {
            out.push_str("    {\n");
            let _ = writeln!(
                out,
                "      \"vector_id\": \"dictionary-merge/v0.1/{slug}\","
            );
            let _ = writeln!(
                out,
                "      \"description\": \"{}\",",
                description.replace('"', "'")
            );
            out.push_str("      \"case_kind\": \"merge\",\n");
            let _ = writeln!(out, "      \"input_local_hex\": \"{}\",", payload(local));
            let _ = writeln!(out, "      \"input_remote_hex\": \"{}\",", payload(remote));
            let _ = writeln!(
                out,
                "      \"expected_merged_hex\": \"{}\"",
                payload(expected)
            );
            out.push_str(if comma { "    },\n" } else { "    }\n" });
        }

        // Round 1: A adds, B is empty. The union keeps it.
        let mut a_added = PersonalDictionaryData::default();
        a_added.add_personal("vodozemac", 100);
        let merged_add = merge_personal_dictionaries(&a_added, &PersonalDictionaryData::default());

        // Round 2: A removes at a later clock; B still holds the word at 0.
        let mut a_removed = PersonalDictionaryData::default();
        a_removed.remove_personal("myne", 300);
        let mut b_live = PersonalDictionaryData::default();
        b_live.add_personal("myne", 0);
        let merged_removed = merge_personal_dictionaries(&a_removed, &b_live);

        // A tombstone retained with NEITHER side holding the word beats a third
        // device's older live copy.
        let mut third = PersonalDictionaryData::default();
        third.add_personal("ghost", 100);
        let merged_third = merge_personal_dictionaries(&a_removed, &third);

        // A re-add beats its own tombstone.
        let mut readd = PersonalDictionaryData::default();
        readd.add_personal("myne", 200);
        let mut tombstone_only = PersonalDictionaryData::default();
        tombstone_only.remove_personal("myne", 100);
        let merged_readd = merge_personal_dictionaries(&tombstone_only, &readd);

        // The equal-clock tie keeps the entry (the recoverable direction).
        let mut tie_a = PersonalDictionaryData::default();
        tie_a.add_personal("tie", 50);
        let mut tie_b = PersonalDictionaryData::default();
        tie_b.remove_personal("tie", 50);
        let merged_tie = merge_personal_dictionaries(&tie_a, &tie_b);

        let mut out = String::new();
        out.push_str("{\n");
        out.push_str("  \"schema\": \"dictionary-merge\",\n");
        out.push_str("  \"protocol_version\": \"v0.1\",\n");
        out.push_str("  \"spec_section\": \"sync-protocol.md §10.2.1 + protocol.md §9.13.2\",\n");
        out.push_str("  \"description\": \"Pins the canonical 0x02 vault.dictionary payload (postcard) and the §10.2.1 union-with-per-word-removal-clocks merge (myne-md/myne#640). input_*_hex and expected_merged_hex are the CANONICAL encoded payloads (NFC + sorted + deduped word sets, sorted clock map). A port that drops a tombstone whose word is in neither input, or that keeps a single-sided entry whose absent-side clock is strictly greater, MUST fail these cases by name.\",\n");
        out.push_str("  \"cases\": [\n");
        case(
            &mut out,
            "merge-add-one-round",
            "A added 'vodozemac' at clock 100; B is empty. The union keeps the word and carries its clock.",
            &a_added,
            &PersonalDictionaryData::default(),
            &merged_add,
            true,
        );
        case(
            &mut out,
            "merge-removal-converges",
            "A removed 'myne' at clock 300 (tombstone, word absent); B still holds it at clock 0. The absent side's clock is strictly greater, so the word is DROPPED and the tombstone is retained.",
            &a_removed,
            &b_live,
            &merged_removed,
            true,
        );
        case(
            &mut out,
            "merge-retained-tombstone-beats-third-device",
            "A holds only the 'myne' tombstone at 300; a third device holds 'myne' live at 100. The tombstone wins, and it is retained even though neither input lists the word.",
            &a_removed,
            &third,
            &merged_third,
            true,
        );
        case(
            &mut out,
            "merge-readd-beats-own-tombstone",
            "A tombstoned 'myne' at 100; B re-added it at 200. The newer add wins and the word is present.",
            &tombstone_only,
            &readd,
            &merged_readd,
            true,
        );
        case(
            &mut out,
            "merge-equal-clock-keeps-the-entry",
            "A holds 'tie' at clock 50; B removed it at clock 50. Equal clocks KEEP the entry: an entry that survives one extra round can be deleted again, while one dropped by a collision cannot be recovered.",
            &tie_a,
            &tie_b,
            &merged_tie,
            false,
        );
        out.push_str("  ]\n");
        out.push_str("}\n");

        std::fs::write("/tmp/myne_dictionary_merge_vectors.json", out.as_bytes())
            .expect("write dictionary-merge vectors");
    }
}
