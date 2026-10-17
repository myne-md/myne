// SPDX-License-Identifier: AGPL-3.0
//! Native-host manifest generation (TB10).
//!
//! A native-messaging host is discovered by the browser through a small
//! JSON **manifest** the browser reads from a well-known per-OS location.
//! The manifest names the host, points `path` at the host entry point
//! (the Myne binary launched with [`super::host::NATIVE_MESSAGING_ARG`]),
//! and — load-bearing for TB10 — **allowlists the exact extension ID** so
//! ONLY the genuine Myne extension may connect:
//!
//! - **Chromium** (Chrome / Edge): `allowed_origins`, an array of
//!   `chrome-extension://<id>/` origins. This is the origin binding that
//!   gives stronger provenance than a localhost port (a random local
//!   process cannot forge a `chrome-extension://` origin to the browser's
//!   native-messaging dispatcher).
//! - **Firefox** (Gecko): `allowed_extensions`, an array of extension IDs
//!   (the gecko `id`, here the real `clipper@myne.md`).
//!
//! Both dialects share `name`, `description`, `path`, and
//! `"type": "stdio"`. We emit BOTH key sets in one struct and serialize
//! the dialect the target browser expects (Chromium ignores
//! `allowed_extensions`; Firefox ignores `allowed_origins`) — but the
//! installer SHOULD write the dialect-appropriate file per browser, since
//! Firefox rejects a manifest carrying an unknown `allowed_origins` key in
//! strict parsing. [`chromium_manifest_json`] and [`firefox_manifest_json`]
//! emit the two dialects.
//!
//! ## Install locations (documented; the installer wires these per OS)
//!
//! The browser reads the manifest from a fixed path keyed by the host
//! `name`. v1 documents the locations; a platform installer step writes
//! the file there (this task delivers the GENERATOR + the template; the
//! install wiring is a thin per-OS file write the desktop installer runs):
//!
//! - **macOS**
//!   - Chrome: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<name>.json`
//!   - Edge:   `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/<name>.json`
//!   - Firefox:`~/Library/Application Support/Mozilla/NativeMessagingHosts/<name>.json`
//! - **Linux**
//!   - Chrome: `~/.config/google-chrome/NativeMessagingHosts/<name>.json`
//!   - Edge:   `~/.config/microsoft-edge/NativeMessagingHosts/<name>.json`
//!   - Firefox:`~/.mozilla/native-messaging-hosts/<name>.json`
//! - **Windows** — a registry key (not a fixed file path) under
//!   `HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>` (and the Edge /
//!   Mozilla equivalents) whose default value is the absolute path to the
//!   manifest JSON file (placed alongside the app, e.g. in the app data
//!   dir). The Windows registry wiring is the installer's job; the JSON
//!   body this module emits is identical.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline" — the
//! manifest carries no secret (a host name, a binary path, public
//! extension IDs); it is config, not key material.
//!
//! The generator API below is exercised by unit tests and consumed by the
//! per-OS installer step ([`super::install`], which writes the emitted JSON
//! to the documented `NativeMessagingHosts/` paths on startup + behind the
//! Settings toggle) + task 4's pairing gate (which binds the same exact
//! extension IDs).

use serde::Serialize;

/// The native-messaging host name (reverse-DNS, matching the app bundle
/// identifier family `md.myne.*`). The browser keys the manifest file /
/// registry entry by this exact string, and the extension's
/// `connectNative("md.myne.clipper")` call must use it verbatim — a
/// cryptographically-load-bearing-adjacent constant (it is the rendezvous
/// name binding the extension to THIS host).
pub const HOST_NAME: &str = "md.myne.clipper";

/// Human-readable host description (shown in no user-facing UI; present
/// because the native-messaging manifest schema includes it).
pub const HOST_DESCRIPTION: &str = "Myne keyless web-clipper native-messaging host";

/// The Firefox extension ID to allowlist — the real gecko `id` pinned in
/// the extension's `manifest.json`
/// (`myne-clipper/src/manifest.json` → `browser_specific_settings.gecko.id`).
pub const FIREFOX_EXTENSION_ID: &str = "clipper@myne.md";

