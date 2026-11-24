// SPDX-License-Identifier: AGPL-3.0-only
//! Round-trip test: build a real v0.2 vault fixture (vault.meta + notes +
//! attachments), run the CLI's unlock + export walk, and assert the plaintext
//! matches the source notes byte-exactly.
//!
//! Crypto primitive choice is not under test (RustCrypto is trusted); this
//! exercises framing, AAD binding, magic-byte enforcement, and the export
//! walk's tree mapping end to end.

use myne_format::export_walk::{
    finalize_export, stage_export_tree, NoopExportHooks, StageParams, TrashedMode,
};
use protocol::{KdfParams, MetaVersion, SubkeyRole};
use std::path::Path;

const FAST_TEST_KDF: KdfParams = KdfParams {
    m_kib: protocol::MIN_KDF_M_KIB,
    t: 1,
    p: 1,
    argon2_version: 0x13,
};

/// Build a real v0.2 vault at `dir` under `password`, returning the key
/// material the export walk needs.
fn build_vault(dir: &Path, password: &str) -> ([u8; 32], [u8; 32], [u8; 16], MetaVersion) {
    let account = protocol::generate_account_number().expect("account");
    let phrase = protocol::generate_recovery_phrase().expect("phrase");
    let root_key = protocol::generate_root_key().expect("root_key");
    let salt_password = [1u8; 16];
    let salt_recovery = [2u8; 16];

    let password_wrap_key = protocol::derive_password_wrap_key_v0_2(
        password,
        &salt_password,
        &account.hash,
        &FAST_TEST_KDF,
    )
    .expect("password wrap key");
    let recovery_wrap_key = protocol::derive_recovery_wrap_key_v0_2(
        &phrase,
        &salt_recovery,
        &account.hash,
        &FAST_TEST_KDF,
    )
    .expect("recovery wrap key");

    let aad_pw = protocol::aad_password_wrap_v0_2(&FAST_TEST_KDF);
    let nonce_pw = [3u8; 24];
    let enc_root_pw =
        protocol::aead_seal_ctx(&password_wrap_key, &nonce_pw, root_key.as_slice(), &aad_pw)
            .expect("seal password wrap");

    let aad_rec = protocol::aad_recovery_wrap_v0_2(&FAST_TEST_KDF);
    let nonce_rec = [4u8; 24];
    let enc_root_rec = protocol::aead_seal_ctx(
        &recovery_wrap_key,
        &nonce_rec,
        root_key.as_slice(),
        &aad_rec,
    )
    .expect("seal recovery wrap");

    let items_wrap_key =
        protocol::derive_subkey_versioned(MetaVersion::V0_2, &root_key, SubkeyRole::ItemsKeyWrap);
    let items_key = protocol::generate_root_key().expect("items_key");
    let items_key_id = [5u8; 16];
    let aad_items = protocol::aad_vault_items_key_wrap_v0_2(&items_key_id);
    let nonce_items = [6u8; 24];
    let enc_items = protocol::aead_seal_ctx(
        &items_wrap_key,
        &nonce_items,
        items_key.as_slice(),
        &aad_items,
    )
    .expect("seal items_key");

    let meta = protocol::VaultMeta {
        account_number_hash: account.hash,
        kdf_params: FAST_TEST_KDF,
        random_salt_password: salt_password,
        random_salt_recovery: salt_recovery,
        nonce_password_wrap: nonce_pw,
        enc_root_key_password: enc_root_pw.as_slice().try_into().expect("64 bytes"),
        nonce_recovery_wrap: nonce_rec,
        enc_root_key_recovery: enc_root_rec.as_slice().try_into().expect("64 bytes"),
        items_key_id,
        items_key_nonce: nonce_items,
        enc_items_key: enc_items.as_slice().try_into().expect("64 bytes"),
        membership: None,
        person_binding: None,
    };
    std::fs::create_dir_all(dir.join("notes")).expect("notes dir");
    std::fs::write(
        dir.join("vault.meta"),
        protocol::serialize_vault_meta_v0_2(&meta),
    )
    .expect("write vault.meta");

    (*root_key, *items_key, items_key_id, MetaVersion::V0_2)
}

