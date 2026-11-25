// SPDX-License-Identifier: AGPL-3.0-only
// The recovery kit as a file: one plain-text document carrying both of a vault's
// out-of-band credentials.
//
// The kit screen is styled as a preview of THIS text (myne-md/myne#468 K11), and
// that is the whole argument for putting two secrets in one file: the user can
// see what they are about to save, so no warning box has to tell them. A box
// saying "both secrets are in one file" was built for the earlier two-screen
// shape, reviewed, and rejected — it restates what the document already shows.
//
// A pure function on purpose. What the file must contain is the load-bearing
// claim of the whole step, and `tests/lib/recoveryKit.test.ts` can hold it to
// that without rendering a screen or touching a filesystem.
//
// Format rules, each for a reason:
//   - The phrase is ONE space-separated line, not a numbered grid. That is the
//     shape `recover_with_phrase` accepts and the shape a password manager's
//     secure-note field wants, so a user who saves this file can paste from it
//     rather than retype 24 words. The screen shows the numbered grid; the file
//     shows the pasteable line.
//   - The words are never translated (`protocol.md` §7: the English BIP-39
//     wordlist is frozen as a major-version constant). Only the labels are.
//   - No trailing decoration, no ASCII art, nothing that a future edit could
//     mistake for structure. This file is read by people and by paste buffers.

/** The translated labels the file's headings use. Supplied by the caller so
 *  `check-i18n.mjs` sees each key as a static `t("literal")` at its call site. */
export interface RecoveryKitLabels {
  /** Document title, e.g. "Myne recovery kit". */
  title: string;
  /** Heading above the phrase, stating what it is for. */
  phraseHeading: string;
  /** Heading above the account number, stating what it is for. */
  accountHeading: string;
}

export interface RecoveryKitInput {
  /** The vault's name, or empty if the user left the name step blank. */
  vaultName: string;
  /**
   * Already-formatted date, so this module holds no locale logic.
   *
   * `dateStyle: "medium"` in the user's own language, deliberately, and NOT the
   * `civilDateIn` treatment `src/AGENTS.md` requires of a date the app stores:
   * that rule exists because three call sites let a formatter's LAYOUT stand in
   * for a value they then parsed and compared, and this one is never parsed or
   * compared by any code. It is read by a person holding a printed kit, in the
   * language they chose, which is what the medium style is for. The distinction
   * is stated here rather than at the three call sites (`KitStep`,
   * `CreateVaultFlow`, `IdentityFlow`) so a future reader can tell a decision
   * from an oversight (myne-md/myne#972 review, D7 minor).
   */
  savedOn: string;
  phrase: readonly string[];
  accountNumber: string;
  labels: RecoveryKitLabels;
}

/**
 * The kit's file contents, ending in a single newline.
 *
 * The meta line joins the vault name and the date with a middle dot, and drops
 * the name when it is empty rather than leaving " · " hanging — a blank name is
 * a legitimate answer on the name step, so the empty case is a shape this has to
 * produce, not an input to reject.
 */
export function recoveryKitText({
  vaultName,
  savedOn,
  phrase,
  accountNumber,
  labels,
}: RecoveryKitInput): string {
  const meta = [vaultName.trim(), savedOn].filter((p) => p.length > 0).join(" · ");
  return [
    labels.title,
    meta,
    "",
    labels.phraseHeading,
    phrase.join(" "),
    "",
    labels.accountHeading,
    accountNumber,
    "",
  ].join("\n");
}
