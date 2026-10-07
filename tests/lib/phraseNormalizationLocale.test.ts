// Phrase normalization is locale-INDEPENDENT, and the Turkish dotless ı is why
// (myne-md/myne#468 task 11).
//
// The code is already correct: every normalization site uses `toLowerCase()`.
// This pins it, because the wrong call is one word longer and reads as the more
// careful choice. Under a Turkish locale `"I".toLocaleLowerCase()` is `"ı"`
// (U+0131, dotless), which is in no BIP-39 word — so a locale-aware lowercase
// turns `INCOME` into `ıncome`, the wordlist lookup fails, and the user is told
// their recovery phrase is wrong. On a vault they can no longer open by any other
// means, since `recovery-flow.md` §2.4 never re-displays the phrase.
//
// The repository uses `toLocaleLowerCase()` in three other files
// (`src/notes/task*.ts`), all correctly — a task filter matching what the user
// typed in their own language WANTS the locale. So the wrong call is idiomatic
// here, which is precisely why the right one needs a test.
//
// **How this test is not vacuous.** Asserting `normalizeWord("INCOME") === "income"`
// passes under the test runner's own locale whichever call the code makes, because
// that locale is English. So the host's locale mapping is REPLACED for the
// duration: `String.prototype.toLocaleLowerCase` is patched to the Turkish
// mapping, and the assertions then distinguish the two calls. A function that
// reaches for the locale returns `ıncome` and fails by name.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeWord } from "../../src/screens/vault-creation/reducer";
import { normalizeBip39Phrase } from "../../src/lib/bip39-normalize";

/** The Turkish mapping, for the one character that distinguishes the two calls. */
const TURKISH_DOTLESS = "ı";

const original = String.prototype.toLocaleLowerCase;

beforeEach(() => {
  // Patched rather than passed a locale argument, because what is under test is
  // WHICH METHOD the code calls. A test that passed `"tr"` could only check a
  // call site it had already found.
  // eslint-disable-next-line no-extend-native
  String.prototype.toLocaleLowerCase = function (this: string) {
    return original.call(this).replace(/i/g, TURKISH_DOTLESS).replace(/I/g, TURKISH_DOTLESS);
  } as typeof String.prototype.toLocaleLowerCase;
});

afterEach(() => {
  // eslint-disable-next-line no-extend-native
  String.prototype.toLocaleLowerCase = original;
});

describe("the patch itself is the non-vacuity check", () => {
  it("makes a locale-aware lowercase produce the dotless form", () => {
    // If this fails, every assertion below is testing nothing: both calls would
    // agree and the file would pass with the defect injected.
    expect("INCOME".toLocaleLowerCase()).toBe(`${TURKISH_DOTLESS}ncome`);
    expect("INCOME".toLowerCase()).toBe("income");
  });
});

describe("normalizeWord — the vault-creation confirm challenge", () => {
  it("lowercases a word the locale-aware way would break", () => {
    // The concrete cost: the user types the word they wrote down, the challenge
    // refuses it, and the only way past is a phrase they are already holding.
    expect(normalizeWord("INCOME")).toBe("income");
  });

  it("holds for every BIP-39 word containing an I", () => {
    // More than one word is affected, and a single-case test invites the reading
    // that `income` is special. These are real entries from the frozen English
    // wordlist (`protocol.md` §7).
    for (const word of ["INDEX", "INJURY", "ISLAND", "INVITE", "IRON", "ICE"]) {
      expect(normalizeWord(word)).toBe(word.toLowerCase());
      expect(normalizeWord(word)).not.toContain(TURKISH_DOTLESS);
    }
  });

  it("still trims and NFKD-normalizes", () => {
    // The patch must not be read as licence to change what else the function does.
    expect(normalizeWord("  INCOME\n")).toBe("income");
    expect(normalizeWord("é")).toBe(normalizeWord("é"));
  });
});

describe("normalizeBip39Phrase — the recovery phrase-entry boundary", () => {
  it("lowercases the whole phrase locale-independently", () => {
    const joined = "INCOME INDEX ISLAND IRON";
    expect(normalizeBip39Phrase(joined)).toBe("income index island iron");
    expect(normalizeBip39Phrase(joined)).not.toContain(TURKISH_DOTLESS);
  });

  it("is the shape the Rust side re-normalizes (§7.4), locale aside", () => {
    expect(normalizeBip39Phrase("  INCOME   IRON \n")).toBe("income iron");
  });
});
