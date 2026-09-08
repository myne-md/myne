// SPDX-License-Identifier: AGPL-3.0
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
        root_key: zeroize::Zeroizing::new(root_key),
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
