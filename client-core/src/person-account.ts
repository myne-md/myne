// The person account number (myne-md/myne#911): one number per person, derived
// from the identity phrase rather than generated per vault.
//
// **Only the display lives here.** The derivation is Rust
// (`protocol::account_number_from_person_id`, the top 95 bits of the person id
// through the frozen Crockford alphabet and Damm-32 check) and stays there:
// every client reaches it through one command, so "the same phrase shows the
// same number on desktop, mobile and web" is a property of there being one
// implementation rather than of three agreeing. A TypeScript re-derivation here
// would be a second implementation of a check-character scheme, which is the
// kind of copy that drifts silently and is discovered by a support ticket.
//
// What this module owns is the PRESENTATION: the `MY-` prefix and the 4-char
// grouping, in the one place all three clients read, so a number grouped one
// way in a settings panel and another way on a phone cannot happen.

/** `MY-` + five 4-char groups. `account-number.md` §2, `DISPLAY_LEN = 27`. */
export const PERSON_ACCOUNT_DISPLAY_LEN = 27;

/** The canonical body: 19 Crockford entropy characters + 1 Damm-32 check. */
export const PERSON_ACCOUNT_CANONICAL_LEN = 20;

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
 * Format a canonical body into its display form: `MY-XXXX-XXXX-XXXX-XXXX-XXXX`.
 *
 * **For a value that CAME FROM THE RUST DERIVATION**, not for user input.
 * User input has to cope with someone typing the `MY` prefix themselves, which
 * is why [`formatAccountNumberInput`] branches on a leading `M`; a canonical
 * body that happens to begin with `M` (`MNPQ…`) would be mis-grouped by that
 * branch, so this function never looks at the characters at all beyond upper
 * casing them.
 *
 * Presentation only: it does not validate the Damm-32 check or the length. The
 * single normative parser is Rust `parse_account_number`.
 */
export function formatPersonAccountNumber(canonical: string): string {
  const alnum = canonical.toUpperCase().replace(/[^0-9A-Z]/g, "");
  // Idempotent on a display form: `MY` + a 20-char body is 22 alnum characters,
  // so the length disambiguates it from a canonical body that itself begins
  // with those two letters (which is 20). Same rule the Rust parser uses.
  const body =
    alnum.length === PERSON_ACCOUNT_CANONICAL_LEN + 2 && alnum.startsWith("MY")
      ? alnum.slice(2)
      : alnum;
  if (body === "") return "";
  return `MY-${groupBySizes(body, BODY_SEGMENT_SIZES)}`;
}

/**
 * Format raw account-number input into the grouped display form as the user
 * types. Idempotent: feeding the output back in yields the same string.
 *
 * Behaviour:
 *  - Uppercases and drops every separator / non-alphanumeric character, so a
 *    pasted `MY-4K7P-…` and a hand-typed `my 4k7p` collapse to the same body.
 *  - If the input begins with `M`, the leading two characters are treated as
 *    the `MY` prefix group: typing `MY` shows `MY`, and the next character
 *    triggers the first dash (`MY3` → `MY-3`). This matches how a user reading
 *    a printed number off the page enters it.
 *  - Otherwise (a prefix-less canonical paste like `4K7P…`) the `MY-` prefix
 *    is injected and the whole input is grouped in 4s.
 *  - Empty input stays empty so the placeholder shows through.
 *
 * Invalid Crockford characters (I/L/O/U) are intentionally NOT stripped: they
 * stay visible so the user can see and fix the typo; the backend reports the
 * non-distinguishing "invalid" result either way (`account-number.md` §5).
 *
 * This was two byte-identical copies (desktop and mobile) until myne-md/myne#911;
 * both clients now re-export this one.
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
