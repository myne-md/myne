# Myne Account Number Scheme v0.1

> **Status: skeleton.** This document fills in the details summarized in `protocol.md` §8. The format and normalization rules below are normative. The Damm-32 quasigroup table is inlined and frozen in §4.2.

---

## 1. Purpose

The account number is Myne's primary user identifier — a Mullvad-style self-generated value that replaces email at signup. It serves three roles:

- **Vault binding** — the SHA-256 hash of the canonical form is mixed into both Argon2id salts (`protocol.md` §3.1) so vault keys cannot be precomputed across accounts.
- **Sync entitlement token** (Phase 2+) — when the sync server exists, the account number is the bearer token for hosted-sync access. The server stores only a hash; the raw number is never persisted server-side after registration.
- **User-facing identifier** — what the user writes down, hands to a self-host operator, or types when restoring on a new device.

The account number is **not** a key. It does not encrypt anything. Possession of an account number alone grants no read access to a vault — the master password and/or recovery phrase are required to derive `root_key`.

## 2. Format

```
Display form:   MY-XXXX-XXXX-XXXX-XXXX-XXXX
Canonical form: 20 uppercase Crockford base32 characters

Layout:
  +--------+-------------------+----------+
  | "MY-"  | 19 entropy chars  | 1 check  |
  +--------+-------------------+----------+
   prefix     Crockford base32   Damm-32
   (display)
```

- **Alphabet**: Crockford base32 — `0 1 2 3 4 5 6 7 8 9 A B C D E F G H J K M N P Q R S T V W X Y Z`. Excludes the visually ambiguous `I L O U` and uppercases by default. Source: https://www.crockford.com/base32.html.
- **Entropy**: 19 characters × 5 bits = **95 bits** of secret entropy.
- **Check character**: 1 Damm-32 digit, computed across the 19 entropy chars.
- **Prefix `MY-`**: human-readable prefix indicating "this is a Myne account number". Display-only; not part of the canonical form, not part of the entropy or check, not part of the SHA-256 input.
- **Separators**: dashes between 4-character groups in the display form. Display-only.

## 3. Generation algorithm

```
1. entropy_bits  := OS_CSPRNG(95 bits)
2. entropy_chars := crockford_base32_encode(entropy_bits)          # 19 chars
3. check_char    := damm32_check(entropy_chars)                    # 1 char
4. canonical     := entropy_chars || check_char                    # 20 chars uppercase
5. display       := "MY-" || canonical[0:4] || "-" || canonical[4:8] || "-"
                          || canonical[8:12] || "-" || canonical[12:16] || "-"
                          || canonical[16:20]
```

The 95-bit entropy is encoded as the first 19 base32 characters by:
- Pad the 95-bit value to 95 bits exactly (no leading zero stripping).
- Group into 19 5-bit chunks, big-endian.
- Map each chunk through the Crockford alphabet table.

## 4. Damm-32 check character

The check character is one Damm-32 digit over a fixed order-32 quasigroup. The quasigroup is **weak totally anti-symmetric with zero diagonal** — the precise (and sufficient) property the Damm check equation requires. Computing the check character:

```
damm32_check(s):                             # s = entropy indices, left-to-right
  interim := 0
  for c in s:
      interim := DAMM32_TABLE[interim][index_of(c)]   # row = interim, col = symbol index
  return alphabet[interim]
```

A check is verified by appending the candidate check character to the 19-character string and running the same loop over all 20 characters; the check passes iff the final `interim` is `0` (this is what the zero diagonal guarantees).

**Properties.** Catches **all** single-character substitutions and **all** adjacent transpositions (including transposition of the trailing check character with its neighbour), plus a high fraction of two-character errors. Stronger than Luhn for alphanumeric alphabets. Account numbers are fixed-length (20 characters), so the leading-zero weakness common to Damm/Luhn does not apply here.

### 4.1 Construction (informative)

The table is derived over the finite field GF(2⁵) ≅ GF(2)[x] / (x⁵ + x² + 1). Map each character to its 0–31 Crockford index (§2); the quasigroup operation is

```
x ∗ y = α · (x ⊕ y)        over GF(2⁵),  α = the field element 2 (the polynomial x)
```

i.e. each step XORs the running interim with the next symbol index, multiplies by α, and reduces modulo the irreducible polynomial. `x⁵ + x² + 1` is the canonical low-weight (and primitive) irreducible of degree 5, encoded as the bitmask `0b100101 = 37`; reduction is "if the doubled value ≥ 32, XOR 37". In code:

