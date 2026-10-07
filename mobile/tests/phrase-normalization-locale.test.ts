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
// word. And one of mobile's two normalization sites is INLINE, inside
// `CreateVaultFlow`'s render, with no function name to grep for and nothing else
// asserting it.
//
// Non-vacuity, as on the desktop side: the host's own locale mapping is replaced
// for the duration, because the test runner's locale is English and both calls
// agree there. The assertions then distinguish which method the code reached for.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { normalizeBip39Phrase } from "../src/lib/bip39-normalize";

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

describe("the type-back comparison inside CreateVaultFlow", () => {
  it("normalizes with the locale-independent call", () => {
    // A SOURCE assertion, and it is the honest shape here rather than a
    // shortcut: the comparison is an inline expression in a render body, not an
    // exported function, so there is nothing to import and call. Driving it
    // through the rendered flow would need the whole creation walk and would
    // then assert the keyboard's behaviour rather than the string's.
    //
    // What makes it a real check rather than a grep: BOTH directions. The right
    // call must be present AND the wrong one absent, so replacing one with the
    // other fails either way round.
    const src = readFileSync(
      resolve(__dirname, "..", "src", "app", "flows", "CreateVaultFlow.tsx"),
      "utf8",
    );
    const line = src
      .split("\n")
      .find((l: string) => l.includes("const norms = answers.map"));
    expect(line, "the type-back comparison moved or was renamed").toBeTruthy();
    expect(line, "the type-back lowercases with the locale").not.toContain(
      "toLocaleLowerCase",
    );
    expect(line, "the type-back stopped lowercasing at all").toContain("toLowerCase");
  });
});
