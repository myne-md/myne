// SPDX-License-Identifier: AGPL-3.0
// The Myne-operated hosted sync endpoint, as a single product constant.
//
// The first-run server choice (myne-md/myne#780) offers "Myne Sync" beside
// "self-hosted": one tap to the hosted server, or a URL field for an operator's
// own. Both clients answer that question identically, and both need the SAME
// address, so it lives here rather than being typed twice.
//
// # What trust this endpoint gets
//
// The endpoint is written with NO trust material of any kind: no pin, no
// fingerprint, no static constant. Native clients verify its certificate chain
// and server name against the public CA roots bundled with the app, on the first
// connection and every later one, and the browser client verifies through the
// browser's own trust store (`docs/decisions/sync/0620`).
//
// The withdrawn alternative is worth keeping in the record rather than deleting:
// a build-time static pin (myne-md/myne#781) and trust-on-first-use leaf
// capture (entry 0379) were both designed and both removed, because a leaf pin
// breaks on every certificate renewal while the mechanism that survives renewal
// (SPKI with stable-key reuse) is a separate design change this has not taken.
// The consequence the hosted card must not paper over is the one entry 0620
// owns: a compromised or compelled public CA can issue a certificate native
// clients accept. There is no per-endpoint trust to compare across devices, so
// there is nothing for the first-run copy to offer the user to verify.
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
