// Create a real account on a real sync server, from source, without a GUI
// (phase3-web-client task 105 — the fixture seeder).
//
//   cargo run --release --example seed-account -- <server-url> <password>
// This uses the same public CA-chain and hostname verification as native sync.
//
// # Why this exists
//
// The web client is sync-required: it JOINS an account that already exists, it
// cannot create one. So every end-to-end test of the web sign-in path needs an
// account on a server, and until now the only way to get one was to drive the
// desktop GUI by hand — which is not automatable on macOS (the app applies
// screen-capture protection, so a driver sees a blank window and a Tauri
// WKWebView exposes no AX subtree to click instead).
//
// It builds the account the same way the desktop app does, through the same
// host-independent functions — `build_session` + `build_and_serialize_vault_meta`
// are the exact code path `vault_creation`'s commit runs — so the artefact is a
// real vault, not a fixture that merely parses. A seeded account is
// indistinguishable from one a user made.
//
// # What it deliberately does NOT do
//
// No local vault directory is written. The point is the SERVER-side account
// (the account number, the SCRAM verifier, `vault.meta`), because the client
// under test is the browser. A caller who wants a local desktop vault too
// should use the app.
//
// # The recovery phrase is printed
//
// It has to be: it is the only credential that can self-approve a device
// (`EnrollPath::Recovery`), and a seeded account whose phrase was discarded can
// never enrol a second device. That makes this tool unsuitable for anything but
// throwaway test accounts, which is what it is for — never point it at an
// account holding real notes.

use myne_core::plugins::sync::enroll::{enroll, put_vault_meta, register_verifier, EnrollPath};
use myne_core::plugins::sync::rustls_transport::RustlsTransport;
use myne_core::plugins::vault_creation::commands::{build_and_serialize_vault_meta, build_session};

fn main() {
    let mut args = std::env::args().skip(1);
    let server = args.next().unwrap_or_else(|| {
        eprintln!("usage: seed-account <server-url> <password>");
        std::process::exit(2);
    });
    let password = args.next().unwrap_or_else(|| {
        eprintln!("usage: seed-account <server-url> <password>");
        std::process::exit(2);
    });
    if args.next().is_some() {
        eprintln!("usage: seed-account <server-url> <password>");
        std::process::exit(2);
    }

    // Same KDF parameters the app uses. NOT a weakened test profile: the point
    // of the seeded account is that the web client can unlock it with the real
    // derivation, and a lowered cost would make the fixture unopenable by the
    // client under test (its floor rejects under-strength parameters).
    let session = build_session(
        myne_core::paths::web_single_vault_id(),
        &password,
        protocol::DEFAULT_V0_1_KDF_PARAMS,
    )
    .expect("build vault-creation session");

    let account_number = session.account.display.clone();
    let phrase = session.phrase.words().join(" ");
    let meta = build_and_serialize_vault_meta(&session).expect("serialize vault.meta");

    // Endpoint -> host/port. The certificate is verified the way the shipped
    // desktop client verifies it: public CA chain plus the requested server
    // name. A browser cannot do this and does not need to (its fetch verifies
    // through the platform trust store); this tool is a native client and takes
    // the native path.
    let url = server.trim_end_matches('/').to_string();
    let (host, port) = {
        let rest = url.strip_prefix("https://").unwrap_or_else(|| {
            eprintln!("server url must be https://");
            std::process::exit(2);
        });
        match rest.split_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().expect("port")),
            None => (rest.to_string(), 443u16),
        }
    };
    let transport = RustlsTransport::new(host, port);

    let secret = protocol::derive_subkey(&session.root_key, protocol::SubkeyRole::ServerAuth);

    register_verifier(&transport, &session.account.hash, secret.as_ref())
        .expect("register SCRAM verifier");

    // `Recovery`, not `Password`: the first device on an account has nothing to
    // approve it, and the recovery path is the bootstrap exception that
    // self-approves. This is the same path the desktop app takes for the device
    // that created the account.
    let mut client_nonce = [0u8; 16];
    getrandom::getrandom(&mut client_nonce).expect("csprng");
    let nonce_hex: String = client_nonce.iter().map(|b| format!("{b:02x}")).collect();
    let mut device_id = [0u8; 16];
    getrandom::getrandom(&mut device_id).expect("csprng");

    let outcome = enroll(
        &transport,
        &session.account.hash,
        secret.as_ref(),
        EnrollPath::Recovery,
        &nonce_hex,
        device_id,
    )
    .expect("enroll device");
    assert!(
        outcome.approved,
        "the recovery path must self-approve; got a pending device"
    );
    let token: String = outcome.token.iter().map(|b| format!("{b:02x}")).collect();

    // The web client fetches this PRE-auth at join time. Without it a browser
    // that has the account number and the password still has nowhere to start.
    put_vault_meta(&transport, &token, &meta).expect("seed vault.meta");

    println!("account_number={account_number}");
    println!("password={password}");
    println!("recovery_phrase={phrase}");
    println!("server={url}");
}
