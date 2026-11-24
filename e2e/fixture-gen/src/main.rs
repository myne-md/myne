// SPDX-License-Identifier: AGPL-3.0-only
//! CLI for the E2E fixture generator. Invoked by the TS harness
//! (`e2e/support/fixtures.ts::seedVault`) via
//! `cargo run --release -p e2e-fixture-gen -- …`.
//!
//!   e2e-fixture-gen --base <app-data-dir> [--count N] [--kdf weak|production] [--password <pw>] [--export-suite]
//!
//! Writes `<base>/vaults/<uuidv7>/vault.meta` per vault and prints one
//! JSON object to stdout:
//!   {"vaults":[{"vaultId":"…","password":"…","phrase":"…","account":"…"}]}
//!
//! `--export-suite` additionally lays the MYND-116 note-export suite
//! into every generated vault (a plain note + an attachments note with
//! two colliding-filename form-C embeds + MYA1 blobs + MYC1 catalog)
//! and extends each vault entry with an `"exportSuite":{…}` object
//! carrying the ids and exact plaintexts the scenario asserts against.
//!
//! Hand-rolled arg parsing + JSON emit — this binary deliberately adds
//! no clap/serde_json to the workspace (dependency-policy discipline);
//! the emitted fields are structurally JSON-safe (uuid hyphenated,
//! lowercase BIP-39 words, uppercase Crockford display) except the
//! password, which gets a minimal escaper.

use std::path::PathBuf;
use std::process::ExitCode;

use e2e_fixture_gen::{
    build_fixture_in, offsets, write_export_suite, write_fixture, write_import_source_suite,
    DEFAULT_FIXTURE_GENERATION, WEAK_TEST_KDF,
};
use protocol::{MetaVersion, DEFAULT_V0_1_KDF_PARAMS};

