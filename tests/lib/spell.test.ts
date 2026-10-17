// IPC wrapper shape + manifest tests for the `spell` plugin (MYND-262/263/266).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  spellCheck,
  addToPersonalDictionary,
  ignoreWordInVault,
  defaultActiveLanguages,
  BUNDLED_SPELL_LANGUAGES,
  type SpellWord,
} from "../../src/lib/spell";

beforeEach(() => invokeMock.mockReset());
afterEach(() => invokeMock.mockReset());

describe("spell IPC wrappers", () => {
  it("spellCheck calls plugin:spell|spell_check with words+langs", async () => {
    const result: SpellWord[] = [
      { word: "helllo", misspelled: true, suggestions: ["hello"] },
    ];
    invokeMock.mockResolvedValue(result);
    const out = await spellCheck(["helllo"], ["en-US"]);
    expect(invokeMock).toHaveBeenCalledWith("plugin:spell|spell_check", {
      words: ["helllo"],
      langs: ["en-US"],
    });
    expect(out).toEqual(result);
  });

  it("addToPersonalDictionary calls the add command with the word", async () => {
    invokeMock.mockResolvedValue(undefined);
    await addToPersonalDictionary("Myne");
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:spell|add_to_personal_dictionary",
      { word: "Myne" },
    );
  });

  it("ignoreWordInVault calls the ignore command with the word", async () => {
    invokeMock.mockResolvedValue(undefined);
    await ignoreWordInVault("helllo");
    expect(invokeMock).toHaveBeenCalledWith("plugin:spell|ignore_word_in_vault", {
      word: "helllo",
    });
  });
});

describe("bundled-language manifest + defaults (SYNC-6/12/15)", () => {
  it("v1 bundles 22 languages incl. en-US/de/ru; TR/el/hr excluded", () => {
    expect(BUNDLED_SPELL_LANGUAGES).toHaveLength(22);
    expect([...BUNDLED_SPELL_LANGUAGES]).toContain("en-US");
    expect([...BUNDLED_SPELL_LANGUAGES]).toContain("de");
    expect([...BUNDLED_SPELL_LANGUAGES]).toContain("ru");
    expect([...BUNDLED_SPELL_LANGUAGES]).not.toContain("tr"); // ZeroFlag, deferred
    expect([...BUNDLED_SPELL_LANGUAGES]).not.toContain("el"); // 19MB, held back
    expect([...BUNDLED_SPELL_LANGUAGES]).not.toContain("hr"); // SISSL, AGPL-incompatible
    // No duplicates.
    expect(new Set(BUNDLED_SPELL_LANGUAGES).size).toBe(BUNDLED_SPELL_LANGUAGES.length);
  });

  it("defaults to en-US when no/unbundled OS locale", () => {
    expect(defaultActiveLanguages(undefined)).toEqual(["en-US"]);
    expect(defaultActiveLanguages("tr")).toEqual(["en-US"]); // tr not bundled v1
  });

  it("includes a bundled OS locale alongside en-US", () => {
    // en-US OS locale → just en-US (deduped).
    expect(defaultActiveLanguages("en-US")).toEqual(["en-US"]);
    // A bundled non-English locale joins the union.
    expect(defaultActiveLanguages("de")).toEqual(["en-US", "de"]);
    // A region variant matches on its base language (de-DE → de).
    expect(defaultActiveLanguages("fr-FR")).toEqual(["en-US", "fr"]);
  });
});
