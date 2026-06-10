// SPDX-License-Identifier: AGPL-3.0-or-later
//! CLI for the E2E fixture generator. Invoked by the TS harness
//! (`e2e/support/fixtures.ts::seedVault`) via
//! `cargo run --release -p e2e-fixture-gen -- …`.
//!
//!   e2e-fixture-gen --base <app-data-dir> [--count N] [--kdf weak|production] [--password <pw>]
//!
//! Writes `<base>/vaults/<uuidv7>/vault.meta` per vault and prints one
//! JSON object to stdout:
//!   {"vaults":[{"vaultId":"…","password":"…","phrase":"…","account":"…"}]}
//!
//! Hand-rolled arg parsing + JSON emit — this binary deliberately adds
//! no clap/serde_json to the workspace (dependency-policy discipline);
//! the emitted fields are structurally JSON-safe (uuid hyphenated,
//! lowercase BIP-39 words, uppercase Crockford display) except the
//! password, which gets a minimal escaper.

use std::path::PathBuf;
use std::process::ExitCode;

use e2e_fixture_gen::{build_fixture, offsets, write_fixture, WEAK_TEST_KDF};
use protocol::DEFAULT_V0_1_KDF_PARAMS;

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
        "usage: e2e-fixture-gen --base <app-data-dir> [--count N] [--kdf weak|production] [--password <pw>]"
    );
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let mut base: Option<PathBuf> = None;
    let mut count: usize = 1;
    let mut kdf = WEAK_TEST_KDF;
    let mut password = DEFAULT_PASSWORD.to_string();

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
            _ => return usage(),
        }
    }
    let Some(base) = base else { return usage() };

    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        let fixture = match build_fixture(&password, kdf) {
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
        entries.push(format!(
            "{{\"vaultId\":\"{}\",\"password\":\"{}\",\"phrase\":\"{}\",\"account\":\"{}\"}}",
            fixture.vault_id,
            json_escape(&fixture.password),
            fixture.phrase,
            fixture.account,
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