const DEFAULT_PASSWORD: &str = "e2e-fixture-password-1";

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn usage() -> ExitCode {
    eprintln!(
        "usage: e2e-fixture-gen --base <app-data-dir> [--count N] [--kdf weak|production] [--password <pw>] [--export-suite] [--import-source-suite] [--generation v0.1|v0.2]"
    );
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let mut base: Option<PathBuf> = None;
    let mut count: usize = 1;
    let mut kdf = WEAK_TEST_KDF;
    let mut password = DEFAULT_PASSWORD.to_string();
    let mut export_suite = false;
    let mut import_source_suite = false;
    // The product's birth format unless the caller asks for a pre-flip vault.
    let mut generation = DEFAULT_FIXTURE_GENERATION;
    let mut generation_explicit = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--base" => match args.next() {
                Some(v) => base = Some(PathBuf::from(v)),
                None => return usage(),
            },
            "--count" => match args.next().and_then(|v| v.parse().ok()) {
                Some(v) if v >= 1 => count = v,
                _ => return usage(),
            },
            "--kdf" => match args.next().as_deref() {
                Some("weak") => kdf = WEAK_TEST_KDF,
                Some("production") => kdf = DEFAULT_V0_1_KDF_PARAMS,
                _ => return usage(),
            },
            "--password" => match args.next() {
                Some(v) if protocol::validate_min_length(&v).is_ok() => password = v,
                Some(_) => {
                    eprintln!(
                        "error: password below protocol::MIN_PASSWORD_LEN ({} chars)",
                        protocol::MIN_PASSWORD_LEN
                    );
                    return ExitCode::from(2);
                }
                None => return usage(),
            },
            "--export-suite" => export_suite = true,
            "--import-source-suite" => import_source_suite = true,
            "--generation" => match args.next().as_deref() {
                Some("v0.1") => {
                    generation = MetaVersion::V0_1;
                    generation_explicit = true;
                }
                Some("v0.2") => {
                    generation = MetaVersion::V0_2;
                    generation_explicit = true;
                }
                _ => return usage(),
            },
            _ => return usage(),
        }
    }
    let Some(base) = base else { return usage() };

    // The export suite is MY01/MYA1/MYC1 by construction (see its doc comment),
    // so it pins the vault to v0.1 rather than producing a hybrid. An explicit
    // `--generation v0.2` alongside it is a contradiction, not a preference.
    if export_suite {
        if generation_explicit && generation != MetaVersion::V0_1 {
            eprintln!("error: --export-suite writes v0.1 blobs; it cannot be combined with --generation v0.2");
            return ExitCode::from(2);
        }
        generation = MetaVersion::V0_1;
    }

    // Same pin, same reason: the import-source suite writes MY01/MYA1/MYC1.
    if import_source_suite {
        if generation_explicit && generation != MetaVersion::V0_1 {
            eprintln!("error: --import-source-suite writes v0.1 blobs; it cannot be combined with --generation v0.2");
            return ExitCode::from(2);
        }
        generation = MetaVersion::V0_1;
    }

    // The suite goes into the LAST vault only. A vault-import scenario needs a
    // target and a source, and laying the source's content into both would give
    // the target the very titles the collision rules are supposed to meet for
    // the first time during the import.
    if import_source_suite && count < 2 {
        eprintln!(
            "error: --import-source-suite needs --count 2 or more (the last vault is the source)"
        );
        return ExitCode::from(2);
    }

    let mut entries = Vec::with_capacity(count);
    for index in 0..count {
        let fixture = match build_fixture_in(generation, &password, kdf) {
            Ok(f) => f,
            Err(_) => {
                // ProtocolError variants are unit-like; no secrets leak,
                // but keep the message generic anyway.
                eprintln!("error: fixture build failed (protocol error)");
                return ExitCode::FAILURE;
            }
        };
        if let Err(e) = write_fixture(&base, &fixture) {
            eprintln!("error: write failed: {}", e.kind());
            return ExitCode::FAILURE;
        }
        // The export-suite JSON rides each vault entry so the TS layer
        // (e2e/support/fixtures.ts) asserts against the EXACT bytes this
        // binary wrote — note plaintexts are in-source scenario content,
        // not credentials (SYNC-13 applies to passwords/phrases only).
        let mut export_suite_json = String::new();
        if export_suite {
            let suite = match write_export_suite(&base, &fixture) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("error: export-suite write failed: {}", e.kind());
                    return ExitCode::FAILURE;
                }
            };
            let attachment_json = |a: &e2e_fixture_gen::ExportSuiteAttachment| {
                format!(
                    "{{\"idHex\":\"{}\",\"filename\":\"{}\",\"contents\":\"{}\",\"contentType\":\"{}\"}}",
                    a.id_hex,
                    json_escape(&a.filename),
                    json_escape(&a.contents),
                    json_escape(&a.content_type),
                )
            };
            let attachments_json: Vec<String> =
                suite.attachments.iter().map(&attachment_json).collect();
            export_suite_json = format!(
                ",\"exportSuite\":{{\"plainNoteId\":\"{}\",\"plainNotePlaintext\":\"{}\",\"attachmentsNoteId\":\"{}\",\"attachmentsNotePlaintext\":\"{}\",\"attachments\":[{}],\"pdfNoteId\":\"{}\",\"pdfNotePlaintext\":\"{}\",\"pdfAttachment\":{}}}",
                suite.plain_note_id,
                json_escape(&suite.plain_note_plaintext),
                suite.attachments_note_id,
                json_escape(&suite.attachments_note_plaintext),
                attachments_json.join(","),
                suite.pdf_note_id,
                json_escape(&suite.pdf_note_plaintext),
                attachment_json(&suite.pdf_attachment),
            );
        }
        let mut import_source_json = String::new();
        if import_source_suite && index + 1 == count {
            let suite = match write_import_source_suite(&base, &fixture) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("error: import-source-suite write failed: {}", e.kind());
                    return ExitCode::FAILURE;
                }
            };
            import_source_json = format!(
                ",\"importSourceSuite\":{{\"linkingNoteTitle\":\"{}\",\"collidingLinkedTitle\":\"{}\",\"collidingUnlinkedTitle\":\"{}\",\"untitledBody\":\"{}\",\"trashedTitle\":\"{}\",\"templateTitle\":\"{}\",\"referencedAttachmentId\":\"{}\",\"unreferencedAttachmentId\":\"{}\",\"tombstonedAttachmentId\":\"{}\",\"brokenLinkTarget\":\"{}\",\"dictionaryWordNotWritten\":\"{}\",\"ignoredWordNotWritten\":\"{}\"}}",
                json_escape(&suite.linking_note_title),
                json_escape(&suite.colliding_linked_title),
                json_escape(&suite.colliding_unlinked_title),
                json_escape(&suite.untitled_body),
                json_escape(&suite.trashed_title),
                json_escape(&suite.template_title),
                suite.referenced_attachment_id,
                suite.unreferenced_attachment_id,
                suite.tombstoned_attachment_id,
                json_escape(&suite.broken_link_target),
                json_escape(&suite.dictionary_word_not_written),
                json_escape(&suite.ignored_word_not_written),
            );
        }
        entries.push(format!(
            "{{\"vaultId\":\"{}\",\"password\":\"{}\",\"phrase\":\"{}\",\"account\":\"{}\"{}{}}}",
            fixture.vault_id,
            json_escape(&fixture.password),
            fixture.phrase,
            fixture.account,
            export_suite_json,
            import_source_json,
        ));
    }

    // Emit the offset table alongside — the TS mirror
    // (e2e/support/fixtures.ts) verifies itself against this on every
    // seed, so a desynced mirror throws instead of tampering the wrong
    // field.
    let offsets_json = format!(
        "{{\"MAGIC\":{},\"ACCOUNT_HASH\":{},\"KDF_PARAMS\":{},\"SALT_PASSWORD\":{},\"SALT_RECOVERY\":{},\"NONCE_PASSWORD_WRAP\":{},\"ENC_ROOT_KEY_PASSWORD\":{},\"NONCE_RECOVERY_WRAP\":{},\"ENC_ROOT_KEY_RECOVERY\":{},\"ITEMS_KEY_ID\":{},\"ITEMS_KEY_NONCE\":{},\"ENC_ITEMS_KEY\":{},\"END\":{}}}",
        offsets::MAGIC,
        offsets::ACCOUNT_HASH,
        offsets::KDF_PARAMS,
        offsets::SALT_PASSWORD,
        offsets::SALT_RECOVERY,
        offsets::NONCE_PASSWORD_WRAP,
        offsets::ENC_ROOT_KEY_PASSWORD,
        offsets::NONCE_RECOVERY_WRAP,
        offsets::ENC_ROOT_KEY_RECOVERY,
        offsets::ITEMS_KEY_ID,
        offsets::ITEMS_KEY_NONCE,
        offsets::ENC_ITEMS_KEY,
        offsets::END,
    );
    println!(
        "{{\"vaults\":[{}],\"offsets\":{}}}",
        entries.join(","),
        offsets_json
    );
    ExitCode::SUCCESS
}
