// SPDX-License-Identifier: AGPL-3.0-only
//! **What kind of `vault.meta` is this**, for the sync plane, answered once.
//!
//! Every question here used to be a raw magic comparison at its call site, and every
//! one of them was written when `NTV7` was the newest generation. `NTV8` (myne-md/myne#938)
//! is the same vault with the person wrap truncated away, so a comparison against
//! `NTV7`'s magic alone answers "no" for every vault that has been unlocked since the
//! upgrade, and the answers are not cosmetic:
//!
//! - the head context (`cycle::signed_head_ctx`) returned `None`, so the cycle stopped
//!   authoring heads at all;
//! - the signed-head guard (`cycle`) read the vault as single-user and fell back to the
//!   `0x01` HMAC head the server refuses, wedging sync;
//! - the account plane (`devices`) read a person-born vault as a vault-account vault,
//!   so requests went out under the wrong token and the wrong namespace;
//! - publishing (`publish`) read it as unpublished, and a vault list would have offered
//!   the publish action again;
//! - joining a second device (`person_discovery`) refused the frame as `BadRequest`,
//!   because the server's copy of a person-born vault becomes `NTV8` as soon as the
//!   owner's device syncs its upgraded `vault.meta`.
//!
//! So the generation is asked through `protocol`'s classifier, which is the one place
//! that knows the list, and a new generation is added there rather than here.

/// Whether this frame belongs to the **person-born** family: `NTV7`, and `NTV8` since
/// the person wrap was dropped.
///
/// The property the callers actually want is "this vault is addressed with the person
/// token and its own `?account=` selector rather than a vault SCRAM account", which is
/// true of both generations and false of `MYV1`, `NTV5` and `NTV6`.
#[must_use]
pub fn is_person_born(bytes: &[u8]) -> bool {
    protocol::vault_meta_generation(bytes) >= protocol::VaultMetaGeneration::Person
}

/// Whether this frame carries the B2B tail (group-key wrap, epoch, signed roster), and
/// therefore must be head-signed rather than HMAC'd: `NTV6`, `NTV7` and `NTV8`.
///
/// Delegates to `protocol::has_b2b_tail` so the tail question has one answer in the
/// tree; the wrapper exists so a sync-plane reader does not have to know that the
/// generation enum is ordered by "how much of the tail is present".
#[must_use]
pub fn carries_b2b_tail(bytes: &[u8]) -> bool {
    protocol::has_b2b_tail(bytes)
}

/// The B2B tail of this frame (group-key wrap, epoch, signed roster), or `None` for a
/// generation that has none.
///
/// The tail is byte-identical across `NTV6`, `NTV7` and `NTV8`, which is why the head
/// authority can treat all three the same. It exists here rather than at the call site
/// because the call site (`cycle::signed_head_ctx`) used to spell the three magics out
/// by hand and silently dropped the newest one.
#[must_use]
pub fn b2b_tail(bytes: &[u8]) -> Option<protocol::B2bVaultMeta> {
    protocol::vault_meta_ntv7::parse_b2b_tail_any(bytes).ok()
}

/// Which tail generation a sync-plane WRITER must re-emit.
///
/// Carried rather than inferred from `Option<PersonWrap>`, which is what the invite
/// writer and the group rotation used to do. That inference was exact while the tail
/// had two generations; `NTV8` carries no person wrap either, so `None` became
/// ambiguous and an `NTV8` vault was re-emitted as `NTV6` — a two-generation
/// downgrade of a frame `protocol.md` §9.3.6 says is never written again, and one
/// that the meta phase then refuses to push, so the server's pre-write frame comes
/// back over the local one (myne-md/myne#938 review).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TailFrame {
    /// `NTV6`: the v0.2 B2B frame, no person wrap, recovery wrap retired.
    Ntv6,
    /// `NTV7`: the B2B tail plus the person wrap.
    Ntv7,
    /// `NTV8`: the B2B tail with the person wrap structurally absent.
    Ntv8,
}

