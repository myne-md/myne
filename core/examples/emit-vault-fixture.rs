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
const PASSWORD: &str = "fixture-vault-password-7x3k9q";

/// Body of the quarantined note. A distinctive token so a scenario can assert
/// the READ step decrypted it rather than merely listed a filename.
const QUARANTINED_BODY: &str = "quarantined fixture note: quokkazephyr";

fn main() {
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

    let files = collect_slots(&vault_dir);
    assert!(
        !files.is_empty(),
        "the container wrote no slot — a fixture of nothing would seed an empty \
         store and read as a first run"
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
    println!("  ]");
    println!("}}");
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
