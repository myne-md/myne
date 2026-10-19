// SPDX-License-Identifier: AGPL-3.0
//! The sync engine's pull/push state machine (MYND-424 tasks 5/6).
//!
//! This is pure logic over the [`SyncTransport`] seam + the `protocol`
//! vault-head primitives — no Tauri, no disk, no rustls — so it unit-tests
//! against [`super::transport::FakeTransport`]. The wire types mirror the Go
//! server's `/sync/pull` + `/sync/push` JSON (`myne-server/internal/syncapi`)
//! exactly, so the two implementations stay byte-compatible.
//!
//! ## Pull (task 5)
//!
//! `GET /sync/pull?cursor=<u64>` (Authorization: the per-device token). The
//! server answers `{ metas, next_cursor, head? }`. The engine:
//! 1. verifies the head **client-side** — `open_vault_head` (MAC + structural)
//!    + `head_id` recomputation + `vv_dominance` vs the device baseline;
//! 2. **rejects a rollback** (`Dominance::Rollback` → hard error, never a silent
//!    accept) — the core anti-malicious-server guarantee (story 5);
//! 3. lists the changed blobs (a meta whose `content_nonce` ≠ the local one);
//! 4. surfaces `410 cursor_expired` as [`PullError::CursorExpired`] so the caller
//!    triggers a full-reconcile (task 8).
//!
//! The cursor ack is server-side (the server `AckCursor`s on each pull); the
//! client just advances its stored cursor to `next_cursor`.
//!
//! `download_blob` issues `GET /sync/blob?id=<hex>`; `myne-server` serves that
//! route (`internal/syncapi` `handleBlob`, backed by `store.GetBlob`). The full
//! pull→download→write→push cycle is driven by [`super::orchestrator`] and
//! proven end-to-end against the real server by
//! `orchestrator::tests::two_devices_replicate_a_note`.

use super::head_authority::HeadAuthority;
use super::transport::{HttpMethod, SyncTransport, TransportError};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use protocol::{
    compute_head_id, vv_dominance, Dominance, SealedHead, VaultHead, VaultHeadError, VvEntry,
    DEVICE_ID_LEN, HEAD_ID_LEN, VAULT_HEAD_FORMAT_V1,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One blob meta from `/sync/pull` (mirrors the Go `syncMetaWire`).
#[derive(Debug, Clone, Deserialize)]
struct SyncMetaWire {
    uuid_hex: String,
    version: u64,
    content_nonce_hex: String,
    #[serde(default)]
    size: usize,
    /// Full 32-byte attachment-id (64 hex), echoed by the server for an
    /// attachment record so the puller can resolve the 16-byte sync-id
    /// prefix without waiting on the catalog (MYND-468; §8.1).
    #[serde(default)]
    attachment_id_hex: Option<String>,
}

/// The current head from `/sync/pull` (mirrors the Go `headWire`).
#[derive(Debug, Clone, Deserialize)]
struct HeadWire {
    record_b64: String,
    head_id_hex: String,
}

/// The `/sync/pull` 200 body (mirrors the Go `pullResp`).
#[derive(Debug, Clone, Deserialize)]
struct PullRespWire {
    #[serde(default)]
    metas: Vec<SyncMetaWire>,
    next_cursor: u64,
    #[serde(default)]
    head: Option<HeadWire>,
}

/// A server error body (mirrors the Go `errBody`).
#[derive(Debug, Clone, Deserialize)]
struct ErrBodyWire {
    #[serde(default)]
    error_code: String,
}

/// A blob-download body (`GET /sync/blob`; client-side contract — see the
/// module note on the pending server route).
#[derive(Debug, Clone, Deserialize)]
struct BlobWire {
    ciphertext_b64: String,
}

/// A changed content blob the pull surfaced (its `content_nonce` differs from
/// the local manifest, or it is new).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedBlob {
    /// 16-byte note UUID / attachment sync-id (§4.2 — an attachment's key is
    /// the first 16 bytes of its 32-byte `attachment-id`).
    pub id: [u8; 16],
    /// The server's current `content_nonce` for this blob.
    pub content_nonce: [u8; 24],
    /// The server's opaque per-blob version (CAS token).
    pub version: u64,
    /// Advertised ciphertext size (informational).
    pub size: usize,
    /// The full 32-byte attachment-id when this record is an attachment
    /// (server echo; MYND-468). `None` for notes.
    pub attachment_id: Option<[u8; 32]>,
}

/// A pulled head, verified client-side, with its dominance vs the baseline.
#[derive(Debug, Clone)]
pub struct VerifiedHead {
    /// The decoded, MAC-verified head.
    pub head: VaultHead,
    /// `head_id = SHA-256(record)` (matched against the wire `head_id_hex`).
    pub head_id: [u8; HEAD_ID_LEN],
    /// The §5.3 comparison of this head's VV against the device baseline.
    pub dominance: Dominance,
    /// The exact wire record, so the baseline can be persisted verbatim. A
    /// signed (`0x02`) head's ML-DSA half is randomized, so re-sealing the
    /// decoded head would produce a DIFFERENT record/head_id; storing the pulled
    /// bytes is what keeps the baseline's `head_id` the one the server holds.
    pub record: Vec<u8>,
}

/// The result of one `/sync/pull` page.
#[derive(Debug, Clone)]
pub struct PullPage {
    /// The server's `next_cursor` (the client advances its stored cursor here).
    pub next_cursor: u64,
    /// The current head, verified (absent on an empty vault).
    pub head: Option<VerifiedHead>,
    /// Blobs whose `content_nonce` differs from the local manifest.
    pub changed: Vec<ChangedBlob>,
    /// **Every** blob the server reported this page (the full roster, regardless
    /// of whether it matches the local manifest). The caller reconciles its
    /// synced-baseline (`state.blobs`) from this — without it a baseline that a
    /// prior corrupted cycle failed to record can never self-heal, and every
    /// locally-held blob re-pushes at `base_version 0` (server CAS → 409).
    pub all_metas: Vec<ChangedBlob>,
    /// The `head_id` of a head this device could NOT MAC-verify, populated only
    /// on a `rekey_rebase` pull (myne-md/myne#429) — the one situation where an
    /// unopenable head is expected rather than hostile, because this device just
    /// re-keyed the vault and the server still holds the previous generation's
    /// head.
    ///
    /// Only the id crosses, never the record's contents: `head_id` is
    /// `SHA-256(record)` (§5.2), so it needs no key and asserts nothing about
    /// what the head says. It is exactly what the server's head CAS wants as the
    /// parent, and nothing more. `head` stays `None` — an unverified head
    /// contributes no VV, no `seq` and no `manifest_hash`.
    pub unverifiable_head_id: Option<[u8; HEAD_ID_LEN]>,
}

/// Pull-path failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PullError {
    /// 401 — token rejected / no authed session.
    Unauthenticated,
    /// 401 `device_revoked` — this DEVICE's registry row was revoked or retired
    /// from another client (`server-protocol.md` §3.1). Distinct from
    /// [`PullError::Unauthenticated`] on purpose: the two arrive on the same
    /// status and mean opposite things to a client.
    ///
    /// `Unauthenticated` covers an expired token, a restarted server, a token
    /// the server has simply never heard of — every one of which is fixed by
    /// re-authenticating, and none of which says anything about the user's
    /// intent. A revoked device row is a **deliberate act by the account owner
    /// from another client**, and on a client whose storage is a cache of a
    /// sync-held vault it is terminal rather than a retry class (task 94).
    ///
    /// It is emphatically NOT a remote wipe or a cryptographic lockout: a device
    /// that already decrypted content cannot un-decrypt it, and anyone holding
    /// the vault file plus the password is unaffected. `REMOVE_DEVICE_DISCLOSURE`
    /// says exactly that and must keep saying it.
    DeviceRevoked,
    /// 429 — per-account rate limit.
    RateLimited,
    /// 410 cursor_expired — the caller MUST trigger a full-reconcile (task 8).
    CursorExpired,
    /// The pulled head failed MAC / structural verification.
    HeadInvalid,
    /// The recomputed `head_id` ≠ the wire `head_id_hex` (server inconsistency).
    HeadIdMismatch,
    /// **Rollback rejected** — the head's VV regressed below the baseline
    /// (`Dominance::Rollback`). Never silently accepted (story 5).
    RollbackRejected,
    /// 404 on `/sync/blob` — the server does not know this id at all.
    BlobNotFound,
    /// 410 `blob_reclaimed` on `/sync/blob` — the body was Layer-2 reclaimed
    /// (horizon-GC); §11.3 makes this fail-closed instead of an empty 200. The
    /// caller skips the record without any local mutation.
    BlobReclaimed,
    /// A malformed / unparseable server response.
    BadResponse,
    /// Transport-level failure (below HTTP).
    Transport(TransportError),
}

impl From<TransportError> for PullError {
    fn from(e: TransportError) -> Self {
        PullError::Transport(e)
    }
}

/// Classify a 401 body into `device_revoked` vs plain `unauthenticated`.
///
/// **One reader, on purpose.** The server sends both on status 401, so EVERY
/// 401 arm in this file has to look inside the body or it silently collapses a
/// terminal condition into a retryable one. A copy at each would be as many
/// places for the string to drift from `server-protocol.md` §3.1.
///
/// The count used to be stated here as a number, and the number was wrong — it
/// said five while three arms did not call this at all, which is how
/// `download_blob`'s omission survived review (myne#294). A number that has to
/// be re-counted by hand on every edit is not a check; `every_401_arm_consults_
/// the_body` in this file's tests is, so this doc no longer carries one.
///
/// An unparseable or absent body means `false` — plain `Unauthenticated`, the
/// SAFE default in the direction that matters. Guessing "revoked" from a missing
/// body would let a malformed response from any server erase a web client's
/// local copy, which is the one outcome here that cannot be undone by retrying.
fn is_device_revoked(body: &[u8]) -> bool {
    serde_json::from_slice::<ErrBodyWire>(body)
        .map(|e| e.error_code == "device_revoked")
        .unwrap_or(false)
}

/// Lenient (`protocol::hex::decode_ci`): every call site decodes a field of a
/// SERVER response (`head_id_hex`, `uuid_hex`, `content_nonce_hex`,
/// `blob_id_hex`), so its case is not this client's to fix (R1.2).
fn hex_to_array<const N: usize>(s: &str) -> Option<[u8; N]> {
    protocol::hex::decode_ci(s)
}