```
step(interim, symbol):
  t := (interim XOR symbol) << 1
  if t >= 32: t := t XOR 37
  return t
```

**The literal table in §4.2 is normative**; this construction is the informative derivation. An independent implementation MAY either paste the table verbatim or implement the construction and verify it against the table — the two are byte-identical.

**Commutativity note.** The operation is commutative (`x ∗ y = y ∗ x`), so the quasigroup is **not** *fully* totally anti-symmetric — only **weakly** so. This is correct and intended: the Damm check equation needs only weak total anti-symmetry (the source of the all-single-error + all-adjacent-transposition guarantee), and the zero diagonal gives the "valid ⟺ final interim is 0" property. An implementation MUST NOT "fix" the table to be fully anti-symmetric — that changes the table and is a major-version event (see root `CLAUDE.md` load-bearing registry).

### 4.2 Frozen quasigroup table (normative)

`DAMM32_TABLE[interim][symbol]` — the outer index is the running interim digit (row), the inner index is the input symbol's Crockford index (column); both range over 0–31. This block is machine-generated (`emit_damm32_table_for_paste`); do not edit it by hand.

<!-- BEGIN GENERATED damm32-table (emit_damm32_table_for_paste) — do not edit by hand -->
```text
  i\j │  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
  ────┼────────────────────────────────────────────────────────────────────────────────────────────────
    0 │  0  2  4  6  8 10 12 14 16 18 20 22 24 26 28 30  5  7  1  3 13 15  9 11 21 23 17 19 29 31 25 27
    1 │  2  0  6  4 10  8 14 12 18 16 22 20 26 24 30 28  7  5  3  1 15 13 11  9 23 21 19 17 31 29 27 25
    2 │  4  6  0  2 12 14  8 10 20 22 16 18 28 30 24 26  1  3  5  7  9 11 13 15 17 19 21 23 25 27 29 31
    3 │  6  4  2  0 14 12 10  8 22 20 18 16 30 28 26 24  3  1  7  5 11  9 15 13 19 17 23 21 27 25 31 29
    4 │  8 10 12 14  0  2  4  6 24 26 28 30 16 18 20 22 13 15  9 11  5  7  1  3 29 31 25 27 21 23 17 19
    5 │ 10  8 14 12  2  0  6  4 26 24 30 28 18 16 22 20 15 13 11  9  7  5  3  1 31 29 27 25 23 21 19 17
    6 │ 12 14  8 10  4  6  0  2 28 30 24 26 20 22 16 18  9 11 13 15  1  3  5  7 25 27 29 31 17 19 21 23
    7 │ 14 12 10  8  6  4  2  0 30 28 26 24 22 20 18 16 11  9 15 13  3  1  7  5 27 25 31 29 19 17 23 21
    8 │ 16 18 20 22 24 26 28 30  0  2  4  6  8 10 12 14 21 23 17 19 29 31 25 27  5  7  1  3 13 15  9 11
    9 │ 18 16 22 20 26 24 30 28  2  0  6  4 10  8 14 12 23 21 19 17 31 29 27 25  7  5  3  1 15 13 11  9
   10 │ 20 22 16 18 28 30 24 26  4  6  0  2 12 14  8 10 17 19 21 23 25 27 29 31  1  3  5  7  9 11 13 15
   11 │ 22 20 18 16 30 28 26 24  6  4  2  0 14 12 10  8 19 17 23 21 27 25 31 29  3  1  7  5 11  9 15 13
   12 │ 24 26 28 30 16 18 20 22  8 10 12 14  0  2  4  6 29 31 25 27 21 23 17 19 13 15  9 11  5  7  1  3
   13 │ 26 24 30 28 18 16 22 20 10  8 14 12  2  0  6  4 31 29 27 25 23 21 19 17 15 13 11  9  7  5  3  1
   14 │ 28 30 24 26 20 22 16 18 12 14  8 10  4  6  0  2 25 27 29 31 17 19 21 23  9 11 13 15  1  3  5  7
   15 │ 30 28 26 24 22 20 18 16 14 12 10  8  6  4  2  0 27 25 31 29 19 17 23 21 11  9 15 13  3  1  7  5
   16 │  5  7  1  3 13 15  9 11 21 23 17 19 29 31 25 27  0  2  4  6  8 10 12 14 16 18 20 22 24 26 28 30
   17 │  7  5  3  1 15 13 11  9 23 21 19 17 31 29 27 25  2  0  6  4 10  8 14 12 18 16 22 20 26 24 30 28
   18 │  1  3  5  7  9 11 13 15 17 19 21 23 25 27 29 31  4  6  0  2 12 14  8 10 20 22 16 18 28 30 24 26
   19 │  3  1  7  5 11  9 15 13 19 17 23 21 27 25 31 29  6  4  2  0 14 12 10  8 22 20 18 16 30 28 26 24
   20 │ 13 15  9 11  5  7  1  3 29 31 25 27 21 23 17 19  8 10 12 14  0  2  4  6 24 26 28 30 16 18 20 22
   21 │ 15 13 11  9  7  5  3  1 31 29 27 25 23 21 19 17 10  8 14 12  2  0  6  4 26 24 30 28 18 16 22 20
   22 │  9 11 13 15  1  3  5  7 25 27 29 31 17 19 21 23 12 14  8 10  4  6  0  2 28 30 24 26 20 22 16 18
   23 │ 11  9 15 13  3  1  7  5 27 25 31 29 19 17 23 21 14 12 10  8  6  4  2  0 30 28 26 24 22 20 18 16
   24 │ 21 23 17 19 29 31 25 27  5  7  1  3 13 15  9 11 16 18 20 22 24 26 28 30  0  2  4  6  8 10 12 14
   25 │ 23 21 19 17 31 29 27 25  7  5  3  1 15 13 11  9 18 16 22 20 26 24 30 28  2  0  6  4 10  8 14 12
   26 │ 17 19 21 23 25 27 29 31  1  3  5  7  9 11 13 15 20 22 16 18 28 30 24 26  4  6  0  2 12 14  8 10
   27 │ 19 17 23 21 27 25 31 29  3  1  7  5 11  9 15 13 22 20 18 16 30 28 26 24  6  4  2  0 14 12 10  8
   28 │ 29 31 25 27 21 23 17 19 13 15  9 11  5  7  1  3 24 26 28 30 16 18 20 22  8 10 12 14  0  2  4  6
   29 │ 31 29 27 25 23 21 19 17 15 13 11  9  7  5  3  1 26 24 30 28 18 16 22 20 10  8 14 12  2  0  6  4
   30 │ 25 27 29 31 17 19 21 23  9 11 13 15  1  3  5  7 28 30 24 26 20 22 16 18 12 14  8 10  4  6  0  2
   31 │ 27 25 31 29 19 17 23 21 11  9 15 13  3  1  7  5 30 28 26 24 22 20 18 16 14 12 10  8  6  4  2  0
```
<!-- END GENERATED damm32-table -->

