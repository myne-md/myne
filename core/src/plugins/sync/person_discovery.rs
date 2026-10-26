// SPDX-License-Identifier: AGPL-3.0
//! Person-scoped vault discovery and listing (myne-md/myne#911 task 9).
//!
//! A device admitted to a person's account knows one thing after its claim
//! lands: it is a device of that account. It does not yet know WHICH vaults the
//! person holds. `GET /b2b/vaults` answers that (task 7 built the route from the
//! membership index), and this module turns that answer into local vaults the
//! picker can list.
//!
//! # What materialisation is, and what it deliberately is not
//!
//! Listing a vault means writing its FRAME: the `vault.meta` this server already
//! holds, fetched pre-auth by namespace, plus the device-local record that says
//! "this container is reachable under that namespace". Nothing is decrypted and
//! no key is installed. Opening the vault is a separate act and still asks for
//! THAT vault's password, which is the user's decision for this session (1B: the
//! device lists every vault, each opens with its own password).
//!
//! The consequence is worth stating because it looks like an omission: a joined
//! vault holds no corpus, no items key and no root key. Its first unlock derives
//! them from the password wrap in the frame, and sync then pulls the content.
//! Before that unlock the picker knows a vault exists here and nothing more, the
//! same way it treats any vault this session has not opened.
//!
//! # Why the namespace is the identity
//!
//! §9.3 offset 6 is the value the salts and AADs bind in every generation, so a
//! local container is "the one for this namespace" iff its frame carries that
//! value there. That is what makes the listing idempotent: a second discovery
//! finds the container it made the first time instead of minting a duplicate,
//! and it needs no side table to do it.

use protocol::vault_meta_ntv7::VAULT_META_NTV7_MAGIC;

use crate::host::HostCtx;
use crate::plugins::sync::devices::SyncDeviceError;
use crate::plugins::sync::http_transport::build_transport;
use crate::plugins::sync::state::{read_sync_state, write_sync_state, SyncState};
use crate::plugins::sync::transport::HttpMethod;
use crate::vault_id::VaultId;
use crate::vault_io::{VaultIo, WriteOpts};

/// One vault the account is bound to, and whether this device holds it yet.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct PersonVaultRow {
    /// The vault's namespace, 32 lowercase hex. It is the vault's public id: the
    /// server stores its blobs under it and the frame carries it at §9.3 offset 6.
    pub account_hash_hex: String,
    /// `"owner"` or `"member"`, the two words §3.1a uses. It is the binding's
    /// role, which the vault list shows.
    pub role: String,
    /// The local `VaultId` once this device holds a container for it, `None`
    /// when materialisation did not happen (an unreachable frame, or a caller
    /// that only asked what the account has).
    pub vault_id: Option<String>,
}

