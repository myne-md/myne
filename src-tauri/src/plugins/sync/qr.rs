//! Desktop-only QR device-join generation (MYND-466).
//!
//! Two producers, both rendering a scanner-only payload from
//! `myne_core::plugins::sync::qr_join`:
//!
//! - [`sync_device_join_qr`] — the OWNER's. Takes the **user-pasted** account
//!   number (Option 1, prompt-to-paste — the account# is an AS9 bearer token Myne
//!   never persists at rest, `account-number.md §8`, so it cannot be read from
//!   storage), reads this device's own sync endpoint, and renders it. The phone
//!   scans it to prefill `{server_url, account#}`.
//! - [`sync_member_join_qr`] — a MEMBER's, for bringing another device of the
//!   SAME person into the shared vault they belong to (myne-md/myne). It takes no
//!   argument: the vault is resolved from the ACTIVE session, and the payload
//!   names the vault by its `account_number_hash`, which is the only name a member
//!   has for it.
//!
//! SYNC-47 holds for both: the password and the 24-word phrase are NEVER carried,
//! and the scanning device is always asked for its own credential. The legacy
//! cert-pin slot is emitted empty (decisions/sync/0620: native trust is public CA
//! + hostname), while the codec still decodes a pinned older QR.
//!
//! Desktop-only: mobile scans, never generates — so the `qrcode` dependency lives
//! here rather than in the shared core (kept off the mobile build).

use myne_core::plugins::sync::commands::sync_get_endpoint;
use myne_core::plugins::sync::qr_join::{QrJoinPayload, QR_JOIN_TTL_SECS};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use thiserror::Error;

/// The SVG QR plus the freshness window the WebView uses to schedule its refresh.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceJoinQr {
    /// A self-contained SVG string rendering the join payload as a QR.
    pub svg: String,
    /// Seconds this payload stays fresh (the WebView regenerates before it lapses).
    pub ttl_secs: u64,
}

/// Failure surface for [`sync_device_join_qr`] and [`sync_member_join_qr`].
#[derive(Debug, Clone, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum DeviceJoinQrError {
    /// No sync endpoint is configured yet (configure the server first).
    #[error("sync endpoint is not configured")]
    NotConfigured,
    /// The pasted account number is not a valid Myne account number.
    #[error("account number is invalid")]
    InvalidAccountNumber,
    /// The device-local endpoint config could not be read.
    #[error("could not read the sync endpoint config")]
    EndpointRead,
    /// QR rendering failed (data exceeds QR capacity — unreachable for the
    /// bounded join payload; surfaced rather than panicking).
    #[error("could not render the QR")]
    Render,
    /// `sync_member_join_qr` was called on a session that is not a member of a
    /// shared vault. An owner's second device joins with the account number plus
    /// the vault password (`sync_device_join_qr`), and a QR that led an owner down
    /// the phrase path would create a MEMBER device for a vault they own.
    #[error("this vault is not a shared vault you are a member of")]
    NotAMemberVault,
    /// A member vault with no account hash recorded, which means its join never
    /// completed. Refused rather than emitting a QR that names no vault.
    #[error("this member vault has no account recorded")]
    VaultAccountUnknown,
}

/// Build the SVG QR for adding a device, from the user-pasted `account_number`.
///
/// The account# arrives from the paste (never from storage — it is not persisted);
/// the endpoint URL comes from this device's own sync config.
#[tauri::command]
pub async fn sync_device_join_qr<R: Runtime>(
    app: AppHandle<R>,
    account_number: String,
) -> Result<DeviceJoinQr, DeviceJoinQrError> {
    let endpoint_url = endpoint_url_from_host(&app).await?;

    // `None` in the legacy pin slot, always: the phone no longer adopts a pin from
    // a QR (native trust is CA + hostname, 0620), and `sync_get_endpoint` reports
    // the retired field as `None` regardless of what a legacy config holds. Emitting
    // it explicitly keeps a future reader from reading the local `endpoint` binding
    // as the source of trust material.
    let payload = QrJoinPayload::new(endpoint_url, account_number.trim(), None, now_unix())
        .map_err(|_| DeviceJoinQrError::InvalidAccountNumber)?;

    render_payload(&payload)
}

