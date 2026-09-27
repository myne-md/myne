// SPDX-License-Identifier: AGPL-3.0
// The Myne-operated hosted sync endpoint, as a single product constant.
//
// The first-run server choice (myne-md/myne#780) offers "Myne Sync" beside
// "self-hosted": one tap to the hosted server, or a URL field for an operator's
// own. Both clients answer that question identically, and both need the SAME
// address, so it lives here rather than being typed twice.
//
// # Why this is not a certificate pin
//
// The endpoint is written with NO cert pin: the first connection TOFU-pins the
// leaf and records the pin source as `Tofu`, never `Static`. The build-time
// static pin the design calls for (`hosted_static_pin` in
// `core/src/plugins/sync/config.rs`) is deliberately `None` until hosted launch,
// because a leaf-DER pin breaks on every certificate renewal and the mechanism
// that survives renewal (SPKI + stable-key reuse) is its own design change
// (myne-md/myne#781). Until then the hosted card must not present a
// first-connect TOFU pin as pre-vetted (`docs/decisions/sync/0379`).
//
// # Why a subpath and not the barrel
//
// `client-core`'s barrel is bundled into the web client, which compiles the
// same `src/` tree; this module is imported only by the desktop and mobile
// first-run flows (the web client never reaches identity setup). Reaching it by
// subpath keeps the string out of the served web bundle, where
// `scripts/check-web-third-party.mjs` pins every external origin that appears.

/** The base URL of the Myne-operated hosted sync server. */
export const HOSTED_SYNC_ORIGIN = "https://sync.myne.md";
