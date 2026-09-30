// Approve every pending device on an account, from source, without a GUI
// (phase3-web-client task 105 — the other half of the fixture seeder).
//
//   cargo run --release --example approve-device -- \
//     https://sync.myne.md <account-number> <recovery-phrase>
//
// # Why this exists
//
// A browser signing in with {account number + password} lands **pending** by
// design — the password path never self-approves, because an attacker who
// guessed a password would otherwise enrol silently. Approval comes from a
// device that already has access. So an end-to-end test of the web sign-in
// path needs the second half of a two-device flow, and on a machine where the
// desktop GUI cannot be driven (see `seed-account.rs`) there was no way to
// produce it.
//
// This authenticates on the RECOVERY path — the bootstrap exception that
// self-approves — reads the device roster, and approves everything pending.
//
// # What it skips, and says so
//
// **The SAS comparison.** In the app, approval is gated on a human reading a
// short code on both screens and confirming they match, which is what makes the
// approval resistant to a server that swapped the pending device. This tool
// approves whatever is pending. That is acceptable for a throwaway test account
// and unacceptable for a real one — the same reason `seed-account` prints the
// recovery phrase. Never point either at an account holding real notes.

use myne_core::plugins::sync::devices::{approve_device, list_devices, pending_devices};
use myne_core::plugins::sync::enroll::{enroll, EnrollPath};
use myne_core::plugins::sync::rustls_transport::RustlsTransport;

fn main() {
    let mut args = std::env::args().skip(1);
    let usage = "usage: approve-device <server-url> <account-number> <recovery-phrase>";
    let server = args.next().unwrap_or_else(|| die(usage));
    let account_input = args.next().unwrap_or_else(|| die(usage));
    let phrase_input = args.next().unwrap_or_else(|| die(usage));
    if args.next().is_some() {
        die(usage);
    }

    let account = protocol::parse_account_number(&account_input).expect("valid account number");

    let url = server.trim_end_matches('/').to_string();
    let rest = url
        .strip_prefix("https://")
        .unwrap_or_else(|| die("server url must be https://"));
    let (host, port) = match rest.split_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().expect("port")),
        None => (rest.to_string(), 443u16),
    };
    let transport = RustlsTransport::new(host, port);

    // The recovery phrase re-derives the SAME root_key the account was created
    // with — that is the whole point of the recovery wrap — so the server-auth
    // subkey below is the account's, not a new one.
    let meta_bytes = fetch_vault_meta(&transport, &account.hash);
    let meta = protocol::parse_vault_meta(&meta_bytes).expect("parse vault.meta");
    // `from_normalized`, matching `vault_recover`: the spec feeds the §7.4
    // normalized phrase bytes to Argon2id directly, with NO BIP-39 wordlist
    // lookup — a membership check here would leak wordlist signal. A wrong
    // phrase therefore fails at the AEAD tag below rather than at a parse.
    let normalized = protocol::normalize_user_phrase(&phrase_input);
    let recovery_wrap_key = protocol::derive_recovery_wrap_key_from_normalized(
        normalized.as_str(),
        &meta.random_salt_recovery,
        &meta.account_number_hash,
        &meta.kdf_params,
    )
    .expect("derive recovery wrap key");
    let aad = protocol::aad_recovery_wrap(&meta.kdf_params);
    let opened = protocol::aead_open_ctx(
        &recovery_wrap_key,
        &meta.nonce_recovery_wrap,
        &meta.enc_root_key_recovery,
        &aad,
    )
    .expect("unwrap root_key with the recovery phrase");
    let root_key: [u8; 32] = opened.as_slice().try_into().expect("root_key is 32 bytes");

    let secret = protocol::derive_subkey(&root_key, protocol::SubkeyRole::ServerAuth);

    let mut client_nonce = [0u8; 16];
    getrandom::getrandom(&mut client_nonce).expect("csprng");
    let nonce_hex: String = client_nonce.iter().map(|b| format!("{b:02x}")).collect();
    let mut device_id = [0u8; 16];
    getrandom::getrandom(&mut device_id).expect("csprng");

    let outcome = enroll(
        &transport,
        &account.hash,
        secret.as_ref(),
        EnrollPath::Recovery,
        &nonce_hex,
        device_id,
    )
    .expect("enroll approver device");
    assert!(outcome.approved, "the recovery path must self-approve");
    let token: String = outcome.token.iter().map(|b| format!("{b:02x}")).collect();

    let roster = list_devices(&transport, &token).expect("list devices");
    let pending: Vec<[u8; 16]> = pending_devices(&roster)
        .iter()
        .filter_map(|d| myne_core::plugins::sync::devices::hex16(&d.device_id_hex))
        .filter(|id| id != &device_id)
        .collect();

    if pending.is_empty() {
        println!("no pending devices");
        return;
    }
    for id in &pending {
        let hex: String = id.iter().map(|b| format!("{b:02x}")).collect();
        approve_device(&transport, &token, id).expect("approve device");
        println!("approved={hex}");
    }
}

/// `vault.meta` is fetched PRE-auth by design — a joining device needs the KDF
/// parameters and salts before it can derive anything to authenticate with.
fn fetch_vault_meta(transport: &RustlsTransport, account_hash: &[u8; 16]) -> Vec<u8> {
    use myne_core::plugins::sync::transport::{HttpMethod, SyncTransport};
    let hex: String = account_hash.iter().map(|b| format!("{b:02x}")).collect();
    let resp = transport
        .request(
            HttpMethod::Get,
            &format!("/vault.meta?account={hex}"),
            &[],
            None,
        )
        .expect("fetch vault.meta");
    assert_eq!(
        resp.status, 200,
        "vault.meta fetch returned {}",
        resp.status
    );
    resp.body
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(2);
}
