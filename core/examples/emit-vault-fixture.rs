// SPDX-License-Identifier: AGPL-3.0
//! Emit a complete, unlockable vault as OPFS-ready container bytes
//! (phase3-web-client tasks 87 + 105).
//!
//!   cargo run --release -p myne-core --features test-support \
//!     --example emit-vault-fixture > e2e-web/fixtures/unlockable-vault.json
//!
//! # What the browser lane could not do without this
//!
//! The web client is sync-required for SIGN-IN, but not for UNLOCK: unlocking
//! reads `vault.meta` and derives a key, and never touches a server. So a lane
//! with a seeded `vault.meta` can reach an unlocked vault with no sync server at
//! all — which is what makes the conflict/quarantine surfaces (task 87) and the
//! post-unlock screens testable in CI, where there is no server to sign into.
//!
//! # Why the bytes come from here
//!
//! Same reasoning as the crash fixtures: this drives the app's OWN
//! vault-creation path (`build_session` + `build_and_serialize_vault_meta`) and
//! frames the result with the app's OWN container writer. A `vault.meta`
//! assembled in TypeScript would encode a second opinion about a 345-byte
//! layout AND about the container framing around it, and a fixture that drifted
//! would have the lane testing an unlock of something production never writes.
//!
//! # The password is in the output, deliberately
//!
//! A fixture nobody can unlock is a file, not a fixture. It is a throwaway
//! vault with no notes, minted fresh on every run, and it never touches a
//! server — the credential is meaningful only against these exact bytes.
//!
//! `--release` matters: Argon2id at `m=256 MiB, t=3, p=2` takes tens of seconds
//! in a debug build.

use myne_core::double_buffer;
use myne_core::plugins::vault_creation::commands::{build_and_serialize_vault_meta, build_session};
use myne_core::test_support::{block_on, ContainerVaultIo, ScopedTempDir};
use myne_core::vault_io::{VaultIo, WriteOpts};
use std::path::Path;

/// Fixed so a re-run produces a fixture the same scenarios can unlock. Not a
/// secret in any sense that matters: it opens one throwaway vault whose bytes
/// are regenerated on every emit.
// secret-scan:allow, fixture-generator constant, not a credential
const PASSWORD: &str = "fixture-vault-password-7x3k9q";

/// Body of the quarantined note. A distinctive token so a scenario can assert
/// the READ step decrypted it rather than merely listed a filename.
const QUARANTINED_BODY: &str = "quarantined fixture note: quokkazephyr";

/// The 24 words a `--person` fixture's identity is derived from, normalized
/// (single spaces, lowercase). The browser lane types these into the identity
/// phrase door, so this string IS the credential the scenario uses; the unlock
/// path derives the same keypair from the same words.
// secret-scan:allow, fixture-generator constant, not a credential
const PERSON_PHRASE: &str = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";

