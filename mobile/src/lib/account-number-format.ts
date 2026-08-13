// Input-mask helper for the account-number entry field (enroll SY-03). Ports the
// desktop `src/lib/account-number-format.ts` verbatim — mirrors the display form in
// `docs/spec/account-number.md` §2 (`MY-XXXX-XXXX-XXXX-XXXX-XXXX`: the `MY-` prefix
// plus the 20-char canonical Crockford-base32 body grouped into five 4-char runs).
//
// PRESENTATION-ONLY. It never validates the Damm-32 check and never canonicalizes
// for the wire — the Rust `parse_account_number` (`protocol/src/account_number.rs`)
// is the single normative parser (it strips whitespace, the `MY-` prefix, and every
// dash before checking), so a formatted value submits exactly like the raw value.
// A wrong account number collapses to the non-distinguishing enroll banner server-side.

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
 * Format raw account-number input into the grouped display form as the user types.
 * Idempotent: feeding the output back in yields the same string. Invalid Crockford
 * characters (I/L/O/U) are intentionally NOT stripped — they stay visible so the
 * user can see and fix the typo; the backend reports the non-distinguishing
 * "invalid" result either way (`account-number.md` §5).
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