/// Issue one `/sync/pull` request and verify the response (head verify +
/// rollback rejection + changed-blob detection). `local` maps each locally-held
/// blob id to its current `content_nonce`.
///
/// `rekey_rebase` is the ONE exemption (myne-md/myne#429): set only when this
/// device's own `SyncState::rekey_rebase_pending` says it just re-keyed the
/// vault, it downgrades an unopenable head from [`PullError::HeadInvalid`] to
/// [`PullPage::unverifiable_head_id`], because after a re-key the server's head
/// is MAC'd under a `root_key` that no longer exists and "cannot open it" is the
/// expected answer rather than evidence of a forgery. Everything else — the
/// head-id match, rollback rejection on a head that DOES open, and every
/// blob-level check — is untouched.
// Each argument is a distinct pull input; bundling them into a struct would
// only move the same list one indirection away.
#[allow(clippy::too_many_arguments)]
pub fn pull_page(
    transport: &dyn SyncTransport,
    head_authority: &HeadAuthority,
    token: &str,
    baseline_vv: &[VvEntry],
    cursor: u64,
    local: &HashMap<[u8; 16], [u8; 24]>,
    reconcile: bool,
    rekey_rebase: bool,
) -> Result<PullPage, PullError> {
    // `reconcile=1` is a full-manifest walk (§11.2): the server exempts it from the
    // cursor-expired floor so the walk can drain a vault whose reclaim floor sits
    // beyond the first page boundary. A plain incremental pull omits it, so a stale
    // cursor still earns the 410 that flips us into the reconcile walk below.
    let path = if reconcile {
        format!("/sync/pull?cursor={cursor}&reconcile=1")
    } else {
        format!("/sync/pull?cursor={cursor}")
    };
    let resp = transport.request(HttpMethod::Get, &path, &[], Some(token))?;

    match resp.status {
        200 => {}
        401 => {
            return Err(if is_device_revoked(&resp.body) {
                PullError::DeviceRevoked
            } else {
                PullError::Unauthenticated
            })
        }
        410 => return Err(PullError::CursorExpired),
        429 => return Err(PullError::RateLimited),
        _ => {
            // Best-effort: distinguish cursor_expired even if the status drifts.
            if let Ok(eb) = serde_json::from_slice::<ErrBodyWire>(&resp.body) {
                if eb.error_code == "cursor_expired" {
                    return Err(PullError::CursorExpired);
                }
                if eb.error_code == "unauthenticated" {
                    return Err(PullError::Unauthenticated);
                }
                if eb.error_code == "device_revoked" {
                    return Err(PullError::DeviceRevoked);
                }
            }
            return Err(PullError::BadResponse);
        }
    }

    let wire: PullRespWire =
        serde_json::from_slice(&resp.body).map_err(|_| PullError::BadResponse)?;

    let mut unverifiable_head_id = None;
    let head = match wire.head {
        None => None,
        Some(hw) => {
            let record = B64
                .decode(hw.record_b64.as_bytes())
                .map_err(|_| PullError::BadResponse)?;
            let opened = head_authority.open(&record);
            // A head that will not open under a root_key this device just
            // REPLACED is the expected shape, not a forgery (#429). Take its id —
            // `SHA-256(record)`, keyless — as the CAS parent for the head this
            // cycle will author under the new root, and carry nothing else out of
            // it. The head-id match below still runs, so a server that answers
            // with a record not matching the id it advertised is still caught.
            let head_id = compute_head_id(&record);
            let wire_id =
                hex_to_array::<HEAD_ID_LEN>(&hw.head_id_hex).ok_or(PullError::BadResponse)?;
            if head_id != wire_id {
                return Err(PullError::HeadIdMismatch);
            }
            match opened {
                Err(_) if rekey_rebase => {
                    unverifiable_head_id = Some(head_id);
                    None
                }
                Err(_) => return Err(PullError::HeadInvalid),
                Ok(vault_head) => {
                    let dominance = vv_dominance(baseline_vv, &vault_head.version_vector);
                    if dominance == Dominance::Rollback {
                        return Err(PullError::RollbackRejected);
                    }
                    Some(VerifiedHead {
                        head: vault_head,
                        head_id,
                        dominance,
                        record,
                    })
                }
            }
        }
    };

    let mut changed = Vec::new();
    let mut all_metas = Vec::new();
    for m in &wire.metas {
        let id = hex_to_array::<16>(&m.uuid_hex).ok_or(PullError::BadResponse)?;
        let content_nonce =
            hex_to_array::<24>(&m.content_nonce_hex).ok_or(PullError::BadResponse)?;
        let attachment_id = match &m.attachment_id_hex {
            None => None,
            Some(h) => Some(hex_to_array::<32>(h).ok_or(PullError::BadResponse)?),
        };
        let blob = ChangedBlob {
            id,
            content_nonce,
            version: m.version,
            size: m.size,
            attachment_id,
        };
        if local.get(&id) != Some(&content_nonce) {
            changed.push(blob.clone());
        }
        all_metas.push(blob);
    }

    Ok(PullPage {
        next_cursor: wire.next_cursor,
        head,
        changed,
        all_metas,
        unverifiable_head_id,
    })
}

/// Loop `pull_page` until the cursor stops advancing (a stable pull), so a
/// vault larger than one page is fully drained. Accumulates changed blobs (last
/// content_nonce wins per id) and keeps the latest verified head.
// Each argument is a distinct pull input; bundling them into a struct would
// only move the same list one indirection away.
#[allow(clippy::too_many_arguments)]
pub fn pull_to_stable(
    transport: &dyn SyncTransport,
    head_authority: &HeadAuthority,
    token: &str,
    baseline_vv: &[VvEntry],
    start_cursor: u64,
    local: &HashMap<[u8; 16], [u8; 24]>,
    reconcile: bool,
    rekey_rebase: bool,
) -> Result<PullPage, PullError> {
    let mut cursor = start_cursor;
    let mut acc: HashMap<[u8; 16], ChangedBlob> = HashMap::new();
    let mut acc_all: HashMap<[u8; 16], ChangedBlob> = HashMap::new();
    let mut latest_head: Option<VerifiedHead> = None;
    let mut unverifiable_head_id: Option<[u8; HEAD_ID_LEN]> = None;

    loop {
        let page = pull_page(
            transport,
            head_authority,
            token,
            baseline_vv,
            cursor,
            local,
            reconcile,
            rekey_rebase,
        )?;
        if page.unverifiable_head_id.is_some() {
            unverifiable_head_id = page.unverifiable_head_id;
        }
        for c in page.changed {
            acc.insert(c.id, c);
        }
        for m in page.all_metas {
            acc_all.insert(m.id, m);
        }
        if page.head.is_some() {
            latest_head = page.head;
        }
        // Stable when the cursor no longer advances.
        if page.next_cursor <= cursor {
            cursor = page.next_cursor;
            break;
        }
        cursor = page.next_cursor;
    }

    let mut changed: Vec<ChangedBlob> = acc.into_values().collect();
    changed.sort_by_key(|a| a.id);
    let mut all_metas: Vec<ChangedBlob> = acc_all.into_values().collect();
    all_metas.sort_by_key(|a| a.id);
    Ok(PullPage {
        next_cursor: cursor,
        head: latest_head,
        changed,
        all_metas,
        unverifiable_head_id,
    })
}

/// Download a changed blob's opaque ciphertext (`GET /sync/blob?id=<hex>`).
/// See the module note: the server route is a pending pushpull amendment.
pub fn download_blob(
    transport: &dyn SyncTransport,
    token: &str,
    id: &[u8; 16],
) -> Result<Vec<u8>, PullError> {
    let path = format!("/sync/blob?id={}", hex_lower(id));
    let resp = transport.request(HttpMethod::Get, &path, &[], Some(token))?;
    match resp.status {
        200 => {
            let wire: BlobWire =
                serde_json::from_slice(&resp.body).map_err(|_| PullError::BadResponse)?;
            B64.decode(wire.ciphertext_b64.as_bytes())
                .map_err(|_| PullError::BadResponse)
        }
        // myne#294 — the body decides, here as at every other 401 arm. This one
        // skipped the check, and it is the arm a revocation landing MID-CYCLE
        // hits: `pull_to_stable` has already succeeded, and the cycle is minutes
        // deep in per-note `GET /sync/blob`. A terminal revocation was then
        // reported as a retryable "sign-in expired", so the UI showed the wrong
        // copy and the web client's terminal takeover — gated on
        // `detail === "device_revoked"` — did not render, for up to one 15-minute
        // auth park. Which is precisely the collapse the separate class exists to
        // prevent.
        401 => Err(if is_device_revoked(&resp.body) {
            PullError::DeviceRevoked
        } else {
            PullError::Unauthenticated
        }),
        // 404/410 are per-blob outcomes (unknown id / horizon-GC reclaimed body,
        // §11.3) — first-class so the apply loop can SKIP the record instead of
        // failing the whole cycle.
        404 => Err(PullError::BlobNotFound),
        410 => Err(PullError::BlobReclaimed),
        429 => Err(PullError::RateLimited),
        _ => Err(PullError::BadResponse),
    }
}

/// A ciphertext the batch route served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedBlob {
    /// The blob id it was requested under.
    pub id: [u8; 16],
    /// The opaque ciphertext bytes.
    pub ciphertext: Vec<u8>,
}

/// Why the server accounted for an id without serving its bytes. These mirror
/// the per-blob outcomes the single-blob route signals as HTTP statuses, so the
/// apply loop needs no new class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobOmission {
    /// Unknown id (`not_found`) — also the answer for an id in another account's
    /// namespace.
    NotFound,
    /// Horizon-GC reclaimed body (`blob_reclaimed`, §11.3).
    Reclaimed,
    /// The server could not read it (`internal`), or a code this client does not
    /// know. An unknown code lands here deliberately: the disposition — skip the
    /// record, mutate nothing — is the safe one, so a server that grows a fourth
    /// condition degrades instead of wedging a client that never re-requests.
    Other,
}

/// One batch-fetch response, accounting for a PREFIX of the requested ids.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BlobBatch {
    /// The ids served, with their bytes.
    pub blobs: Vec<FetchedBlob>,
    /// The ids accounted for but not served, with why.
    pub omitted: Vec<([u8; 16], BlobOmission)>,
}

