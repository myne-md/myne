// Input-mask helper for the account-number entry fields (enroll, join,
// recover-by-account). Mirrors the display form defined in
// `docs/spec/account-number.md` §2 — `MY-XXXX-XXXX-XXXX-XXXX-XXXX`: the
// `MY-` prefix plus the 20-character canonical Crockford-base32 body grouped
// into five 4-character runs.
//
// This is a PRESENTATION-ONLY mask. It never validates the Damm-32 check and
// never canonicalizes for the wire — the Rust `parse_account_number`
// (`protocol/src/account_number.rs`) is the single normative parser, and it
// already strips whitespace, the `MY-` prefix, and every dash before checking.
// So a formatted value submits exactly like the raw value did; the mask only
// makes the field readable as the user types or pastes.

/** Display-form layout: a 2-char `MY` group followed by five 4-char groups. */
const SEGMENT_SIZES = [2, 4, 4, 4, 4, 4] as const;

/** 4-char canonical groups when the user has NOT typed the `MY` prefix yet. */
const BODY_SEGMENT_SIZES = [4, 4, 4, 4, 4] as const;

/** Slice `s` into the given run lengths, dash-joined, dropping any overflow. */
function groupBySizes(s: string, sizes: readonly number[]): string {
  const segments: string[] = [];
  let i = 0;
  for (const size of sizes) {
    if (i >= s.length) break;
    segments.push(s.slice(i, i + size));
    i += size;
  }
  return segments.join("-");
}

/**
 * Format raw account-number input into the grouped display form as the user
 * types. Idempotent: feeding the output back in yields the same string.
 *
 * Behaviour:
 *  - Uppercases and drops every separator / non-alphanumeric character, so a
 *    pasted `MY-4K7P-…` and a hand-typed `my 4k7p` collapse to the same body.
 *  - If the input begins with `M`, the leading two characters are treated as
 *    the `MY` prefix group — typing `MY` shows `MY`, and the next character
 *    triggers the first dash (`MY3` → `MY-3`). This matches how a user reading
 *    a printed number off the page enters it.
 *  - Otherwise (a prefix-less canonical paste like `4K7P…`) the `MY-` prefix
 *    is injected and the whole input is grouped in 4s.
 *  - Empty input stays empty so the placeholder shows through.
 *
 * Invalid Crockford characters (I/L/O/U) are intentionally NOT stripped — they
 * stay visible so the user can see and fix the typo; the backend reports the
 * non-distinguishing "invalid" result either way (`account-number.md` §5).
 */
export function formatAccountNumberInput(raw: string): string {
  const alnum = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (alnum === "") return "";

  // `M` start → the user is (most likely) typing the `MY` prefix themselves.
  if (alnum[0] === "M") {
    return groupBySizes(alnum, SEGMENT_SIZES);
  }
  // Prefix-less paste → inject `MY-` and group the canonical body in 4s.
  return `MY-${groupBySizes(alnum, BODY_SEGMENT_SIZES)}`;
}
