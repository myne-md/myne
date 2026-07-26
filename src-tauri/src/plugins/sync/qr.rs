//! Desktop-only QR device-join generation (MYND-466).
//!
//! `sync_device_join_qr` takes the **user-pasted** account number (Option 1,
//! prompt-to-paste — the account# is an AS9 bearer token Myne never persists at
//! rest, `account-number.md §8`, so it cannot be read from storage), reads THIS
//! device's own sync endpoint + cert pin from the endpoint config, builds the
//! scanner-only join payload (`myne_core::plugins::sync::qr_join`), and renders it
//! to an SVG QR the WebView displays. The phone scans it to prefill
//! `{server_url, account#}` — SYNC-47: the password/phrase are NEVER carried.
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

/// Failure surface for [`sync_device_join_qr`].
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
}

/// Build the SVG QR for adding a device, from the user-pasted `account_number`.
///
/// The account# arrives from the paste (never from storage — it is not persisted);
/// the endpoint URL + self-host cert pin come from this device's own sync config.
#[tauri::command]
pub async fn sync_device_join_qr<R: Runtime>(
    app: AppHandle<R>,
    account_number: String,
) -> Result<DeviceJoinQr, DeviceJoinQrError> {
    let endpoint = sync_get_endpoint(app)
        .await
        .map_err(|_| DeviceJoinQrError::EndpointRead)?;
    let endpoint_url = endpoint
        .endpoint_url
        .ok_or(DeviceJoinQrError::NotConfigured)?;

    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let payload = QrJoinPayload::new(
        endpoint_url,
        account_number.trim(),
        endpoint.cert_pin_hex,
        now_unix,
    )
    .map_err(|_| DeviceJoinQrError::InvalidAccountNumber)?;

    let encoded = payload
        .encode()
        .map_err(|_| DeviceJoinQrError::InvalidAccountNumber)?;

    let svg = render_qr_svg(&encoded).ok_or(DeviceJoinQrError::Render)?;

    Ok(DeviceJoinQr {
        svg,
        ttl_secs: QR_JOIN_TTL_SECS,
    })
}

/// Render `data` to a self-contained SVG QR string. `None` if the data exceeds QR
/// capacity (unreachable for the bounded join payload).
fn render_qr_svg(data: &str) -> Option<String> {
    use qrcode::render::svg;
    use qrcode::QrCode;
    let code = QrCode::new(data.as_bytes()).ok()?;
    // Pin black-on-white explicitly: a QR must stay high-contrast + self-contained
    // (its own white background rect), never theme-tinted, or scanners fail.
    let svg = code
        .render::<svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build();
    Some(svg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::generate_account_number;

    fn fresh_account() -> String {
        String::from_utf8(generate_account_number().unwrap().canonical.to_vec()).unwrap()
    }

    #[test]
    fn render_qr_svg_produces_well_formed_svg() {
        let acct = fresh_account();
        let encoded = QrJoinPayload::new("https://s.example", &acct, None, 1)
            .unwrap()
            .encode()
            .unwrap();
        let svg = render_qr_svg(&encoded).expect("svg");
        // qrcode emits `<?xml …?><svg …>…</svg>` (standard standalone SVG).
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
}