impl BlobBatch {
    /// What the response said about `id`: `None` when it accounted for the id at
    /// all — the caller must keep it queued and ask again, NEVER default it to
    /// empty bytes. A `get(..).unwrap_or_default()` here would reproduce the
    /// exact destructive shape §11.3 was written against, arrived at through a
    /// different door.
    pub fn outcome(&self, id: &[u8; 16]) -> Option<Result<&[u8], BlobOmission>> {
        if let Some(b) = self.blobs.iter().find(|b| &b.id == id) {
            return Some(Ok(&b.ciphertext));
        }
        self.omitted
            .iter()
            .find(|(oid, _)| oid == id)
            .map(|(_, why)| Err(*why))
    }
}

/// What [`download_blobs`] found at the far end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobBatchOutcome {
    /// The server answered; the batch accounts for a prefix of the request.
    Served(BlobBatch),
    /// The server has no batch route (`404`/`405`) — an older self-hosted
    /// deployment. The caller falls back to [`download_blob`].
    ///
    /// Deliberately a value rather than a `PullError` variant: a new error
    /// variant would fall through `classify_cycle_error`'s catch-all into the
    /// 1-second retry ladder the moment a caller forgot to handle it, and it
    /// would put a state that must never reach a user into a UI-facing enum. As
    /// an enum arm the compiler forces the caller to deal with it, and
    /// `cycle.rs` needs no change at all.
    RouteUnsupported,
}

#[derive(Debug, Clone, Deserialize)]
struct BlobBatchEntryWire {
    blob_id_hex: String,
    ciphertext_b64: String,
}

#[derive(Debug, Clone, Deserialize)]
struct BlobBatchOmittedWire {
    blob_id_hex: String,
    #[serde(default)]
    error_code: String,
}

#[derive(Debug, Clone, Deserialize)]
struct BlobBatchWire {
    #[serde(default)]
    blobs: Vec<BlobBatchEntryWire>,
    #[serde(default)]
    omitted: Vec<BlobBatchOmittedWire>,
}

#[derive(Serialize)]
struct BlobBatchReqWire {
    blob_ids_hex: Vec<String>,
}

/// Download many ciphertexts in one request (`POST /sync/blobs`, myne#240) —
/// the read-path twin of the chunked push. The pull path was one HTTP request
/// per blob, so a first sync of a large vault spent its cost in round-trips
/// against the per-account bucket rather than in bandwidth.
///
/// The response accounts for a **prefix** of `ids` in request order; an id in
/// neither array was not served and the caller re-requests it (that is what lets
/// the server's byte budget truncate safely without the client having to guess
/// its window right). Callers read outcomes through [`BlobBatch::outcome`].
pub fn download_blobs(
    transport: &dyn SyncTransport,
    token: &str,
    ids: &[[u8; 16]],
) -> Result<BlobBatchOutcome, PullError> {
    let body = serde_json::to_vec(&BlobBatchReqWire {
        blob_ids_hex: ids.iter().map(hex_lower).collect(),
    })
    .map_err(|_| PullError::BadResponse)?;
    let resp = transport.request(HttpMethod::Post, "/sync/blobs", &body, Some(token))?;
    match resp.status {
        200 => {
            let wire: BlobBatchWire =
                serde_json::from_slice(&resp.body).map_err(|_| PullError::BadResponse)?;
            let mut batch = BlobBatch::default();
            for e in wire.blobs {
                let id = hex_to_array::<16>(&e.blob_id_hex).ok_or(PullError::BadResponse)?;
                let ciphertext = B64
                    .decode(e.ciphertext_b64.as_bytes())
                    .map_err(|_| PullError::BadResponse)?;
                batch.blobs.push(FetchedBlob { id, ciphertext });
            }
            for o in wire.omitted {
                let id = hex_to_array::<16>(&o.blob_id_hex).ok_or(PullError::BadResponse)?;
                let why = match o.error_code.as_str() {
                    "not_found" => BlobOmission::NotFound,
                    "blob_reclaimed" => BlobOmission::Reclaimed,
                    _ => BlobOmission::Other,
                };
                batch.omitted.push((id, why));
            }
            Ok(BlobBatchOutcome::Served(batch))
        }
        // myne#294 — the body decides, here as at every other 401 arm.
        401 => Err(if is_device_revoked(&resp.body) {
            PullError::DeviceRevoked
        } else {
            PullError::Unauthenticated
        }),
        // A server that predates the route. 405 is the same answer through a
        // reverse proxy that knows the /sync prefix but not this method.
        404 | 405 => Ok(BlobBatchOutcome::RouteUnsupported),
        429 => Err(PullError::RateLimited),
        // No 410 arm: on this route reclamation is a per-id code inside a 200,
        // never a status. A whole-response 410 is a server this client does not
        // understand.
        _ => Err(PullError::BadResponse),
    }
}

/// Lowercase hex of a fixed-size id.
fn hex_lower<const N: usize>(bytes: &[u8; N]) -> String {
    let mut s = String::with_capacity(N * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

// ---------------------------------------------------------------------------
// Push path (task 6)
// ---------------------------------------------------------------------------

/// One blob to push (mirrors the Go `pushBlob`). A `tombstone` push carries the
/// `deleted`-version ciphertext (MYND-426 builds it); the field is the only
/// deletion signal the blind server sees. An **attachment** record carries the
/// full id in `attachment_id_hex` with an EMPTY inline ciphertext — the bytes
/// travel over `/attachments/{id}` (§8.1/§11.4, MYND-468); its tombstone
/// additionally triggers the server-side body mark-deleted.
#[derive(Debug, Clone, Serialize)]
struct PushBlobWire {
    blob_id_hex: String,
    base_version: u64,
    content_nonce_hex: String,
    ciphertext_b64: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    tombstone: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachment_id_hex: Option<String>,
}

/// The optional new head on a push (mirrors the Go `pushHead`): the pointer-CAS
/// is `prev_head_hash` (the head the client believes is current).
#[derive(Debug, Clone, Serialize)]
struct PushHeadWire {
    prev_head_hash_hex: String,
    record_b64: String,
}

/// The `/sync/push` request (mirrors the Go `pushReq`).
#[derive(Debug, Clone, Serialize)]
struct PushReqWire {
    blobs: Vec<PushBlobWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_head: Option<PushHeadWire>,
}

/// One push result (mirrors the Go `pushResult`).
#[derive(Debug, Clone, Deserialize)]
struct PushResultWire {
    blob_id_hex: String,
    version: u64,
}

/// The `/sync/push` 200 body (mirrors the Go `pushResp`).
#[derive(Debug, Clone, Deserialize)]
struct PushRespWire {
    #[serde(default)]
    results: Vec<PushResultWire>,
    #[serde(default)]
    head_id_hex: String,
}

/// A blob the client wants to push (the coalesced batch the loop accumulates).
#[derive(Debug, Clone)]
pub struct PushBlob {
    /// 16-byte note UUID / attachment sync-id (§4.2).
    pub id: [u8; 16],
    /// The version the client last saw for this blob (the per-blob CAS base).
    pub base_version: u64,
    /// The new revision's `content_nonce`.
    pub content_nonce: [u8; 24],
    /// The opaque sealed ciphertext. EMPTY for an attachment record — the
    /// bytes already travelled over `/attachments/{id}` (MYND-468).
    pub ciphertext: Vec<u8>,
    /// `true` for a `deleted`-marked tombstone version (MYND-426; for an
    /// attachment, the §11.4 deletion signal that also marks the body).
    pub tombstone: bool,
    /// The full 32-byte attachment-id for an attachment record (registration
    /// or tombstone); `None` for notes.
    pub attachment_id: Option<[u8; 32]>,
}

/// The result of a successful push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushOutcome {
    /// Per-blob `(id, new_version)` (advance the local CAS base to these).
    pub results: Vec<([u8; 16], u64)>,
    /// The new `head_id` if a head was advanced.
    pub head_id: Option<[u8; HEAD_ID_LEN]>,
}

/// Push-path failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushError {
    /// 401 — token rejected.
    Unauthenticated,
    /// 401 `device_revoked` — see [`PullError::DeviceRevoked`] for why this is a
    /// separate variant rather than a flavour of `Unauthenticated`.
    DeviceRevoked,
    /// 429 — per-account rate limit.
    RateLimited,
    /// 409 `blob_stale` — a blob's `base_version` lost the CAS; pull + re-push.
    BlobStale,
    /// 409 `head_stale` — the head pointer-CAS lost; pull + merge + re-push.
    HeadStale,
    /// 507 — per-account quota exceeded.
    QuotaExceeded,
    /// 413 — the request body exceeded the server cap.
    PayloadTooLarge,
    /// 403 `frozen` — the account is operator-frozen: push + enroll are refused,
    /// pull is NEVER refused ("frozen is minimal", `decisions.md` 2026-07-13).
    /// Distinct from `Unauthenticated` so the UI can say the account is frozen
    /// and that reading still works, instead of "sign-in expired".
    Frozen,
    /// A malformed / unparseable server response.
    BadResponse,
    /// Transport-level failure.
    Transport(TransportError),
}

impl From<TransportError> for PushError {
    fn from(e: TransportError) -> Self {
        PushError::Transport(e)
    }
}

use super::to_hex as hex_encode;

