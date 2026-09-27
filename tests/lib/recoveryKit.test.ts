// The recovery kit's FILE CONTENTS (myne-md/myne#468).
//
// This is the load-bearing claim of the whole kit step, and it is the one a
// screen test cannot make: the step is laid out as a preview of this text, and
// the argument for putting two secrets on one screen is that the user can see
// they are going into one file. If the file then holds only the phrase, the
// screen has been lying and nothing else in the tree would say so — the save
// path reports success either way, because writing the wrong string succeeds.
//
// The two steps this replaced saved two files, each holding one secret.

import { describe, expect, it } from "vitest";
import { recoveryKitText } from "../../src/lib/recovery-kit";

const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);
const ACCOUNT = "MY-4K7P-N3RM-9QXC-VBHT-2";
const LABELS = {
  title: "Myne recovery kit",
  phraseHeading: "Recovery phrase — if you forget your password",
  accountHeading: "Account number — when you add another device",
};

function kit(over: Partial<Parameters<typeof recoveryKitText>[0]> = {}) {
  return recoveryKitText({
    vaultName: "Research",
    savedOn: "27 Sep 2026",
    phrase: PHRASE,
    accountNumber: ACCOUNT,
    labels: LABELS,
    ...over,
  });
}

describe("the kit file carries BOTH secrets", () => {
  it("holds all 24 words, in order, on one line", () => {
    const text = kit();
    // The phrase line is located by its heading rather than by index, so a
    // reordering of the document does not silently pass by matching a
    // neighbouring line that happens to have 24 tokens in it.
    const lines = text.split("\n");
    const at = lines.indexOf(LABELS.phraseHeading);
    expect(at, "the phrase heading is not in the file").toBeGreaterThanOrEqual(0);
    const words = lines[at + 1].split(" ");
    expect(words).toEqual(PHRASE);
    // One line, because that is what the recovery flow accepts as a paste and
    // what a password manager's secure note wants. A numbered grid would be
    // prettier and unusable for both.
    expect(words.length).toBe(24);
  });

  it("holds the account number under its own heading", () => {
    const lines = kit().split("\n");
    const at = lines.indexOf(LABELS.accountHeading);
    expect(at, "the account heading is not in the file").toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe(ACCOUNT);
  });

  it("names the vault and the date, so a second kit is distinguishable", () => {
    // Two vaults' kits in one Downloads folder are otherwise two files with the
    // same name and no way to tell which phrase opens which vault.
    expect(kit()).toContain("Research · 27 Sep 2026");
  });
});

describe("a blank vault name is a shape, not an input to reject", () => {
  it("drops the separator rather than leaving it hanging", () => {
    // Blank is a legitimate answer on the name step, so this is a real input.
    const text = kit({ vaultName: "" });
    expect(text).toContain("27 Sep 2026");
    expect(text, "the name separator outlived the name").not.toContain("·");
  });

  it("treats a whitespace-only name as blank", () => {
    expect(kit({ vaultName: "   " })).not.toContain("·");
  });

  it("still carries both secrets when the name is blank", () => {
    // The regression worth fearing: a falsy-name branch that returns early.
    const text = kit({ vaultName: "" });
    expect(text).toContain(PHRASE.join(" "));
    expect(text).toContain(ACCOUNT);
  });
});

describe("the file ends the way a text file should", () => {
  it("ends in exactly one newline", () => {
    const text = kit();
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});
