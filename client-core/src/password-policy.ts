// The password floor, and the unit it is counted in.
//
// # Why this is here and not in `PasswordInput.tsx`
//
// It lived in the desktop `src/components/PasswordInput.tsx`, which was ONE
// source on the desktop and no source at all on mobile: the phone carried three
// copies of `const MIN_PASSWORD_LEN = 12` (`RecoverFlow`, `IdentityFlow`,
// `MemberUnlockBlock`) and two bare `12` literals in its own strength meters, so
// the floor was written five times across the two clients and compared in two
// different units. `client-core` is the layer whose entry criterion is "both
// clients answer the same question and it touches no host", which is exactly
// this: a number the backend enforces and both clients mirror.
//
// # The unit is the half that bites
//
// `String.prototype.length` counts UTF-16 code units; the backend
// (`protocol::password_policy::validate_min_length`) counts Unicode scalar
// values via `str::chars().count()`. Every astral scalar — most emoji, the CJK
// extension blocks, historic scripts — is 2 code units and 1 USV, so a `.length`
// gate admits an eleven-character password that the backend then refuses: the
// form says "fine" and the ceremony says "too short". A mobile strength meter
// compared `.length` against a code-point floor, which is the same bug wearing
// the other sign.
//
// So the constant and the counter travel together, and a caller that wants the
// floor should reach for `passwordLength` rather than `.length`.

/** Minimum password length enforced by every consumer (frontend gate). */
export const MIN_PASSWORD_LEN = 12;

/**
 * Password length in the unit the backend floor counts: Unicode scalar values,
 * via the string iterator.
 *
 * Compare against `MIN_PASSWORD_LEN` through this helper, never through
 * `.length`.
 */
export const passwordLength = (password: string) => [...password].length;