/// Push a coalesced batch of blobs (each with its per-blob CAS `base_version`)
/// plus an optional new head (pointer-CAS on `prev_head_hash`). Idempotent: a
/// retry of the same `(base_version, content_nonce, ciphertext)` after the
/// server already applied it returns the current version (the server's
/// replay-detection) rather than a spurious stale.
pub fn push(
    transport: &dyn SyncTransport,
    token: &str,
    blobs: &[PushBlob],
    new_head: Option<(&[u8; HEAD_ID_LEN], &[u8])>,
) -> Result<PushOutcome, PushError> {
    let req = PushReqWire {
        blobs: blobs
            .iter()
            .map(|b| PushBlobWire {
                blob_id_hex: hex_encode(&b.id),
                base_version: b.base_version,
                content_nonce_hex: hex_encode(&b.content_nonce),
                ciphertext_b64: B64.encode(&b.ciphertext),
                tombstone: b.tombstone,
                attachment_id_hex: b.attachment_id.as_ref().map(|id| hex_encode(id)),
            })
            .collect(),
        new_head: new_head.map(|(prev, record)| PushHeadWire {
            prev_head_hash_hex: hex_encode(prev),
            record_b64: B64.encode(record),
        }),
    };
    let body = serde_json::to_vec(&req).map_err(|_| PushError::BadResponse)?;
    let resp = transport.request(HttpMethod::Post, "/sync/push", &body, Some(token))?;

    match resp.status {
        200 => {}
        401 => {
            return Err(if is_device_revoked(&resp.body) {
                PushError::DeviceRevoked
            } else {
                PushError::Unauthenticated
            })
        }
        403 => return Err(PushError::Frozen),
        429 => return Err(PushError::RateLimited),
        413 => return Err(PushError::PayloadTooLarge),
        507 => return Err(PushError::QuotaExceeded),
        409 => {
            let code = serde_json::from_slice::<ErrBodyWire>(&resp.body)
                .map(|e| e.error_code)
                .unwrap_or_default();
            return Err(match code.as_str() {
                "head_stale" => PushError::HeadStale,
                _ => PushError::BlobStale,
            });
        }
        _ => return Err(PushError::BadResponse),
    }

    let wire: PushRespWire =
        serde_json::from_slice(&resp.body).map_err(|_| PushError::BadResponse)?;
    let mut results = Vec::with_capacity(wire.results.len());
    for r in &wire.results {
        let id = hex_to_array::<16>(&r.blob_id_hex).ok_or(PushError::BadResponse)?;
        results.push((id, r.version));
    }
    let head_id = if wire.head_id_hex.is_empty() {
        None
    } else {
        Some(hex_to_array::<HEAD_ID_LEN>(&wire.head_id_hex).ok_or(PushError::BadResponse)?)
    };
    Ok(PushOutcome { results, head_id })
}

// ---------------------------------------------------------------------------
// Attachment byte-transport client (`server-protocol.md` §3.2; MYND-468)
// ---------------------------------------------------------------------------

/// Upload chunk size for `PUT /attachments/{id}?offset=N&total=M`. Small
/// enough that a flaky link loses at most one chunk of progress, large enough
/// that a 64 MiB blob is ≤16 requests.
pub const ATTACHMENT_UPLOAD_CHUNK: usize = 4 * 1024 * 1024;

/// One `HEAD /attachments/{id}` probe result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentProbe {
    /// Bytes the server currently holds for this id.
    pub uploaded: usize,
    /// Whether the upload is complete (the whole blob is stored).
    pub complete: bool,
}

fn attachment_path(id: &[u8; 32]) -> String {
    let mut p = String::with_capacity(13 + 64);
    p.push_str("/attachments/");
    p.push_str(&hex_encode(id));
    p
}

/// `HEAD /attachments/{id}` — the resume/dedup probe. `Ok(None)` = the server
/// holds nothing for this id (404: never uploaded, or deleted — the two are
/// deliberately indistinguishable, §11.4).
pub fn probe_attachment(
    transport: &dyn SyncTransport,
    token: &str,
    id: &[u8; 32],
) -> Result<Option<AttachmentProbe>, PushError> {
    let resp = transport.request_ext(
        HttpMethod::Head,
        &attachment_path(id),
        &[],
        &[],
        Some(token),
    )?;
    match resp.status {
        200 => {
            let uploaded = resp
                .header("x-uploaded-length")
                .and_then(|v| v.parse::<usize>().ok())
                .ok_or(PushError::BadResponse)?;
            let complete = resp.header("x-complete").is_some();
            Ok(Some(AttachmentProbe { uploaded, complete }))
        }
        404 => Ok(None),
        // #7: read the code from the HEADER on this route.
        //
        // This is a HEAD request. A HEAD response carries no body — Go's
        // net/http discards what the handler writes, and this codec does not
        // read one either — so `is_device_revoked(&resp.body)` was fed an
        // always-empty slice and always answered `false`. The one route where
        // the distinction decides whether a client erases its local copy was
        // therefore the one route that could never make it.
        //
        // The body check stays as the fallback for a server that has not
        // shipped the header yet: an absent code still means plain
        // `Unauthenticated`, which is the safe direction — guessing "revoked"
        // from silence is the outcome that cannot be undone by retrying.
        401 => Err(
            if resp.header("x-error-code") == Some("device_revoked")
                || is_device_revoked(&resp.body)
            {
                PushError::DeviceRevoked
            } else {
                PushError::Unauthenticated
            },
        ),
        429 => Err(PushError::RateLimited),
        _ => Err(PushError::BadResponse),
    }
}

/// Upload an attachment's whole ciphertext over the resumable transport:
/// `HEAD` probe → strict-sequential `PUT` chunks from the server's current
/// offset. Idempotent: an already-complete id returns `Ok` without a byte
/// sent (the content-addressed dedup), and a retry resumes where the server
/// really is. A 409 (resume-offset conflict — e.g. a concurrent upload of the
/// same content-addressed id from another device) re-probes and continues
/// from the server's offset, bounded so two pathological writers can't loop
/// forever.
pub fn upload_attachment(
    transport: &dyn SyncTransport,
    token: &str,
    id: &[u8; 32],
    bytes: &[u8],
) -> Result<(), PushError> {
    let path_base = attachment_path(id);
    let total = bytes.len();

    let mut offset = match probe_attachment(transport, token, id)? {
        Some(p) if p.complete => return Ok(()),
        Some(p) => p.uploaded.min(total),
        None => 0,
    };

    let mut conflict_retries = 3u8;
    while offset < total || total == 0 {
        let end = (offset + ATTACHMENT_UPLOAD_CHUNK).min(total);
        let path = format!("{path_base}?offset={offset}&total={total}");
        let resp = transport.request_ext(
            HttpMethod::Put,
            &path,
            &[("Content-Type", "application/octet-stream")],
            &bytes[offset..end],
            Some(token),
        )?;
        match resp.status {
            200 => {
                // Advance to the server's authoritative offset (falls back to
                // our own arithmetic if the header is absent).
                offset = resp
                    .header("x-uploaded-length")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(end);
                if total == 0 {
                    break; // zero-length blob: one empty PUT registers it
                }
            }
            409 => {
                // Resume-offset conflict — re-probe and continue from truth.
                if conflict_retries == 0 {
                    return Err(PushError::BadResponse);
                }
                conflict_retries -= 1;
                match probe_attachment(transport, token, id)? {
                    Some(p) if p.complete => return Ok(()),
                    Some(p) => offset = p.uploaded.min(total),
                    None => offset = 0,
                }
            }
            401 => {
                return Err(if is_device_revoked(&resp.body) {
                    PushError::DeviceRevoked
                } else {
                    PushError::Unauthenticated
                })
            }
            429 => return Err(PushError::RateLimited),
            413 => return Err(PushError::PayloadTooLarge),
            507 => return Err(PushError::QuotaExceeded),
            _ => return Err(PushError::BadResponse),
        }
    }
    Ok(())
}

/// Range size for a chunked attachment download (#265).
///
/// Big enough that a healthy link pays few round trips on a 64 MiB cap, small
/// enough that a drop costs at most this much re-transfer. The upload side's
/// chunking is the client's own and need not match.
const CHUNK: usize = 4 * 1024 * 1024;

/// Download an attachment's whole ciphertext, resuming past `partial` (the
/// locally-buffered prefix from an interrupted earlier attempt). Returns:
/// - `Ok(Some(bytes))` — the complete ciphertext (partial ∥ fetched);
/// - `Ok(None)` — the server holds no **complete** body for this id (absent,
///   deleted, or an upload still in flight) — the caller defers to a later
///   cycle rather than downloading a half-uploaded blob.
///
/// The returned bytes are OPAQUE — the caller MUST verify the whole-blob
/// AEAD/CTX tag before persisting (§3.2: range slices carry no integrity of
/// their own).
pub fn download_attachment(
    transport: &dyn SyncTransport,
    token: &str,
    id: &[u8; 32],
    partial: &[u8],
    // Called after each range lands, with everything received SO FAR
    // (`partial` ∥ fetched). The caller persists it so an interrupted transfer
    // can resume rather than restart (#265). Still opaque: the whole-blob AEAD
    // is verified only once the body is complete, so what this hands over is
    // unverified ciphertext and must not be treated as an attachment yet.
    mut on_progress: impl FnMut(&[u8]),
) -> Result<Option<Vec<u8>>, PullError> {
    let probe = match probe_attachment(transport, token, id) {
        Ok(p) => p,
        Err(PushError::Unauthenticated) => return Err(PullError::Unauthenticated),
        // Carried across the push→pull translation rather than flattened into
        // `BadResponse`: an attachment probe is the first request many cycles
        // make, so losing the distinction here would make revocation look like a
        // protocol error on exactly the path most likely to see it first.
        Err(PushError::DeviceRevoked) => return Err(PullError::DeviceRevoked),
        Err(PushError::RateLimited) => return Err(PullError::RateLimited),
        Err(PushError::Transport(t)) => return Err(PullError::Transport(t)),
        Err(_) => return Err(PullError::BadResponse),
    };
    let Some(probe) = probe else { return Ok(None) };
    if !probe.complete {
        return Ok(None);
    }
    let total = probe.uploaded;

    // A stale/oversized partial can't be trusted — refetch whole.
    let prefix = if partial.len() < total { partial } else { &[] };

    let path = attachment_path(id);
    let mut full = Vec::with_capacity(total);
    full.extend_from_slice(prefix);

    // #265: fetch in RANGES, reporting each one as it lands.
    //
    // The resume branch existed and was unreachable: both callers passed an
    // empty `partial`, and nothing ever produced a non-empty one — because a
    // single whole-body GET yields nothing at all when it fails. Upload has
    // resumed from a HEAD-probed offset since it shipped; download restarted
    // from byte 0 on every drop, which on a large attachment over a poor link
    // is a transfer that cannot finish.
    //
    // Chunking is what makes a partial exist. Each completed range is handed to
    // `on_progress` so the caller can persist it, and a failure part-way leaves
    // the caller holding everything that did arrive.
    while full.len() < total {
        let range = format!(
            "bytes={}-{}",
            full.len(),
            (full.len() + CHUNK).min(total) - 1
        );
        let resp = transport.request_ext(
            HttpMethod::Get,
            &path,
            &[("Range", range.as_str())],
            &[],
            Some(token),
        )?;
        match resp.status {
            206 => {
                if resp.body.is_empty() {
                    // No progress: a server that answers 206 with nothing would
                    // spin this loop forever.
                    return Err(PullError::BadResponse);
                }
                full.extend_from_slice(&resp.body);
                on_progress(&full);
            }
            // A server that ignores Range and sends the whole body is fine —
            // and is the whole answer, so take it and stop.
            200 => {
                if prefix.is_empty() {
                    return Ok(Some(resp.body));
                }
                // With a prefix in hand, a whole-body answer supersedes it:
                // concatenating would duplicate the prefix.
                full = resp.body;
                on_progress(&full);
                return Ok(Some(full));
            }
            404 => return Ok(None),
            // Symmetry with the probe at the head of this flow, which already
            // classifies: without it, a revocation landing in the gap between
            // the probe and this GET reports the wrong class (myne#294).
            401 => {
                return Err(if is_device_revoked(&resp.body) {
                    PullError::DeviceRevoked
                } else {
                    PullError::Unauthenticated
                })
            }
            429 => return Err(PullError::RateLimited),
            _ => return Err(PullError::BadResponse),
        }
    }
    Ok(Some(full))
}