**Worked example (pins orientation).** Entropy `0123456789ABCDEFGHJ` (indices 0,1,…,18). Start `interim = 0`. First symbol index `0` → `DAMM32_TABLE[0][0] = 0`; next index `1` → `DAMM32_TABLE[0][1] = 2`; next index `2` → `DAMM32_TABLE[2][2] = 0`; …continuing left-to-right over all 19 indices yields final `interim = 26`, which maps to Crockford `T`. The canonical account number is `0123456789ABCDEFGHJT`; validating all 20 characters returns `interim = 0`. (Because the row index is the *running interim* — not the position — a transposed pair changes the running state and is detected.)

### 4.3 Provenance

- **Construction method:** H. Michael Damm, *Total anti-symmetrische Quasigruppen* (PhD dissertation, Philipps-Universität Marburg, 2004) — <https://archiv.ub.uni-marburg.de/diss/z2004/0516>.
- **Irreducible polynomial:** G. Seroussi, *Table of Low-Weight Binary Irreducible Polynomials*, HP Labs HPL-98-135 (1998) — degree-5 entry `x⁵ + x² + 1`.
- **Reference implementation:** `srobo/damm32` (MIT) — <https://github.com/srobo/damm32>. The operative core is the same `α·(x⊕y)` step; that crate uses the RFC 4648 alphabet, so its check *characters* differ — the construction is alphabet-independent and Myne indexes via Crockford (§2).
- The literal table is locked to the construction by a golden test in `protocol/src/account_number.rs` and pinned as a 1024-byte cross-implementation hex vector in `myne-test-vectors`.

## 5. Parsing and normalization

Liberal parsing rules — the user is allowed to enter the account number with or without prefix, with or without separators, in any case:

```
normalize(input):
  1. NFKD Unicode normalize + trim leading/trailing whitespace
     (whitespace = code points carrying the Unicode `White_Space` property,
      NOT the ASCII subset; the two disagree on U+2028 among others)
  2. Remove all internal whitespace (same `White_Space` class as step 1)
  3. Strip leading "MY-" or "my-" (case-insensitive); fail if any other prefix is present
  4. Remove all "-" separators
 4a. Fail if any remaining code point is non-ASCII.
     An implementation MAY apply this check earlier — the reference
     implementation applies it right after step 2, and the outcome is
     identical because every code point steps 3 and 4 consume is ASCII.
     It MUST NOT be applied later than here: full Unicode uppercase can
     change string length (ß → SS), which would let a 19-character input
     pass the step-6 length check.
  5. Uppercase, ASCII only: U+0061..U+007A → U+0041..U+005A. Every other
     code point is left unchanged. This mapping MUST NOT be locale-sensitive.
     (Unlike the phrase pipeline in `protocol.md` §7.4, a locale-sensitive
      mapping here cannot produce a wrong account_number_hash: tr/az sends
      i to U+0130, and Crockford excludes I L O U, so step 7 rejects either
      way. The pin is owed regardless — the canonical form is defined as
      ASCII, and a case step that can emit a non-ASCII code point breaks
      that invariant rather than merely failing a later check.)
  6. Verify resulting string is exactly 20 characters
  7. Verify each character is in the Crockford base32 alphabet
  8. Verify Damm-32 check passes on the full 20-character string
  9. Return the 20-character canonical form

If any step fails, return an error and present a single user-facing message:
  "Invalid account number — please check and re-enter."

Do not distinguish "wrong length", "wrong characters", "wrong check digit" to the user;
all three failure modes return the same message.
```

## 6. Canonicality and hashing

The cryptographic identifier used in `protocol.md §3.1` is:

```
account_number_hash := SHA-256(normalize(input) as ASCII bytes)[:16]
```

The 16-byte hash is stored in `vault.meta` (§9.3 of the protocol spec) and binds the Argon2id salts to this account.

## 7. Privacy properties

- **No PII** — the account number does not encode any personal information. It is 95 bits of CSPRNG output, formatted for human use.
- **Bearer-token semantics** (Phase 2+) — anyone in possession of the account number can authenticate sync requests for that account. This is by design, similar to Mullvad VPN. Two consequences:
  - Treat account numbers like cash: write them down, do not paste them into untrusted forms.
  - Do not display the full account number in shared screenshots; UI MAY redact middle groups after first display.
- **Cross-account precomputation is prevented** by mixing `account_number_hash` into the Argon2id salts (`protocol.md §3.1`).
- **Server-side storage** (Phase 2+) — the sync server stores only `account_number_hash` (`SHA-256(canonical_form)[:16]`, §6) as its account identity — the same canonical value every other use site derives. *(Revised 2026-07-13, supersedes this bullet's earlier `[:32]` form: a longer truncation of the same digest is a strict prefix-extension of the 16-byte form — same input, same hash — so "a different truncation length to avoid sharing identifiers" provided no separation; true separation would need a domain-separated input, which buys nothing here either, because the server stores each account's `vault.meta` — embedding the 16-byte form — inside that account's own namespace. See `design-notes.md` 2026-07-13.)* The raw number MUST NOT cross the sync wire at all: clients authenticate with hash-derived identity (the SCRAM username is the hash form, `server-protocol.md` §3.1), and the server rejects raw-form usernames.

## 8. Anti-abuse considerations (Phase 2+, not v0.1)

- Per-IP rate limiting on registration is **not viable** under the no-IP-logging commitment (`../threat-model.md` §2 AS14). Anti-abuse must be per-account or per-device-attestation.
- Captcha at registration acceptable.
- "No-email" model means a single attacker can churn through arbitrary numbers of free accounts. Rate-limiting per account, not per-creator, is the operational reality. Storage quotas on free accounts are the primary defense; Privacy Pass / KVAC tokens may be considered in a later major version.

## 9. Open issues

- **Display redaction policy** — UI behavior when re-displaying a previously-known account number (full vs partial). Out of scope for the protocol; UX decision.
- **Recovery if account number is lost** — losing the account number is not equivalent to losing the password. The hash is in `vault.meta`, but reverse-deriving the number from the hash is infeasible. Practical recovery: the user MUST also store the account number alongside the recovery phrase.
