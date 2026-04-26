# Myne Account Number Scheme v0.1

> **Status: skeleton.** This document fills in the details summarized in `protocol.md` §8. The format and normalization rules below are normative. The Damm-32 quasigroup table is referenced but not yet inlined; it will be added before v1.0 ship.

---

## 1. Purpose

The account number is Myne's primary user identifier — a Mullvad-style self-generated value that replaces email at signup. It serves three roles:

- **Vault binding** — the SHA-256 hash of the canonical form is mixed into both Argon2id salts (`protocol.md` §3.1) so vault keys cannot be precomputed across accounts.
- **Sync entitlement token** (Phase 2+) — when the sync server exists, the account number is the bearer token for hosted-sync access. The server stores only a hash; the raw number is never persisted server-side after registration.
- **User-facing identifier** — what the user writes down, hands to a self-host operator, or types when restoring on a new device.

The account number is **not** a key. It does not encrypt anything. Possession of an account number alone grants no read access to a vault — the master password and/or recovery phrase are required to derive `root_key`.

## 2. Format

```
Display form:   MY-XXXX-XXXX-XXXX-XXXX-X
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

The Damm algorithm uses a **totally anti-symmetric quasigroup** of order 32. Computing the check character:

```
damm32_check(s):
  digit := 0
  for c in s:                                # left-to-right
      digit := QUASIGROUP[digit][index_of(c)]
  return alphabet[digit]
```

A check is verified by appending the candidate check character to the 19-char string and running the same loop on all 20 characters; if the final `digit` is `0`, the check passes.

**Properties**: catches all single-character substitutions, all single-character adjacent transpositions, and a high fraction of two-character errors. Stronger than Luhn for alphanumeric alphabets.

The 32×32 quasigroup table is to be inlined in this document before v1.0 ship. Reference implementations:

- Damm's original paper (2004): "Total Anti-Symmetrische Quasigruppe", H. Michael Damm.
- A pre-built Damm-32 table: TBD reference (multiple GitHub implementations exist, requires audit before adoption).

> **Open issue.** The Damm-32 quasigroup MUST be a single canonical table chosen for Myne and frozen in this document. The table will be selected from a published source and pasted in before v1.0 ship.

## 5. Parsing and normalization

Liberal parsing rules — the user is allowed to enter the account number with or without prefix, with or without separators, in any case:

```
normalize(input):
  1. NFKD Unicode normalize + trim leading/trailing whitespace
  2. Remove all internal whitespace
  3. Strip leading "MY-" or "my-" (case-insensitive); fail if any other prefix is present
  4. Remove all "-" separators
  5. Uppercase
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
- **Server-side storage** (Phase 2+) — the sync server stores only `SHA-256(canonical_form)[:32]` (a different truncation length than `account_number_hash`, to avoid sharing identifiers across uses). The raw number is verified once at registration and discarded.

## 8. Anti-abuse considerations (Phase 2+, not v0.1)

- Per-IP rate limiting on registration is **not viable** under the no-IP-logging commitment (`../threat-model.md` §2 AS14). Anti-abuse must be per-account or per-device-attestation.
- Captcha at registration acceptable.
- "No-email" model means a single attacker can churn through arbitrary numbers of free accounts. Rate-limiting per account, not per-creator, is the operational reality. Storage quotas on free accounts are the primary defense; Privacy Pass / KVAC tokens may be considered in `appname-v005`.

## 9. Open issues

- **Damm-32 quasigroup table selection** — pick a published source, inline the table, freeze.
- **Display redaction policy** — UI behavior when re-displaying a previously-known account number (full vs partial). Out of scope for the protocol; UX decision.
- **Recovery if account number is lost** — losing the account number is not equivalent to losing the password. The hash is in `vault.meta`, but reverse-deriving the number from the hash is infeasible. Practical recovery: the user MUST also store the account number alongside the recovery phrase.
