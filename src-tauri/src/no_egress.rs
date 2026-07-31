//! App-global no-egress invariant: the single source of truth + pure
//! predicates + static scanners (local-ai epic, ai-egress-guardrail MYND-407,
//! tasks 1–3).
//!
//! **App-global by design, NOT AI-scoped.** The whole Myne client must never
//! gain a network egress path: the WebView is bound by the CSP `connect-src`
//! allowlist, and the Rust host has no HTTP-client / telemetry crate and no
//! network-bearing capability. The AI runtime (`local_inference`) is the
//! occasion for the guard, but the invariant it enforces is global — a future
//! contributor adding `reqwest` for *any* feature trips it.
//!
//! Three layers, one canonical source here so the CI gate (task 2) cannot
//! drift from the lists:
//!   1. CSP `connect-src` **allowlist** — [`CSP_CONNECT_SRC_ALLOWLIST`].
//!   2. Cargo HTTP-client / telemetry **denylist** — [`DENYLISTED_CRATES`].
//!   3. Network-bearing **capability permission** shapes —
//!      [`permission_is_network`].
//!   4. Process-spawn **capability permission** shapes —
//!      [`permission_is_process_spawn`] (MYND-650: the bundle ships an
//!      `externalBin` that exists to originate network traffic, and page
//!      context must never be able to start it).
//!
//! `rustls` is deliberately NOT denylisted: it is the legitimate Phase-2 sync
//! TLS transport (`decisions.md` MYND-424), not an HTTP client or telemetry
//! sink, and it is not reachable from the AI module. The denylist targets
//! crates that *originate* outbound requests, not TLS primitives.
//!
//! Logging: predicates + scanners are pure over their string inputs and emit
//! nothing; the gate test (below) only prints crate/token names on failure —
//! never secret material.

/// The exact set of tokens the CSP `connect-src` directive may contain.
/// Anything else — `https:`, any external host, any `*` wildcard, `data:`,
/// `blob:` in `connect-src` — is a violation. Mirrors `tauri.conf.json`.
///
/// `http://attachment.localhost` is the Windows/Android http-mapped form of
/// the in-app `attachment:` scheme (those WebViews cannot intercept custom
/// schemes; Tauri serves registered protocols there as
/// `http://<scheme>.localhost` — same class as `http://ipc.localhost`,
/// MYND-519). It resolves to the local Rust handler, never the network.
pub const CSP_CONNECT_SRC_ALLOWLIST: &[&str] = &[
    "'self'",
    "ipc:",
    "http://ipc.localhost",
    "attachment:",
    "http://attachment.localhost",
];

/// Crates whose presence anywhere in the dependency closure means the client
/// gained an outbound-request or telemetry capability. HTTP clients +
/// crash/analytics SDKs. NOT TLS primitives (see module docs on `rustls`).
pub const DENYLISTED_CRATES: &[&str] = &[
    // HTTP clients
    "reqwest",
    "hyper",
    "ureq",
    "isahc",
    "surf",
    "attohttpc",
    "curl",
    "curl-sys",
    // Tauri network plugins
    "tauri-plugin-http",
    "tauri-plugin-updater",
    // Telemetry / crash reporters / analytics
    "sentry",
    "sentry-core",
    "opentelemetry",
    "datadog",
    "posthog",
    "segment",
    "amplitude",
];

/// Capability-permission namespace prefixes that grant a network capability.
const NETWORK_PERMISSION_PREFIXES: &[&str] = &["http", "updater", "websocket"];

/// Capability-permission namespace prefixes that would let **page context**
/// start a process.
///
/// Added with the arti Tor sidecar (MYND-650): the bundle now ships an
/// `externalBin` whose entire purpose is to originate network traffic. The host
/// spawns it from Rust, which no capability governs — a Tauri capability grants
/// the *webview* an IPC surface, not the host a syscall. Granting `shell:` or
/// `process:` here would hand any script running in the page the ability to
/// start that proxy (or anything else), which is the one way this feature could
/// turn into the egress path the whole no-egress invariant denies. Neither
/// namespace has ever been granted; this makes the absence enforced rather than
/// merely true.
const PROCESS_SPAWN_PERMISSION_PREFIXES: &[&str] = &["shell", "process"];

/// Normalize a crate name for robust comparison: trim, lowercase, and treat
/// `_`/`-` as equivalent (cargo does).
pub fn normalize_crate(name: &str) -> String {
    name.trim().to_ascii_lowercase().replace('_', "-")
}

/// Is a single `connect-src` token on the allowlist?
pub fn csp_token_allowed(token: &str) -> bool {
    CSP_CONNECT_SRC_ALLOWLIST.contains(&token.trim())
}