/// The account's bindings, newest answer from the server.
///
/// Ordered as the server orders them (owner first, then by vault id), so a list
/// rendered in received order does not shuffle between polls.
pub async fn discover_bindings(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<Vec<(String, String)>, SyncDeviceError> {
    let (token_hex, url) = person_plane(host, io).await?;
    let rows =
        crate::task::run_blocking(move || -> Result<Vec<(String, String)>, SyncDeviceError> {
            let transport = build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
            let resp = transport
                .request(HttpMethod::Get, "/b2b/vaults", &[], Some(&token_hex))
                .map_err(|_| SyncDeviceError::Transport)?;
            match resp.status {
                200 => {}
                401 => return Err(SyncDeviceError::Unauthenticated),
                503 => return Err(SyncDeviceError::NotConfigured),
                _ => return Err(SyncDeviceError::Transport),
            }
            let parsed: DiscoveryBody =
                serde_json::from_slice(&resp.body).map_err(|_| SyncDeviceError::Transport)?;
            Ok(parsed
                .vaults
                .into_iter()
                .map(|v| (v.account_hash_hex, v.role))
                .collect())
        })
        .await
        .map_err(|_| SyncDeviceError::Internal)??;
    Ok(rows)
}

/// `GET /b2b/vaults`'s body. Mirrors the server's `vaultBindingWire`.
#[derive(serde::Deserialize)]
struct DiscoveryBody {
    vaults: Vec<DiscoveryRow>,
}

#[derive(serde::Deserialize)]
struct DiscoveryRow {
    account_hash_hex: String,
    role: String,
}

/// Every vault the account is bound to, materialising the ones this device does
/// not hold yet (1B: the device lists them; opening one asks for its password).
///
/// A row whose frame could not be fetched keeps its place in the list with
/// `vault_id: None`. That is deliberate: the account really is bound to it, and
/// hiding it would make an unreachable server look like an empty account.
pub async fn list_person_vaults(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<Vec<PersonVaultRow>, SyncDeviceError> {
    let bindings = discover_bindings(host, io).await?;
    let mut rows = Vec::with_capacity(bindings.len());
    let mut materialised = 0usize;
    for (account_hash_hex, role) in bindings {
        let Some(namespace) = crate::plugins::sync::devices::hex16(&account_hash_hex) else {
            // A malformed id from the server is not this client's to repair;
            // the row stays visible without a container.
            rows.push(PersonVaultRow {
                account_hash_hex,
                role,
                vault_id: None,
            });
            continue;
        };
        let vault_id = match local_vault_for_namespace(host, io, namespace).await {
            Some(existing) => {
                // Repair the cache on the way past: a container that exists but
                // whose `sync-state.json` was lost (evicted OPFS, a crash between
                // the two writes) still names its namespace in its own frame, and
                // this is the only place a listing meets both facts at once.
                // Two conditions, and both are the difference between a repair
                // and a downgrade (myne-md/myne#911 review). The frame must be
                // PERSON-wrapped, because on every other generation offset 6 is the
                // account hash its own credential already names, and stamping a
                // namespace onto an enrolled legacy vault moves it off its device
                // token onto a person credential it may not have. And the read must
                // SUCCEED: `unwrap_or_default` would fold "present but undecodable"
                // into "absent" and then write that empty state back, destroying
                // every per-blob CAS baseline, the cursor and the owner token
                // because a listing happened to catch a bad read.
                if let Ok(dir) =
                    crate::paths::vault_dir_for_id_from_host_io(host, io, Some(existing)).await
                {
                    if person_frame_namespace(io, &dir).await == Some(namespace) {
                        if let Ok(cached) = read_sync_state(io, &dir).await {
                            if cached.namespace_hex.is_none() {
                                let repaired = SyncState {
                                    namespace_hex: Some(protocol::hex::encode_lower(&namespace)),
                                    ..cached
                                };
                                let _ = write_sync_state(io, &dir, &repaired).await;
                            }
                        }
                    }
                }
                Some(existing)
            }
            // The cap bounds what ONE server answer can make this client write.
            // The answer is from a party the threat model treats as untrusted, and
            // every other untrusted-input path here is bounded; without it a
            // hostile `GET /b2b/vaults` fills the disk and the picker with rows
            // the user never asked for. Past the cap the row is still LISTED (it
            // is a real binding) and materialises on the user's next explicit act.
            None if materialised >= MAX_MATERIALISED_PER_DISCOVERY => None,
            None => {
                materialised += 1;
                materialise_vault(host, io, namespace).await.ok()
            }
        };
        rows.push(PersonVaultRow {
            account_hash_hex,
            role,
            vault_id: vault_id.map(|id| id.to_string()),
        });
    }
    Ok(rows)
}

/// How many containers one discovery call may materialise (myne-md/myne#911).
///
/// A bound rather than a UX choice: the row list comes from the server, and a
/// server that answers ten thousand rows must not turn one listing into ten
/// thousand writes. The rest stay visible and materialise when the user opens
/// them, which is the same "the account really is bound to it" reasoning the
/// unreachable-frame arm uses.
pub const MAX_MATERIALISED_PER_DISCOVERY: usize = 50;

/// The local container whose frame carries `namespace` at §9.3 offset 6, if any.
///
/// Reads the identity field rather than parsing the frame: the question is
/// "which container is this namespace", and a frame too damaged to parse still
/// answers it. A corrupted container is therefore matched and reported by the
/// picker's own status instead of being hidden behind a second copy.
async fn local_vault_for_namespace(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    namespace: [u8; 16],
) -> Option<VaultId> {
    let base = host.app_data_dir().ok()?;
    // `discover_vaults_via_io`, never `discover_vaults`: the latter is a
    // `std::fs::read_dir` walk, and this command runs on the web client, where
    // that compiles and then answers "no vaults" (or fails at runtime). The
    // consequence is not cosmetic: every listing would fall through to
    // `materialise_vault` and mint ANOTHER container for a namespace the device
    // already holds, so the picker grows phantom rows and several local vaults
    // authenticate as one server namespace. The module header's idempotence claim
    // is only true through the seam.
    for discovered in crate::vault_registry::discover_vaults_via_io(io, &base).await {
        let Ok(bytes) = io.read(&discovered.root.join("vault.meta")).await else {
            continue;
        };
        // §9.3: magic (4) then the 16-byte binding.
        if bytes.get(6..22) == Some(namespace.as_slice()) {
            return Some(discovered.id);
        }
    }
    None
}

/// Write a local container for `namespace` from the server's own frame.
///
/// Refusals are typed and all of them leave the tree as it was: a frame that is
/// not this namespace (`BadRequest`), a frame whose KDF parameters are outside
/// policy (`BadRequest`, validated BEFORE the write for the reason the join path
/// documents at length), and a container that already exists at the minted id
/// (`Internal`, which a retry cannot produce because ids are minted per call).
async fn materialise_vault(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    namespace: [u8; 16],
) -> Result<VaultId, SyncDeviceError> {
    let url = endpoint_url(host, io).await?;
    let ns_hex = protocol::hex::encode_lower(&namespace);
    let bytes = {
        let ns_query = ns_hex.clone();
        crate::task::run_blocking(move || -> Result<Vec<u8>, SyncDeviceError> {
            let transport = build_transport(&url).map_err(|_| SyncDeviceError::Transport)?;
            let resp = transport
                .request(
                    HttpMethod::Get,
                    &format!("/vault.meta?account={ns_query}"),
                    &[],
                    None,
                )
                .map_err(|_| SyncDeviceError::Transport)?;
            if resp.status != 200 {
                return Err(SyncDeviceError::DeviceNotFound);
            }
            Ok(resp.body)
        })
        .await
        .map_err(|_| SyncDeviceError::Internal)??
    };

    // Validate before writing, for the reason the join path spells out: a
    // poisoned frame that reaches the disk is durable and self-trapping, because
    // the picker then routes to Unlock and the unlock refuses it forever.
    crate::plugins::sync::enroll::validate_fetched_meta(&bytes, &namespace)
        .map_err(|_| SyncDeviceError::BadRequest)?;

    // A person-born vault is the only kind this path materialises: its frame is
    // the one a second device can hold without any key material, and its password
    // wrap is what later opens it. A legacy frame here would be a server answer
    // this device cannot use, and guessing is worse than saying so.
    if bytes.get(..4) != Some(VAULT_META_NTV7_MAGIC.as_slice()) {
        return Err(SyncDeviceError::BadRequest);
    }

    let vault_id = VaultId::mint();
    let dir = crate::paths::vault_dir_for_id_from_host_io(host, io, Some(vault_id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    io.create_dir_all(&dir)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    io.write(
        &dir.join("vault.meta"),
        &bytes,
        WriteOpts {
            replace: false,
            ..Default::default()
        },
    )
    .await
    .map_err(|_| SyncDeviceError::Internal)?;

    // The namespace IS the record: `published_state` reads it as "this vault is on
    // a server", and the cycle reads it as "address `?account=` with the person
    // token". `published_at_ms` stays absent on purpose: this device never
    // published this vault, it joined one that already was.
    //
    // The frame already carries the namespace at §9.3 offset 6, so the record is
    // a CACHE and not the only copy, and that is what makes a torn write or an
    // evicted `sync-state.json` self-healing rather than a vault that opens,
    // lists, and silently refuses to sync (myne-md/myne#911 review). Readers
    // that need the namespace take it from the state when present and from the
    // frame when absent; `list_person_vaults` rewrites the record for a container
    // it matches, so the next listing repairs it.
    let state = SyncState {
        namespace_hex: Some(ns_hex),
        ..read_sync_state(io, &dir).await.unwrap_or_default()
    };
    write_sync_state(io, &dir, &state)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    Ok(vault_id)
}

/// The namespace a person-wrapped container names, read from the frame itself.
///
/// The fallback for a lost `sync-state.json`, and deliberately narrow: `None`
/// unless the frame is `NTV7`, because on every other generation offset 6 is the
/// account hash the vault's own credential already names, and reading that as a
/// namespace would move a legacy vault onto the person credential.
pub async fn person_frame_namespace(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
) -> Option<[u8; 16]> {
    let bytes = io.read(&vault_root.join("vault.meta")).await.ok()?;
    if protocol::vault_meta_generation(&bytes) != protocol::VaultMetaGeneration::Person {
        return None;
    }
    let mut ns = [0u8; 16];
    ns.copy_from_slice(bytes.get(6..22)?);
    Some(ns)
}

/// The person plane's bearer token and the configured endpoint.
async fn person_plane(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<(String, String), SyncDeviceError> {
    let path = crate::plugins::sync::person_auth::person_auth_path_for_read(host)
        .map_err(|_| SyncDeviceError::Internal)?;
    let auth = crate::plugins::sync::person_auth::read_person_auth(io, &path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let token = auth
        .filter(|a| !a.token_hex.is_empty())
        .map(|a| a.token_hex)
        .ok_or(SyncDeviceError::PersonSessionRequired)?;
    Ok((token, endpoint_url(host, io).await?))
}

async fn endpoint_url(host: &dyn HostCtx, io: &dyn VaultIo) -> Result<String, SyncDeviceError> {
    let path = crate::plugins::sync::config::config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    crate::plugins::sync::config::read_config(io, &path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?
        .endpoint_url
        .ok_or(SyncDeviceError::NotConfigured)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::test_host::TestHost;
    use crate::test_support::{block_on, ScopedTempDir};

    /// The matcher reads §9.3 offset 6 rather than parsing, so a container whose
    /// frame is otherwise damaged is still recognised as THIS namespace. That is
    /// the difference between the picker showing a corrupted vault and showing a
    /// second, empty copy of one it already has.
    #[test]
    fn a_local_container_is_matched_by_its_namespace_alone() {
        let tmp = ScopedTempDir::new("person-list-match").unwrap();
        let host = TestHost::with_dirs(tmp.path(), tmp.path().join("config"));
        let io = crate::vault_io::StdVaultIo;
        let namespace = [0x42u8; 16];

        block_on(async {
            let id = VaultId::mint();
            let dir = crate::paths::vault_dir_for_id_from_host_io(&host, &io, Some(id))
                .await
                .expect("vault dir");
            io.create_dir_all(&dir).await.expect("mkdir");
            // A deliberately unparseable frame: magic plus the binding, nothing
            // else. The matcher must still answer the right id.
            let mut bytes = b"NTV7".to_vec();
            bytes.extend_from_slice(&[0u8; 2]);
            bytes.extend_from_slice(&namespace);
            io.write(&dir.join("vault.meta"), &bytes, WriteOpts::default())
                .await
                .expect("write");

            assert_eq!(
                local_vault_for_namespace(&host, &io, namespace).await,
                Some(id)
            );
            assert_eq!(
                local_vault_for_namespace(&host, &io, [0x43; 16]).await,
                None,
                "a different namespace must not match"
            );
        });
    }
}
