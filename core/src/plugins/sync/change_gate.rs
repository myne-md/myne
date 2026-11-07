// SPDX-License-Identifier: AGPL-3.0

//! One change gate for the sync engine's diagnostic edges (myne-md/myne#1033).
//!
//! Three sites needed the same question answered — "is this observation different from the last
//! one I emitted?" — and the first version of this change answered it three ways: an
//! `AtomicU8` verdict code, an `AtomicU64` built from the LENGTHS of two literals, and a
//! `OnceLock<Mutex<String>>` that allocated on every cycle. The length hash could not tell two
//! same-length sites apart, and the third allocated to compare. One mechanism, three call sites
//! (review of myne-md/myne#1033).
//!
//! The slot is a closed list of string literals, and the observation is folded into one `u64`, so
//! an entry is sixteen bytes and a lookup is a linear scan over a handful of them: no map, no
//! allocation, and the tag compares the CONTENT of what is logged rather than its shape.

use std::sync::Mutex;

/// A stable 64-bit fold of two bounded tokens (FNV-1a, 64-bit).
///
/// Content, not length: the value it stands in for is what the log line prints, so two
/// observations that would print differently must not fold to the same tag.
#[must_use]
pub(crate) fn fold(a: &str, b: &str) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for byte in a
        .as_bytes()
        .iter()
        .chain(b"\x1f".iter())
        .chain(b.as_bytes())
    {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// True the first time `slot` observes `tag`, false while it repeats.
///
/// `slot` is the address of the channel ("signed_head_ctx", "authority_verdict", ...), so two
/// sites asking about the same KIND of observation never suppress each other's line: each has its
/// own slot. The first call for a slot always fires, which is what makes the opening state of the
/// process visible.
pub(crate) fn first_sighting(slot: &'static str, tag: u64) -> bool {
    static SEEN: Mutex<Vec<(&'static str, u64)>> = Mutex::new(Vec::new());
    // A poisoned lock must not silence a diagnostic: the one writer inside the critical section is
    // a `Vec` push, so the value it guards is intact even after a panic elsewhere.
    let mut seen = match SEEN.lock() {
        Ok(seen) => seen,
        Err(poisoned) => poisoned.into_inner(),
    };
    match seen.iter_mut().find(|(known, _)| *known == slot) {
        Some(entry) => {
            if entry.1 == tag {
                return false;
            }
            entry.1 = tag;
            true
        }
        None => {
            seen.push((slot, tag));
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repeating_observation_is_emitted_once() {
        assert!(first_sighting("test_repeat", fold("a", "b")));
        assert!(!first_sighting("test_repeat", fold("a", "b")));
    }

    #[test]
    fn the_recovery_edge_is_emitted_and_the_slots_are_independent() {
        // The defect the third review found in the first version: the "healthy" answer returned
        // before the gate was consulted, so an absent/present/absent store logged once and then
        // went silent, and a reader could never see that it had stopped.
        let absent = fold("absent", "");
        let present = fold("present", "");
        assert!(first_sighting("test_edge_one", absent));
        assert!(
            first_sighting("test_edge_one", present),
            "recovery must emit"
        );
        assert!(
            first_sighting("test_edge_one", absent),
            "so must a second failure"
        );
        // A second slot with the SAME tags is not suppressed by the first.
        assert!(first_sighting("test_edge_two", absent));
        assert!(!first_sighting("test_edge_two", absent));
    }

    #[test]
    fn the_tag_follows_content_not_length() {
        // Two pairs with identical total lengths must not collide, which is what the length-based
        // hash this replaces did.
        assert_ne!(fold("ab", "cde"), fold("cd", "abe"));
        assert_ne!(fold("", "abc"), fold("abc", ""));
    }
}