fn main() {
    if std::env::args().any(|a| a == "--person") {
        emit_person_fixture();
        return;
    }
    let tmp = ScopedTempDir::new("vault-fixture").expect("scratch dir");
    let vault_dir = tmp.path().join("vault");

    let session = build_session(
        myne_core::paths::web_single_vault_id(),
        PASSWORD,
        protocol::DEFAULT_V0_1_KDF_PARAMS,
    )
    .expect("build vault-creation session");
    let meta = build_and_serialize_vault_meta(&session).expect("serialize vault.meta");

    // Write through the CONTAINER, not to a plain path: what the browser reads
    // is `vault.meta.a` behind an 8-byte generation frame, and a fixture
    // carrying the raw 345 bytes would be unreadable there in a way that looks
    // like corruption.
    block_on(async {
        let io = ContainerVaultIo;
        io.create_dir_all(&vault_dir).await.expect("mkdir");
        io.write(&vault_dir.join("vault.meta"), &meta, WriteOpts::default())
            .await
            .expect("write vault.meta");
    });

    // A quarantined note, encrypted under this vault's OWN itemsKey — which
    // means deriving it back out of the meta we just built, because
    // `build_and_serialize_vault_meta` mints the key internally and hands back
    // only the 345 bytes. Reading it back is the point: a fixture note wrapped
    // under a key the vault does not hold would fail at the AEAD tag and read
    // as corruption, which is the one failure this fixture must not fake
    // (task 87's `read` step).
    let parsed = protocol::parse_vault_meta(&meta).expect("parse the meta we just wrote");
    let items_key = protocol::derive_items_key(&session.root_key, &parsed)
        .expect("derive itemsKey from the fixture's own meta");
    let quar_uuid = uuid::Uuid::now_v7();
    let quar_note = protocol::encode_new_note(
        &items_key,
        &parsed.items_key_id,
        quar_uuid.as_bytes(),
        QUARANTINED_BODY.as_bytes(),
    )
    .expect("encode the quarantined note");

    // `quarantine/<uuid>.myn` — the name `parse_quarantine_file_name` accepts.
    // Written PLAIN, not through the container: staged trees are `SingleLive`
    // in production, and this fixture describes the file the reader opens.
    block_on(async {
        let io = ContainerVaultIo;
        let quar_dir = vault_dir.join("quarantine");
        io.create_dir_all(&quar_dir)
            .await
            .expect("mkdir quarantine");
        io.write(
            &quar_dir.join(format!("{quar_uuid}.myn")),
            &quar_note,
            WriteOpts::default(),
        )
        .await
        .expect("write quarantined note");
    });

    // ── the awaiting-approval state (MYND-635) ──────────────────────────────
    //
    // What a browser holds after a join that came back pending: a device
    // identity persisted, NO token, and an endpoint configured. `sync_status`
    // reads exactly that triple and answers `Pending`, which is what boot
    // routing consults — so seeding it is how a lane with no sync server can
    // reproduce the state the whole bug lives in.
    //
    // Written through the same container writer as everything else, and that is
    // not incidental: `sync-state.json` and `sync-config.json` are BOTH in
    // `DOUBLE_BUFFERED`, so what the client opens is `sync-state.json.a` behind
    // an 8-byte generation frame. A fixture carrying the plain JSON would be
    // unreadable in a way that looks like a device which never enrolled — the
    // precise wrong answer, since the test would then pass against a client that
    // had regressed.
    //
    // No token file is written, deliberately. Its ABSENCE is half the
    // definition of pending; a fixture that included one would describe an
    // approved device and quietly stop testing anything.
    let config_dir = tmp.path().join("config");
    block_on(async {
        let io = ContainerVaultIo;
        let st = myne_core::plugins::sync::state::SyncState {
            device_id_hex: Some("a1".repeat(16)),
            account_hash_hex: Some(hex_of(&parsed.account_number_hash)),
            ..Default::default()
        };
        myne_core::plugins::sync::state::write_sync_state(&io, &vault_dir, &st)
            .await
            .expect("write sync-state.json");

        io.create_dir_all(&config_dir).await.expect("mkdir config");
        let cfg = myne_core::plugins::sync::config::SyncEndpointConfig {
            endpoint_url: Some(String::from("https://sync.example.test")),
            cert_pin_hex: None,
            invite_code: None,
        };
        myne_core::plugins::sync::config::write_config(
            &io,
            &config_dir.join("sync-config.json"),
            &cfg,
        )
        .await
        .expect("write sync-config.json");
    });

    let files = collect_slots(&vault_dir);
    assert!(
        !files.is_empty(),
        "the container wrote no slot — a fixture of nothing would seed an empty \
         store and read as a first run"
    );
    // Kept OUT of `files` on purpose. `files` is what every existing scenario
    // seeds to get an unlockable vault, and folding the pending state into it
    // would silently turn those into pending scenarios — `unlock-from-fixture`
    // would stop testing an unlock. A scenario opts INTO awaiting-approval by
    // seeding these two extra arrays; seeding `files` alone still describes a
    // plain vault with sync unconfigured.
    let pending_files = collect_named(&vault_dir, "sync-state.json");
    assert!(
        !pending_files.is_empty(),
        "no sync-state slot — without a persisted device identity the fixture \
         describes a device that never enrolled, and the pending scenario would \
         quietly become a first-run one"
    );
    let config_files = collect_named(&config_dir, "sync-config.json");
    assert!(
        !config_files.is_empty(),
        "no sync-config slot — without an endpoint the status derivation answers \
         Disabled, and the pending fixture would describe nothing"
    );

    println!("{{");
    println!("  \"password\": \"{PASSWORD}\",");
    println!(
        "  \"accountNumber\": \"{}\",",
        session.account.display.replace('"', "")
    );
    println!("  \"quarantinedBody\": \"{QUARANTINED_BODY}\",");
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
    println!("  ],");
    println!("  \"pendingFiles\": [");
    for (i, (name, bytes)) in pending_files.iter().enumerate() {
        println!(
            "    {{ \"name\": \"{}\", \"bytes\": [{}] }}{}",
            name,
            bytes
                .iter()
                .map(|b| b.to_string())
                .collect::<Vec<_>>()
                .join(","),
            if i + 1 == pending_files.len() {
                ""
            } else {
                ","
            }
        );
    }
    println!("  ],");
    println!("  \"configFiles\": [");
    for (i, (name, bytes)) in config_files.iter().enumerate() {
        println!(
            "    {{ \"name\": \"{}\", \"bytes\": [{}] }}{}",
            name,
            bytes
                .iter()
                .map(|b| b.to_string())
                .collect::<Vec<_>>()
                .join(","),
            if i + 1 == config_files.len() { "" } else { "," }
        );
    }
    println!("  ]");
    println!("}}");
}

