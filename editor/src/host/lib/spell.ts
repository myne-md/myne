import { getHost, type SpellWord } from "../../host";
export type { SpellWord };
export function spellCheck(words: string[], langs: string[]): Promise<SpellWord[]> {
  const s = getHost().spell;
  return s ? s.spellCheck(words, langs) : Promise.resolve([]);
}
export function addToPersonalDictionary(word: string): Promise<void> {
  const s = getHost().spell;
  return s ? s.addToPersonalDictionary(word) : Promise.resolve();
}
export function ignoreWordInVault(word: string): Promise<void> {
  const s = getHost().spell;
  return s ? s.ignoreWordInVault(word) : Promise.resolve();
}