/// Write a note blob under `items_key`/`items_key_id` with a fresh UUIDv7.
fn write_note(dir: &Path, items_key: &[u8; 32], items_key_id: &[u8; 16], plaintext: &str) {
    let uuid = myne_format::notes::note_id::NoteId::new_v7();
    let uuid = *uuid.as_uuid();
    let blob = protocol::encode_new_note(
        items_key,
        items_key_id,
        uuid.as_bytes(),
        plaintext.as_bytes(),
    )
    .expect("seal note");
    std::fs::write(dir.join("notes").join(format!("{uuid}.myn")), blob).expect("write note");
}

/// Write an `NC05` (v0.2 CRDT) note blob: a single-`Text` Automerge document
/// sealed through `protocol::encode_crdt_note_blob`. The encode half of the
/// bridge lives in `myne-core` (host clock + actor CSPRNG); here the `save()`
/// bytes are built inline, which is the same shape the `format/` unit test uses.
fn write_nc05_note(dir: &Path, items_key: &[u8; 32], items_key_id: &[u8; 16], plaintext: &str) {
    use automerge::transaction::Transactable;
    use automerge::{AutoCommit, ObjType, ROOT};
    let mut doc = AutoCommit::new();
    let text = doc
        .put_object(
            ROOT,
            myne_format::notes::crdt_decode::NOTE_TEXT_KEY,
            ObjType::Text,
        )
        .expect("root Text object");
    doc.splice_text(&text, 0, 0, plaintext)
        .expect("seed note text");
    let save = doc.save();
    let uuid = myne_format::notes::note_id::NoteId::new_v7();
    let uuid = *uuid.as_uuid();
    let blob = protocol::encode_crdt_note_blob(items_key, items_key_id, uuid.as_bytes(), &save)
        .expect("seal NC05 note");
    std::fs::write(dir.join("notes").join(format!("{uuid}.myn")), blob).expect("write NC05 note");
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!("{nanos}")
}

#[test]
fn round_trip_exports_notes_byte_exactly() {
    let scratch = std::env::temp_dir().join(format!("myne-decrypt-rt-{}", uuid_like()));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let vault_dir = scratch.join("vault");
    std::fs::create_dir_all(&vault_dir).expect("vault dir");

    let (root_key, items_key, items_key_id, version) = build_vault(&vault_dir, "pw");

    let alpha = "---\ntitle: Alpha\nfolder: Projects/\n---\n\n# Alpha\n\nbody with trailing spaces   \nno trailing newline";
    let root_note = "no frontmatter, root note";
    let nc05_note = "---\ntitle: CRDT\n---\n\nan NC05 note body";
    write_note(&vault_dir, &items_key, &items_key_id, alpha);
    write_note(&vault_dir, &items_key, &items_key_id, root_note);
    write_nc05_note(&vault_dir, &items_key, &items_key_id, nc05_note);

    let dest = scratch.join("export-tree");
    let params = StageParams {
        vault_dir: vault_dir.clone(),
        forbidden_roots: vec![vault_dir.clone()],
        destination: dest.clone(),
        scope: None,
        items_key: zeroize::Zeroizing::new(items_key),
        items_key_id,
        root_key: Some(zeroize::Zeroizing::new(root_key)),
        group_key: None,
        version,
        trashed: TrashedMode::Trash,
        best_effort: true,
        history: false,
    };
    let hooks = NoopExportHooks;
    let staged = stage_export_tree(params, &hooks).expect("stage");
    let summary = finalize_export(
        staged,
        &vault_dir,
        zeroize::Zeroizing::new(items_key),
        items_key_id,
        &hooks,
    )
    .expect("finalize");

    assert_eq!(summary.notes, 3);
    assert_eq!(summary.attachments, 0);

    // Byte-verbatim body (frontmatter included, no trailing newline
    // normalization).
    assert_eq!(
        std::fs::read(dest.join("Projects/Alpha.md")).unwrap(),
        alpha.as_bytes()
    );
    assert_eq!(
        std::fs::read(dest.join("Untitled.md")).unwrap(),
        root_note.as_bytes()
    );
    // The NC05 (v0.2 CRDT) note decodes through the same dispatcher.
    assert_eq!(
        std::fs::read(dest.join("CRDT.md")).unwrap(),
        nc05_note.as_bytes()
    );

    std::fs::remove_dir_all(&scratch).ok();
}

