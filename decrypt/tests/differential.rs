// SPDX-License-Identifier: AGPL-3.0-only
//! Differential test: the app's export path and the CLI's export path are the
//! SAME walk (`myne_format::export_walk`), so the only divergence is the mode
//! parameters. This test runs the walk twice over one fixture. Once with the
//! app's parameters (`TrashedMode::Exclude`, `best_effort: false`) and once with
//! the CLI's (`TrashedMode::Trash`, `best_effort: true`), which asserts the
//! non-trashed, non-failed notes are byte-identical between the two runs.
//!
//! Crypto primitive choice is not under test (RustCrypto is trusted); this
//! exercises the mode split and the shared tree mapping.

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

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!("{nanos}")
}

/// Run the walk with the given mode parameters and return the exported tree as
/// a `(relative path, bytes)` map, excluding the reserved `_trash/` and
/// `_undecodable/` dirs (which differ by mode by design).
#[allow(clippy::too_many_arguments)]
fn export_tree(
    vault_dir: &Path,
    items_key: [u8; 32],
    items_key_id: [u8; 16],
    root_key: [u8; 32],
    version: MetaVersion,
    dest: &Path,
    trashed: TrashedMode,
    best_effort: bool,
) -> std::collections::BTreeMap<String, Vec<u8>> {
    let params = StageParams {
        vault_dir: vault_dir.to_path_buf(),
        forbidden_roots: vec![vault_dir.to_path_buf()],
        destination: dest.to_path_buf(),
        scope: None,
        items_key: zeroize::Zeroizing::new(items_key),
        items_key_id,
        root_key: Some(zeroize::Zeroizing::new(root_key)),
        group_key: None,
        version,
        trashed,
        best_effort,
        history: false,
    };
    let hooks = NoopExportHooks;
    let staged = stage_export_tree(params, &hooks).expect("stage");
    finalize_export(
        staged,
        vault_dir,
        zeroize::Zeroizing::new(items_key),
        items_key_id,
        &hooks,
    )
    .expect("finalize");

    let mut out = std::collections::BTreeMap::new();
    fn walk(dir: &Path, prefix: &str, out: &mut std::collections::BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if entry.file_type().unwrap().is_dir() {
                walk(&entry.path(), &rel, out);
            } else {
                out.insert(rel, std::fs::read(entry.path()).unwrap());
            }
        }
    }
    walk(dest, "", &mut out);
    out
}

#[test]
fn app_and_cli_modes_produce_identical_shared_notes() {
    let scratch = std::env::temp_dir().join(format!("myne-decrypt-diff-{}", uuid_like()));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let vault_dir = scratch.join("vault");
    std::fs::create_dir_all(&vault_dir).expect("vault dir");

    let (root_key, items_key, items_key_id, version) = build_vault(&vault_dir, "pw");

    let live = "---\ntitle: Live\nfolder: A/\n---\n\nlive body";
    let trashed = "---\ntitle: Gone\ntrashed: 2026-06-01T00:00:00Z\n---\ntrashed body";
    write_note(&vault_dir, &items_key, &items_key_id, live);
    write_note(&vault_dir, &items_key, &items_key_id, trashed);

    let app_dest = scratch.join("app-tree");
    let cli_dest = scratch.join("cli-tree");

    let app_tree = export_tree(
        &vault_dir,
        items_key,
        items_key_id,
        root_key,
        version,
        &app_dest,
        TrashedMode::Exclude,
        false,
    );
    let cli_tree = export_tree(
        &vault_dir,
        items_key,
        items_key_id,
        root_key,
        version,
        &cli_dest,
        TrashedMode::Trash,
        true,
    );

    // The live note is byte-identical in both modes.
    assert_eq!(app_tree.get("A/Live.md"), cli_tree.get("A/Live.md"));
    // The app excludes the trashed note; the CLI writes it into _trash/.
    assert!(!app_tree.contains_key("_trash/Gone.md"));
    assert!(cli_tree.contains_key("_trash/Gone.md"));

    std::fs::remove_dir_all(&scratch).ok();
}