/// Build the SVG QR for bringing **another device of the same person** into the
/// shared vault this device is a member of (myne-md/myne).
///
/// The member's counterpart of [`sync_device_join_qr`], and different in kind
/// rather than in degree: the owner's QR carries the vault ACCOUNT NUMBER and the
/// scanning device proves `{account# + password}`, but a member holds neither —
/// the display form is the owner's and never reaches them. So this payload names
/// the vault by its `account_number_hash` and the scanner proves the **24-word
/// recovery phrase** instead, which self-approves and fetches the vault's keys
/// from the group package the owner already pushed. Nothing in the payload is a
/// secret.
///
/// Takes **no argument**: the vault is resolved from the active session, so a
/// caller cannot ask for a QR describing some other vault. Refuses unless the
/// session is a member session — an owner's own second device belongs on the
/// account-number path, and a QR that led an owner down the phrase path would
/// create a member device for a vault they own.
#[tauri::command]
pub async fn sync_member_join_qr<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, crate::plugins::vault_unlock::state::VaultRuntimeState>,
) -> Result<DeviceJoinQr, DeviceJoinQrError> {
    use myne_core::plugins::sync::devices::{account_plane_from_host, AccountPlane};

    if account_plane_from_host(state.inner()).await != AccountPlane::Person {
        return Err(DeviceJoinQrError::NotAMemberVault);
    }

    // `account_hash_hex` is written when the vault was materialized
    // (`materialize_member_vault`), and it is the vault's public id rather than a
    // credential: it names the server namespace the shared blobs live under and it
    // is already on this device in plaintext sync state.
    let vault_dir = crate::paths::active_vault_root_io(&app, state.inner().active_vault_id().await)
        .map_err(|_| DeviceJoinQrError::VaultAccountUnknown)?;
    let sync_state = myne_core::plugins::sync::state::read_sync_state(
        &myne_core::vault_io::StdVaultIo,
        &vault_dir,
    )
    .await
    .map_err(|_| DeviceJoinQrError::VaultAccountUnknown)?;
    let mut account_hash_hex = sync_state
        .account_hash_hex
        .filter(|h| !h.is_empty())
        .ok_or(DeviceJoinQrError::VaultAccountUnknown)?;
    // Canonicalised HERE rather than trusted, because this value is not ours: it
    // was stored verbatim from the server's claim reply
    // (`person_account.rs::materialize_member_vault`), and the codec refuses
    // anything but lowercase hex. Uppercase is a legal spelling of the same 16
    // bytes and every other reader of this field accepts it (`devices::hex16`
    // tests `is_ascii_hexdigit`), so without this a vault that syncs perfectly
    // would be told "this member vault has no account recorded" about a vault whose
    // account IS recorded. The strict rule stays on the codec's own inputs, which is
    // what keeps one spelling of a vault id travelling between two devices.
    if account_hash_hex.len() == 32 && account_hash_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        account_hash_hex = account_hash_hex.to_ascii_lowercase();
    }

    let endpoint_url = endpoint_url_from_host(&app).await?;
    let payload = QrJoinPayload::member_vault(endpoint_url, account_hash_hex.trim(), now_unix())
        .map_err(|_| DeviceJoinQrError::VaultAccountUnknown)?;

    render_payload(&payload)
}