/// Best-effort rejection case: a corrupt `.myn` blob is preserved under
/// `_undecodable/`, named in `_FAILED.txt`, and counted in `failed` (which is
/// what the CLI maps to a failure exit), while decodable notes still export.
#[test]
fn best_effort_preserves_and_names_a_corrupt_note() {
    let scratch = std::env::temp_dir().join(format!("myne-decrypt-rt-bad-{}", uuid_like()));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let vault_dir = scratch.join("vault");
    std::fs::create_dir_all(&vault_dir).expect("vault dir");

    let (root_key, items_key, items_key_id, version) = build_vault(&vault_dir, "pw");
    write_note(&vault_dir, &items_key, &items_key_id, "a good note");

    // Random bytes under a well-formed UUIDv7 name: undecodable by
    // construction, with a name the manifest can carry.
    let bad_uuid = myne_format::notes::note_id::NoteId::new_v7();
    let bad_uuid = *bad_uuid.as_uuid();
    let bad_name = format!("{bad_uuid}.myn");
    let bad_bytes = vec![0x75u8; 64];
    std::fs::write(vault_dir.join("notes").join(&bad_name), &bad_bytes).expect("write bad note");

    let dest = scratch.join("export-tree");
    let params = StageParams {
        vault_dir: vault_dir.clone(),
        forbidden_roots: vec![vault_dir.clone()],
        destination: dest.clone(),
        scope: None,
        items_key: zeroize::Zeroizing::new(items_key),
        items_key_id,
        root_key: Some(zeroize::Zeroizing::new(root_key)),
        group_key: None,
        version,
        trashed: TrashedMode::Trash,
        best_effort: true,
        history: false,
    };
    let hooks = NoopExportHooks;
    let staged = stage_export_tree(params, &hooks).expect("stage");
    let summary = finalize_export(
        staged,
        &vault_dir,
        zeroize::Zeroizing::new(items_key),
        items_key_id,
        &hooks,
    )
    .expect("finalize");

    // The distinguishing behavior: preserved, named, counted.
    assert_eq!(summary.failed, 1);
    assert_eq!(
        std::fs::read(dest.join("_undecodable").join(&bad_name)).unwrap(),
        bad_bytes
    );
    let manifest = std::fs::read_to_string(dest.join("_FAILED.txt")).unwrap();
    assert!(manifest.contains(&bad_name), "manifest names the bad note");
    // The good note still exported.
    assert_eq!(summary.notes, 1);

    std::fs::remove_dir_all(&scratch).ok();
}

