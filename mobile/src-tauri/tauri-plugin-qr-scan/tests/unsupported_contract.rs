// SPDX-License-Identifier: AGPL-3.0-only
//! The off-iOS refusal crosses IPC as the kind the WebView matches on —
//! myne-md/myne#557, the `enrolment.qr-scan` bullet.
//!
//! # What the roster row was really asking
//!
//! "Tap Scan QR on Android and check that it does not appear to do nothing."
//! That is a per-release hand-walk on a device, and both halves of the answer
//! are code:
//!
//!  * this crate returns `Error::Unsupported` on every target but iOS
//!    (`scan()`'s `#[cfg(not(target_os = "ios"))]` arm), and
//!  * `mobile/src/app/flows/JoinFlow.tsx` maps `errKind(e) === "Unsupported"`
//!    to `t("join.qr.scanUnavailable")`.
//!
//! The button appearing to do nothing is exactly what happens when those two
//! stop agreeing, and they can stop agreeing without any compiler noticing:
//! the link between them is a serde tag on one side and a string literal on the
//! other, with an IPC boundary in between.
//!
//! # Why this asserts the WIRE FORM rather than calling `scan()`
//!
//! Calling `scan()` needs a `QrScan<R>`, which needs a running Tauri app — and
//! what that would prove on this machine is that a `#[cfg]` arm the compiler
//! already selected was selected. The thing that is genuinely fragile is the
//! **shape the error takes on the wire**: `#[serde(tag = "kind")]` plus a
//! variant name, matched on the other side by a string. Renaming the variant,
//! dropping the tag attribute, or adding a payload all compile cleanly here and
//! all silently stop the WebView's `=== "Unsupported"` from ever being true.
//! Then the button really does appear to do nothing, which is the failure the
//! roster row was watching for.
//!
//! The `#[cfg]` half is covered by the compiler: there is exactly one non-iOS
//! arm and it is `Err(Error::Unsupported)`.

use tauri_plugin_qr_scan::{Error, ScanResponse};

#[test]
fn the_unsupported_refusal_serializes_as_the_kind_the_webview_matches() {
    let json = serde_json::to_value(Error::Unsupported).expect("serializes");
    // `JoinFlow.tsx`: `kind === "Unsupported" ? t("join.qr.scanUnavailable") : …`
    assert_eq!(
        json.get("kind").and_then(|v| v.as_str()),
        Some("Unsupported"),
        "the refusal no longer reaches the WebView as kind \"Unsupported\", so \
         JoinFlow's branch can never be taken and the Scan button appears to do \
         nothing on every platform but iOS"
    );
}

#[test]
fn the_refusal_carries_no_detail_the_ui_would_have_to_render() {
    // The variant is unit, so the tagged form has no `detail`. That matters
    // because the UI substitutes its OWN sentence for this kind; a payload
    // would be an English string from the backend that no catalog covers.
    let json = serde_json::to_value(Error::Unsupported).expect("serializes");
    assert!(
        json.get("detail").is_none(),
        "Unsupported grew a payload: {json}"
    );
}

#[test]
fn a_genuine_scanner_failure_is_a_different_kind() {
    // Without this the mapping could answer "unavailable" for a camera-denied
    // or capture failure on iOS — telling a user whose scanner exists that it
    // does not.
    let json = serde_json::to_value(Error::Plugin("camera denied".into())).expect("serializes");
    assert_eq!(json.get("kind").and_then(|v| v.as_str()), Some("Plugin"));
    assert_ne!(
        json.get("kind").and_then(|v| v.as_str()),
        Some("Unsupported")
    );
}

#[test]
fn a_cancelled_scan_is_a_success_with_no_value_rather_than_an_error() {
    // The third outcome, and the one that must NOT reach the error branch: a
    // user who dismisses the scanner has not hit an unsupported platform, and
    // showing them "scanning is unavailable" would be false.
    let cancelled: ScanResponse = serde_json::from_str("{}").expect("cancel decodes");
    assert!(cancelled.value.is_none());
    let scanned: ScanResponse =
        serde_json::from_str(r#"{"value":"myne://join?x=1"}"#).expect("a scan decodes");
    assert_eq!(scanned.value.as_deref(), Some("myne://join?x=1"));
}
