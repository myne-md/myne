// The recovery-phrase type-back challenge, shared by the two mobile flows that
// put a 24-word phrase on screen: vault creation (`CreateVaultFlow`) and identity
// creation (`IdentityFlow`). `docs/spec/protocol.md` section 7.1.3's "demonstrate
// the phrase, not memorize" is a property of the secret, not of which ceremony
// produced it, so the identity phrase gets the same challenge the vault phrase
// does (myne-md/myne#855; `design-notes/ui/0665` supersedes that clause of 0615
// which had given the identity phrase none).
//
// The DRAW and the normalisation now live in `@myne/client-core/phrase-challenge`,
// shared with desktop, and this module is the mobile adapter over them. It was two
// implementations until myne-md/myne#851: mobile drew four UNIFORM positions while
// desktop drew one word from each third, so mobile gave up the last-third guarantee
// on about one screen in six and nothing could report it. See that module's header.
//
// What stays here is the mobile presentation: the challenge is a plain 0-based
// `number[]` (it is `useState` state in both flows) and the answers are an array read
// by index. Desktop keys 1-based positions through a `Record<number, string>`, and
// neither shape is the other's to dictate, so only the rule is shared.

import {
  drawPhraseChallenge,
  normalizePhraseWord,
} from "@myne/client-core/phrase-challenge";

/**
 * NFKD + trim + lowercase, so case and stray whitespace cannot falsely block. The body
 * lives in `@myne/client-core/phrase-challenge`; re-exported under this name because both
 * mobile flows and two mobile specs import it from here.
 */
export { normalizePhraseWord as normalizeWord };

/**
 * Four distinct 0-based word positions to confirm by type-back, ascending, one from each
 * third of the 24-word phrase. Delegates to the shared draw, which documents the bias and
 * why it is load-bearing (partial-write detection).
 *
 * The return is a fresh mutable array rather than the shared `readonly` tuple because both
 * flows hold it in `useState<number[]>`.
 */
export function pickChallenge(): number[] {
  return [...drawPhraseChallenge()];
}

/**
 * Per-position match state: `null` while a field is empty (not yet wrong), `true`
 * or `false` once something is typed. `allCorrect` is the gate both flows use.
 */
export function phraseTypeBackMatches(
  phrase: readonly string[],
  positions: readonly number[],
  answers: readonly string[],
): { matches: Array<boolean | null>; allCorrect: boolean } {
  const matches = positions.map((pos, i) => {
    const value = answers[i] ?? "";
    if (value.length === 0) return null;
    return normalizePhraseWord(value) === normalizePhraseWord(phrase[pos] ?? "");
  });
  return {
    matches,
    allCorrect: positions.length === 4 && matches.every((m) => m === true),
  };
}