impl TailFrame {
    /// The generation a frame of these bytes must be re-emitted in, or `None` for a
    /// generation with no tail (`MYV1`, `NTV5`), which no tail-aware writer accepts.
    #[must_use]
    pub fn of(bytes: &[u8]) -> Option<Self> {
        match protocol::vault_meta_generation(bytes) {
            protocol::VaultMetaGeneration::B2b => Some(Self::Ntv6),
            protocol::VaultMetaGeneration::Person => Some(Self::Ntv7),
            protocol::VaultMetaGeneration::PersonNoWrap => Some(Self::Ntv8),
            protocol::VaultMetaGeneration::Legacy => None,
        }
    }
}

/// Re-serialize a rewritten tail in the generation it arrived in.
///
/// The caller builds `tail` with the epoch and the sealed roster it means to write,
/// because both callers replace them (an invite writes the roster at the same epoch, a
/// rotation advances both); everything else rides `tail` untouched, so a rotation
/// cannot lose the owner's group-key wrap by rebuilding the frame field by field.
///
/// A person wrap paired with a frame that cannot hold one, or an `NTV7` frame with
/// none, is refused rather than silently downgraded: that pairing is the caller
/// error this function exists to make unrepresentable.
pub fn serialize_tail_frame(
    frame: TailFrame,
    tail: protocol::B2bVaultMeta,
    person_wrap: Option<protocol::PersonWrap>,
) -> Result<Vec<u8>, protocol::ProtocolError> {
    let base = tail.base;
    let group_key_nonce = tail.group_key_nonce;
    let enc_group_key = tail.enc_group_key;
    let group_key_epoch = tail.group_key_epoch;
    let signed_roster_envelope = tail.signed_roster_envelope;
    match (frame, person_wrap) {
        (TailFrame::Ntv7, Some(person_wrap)) => {
            protocol::serialize_vault_meta_ntv7(&protocol::PersonWrappedVaultMeta {
                base,
                group_key_nonce,
                enc_group_key,
                group_key_epoch,
                signed_roster_envelope,
                person_wrap,
            })
        }
        (TailFrame::Ntv8, None) => {
            protocol::serialize_vault_meta_ntv8(&protocol::PasswordOnlyVaultMeta {
                base,
                group_key_nonce,
                enc_group_key,
                group_key_epoch,
                signed_roster_envelope,
            })
        }
        (TailFrame::Ntv6, None) => protocol::serialize_vault_meta_ntv6(&protocol::B2bVaultMeta {
            base,
            group_key_nonce,
            enc_group_key,
            group_key_epoch,
            signed_roster_envelope,
        }),
        (TailFrame::Ntv7, None) | (TailFrame::Ntv6, Some(_)) | (TailFrame::Ntv8, Some(_)) => {
            Err(protocol::ProtocolError::InvalidVaultMeta)
        }
    }
}

#[cfg(test)]
mod generation_matrix {
    //! **Every generation the spec names, answered by every consumer that branches on one.**
    //!
    //! This is the ratchet for the defect class myne-md/myne#983 came from, one level above the
    //! `gen` guard in `scripts/check-version-routing.mjs`: that guard catches a PARTIAL question
    //! (an equality test against one variant), and this matrix catches an UNANSWERED one (a
    //! generation that a consumer simply has no case for, which is how `NTV8` silently fell out
    //! of the person-identity carrier and out of the head context before anybody noticed).
    //!
    //! The list of magics is READ FROM THE SPEC rather than copied here. A generation added to
    //! `docs/spec/protocol.md` without a row below turns this red, which is the whole point: the
    //! failure mode it replaces is a silent `_ =>` arm.

    use super::{carries_b2b_tail, is_person_born};

    /// One row per magic `docs/spec/protocol.md` names, with what every consumer must answer.
    ///
    /// `(magic, person_born, carries_tail)`. `person_born` is deliberate about the two older
    /// frames: `MYV1` and `NTV5` are single-user, and `NTV6` is a shared vault that is NOT
    /// person-born (it has no person wrap and no `?account=` selector).
    const MATRIX: &[(&str, bool, bool)] = &[
        ("MYV1", false, false),
        ("NTV5", false, false),
        ("NTV6", false, true),
        ("NTV7", true, true),
        ("NTV8", true, true),
    ];

