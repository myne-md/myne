// Constructing a 24-word recovery-phrase credential (phase3-web-client task 92).
//
// # Why one function gets its own module
//
// The enrolment form gates the recovery arm on `has("phraseEnrolment")` (its own
// capability since `decisions.md` 2026-08-15, so the reversal that ships phrase
// display and phrase entry on web leaves this third path shut), and the
// grid's testid and the BIP-39 wordlist both grep to zero hits in the built web
// bundle. That is the measured state, and it is not the same as a structural
// one: the gate is a runtime branch in shared code, so what keeps the wordlist
// out of the bundle today is a tree-shaker's opinion about a conditional. This
// module makes it a build-time fact instead — the web target substitutes it with
// a stub that CANNOT construct a recovery credential, so there is no import edge
// from served code to `bip39-normalize` at all.
//
// The stake is that one exposure is permanent. `protocol.md` §7 preserves the
// phrase across every password change and there is no rotation command, so a
// phrase typed into served code once has no in-app remedy — which is why
// `decisions.md` 2026-07-26 forbids it as firmly as it forbids generating one
// there. And per `server-protocol.md` §3.1 the recovery path **self-approves**,
// so a phrase credential from a browser would also walk past the device-approval
// gate.
//
// The dispatcher refuses the recovery kind independently (`web/wasm/src/
// dispatch.rs`), because a UI defence is bypassed by one `invoke` from a devtools
// console. These are belt and braces on purpose: this module stops the code
// existing, that arm stops the call working.

import { normalizeBip39Phrase } from "../../lib/bip39-normalize";

export { PHRASE_CELL_COUNT } from "../../lib/phrase-cells";

/**
 * Join and normalise the grid's cells into the credential `sync_enroll` takes.
 *
 * Normalisation is not cosmetic: the phrase is fed directly to Argon2id
 * (`protocol.md` §7 — no PBKDF2 step), so whitespace and Unicode form change the
 * derived key rather than being tidied away by a later step.
 */
export function buildPhraseCredential(cells: readonly string[]): string {
  return normalizeBip39Phrase(cells.join(" "));
}