/// The Chromium (Chrome / Edge) extension ID to allowlist.
///
/// A Chromium extension ID is the 32-character `[a-p]` string deterministically
/// derived from the extension's packed public key. This value is **pinned** from
/// the `key` committed to the extension's unpacked manifest
/// (`myne-clipper/src/manifest.json` → `key`), so a keyed unpacked install and a
/// future Web Store build share the same ID and this host allowlists both.
///
/// Derivation (reproducible): base64-decode the manifest `key` (DER
/// SubjectPublicKeyInfo) → SHA-256 → take the first 16 bytes → map each hex
/// nibble `0..=f` to `a..=p`. Re-run this if the extension's `key` ever changes
/// (a forced re-pair — see the root `AGENTS.md` load-bearing-identifiers table).
/// Task 4's pairing handshake binds the SAME exact ID on the host side.
pub const CHROMIUM_EXTENSION_ID: &str = "ebbbblnjddeockegombcnbiljefmlhbh";

/// The Chromium `chrome-extension://<id>/` allowed-origin for a given
/// extension ID. The trailing slash is required by the
/// native-messaging `allowed_origins` grammar.
pub fn chromium_allowed_origin(extension_id: &str) -> String {
    format!("chrome-extension://{extension_id}/")
}

/// The Chromium-dialect native-host manifest.
///
/// `allowed_origins` is the load-bearing allowlist: only the listed
/// `chrome-extension://<id>/` origins may connect to this host.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ChromiumManifest {
    /// The host rendezvous name ([`HOST_NAME`]).
    pub name: String,
    /// Human-readable description.
    pub description: String,
    /// Absolute path to the host entry point (the Myne binary).
    pub path: String,
    /// Always `"stdio"` for a native-messaging host.
    #[serde(rename = "type")]
    pub host_type: String,
    /// The exact `chrome-extension://<id>/` origins permitted to connect.
    pub allowed_origins: Vec<String>,
}

/// The Firefox-dialect native-host manifest.
///
/// `allowed_extensions` is the load-bearing allowlist: only the listed
/// extension IDs (the gecko `id`) may connect.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct FirefoxManifest {
    /// The host rendezvous name ([`HOST_NAME`]).
    pub name: String,
    /// Human-readable description.
    pub description: String,
    /// Absolute path to the host entry point (the Myne binary).
    pub path: String,
    /// Always `"stdio"` for a native-messaging host.
    #[serde(rename = "type")]
    pub host_type: String,
    /// The exact extension IDs permitted to connect.
    pub allowed_extensions: Vec<String>,
}

/// Build the Chromium manifest pinning `chromium_extension_id`.
///
/// `host_path` is the absolute path to the Myne binary; the browser
/// launches it with [`super::host::NATIVE_MESSAGING_ARG`] (the wrapper /
/// argv the installer configures).
pub fn chromium_manifest(host_path: &str, chromium_extension_id: &str) -> ChromiumManifest {
    ChromiumManifest {
        name: HOST_NAME.to_string(),
        description: HOST_DESCRIPTION.to_string(),
        path: host_path.to_string(),
        host_type: "stdio".to_string(),
        allowed_origins: vec![chromium_allowed_origin(chromium_extension_id)],
    }
}

/// Build the Firefox manifest pinning [`FIREFOX_EXTENSION_ID`].
pub fn firefox_manifest(host_path: &str) -> FirefoxManifest {
    FirefoxManifest {
        name: HOST_NAME.to_string(),
        description: HOST_DESCRIPTION.to_string(),
        path: host_path.to_string(),
        host_type: "stdio".to_string(),
        allowed_extensions: vec![FIREFOX_EXTENSION_ID.to_string()],
    }
}