    /// The magics the spec names, as 4-byte frames the classifier can be asked about.
    fn spec_magics() -> Vec<String> {
        let spec = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../docs/spec/protocol.md"
        ))
        .expect("docs/spec/protocol.md is part of the tree");
        let mut out: Vec<String> = Vec::new();
        let bytes = spec.as_bytes();
        for (i, _) in spec.match_indices(['M', 'N']) {
            let tail = &bytes[i..(i + 4).min(bytes.len())];
            if tail.len() == 4
                && (tail[0] == b'M' || tail[0] == b'N')
                && tail[3].is_ascii_digit()
                && tail[1..3].iter().all(|b| b.is_ascii_uppercase())
            {
                let magic = String::from_utf8(tail.to_vec()).expect("ascii");
                // The `vault.meta` family only: `MYV1` and the `NTV` generations. Every OTHER
                // four-character magic in the spec is a blob family (`MYA1`, `MYC5`, ...), and
                // those are not generations a consumer branches on.
                if magic.starts_with("MYV") || magic.starts_with("NTV") {
                    out.push(magic);
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// A new generation cannot land silently: the spec names it and this matrix has no row.
    #[test]
    fn every_magic_the_spec_names_has_a_row_here() {
        let named = spec_magics();
        assert!(
            named.len() >= 5,
            "the spec's magic list went missing or the scan broke: {named:?}"
        );
        let missing: Vec<&String> = named
            .iter()
            .filter(|magic| !MATRIX.iter().any(|(known, _, _)| known == &magic.as_str()))
            .collect();
        assert!(
            missing.is_empty(),
            "docs/spec/protocol.md names {missing:?} and this matrix has no row for it. Answer for \
             it before adding it: which consumers branch on generation, and what does each answer? \
             See myne-md/myne#983 and myne-md/myne#984."
        );
    }

    /// Every consumer's answer, per generation. Both predicates are asked because they are the two
    /// questions a generation-branching consumer actually has, and getting either wrong is silent.
    #[test]
    fn every_consumer_answers_for_every_generation() {
        for (magic, person_born, carries_tail) in MATRIX {
            let mut frame = [0u8; 64];
            frame[0..4].copy_from_slice(magic.as_bytes());
            assert_eq!(
                is_person_born(&frame),
                *person_born,
                "{magic}: is_person_born"
            );
            assert_eq!(
                carries_b2b_tail(&frame),
                *carries_tail,
                "{magic}: carries_b2b_tail"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame of each generation, built by the crate that writes it. The two person
    /// generations must answer identically to both predicates, because that is exactly
    /// what the six call sites this module replaced got wrong.
    fn frames() -> Vec<(&'static str, Vec<u8>)> {
        let account = protocol::generate_account_number().expect("account");
        let root = protocol::generate_root_key().expect("root");
        let items = protocol::generate_root_key().expect("items");
        let group = protocol::generate_root_key().expect("group");
        let items_key_id = [5u8; 16];
        let kdf = protocol::KdfParams {
            m_kib: protocol::MIN_KDF_M_KIB,
            t: 1,
            p: 1,
            argon2_version: 0x13,
        };

        let ntv5 = protocol::encode_vault_meta_v0_2_raw(
            &root,
            &items,
            &items_key_id,
            "pw",
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            &account.hash,
            &kdf,
            &[0x01; 16],
            &[0x02; 16],
            &[0x03; 24],
            &[0x04; 24],
            &[0x05; 24],
        )
        .expect("encode NTV5")
        .to_vec();
        let mut myv1 = ntv5.clone();
        myv1[0..4].copy_from_slice(&protocol::VAULT_META_MAGIC);
        myv1[4] = protocol::VAULT_META_PROTOCOL_VERSION;
        myv1[5] = 0x00;

        // The person generations retire the recovery wrap; the serializer refuses one.
        let mut base = protocol::parse_vault_meta_v0_2(&ntv5).expect("parse NTV5");
        base.random_salt_recovery = [0u8; 16];
        base.nonce_recovery_wrap = [0u8; 24];
        base.enc_root_key_recovery = [0u8; 64];

        let roster = protocol::person_invite::seal_group_roster(
            &group,
            &account.hash,
            1,
            &[0x66; 24],
            &protocol::person_invite::SignedGroupRoster {
                payload: vec![0xC3; 32],
                signature: protocol::person_key::PersonSigned {
                    ed25519_sig: [0xD4; protocol::person_key::PERSON_ED25519_SIG_LEN],
                    mldsa_sig: vec![0xE5; protocol::person_key::PERSON_MLDSA_SIG_LEN],
                },
            },
        )
        .expect("sealed roster");
        let ntv6 = protocol::serialize_vault_meta_ntv6(&protocol::B2bVaultMeta {
            base: base.clone(),
            group_key_nonce: [0xA1; 24],
            enc_group_key: [0xB2; 64],
            group_key_epoch: 1,
            signed_roster_envelope: roster.clone(),
        })
        .expect("serialize NTV6");
        let owner = protocol::PersonKeyPair::generate_raw(&[0x31; 64], &[0x32; 32], &[0x33; 32]);
        let ntv7 = protocol::vault_meta_ntv7::serialize_vault_meta_ntv7(
            &protocol::vault_meta_ntv7::PersonWrappedVaultMeta {
                base: base.clone(),
                group_key_nonce: [0xA1; 24],
                enc_group_key: [0xB2; 64],
                group_key_epoch: 1,
                signed_roster_envelope: roster.clone(),
                person_wrap: {
                    let mut rng = FixtureRng(5);
                    protocol::vault_meta_ntv7::seal_root_key_to_person_raw(
                        &owner.public_half(),
                        &root,
                        &items_key_id,
                        &mut rng,
                    )
                    .expect("seal root key")
                },
            },
        )
        .expect("serialize NTV7");
        let ntv8 = protocol::vault_meta_ntv8::serialize_vault_meta_ntv8(
            &protocol::vault_meta_ntv8::PasswordOnlyVaultMeta {
                base,
                group_key_nonce: [0xA1; 24],
                enc_group_key: [0xB2; 64],
                group_key_epoch: 1,
                signed_roster_envelope: roster,
            },
        )
        .expect("serialize NTV8");

        vec![
            ("MYV1", myv1),
            ("NTV5", ntv5),
            ("NTV6", ntv6),
            ("NTV7", ntv7),
            ("NTV8", ntv8),
        ]
    }

    /// Deterministic `CryptoRng` for the fixture's person wrap.
    struct FixtureRng(u64);

    impl rand_core::TryRng for FixtureRng {
        type Error = core::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            Ok(self.try_next_u64()? as u32)
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            Ok(z ^ (z >> 31))
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            for chunk in dst.chunks_mut(8) {
                let v = self.try_next_u64()?.to_le_bytes();
                chunk.copy_from_slice(&v[..chunk.len()]);
            }
            Ok(())
        }
    }

    impl rand_core::TryCryptoRng for FixtureRng {}

    /// **Both person generations answer identically**, which is the whole point.
    ///
    /// Reverting either predicate to an `NTV7`-only magic comparison makes the `NTV8`
    /// row fail, and each of those reversions is a live bug in the plane: no head
    /// context, an `0x01` downgrade the server refuses, the wrong account token, a
    /// re-offered publish action, and a refused second-device join.
    #[test]
    fn the_two_person_generations_answer_identically() {
        let expected: [(&str, bool, bool); 5] = [
            ("MYV1", false, false),
            ("NTV5", false, false),
            ("NTV6", false, true),
            ("NTV7", true, true),
            ("NTV8", true, true),
        ];
        for ((name, bytes), (want_name, person_born, tail)) in frames().into_iter().zip(expected) {
            assert_eq!(name, want_name);
            assert_eq!(
                is_person_born(&bytes),
                person_born,
                "[{name}] is_person_born"
            );
            assert_eq!(carries_b2b_tail(&bytes), tail, "[{name}] carries_b2b_tail");
            // The tail the head authority builds its context from: present for exactly
            // the generations the predicate names, and it unwraps to the same fields.
            match b2b_tail(&bytes) {
                Some(parsed) => {
                    assert!(tail, "[{name}] has a tail predicate but no parsable tail");
                    assert_eq!(parsed.group_key_epoch, 1, "[{name}] epoch");
                }
                None => assert!(
                    !tail,
                    "[{name}] carries a tail but the tail reader returned None, which is \
                     the defect that stopped the cycle authoring heads"
                ),
            }
        }
    }

    /// **A rewritten tail goes back out in the generation it arrived in.**
    ///
    /// This is the writer half of the module: the invite and the group rotation both
    /// take a live frame, rewrite its tail and write it back, and both used to pick
    /// the output by asking `person_wrap.is_some()`. `NTV8` has no person wrap, so
    /// that question answered "NTV6" for every vault created since the upgrade.
    /// Reverting this to an inferred frame makes the `NTV8` row fail.
    #[test]
    fn a_rewritten_tail_keeps_the_generation_it_arrived_in() {
        for (name, bytes) in frames() {
            let Some(frame) = TailFrame::of(&bytes) else {
                assert!(
                    matches!(name, "MYV1" | "NTV5"),
                    "[{name}] has a tail but no tail frame"
                );
                continue;
            };
            let tail = b2b_tail(&bytes).expect("a tailed frame parses as a tail");
            let person_wrap = match frame {
                TailFrame::Ntv7 => Some(
                    protocol::vault_meta_ntv7::parse_vault_meta_ntv7(&bytes)
                        .expect("NTV7 parses")
                        .person_wrap,
                ),
                TailFrame::Ntv6 | TailFrame::Ntv8 => None,
            };
            // The same epoch and the same sealed roster, so the only thing that can
            // differ in the output is the frame around them.
            let out = serialize_tail_frame(frame, tail, person_wrap)
                .unwrap_or_else(|_| panic!("[{name}] re-serialize"));
            assert_eq!(
                out.get(..4),
                bytes.get(..4),
                "[{name}] a rewritten tail changed the magic"
            );
            assert_eq!(
                TailFrame::of(&out),
                Some(frame),
                "[{name}] the re-serialized frame reads back as a different generation"
            );
        }
    }

    /// A person wrap cannot be paired with a frame that has no room for it, and an
    /// `NTV7` frame cannot be written without one.
    #[test]
    fn a_person_wrap_and_a_frame_that_cannot_hold_it_are_refused() {
        let bytes = frames()
            .into_iter()
            .find(|(n, _)| *n == "NTV7")
            .map(|(_, b)| b)
            .expect("NTV7 fixture");
        let tail = b2b_tail(&bytes).expect("tail");
        let person_wrap = protocol::vault_meta_ntv7::parse_vault_meta_ntv7(&bytes)
            .expect("parse")
            .person_wrap;
        assert!(
            serialize_tail_frame(TailFrame::Ntv7, tail.clone(), None).is_err(),
            "an NTV7 frame was written without a person wrap"
        );
        assert!(
            serialize_tail_frame(TailFrame::Ntv8, tail.clone(), Some(person_wrap.clone())).is_err(),
            "an NTV8 frame accepted a person wrap it cannot hold"
        );
        assert!(
            serialize_tail_frame(TailFrame::Ntv6, tail, Some(person_wrap)).is_err(),
            "an NTV6 frame accepted a person wrap it cannot hold"
        );
    }

    /// An unknown magic is neither, which is the safe answer for a caller choosing a
    /// credential: it falls back to the vault-account path rather than the person one.
    #[test]
    fn an_unknown_generation_is_neither_person_born_nor_tailed() {
        let mut future = frames()
            .into_iter()
            .find(|(n, _)| *n == "NTV8")
            .map(|(_, b)| b)
            .expect("NTV8 fixture");
        future[0..4].copy_from_slice(b"FUT9");
        assert!(!is_person_born(&future));
        assert!(!carries_b2b_tail(&future));
    }
}
