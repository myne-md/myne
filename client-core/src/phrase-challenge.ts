// SPDX-License-Identifier: AGPL-3.0
//
// The recovery-phrase type-back challenge's two RULES: which four words of a 24-word
// phrase the user is asked to retype, and how a typed answer is compared to the word
// it has to reproduce.
//
// ## Why this is shared rather than duplicated
//
// Both clients draw a challenge and both clients normalize the answer, and they drew
// the challenge DIFFERENTLY until myne-md/myne#851: the desktop reducer's draw is
// biased, one word out of each third of the phrase, and mobile's was four uniform
// positions. The bias is the point rather than a flourish. Requiring one word from the
// last third is what makes the challenge detect a partial write-down: a user who copied
// only the first 16 words fails it. A uniform draw still asks from the last third with
// probability `C(16,4)/C(24,4)`, about 83%, so it loses that signal on roughly one
// screen in six, and nothing in either tree could report it: both draws return four
// distinct in-range positions, both are sorted, and both gate on four answered fields,
// so every assertion a client can write about its own draw passes either way.
// `docs/spec/protocol.md` section 7.1.3's "demonstrate the phrase, not memorize" is a
// property of the secret, not of which ceremony produced it, so the identity phrase
// (myne-md/myne#855) takes the same rule as the vault phrase.
//
// The normalization is here for the same reason at a smaller scale: both copies were
// byte-identical, and the day one of them needs to change (a locale whose lowercase is
// not the comparison to make, say) two copies means one client accepts answers the
// other rejects, with no error anywhere.
//
// ## Entry criterion (`@myne/client-core/package.json` `"//"`)
//
// Met exactly: both clients answer the same question, and this module touches no host at
// all (`seam: null`). It reads and returns plain strings and numbers.
//
// **The presentation is deliberately NOT here.** Each client keeps its own match-state
// shape next to its own ceremony: desktop's `phraseTypeBackMatches` takes 1-based
// positions and a `Record<number, string>` off a reducer's state, mobile's takes 0-based
// positions and an answer array off a `useState`. Both compute the same gate over the same
// rule, and neither shape is the other's to dictate.

/**
 * The only phrase length this rule is defined for.
 *
 * The bias below is stated in thirds of a 24-word phrase, so it does not generalize to a
 * 12-word phrase by changing a constant: splitting 12 into thirds and taking two words
 * from the middle one would ask from 4 of 12 words, which is a different challenge with a
 * different cost to the user. A 12-word flow would owe its own rule rather than a
 * parameter here, and no client has one today.
 */
export const PHRASE_WORD_COUNT = 24;

/**
 * NFKD, trim, lowercase.
 *
 * NFKD rather than NFC, because the comparison is between a word the app displayed and a
 * word the user retyped: a decomposed accent and a precomposed one are the same word to a
 * reader, and failing them would block a user who typed the right phrase. Case and
 * surrounding whitespace are the same kind of non-answer.
 */
export function normalizePhraseWord(s: string): string {
  return s.normalize("NFKD").trim().toLowerCase();
}

/**
 * Four distinct 0-based word positions to confirm by type-back, ascending:
 *
 * - `[0]`  one position in `[0, 8)`   (words 1 to 8)
 * - `[1]`  `[2]` two distinct positions in `[8, 16)` (words 9 to 16)
 * - `[3]`  one position in `[16, 24)` (words 17 to 24)
 *
 * Ascending, so the four fields read down the phrase in the order the words appear in it.
 * It is NOT free from the construction: the second mid position is drawn from the seven
 * that are not the first (distinct by construction rather than by resampling, which would
 * skew the pair), and that draw can land BELOW the first, so the pair is sorted to put the
 * lower one first. The two arms were split across the clients until myne-md/myne#851:
 * mobile's draw sorted and desktop's did not, so the same ceremony presented its four words
 * in a different order depending on the client. Mobile's existing assertion is what caught
 * it, and the two ends of this function are the reason it is a sort rather than a claim.
 *
 * The one-from-the-last-third arm is the load-bearing part: it is what fails a user who
 * wrote down only the first two thirds. See the module header for the divergence this
 * rule replaced.
 */
export function drawPhraseChallenge(): readonly [number, number, number, number] {
  const early = Math.floor(Math.random() * 8);
  const middle = [8, 9, 10, 11, 12, 13, 14, 15];
  const first = Math.floor(Math.random() * middle.length);
  let second = Math.floor(Math.random() * (middle.length - 1));
  // Skip past the first draw rather than resampling a collision: a rejection loop would
  // skew the pair's distribution.
  if (second >= first) second += 1;
  const lo = Math.min(middle[first], middle[second]);
  const hi = Math.max(middle[first], middle[second]);
  const late = 16 + Math.floor(Math.random() * 8);
  return [early, lo, hi, late];
}
