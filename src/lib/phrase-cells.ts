// SPDX-License-Identifier: AGPL-3.0
// How many cells a recovery-phrase grid has, and it lives alone in its own
// module for two reasons that are both about NOT duplicating it again.
//
// # Why a module of its own
//
// This number was written by hand in five places — `phrase-credential.ts`,
// `vault-recover/reducer.ts`, the enrolment grid, `notes/import/MyneVaultSetup.tsx`
// and the mobile `SyncSettingsPanels.tsx` — so a grid could have rendered 23
// cells against a reducer that expected 24, with nothing in the tree to report
// it. A module with one export and no imports is the cheapest shape that makes
// "one definition" checkable by eye.
//
// # Why NOT `lib/bip39-normalize.ts`, which is where it first went
//
// That module is a desktop/mobile TWIN (`check-twin-inventory.mjs` pairs it with
// `mobile/src/lib/bip39-normalize.ts`, byte-identical today). Adding the
// constant to one side moved the pair into the semantically-different set, and
// `check-twin-drift-ratchet.mjs` may only ever shrink: the honest choices were to
// port it to the twin (two definitions again) or to leave the twin alone. This
// file is neither, and it is deliberately absent from the mobile tree so the pair
// stays undecided rather than newly divergent.

/**
 * Cells in a BIP-39 phrase, and therefore in every phrase grid on every client.
 * 24 words, per `protocol.md` §7.
 */
export const PHRASE_CELL_COUNT = 24;