/// Author a two-way **merge head** (§5.3) when the local and remote heads are
/// concurrent (`Dominance::Incomparable`). The merged VV is the componentwise
/// max of the two parents, then the authoring device's component is incremented
/// (§4.1 author consistency `VV[author] == max(parents)[author] + 1`); `seq` is
/// `max(parent_seqs) + 1`; the two parents become `prev_head_hash` (sealed in
/// canonical byte order). The caller computes the merged `manifest_hash`.
pub fn author_merge_head(
    root_key: &[u8; 32],
    account_number_hash: [u8; 16],
    manifest_hash: [u8; 32],
    parent_a: (&[u8; HEAD_ID_LEN], &[VvEntry], u64),
    parent_b: (&[u8; HEAD_ID_LEN], &[VvEntry], u64),
    author_device_id: [u8; DEVICE_ID_LEN],
) -> Result<SealedHead, VaultHeadError> {
    let (id_a, vv_a, seq_a) = parent_a;
    let (id_b, vv_b, seq_b) = parent_b;

    // Componentwise max of the two parent VVs.
    let mut merged: HashMap<[u8; DEVICE_ID_LEN], u64> = HashMap::new();
    for e in vv_a.iter().chain(vv_b.iter()) {
        let slot = merged.entry(e.device_id).or_insert(0);
        *slot = (*slot).max(e.counter);
    }
    // Author consistency: the authoring device's component = max + 1.
    *merged.entry(author_device_id).or_insert(0) += 1;

    let version_vector: Vec<VvEntry> = merged
        .into_iter()
        .map(|(device_id, counter)| VvEntry { device_id, counter })
        .collect();

    let head = VaultHead {
        head_format_version: VAULT_HEAD_FORMAT_V1,
        account_number_hash,
        manifest_hash,
        seq: seq_a.max(seq_b) + 1,
        prev_head_hash: vec![*id_a, *id_b],
        version_vector,
    };
    head.seal(root_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::sync::transport::FakeTransport;
    use protocol::vault_head::open_vault_head;
    use protocol::VAULT_HEAD_FORMAT_V1;

    const ROOT: [u8; 32] = [0x42; 32];

    /// A `HeadAuthority` for the `NTV5` HMAC path, for the many pull tests.
    fn mac() -> super::HeadAuthority<'static> {
        super::HeadAuthority::Mac { root_key: &ROOT }
    }

    fn vv(counters: &[(u8, u64)]) -> Vec<VvEntry> {
        counters
            .iter()
            .map(|&(d, c)| VvEntry {
                device_id: [d; 16],
                counter: c,
            })
            .collect()
    }

    fn sealed_head(vv_entries: &[VvEntry], seq: u64) -> (String, String, [u8; 32]) {
        sealed_head_under(&ROOT, vv_entries, seq)
    }

    /// [`sealed_head`] under an arbitrary root — the previous key generation, for
    /// the re-key re-base tests (#429).
    fn sealed_head_under(
        root: &[u8; 32],
        vv_entries: &[VvEntry],
        seq: u64,
    ) -> (String, String, [u8; 32]) {
        let sealed = VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V1,
            account_number_hash: [0x33; 16],
            manifest_hash: [0x55; 32],
            seq,
            prev_head_hash: Vec::new(),
            version_vector: vv_entries.to_vec(),
        }
        .seal(root)
        .unwrap();
        let mut id_hex = String::new();
        for b in &sealed.head_id {
            id_hex.push_str(&format!("{b:02x}"));
        }
        (B64.encode(&sealed.record), id_hex, sealed.head_id)
    }

    fn pull_body(metas_json: &str, next_cursor: u64, head: Option<(&str, &str)>) -> Vec<u8> {
        let head_json = match head {
            Some((rec, id)) => {
                format!(",\"head\":{{\"record_b64\":\"{rec}\",\"head_id_hex\":\"{id}\"}}")
            }
            None => String::new(),
        };
        format!("{{\"metas\":[{metas_json}],\"next_cursor\":{next_cursor}{head_json}}}")
            .into_bytes()
    }

    #[test]
    fn empty_vault_pull_ok() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body("", 0, None),
        );
        let page = pull_page(&t, &mac(), "tok", &[], 0, &HashMap::new(), false, false).unwrap();
        assert_eq!(page.next_cursor, 0);
        assert!(page.head.is_none());
        assert!(page.changed.is_empty());
    }

    #[test]
    fn extension_head_and_changed_blob_detected() {
        let baseline = vv(&[(0xA1, 1)]);
        let (rec, id, head_id) = sealed_head(&vv(&[(0xA1, 2)]), 2);
        let meta = "{\"uuid_hex\":\"0101010101010101010101010101010101\",\"version\":5,\"content_nonce_hex\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"size\":10}";
        // Note: uuid is 32 hex chars (16 bytes) — fix the literal length below.
        let meta = meta.replace(
            "0101010101010101010101010101010101",
            "01010101010101010101010101010101",
        );
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=1",
            200,
            pull_body(&meta, 7, Some((&rec, &id))),
        );

        let local = HashMap::new(); // blob unknown locally → changed
        let page = pull_page(&t, &mac(), "tok", &baseline, 1, &local, false, false).unwrap();
        let vh = page.head.unwrap();
        assert_eq!(vh.dominance, Dominance::Extension);
        assert_eq!(vh.head_id, head_id);
        assert_eq!(page.changed.len(), 1);
        assert_eq!(page.changed[0].id, [0x01; 16]);
        assert_eq!(page.next_cursor, 7);
    }

    #[test]
    fn unchanged_blob_not_listed() {
        let (rec, id, _) = sealed_head(&vv(&[(0xA1, 1)]), 1);
        let meta = "{\"uuid_hex\":\"01010101010101010101010101010101\",\"version\":5,\"content_nonce_hex\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"size\":10}";
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body(meta, 7, Some((&rec, &id))),
        );
        let mut local = HashMap::new();
        local.insert([0x01u8; 16], [0xaau8; 24]); // same content_nonce → not changed
        let page = pull_page(&t, &mac(), "tok", &[], 0, &local, false, false).unwrap();
        assert!(page.changed.is_empty());
    }

    #[test]
    fn rollback_rejected_not_silently_accepted() {
        // Baseline has A:3; candidate head regresses A:2 → Rollback.
        let baseline = vv(&[(0xA1, 3)]);
        let (rec, id, _) = sealed_head(&vv(&[(0xA1, 2)]), 2);
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body("", 9, Some((&rec, &id))),
        );
        assert_eq!(
            pull_page(
                &t,
                &mac(),
                "tok",
                &baseline,
                0,
                &HashMap::new(),
                false,
                false
            )
            .unwrap_err(),
            PullError::RollbackRejected
        );
    }

    #[test]
    fn tampered_head_record_rejected() {
        let (rec, id, _) = sealed_head(&vv(&[(0xA1, 1)]), 1);
        // Flip a base64 char to corrupt the record → MAC verify fails.
        let mut bad = rec.clone();
        let last = bad.pop().unwrap();
        bad.push(if last == 'A' { 'B' } else { 'A' });
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body("", 1, Some((&bad, &id))),
        );
        let r = pull_page(&t, &mac(), "tok", &[], 0, &HashMap::new(), false, false);
        assert!(matches!(
            r,
            Err(PullError::HeadInvalid)
                | Err(PullError::HeadIdMismatch)
                | Err(PullError::BadResponse)
        ));
    }

    /// After a local re-key the server's head is MAC'd under a `root_key` that no
    /// longer exists. Without the re-base exemption that is `HeadInvalid` — the
    /// same signal a forged head produces — which the cycle routes to the
    /// malicious-server alert and then aborts on, before it could re-author the
    /// head. Self-perpetuating: a sanctioned local migration accuses the server,
    /// every cycle, forever (myne-md/myne#429).
    ///
    /// The two arms are asserted together on the SAME bytes, so the test states
    /// the whole rule: unopenable is still fatal by default, and permitted only
    /// for the device that says it just re-keyed.
    #[test]
    fn a_head_from_the_previous_key_generation_is_fatal_unless_rebasing() {
        const OLD_ROOT: [u8; 32] = [0x9au8; 32];
        let (rec, id_hex, id) = sealed_head_under(&OLD_ROOT, &vv(&[(0xA1, 4)]), 4);
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body("", 1, Some((&rec, &id_hex))),
        );

        // Default: indistinguishable from a forgery, and treated as one.
        assert_eq!(
            pull_page(&t, &mac(), "tok", &[], 0, &HashMap::new(), false, false).unwrap_err(),
            PullError::HeadInvalid,
            "an unopenable head must stay fatal when this device did not re-key"
        );

        // Re-basing: the head is not verified, and only its id is taken.
        let page = pull_page(&t, &mac(), "tok", &[], 0, &HashMap::new(), false, true)
            .expect("a re-basing device accepts the stale-generation head");
        assert!(
            page.head.is_none(),
            "an unverified head must contribute no VV, seq or manifest_hash"
        );
        assert_eq!(
            page.unverifiable_head_id,
            Some(id),
            "the CAS parent for the re-authored head is the old head's id"
        );
    }

    /// The re-base exemption is narrow: it forgives an unopenable MAC, and
    /// nothing else. A server answering with a record that does not hash to the
    /// `head_id` it advertised is still rejected — otherwise a re-keying device
    /// would adopt an attacker-chosen CAS parent.
    #[test]
    fn rebasing_still_rejects_a_head_id_that_does_not_match_its_record() {
        const OLD_ROOT: [u8; 32] = [0x9au8; 32];
        let (rec, _, _) = sealed_head_under(&OLD_ROOT, &vv(&[(0xA1, 4)]), 4);
        let lying_id = "ab".repeat(32);
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body("", 1, Some((&rec, &lying_id))),
        );
        assert_eq!(
            pull_page(&t, &mac(), "tok", &[], 0, &HashMap::new(), false, true).unwrap_err(),
            PullError::HeadIdMismatch
        );
    }

    #[test]
    fn cursor_expired_maps_to_reconcile_signal() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=5",
            410,
            b"{\"error_code\":\"cursor_expired\"}".to_vec(),
        );
        assert_eq!(
            pull_page(&t, &mac(), "tok", &[], 5, &HashMap::new(), false, false).unwrap_err(),
            PullError::CursorExpired
        );
    }

    #[test]
    fn unauthenticated_surfaced() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            401,
            b"{\"error_code\":\"unauthenticated\"}".to_vec(),
        );
        assert_eq!(
            pull_page(&t, &mac(), "tok", &[], 0, &HashMap::new(), false, false).unwrap_err(),
            PullError::Unauthenticated
        );
    }

    // ── device_revoked (task 94) ────────────────────────────────────────────
    //
    // The whole value of the code is the DISTINCTION, so every test here is a
    // pair: the same status, two bodies, two verdicts. A test that only asserted
    // the new variant would pass just as happily against a parser that returned
    // it for every 401 — which would erase a web client's local copy on an
    // ordinary expired token.

    #[test]
    fn a_revoked_device_is_not_reported_as_unauthenticated() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            401,
            b"{\"error_code\":\"device_revoked\"}".to_vec(),
        );
        assert_eq!(
            pull_page(&t, &mac(), "tok", &[], 0, &HashMap::new(), false, false).unwrap_err(),
            PullError::DeviceRevoked
        );
    }

    /// The safe default, and the direction it has to be safe in: an unparseable
    /// or bodyless 401 is `Unauthenticated`. Guessing "revoked" from a missing
    /// body would let any malformed response erase a browser's local copy.
    #[test]
    fn a_401_with_no_usable_body_stays_unauthenticated() {
        for body in [b"".to_vec(), b"not json".to_vec(), b"{}".to_vec()] {
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/sync/pull?cursor=0", 401, body);
            assert_eq!(
                pull_page(&t, &mac(), "tok", &[], 0, &HashMap::new(), false, false).unwrap_err(),
                PullError::Unauthenticated
            );
        }
    }

    /// myne#294 — the blob download is the arm a revocation landing MID-CYCLE
    /// hits, and it was the one arm that never looked inside the body.
    ///
    /// By the time the per-note loop runs, `pull_to_stable` has already returned
    /// 200s; the next minutes are `GET /sync/blob`. A revocation there was
    /// reported as a retryable "sign-in expired", so the UI showed the wrong copy
    /// and the web client's terminal takeover never rendered — for up to one
    /// 15-minute auth park.
    #[test]
    fn the_blob_download_distinguishes_it_too() {
        let id = [0x11u8; 16];
        let path = format!("/sync/blob?id={}", "11".repeat(16));

        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            &path,
            401,
            b"{\"error_code\":\"device_revoked\"}".to_vec(),
        );
        assert_eq!(
            download_blob(&t, "tok", &id).unwrap_err(),
            PullError::DeviceRevoked
        );

        // The other half of the pair: an ordinary expired token must NOT be
        // reported as a revocation, or a browser erases its local copy.
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, &path, 401, b"{}".to_vec());
        assert_eq!(
            download_blob(&t, "tok", &id).unwrap_err(),
            PullError::Unauthenticated
        );
    }

    /// The count in `is_device_revoked`'s doc used to be a hand-maintained
    /// number, and it was wrong — it said five while three arms did not call the
    /// helper at all, which is how the omission above survived review.
    ///
    /// This reads the file instead. A hand-counted invariant is not a check; the
    /// point of replacing the number with this is that adding a 401 arm that
    /// forgets the body now fails here rather than shipping a terminal condition
    /// as a retryable one.
    #[test]
    fn every_401_arm_consults_the_body() {
        let src = include_str!("engine.rs");
        let mut arms = 0usize;
        let lines: Vec<&str> = src.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if !line.trim_start().starts_with("401 =>") {
                continue;
            }
            arms += 1;
            // The classification is either on this line or within the arm's
            // first few lines; every existing arm resolves inside four.
            let window = lines[i..(i + 6).min(lines.len())].join("\n");
            assert!(
                window.contains("is_device_revoked") || window.contains("x-error-code"),
                "the 401 arm at line {} does not classify the body — a revocation \
                 reported as a retryable auth failure is exactly myne#294",
                i + 1,
            );
        }
        // A floor, raised whenever an arm is added — the count having been wrong
        // once (myne#294) is the whole reason this test exists.
        assert!(arms >= 7, "expected every 401 arm to be found, saw {arms}");
    }

    #[test]
    fn the_push_path_distinguishes_it_too() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/sync/push",
            401,
            b"{\"error_code\":\"device_revoked\"}".to_vec(),
        );
        assert_eq!(
            push(&t, "tok", &[], None).unwrap_err(),
            PushError::DeviceRevoked
        );
        let t2 = FakeTransport::new();
        t2.on(
            HttpMethod::Post,
            "/sync/push",
            401,
            b"{\"error_code\":\"unauthenticated\"}".to_vec(),
        );
        assert_eq!(
            push(&t2, "tok", &[], None).unwrap_err(),
            PushError::Unauthenticated
        );
    }

    /// A close cousin that must NOT match: the code is compared whole, not by
    /// prefix or substring, so a server that grows `device_revoked_pending`
    /// later does not silently trigger an erase.
    #[test]
    fn only_the_exact_code_counts() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            401,
            b"{\"error_code\":\"device_revoked_soon\"}".to_vec(),
        );
        assert_eq!(
            pull_page(&t, &mac(), "tok", &[], 0, &HashMap::new(), false, false).unwrap_err(),
            PullError::Unauthenticated
        );
    }

    #[test]
    fn pull_to_stable_drains_pages() {
        let baseline: Vec<VvEntry> = Vec::new();
        let m1 = "{\"uuid_hex\":\"01010101010101010101010101010101\",\"version\":1,\"content_nonce_hex\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"size\":1}";
        let m2 = "{\"uuid_hex\":\"02020202020202020202020202020202\",\"version\":2,\"content_nonce_hex\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"size\":1}";
        let t = FakeTransport::new();
        // page 1: cursor 0 → next 1, one blob
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body(m1, 1, None),
        );
        // page 2: cursor 1 → next 1 (stable), one more blob
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=1",
            200,
            pull_body(m2, 1, None),
        );
        let page = pull_to_stable(
            &t,
            &mac(),
            "tok",
            &baseline,
            0,
            &HashMap::new(),
            false,
            false,
        )
        .unwrap();
        assert_eq!(page.next_cursor, 1);
        assert_eq!(page.changed.len(), 2);
    }

    // Regression for the pagination×reclaim-floor wedge: a vault larger than one
    // page whose reclaim floor sits beyond the first page boundary. An incremental
    // walk 410s on page 2 (cursor below floor); the reconcile walk must pass
    // `reconcile=1` so the server exempts page 2 and the drain completes.
    #[test]
    fn pull_to_stable_reconcile_walks_past_floor() {
        let baseline: Vec<VvEntry> = Vec::new();
        let m1 = "{\"uuid_hex\":\"01010101010101010101010101010101\",\"version\":1,\"content_nonce_hex\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"size\":1}";
        let m2 = "{\"uuid_hex\":\"02020202020202020202020202020202\",\"version\":2,\"content_nonce_hex\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"size\":1}";
        let t = FakeTransport::new();
        // Incremental page-2 (no reconcile flag) at a sub-floor cursor → 410.
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=1",
            410,
            b"{\"error_code\":\"cursor_expired\"}".to_vec(),
        );
        // Reconcile walk: page 1 (cursor 0 → next 1) then page 2 (cursor 1 → next 2,
        // stable) — both carry reconcile=1, so the server serves the sub-floor page.
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0&reconcile=1",
            200,
            pull_body(m1, 1, None),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=1&reconcile=1",
            200,
            pull_body(m2, 1, None), // next == cursor → stable, walk stops
        );
        // Plain walk wedges on page 2.
        assert_eq!(
            pull_to_stable(
                &t,
                &mac(),
                "tok",
                &baseline,
                1,
                &HashMap::new(),
                false,
                false
            )
            .unwrap_err(),
            PullError::CursorExpired
        );
        // Reconcile walk drains both pages.
        let page = pull_to_stable(
            &t,
            &mac(),
            "tok",
            &baseline,
            0,
            &HashMap::new(),
            true,
            false,
        )
        .unwrap();
        assert_eq!(page.next_cursor, 1);
        assert_eq!(page.changed.len(), 2);
    }

    // §11.3/F2 wire shape: a page window whose records were ALL reclaimed
    // returns ZERO metas with an ADVANCING cursor (the server omits reclaimed
    // records but still walks the cursor across them). The drain must keep
    // going — stalling here would strand the cursor below the reclaim floor
    // and 410-loop forever.
    #[test]
    fn pull_to_stable_tolerates_empty_page_with_advancing_cursor() {
        let m = "{\"uuid_hex\":\"03030303030303030303030303030303\",\"version\":1,\"content_nonce_hex\":\"cccccccccccccccccccccccccccccccccccccccccccccccc\",\"size\":1}";
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body("", 5, None),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=5",
            200,
            pull_body(m, 6, None),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=6",
            200,
            pull_body("", 6, None),
        );
        let page =
            pull_to_stable(&t, &mac(), "tok", &[], 0, &HashMap::new(), false, false).unwrap();
        assert_eq!(page.next_cursor, 6);
        assert_eq!(
            page.changed.len(),
            1,
            "the live record past the gap still arrives"
        );
    }

    #[test]
    fn download_blob_maps_reclaimed_and_missing() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/blob?id=04040404040404040404040404040404",
            410,
            b"{\"error_code\":\"blob_reclaimed\"}".to_vec(),
        );
        t.on(
            HttpMethod::Get,
            "/sync/blob?id=05050505050505050505050505050505",
            404,
            b"{\"error_code\":\"not_found\"}".to_vec(),
        );
        assert_eq!(
            download_blob(&t, "tok", &[0x04; 16]).unwrap_err(),
            PullError::BlobReclaimed
        );
        assert_eq!(
            download_blob(&t, "tok", &[0x05; 16]).unwrap_err(),
            PullError::BlobNotFound
        );
    }

    #[test]
    fn download_blob_decodes_ciphertext() {
        let t = FakeTransport::new();
        let body = format!("{{\"ciphertext_b64\":\"{}\"}}", B64.encode(b"opaque-bytes"));
        t.on(
            HttpMethod::Get,
            "/sync/blob?id=01010101010101010101010101010101",
            200,
            body.into_bytes(),
        );
        let bytes = download_blob(&t, "tok", &[0x01; 16]).unwrap();
        assert_eq!(bytes, b"opaque-bytes");
    }

    /// Build a batch-response body from `(id_byte, ciphertext)` served entries
    /// and `(id_byte, code)` omissions.
    fn batch_body(served: &[(u8, &str)], omitted: &[(u8, &str)]) -> Vec<u8> {
        let b = |x: u8| hex_lower(&[x; 16]);
        let blobs: Vec<String> = served
            .iter()
            .map(|(id, ct)| {
                format!(
                    "{{\"blob_id_hex\":\"{}\",\"ciphertext_b64\":\"{}\"}}",
                    b(*id),
                    B64.encode(ct.as_bytes())
                )
            })
            .collect();
        let om: Vec<String> = omitted
            .iter()
            .map(|(id, code)| {
                format!(
                    "{{\"blob_id_hex\":\"{}\",\"error_code\":\"{code}\"}}",
                    b(*id)
                )
            })
            .collect();
        format!(
            "{{\"blobs\":[{}],\"omitted\":[{}]}}",
            blobs.join(","),
            om.join(",")
        )
        .into_bytes()
    }

    fn served_batch(t: &FakeTransport, ids: &[[u8; 16]]) -> BlobBatch {
        match download_blobs(t, "tok", ids).unwrap() {
            BlobBatchOutcome::Served(b) => b,
            BlobBatchOutcome::RouteUnsupported => panic!("expected a served batch"),
        }
    }

    /// The three per-id outcomes in one response, each mapping to the omission
    /// class the single-blob route signals as a status.
    #[test]
    fn download_blobs_maps_omitted_codes_per_id() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/sync/blobs",
            200,
            batch_body(
                &[(0x01, "live-bytes")],
                &[(0x02, "blob_reclaimed"), (0x03, "not_found")],
            ),
        );
        let batch = served_batch(&t, &[[0x01; 16], [0x02; 16], [0x03; 16]]);
        assert_eq!(batch.outcome(&[0x01; 16]), Some(Ok(&b"live-bytes"[..])));
        assert_eq!(
            batch.outcome(&[0x02; 16]),
            Some(Err(BlobOmission::Reclaimed))
        );
        assert_eq!(
            batch.outcome(&[0x03; 16]),
            Some(Err(BlobOmission::NotFound))
        );
    }

    /// An `error_code` this client does not know degrades to the SAFE
    /// disposition (skip, mutate nothing) rather than being unaccounted for. A
    /// server growing a fourth condition must not wedge a client that would
    /// otherwise re-request the id forever.
    #[test]
    fn download_blobs_maps_an_unknown_code_to_other() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/sync/blobs",
            200,
            batch_body(&[], &[(0x07, "internal"), (0x08, "some_future_condition")]),
        );
        let batch = served_batch(&t, &[[0x07; 16], [0x08; 16]]);
        assert_eq!(batch.outcome(&[0x07; 16]), Some(Err(BlobOmission::Other)));
        assert_eq!(batch.outcome(&[0x08; 16]), Some(Err(BlobOmission::Other)));
    }

    /// An id the response accounted for NOWHERE is `None` — "not served, ask
    /// again" — and must never read as empty bytes. A lookup that defaulted a
    /// missing key to `Vec::new()` would reproduce the exact shape §11.3 was
    /// written against (an empty body a blind client writes over a live note),
    /// arrived at through a different door.
    #[test]
    fn download_blobs_treats_an_unaccounted_id_as_not_served() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/sync/blobs",
            200,
            batch_body(&[(0x01, "served")], &[]),
        );
        let batch = served_batch(&t, &[[0x01; 16], [0x09; 16]]);
        assert_eq!(batch.outcome(&[0x01; 16]), Some(Ok(&b"served"[..])));
        assert_eq!(batch.outcome(&[0x09; 16]), None, "unaccounted must be None");
    }

    /// A server that predates the route answers 404 — or 405 through a proxy
    /// that knows the /sync prefix but not the method. Both mean "no such
    /// route", and neither is an error the cycle should fail on.
    #[test]
    fn download_blobs_404_and_405_are_route_unsupported() {
        for status in [404u16, 405] {
            let t = FakeTransport::new();
            t.on(HttpMethod::Post, "/sync/blobs", status, b"{}".to_vec());
            assert_eq!(
                download_blobs(&t, "tok", &[[0x01; 16]]).unwrap(),
                BlobBatchOutcome::RouteUnsupported,
                "status {status}",
            );
        }
    }

    #[test]
    fn download_blobs_maps_status_errors() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Post, "/sync/blobs", 429, b"{}".to_vec());
        assert_eq!(
            download_blobs(&t, "tok", &[[0x01; 16]]).unwrap_err(),
            PullError::RateLimited
        );
        // A whole-response 410 is a server this client does not understand:
        // reclamation is a per-id code inside a 200 on this route.
        let t410 = FakeTransport::new();
        t410.on(HttpMethod::Post, "/sync/blobs", 410, b"{}".to_vec());
        assert_eq!(
            download_blobs(&t410, "tok", &[[0x01; 16]]).unwrap_err(),
            PullError::BadResponse
        );
        let trev = FakeTransport::new();
        trev.on(
            HttpMethod::Post,
            "/sync/blobs",
            401,
            b"{\"error_code\":\"device_revoked\"}".to_vec(),
        );
        assert_eq!(
            download_blobs(&trev, "tok", &[[0x01; 16]]).unwrap_err(),
            PullError::DeviceRevoked
        );
        let tauth = FakeTransport::new();
        tauth.on(HttpMethod::Post, "/sync/blobs", 401, b"{}".to_vec());
        assert_eq!(
            download_blobs(&tauth, "tok", &[[0x01; 16]]).unwrap_err(),
            PullError::Unauthenticated
        );
    }

    #[test]
    fn download_blobs_rejects_malformed_bodies() {
        for body in [
            &b"not json"[..],
            // A non-hex id: accepting it would let a server steer bytes to an id
            // the client never asked about.
            b"{\"blobs\":[{\"blob_id_hex\":\"zz\",\"ciphertext_b64\":\"\"}]}",
            b"{\"blobs\":[{\"blob_id_hex\":\"01010101010101010101010101010101\",\"ciphertext_b64\":\"!!!\"}]}",
        ] {
            let t = FakeTransport::new();
            t.on(HttpMethod::Post, "/sync/blobs", 200, body.to_vec());
            assert_eq!(
                download_blobs(&t, "tok", &[[0x01; 16]]).unwrap_err(),
                PullError::BadResponse,
            );
        }
    }

    fn one_blob() -> PushBlob {
        PushBlob {
            id: [0x01; 16],
            base_version: 3,
            content_nonce: [0xaa; 24],
            ciphertext: b"ct".to_vec(),
            tombstone: false,
            attachment_id: None,
        }
    }

    #[test]
    fn push_success_maps_results_and_head() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/sync/push",
            200,
            b"{\"results\":[{\"blob_id_hex\":\"01010101010101010101010101010101\",\"version\":4}],\"head_id_hex\":\"22222222222222222222222222222222222222222222222222222222222222222\"}"
                .to_vec(),
        );
        // head_id_hex above is 65 chars (bad) — fix to 64.
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/sync/push",
            200,
            b"{\"results\":[{\"blob_id_hex\":\"01010101010101010101010101010101\",\"version\":4}],\"head_id_hex\":\"2222222222222222222222222222222222222222222222222222222222222222\"}"
                .to_vec(),
        );
        let out = push(&t, "tok", &[one_blob()], None).unwrap();
        assert_eq!(out.results, vec![([0x01u8; 16], 4)]);
        assert_eq!(out.head_id, Some([0x22u8; 32]));
        // The request carried the token + the blob body.
        let seen = t.requests();
        assert_eq!(seen[0].3.as_deref(), Some("tok"));
        assert!(!seen[0].2.is_empty());
    }

    #[test]
    fn push_blob_stale_409() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/sync/push",
            409,
            b"{\"error_code\":\"blob_stale\"}".to_vec(),
        );
        assert_eq!(
            push(&t, "tok", &[one_blob()], None).unwrap_err(),
            PushError::BlobStale
        );
    }

    #[test]
    fn push_head_stale_409() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/sync/push",
            409,
            b"{\"error_code\":\"head_stale\"}".to_vec(),
        );
        let prev = [0x11u8; 32];
        assert_eq!(
            push(&t, "tok", &[], Some((&prev, b"rec"))).unwrap_err(),
            PushError::HeadStale
        );
    }

    #[test]
    fn push_quota_and_payload() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/sync/push",
            507,
            b"{\"error_code\":\"quota\"}".to_vec(),
        );
        assert_eq!(
            push(&t, "tok", &[one_blob()], None).unwrap_err(),
            PushError::QuotaExceeded
        );

        let t2 = FakeTransport::new();
        t2.on(HttpMethod::Post, "/sync/push", 413, b"{}".to_vec());
        assert_eq!(
            push(&t2, "tok", &[one_blob()], None).unwrap_err(),
            PushError::PayloadTooLarge
        );
    }

    // ---- attachment byte-transport client (MYND-468) ----

    const ATT_ID: [u8; 32] = [0xEE; 32];

    fn att_path() -> String {
        format!("/attachments/{}", "ee".repeat(32))
    }

    #[test]
    fn probe_attachment_reads_headers_and_maps_absent() {
        let t = FakeTransport::new();
        t.on_ext(
            HttpMethod::Head,
            &att_path(),
            200,
            Vec::new(),
            vec![
                ("X-Uploaded-Length".to_string(), "7".to_string()),
                ("X-Complete".to_string(), "1".to_string()),
            ],
        );
        assert_eq!(
            probe_attachment(&t, "tok", &ATT_ID).unwrap(),
            Some(AttachmentProbe {
                uploaded: 7,
                complete: true
            })
        );

        let t404 = FakeTransport::new();
        t404.on(HttpMethod::Head, &att_path(), 404, Vec::new());
        assert_eq!(probe_attachment(&t404, "tok", &ATT_ID).unwrap(), None);
    }

    #[test]
    fn upload_attachment_fresh_puts_from_zero() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Head, &att_path(), 404, Vec::new());
        t.on_ext(
            HttpMethod::Put,
            &format!("{}?offset=0&total=5", att_path()),
            200,
            Vec::new(),
            vec![("X-Uploaded-Length".to_string(), "5".to_string())],
        );
        upload_attachment(&t, "tok", &ATT_ID, b"hello").unwrap();
        let seen = t.requests();
        assert_eq!(seen.len(), 2); // HEAD + one PUT
        assert_eq!(seen[1].0, HttpMethod::Put);
        assert_eq!(seen[1].2, b"hello");
        // The PUT carries the octet-stream content type.
        assert!(seen[1]
            .4
            .iter()
            .any(|(n, v)| n == "Content-Type" && v == "application/octet-stream"));
    }

    #[test]
    fn upload_attachment_resumes_from_server_offset_and_dedups_complete() {
        // Server already holds 3 of 5 bytes → one PUT from offset 3.
        let t = FakeTransport::new();
        t.on_ext(
            HttpMethod::Head,
            &att_path(),
            200,
            Vec::new(),
            vec![("X-Uploaded-Length".to_string(), "3".to_string())],
        );
        t.on_ext(
            HttpMethod::Put,
            &format!("{}?offset=3&total=5", att_path()),
            200,
            Vec::new(),
            vec![("X-Uploaded-Length".to_string(), "5".to_string())],
        );
        upload_attachment(&t, "tok", &ATT_ID, b"hello").unwrap();
        let seen = t.requests();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[1].2, b"lo"); // only the tail

        // Already complete → HEAD only, zero PUTs (content-addressed dedup).
        let t2 = FakeTransport::new();
        t2.on_ext(
            HttpMethod::Head,
            &att_path(),
            200,
            Vec::new(),
            vec![
                ("X-Uploaded-Length".to_string(), "5".to_string()),
                ("X-Complete".to_string(), "1".to_string()),
            ],
        );
        upload_attachment(&t2, "tok", &ATT_ID, b"hello").unwrap();
        assert_eq!(t2.requests().len(), 1);
    }

    #[test]
    fn upload_attachment_maps_quota_and_cap() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Head, &att_path(), 404, Vec::new());
        t.on(
            HttpMethod::Put,
            &format!("{}?offset=0&total=2", att_path()),
            507,
            Vec::new(),
        );
        assert_eq!(
            upload_attachment(&t, "tok", &ATT_ID, b"ct").unwrap_err(),
            PushError::QuotaExceeded
        );

        let t2 = FakeTransport::new();
        t2.on(HttpMethod::Head, &att_path(), 404, Vec::new());
        t2.on(
            HttpMethod::Put,
            &format!("{}?offset=0&total=2", att_path()),
            413,
            Vec::new(),
        );
        assert_eq!(
            upload_attachment(&t2, "tok", &ATT_ID, b"ct").unwrap_err(),
            PushError::PayloadTooLarge
        );
    }

    #[test]
    fn download_attachment_full_and_resume() {
        // Complete on the server → plain GET returns the body.
        let t = FakeTransport::new();
        t.on_ext(
            HttpMethod::Head,
            &att_path(),
            200,
            Vec::new(),
            vec![
                ("X-Uploaded-Length".to_string(), "5".to_string()),
                ("X-Complete".to_string(), "1".to_string()),
            ],
        );
        t.on(HttpMethod::Get, &att_path(), 200, b"hello".to_vec());
        assert_eq!(
            download_attachment(&t, "tok", &ATT_ID, &[], |_| {}).unwrap(),
            Some(b"hello".to_vec())
        );

        // Resume: 3 bytes buffered locally → Range GET, reassembled.
        let t2 = FakeTransport::new();
        t2.on_ext(
            HttpMethod::Head,
            &att_path(),
            200,
            Vec::new(),
            vec![
                ("X-Uploaded-Length".to_string(), "5".to_string()),
                ("X-Complete".to_string(), "1".to_string()),
            ],
        );
        t2.on(HttpMethod::Get, &att_path(), 206, b"lo".to_vec());
        // #265: the callback reports progress so a caller can resume; the range
        // is now bounded on both ends, because chunking is what makes a partial
        // exist at all.
        let mut progress: Vec<usize> = Vec::new();
        assert_eq!(
            download_attachment(&t2, "tok", &ATT_ID, b"hel", |so_far| progress
                .push(so_far.len()))
            .unwrap(),
            Some(b"hello".to_vec())
        );
        assert_eq!(progress, vec![5], "each landed range is reported");
        let seen = t2.requests();
        assert!(seen[1]
            .4
            .iter()
            .any(|(n, v)| n == "Range" && v.starts_with("bytes=3-")));
    }

    /// #265: a drop part-way leaves the caller holding what DID arrive.
    ///
    /// The resume branch existed and was unreachable — both callers passed an
    /// empty prefix, and a single whole-body GET yields nothing at all when it
    /// fails, so nothing could ever produce a non-empty one. Upload has resumed
    /// from a HEAD-probed offset since it shipped; download restarted from byte
    /// zero on every drop.
    #[test]
    fn download_attachment_reports_progress_before_a_failure() {
        let t = FakeTransport::new();
        t.on_ext(
            HttpMethod::Head,
            &att_path(),
            200,
            Vec::new(),
            vec![
                ("X-Uploaded-Length".to_string(), "5".to_string()),
                ("X-Complete".to_string(), "1".to_string()),
            ],
        );
        // The first range lands; the second fails.
        t.on(HttpMethod::Get, &att_path(), 206, b"he".to_vec());
        let mut best: Vec<u8> = Vec::new();
        let _ = download_attachment(&t, "tok", &ATT_ID, &[], |so_far| {
            if so_far.len() > best.len() {
                best.clear();
                best.extend_from_slice(so_far);
            }
        });
        assert!(
            !best.is_empty(),
            "a partial transfer must hand back what arrived, or resume is impossible"
        );
    }

    #[test]
    fn download_attachment_defers_on_absent_or_incomplete() {
        // 404 → None (absent or deleted — non-distinguishing).
        let t = FakeTransport::new();
        t.on(HttpMethod::Head, &att_path(), 404, Vec::new());
        assert_eq!(
            download_attachment(&t, "tok", &ATT_ID, &[], |_| {}).unwrap(),
            None
        );

        // Incomplete upload → None (never download a half-uploaded blob).
        let t2 = FakeTransport::new();
        t2.on_ext(
            HttpMethod::Head,
            &att_path(),
            200,
            Vec::new(),
            vec![("X-Uploaded-Length".to_string(), "3".to_string())],
        );
        assert_eq!(
            download_attachment(&t2, "tok", &ATT_ID, &[], |_| {}).unwrap(),
            None
        );
    }

    #[test]
    fn push_serializes_attachment_record_with_empty_ciphertext() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/sync/push",
            200,
            b"{\"results\":[{\"blob_id_hex\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\",\"version\":1}]}"
                .to_vec(),
        );
        let record = PushBlob {
            id: [0xEE; 16],
            base_version: 0,
            content_nonce: [0xaa; 24],
            ciphertext: Vec::new(),
            tombstone: false,
            attachment_id: Some(ATT_ID),
        };
        push(&t, "tok", &[record], None).unwrap();
        let seen = t.requests();
        let body: serde_json::Value = serde_json::from_slice(&seen[0].2).unwrap();
        let blob = &body["blobs"][0];
        assert_eq!(blob["ciphertext_b64"], "");
        assert_eq!(blob["attachment_id_hex"], "ee".repeat(32));
        assert!(blob.get("tombstone").is_none()); // skipped when false
                                                  // A note record omits attachment_id_hex entirely.
        let t2 = FakeTransport::new();
        t2.on(
            HttpMethod::Post,
            "/sync/push",
            200,
            b"{\"results\":[]}".to_vec(),
        );
        push(&t2, "tok", &[one_blob()], None).unwrap();
        let body2: serde_json::Value = serde_json::from_slice(&t2.requests()[0].2).unwrap();
        assert!(body2["blobs"][0].get("attachment_id_hex").is_none());
    }

    #[test]
    fn pull_meta_echoes_attachment_id() {
        let meta = "{\"uuid_hex\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\",\"version\":1,\"content_nonce_hex\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"size\":0,\"attachment_id_hex\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\"}";
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body(meta, 1, None),
        );
        let page = pull_page(&t, &mac(), "tok", &[], 0, &HashMap::new(), false, false).unwrap();
        assert_eq!(page.changed.len(), 1);
        assert_eq!(page.changed[0].id, [0xEE; 16]);
        assert_eq!(page.changed[0].attachment_id, Some([0xEE; 32]));
    }

    #[test]
    fn merge_head_takes_componentwise_max_plus_author_increment() {
        let root = [0x42u8; 32];
        // parent A: {A:2, B:1}; parent B: {A:1, B:3}. componentwise max = {A:2, B:3}.
        let vv_a = vv(&[(0xA1, 2), (0xB2, 1)]);
        let vv_b = vv(&[(0xA1, 1), (0xB2, 3)]);
        let (_, _, id_a) = sealed_head(&vv_a, 2);
        let (_, _, id_b) = sealed_head(&vv_b, 3);
        let author = [0xA1u8; 16]; // device A authors the merge

        let sealed = author_merge_head(
            &root,
            [0x33; 16],
            [0x55; 32],
            (&id_a, &vv_a, 2),
            (&id_b, &vv_b, 3),
            author,
        )
        .unwrap();

        let head = open_vault_head(&root, &sealed.record).unwrap();
        assert_eq!(head.prev_head_hash.len(), 2);
        assert_eq!(head.seq, 4); // max(2,3)+1
        let get = |d: u8| {
            head.version_vector
                .iter()
                .find(|e| e.device_id == [d; 16])
                .map(|e| e.counter)
                .unwrap_or(0)
        };
        assert_eq!(get(0xA1), 3, "author A: max(2,1)=2 then +1 = 3");
        assert_eq!(get(0xB2), 3, "B: max(1,3)=3, not author → no increment");

        // The merge head dominates each parent (Extension over both).
        assert_eq!(
            vv_dominance(&vv_a, &head.version_vector),
            Dominance::Extension
        );
        assert_eq!(
            vv_dominance(&vv_b, &head.version_vector),
            Dominance::Extension
        );
    }
}
