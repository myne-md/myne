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

use super::transport::{HttpMethod, SyncTransport, TransportError};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use protocol::{
    compute_head_id, open_vault_head, vv_dominance, Dominance, SealedHead, VaultHead,
    VaultHeadError, VvEntry, DEVICE_ID_LEN, HEAD_ID_LEN, VAULT_HEAD_FORMAT_V1,
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
/// **One reader, on purpose.** The server sends both on status 401, so every
/// 401 site has to look inside the body or it silently collapses a terminal
/// condition into a retryable one. Five sites do; a copy at each is five places
/// for the string to drift from `server-protocol.md` §3.1.
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

fn hex_to_array<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Issue one `/sync/pull` request and verify the response (head verify +
/// rollback rejection + changed-blob detection). `local` maps each locally-held
/// blob id to its current `content_nonce`.
pub fn pull_page(
    transport: &dyn SyncTransport,
    root_key: &[u8; 32],
    token: &str,
    baseline_vv: &[VvEntry],
    cursor: u64,
    local: &HashMap<[u8; 16], [u8; 24]>,
    reconcile: bool,
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

    let head = match wire.head {
        None => None,
        Some(hw) => {
            let record = B64
                .decode(hw.record_b64.as_bytes())
                .map_err(|_| PullError::BadResponse)?;
            let vault_head =
                open_vault_head(root_key, &record).map_err(|_| PullError::HeadInvalid)?;
            let head_id = compute_head_id(&record);
            let wire_id =
                hex_to_array::<HEAD_ID_LEN>(&hw.head_id_hex).ok_or(PullError::BadResponse)?;
            if head_id != wire_id {
                return Err(PullError::HeadIdMismatch);
            }
            let dominance = vv_dominance(baseline_vv, &vault_head.version_vector);
            if dominance == Dominance::Rollback {
                return Err(PullError::RollbackRejected);
            }
            Some(VerifiedHead {
                head: vault_head,
                head_id,
                dominance,
            })
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
    })
}

/// Loop `pull_page` until the cursor stops advancing (a stable pull), so a
/// vault larger than one page is fully drained. Accumulates changed blobs (last
/// content_nonce wins per id) and keeps the latest verified head.
pub fn pull_to_stable(
    transport: &dyn SyncTransport,
    root_key: &[u8; 32],
    token: &str,
    baseline_vv: &[VvEntry],
    start_cursor: u64,
    local: &HashMap<[u8; 16], [u8; 24]>,
    reconcile: bool,
) -> Result<PullPage, PullError> {
    let mut cursor = start_cursor;
    let mut acc: HashMap<[u8; 16], ChangedBlob> = HashMap::new();
    let mut acc_all: HashMap<[u8; 16], ChangedBlob> = HashMap::new();
    let mut latest_head: Option<VerifiedHead> = None;

    loop {
        let page = pull_page(
            transport,
            root_key,
            token,
            baseline_vv,
            cursor,
            local,
            reconcile,
        )?;
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
    })
}

/// Download a changed blob's opaque ciphertext (`GET /sync/blob?id=<hex>`).
/// See the module note: the server route is a pending pushpull amendment.
pub fn download_blob(
    transport: &dyn SyncTransport,
    token: &str,
    id: &[u8; 16],
) -> Result<Vec<u8>, PullError> {
    let mut hex = String::with_capacity(32);
    for b in id {
        hex.push_str(&format!("{b:02x}"));
    }
    let path = format!("/sync/blob?id={hex}");
    let resp = transport.request(HttpMethod::Get, &path, &[], Some(token))?;
    match resp.status {
        200 => {
            let wire: BlobWire =
                serde_json::from_slice(&resp.body).map_err(|_| PullError::BadResponse)?;
            B64.decode(wire.ciphertext_b64.as_bytes())
                .map_err(|_| PullError::BadResponse)
        }
        401 => Err(PullError::Unauthenticated),
        // 404/410 are per-blob outcomes (unknown id / horizon-GC reclaimed body,
        // §11.3) — first-class so the apply loop can SKIP the record instead of
        // failing the whole cycle.
        404 => Err(PullError::BlobNotFound),
        410 => Err(PullError::BlobReclaimed),
        429 => Err(PullError::RateLimited),
        _ => Err(PullError::BadResponse),
    }
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
        401 => Err(if is_device_revoked(&resp.body) {
            PushError::DeviceRevoked
        } else {
            PushError::Unauthenticated
        }),
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
    if prefix.is_empty() {
        let resp = transport.request_ext(HttpMethod::Get, &path, &[], &[], Some(token))?;
        return match resp.status {
            200 => Ok(Some(resp.body)),
            404 => Ok(None),
            401 => Err(PullError::Unauthenticated),
            429 => Err(PullError::RateLimited),
            _ => Err(PullError::BadResponse),
        };
    }

    let range = format!("bytes={}-", prefix.len());
    let resp = transport.request_ext(
        HttpMethod::Get,
        &path,
        &[("Range", range.as_str())],
        &[],
        Some(token),
    )?;
    match resp.status {
        206 => {
            let mut full = Vec::with_capacity(total);
            full.extend_from_slice(prefix);
            full.extend_from_slice(&resp.body);
            Ok(Some(full))
        }
        // A server that ignores the range and sends the whole body is fine.
        200 => Ok(Some(resp.body)),
        404 => Ok(None),
        401 => Err(PullError::Unauthenticated),
        429 => Err(PullError::RateLimited),
        _ => Err(PullError::BadResponse),
    }
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
    use protocol::VAULT_HEAD_FORMAT_V1;

    const ROOT: [u8; 32] = [0x42; 32];

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
        let sealed = VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V1,
            account_number_hash: [0x33; 16],
            manifest_hash: [0x55; 32],
            seq,
            prev_head_hash: Vec::new(),
            version_vector: vv_entries.to_vec(),
        }
        .seal(&ROOT)
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
        let page = pull_page(&t, &ROOT, "tok", &[], 0, &HashMap::new(), false).unwrap();
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
        let page = pull_page(&t, &ROOT, "tok", &baseline, 1, &local, false).unwrap();
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
        let page = pull_page(&t, &ROOT, "tok", &[], 0, &local, false).unwrap();
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
            pull_page(&t, &ROOT, "tok", &baseline, 0, &HashMap::new(), false).unwrap_err(),
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
        let r = pull_page(&t, &ROOT, "tok", &[], 0, &HashMap::new(), false);
        assert!(matches!(
            r,
            Err(PullError::HeadInvalid)
                | Err(PullError::HeadIdMismatch)
                | Err(PullError::BadResponse)
        ));
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
            pull_page(&t, &ROOT, "tok", &[], 5, &HashMap::new(), false).unwrap_err(),
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
            pull_page(&t, &ROOT, "tok", &[], 0, &HashMap::new(), false).unwrap_err(),
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
            pull_page(&t, &ROOT, "tok", &[], 0, &HashMap::new(), false).unwrap_err(),
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
                pull_page(&t, &ROOT, "tok", &[], 0, &HashMap::new(), false).unwrap_err(),
                PullError::Unauthenticated
            );
        }
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
            pull_page(&t, &ROOT, "tok", &[], 0, &HashMap::new(), false).unwrap_err(),
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
        let page = pull_to_stable(&t, &ROOT, "tok", &baseline, 0, &HashMap::new(), false).unwrap();
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
            pull_to_stable(&t, &ROOT, "tok", &baseline, 1, &HashMap::new(), false).unwrap_err(),
            PullError::CursorExpired
        );
        // Reconcile walk drains both pages.
        let page = pull_to_stable(&t, &ROOT, "tok", &baseline, 0, &HashMap::new(), true).unwrap();
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
        let page = pull_to_stable(&t, &ROOT, "tok", &[], 0, &HashMap::new(), false).unwrap();
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
            download_attachment(&t, "tok", &ATT_ID, &[]).unwrap(),
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
        assert_eq!(
            download_attachment(&t2, "tok", &ATT_ID, b"hel").unwrap(),
            Some(b"hello".to_vec())
        );
        let seen = t2.requests();
        assert!(seen[1]
            .4
            .iter()
            .any(|(n, v)| n == "Range" && v == "bytes=3-"));
    }

    #[test]
    fn download_attachment_defers_on_absent_or_incomplete() {
        // 404 → None (absent or deleted — non-distinguishing).
        let t = FakeTransport::new();
        t.on(HttpMethod::Head, &att_path(), 404, Vec::new());
        assert_eq!(download_attachment(&t, "tok", &ATT_ID, &[]).unwrap(), None);

        // Incomplete upload → None (never download a half-uploaded blob).
        let t2 = FakeTransport::new();
        t2.on_ext(
            HttpMethod::Head,
            &att_path(),
            200,
            Vec::new(),
            vec![("X-Uploaded-Length".to_string(), "3".to_string())],
        );
        assert_eq!(download_attachment(&t2, "tok", &ATT_ID, &[]).unwrap(), None);
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
        let page = pull_page(&t, &ROOT, "tok", &[], 0, &HashMap::new(), false).unwrap();
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
