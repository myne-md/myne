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
//! NOTE (cross-repo gap): `download_blob` issues `GET /sync/blob?id=<hex>`, but
//! `myne-server` (MYND-421) shipped `/sync/pull` + `/sync/push` only — the store
//! has `GetBlob` but no HTTP route exposes it. The `/sync/blob` GET handler is a
//! pushpull amendment that MUST land before the MYND-428 two-device smoke canary
//! replicates a note end-to-end. Flagged in progress.md.

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
    /// 16-byte note UUID / attachment-id.
    pub id: [u8; 16],
    /// The server's current `content_nonce` for this blob.
    pub content_nonce: [u8; 24],
    /// The server's opaque per-blob version (CAS token).
    pub version: u64,
    /// Advertised ciphertext size (informational).
    pub size: usize,
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
}

/// Pull-path failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PullError {
    /// 401 — token rejected / no authed session.
    Unauthenticated,
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
) -> Result<PullPage, PullError> {
    let path = format!("/sync/pull?cursor={cursor}");
    let resp = transport.request(HttpMethod::Get, &path, &[], Some(token))?;

    match resp.status {
        200 => {}
        401 => return Err(PullError::Unauthenticated),
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
    for m in &wire.metas {
        let id = hex_to_array::<16>(&m.uuid_hex).ok_or(PullError::BadResponse)?;
        let content_nonce =
            hex_to_array::<24>(&m.content_nonce_hex).ok_or(PullError::BadResponse)?;
        if local.get(&id) != Some(&content_nonce) {
            changed.push(ChangedBlob {
                id,
                content_nonce,
                version: m.version,
                size: m.size,
            });
        }
    }

    Ok(PullPage {
        next_cursor: wire.next_cursor,
        head,
        changed,
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
) -> Result<PullPage, PullError> {
    let mut cursor = start_cursor;
    let mut acc: HashMap<[u8; 16], ChangedBlob> = HashMap::new();
    let mut latest_head: Option<VerifiedHead> = None;

    loop {
        let page = pull_page(transport, root_key, token, baseline_vv, cursor, local)?;
        for c in page.changed {
            acc.insert(c.id, c);
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
    Ok(PullPage {
        next_cursor: cursor,
        head: latest_head,
        changed,
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
        429 => Err(PullError::RateLimited),
        _ => Err(PullError::BadResponse),
    }
}

// ---------------------------------------------------------------------------
// Push path (task 6)
// ---------------------------------------------------------------------------

/// One blob to push (mirrors the Go `pushBlob`). A `tombstone` push carries the
/// `deleted`-version ciphertext (MYND-426 builds it); the field is the only
/// deletion signal the blind server sees.
#[derive(Debug, Clone, Serialize)]
struct PushBlobWire {
    blob_id_hex: String,
    base_version: u64,
    content_nonce_hex: String,
    ciphertext_b64: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    tombstone: bool,
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
    /// 16-byte note UUID / attachment-id.
    pub id: [u8; 16],
    /// The version the client last saw for this blob (the per-blob CAS base).
    pub base_version: u64,
    /// The new revision's `content_nonce`.
    pub content_nonce: [u8; 24],
    /// The opaque sealed ciphertext.
    pub ciphertext: Vec<u8>,
    /// `true` for a `deleted`-marked tombstone version (MYND-426).
    pub tombstone: bool,
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

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

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
        401 => return Err(PushError::Unauthenticated),
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
        let page = pull_page(&t, &ROOT, "tok", &[], 0, &HashMap::new()).unwrap();
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
        let page = pull_page(&t, &ROOT, "tok", &baseline, 1, &local).unwrap();
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
        let page = pull_page(&t, &ROOT, "tok", &[], 0, &local).unwrap();
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
            pull_page(&t, &ROOT, "tok", &baseline, 0, &HashMap::new()).unwrap_err(),
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
        let r = pull_page(&t, &ROOT, "tok", &[], 0, &HashMap::new());
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
            pull_page(&t, &ROOT, "tok", &[], 5, &HashMap::new()).unwrap_err(),
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
            pull_page(&t, &ROOT, "tok", &[], 0, &HashMap::new()).unwrap_err(),
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
        let page = pull_to_stable(&t, &ROOT, "tok", &baseline, 0, &HashMap::new()).unwrap();
        assert_eq!(page.next_cursor, 1);
        assert_eq!(page.changed.len(), 2);
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