/// Build a real **person-generation** vault at `dir`: the password wrap on the
/// credential side, `itemsKey` sealed under the GROUP tier, and the group key
/// itself wrapped under the owner's root-tier `GroupKeyWrap`.
///
/// `person_wrap` selects `NTV7` (the generation this branch upgrades away from)
/// or `NTV8` (the password-only generation it writes). Both are built because a
/// `.myne-backup` taken before the upgrade still holds the `NTV7` frame, and the
/// decrypter has to open it.
fn build_person_vault(
    dir: &Path,
    password: &str,
    person_wrap: bool,
) -> ([u8; 32], [u8; 32], [u8; 32], [u8; 16], MetaVersion) {
    let account = protocol::generate_account_number().expect("account");
    let root_key = protocol::generate_root_key().expect("root_key");
    let items_key = protocol::generate_root_key().expect("items_key");
    let group_key = protocol::generate_root_key().expect("group_key");
    let items_key_id = [5u8; 16];
    let salt_password = [1u8; 16];

    let password_wrap_key = protocol::derive_password_wrap_key_v0_2(
        password,
        &salt_password,
        &account.hash,
        &FAST_TEST_KDF,
    )
    .expect("password wrap key");
    let enc_root_pw = protocol::aead_seal_ctx(
        &password_wrap_key,
        &[3u8; 24],
        root_key.as_slice(),
        &protocol::aad_password_wrap_v0_2(&FAST_TEST_KDF),
    )
    .expect("seal password wrap");

    let items_wrap_key = protocol::derive_group_subkey_v0_2(
        &protocol::GroupKey::new(*group_key),
        protocol::GroupRole::ItemsKeyWrap,
    );
    let enc_items = protocol::aead_seal_ctx(
        &items_wrap_key,
        &[6u8; 24],
        items_key.as_slice(),
        &protocol::aad_vault_items_key_wrap_v0_2(&items_key_id),
    )
    .expect("seal items_key");

    let base = protocol::VaultMeta {
        account_number_hash: account.hash,
        kdf_params: FAST_TEST_KDF,
        random_salt_password: salt_password,
        // Retired by both person generations.
        random_salt_recovery: [0u8; 16],
        nonce_password_wrap: [3u8; 24],
        enc_root_key_password: enc_root_pw.as_slice().try_into().expect("64 bytes"),
        nonce_recovery_wrap: [0u8; 24],
        enc_root_key_recovery: [0u8; 64],
        items_key_id,
        items_key_nonce: [6u8; 24],
        enc_items_key: enc_items.as_slice().try_into().expect("64 bytes"),
        membership: None,
        person_binding: None,
    };

    let group_wrap_key = protocol::derive_owner_subkey_v0_2(
        &protocol::OwnerKey::new(*root_key),
        protocol::OwnerRole::GroupKeyWrap,
    );
    let enc_group = protocol::aead_seal_ctx(
        &group_wrap_key,
        &[0xA1u8; 24],
        group_key.as_slice(),
        &protocol::aad_vault_group_key_wrap_v0_2(&account.hash, 1),
    )
    .expect("seal group key");
    let enc_group: [u8; 64] = enc_group.as_slice().try_into().expect("64 bytes");

    let roster = protocol::person_invite::seal_group_roster(
        &group_key,
        &account.hash,
        1,
        &[0x66u8; 24],
        &protocol::person_invite::SignedGroupRoster {
            payload: vec![0xC3; 32],
            signature: protocol::person_key::PersonSigned {
                ed25519_sig: [0xD4; protocol::person_key::PERSON_ED25519_SIG_LEN],
                mldsa_sig: vec![0xE5; protocol::person_key::PERSON_MLDSA_SIG_LEN],
            },
        },
    )
    .expect("sealed roster");

    let bytes = if person_wrap {
        protocol::vault_meta_ntv7::serialize_vault_meta_ntv7(
            &protocol::vault_meta_ntv7::PersonWrappedVaultMeta {
                base,
                group_key_nonce: [0xA1; 24],
                enc_group_key: enc_group,
                group_key_epoch: 1,
                signed_roster_envelope: roster,
                // Sealed to a real keypair, so the frame is what the app writes
                // rather than a block of the right length.
                person_wrap: {
                    let owner = protocol::PersonKeyPair::generate_raw(
                        &[0x31; 64],
                        &[0x32; 32],
                        &[0x33; 32],
                    );
                    protocol::vault_meta_ntv7::seal_root_key_to_person_raw(
                        &owner.public_half(),
                        &root_key,
                        &items_key_id,
                        &mut FixtureRng(7),
                    )
                    .expect("seal root key")
                },
            },
        )
        .expect("serialize NTV7")
    } else {
        protocol::vault_meta_ntv8::serialize_vault_meta_ntv8(
            &protocol::vault_meta_ntv8::PasswordOnlyVaultMeta {
                base,
                group_key_nonce: [0xA1; 24],
                enc_group_key: enc_group,
                group_key_epoch: 1,
                signed_roster_envelope: roster,
            },
        )
        .expect("serialize NTV8")
    };

    std::fs::create_dir_all(dir.join("notes")).expect("notes dir");
    std::fs::write(dir.join("vault.meta"), bytes).expect("write vault.meta");
    (
        *root_key,
        *items_key,
        *group_key,
        items_key_id,
        MetaVersion::V0_2,
    )
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

/// **The acceptance case for the new generation, end to end**: both person
/// generations export their notes through the same walk the CLI runs.
///
/// Scope, stated because the fixture cannot prove more than this: the walk is
/// handed the keys already unwrapped, so this test covers the export over each
/// FRAME rather than the unwrapping. Reading the frame is held by two tests that
/// do fail without it: `myne-format`'s five-generation read of the account hash,
/// and the unlock unit tests in `unlock.rs`, which unwrap the group tier and the
/// `itemsKey` from a real frame of each generation. `NTV7` is here because every
/// `.myne-backup` taken before the upgrade still contains one.
#[test]
fn person_generation_vaults_export_their_notes() {
    for (generation, person_wrap) in [("NTV7", true), ("NTV8", false)] {
        let scratch =
            std::env::temp_dir().join(format!("myne-decrypt-rt-{generation}-{}", uuid_like()));
        std::fs::create_dir_all(&scratch).expect("scratch");
        let vault_dir = scratch.join("vault");
        std::fs::create_dir_all(&vault_dir).expect("vault dir");

        let (root_key, items_key, group_key, items_key_id, version) =
            build_person_vault(&vault_dir, "pw", person_wrap);

        let on_disk = std::fs::read(vault_dir.join("vault.meta")).expect("read meta");
        assert_eq!(&on_disk[..4], generation.as_bytes());
        // The walk's own first question, asked here too: a frame this build
        // cannot place would degrade to "no account" and export anyway, so the
        // fixture's readability is asserted rather than assumed.
        assert!(
            protocol::parse_vault_meta_any(&on_disk).is_ok(),
            "[{generation}] the export walk must be able to read this frame"
        );

        let body = "---\ntitle: From the group tier\n---\n\nbody";
        write_note(&vault_dir, &items_key, &items_key_id, body);

        let dest = scratch.join("export-tree");
        let params = StageParams {
            vault_dir: vault_dir.clone(),
            forbidden_roots: vec![vault_dir.clone()],
            destination: dest.clone(),
            scope: None,
            items_key: zeroize::Zeroizing::new(items_key),
            items_key_id,
            root_key: Some(zeroize::Zeroizing::new(root_key)),
            group_key: Some(zeroize::Zeroizing::new(group_key)),
            version,
            trashed: TrashedMode::Trash,
            best_effort: true,
            history: false,
        };
        let hooks = NoopExportHooks;
        let staged = stage_export_tree(params, &hooks).expect("stage");
        let summary = finalize_export(
            staged,
            &vault_dir,
            zeroize::Zeroizing::new(items_key),
            items_key_id,
            &hooks,
        )
        .expect("finalize");

        assert_eq!(summary.notes, 1, "[{generation}] one note exported");
        assert_eq!(
            std::fs::read(dest.join("From the group tier.md")).unwrap(),
            body.as_bytes(),
            "[{generation}] body byte-exact"
        );
        std::fs::remove_dir_all(&scratch).ok();
    }
}