/// This device's configured sync endpoint URL, or the typed refusal.
async fn endpoint_url_from_host<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<String, DeviceJoinQrError> {
    let endpoint = sync_get_endpoint(app.clone())
        .await
        .map_err(|_| DeviceJoinQrError::EndpointRead)?;
    endpoint
        .endpoint_url
        .ok_or(DeviceJoinQrError::NotConfigured)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Encode + render an already-validated payload.
///
/// Both constructors validate their target, so an `encode` refusal here is a bug
/// rather than user input; it surfaces as [`DeviceJoinQrError::Render`] instead of
/// panicking, because a QR that cannot be drawn is still not a crash.
fn render_payload(payload: &QrJoinPayload) -> Result<DeviceJoinQr, DeviceJoinQrError> {
    let encoded = payload.encode().map_err(|_| DeviceJoinQrError::Render)?;
    let svg = render_qr_svg(&encoded).ok_or(DeviceJoinQrError::Render)?;
    Ok(DeviceJoinQr {
        svg,
        ttl_secs: QR_JOIN_TTL_SECS,
    })
}

/// Quiet zone in modules on every side, baked into the SVG viewBox. Four modules is
/// the QR spec minimum for reliable detection; the paper card around the code
/// (frontend) adds visual separation on top of it.
const QUIET_ZONE_MODULES: usize = 4;

/// Dark/light module colours, LITERAL (never CSS variables): a custom theme must not
/// tint a pairing QR, and dark mode must not invert it. Matched to the Myne mark tile
/// ink (#1a1a17) on paper (#fbfbfa); ~17:1 contrast, far above any scanner floor, and
/// on an emissive screen the delta from pure black/white is lost in the panel anyway.
const QR_DARK: &str = "#1a1a17";
const QR_LIGHT: &str = "#fbfbfa";

/// The centre mark's knockout square as a fraction of the symbol width. EC-H spends
/// two codewords per corrupted (not erased) module, so the real decode limit is well
/// under the <=20%-AREA ceiling the issue cites (~0.45 of the width). 0.22 of the
/// width (~0.048 area) is bracketed by the round-trip tests over the composite a
/// scanner actually sees (light pad + dark mark tile, `composite_mark_center`):
/// `composed_symbol_decodes` confirms 0.22 decodes, `oversized_knockout_fails_to_decode`
/// confirms ~1.9x it does not, so the shipped value has measured margin below failure.
/// The remaining phone-camera margin off an emissive screen is the manual roster item.
const MARK_KNOCKOUT_FRACTION: f64 = 0.22;

/// Render `data` to a self-contained SVG QR string with the Myne mark composed into a
/// centre knockout. `None` if the data exceeds QR capacity (unreachable for the
/// bounded join payload).
///
/// EC-H (~30% recovery) is what lets the centre mark knock out modules and still
/// decode; it also pushes the symbol version up, so the display size must clear
/// >=4 px/module (frontend, `DeviceJoinQr.tsx`).
///
/// Self-emitted from the module matrix rather than the `qrcode` crate's SVG renderer:
/// a module-unit viewBox keeps every coordinate in module space, which is what lets
/// the centre overlay be placed exactly and keeps the whole symbol decodable in a Rust
/// test. No byte of `data` is ever written into the SVG as text (the payload becomes
/// module geometry), so the payload is not an SVG/XML-injection surface. See
/// `svg_carries_no_payload_text`.
fn render_qr_svg(data: &str) -> Option<String> {
    use qrcode::{EcLevel, QrCode};
    let code = QrCode::with_error_correction_level(data.as_bytes(), EcLevel::H).ok()?;
    Some(emit_qr_svg(code.width(), &code.to_colors()))
}

/// Centred knockout square side in modules for an `n`-module symbol. Forced ODD so it
/// centres exactly on the symbol's centre module (QR symbols always have an odd module
/// count, so an odd `k` gives an integer, symmetric start).
fn mark_knockout_modules(n: usize) -> usize {
    let mut k = (n as f64 * MARK_KNOCKOUT_FRACTION).round() as usize;
    if k.is_multiple_of(2) {
        k += 1;
    }
    k
}

/// Serialize an `n` x `n` row-major module matrix to a self-contained SVG in a
/// module-unit coordinate space: viewBox `0 0 side side` with
/// `side = n + 2 * QUIET_ZONE_MODULES`. Dark modules become one `<path>` of unit
/// squares offset by the quiet zone (modules under the centre knockout are skipped,
/// since the mark covers them); the background is one light `<rect>`; then a light pad
/// and the Myne mark are drawn in the centre.
fn emit_qr_svg(n: usize, colors: &[qrcode::Color]) -> String {
    let side = n + 2 * QUIET_ZONE_MODULES;
    let k = mark_knockout_modules(n);
    let ko_lo = (n - k) / 2; // module-grid start of the knockout (pre-quiet-zone)
    let ko_hi = ko_lo + k; // exclusive
    use std::fmt::Write as _;
    let mut path = String::new();
    for row in 0..n {
        for col in 0..n {
            // Skip modules under the centre knockout: the mark covers them.
            if (ko_lo..ko_hi).contains(&row) && (ko_lo..ko_hi).contains(&col) {
                continue;
            }
            if colors[row * n + col] == qrcode::Color::Dark {
                let x = col + QUIET_ZONE_MODULES;
                let y = row + QUIET_ZONE_MODULES;
                // One unit square: move to (x,y), right, down, left, close.
                // `write!` into the buffer avoids a per-module temporary String.
                let _ = write!(path, "M{x} {y}h1v1h-1z");
            }
        }
    }
    // Knockout pad (light) + Myne mark, all in module-unit coordinates. The pad covers
    // the whole knockout square; the mark tile is inset one module so a light frame
    // stays around it. The mark's own 32-unit viewBox is scaled into that tile.
    let pad_xy = ko_lo + QUIET_ZONE_MODULES;
    // `k` is always >= 5: `mark_knockout_modules` rounds 0.22 * n up to an odd number
    // and the smallest QR is n = 21, so k - 2 >= 3 with no underflow or clamp needed.
    let tile = k - 2;
    let tile_xy = pad_xy + 1;
    let scale = tile as f64 / 32.0;
    format!(
        "<?xml version=\"1.0\" standalone=\"yes\"?>\
<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {side} {side}\" shape-rendering=\"crispEdges\">\
<rect width=\"{side}\" height=\"{side}\" fill=\"{QR_LIGHT}\"/>\
<path fill=\"{QR_DARK}\" d=\"{path}\"/>\
<rect x=\"{pad_xy}\" y=\"{pad_xy}\" width=\"{k}\" height=\"{k}\" rx=\"1.5\" fill=\"{QR_LIGHT}\"/>\
<g transform=\"translate({tile_xy} {tile_xy}) scale({scale})\" shape-rendering=\"geometricPrecision\">\
<rect width=\"32\" height=\"32\" rx=\"6\" fill=\"{QR_DARK}\"/>\
<path d=\"M8 22 V10 L16 18 L24 10 V22\" fill=\"none\" stroke=\"{QR_LIGHT}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\
</g>\
</svg>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::generate_account_number;

    fn fresh_account() -> String {
        String::from_utf8(generate_account_number().unwrap().canonical.to_vec()).unwrap()
    }

    /// The densest payload the codec can produce: a long self-host URL plus a full
    /// 64-hex cert pin. No new payload carries a pin (decisions/sync/0620), but a QR
    /// emitted by an older desktop still has to render and the phone still has to
    /// decode it, so the symbol-size budget is sized on it. This is the worst case
    /// for scan reliability (largest symbol).
    fn worst_case_encoded() -> String {
        let acct = fresh_account();
        QrJoinPayload::new(
            "https://sync.selfhosted.example.org:8443/myne/endpoint/v1",
            &acct,
            Some("cd".repeat(32)),
            1_700_000_000,
        )
        .unwrap()
        .encode()
        .unwrap()
    }

    /// Model the SHIPPED centre composite at module resolution, the way `emit_qr_svg`
    /// draws it: the centre `k` x `k` becomes the light pad, and the inner
    /// `(k-2)` x `(k-2)` becomes the dark mark tile. The light "M" strokes inside the
    /// tile are omitted, which only ADDS dark coverage, so this is a conservative
    /// (harder-to-decode) model of the artefact a scanner actually sees, not a
    /// lighter all-erasure proxy.
    fn composite_mark_center(n: usize, colors: &[qrcode::Color], k: usize) -> Vec<qrcode::Color> {
        let mut out = colors.to_vec();
        let lo = (n - k) / 2;
        // The inner (k-2) x (k-2) is the dark tile; the 1-module frame around it is the
        // light pad. k >= 5 always, so `lo + k - 1` cannot underflow.
        let inner = (lo + 1)..(lo + k - 1);
        for row in lo..lo + k {
            for col in lo..lo + k {
                out[row * n + col] = if inner.contains(&row) && inner.contains(&col) {
                    qrcode::Color::Dark
                } else {
                    qrcode::Color::Light
                };
            }
        }
        out
    }

    fn decodes(n: usize, colors: &[qrcode::Color], expected: &str) -> bool {
        let (dim, luma) = matrix_to_luma(n, colors, 8);
        let mut img =
            rqrr::PreparedImage::prepare_from_greyscale(dim, dim, |x, y| luma[y * dim + x]);
        let grids = img.detect_grids();
        grids.len() == 1
            && grids[0]
                .decode()
                .map(|(_, c)| c == expected)
                .unwrap_or(false)
    }

    #[test]
    fn render_uses_ec_high() {
        // EC-H is what the centre knockout needs. The worst-case payload lands on a
        // larger version at EC-H than at EC-M, so the emitted viewBox module count
        // pins the level.
        use qrcode::{EcLevel, QrCode};
        let encoded = worst_case_encoded();
        let n_h = QrCode::with_error_correction_level(encoded.as_bytes(), EcLevel::H)
            .unwrap()
            .width();
        let n_m = QrCode::new(encoded.as_bytes()).unwrap().width();
        assert!(
            n_h > n_m,
            "worst-case payload must distinguish EC-H from EC-M (n_h={n_h}, n_m={n_m})"
        );
        let side = n_h + 2 * QUIET_ZONE_MODULES;
        let svg = render_qr_svg(&encoded).expect("svg");
        assert!(
            svg.contains(&format!("viewBox=\"0 0 {side} {side}\"")),
            "render must emit the EC-H module count"
        );
    }

    #[test]
    fn svg_contains_the_mark() {
        let encoded = worst_case_encoded();
        let svg = render_qr_svg(&encoded).expect("svg");
        // The Myne mark's constant path plus both literal colours are present.
        assert!(svg.contains("M8 22 V10 L16 18 L24 10 V22"));
        assert!(svg.contains(QR_DARK));
        assert!(svg.contains(QR_LIGHT));
        // Colours are literal, never CSS variables (a theme must not tint the QR).
        assert!(!svg.contains("var(--"));
    }

    #[test]
    fn mark_footprint_within_ceiling() {
        // 0.20 of the symbol AREA is the issue's hard ceiling; the shipped fraction
        // (0.22 of the WIDTH => ~0.048 area) sits far below it. The bound here is 0.06,
        // not 0.20, on purpose: a loose 0.20 check would pass even if MARK_KNOCKOUT_FRACTION
        // were bumped to ~0.44 of the width, so it would not pin the shipped value at all.
        use qrcode::{EcLevel, QrCode};
        let encoded = worst_case_encoded();
        let n = QrCode::with_error_correction_level(encoded.as_bytes(), EcLevel::H)
            .unwrap()
            .width();
        let k = mark_knockout_modules(n);
        let area_ratio = (k * k) as f64 / (n * n) as f64;
        assert!(
            area_ratio <= 0.06,
            "knockout area {area_ratio:.3} exceeds the pinned 0.06 (well under the 0.20 ceiling); k={k}, n={n}"
        );
    }

    #[test]
    fn composed_symbol_decodes() {
        // Positive: the worst-case payload with the SHIPPED centre composite (light pad
        // + dark mark tile, modelled by `composite_mark_center`) still decodes. Proves
        // the footprint is inside the software-decode envelope; the phone-camera margin
        // on top is the manual roster item, not this test.
        use qrcode::{EcLevel, QrCode};
        let encoded = worst_case_encoded();
        let code = QrCode::with_error_correction_level(encoded.as_bytes(), EcLevel::H).unwrap();
        let n = code.width();
        let composed = composite_mark_center(n, &code.to_colors(), mark_knockout_modules(n));
        assert!(
            decodes(n, &composed, &encoded),
            "shipped composite must decode"
        );
    }

    #[test]
    fn oversized_knockout_fails_to_decode() {
        // Negative: a composite ~1.9x the SHIPPED footprint fraction does NOT decode.
        // Deriving the oversized fraction from MARK_KNOCKOUT_FRACTION (rather than a bare
        // 0.42) is what makes this a margin RELATIVE to the shipped value: lower the
        // const and this scales with it, so the "shipped decodes, 1.9x fails" gap cannot
        // silently narrow. Per the issue: "temporarily oversize the knockout, confirm the
        // scan actually fails."
        use qrcode::{EcLevel, QrCode};
        let encoded = worst_case_encoded();
        let code = QrCode::with_error_correction_level(encoded.as_bytes(), EcLevel::H).unwrap();
        let n = code.width();
        let mut oversized = (n as f64 * MARK_KNOCKOUT_FRACTION * 1.9).round() as usize;
        if oversized.is_multiple_of(2) {
            oversized += 1;
        }
        let composed = composite_mark_center(n, &code.to_colors(), oversized);
        assert!(
            !decodes(n, &composed, &encoded),
            "an oversized composite ({oversized} of {n}) must fail to decode, proving margin"
        );
    }

    /// Not a gate: writes a sample branded QR SVG to `/tmp` for a visual eyeball,
    /// mirroring the repo's `emit_*_vectors` convention. Run with
    /// `cargo test -p myne-desktop --lib emit_sample_branded_qr -- --ignored`.
    #[test]
    #[ignore]
    fn emit_sample_branded_qr() {
        let encoded = worst_case_encoded();
        let svg = render_qr_svg(&encoded).expect("svg");
        std::fs::write("/tmp/device-join-qr-sample.svg", &svg).unwrap();
        println!("wrote /tmp/device-join-qr-sample.svg ({} bytes)", svg.len());
    }

    /// The member payload is the one the new affordance displays, so it owes the
    /// same two facts the account payload's tests pin: it renders, and the vault
    /// hash never becomes SVG text.
    #[test]
    fn a_member_payload_renders_decodes_and_carries_no_text() {
        let hash = "ab".repeat(16);
        let payload =
            QrJoinPayload::member_vault("https://sync.example.org", &hash, 1_700).unwrap();
        let encoded = payload.encode().unwrap();
        let svg = render_qr_svg(&encoded).expect("svg");
        assert!(
            !svg.contains(&hash),
            "the vault hash must not survive as SVG text"
        );
        assert!(!svg.contains("MYQR"));
        assert_eq!(QrJoinPayload::decode(&encoded).unwrap(), payload);
    }

    #[test]
    fn a_member_payload_fits_the_display_budget() {
        // Same 340 px / >=4 px-per-module budget as the account worst case
        // (`DeviceJoinQr.tsx`'s `QR_IMG`), for the payload the member dialog shows:
        // a long self-host URL plus a full 32-hex vault hash.
        use qrcode::{EcLevel, QrCode};
        let hash = "ab".repeat(16);
        let encoded = QrJoinPayload::member_vault(
            "https://sync.selfhosted.example.org:8443/myne/endpoint/v1",
            &hash,
            1_700_000_000,
        )
        .unwrap()
        .encode()
        .unwrap();
        let n = QrCode::with_error_correction_level(encoded.as_bytes(), EcLevel::H)
            .unwrap()
            .width();
        let side = n + 2 * QUIET_ZONE_MODULES;
        assert!(
            side <= 85,
            "member payload side {side} modules exceeds the 85 budget"
        );
    }

    #[test]
    fn render_qr_svg_produces_well_formed_svg() {
        let acct = fresh_account();
        let encoded = QrJoinPayload::new("https://s.example", &acct, None, 1)
            .unwrap()
            .encode()
            .unwrap();
        let svg = render_qr_svg(&encoded).expect("svg");
        // emit_qr_svg emits `<?xml ...?><svg ...>...</svg>` (standard standalone SVG).
        assert!(svg.starts_with("<?xml"));
        assert!(svg.contains("<svg xmlns="));
        assert!(svg.trim_end().ends_with("</svg>"));
    }

    #[test]
    fn rendered_payload_round_trips_via_the_shared_codec() {
        // The exact string the desktop renders must decode back to the same fields
        // on the phone — the desktop-render ⇄ phone-decode contract.
        let acct = fresh_account();
        let payload = QrJoinPayload::new(
            "https://sync.example.org",
            &acct,
            Some("ab".repeat(32)),
            1_700,
        )
        .unwrap();
        let encoded = payload.encode().unwrap();
        assert!(render_qr_svg(&encoded).is_some());
        assert_eq!(QrJoinPayload::decode(&encoded).unwrap(), payload);
    }

    /// Test-only rasteriser: blow an `n` x `n` module matrix (plus quiet zone) up to
    /// `scale` px per module as an 8-bit greyscale buffer, dark = 0, light = 255.
    /// This feeds rqrr WITHOUT pulling in the `image` crate, and task 2 reuses it
    /// over the mark-composited matrix.
    fn matrix_to_luma(n: usize, colors: &[qrcode::Color], scale: usize) -> (usize, Vec<u8>) {
        let side = n + 2 * QUIET_ZONE_MODULES;
        let dim = side * scale;
        let mut luma = vec![255u8; dim * dim];
        for row in 0..n {
            for col in 0..n {
                if colors[row * n + col] == qrcode::Color::Dark {
                    let x0 = (col + QUIET_ZONE_MODULES) * scale;
                    let y0 = (row + QUIET_ZONE_MODULES) * scale;
                    for py in y0..y0 + scale {
                        for px in x0..x0 + scale {
                            luma[py * dim + px] = 0;
                        }
                    }
                }
            }
        }
        (dim, luma)
    }

    #[test]
    fn svg_carries_no_payload_text() {
        // The URL is caller-controlled; a distinctive marker must NOT survive into
        // the SVG, or the payload would be an SVG/XML-injection surface. The payload
        // becomes module geometry, never SVG text.
        let acct = fresh_account();
        let payload =
            QrJoinPayload::new("https://INJECTIONMARKER.example", &acct, None, 1).unwrap();
        let encoded = payload.encode().unwrap();
        let svg = render_qr_svg(&encoded).expect("svg");
        assert!(!svg.contains("INJECTIONMARKER"));
        assert!(!svg.contains(&acct));
        assert!(!svg.contains("MYQR"));
    }

    #[test]
    fn emit_qr_svg_clears_the_knockout_region() {
        // Tests `emit_qr_svg`'s ACTUAL skip geometry (not a model): the shipped SVG must
        // draw no dark module inside the centre knockout, since the mark covers it. This
        // is what catches a drift between the skip region and the pad, which the
        // matrix-level decode tests above cannot (they build their own matrix).
        use qrcode::{EcLevel, QrCode};
        let encoded = worst_case_encoded();
        let code = QrCode::with_error_correction_level(encoded.as_bytes(), EcLevel::H).unwrap();
        let n = code.width();
        let svg = render_qr_svg(&encoded).expect("svg");
        let k = mark_knockout_modules(n);
        let lo = (n - k) / 2;
        for row in lo..lo + k {
            for col in lo..lo + k {
                let x = col + QUIET_ZONE_MODULES;
                let y = row + QUIET_ZONE_MODULES;
                let module = format!("M{x} {y}h1v1h-1z");
                assert!(
                    !svg.contains(&module),
                    "a dark module at ({x},{y}) inside the knockout was not skipped"
                );
            }
        }
    }

    #[test]
    fn worst_case_fits_display_budget() {
        // The frontend shows the QR at 340 CSS px (`QR_IMG` in DeviceJoinQr.tsx) and the
        // scan floor is >=4 px/module, so the symbol side (data modules + quiet zone)
        // must be <=85. This pins the coupling between the backend module count and the
        // frontend size: if a realistic payload ever grows past it, this fails and the
        // display size (or the payload) must be revisited rather than silently dropping
        // below the scan floor.
        use qrcode::{EcLevel, QrCode};
        let encoded = worst_case_encoded();
        let n = QrCode::with_error_correction_level(encoded.as_bytes(), EcLevel::H)
            .unwrap()
            .width();
        let side = n + 2 * QUIET_ZONE_MODULES;
        assert!(
            side <= 85,
            "worst-case side {side} modules exceeds the 340px / 4-px-per-module budget (85)"
        );
    }
}
