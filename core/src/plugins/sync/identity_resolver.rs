// SPDX-License-Identifier: AGPL-3.0
//! The client-side identity resolver (`collab-provenance` task 2).
//!
//! Maps a raw Automerge actor id to a closed `{Device, Person, Unknown}` identity
//! plus a label. This is the ONE client-side place an id hash would be computed were
//! one needed (the authoritative head-author hash stays in Rust, `myne.head-author
//! v1|`); the resolver never crosses that to TypeScript.
//!
//! # Durable attribution is Device-only in v1 (decision 2026-10-10)
//!
//! No durable device-to-person binding exists, so a DURABLE revision (a saved
//! snapshot) resolves to its DEVICE, the explicit name from the vault's
//! `device_names` map, or the short code the device list shows for an unnamed device
//!, or to `Unknown`. The `Person` arm exists for the LIVE presence surface, where
//! the per-session signed assertion (SYNC-11) binds the device actor to the person
//! for the session's lifetime only; the durable path never returns it.
//!
//! Pure (no IO): the caller reads `device_names` once and passes the map, so the
//! arms are unit-testable and the caller controls the read cost.

use std::collections::BTreeMap;

/// A resolved identity, closed. Serialized across IPC; the UI renders the label.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind")]
pub enum ResolvedIdentity {
    /// A device. `name` is the explicit `device_names` value, or `None` for an
    /// unnamed device (the UI renders "Device <code>").
    Device { name: Option<String>, code: String },
    /// A person (live presence only, from the signed assertion). `name` is the
    /// roster display name.
    Person { name: String },
    /// The actor maps to no known identity (an old note's unmappable actor, an
    /// `MY01` snapshot, or a revision with no actor).
    Unknown,
}

/// Parse a 32-hex actor id, or `None` for anything else, a malformed or absent
/// actor resolves to `Unknown` rather than erroring (a revision with an
/// unmappable actor must not fail the whole listing).
#[must_use]
pub fn actor_from_hex(hex: &str) -> Option<[u8; 16]> {
    if hex.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// The short device code the device list shows for an unnamed device, the first
/// six hex chars of the device id, matching `DeviceManagementPanel`'s `slice(0, 6)`.
#[must_use]
pub fn device_code(actor: &[u8; 16]) -> String {
    actor.iter().map(|b| format!("{b:02x}")).collect::<String>()[..6].to_string()
}

/// Resolve a DURABLE revision's author from the vault's `device_names` map.
/// `actor` is the revision's Automerge actor; `None` (an `MY01` snapshot, or a
/// revision with no actor) resolves to [`ResolvedIdentity::Unknown`]. A device with
/// no name resolves to `Device { name: None, code }`, the short-code fallback.
#[must_use]
pub fn resolve_revision_author(
    names: &BTreeMap<String, String>,
    actor: Option<[u8; 16]>,
) -> ResolvedIdentity {
    let Some(a) = actor else {
        return ResolvedIdentity::Unknown;
    };
    let code = device_code(&a);
    let hex = a.iter().map(|b| format!("{b:02x}")).collect::<String>();
    match names.get(&hex) {
        Some(name) if !name.is_empty() => ResolvedIdentity::Device {
            name: Some(name.clone()),
            code,
        },
        _ => ResolvedIdentity::Device { name: None, code },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> BTreeMap<String, String> {
        let mut m = BTreeMap::new();
        m.insert(
            "aabbccddeeff00112233445566778899".to_string(),
            "Ada's Laptop".to_string(),
        );
        m.insert(
            "00000000000000000000000000000000".to_string(),
            String::new(),
        );
        m
    }

    #[test]
    fn a_named_device_resolves_to_its_name() {
        let actor = [
            0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
            0x88, 0x99,
        ];
        assert_eq!(
            resolve_revision_author(&names(), Some(actor)),
            ResolvedIdentity::Device {
                name: Some("Ada's Laptop".into()),
                code: "aabbcc".into()
            }
        );
    }

    #[test]
    fn an_unnamed_or_empty_named_device_falls_back_to_the_short_code() {
        // Not in the map.
        let unknown_device = [0x11u8; 16];
        assert_eq!(
            resolve_revision_author(&names(), Some(unknown_device)),
            ResolvedIdentity::Device {
                name: None,
                code: "111111".into()
            }
        );
        // Present but empty → the same fallback.
        let empty = [0u8; 16];
        assert_eq!(
            resolve_revision_author(&names(), Some(empty)),
            ResolvedIdentity::Device {
                name: None,
                code: "000000".into()
            }
        );
    }

    #[test]
    fn a_missing_actor_resolves_to_unknown() {
        assert_eq!(
            resolve_revision_author(&names(), None),
            ResolvedIdentity::Unknown
        );
    }

    #[test]
    fn the_device_code_is_the_first_six_hex_chars() {
        let actor = [
            0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert_eq!(device_code(&actor), "abcdef");
    }
}

// ── The resolver command (`collab-provenance` task 2) ────────────────────────
//
// Lives HERE rather than in `sync/commands.rs` on purpose: that module is gated
// `#[cfg(all(feature = "tauri-ipc", not(wasm32)))]`, so a command on the browser
// path (the web dispatcher calls this) must sit in an ungated module.

/// A failure resolving an actor to an identity. Closed enum, no `String` field
/// (the label is DATA, not an error).
#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum ResolveIdentityError {
    /// The vault is not unlocked, so `vault.prefs` cannot be read.
    #[error("vault not unlocked")]
    VaultNotUnlocked,
    /// The actor hex is not 32 hex chars (nor the empty "no actor" form).
    #[error("invalid actor id")]
    InvalidActor,
    /// `vault.prefs` could not be read.
    #[error("preferences unavailable")]
    Prefs,
}

/// Parse an actor hex: `""` is the "no actor" (`MY01` / absent) case, otherwise
/// exactly 32 hex chars.
fn parse_actor_hex(hex: &str) -> Result<Option<[u8; 16]>, ResolveIdentityError> {
    if hex.is_empty() {
        return Ok(None);
    }
    if hex.len() != 32 {
        return Err(ResolveIdentityError::InvalidActor);
    }
    let mut out = [0u8; 16];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| ResolveIdentityError::InvalidActor)?;
    }
    Ok(Some(out))
}

/// Resolve an Automerge actor (hex) to a closed `{Device, Person, Unknown}`
/// identity, reading the vault's `device_names`. The DURABLE revision path never
/// returns `Person` (decision 2026-10-10); a missing actor resolves to `Unknown`.
pub async fn resolve_identity_from_host(
    host: &dyn crate::host::HostCtx,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    io: &dyn crate::vault_io::VaultIo,
    actor_hex: String,
) -> Result<ResolvedIdentity, ResolveIdentityError> {
    let vault_dir =
        crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
            .map_err(|_| ResolveIdentityError::VaultNotUnlocked)?;
    let actor = parse_actor_hex(&actor_hex)?;
    let view = crate::plugins::prefs::commands::prefs_read_with_dir(&vault_dir, state, io)
        .await
        .map_err(|_| ResolveIdentityError::Prefs)?;
    Ok(resolve_revision_author(&view.device_names, actor))
}

/// Tauri wrapper for the identity resolver (desktop).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn resolve_identity<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, crate::plugins::vault_unlock::state::VaultRuntimeState>,
    actor_hex: String,
) -> Result<ResolvedIdentity, ResolveIdentityError> {
    resolve_identity_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        state.inner(),
        &crate::vault_io::StdVaultIo,
        actor_hex,
    )
    .await
}
