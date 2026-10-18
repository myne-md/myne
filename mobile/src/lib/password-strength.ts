// The length-bucket strength label behind every mobile password meter.
//
// # One implementation, because there were three and they disagreed
//
// `CreateVaultFlow` bucketed at 12/10/8 on `pw.length`; `RecoverFlow` bucketed
// at 20/16/`MIN_PASSWORD_LEN` on `[...pw].length`; `SettingsSheet` took an
// already-counted `len` and bucketed at 12/16/20. So the same twelve-character
// password read "Strong" (4/4 green) on the create screen and "Fair" (2/4) on
// the recovery screen, and the two disagreed about the UNIT as well — the
// `pw.length` versus `[...pw].length` half of R1.6, which is the same defect
// `client-core/src/password-policy.ts` exists to stop.
//
// The buckets here are `RecoverFlow`'s, because they are the ones anchored to the
// real floor: `MIN_PASSWORD_LEN` is what the backend enforces, so a password that
// exactly meets it is the bottom of "Fair" rather than the top of anything. The
// create screen's meter is stricter than it was as a result, which is the
// direction that cannot mislead.
//
// Presentational only. The gate is the floor plus the backend's own check; a
// meter that says "Strong" has never admitted a password.

import { MIN_PASSWORD_LEN, passwordLength } from "@myne/client-core/password-policy";

export type StrengthLevel = "Weak" | "Fair" | "Good" | "Strong";

/** Where "Fair" ends. Above the floor, because meeting the floor is not a
 *  compliment. */
const GOOD_MIN = 16;
/** Where "Good" ends. */
const STRONG_MIN = 20;

/** The bucket a password falls in, counted in the unit the floor uses. */
export function strengthLevel(password: string): StrengthLevel {
  const n = passwordLength(password);
  if (n < MIN_PASSWORD_LEN) return "Weak";
  if (n < GOOD_MIN) return "Fair";
  if (n < STRONG_MIN) return "Good";
  return "Strong";
}
