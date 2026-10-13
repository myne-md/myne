// Phrase normalization is locale-INDEPENDENT on the phone too
// (myne-md/myne#468 task 11). Mobile's half of the desktop test.
//
// Under a Turkish locale `"I".toLocaleLowerCase()` is `"ı"` (U+0131, dotless),
// which appears in no BIP-39 word — so a locale-aware lowercase turns `INCOME`
// into `ıncome`, the type-back refuses the word the user wrote down, and the way
// past is a phrase `recovery-flow.md` §2.4 never shows again.
//
// Mobile matters MORE here than the desktop does, for two reasons a reviewer
// should not have to reconstruct. A phone keyboard autocapitalises, so
// upper-case input is the common case rather than the odd one — which is why the
// manual roster already carries an item about autocorrect mangling a BIP-39
// word. And both of mobile's normalization sites are shared now: since
// myne-md/myne#855 the vault and identity type-backs both go through
// `phraseChallenge.normalizeWord`, which is what this file drives directly
// (it used to be an inline expression in `CreateVaultFlow`'s render, with no
// function name to grep for and nothing else asserting it).
//
// Non-vacuity, as on the desktop side: the host's own locale mapping is replaced
// for the duration, because the test runner's locale is English and both calls
// agree there. The assertions then distinguish which method the code reached for.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeBip39Phrase } from "../src/lib/bip39-normalize";
import { normalizeWord, phraseTypeBackMatches } from "../src/lib/phraseChallenge";

const TURKISH_DOTLESS = "ı";
const original = String.prototype.toLocaleLowerCase;

beforeEach(() => {
  String.prototype.toLocaleLowerCase = function (this: string) {
    return original.call(this).replace(/i/g, TURKISH_DOTLESS).replace(/I/g, TURKISH_DOTLESS);
  } as typeof String.prototype.toLocaleLowerCase;
});

afterEach(() => {
  String.prototype.toLocaleLowerCase = original;
});

describe("the patch itself is the non-vacuity check", () => {
  it("makes a locale-aware lowercase produce the dotless form", () => {
    expect("INCOME".toLocaleLowerCase()).toBe(`${TURKISH_DOTLESS}ncome`);
    expect("INCOME".toLowerCase()).toBe("income");
  });
});

describe("normalizeBip39Phrase — the recover phrase-entry boundary", () => {
  it("lowercases the whole phrase locale-independently", () => {
    expect(normalizeBip39Phrase("INCOME INDEX ISLAND IRON")).toBe(
      "income index island iron",
    );
  });

  it("holds for every BIP-39 word containing an I", () => {
    for (const word of ["INDEX", "INJURY", "ISLAND", "INVITE", "IRON", "ICE"]) {
      expect(normalizeBip39Phrase(word)).toBe(word.toLowerCase());
      expect(normalizeBip39Phrase(word)).not.toContain(TURKISH_DOTLESS);
    }
  });
});

describe("the type-back comparison, now one exported rule for both flows", () => {
  it("normalizes locale-independently, so a Turkish I never refuses a real word", () => {
    // This used to be a SOURCE assertion over `CreateVaultFlow`'s inline
    // comparison, because that comparison was an expression in a render body
    // with nothing to import. It is now `phraseChallenge.normalizeWord`, reached
    // by the vault AND identity type-backs, so the check is behavioural: call it
    // under the patched host locale and assert the dotless form never appears.
    // The patch is vacuous-proofed in the first describe block above.
    expect(normalizeWord("INCOME")).toBe("income");
    for (const word of ["INDEX", "INJURY", "ISLAND", "INVITE", "IRON", "ICE"]) {
      expect(normalizeWord(word)).toBe(word.toLowerCase());
      expect(normalizeWord(word)).not.toContain(TURKISH_DOTLESS);
    }
    // And the gate accepts the uppercase form for a phrase of such words.
    const gate = phraseTypeBackMatches(
      ["income", "index", "island", "iron"],
      [0, 1, 2, 3],
      ["INCOME", "INDEX", "ISLAND", "IRON"],
    );
    expect(gate.allCorrect).toBe(true);
  });
});
