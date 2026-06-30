// BIP-39 phrase normalization helpers — TS-side mirror of the Rust
// `protocol::normalize_user_phrase` per `protocol.md` §7.4. Used at
// the recover phrase-entry submit boundary before invoking
// `recover_with_phrase` IPC; the Rust side defensively normalizes
// again, but the wire shape is the normalized form.
//
// Vault-creation's confirm-step uses a per-token `normalizeWord`
// helper (in `src/screens/vault-creation/reducer.ts`) that performs
// the same NFKD + lowercase + trim transformation but on individual
// words — equivalent on the per-token unit since neither lowercase
// nor trim introduces whitespace, and NFKD is byte-identical when
// composed across token boundaries (whitespace stays whitespace).

/** Apply `protocol.md` §7.4 normalization to a joined 24-word phrase:
 *  NFKD + lowercase + trim + collapse whitespace runs to single ASCII
 *  space. Output is the wire-shape string passed to A8d. */
export function normalizeBip39Phrase(joined: string): string {
  return joined
    .normalize("NFKD")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}
