// Web substitution — there is no recovery-phrase credential here
// (phase3-web-client task 92).
//
// The desktop module imports `normalizeBip39Phrase`, which pulls the BIP-39
// wordlist. This one imports nothing, so the wordlist has **no import edge into
// the served bundle at all** — which is a stronger statement than the grep that
// currently reports zero hits, because a grep describes today's tree-shake and
// this describes the module graph.
//
// `PHRASE_CELL_COUNT` is `0` rather than `24`: any caller that still maps over a
// grid renders nothing, instead of rendering 24 empty inputs no code can read.
//
// The thrower is deliberate, and deliberately not a silent empty string. An
// empty credential would reach `sync_enroll` and fail there as a wrong
// credential — the same message a mistyped password gets — so a bug that
// resurrected this path would look like a user error and stay in the product.
// A throw names the boundary at the moment it is crossed. It is unreachable in
// practice: `has("phraseEnrolment")` is false on this client, so the arm that
// would call this is never rendered.

/** No grid on this client. See the header for why `0` and not `24`. */
export const PHRASE_CELL_COUNT = 0;

export function buildPhraseCredential(_cells: readonly string[]): string {
  throw new Error(
    "the recovery-phrase credential does not exist in the web client " +
      "(decisions.md 2026-07-26; phase3-web-client task 92)",
  );
}
