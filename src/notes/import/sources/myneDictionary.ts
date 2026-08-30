// Carrying a source vault's ADDED dictionary words into the target
// (myne-md/myne#464).
//
// The vault-wide ignore set is not carried, and the shape of this module is
// what enforces that rather than a comment asking the reader to be careful:
// this file makes ONE call, and that call's host-side implementation reads the
// source through `added_words_from_dir`, which returns the added words and has
// no parameter that would return anything else. There is no path through this
// file that could reach the ignore set, and adding one would be a visible edit
// rather than a forgotten filter.
//
// Why the added words cross at all: without them every domain term in the notes
// that were just imported comes up red-underlined, and the cost lands on exactly
// the content the user brought over. Why the ignore set does not: it is
// explicitly vault-SCOPED, so importing another vault's ignore decisions would
// silently change spell-check behaviour on target notes the import never
// touched, and the user would not notice because the change is a warning that
// stops appearing.

import { importSourceMergeDictionary } from "../../../lib/import-source-vault";

export interface DictionaryCarryResult {
  /**
   * Words added to the target. Already-present words are NOT counted.
   *
   * That sentence used to be false. The carry looped a per-word command and
   * counted its own calls, so a target that already shared most of the source's
   * vocabulary was reported as having gained all of it. The host compares
   * folded, the way the lookup layer does, and returns the difference.
   */
  readonly added: number;
  /**
   * Words read from the source, whether or not the target already had them.
   *
   * Kept beside `added` so `added: 0` can be read correctly: with `read: 0` the
   * source had no added words, and with `read: 40` the target already had all
   * forty. Those are different facts and the first version could not tell them
   * apart.
   */
  readonly read: number;
  /**
   * `true` when the source's dictionary could not be read at all.
   *
   * Distinct from `added: 0`, which means the source had no added words. The
   * report says different things for the two, because "there was nothing to
   * bring" and "we could not look" are different facts and only one of them is
   * worth the user's attention.
   */
  readonly unreadable: boolean;
}

/**
 * Union the source vault's added words into the target's personal dictionary.
 *
 * Runs once, after the notes have landed. A set union has no conflict semantics
 * to get wrong: a word the target already has is a no-op on the host side, so
 * this is safe to repeat and safe to run against a target that shares half the
 * vocabulary.
 *
 * Failure is never fatal to the import. The notes are already in; refusing to
 * finish because a dictionary would not decrypt would be reporting failure for
 * an import that succeeded.
 */
export async function carrySourceDictionary(
  sourceVaultId: string,
): Promise<DictionaryCarryResult> {
  try {
    const carry = await importSourceMergeDictionary(sourceVaultId);
    return { added: carry.added, read: carry.read, unreadable: false };
  } catch {
    // One call, so there is no partial-carry state to report: the host merges
    // in memory and persists once, so either the whole union landed or none of
    // it did. That is a stronger property than the per-word loop had, where a
    // failure halfway through left the target holding some of the source's
    // words and the report claiming a number that described neither vault.
    return { added: 0, read: 0, unreadable: true };
  }
}
