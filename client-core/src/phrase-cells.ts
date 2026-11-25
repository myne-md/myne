// SPDX-License-Identifier: AGPL-3.0-only
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

/**
 * The tokens a pasted value distributes over a phrase grid (myne-md/myne#932).
 *
 * The split is `recovery-flow.md` section 3.2's: whitespace, one token per cell.
 * Callers treat fewer than two tokens as "not a phrase paste" and let the browser
 * fill the single cell natively, which is the rule the spec states.
 */
export function phrasePasteTokens(pasted: string): string[] {
  return pasted.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Distribute a pasted phrase over the grid's cells, **from the first cell**.
 *
 * The first cell is the whole point, and it is what `recovery-flow.md` section 3.2
 * specifies: "paste into the first cell ... populate cells 1 through N (where N is
 * the token count, capped at 24)". Ten call sites in this tree distributed from the
 * cell the paste LANDED on instead, so a paste into cell 5 wrote the first twenty
 * words into cells 5-24 and **silently dropped the last four**: a fully populated
 * grid holding a phrase nobody typed, which the submit gate cannot tell from the
 * real one. One implementation, so the rule cannot drift per surface.
 *
 * Cells past the token count keep what they held: a short paste over a full grid is
 * visible state (the words are still on screen), not the hidden shift this function
 * exists to remove.
 */
export function applyPastedPhrase(
  cells: readonly string[],
  tokens: readonly string[],
  count: number = PHRASE_CELL_COUNT,
): string[] {
  const next = [...cells];
  for (let i = 0; i < tokens.length && i < count; i += 1) {
    next[i] = tokens[i];
  }
  return next;
}