/// Is a crate name on the HTTP-client / telemetry denylist?
pub fn crate_denied(name: &str) -> bool {
    let n = normalize_crate(name);
    DENYLISTED_CRATES.iter().any(|d| normalize_crate(d) == n)
}

/// Does a capability permission string grant a network capability?
///
/// Flags `http:*` / `updater:*` / `websocket:*` and anything mentioning
/// `fetch`/`network`/`socket`; clears the pdf-export-style empty capabilities
/// (`pdf-export:page`), `core:*`, `fs:*`, `dialog:*`, `clipboard-manager:*`,
/// `opener:*` (user-initiated external-open, not app-controlled egress).
pub fn permission_is_network(perm: &str) -> bool {
    let p = perm.trim();
    let ns = p.split(':').next().unwrap_or("").trim();
    NETWORK_PERMISSION_PREFIXES.contains(&ns)
        || p.contains("fetch")
        || p.contains("network")
        || p.contains("socket")
}

/// Does a capability permission string let page context spawn a process?
///
/// Flags the `shell:` / `process:` namespaces and anything naming `execute`,
/// `spawn` or `sidecar`. Clears in-app command namespaces that merely contain
/// one of those words as a verb (`vault-unlock:allow-…`, `sync:…`), because the
/// namespace check runs first and only these two namespaces can reach a
/// process.
pub fn permission_is_process_spawn(perm: &str) -> bool {
    let p = perm.trim();
    let ns = p.split(':').next().unwrap_or("").trim();
    PROCESS_SPAWN_PERMISSION_PREFIXES.contains(&ns)
        || p.contains("execute")
        || p.contains("spawn")
        || p.contains("sidecar")
}

/// Extract the space-separated tokens of the `connect-src` directive from a
/// full CSP string, or `None` if the directive is absent.
pub fn parse_connect_src(csp: &str) -> Option<Vec<String>> {
    for directive in csp.split(';') {
        let directive = directive.trim();
        if let Some(rest) = directive.strip_prefix("connect-src") {
            // Ensure it's the `connect-src` directive, not a prefix match.
            if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                return Some(
                    rest.split_whitespace()
                        .map(|t| t.to_string())
                        .collect::<Vec<_>>(),
                );
            }
        }
    }
    None
}

/// Tokens in the CSP `connect-src` that are NOT on the allowlist. Empty = OK.
/// A CSP with no `connect-src` at all is a violation surfaced as the sentinel
/// `"<missing connect-src>"` (fail-closed: the default `default-src` fallback
/// might be permissive).
pub fn csp_connect_src_violations(csp: &str) -> Vec<String> {
    match parse_connect_src(csp) {
        None => vec!["<missing connect-src>".to_string()],
        Some(tokens) => tokens
            .into_iter()
            .filter(|t| !csp_token_allowed(t))
            .collect(),
    }
}

/// Denylisted crates found in a `Cargo.lock` (scans `name = "<crate>"`
/// package entries — catches transitive dependencies).
pub fn lock_denied_crates(lock_text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in lock_text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("name = \"") {
            if let Some(name) = rest.strip_suffix('"') {
                if crate_denied(name) && !found.iter().any(|f| f == name) {
                    found.push(name.to_string());
                }
            }
        }
    }
    found
}

/// Denylisted crates declared as dependency keys in a `Cargo.toml` (a line
/// like `reqwest = "…"` or `reqwest = { … }`, or a quoted key). Direct-dep
/// scan; the transitive closure is caught by [`lock_denied_crates`].
pub fn manifest_denied_crates(toml_text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in toml_text.lines() {
        let line = line.trim();
        // A dependency line: `<key> = …`. Take the key left of `=`.
        if let Some((key, _)) = line.split_once('=') {
            let key = key.trim().trim_matches('"');
            if crate_denied(key) && !found.iter().any(|f| f == key) {
                found.push(key.to_string());
            }
        }
    }
    found
}

/// Network-bearing permissions found in a capability JSON file.
pub fn capability_network_permissions(json_text: &str) -> Vec<String> {
    capability_permissions_matching(json_text, permission_is_network)
}

/// Process-spawn permissions found in a capability JSON file (MYND-650).
pub fn capability_process_spawn_permissions(json_text: &str) -> Vec<String> {
    capability_permissions_matching(json_text, permission_is_process_spawn)
}

