// Carrying a source vault's added dictionary words (myne-md/myne#464).
//
// The carry is ONE host-side call now, not a read here plus a per-word write
// loop, so what these tests can observe changed with it. What they still assert
// is the part that is a product decision rather than an implementation detail:
// the ignore set never crosses, and "there was nothing to bring", "the target
// already had it" and "we could not look" stay three distinct outcomes.
//
// The word-level union itself is asserted where it now happens, in
// `plugins::importer::source_dictionary::tests` and `spell::state`'s tests,
// against the real encoder rather than against a mock of it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mergeDictionary = vi.fn();
const readSourceDictionary = vi.fn();
const addWord = vi.fn();
const ignoreWord = vi.fn();

vi.mock("../../../src/lib/import-source-vault", () => ({
  importSourceMergeDictionary: (...a: unknown[]) => mergeDictionary(...a),
  importSourceDictionary: (...a: unknown[]) => readSourceDictionary(...a),
}));
vi.mock("../../../src/lib/spell", () => ({
  addToPersonalDictionary: (...a: unknown[]) => addWord(...a),
  ignoreWordInVault: (...a: unknown[]) => ignoreWord(...a),
}));

const { carrySourceDictionary } = await import(
  "../../../src/notes/import/sources/myneDictionary"
);

describe("carrySourceDictionary", () => {
  beforeEach(() => {
    mergeDictionary.mockReset();
    readSourceDictionary.mockReset();
    addWord.mockReset();
    ignoreWord.mockReset();
  });

  it("reports what the host merged, addressed to the source vault", async () => {
    mergeDictionary.mockResolvedValue({ added: 3, read: 3 });
    expect(await carrySourceDictionary("vault-a")).toEqual({
      added: 3,
      read: 3,
      unreadable: false,
    });
    expect(mergeDictionary).toHaveBeenCalledWith("vault-a");
  });

  it("does not count a word the target already had", async () => {
    // The finding this replaced: the old carry counted its own calls, so a
    // target sharing most of the source's vocabulary was reported as having
    // gained all of it. `read` is what keeps `added: 0` readable.
    mergeDictionary.mockResolvedValue({ added: 2, read: 40 });
    expect(await carrySourceDictionary("vault-a")).toEqual({
      added: 2,
      read: 40,
      unreadable: false,
    });
  });

  it("never touches the vault-wide ignore set", async () => {
    // The design decision, asserted as behaviour: an ignore decision is
    // vault-scoped, so carrying it would change spell-check on target notes the
    // import never touched. There is no code path here that could reach it, and
    // this is the test that fails if somebody adds one.
    mergeDictionary.mockResolvedValue({ added: 1, read: 1 });
    await carrySourceDictionary("vault-a");
    expect(ignoreWord).not.toHaveBeenCalled();
  });

  it("makes no per-word write of its own", async () => {
    // The whole point of the batch command: 500 shared words used to mean 500
    // IPC round trips and 500 full `vault.dictionary` re-seals. A regression
    // that reintroduced the loop would still pass every assertion above.
    mergeDictionary.mockResolvedValue({ added: 3, read: 3 });
    await carrySourceDictionary("vault-a");
    expect(addWord).not.toHaveBeenCalled();
  });

  it("separates three outcomes: nothing to bring, nothing new, could not look", async () => {
    mergeDictionary.mockRejectedValue({ kind: "Unreadable" });
    expect(await carrySourceDictionary("vault-a")).toEqual({
      added: 0,
      read: 0,
      unreadable: true,
    });

    mergeDictionary.mockResolvedValue({ added: 0, read: 0 });
    expect(await carrySourceDictionary("vault-a")).toEqual({
      added: 0,
      read: 0,
      unreadable: false,
    });

    // The third one, which the previous shape could not express at all: the
    // source had words and the target already had every one of them.
    mergeDictionary.mockResolvedValue({ added: 0, read: 12 });
    expect(await carrySourceDictionary("vault-a")).toEqual({
      added: 0,
      read: 12,
      unreadable: false,
    });
  });
});
