// SPDX-License-Identifier: AGPL-3.0-only
//! Emit an unlockable vault carrying one AI conversation as OPFS-ready
//! container bytes (myne-md/myne#675, task 12).
//!
//!   cargo run --release -p myne-core --features test-support \
//!     --example emit-chats-fixture > e2e-web/fixtures/chats-history.json
//!
//! # What the browser lane could not do without this
//!
//! The web lane proves reload persistence of the conversation history: a
//! seeded conversation must be listable, openable, still there after a page
//! reload, and deletable. The agent plugin is `Class::Unsupported` on web, so
//! no run can START there: the lane cannot send its way into a conversation.
//! Seeding the at-rest bytes (the `vault.chats` catalog singleton +
//! `chats/<id-hex>` file, sealed under this vault's own keys) is therefore
//! the only route in, exactly as `emit-vault-fixture` seeds `vault.meta` for
//! unlock.
//!
//! # Why the bytes come from here
//!
//! Same reasoning as the sibling emitter: this drives the app's OWN
//! vault-creation path and seals with the app's OWN codecs
//! (`encode_chats_catalog_blob_raw`, `encode_chats_blob_raw`,
//! `encode_prefs_blob_raw`) through the app's OWN container writer. A catalog
//! assembled in TypeScript would encode a second opinion about the roster
//! JSON, the envelope framing AND the OPFS slot names. A fixture that
//! drifted would have the lane testing history UI against something
//! production never writes.
//!
//! # The password is in the output, deliberately
//!
//! A fixture nobody can unlock is a file, not a fixture (same terms as the
//! sibling emitter).
//!
//! `--release` matters: Argon2id at `m=256 MiB, t=3, p=2` takes tens of seconds
//! in a debug build.

// secret-scan:allow: fixture-generator constant, not a credential
const PASSWORD: &str = "fixture-chats-password-4m8p2r";

/// Fixed conversation id: the fixture must be describable without opening it
/// (the scenario finds the conversation by title, but a stable id keeps the
/// OPFS file set stable across emits).
const CONV_ID: [u8; 16] = [0xC4; 16];

const CONV_TITLE: &str = "Fixture question about tea";
const CREATED_AT: u64 = 1725417600000;

