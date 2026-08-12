// The device-local beta-terms acceptance record — desktop implementation
// (operations#15).
//
// A seam module rather than a `src/lib/` wrapper because the two clients store
// this in genuinely different places, and neither can use the other's. Desktop
// writes `<app_config_dir>/legal-consent.json` through the sync plugin; the web
// client has no such directory and its Worker cannot reach `localStorage` at
// all, so the browser arm keeps the record on the main thread
// (`web/src/platform/legal-consent.ts`).
//
// What both arms agree on is the shape: the stored value is the accepted
// VERSION, and "accepted" means it equals the version this build ships. See
// `core/src/plugins/sync/legal_consent.rs` for why a version rather than a
// boolean, and why this is not a `vault.prefs` field.

import { invoke } from "./core";

/**
 * Whether `version` has been accepted on this device.
 *
 * Answers `false` on any failure — an unreadable record must never be read as
 * agreement nobody gave, and the cost of being wrong is showing a screen twice.
 */
export async function betaTermsAccepted(version: string): Promise<boolean> {
  return await invoke<boolean>("plugin:sync|sync_beta_terms_accepted", { version });
}

/** Record that `version` was accepted on this device. */
export async function acceptBetaTerms(version: string): Promise<void> {
  await invoke<void>("plugin:sync|sync_accept_beta_terms", { version });
}