/// Permissions in a capability JSON file that satisfy `is_offending`. Walks the
/// `permissions` array — both bare strings and `{ "identifier": … }` objects.
fn capability_permissions_matching(json_text: &str, is_offending: fn(&str) -> bool) -> Vec<String> {
    let mut found = Vec::new();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json_text) else {
        // Unparseable capability JSON is not this gate's concern (tauri build
        // catches it); report nothing rather than false-fail.
        return found;
    };
    if let Some(perms) = value.get("permissions").and_then(|p| p.as_array()) {
        for perm in perms {
            let ident = match perm {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Object(o) => o
                    .get("identifier")
                    .and_then(|i| i.as_str())
                    .map(|s| s.to_string()),
                _ => None,
            };
            if let Some(ident) = ident {
                if is_offending(&ident) {
                    found.push(ident);
                }
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn src_tauri_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    // ---- Task 1: pure predicates ----

    #[test]
    fn csp_token_allowed_accepts_baseline_rejects_remote_and_wildcard() {
        for ok in CSP_CONNECT_SRC_ALLOWLIST {
            assert!(csp_token_allowed(ok), "{ok} should be allowed");
        }
        assert!(!csp_token_allowed("https:"));
        assert!(!csp_token_allowed("https://example.com"));
        assert!(!csp_token_allowed("*"));
        assert!(!csp_token_allowed("data:"));
    }

    #[test]
    fn crate_denied_flags_each_denylisted_name_normalization_robust() {
        assert!(crate_denied("reqwest"));
        assert!(crate_denied("tauri-plugin-http"));
        assert!(crate_denied("tauri_plugin_http")); // underscore form
        assert!(crate_denied("  Sentry  ")); // trim + case
        assert!(!crate_denied("rustls")); // TLS transport, legit (sync)
        assert!(!crate_denied("serde"));
        assert!(!crate_denied("tokio"));
    }

    #[test]
    fn permission_is_network_flags_http_updater_clears_empty_capabilities() {
        assert!(permission_is_network("http:default"));
        assert!(permission_is_network("updater:allow-check"));
        assert!(permission_is_network("websocket:default"));
        // pdf-export-style + ordinary permissions are NOT network.
        assert!(!permission_is_network("pdf-export:page"));
        assert!(!permission_is_network("core:default"));
        assert!(!permission_is_network("fs:allow-write-text-file"));
        assert!(!permission_is_network("dialog:allow-open"));
        assert!(!permission_is_network("opener:allow-open-path"));
        assert!(!permission_is_network("local-inference:default"));
    }

    // ---- Task 2: the gate passes against the current (clean) tree ----

    #[test]
    fn gate_current_csp_connect_src_is_clean() {
        let conf = std::fs::read_to_string(src_tauri_dir().join("tauri.conf.json"))
            .expect("read tauri.conf.json");
        let v: serde_json::Value = serde_json::from_str(&conf).expect("parse tauri.conf.json");
        let csp = v
            .pointer("/app/security/csp")
            .and_then(|c| c.as_str())
            .expect("csp present");
        let violations = csp_connect_src_violations(csp);
        assert!(
            violations.is_empty(),
            "current CSP connect-src has violations: {violations:?}"
        );
    }

    #[test]
    fn gate_current_cargo_has_no_denylisted_crate() {
        // (a) No denylisted crate declared directly in the manifest.
        let manifest =
            std::fs::read_to_string(src_tauri_dir().join("Cargo.toml")).expect("read Cargo.toml");
        let manifest_hits = manifest_denied_crates(&manifest);
        assert!(
            manifest_hits.is_empty(),
            "Cargo.toml declares denylisted crates: {manifest_hits:?}"
        );

        // (b) No denylisted crate in the shipped RUNTIME closure. The scan is
        // `cargo tree -e normal` (normal edges only), NOT a raw `Cargo.lock`
        // grep: the single shared workspace lock legitimately carries `reqwest`
        // / `hyper` via a sibling crate's dev/build deps, which never ship in
        // the desktop binary (`cargo tree -e normal -i reqwest` on
        // `myne-desktop` is empty). The runtime closure is the accurate,
        // transitive-caught egress surface.
        let output = std::process::Command::new(env!("CARGO"))
            .args([
                "tree",
                "-p",
                "myne-desktop",
                "-e",
                "normal",
                "--prefix",
                "none",
                "--offline",
            ])
            .current_dir(src_tauri_dir())
            .output()
            .expect("run cargo tree");
        assert!(
            output.status.success(),
            "cargo tree failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut runtime_hits: Vec<String> = Vec::new();
        for line in stdout.lines() {
            let name = line.split_whitespace().next().unwrap_or("");
            if crate_denied(name) && !runtime_hits.iter().any(|h| h == name) {
                runtime_hits.push(name.to_string());
            }
        }
        assert!(
            runtime_hits.is_empty(),
            "myne-desktop runtime closure contains denylisted crates: {runtime_hits:?}"
        );
    }

    #[test]
    fn gate_current_capabilities_grant_no_network_permission() {
        let cap_dir = src_tauri_dir().join("capabilities");
        let mut all_hits: Vec<(String, String)> = Vec::new();
        for entry in std::fs::read_dir(&cap_dir).expect("read capabilities dir") {
            let path = entry.expect("dir entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let json = std::fs::read_to_string(&path).expect("read capability file");
            for perm in capability_network_permissions(&json) {
                all_hits.push((file_name(&path), perm));
            }
        }
        assert!(
            all_hits.is_empty(),
            "capability files grant network permissions: {all_hits:?}"
        );
    }

    /// MYND-650: the bundle ships an `externalBin` that exists to originate
    /// network traffic. The host spawns it from Rust — no capability governs
    /// that — so the capability files must never hand the same ability to page
    /// context.
    #[test]
    fn gate_current_capabilities_grant_no_process_spawn_permission() {
        let cap_dir = src_tauri_dir().join("capabilities");
        let mut all_hits: Vec<(String, String)> = Vec::new();
        for entry in std::fs::read_dir(&cap_dir).expect("read capabilities dir") {
            let path = entry.expect("dir entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let json = std::fs::read_to_string(&path).expect("read capability file");
            for perm in capability_process_spawn_permissions(&json) {
                all_hits.push((file_name(&path), perm));
            }
        }
        assert!(
            all_hits.is_empty(),
            "capability files grant process-spawn permissions: {all_hits:?}"
        );
    }

    #[test]
    fn permission_is_process_spawn_flags_shell_and_process_clears_app_commands() {
        assert!(permission_is_process_spawn("shell:default"));
        assert!(permission_is_process_spawn("shell:allow-execute"));
        assert!(permission_is_process_spawn("shell:allow-spawn"));
        assert!(permission_is_process_spawn("process:allow-restart"));
        assert!(permission_is_process_spawn("core:allow-execute-sidecar"));

        assert!(!permission_is_process_spawn("core:default"));
        assert!(!permission_is_process_spawn("fs:allow-write-text-file"));
        assert!(!permission_is_process_spawn("sync:allow-sync-now"));
        assert!(!permission_is_process_spawn("cli-bridge:default"));
        assert!(!permission_is_process_spawn("local-inference:default"));
    }

    #[test]
    fn negative_a_shell_execute_permission_trips_the_spawn_gate() {
        let json = r#"{"permissions":["core:default",{"identifier":"shell:allow-execute"}]}"#;
        assert_eq!(
            capability_process_spawn_permissions(json),
            vec!["shell:allow-execute".to_string()]
        );
        // …and it is NOT flagged by the network gate, which is why it needed
        // its own predicate rather than a wider `permission_is_network`.
        assert!(capability_network_permissions(json).is_empty());
    }

    fn file_name(p: &Path) -> String {
        p.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("<?>")
            .to_string()
    }

    // ---- Task 3: negative tests — prove the gate actually trips ----

    #[test]
    fn negative_remote_connect_src_trips_the_gate() {
        let csp =
            "default-src 'self'; connect-src 'self' ipc: https://example.com; script-src 'self'";
        let violations = csp_connect_src_violations(csp);
        assert_eq!(violations, vec!["https://example.com".to_string()]);
    }

    #[test]
    fn negative_wildcard_connect_src_trips_the_gate() {
        let csp = "connect-src 'self' *";
        assert_eq!(csp_connect_src_violations(csp), vec!["*".to_string()]);
    }

    #[test]
    fn negative_missing_connect_src_trips_the_gate() {
        let csp = "default-src 'self'; script-src 'self'";
        assert_eq!(
            csp_connect_src_violations(csp),
            vec!["<missing connect-src>".to_string()]
        );
    }

    #[test]
    fn negative_reqwest_in_manifest_and_lock_trips_the_gate() {
        let manifest = "[dependencies]\nserde = \"1\"\nreqwest = { version = \"0.12\" }\n";
        assert_eq!(
            manifest_denied_crates(manifest),
            vec!["reqwest".to_string()]
        );

        let lock = "[[package]]\nname = \"reqwest\"\nversion = \"0.12.0\"\n";
        assert_eq!(lock_denied_crates(lock), vec!["reqwest".to_string()]);
    }

    #[test]
    fn negative_sentry_telemetry_trips_the_gate() {
        let manifest = "[dependencies]\nsentry = \"0.34\"\n";
        assert_eq!(manifest_denied_crates(manifest), vec!["sentry".to_string()]);
    }

    #[test]
    fn negative_network_permission_capability_trips_the_gate() {
        let json = r#"{ "identifier": "x", "windows": ["main"], "permissions": ["core:default", "http:default", { "identifier": "updater:allow-check" }] }"#;
        let hits = capability_network_permissions(json);
        assert!(hits.contains(&"http:default".to_string()));
        assert!(hits.contains(&"updater:allow-check".to_string()));
        assert_eq!(hits.len(), 2);
    }
}