/// Emit a PERSON-WRAPPED (`NTV7`) vault (myne-md/myne#911 task 13).
///
/// **The fixture pins `NTV7` on purpose, and creation no longer produces it.** A
/// person-born vault is `NTV8` since myne-md/myne#938 (`decisions/protocol/0758`):
/// the person wrap is gone, so no phrase opens it and the identity door does not
/// render for one. `NTV7` stays READABLE forever, and the browser lane's
/// identity-phrase scenario is that promise's only proof, so the bytes are built
/// by taking creation's own `NTV8` frame and re-sealing the person wrap onto it
/// with the SAME `seal_root_key_to_person_raw` the `NTV7` migration uses. A
/// hand-assembled frame would encode a second opinion about the 1208-byte tail.
///
/// Drives the same creation path the app does, with an identity derived from
/// [`PERSON_PHRASE`], so the browser lane can prove that a page offers the
/// identity-phrase door and that it opens the vault. Two parameters are pinned
/// rather than chosen here:
///
/// - the identity seed derives under `DEFAULT_V0_1_KDF_PARAMS`, because the
///   UNLOCK path derives it under exactly that set (`derive_keys_from_person_phrase`).
///   A fixture minted under the fast test parameters would produce a different
///   keypair from the same words and the person wrap would never open, which is
///   a fixture bug that reads as a product bug.
/// - the vault's own KDF is the default too, so the password path costs what a
///   real vault costs.
///
/// `--release` is therefore not optional: two 256 MiB Argon2id derivations.
fn emit_person_fixture() {
    use myne_core::plugins::vault_creation::state::CreationPerson;

    let tmp = ScopedTempDir::new("vault-fixture-person").expect("scratch dir");
    let vault_dir = tmp.path().join("vault");

    let person_id = protocol::kdf::person_id_hash(PERSON_PHRASE);
    let seed = protocol::kdf::derive_person_identity_seed(
        PERSON_PHRASE,
        &person_id,
        &protocol::DEFAULT_V0_1_KDF_PARAMS,
    )
    .expect("identity seed");
    let seeds = protocol::kdf::expand_person_identity_key_seeds(&seed);
    let pair = protocol::PersonKeyPair::generate_raw(&seeds.kem, &seeds.ed25519, &seeds.mldsa);
    let person = CreationPerson {
        pair,
        person_id,
        number: protocol::account_number_from_person_id(&person_id),
    };

    let session = myne_core::plugins::vault_creation::commands::build_person_session(
        myne_core::paths::web_single_vault_id(),
        PASSWORD,
        protocol::DEFAULT_V0_1_KDF_PARAMS,
        // Cloned because the wrap below needs the owner's public half and the
        // session owns the keypair.
        person.clone(),
    )
    .expect("build person-born creation session");
    let (password_only_bytes, _group_key) =
        myne_core::plugins::vault_creation::commands::build_and_serialize_person_vault_meta(
            &session,
        )
        .expect("serialize password-only vault.meta");

    // Re-seal the person wrap that `NTV8` deliberately omits. `root_key` is the
    // session's own, the `items_key_id` comes from the frame creation just built,
    // and the sealing call is the one the `NTV7` migration uses, so the tail is
    // the real one rather than a reimplementation.
    let owner_public = person.pair.public_half();
    let password_only = protocol::parse_vault_meta_ntv8(&password_only_bytes)
        .expect("re-parse the frame creation wrote");
    let mut rng = rand_core::UnwrapErr(myne_core::rng::OsRng);
    let person_wrap = protocol::seal_root_key_to_person_raw(
        &owner_public,
        &session.root_key,
        &password_only.base.items_key_id,
        &mut rng,
    )
    .expect("seal root_key to the owner's person key");
    let frame = protocol::PersonWrappedVaultMeta {
        base: password_only.base,
        group_key_nonce: password_only.group_key_nonce,
        enc_group_key: password_only.enc_group_key,
        group_key_epoch: password_only.group_key_epoch,
        signed_roster_envelope: password_only.signed_roster_envelope,
        person_wrap,
    };
    let meta = protocol::serialize_vault_meta_ntv7(&frame)
        .expect("serialize the NTV7 frame the browser lane reads");

    block_on(async {
        let io = ContainerVaultIo;
        io.create_dir_all(&vault_dir).await.expect("mkdir");
        io.write(&vault_dir.join("vault.meta"), &meta, WriteOpts::default())
            .await
            .expect("write vault.meta");
    });

    let files = collect_slots(&vault_dir);
    println!("{{");
    println!("  \"//\": \"person-wrapped NTV7 fixture, emit-vault-fixture --person\",");
    println!("  \"password\": \"{}\",", PASSWORD);
    println!("  \"phrase\": \"{}\",", PERSON_PHRASE);
    println!("  \"accountNumber\": \"\",");
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
    println!("  ],");
    println!("  \"pendingFiles\": [],");
    println!("  \"configFiles\": []");
    println!("}}");
}