fn main() {
    use myne_core::double_buffer;
    use myne_core::plugins::chats::commands::{ChatsCatalogMap, ConversationEntry};
    use myne_core::plugins::vault_creation::commands::{
        build_and_serialize_vault_meta, build_session,
    };
    use myne_core::test_support::{block_on, ContainerVaultIo, ScopedTempDir};
    use myne_core::vault_io::{VaultIo, WriteOpts};

    let tmp = ScopedTempDir::new("chats-fixture").expect("scratch dir");
    let vault_dir = tmp.path().join("vault");

    let session = build_session(
        myne_core::paths::web_single_vault_id(),
        PASSWORD,
        protocol::DEFAULT_V0_1_KDF_PARAMS,
    )
    .expect("build vault-creation session");
    let meta = build_and_serialize_vault_meta(&session).expect("serialize vault.meta");
    // Birth format is v0.2 (NTV5), so the generation-detecting parse is the
    // honest one: the v0.1-only parser rejects what creation writes today.
    let parsed = protocol::parse_vault_meta_any(&meta).expect("parse the meta we just wrote");
    let account_hash = parsed.account_number_hash;
    // Class-1 content follows the vault's generation (never bare
    // derive_subkey): a born-v0.2 vault seals chats + prefs under v0.2 KEKs.
    let version = protocol::MetaVersion::V0_2;

    block_on(async {
        let io = ContainerVaultIo;
        io.create_dir_all(&vault_dir).await.expect("mkdir");

        // vault.meta through the container (vault.meta.a behind the frame).
        io.write(&vault_dir.join("vault.meta"), &meta, WriteOpts::default())
            .await
            .expect("write vault.meta");

        // vault.prefs with the AI surface on: the ai-chat tab (and its
        // History button) hides while ai_enabled is off, and the web lane
        // has no settings surface that could flip it.
        let prefs_key = protocol::derive_subkey_versioned(
            version,
            &session.root_key,
            protocol::SubkeyRole::PrefsKey,
        );
        let prefs = protocol::PrefsView {
            ai_enabled: true,
            ..Default::default()
        };
        let prefs_blob =
            protocol::encode_prefs_blob_versioned(version, &prefs_key, &account_hash, &prefs)
                .expect("encode vault.prefs");
        io.write(
            &vault_dir.join("vault.prefs"),
            &prefs_blob,
            WriteOpts::default(),
        )
        .await
        .expect("write vault.prefs");

        // vault.chats: the one-row roster, through the container
        // (vault.chats.a; the catalog is Doubled like every singleton).
        let catalog_key = protocol::derive_subkey_versioned(
            version,
            &session.root_key,
            protocol::SubkeyRole::ChatsCatalogKey,
        );
        let conv_hex: String = CONV_ID.iter().map(|b| format!("{b:02x}")).collect();
        let mut roster = ChatsCatalogMap::new();
        roster.insert(
            conv_hex.clone(),
            ConversationEntry {
                created_at: CREATED_AT,
                deleted_at: None,
                folder: None,
                title: CONV_TITLE.to_string(),
                updated_at: CREATED_AT,
                version: 1,
                note_id: None,
            },
        );
        let roster_bytes = serde_json::to_vec(&roster).expect("roster serializes");
        let catalog_blob = protocol::encode_chats_catalog_blob_versioned(
            version,
            &catalog_key,
            &account_hash,
            &roster_bytes,
        )
        .expect("encode vault.chats");
        io.write(
            &vault_dir.join("vault.chats"),
            &catalog_blob,
            WriteOpts::default(),
        )
        .await
        .expect("write vault.chats");

        // chats/<id-hex>: two settled TEXT turns (no agent run; the lane
        // cannot start one on web, and history display needs none).
        // SingleLive: the plain name, no slot suffix.
        let chats_key = protocol::derive_subkey_versioned(
            version,
            &session.root_key,
            protocol::SubkeyRole::ChatsKey,
        );
        let payload = serde_json::json!({
            "title_derived_from": CONV_TITLE,
            "turns": [
                {"id": "a1b2c3d4-0000000001", "kind": "text", "role": "user", "text": "Fixture question about tea"},
                {"id": "a1b2c3d4-0000000002", "kind": "text", "role": "assistant", "text": "Fixture answer: start with last year."},
            ],
        });
        let payload_bytes = serde_json::to_vec(&payload).expect("payload serializes");
        let conv_blob = protocol::encode_chats_blob_versioned(
            version,
            &chats_key,
            &account_hash,
            &CONV_ID,
            &payload_bytes,
        )
        .expect("encode conversation file");
        let chats_dir = vault_dir.join("chats");
        io.create_dir_all(&chats_dir).await.expect("mkdir chats");
        io.write(&chats_dir.join(&conv_hex), &conv_blob, WriteOpts::default())
            .await
            .expect("write conversation file");

        // Read back every file the scenario seeds: the fixture describes
        // what was written, not what the emitter expected to write.
        let mut files: Vec<(String, Vec<u8>)> = Vec::new();
        for slot in double_buffer::SLOT_SUFFIXES {
            for logical in ["vault.meta", "vault.prefs", "vault.chats"] {
                let name = format!("{logical}{slot}");
                if let Ok(bytes) = std::fs::read(vault_dir.join(&name)) {
                    files.push((name, bytes));
                }
            }
        }
        // SingleLive (like notes): two slot NAMES, one file at rest. The
        // write lands on the slot that is not live. Probe both suffixes and
        // carry whichever landed, the collect_named discipline.
        let mut conv_landed: Option<(String, Vec<u8>)> = None;
        for slot in double_buffer::SLOT_SUFFIXES {
            let name = format!("{conv_hex}{slot}");
            if let Ok(bytes) = std::fs::read(chats_dir.join(&name)) {
                conv_landed = Some((format!("chats/{name}"), bytes));
                break;
            }
        }
        let (conv_name, conv_bytes) = conv_landed.expect("conversation file readable in some slot");
        files.push((conv_name, conv_bytes));

        assert!(
            files.iter().any(|(n, _)| n == "vault.meta.a"),
            "no vault.meta slot: without it the fixture describes a first run, not an unlock"
        );
        assert!(
            files.iter().any(|(n, _)| n == "vault.prefs.a"),
            "no vault.prefs slot: without ai_enabled the ai-chat tab stays hidden"
        );
        assert!(
            files.iter().any(|(n, _)| n == "vault.chats.a"),
            "no vault.chats slot: without the roster the history list is empty"
        );

        println!("{{");
        println!("  \"_note\": \"secret-scan:allow: fixture unlock password, not a credential\",");
        println!("  \"password\": \"{PASSWORD}\",");
        println!("  \"files\": [");
        for (i, (name, bytes)) in files.iter().enumerate() {
            println!(
                "    {{ \"name\": \"{}\", \"bytes\": [{}] }}{}",
                name,
                bytes
                    .iter()
                    .map(|b| b.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
                if i + 1 == files.len() { "" } else { "," }
            );
        }
        println!("  ]");
        println!("}}");
    });
}
