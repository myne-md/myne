// SPDX-License-Identifier: AGPL-3.0-only
//! The beta-terms acceptance gate — command surface (operations#15).
//!
//! Two commands over the device-local record in
//! [`myne_core::plugins::sync::legal_consent`]: ask whether the terms this
//! build ships have been accepted here, and record that they were.
//!
//! ## The version travels as an argument, deliberately
//!
//! The shipped version lives in `@myne/copy` (`BETA_TERMS_VERSION`), beside the
//! four clauses it stamps, because that is where a person editing the text will
//! be. Rust does not hold a second copy of it — a second copy is how the two
//! come to disagree, and the disagreement would be silent in the worst
//! direction: a build whose Rust half thinks "2" is current would stop asking
//! users who only ever accepted "1".
//!
//! So the client sends the version it is asking about, and the *comparison*
//! still happens in one place —
//! [`myne_core::plugins::sync::legal_consent::terms_accepted`] — which is the
//! part that must not be re-derived per caller. Sending the version is not a
//! trust question: a WebView that lied about it could only make the screen
//! appear more often, which is the harmless direction.
//!
//! ## No new capability
//!
//! Both commands join the existing `sync` plugin rather than opening one of
//! their own, so `capabilities/default.json` is untouched — the same shape
//! [`super::tor`] used, for the same reason. They are reachable pre-unlock on
//! purpose: two of the three doors that turn sync on (the welcome-screen join
//! modal and the web account bootstrap) run before any vault is open, and a
//! consent gate that could only be asked after unlock would not gate them.

use myne_core::plugins::sync::legal_consent::{
    legal_consent_path_from_host, read_legal_consent, terms_accepted, write_legal_consent,
    LegalConsent, LegalConsentError,
};
use myne_core::vault_io::StdVaultIo;
use tauri::{AppHandle, Runtime};

/// Whether `version` has been accepted on this device.
///
/// Every failure answers `false` (see the core module's doc): the cost of being
/// wrong is showing a screen twice, and the cost of the opposite is recording
/// agreement nobody gave.
#[tauri::command]
pub async fn sync_beta_terms_accepted<R: Runtime>(
    app: AppHandle<R>,
    version: String,
) -> Result<bool, LegalConsentError> {
    let host = myne_core::host::tauri_host::TauriHost::new(app.clone());
    let path = legal_consent_path_from_host(&host, &StdVaultIo).await?;
    let read = read_legal_consent(&StdVaultIo, &path).await;
    Ok(terms_accepted(&read, &version))
}

/// Record that `version` was accepted on this device.
///
/// Read-modify-write rather than a fresh value: the record is a struct that
/// later versions will grow other fields on (a privacy-notice stamp is the
/// obvious next one), and a writer that constructs a default would silently
/// clear them. That is the failure `tor_config`'s module doc argues its way out
/// of by taking a separate file; here the file is already separate and the
/// discipline is to merge rather than replace.
#[tauri::command]
pub async fn sync_accept_beta_terms<R: Runtime>(
    app: AppHandle<R>,
    version: String,
) -> Result<(), LegalConsentError> {
    let host = myne_core::host::tauri_host::TauriHost::new(app.clone());
    let path = legal_consent_path_from_host(&host, &StdVaultIo).await?;

    // A corrupt existing record is not a reason to refuse an acceptance — the
    // user is in front of the screen, having just read the terms. Start from
    // the default in that case and write a clean record over the broken one.
    let mut record = read_legal_consent(&StdVaultIo, &path)
        .await
        .unwrap_or_else(|_| LegalConsent::default());
    record.beta_terms_version = Some(version);

    write_legal_consent(&StdVaultIo, &path, &record).await
}