/// Serialize the Chromium manifest to pretty JSON (the form written to
/// the per-OS `NativeMessagingHosts/<name>.json` file).
pub fn chromium_manifest_json(
    host_path: &str,
    chromium_extension_id: &str,
) -> serde_json::Result<String> {
    serde_json::to_string_pretty(&chromium_manifest(host_path, chromium_extension_id))
}

/// Serialize the Firefox manifest to pretty JSON.
pub fn firefox_manifest_json(host_path: &str) -> serde_json::Result<String> {
    serde_json::to_string_pretty(&firefox_manifest(host_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_name_is_reverse_dns_in_app_family() {
        assert_eq!(HOST_NAME, "md.myne.clipper");
    }

    #[test]
    fn chromium_origin_has_required_trailing_slash() {
        let origin = chromium_allowed_origin("abcdefghijklmnopabcdefghijklmnop");
        assert_eq!(
            origin,
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        );
        assert!(origin.ends_with('/'), "the grammar requires a trailing /");
    }

    #[test]
    fn chromium_manifest_allowlists_the_exact_extension_id() {
        let m = chromium_manifest(
            "/Applications/Myne.app/Contents/MacOS/myne",
            "myextensionid",
        );
        assert_eq!(m.name, HOST_NAME);
        assert_eq!(m.host_type, "stdio");
        assert_eq!(
            m.allowed_origins,
            vec!["chrome-extension://myextensionid/".to_string()]
        );
        // The path points at the host entry point.
        assert!(m.path.contains("myne"));
    }

    #[test]
    fn firefox_manifest_allowlists_the_gecko_id() {
        let m = firefox_manifest("/Applications/Myne.app/Contents/MacOS/myne");
        assert_eq!(m.name, HOST_NAME);
        assert_eq!(m.host_type, "stdio");
        assert_eq!(m.allowed_extensions, vec!["clipper@myne.md".to_string()]);
    }

    #[test]
    fn firefox_id_matches_the_extension_manifest_gecko_id() {
        // Load-bearing cross-repo agreement: the allowlisted Firefox ID
        // MUST equal the extension's `browser_specific_settings.gecko.id`
        // (`myne-clipper/src/manifest.json`). If the extension's gecko
        // id ever changes, this constant must change in lock-step or
        // Firefox will refuse the connection.
        assert_eq!(FIREFOX_EXTENSION_ID, "clipper@myne.md");
    }

    #[test]
    fn chromium_json_is_well_formed_and_pins_origin() {
        let json = chromium_manifest_json("/opt/myne/myne", "abcdefghijklmnopabcdefghijklmnop")
            .expect("serialize");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(parsed["name"], "md.myne.clipper");
        assert_eq!(parsed["type"], "stdio");
        assert_eq!(
            parsed["allowed_origins"][0],
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        );
        // The Chromium dialect must NOT carry the Firefox key.
        assert!(parsed.get("allowed_extensions").is_none());
    }

    #[test]
    fn firefox_json_is_well_formed_and_pins_id() {
        let json = firefox_manifest_json("/opt/myne/myne").expect("serialize");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(parsed["name"], "md.myne.clipper");
        assert_eq!(parsed["type"], "stdio");
        assert_eq!(parsed["allowed_extensions"][0], "clipper@myne.md");
        // The Firefox dialect must NOT carry the Chromium key (Firefox's
        // strict parser rejects unknown keys).
        assert!(parsed.get("allowed_origins").is_none());
    }

    #[test]
    fn chromium_id_has_the_right_shape_and_pinned_value() {
        // A Chromium extension ID is 32 chars in the [a-p] alphabet, derived
        // from the extension's committed manifest `key`. Regression-pin the
        // exact value: if the extension's key changes, this must be re-derived
        // in lock-step (a forced re-pair) or Chrome/Edge refuse the connection.
        assert_eq!(CHROMIUM_EXTENSION_ID.len(), 32);
        assert!(CHROMIUM_EXTENSION_ID
            .bytes()
            .all(|b| (b'a'..=b'p').contains(&b)));
        assert_eq!(CHROMIUM_EXTENSION_ID, "ebbbblnjddeockegombcnbiljefmlhbh");
    }
}