/// Lowercase hex, so the fixture's `account_hash_hex` matches what the join
/// would have persisted (it is the SCRAM username — see `state.rs`).
fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Every container slot the writer produced for one logical name, read back
/// rather than assumed — same discipline as [`collect_slots`].
fn collect_named(dir: &Path, logical: &str) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for slot in double_buffer::SLOT_SUFFIXES {
        let name = format!("{logical}{slot}");
        if let Ok(bytes) = std::fs::read(dir.join(&name)) {
            out.push((name, bytes));
        }
    }
    out
}

/// Every slot file the container actually produced, by name — read back rather
/// than assumed, so the fixture describes what was written instead of what the
/// emitter expected to be written.
fn collect_slots(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for slot in double_buffer::SLOT_SUFFIXES {
        let name = format!("vault.meta{slot}");
        if let Ok(bytes) = std::fs::read(dir.join(&name)) {
            out.push((name, bytes));
        }
    }
    // Whatever the staged trees hold, under their real relative names — read
    // back rather than assumed, same discipline as the slots above.
    for sub in ["quarantine", "conflicts"] {
        let Ok(entries) = std::fs::read_dir(dir.join(sub)) else {
            continue;
        };
        let mut names: Vec<_> = entries.flatten().map(|e| e.file_name()).collect();
        names.sort();
        for name in names {
            let rel = format!("{sub}/{}", name.to_string_lossy());
            if let Ok(bytes) = std::fs::read(dir.join(sub).join(&name)) {
                out.push((rel, bytes));
            }
        }
    }
    out
}
