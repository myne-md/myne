# Myne Protocol Specification v0.1

> **Status: draft.** Phase 1 cryptographic protocol for the Myne desktop client. Targets single-user, single-device, local-only usage. Sync server, multi-device, and sharing are explicitly out of scope for v0.1 — see §11. Forward-compatibility hooks for `appname-v005` aspirational features are documented in §10.

---

## 1. Overview, Scope, Conventions

### 1.1 Scope

This specification defines the **at-rest** encryption protocol for notes stored on a user's local device by the Myne Phase 1 desktop client. It covers:

- Derivation of the root key from the user's master password.
- The key hierarchy from root key to per-note encryption keys.
- The format of an encrypted note blob on disk.
- The BIP39 recovery-phrase derivation that wraps the root key.
- The format of the user's account-number identifier (full details in `account-number.md`).
- The protocol-version-byte commitment that anchors forward-compatibility for `appname-v005`.

Out of scope (see §11):
- Server-side authentication (`serverPassword` is derived in v0.1 but not transmitted).
- Sync wire protocol (Phase 2).
- Multi-device device-key management (Phase 2+).
- Inter-user sharing (Phase 4+).
- Real-time collaborative editing (Phase 4+).
- Post-quantum primitives (`appname-v005`).
- Group key agreement (MLS) (`appname-v005`).
- Key Transparency (`appname-v005`).

### 1.2 Conventions

- The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are interpreted per RFC 2119.
- `||` denotes byte-string concatenation.
- `[:N]` denotes truncation to the first N bytes.
- `derive_key(root, ctx)` denotes a context-bound subkey derivation; the concrete primitive (HKDF-SHA-256 or BLAKE3 derive_key) is a deferred decision (see §2.4) but the **calling pattern is fixed in this specification**.
- Context strings used in this specification all begin with the prefix `"myne.v0.1 "` (note: trailing space). This prefix domain-separates v0.1 from any future protocol version.

### 1.3 Protocol identifier

This specification is identified as **`myne-protocol-v0.1`**. The protocol version byte (§10.1) carries the value `0x01` for any blob produced under this specification.

---

## 2. Cryptographic Primitives

> **Conflict-points marked.** Five primitive choices below are flagged as `[DEFERRED]`: the v0.1 baseline is the prior decision in `../decisions.md`, but the user has marked these as subject to revision before v1.0 ship, with the `appname-v005` research as the alternative under consideration.

| Role | v0.1 baseline | `[DEFERRED]` alternative under review |
|---|---|---|
| KDF (password → root key) | Argon2id `m=64 MiB, t=5, p=1` (Standard Notes 004 parameters) | Argon2id `m=1 GiB, t=2, p=4` (research §2.4) |
| Subkey derivation | **HKDF-SHA-256** with registered context strings via single canonical helper (§3.2) | (resolved 2026-04-26 — see §12) |
| AEAD | XChaCha20-Poly1305 (RFC 8439 + extended-nonce variant), 256-bit key, 192-bit random nonce | XChaCha20-Poly1305 + CTX commitment outer hash (research §2.3) |
| Recovery phrase | BIP-39 24 words (256-bit entropy), library `@scure/bip39` | (no alternative under review) |
| Hashing | SHA-256 (RustCrypto `sha2`; libsodium / WebCrypto on other clients) | BLAKE3 (research §2.4) |
| RNG | OS CSPRNG (RustCrypto `getrandom` on the Rust client; libsodium `randombytes_buf` on libsodium clients) | (no alternative under review) |

**Library.** Rust desktop client: **RustCrypto stack** — `hkdf` (RFC 5869), `argon2` (RFC 9106), `chacha20poly1305` (RFC 8439 + extended-nonce variant), `sha2`, with `zeroize` for memory hygiene and `getrandom` for OS CSPRNG. The `protocol/` crate is `#![no_std]` + `extern crate alloc;`. Other clients use libsodium-equivalent APIs at the byte level: Go server uses `golang.org/x/crypto` when it ships in Phase 2; iOS/Android (Phase 3) use native libsodium bindings; the Phase 3 web client's primitive provider is decided at Phase 3 start. **No custom primitive implementations on any client.** Cross-implementation byte-level compatibility is validated by the `myne-test-vectors/` companion repo — RustCrypto and libsodium emit identical bytes for the same inputs because both implement the published RFCs and the CTX commitment construction (§5.1) is a thin SHA-256 wrapper on top.

The `chacha20poly1305` RustCrypto crate received an NCC Group audit (Feb 2020, no significant findings); `vodozemac` (Matrix Olm/Megolm in pure Rust on RustCrypto primitives) received a Least Authority audit (Mar 2022, no significant findings); `age`/`rage` ships exclusively on RustCrypto. These audit and prod-deployment evidences anchor the audit-substitute story (`../threat-model.md` §6) for the Rust side. See `../decisions.md` "2026-04-28 — Rust-side primitives: RustCrypto stack as primary".

The five `[DEFERRED]` items above will be resolved in dedicated decision sessions and recorded in `../decisions.md`. This v0.1 specification will be revised in place if any deferred decision changes the baseline.

---

## 3. Key Hierarchy

The hierarchy is structured to allow forward-compatible evolution toward `appname-v005` without breaking changes. The structural commitment is the **derive_key-with-context** pattern: every subkey is produced by `derive_key(root_key, context_string)` with a context string drawn from the registry in §3.4. New subkey roles can be added in later protocol versions by registering new context strings, with no change to the root-derivation step.

### 3.1 Root key generation and credential wrapping

The root key is the cryptographic core of the vault. It is **a 32-byte random value generated by the OS CSPRNG at vault creation**, stored only as ciphertext on disk, and held in client memory only between unlock and lock. It is **not derived from the password**. This is essential to support a recovery flow — if the root key were a function of the password, losing the password would destroy the vault unconditionally.

Two independent credentials can unlock the vault: the **master password** and the **24-word BIP-39 recovery phrase** (§7). Each credential derives a wrap key via Argon2id with its own salt; each wrap key encrypts an independent copy of the same `root_key`. Both encrypted copies live in `vault.meta` (§9.3). Either credential alone is sufficient to recover the root key. If both are lost, the data is permanently unrecoverable.

This architecture also supports later credentials (e.g., a hardware-backed WebAuthn-PRF unlock in `appname-v005`) by adding a third encrypted copy of `root_key` under a third wrap key, with no change to the rest of the protocol.

**Password path** (deriving `password_wrap_key` and the password-wrapped root key):

```
salt_password    = SHA-256("myne.v0.1 argon2id-password|"
                            || account_number_hash
                            || random_salt_password_16)[:16]

password_wrap_key = Argon2id(password = master_password,
                             salt    = salt_password,
                             m, t, p as encoded in vault.meta (§4),
                             out     = 32 bytes)

AAD_password_wrap = "myne.v0.1|"
                  || protocol_version (1 B)
                  || "password-wrap" (length-prefixed UTF-8)
                  || kdf_params_canonical (11 B; §4.3)

enc_root_key_password = AEAD-encrypt(key  = password_wrap_key,
                                     nonce = nonce_password_wrap (24 random bytes),
                                     plaintext = root_key (32 bytes),
                                     AAD  = AAD_password_wrap)
```

**Recovery-phrase path** (deriving `recovery_wrap_key` and the phrase-wrapped root key):

```
phrase_normalized = NFKD-lowercase-trim(phrase_text)   ← Unicode normalization

salt_recovery     = SHA-256("myne.v0.1 argon2id-recovery|"
                            || account_number_hash
                            || random_salt_recovery_16)[:16]

recovery_wrap_key = Argon2id(password = phrase_normalized (UTF-8 bytes),
                             salt    = salt_recovery,
                             m, t, p as encoded in vault.meta (§4),
                             out     = 32 bytes)

AAD_recovery_wrap = "myne.v0.1|"
                  || protocol_version (1 B)
                  || "recovery-wrap" (length-prefixed UTF-8)
                  || kdf_params_canonical (11 B; §4.3)

enc_root_key_recovery = AEAD-encrypt(key  = recovery_wrap_key,
                                     nonce = nonce_recovery_wrap (24 random bytes),
                                     plaintext = root_key (32 bytes),
                                     AAD  = AAD_recovery_wrap)
```

Both `random_salt_password_16` and `random_salt_recovery_16` are generated once at vault creation and stored in `vault.meta`. The two distinct `argon2id-password` / `argon2id-recovery` salt prefixes ensure the two Argon2id outputs are domain-separated even if the same secret were ever used for both (which it MUST NOT be).

**`account_number_hash`** binds both salts to the user's account number (§8), preventing pre-computation of Argon2id outputs across accounts.

The Argon2id parameter values themselves live in `vault.meta` (§9.3) and are bound into both wrap AADs (§4.3), so any tampering with the stored parameters invalidates the AEAD tag.

### 3.2 Subkey derivation (HKDF-SHA-256 with registered context strings)

The concrete primitive is **HKDF-SHA-256** (RFC 5869) via libsodium's `crypto_kdf_hkdf_sha256_*` API. For each subkey role:

```
subkey = HKDF-Expand(
            PRK  = HKDF-Extract(salt = zero_32, IKM = root_key),
            info = context_string,
            L    = output_length_in_bytes
         )
```

Where:

- `salt = zero_32` (32 zero bytes). HKDF-Extract is invoked once per `root_key`; the PRK MAY be cached in client memory until the vault is locked.
- `info = context_string` is drawn from the registry in §3.4. Context strings MUST be unique within the registry; reuse is a protocol violation.
- `output_length_in_bytes` is 32 for symmetric-key subkeys.

#### 3.2.1 Single canonical helper (mandatory)

Implementations MUST expose subkey derivation only through a single canonical helper that constructs the `info` parameter from a registered role identifier. Direct calls to `HKDF-Expand` outside this helper are forbidden. Reference shape (Go):

```go
// derive_subkey is the only place HKDF-Expand is called for v0.1 subkeys.
// role MUST be one of the strings registered in §3.4.
func DeriveSubkey(rootKey []byte, role string) [32]byte {
    info := []byte("myne.v0.1 " + role)   // canonical prefix locked
    return hkdfSha256Expand(rootKey, info, 32)
}
```

The same shape applies in TypeScript (`@noble/hashes/hkdf` or libsodium-js wrappers) and any other client language. Code review MUST reject any direct call to `hkdf.expand` / `crypto_kdf_hkdf_sha256_expand` from outside this single helper.

This pattern collapses the BLAKE3 vs HKDF debate into a non-issue: BLAKE3 `derive_key`'s "structural context binding" advantage is that the context-string format is fixed by the API. With the helper above, Myne achieves the same property at the codebase level, while keeping HKDF-SHA-256 as the underlying primitive — which is libsodium-native, MLS-aligned (RFC 9420), and already covered by published Tamarin / ProVerif / CryptoVerif models.

#### 3.2.2 Context-string canonical format

Every `info` value passed into `HKDF-Expand` for v0.1 subkey derivation MUST match the form:

```
info = "myne.v0.1 " || role
```

Where `role` is exactly the string from the registry (§3.4). The trailing space after `myne.v0.1` is part of the prefix. Both prefix and role are UTF-8 / ASCII; v0.1 uses ASCII-only role identifiers. Implementations MUST NOT add separators, length prefixes, or trailing null bytes — the `info` parameter is the literal concatenation above.

#### 3.2.3 v005 forward-compatibility

`appname-v005` will likely retain HKDF-SHA-256 because RFC 9420 MLS mandates it for the MLS key schedule; running two KDF primitives in one client doubles the audit surface for no benefit. v005 will register its own `"myne.v005 "` context prefix, so v0.1 and v005 subkey derivations cannot collide even when the same root key bytes appear.

### 3.3 Three-level wrapping for notes

Each note is encrypted under a three-level key hierarchy:

```
root_key (from password via Argon2id, §3.1)
  │
  └── itemsKey_wrap_key = derive_key(root_key, "myne.v0.1 itemsKey-wrap")
        │
        └── encrypts itemsKey
              │
              └── itemsKey (32 random bytes, persistent across password changes)
                    │
                    └── encrypts item_key (per note)
                          │
                          └── item_key (32 random bytes, per note)
                                │
                                └── encrypts note plaintext
```

The three levels are:

1. **`itemsKey_wrap_key`** — deterministically derived from the root key via the registered context string (§3.4). Never stored.
2. **`itemsKey`** — a single 32-byte random key, generated once on vault initialization, persistent across password changes. Stored on disk as ciphertext under `itemsKey_wrap_key`. Re-wrapped (not regenerated) when the password changes.
3. **`item_key`** — a per-note 32-byte random key, generated when a note is created. Stored alongside that note's ciphertext, wrapped under the current `itemsKey`. The plaintext of the note is encrypted under `item_key` using the AEAD construction defined in §5.

**Why three levels and not two:** when the user changes their master password, the new `root_key` produces a new `itemsKey_wrap_key`. The persistent `itemsKey` is decrypted with the old wrap key and re-encrypted under the new one — a single AEAD operation. None of the per-note `item_key` material is touched, and none of the note ciphertexts are re-encrypted. This is essential for vaults of non-trivial size.

**Forward-compatibility for `appname-v005` epoch-key model.** The research roadmap (`protocol-v005-roadmap.md`, to be written) describes per-epoch `itemsKey` rotation that gives notes forward secrecy: each `EK_e` is derived for an epoch, used to wrap a generation of `item_key` material, then deleted on rotation, after which the corresponding ciphertexts become unrecoverable. To allow this evolution without a wire-format break, the v0.1 context-string registry (§3.4) reserves the prefix `"myne.v005 epoch-"` for future epoch-key derivations, and the per-note blob format (§9) carries an `itemsKey_id` field whose semantics extend cleanly from "the singleton v0.1 itemsKey" to "the v005 itemsKey for epoch e".

In v0.1, only the singleton `itemsKey` exists. There is no epoch rotation. The reservation is purely structural.

### 3.4 Subkey context-string registry (v0.1)

| Context string | Role | Phase 1 use |
|---|---|---|
| `"myne.v0.1 server-auth"` | Sync-server authentication material — **placeholder** | Derived locally and held in memory between unlock and lock; **not transmitted in Phase 1** because no sync server exists. The exact use of this material (simple verifier transmission vs. OPAQUE `export_key` integration) is **deferred to Phase 2**; see §11.1 for the criteria that will resolve the choice. |
| `"myne.v0.1 itemsKey-wrap"` | KEK for the persistent itemsKey | Active (wraps itemsKey on disk). |
| `"myne.v0.1 backup-key"` | Local-encrypted backup file derivation root | Active when user exports a backup. |
| `"myne.v0.1 prefs-key"` | KEK for `vault.prefs` blob (§9.5) | Active when `vault.prefs` is written. |
| `"myne.v0.1 search-index-key"` | KEK for `vault.search` blob (§9.6) | Active when `vault.search` is written (MYND-29). |
| (future v005 contexts) | reserved | not derived in v0.1. |

New v0.1 context strings MAY be added in future revisions of this specification; all v0.1 context strings begin with `"myne.v0.1 "` and v005 context strings will begin with `"myne.v005 "`.

The deferred resolution of `server-auth` does not affect the v0.1 wire format or any blob produced under v0.1 — the subkey is derived but never used by any v0.1 client. A v0.1 vault opened by a Phase 2 client will still produce the same `server-auth` bytes deterministically; the Phase 2 protocol layer determines what to do with them.

---

## 4. KDF Parameters

Argon2id is used in two places (§3.1): deriving `password_wrap_key` from the master password, and deriving `recovery_wrap_key` from the BIP-39 phrase. Both call sites use the **same parameter set**, drawn from `vault.meta` at runtime — parameters are **not hardcoded in the client**.

### 4.1 Parameter values (v0.1 baseline)

| Parameter | Value | Encoded as |
|---|---|---|
| Algorithm | Argon2id (RFC 9106) | `kdf_id = 0x01` |
| Memory `m` | 256 MiB (262 144 KiB) | `kdf_m_kib = 0x00040000` (uint32 BE) |
| Time `t` | 3 iterations | `kdf_t = 0x00000003` (uint32 BE) |
| Parallelism `p` | 2 | `kdf_p = 0x02` (uint8) |
| Argon2 version | 1.3 | `argon2_version = 0x13` (uint8) |
| Salt | 16 bytes (constructed per §3.1) | (in `random_salt_*_16` fields) |
| Output | 32 bytes | (implicit) |

Approximate cost: ~1 second on a 2024 desktop laptop, ~2–3 seconds on mid-tier mobile (Phase 3), well within libsodium.js memory limits in modern browsers (Phase 3 web client).

These parameters are calibrated to provide **≥ 80 bits of effective security when combined with a password of ≥ 60 bits of entropy**. Users who select weaker passwords are protected primarily by their recovery phrase, which carries 256 bits of entropy independent of password choice. Implementations SHOULD enforce a minimum password strength (e.g., ≥ 12 characters, zxcvbn score ≥ 3, dictionary check) at signup; this is a UX-level responsibility, not a protocol-level mandate.

### 4.2 Parameters stored in `vault.meta`

The complete parameter set is stored in `vault.meta` (§9.3). Storing parameters per-vault — rather than hardcoding them in the client — has three consequences, all desirable:

1. **Parameter upgrade without format break**: if hardware advances make stronger parameters affordable, a future minor revision MAY raise the baseline; existing vaults continue to open with their original parameters until the user changes their password (which generates a fresh wrap with the new defaults).
2. **Per-platform calibration without forking the format**: Phase 3 mobile ports MAY ship vaults with reduced parameters where the device cannot afford 256 MiB. The protocol does not require the same parameters across platforms; it requires the same parameters across the *two Argon2id call sites within a single vault*.
3. **Auditor transparency**: the parameters used to lock the vault are inspectable in `vault.meta` without running the client, supporting the compensating-controls plan in `../threat-model.md` §6.

### 4.3 AAD binding of parameters

The 11-byte canonical parameter encoding:

```
kdf_params_canonical = kdf_id (1 B)
                    || kdf_m_kib (4 B BE)
                    || kdf_t (4 B BE)
                    || kdf_p (1 B)
                    || argon2_version (1 B)
```

This 11-byte string is appended to BOTH `AAD_password_wrap` and `AAD_recovery_wrap` (§3.1). Tampering with any parameter byte in `vault.meta` invalidates the AEAD tag on both wrapped root-key copies, preventing parameter-downgrade attacks structurally rather than by client policy.

## 5. AEAD Construction

### 5.1 Primitive: XChaCha20-Poly1305 with CTX commitment

The base AEAD is **XChaCha20-Poly1305** per RFC 8439 plus the extended-nonce variant. 256-bit key, 192-bit nonce drawn from the OS CSPRNG via libsodium `randombytes_buf`.

Plain XChaCha20-Poly1305 is **not key-committing**: an attacker can construct a single ciphertext that decrypts validly under multiple keys (Len–Grubbs–Ristenpart, "Partitioning Oracle Attacks", USENIX Security 2021). For a vault that stores `enc_root_key_password` on disk, this opens a partitioning attack against weak passwords. v0.1 closes this by wrapping the AEAD in the **CTX commitment construction** (Chan & Rogaway, "On Committing Authenticated Encryption", ESORICS 2022).

#### 5.1.1 CTX wrapping pattern

```
CTX-encrypt(K, N, plaintext, AD):
    ciphertext, T = XChaCha20_Poly1305_encrypt_detached(K, N, plaintext, AD)
    T' = SHA-256( canonical_encode(K, N, AD, T) )    ← 32-byte commitment tag
    return (ciphertext, T')

CTX-decrypt(K, N, ciphertext, T', AD):
    T_recomputed = Poly1305_MAC(K, N, AD, ciphertext)
    T'_expected  = SHA-256( canonical_encode(K, N, AD, T_recomputed) )
    if not constant_time_eq(T', T'_expected):
        ABORT — the ciphertext is not committed under (K, N, AD)
    plaintext = XChaCha20_decrypt_no_auth(K, N, ciphertext)
    return plaintext
```

The canonical encoding fed into SHA-256 has fixed-length and length-prefixed segments to eliminate concatenation ambiguity:

```
canonical_encode(K, N, AD, T) =
       K[32]              ← 32 fixed bytes
    || N[24]              ← 24 fixed bytes
    || len(AD)[4 BE]      ← 4-byte big-endian unsigned length
    || AD                 ← variable length
    || T[16]              ← 16 fixed bytes
```

This satisfies the "encode-then-hash" requirement of Chan & Rogaway §3 — without the length prefix, an attacker could shift bytes between fixed and variable regions to produce two distinct inputs with identical hashes.

#### 5.1.2 What goes on disk

- The Poly1305 tag `T` (16 bytes) is **not stored on disk**. It is recomputed at decrypt time from `(K, N, AD, ciphertext)` since Poly1305 over a fixed input is deterministic.
- The CTX commitment tag `T'` (32 bytes) replaces `T` in the on-disk record. Tag fields in §9.2 and §9.3 are 32 bytes wide.

#### 5.1.3 Two-step verification semantics

A correct decryption requires both:

1. **CTX commitment check** — `T' == SHA-256(canonical_encode(K, N, AD, T_recomputed))`. Fails if the (K, N, AD, ciphertext) tuple is not the one the encryptor committed to. This is the partition-oracle defense.
2. **Poly1305 authenticity** — implicit in step 1, since `T_recomputed` is the Poly1305 MAC of `(K, N, AD, ciphertext)` and any forgery in `ciphertext` produces a different `T_recomputed` and therefore a different `T'_expected`.

Both checks are folded into the single constant-time equality on `T'`. Implementations MUST use a constant-time comparator (libsodium `sodium_memcmp` or equivalent) and MUST NOT short-circuit on early byte mismatches.

#### 5.1.4 Library availability

- Go: `golang.org/x/crypto/chacha20poly1305` for the AEAD; stdlib `crypto/sha256` for the outer hash; constant-time compare via `crypto/subtle.ConstantTimeCompare`.
- TypeScript / JS: libsodium-js `crypto_aead_xchacha20poly1305_ietf_encrypt_detached`; stdlib SubtleCrypto `digest("SHA-256", ...)` for the outer hash.

No new dependencies. The construction is ~30 lines in either language.

### 5.2 Associated Data (AAD) construction

Both AEAD operations carry an AAD with the structure:

```
AAD_prefix = "myne.v0.1|"               (10 ASCII bytes, including pipe)

AAD_wrap_items_key =
  AAD_prefix || protocol_version (1 B) || items_key_id (16 B)

AAD_wrap_item_key =
  AAD_prefix || protocol_version (1 B) || items_key_id (16 B) || note_uuid (16 B)

AAD_encrypt_content =
  AAD_prefix || protocol_version (1 B) || items_key_id (16 B) || note_uuid (16 B) || content_type

AAD_prefs_blob =
  AAD_prefix || protocol_version (1 B) || "prefs-blob" || account_number_hash (16 B)
```

`AAD_wrap_items_key` is the AAD bound into the AEAD wrap of the singleton v0.1 `itemsKey` (`vault.meta` §9.3 offset 281). It is distinct from `AAD_wrap_item_key`, which binds the per-note `item_key` wrap and additionally carries the per-note UUID. The singleton `itemsKey` has no per-note UUID, so the AAD reduces accordingly.

`AAD_prefs_blob` is the AAD bound into the AEAD wrap of `vault.prefs` (§9.5). The `"prefs-blob"` role string is length-prefixed UTF-8 (2-B big-endian length + 10 ASCII bytes); `account_number_hash` is the 16-byte field from `vault.meta` (§9.3 offset 6) and binds the prefs blob to its specific vault. `items_key_id` is **not** bound — `vault.prefs` is independent of the `itemsKey` lineage because its KEK derives directly from `root_key` via `"myne.v0.1 prefs-key"` (§3.4), which preserves prefs portability across the v005 epoch-rotation `itemsKey` evolution.

`AAD_search_index_blob` is the AAD bound into the AEAD wrap of `vault.search` (§9.6), the encrypted search-index blob. It mirrors `AAD_prefs_blob` exactly, with the role string `"search-index-blob"` (length-prefixed UTF-8: 2-B big-endian length + 17 ASCII bytes) and the same 16-byte `account_number_hash` from `vault.meta` (§9.3 offset 6) binding the index blob to its specific vault. As with prefs, `items_key_id` is **not** bound: the search-index KEK derives directly from `root_key` via `"myne.v0.1 search-index-key"` (§3.4), independent of the `itemsKey` lineage.

**Length-prefix encoding for variable-width AAD fields.** All length-prefixed UTF-8 fields in this section and in §3.1 — the `password-wrap` and `recovery-wrap` role strings in `AAD_password_wrap` / `AAD_recovery_wrap`, and the `content_type` field in `AAD_encrypt_content` — are encoded as a **2-byte big-endian unsigned length** followed by the UTF-8 bytes. This matches the binary-format convention elsewhere in this spec (§9.2 reads `enc_item_key_len` as 2 bytes big-endian).

`content_type` in v0.1 is always `"text/markdown"`. The field is included so v005 can introduce attachments and other content types without breaking the AAD layout.

The `AAD_password_wrap` and `AAD_recovery_wrap` AADs (defined in §3.1) additionally carry the canonical KDF parameters block (§4.3), so any tampering with the stored Argon2id parameters invalidates the wrap.

The AAD bytes feed both into Poly1305's MAC computation (standard AEAD behavior) and into the CTX canonical encoding (§5.1.1). A successful decryption proves the encryptor committed to exactly these AAD bytes — downgrade, substitution, key-confusion, content-type-confusion, and KDF-parameter-tampering all fail the CTX commitment check.

### 5.3 Nonce policy

Nonces are 192-bit random values drawn from the OS CSPRNG immediately before each AEAD call. Nonces are stored in the per-note blob (§9.2) and never reused. The protocol does not use deterministic or counter nonces in v0.1.

## 6. Per-Note Encryption

This section narrates the per-note encryption and decryption flow that produces and consumes the `.myn` blob format of §9.2. The key hierarchy that supplies `itemsKey` is established in §3.3; the AEAD primitive is XChaCha20-Poly1305 + CTX commitment per §5.1; the AAD bindings are defined in §5.2. The byte layout in §9.2 is normative — this section adds no new fields and changes no offsets.

### 6.1 Inputs available to the client

A note encryption or decryption operation runs only when the vault is unlocked. The client therefore holds in memory:

- `root_key` — 32 bytes, recovered by the §3.1 unlock procedure.
- `itemsKey` — 32 bytes, recovered by AEAD-decrypting `enc_items_key` (`vault.meta` offset 281; §9.3) under `itemsKey_wrap_key = DeriveSubkey(root_key, "itemsKey-wrap")` per §3.2 and §3.4.
- `items_key_id` — 16-byte UUIDv7 of the singleton v0.1 `itemsKey`, read from `vault.meta` offset 241.

Per-note state:

- `note_uuid` — 16-byte UUIDv7 generated when the note is created. Doubles as the `.myn` filename per §9.1 and as an AAD field per §5.2.
- `content_type` — fixed string `"text/markdown"` in v0.1.
- `plaintext` — UTF-8 bytes of the note's Markdown body.

### 6.2 Creating a new note

Each AEAD call below is the CTX-committed XChaCha20-Poly1305 of §5.1: the on-disk tag is the 32-byte commitment `T'`, never the 16-byte Poly1305 tag (§5.1.2).

```
1. item_key       ← OS_CSPRNG(32 bytes)
2. item_key_nonce ← OS_CSPRNG(24 bytes)
   AAD_wrap_item_key constructed per §5.2 with
       items_key_id and note_uuid.
   enc_item_key  ← AEAD-encrypt(K = itemsKey,
                                N = item_key_nonce,
                                P = item_key,
                                AD = AAD_wrap_item_key)
                  yields 32 B ciphertext || 32 B CTX tag = 64 B on disk
3. content_nonce  ← OS_CSPRNG(24 bytes)
   AAD_encrypt_content constructed per §5.2 with
       items_key_id, note_uuid, content_type.
   ciphertext    ← AEAD-encrypt(K = item_key,
                                N = content_nonce,
                                P = plaintext,
                                AD = AAD_encrypt_content)
                  yields len(plaintext) B ciphertext || 32 B CTX tag
4. Write the .myn blob per §9.2:
       "MY01" || 0x01 || 0x00 || items_key_id || item_key_nonce
       || enc_item_key_len = 64 (2 B BE) || enc_item_key
       || content_nonce
       || ciphertext_len = len(plaintext) + 32 (4 B BE)
       || ciphertext
5. Zeroize item_key in client memory.
```

`item_key` is never persisted in plaintext and never leaves the encryption call.

### 6.3 Updating an existing note

`item_key`, `item_key_nonce`, and `enc_item_key` are persistent for the note's lifetime per §3.3. Updates reuse the existing `item_key` under a fresh `content_nonce`:

```
1. Decrypt the existing note per §6.4 to recover item_key.
2. content_nonce ← OS_CSPRNG(24 bytes)
   ciphertext   ← AEAD-encrypt(K = item_key,
                               N = content_nonce,
                               P = updated_plaintext,
                               AD = AAD_encrypt_content)
3. Rewrite the .myn blob. Bytes 0 through 47+N inclusive — the header
   through enc_item_key — are byte-identical to the previous blob;
   only content_nonce, ciphertext_len, and ciphertext change.
4. Zeroize item_key.
```

The note's `note_uuid` and therefore its filename are unchanged by an update, so `AAD_wrap_item_key` and `AAD_encrypt_content` continue to commit to the same identity bytes across the note's lifetime. The persistence of `enc_item_key` is intentional: it allows password rotation (which changes `itemsKey_wrap_key` but not `itemsKey`) to leave every `.myn` file untouched, per §3.3.

### 6.4 Decrypting a note

```
1. Parse the .myn blob per §9.2. Reject if
       magic != "MY01" || protocol_version != 0x01
       || reserved != 0x00 || enc_item_key_len != 64.
2. Reject if items_key_id does not match the singleton itemsKey id
   in vault.meta (offset 241). v0.1 has exactly one itemsKey; a
   mismatch is either a foreign blob or vault-meta corruption.
3. AAD_wrap_item_key constructed per §5.2 with
       items_key_id and note_uuid (= the .myn filename UUID per §9.1).
   item_key  ← AEAD-decrypt(K = itemsKey,
                            N = item_key_nonce,
                            C = enc_item_key,
                            AD = AAD_wrap_item_key)
4. AAD_encrypt_content constructed per §5.2 with
       items_key_id, note_uuid, content_type.
   plaintext ← AEAD-decrypt(K = item_key,
                            N = content_nonce,
                            C = ciphertext,
                            AD = AAD_encrypt_content)
5. Zeroize item_key once plaintext is delivered.
```

Failure at step 3 means either the blob was tampered (any byte feeding the CTX canonical encoding: `enc_item_key`, `item_key_nonce`, the AAD-bound fields `items_key_id` or `note_uuid`, or the version/prefix bytes) or `itemsKey` is wrong. Failure at step 4 — given step 3 succeeded — narrows to corruption of `content_nonce`, `ciphertext`, or `content_type`. The CTX commitment construction (§5.1.3) folds authenticity and key-commitment into a single constant-time tag comparison; the client MUST NOT distinguish failure causes to the user beyond "this note cannot be decrypted under the current vault".

### 6.5 What the AAD bindings prevent

Because both AEAD operations bind their AAD per §5.2, a successful decrypt commits the encryptor to:

- **Protocol version and AAD prefix.** A v005 client's `"myne.v005|"` AAD will not verify a v0.1 blob's `"myne.v0.1|"` AAD; cross-major substitution fails by construction (§10.5).
- **itemsKey identity.** A `.myn` file from a different vault cannot be silently accepted: both AEAD AADs bind `items_key_id` and the §6.4 step-2 check additionally requires the id match the singleton recorded in `vault.meta`.
- **Note identity.** Renaming a `.myn` file (changing the UUID in its filename) without re-encrypting fails verification — `note_uuid` is bound into both `AAD_wrap_item_key` and `AAD_encrypt_content`.
- **Content type.** Future v005 attachment types cannot be substituted into a v0.1 blob: `content_type` is bound into `AAD_encrypt_content` and any mismatch fails the CTX commitment check.

### 6.6 Why two AEAD calls

Encrypting plaintext directly under `itemsKey` would save one AEAD call per note but defeat the password-rotation property of §3.3: re-wrapping under a new key would force every note's ciphertext to be re-encrypted. The two-call structure isolates per-note cost from `itemsKey` rotation — a future rewrap touches one 64-byte field per note, never the bulk plaintext.

### 6.7 Nonce hygiene

Both `item_key_nonce` and `content_nonce` are 192-bit values from the OS CSPRNG (§5.3). At this width, random collisions are negligible across any realistic note count or revision count under a single `itemsKey` or `item_key`. v0.1 does not use deterministic, counter, or input-derived nonces; deviation is a major-version event.

## 7. Recovery Phrase Derivation

### 7.1 Phrase format

The recovery phrase is **24 BIP-39 English words** representing 256 bits of entropy plus an 8-bit checksum (BIP-39 §3 encoding). The wordlist is the canonical English BIP-39 list.

Myne uses BIP-39 only as an **encoding** for high-entropy phrases. It does **not** use BIP-39's standard PBKDF2-HMAC-SHA512 seed derivation, which uses 2048 iterations and is too weak by 2026 standards (research §3.5). Instead, the phrase string is fed directly to Argon2id as defined in §3.1 (`recovery_wrap_key` derivation).

### 7.2 Generation at vault creation

```
phrase_entropy = OS_CSPRNG(32 bytes)              ← 256 bits of secret entropy
checksum_bits   = SHA-256(phrase_entropy)[:1] (high 8 bits of byte 0)
phrase_bits     = phrase_entropy || checksum_bits (264 bits)
phrase_words    = BIP-39 encode(phrase_bits)      ← 24 words
phrase_text     = words joined with single ASCII spaces
```

The 24 words are presented to the user via the recovery flow defined in `recovery-flow.md` (TBD). The flow MUST require the user to confirm the phrase before vault creation completes — typing back, word selection from the wordlist, or equivalent. A bare "I have written it down" checkbox is insufficient.

### 7.3 Use during recovery

```
phrase_normalized = NFKD-lowercase-trim(user_input)
recovery_wrap_key = Argon2id(phrase_normalized, salt_recovery, ...)   ← §3.1
root_key          = AEAD-decrypt(recovery_wrap_key,
                                 nonce_recovery_wrap,
                                 enc_root_key_recovery,
                                 AAD_recovery_wrap)
```

Tag-verification failure means either the phrase was entered wrong or the `vault.meta` was tampered. The client MUST NOT distinguish these two cases to the user beyond "phrase or vault is invalid".

After successful recovery the client prompts the user to set a new master password. The new password generates fresh `random_salt_password_16` and a new `enc_root_key_password`; `vault.meta` is rewritten in place. The recovery phrase **does not change** — its `enc_root_key_recovery` and `salt_recovery` are preserved across password changes.

### 7.4 Phrase normalization

```
phrase_normalized = lowercase(trim(NFKD(phrase_input)))
                    where consecutive whitespace runs collapse to a single ASCII space
```

NFKD is applied so that visually-identical phrases entered with different keyboard layouts produce identical bytes. Lowercase + trim handles common user input variation. The wordlist itself is ASCII lowercase, so the normalization is conservative.

### 7.5 What the phrase does NOT do

- The phrase is **not** the encryption key. It derives `recovery_wrap_key`, which encrypts a copy of `root_key`.
- The phrase is **not** sent to any server in v0.1.
- The phrase **cannot** be combined with a server-side service to provide a partial-recovery path. v0.1 is hard zero-knowledge: lose both phrase and password, lose the vault.

## 8. Account Number Scheme

This section summarizes the account-number format used by the protocol. Full generation, display, parsing, and validation rules are specified in `account-number.md`.

### 8.1 Format

- Alphabet: **Crockford base32** (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, excludes `I L O U`).
- Payload: **19 random characters** (95 bits of entropy) + **1 Damm-32 check character**.
- Display: `MY-XXXX-XXXX-XXXX-XXXX-X` — human-readable prefix `MY-` plus 4-4-4-4-1 group separators. The prefix and separators are presentation-only.

### 8.2 Generation

```
entropy_bits   = OS_CSPRNG(95 bits)
entropy_chars  = crockford_base32_encode(entropy_bits)        ← 19 chars
check_char     = damm32_check(entropy_chars)                  ← 1 char
account_number = entropy_chars || check_char                  ← 20 chars (canonical form)
display_form   = "MY-" || group_with_dashes(account_number)
```

### 8.3 Normalization for hashing

The account number is normalized before any cryptographic use:

```
normalize(input):
  1. NFKD Unicode normalize + trim whitespace
  2. Strip optional leading "MY-" / "my-" (case-insensitive)
  3. Strip all "-" separators and internal whitespace
  4. Uppercase
  5. Verify length = 20 and Damm-32 check passes
  6. Return canonical 20-character uppercase string
```

The cryptographic identifier used throughout the protocol is the SHA-256 of the canonical form, truncated to 16 bytes:

```
account_number_hash = SHA-256(normalize(account_number_input) as ASCII)[:16]
```

This hash is stored in `vault.meta` (§9.3) and used as a salt component in both Argon2id derivations (§3.1).

### 8.4 What this section does NOT cover

- Algorithmic details of Damm-32 (the 32×32 quasigroup table) → `account-number.md`.
- Server-side anti-abuse for account-number creation (rate limiting, captchas) → out of scope for v0.1; relevant when sync server ships in Phase 2.
- Anonymous-credential wrappers (KVAC, Privacy Pass) — `appname-v005` may layer these on top of the account number for sync-server entitlement; the account-number format itself does not change.

## 9. On-Disk Storage Format

### 9.1 Vault layout

A Myne vault is a directory on the user's filesystem containing:

```
<vault-root>/
├── vault.meta            ← single file with vault-level state
├── notes/
│   ├── 0184a2b3-...myn   ← one encrypted note per file
│   ├── 0184a2b4-...myn
│   └── ...
├── snapshots/            ← encrypted per-note version history (MYND-96)
│   ├── 0184a2b3-...__0184c1d2-...myn
│   └── ...
└── attachments/          ← reserved; out of scope for v0.1 (§11)
```

- File extension `.myn` (Myne Note) for per-note ciphertext blobs.
- File extension `.meta` for vault-level metadata (the wrapped `itemsKey`, the random Argon2id salt, the protocol version, and the account number).
- File names are the note's UUIDv7 string. UUIDs are not encrypted; they are random and reveal only "this is a note" plus a coarse creation-time bucket. (UUIDv7 chosen for natural sort order; the time component leaks a creation-time millisecond, which is accepted in v0.1; v005 may switch to UUIDv4 if even coarse leakage is unacceptable.)
- **Folders are virtual (MYND-144).** The `notes/` directory is **always flat** — folder hierarchy is **not** reflected on disk. A note's folder is a path string in its encrypted frontmatter (`folder:`, see [`markdown-dialect.md`](markdown-dialect.md) §3.6.1); the sidebar tree is reconstructed client-side after decryption. This keeps folder structure inside the AEAD-encrypted blob (`threat-model.md` **AS3**, Sensitive) — a filesystem adversary (A4/A7) sees only flat `<uuid>.myn` blobs, never folder names. Deliberately-created (empty) folders are carried in `vault.prefs` (§9.5.2 `deliberate_folders`), also encrypted. No on-disk-format change.
- **Encrypted snapshots (MYND-96).** The `snapshots/` directory holds per-note version history. Each snapshot is a frozen `.myn`-format blob — the prior note plaintext re-sealed under the note's own `item_key` in the `MY01` envelope of §9.2 — so there is **no new magic byte and no §10.3 registry entry**. Files are flat (no per-note subdirectories, mirroring the `notes/` privacy posture) and named `<note-uuid>__<snapshot-uuidv7>.myn`; the snapshot's capture time is the trailing UUIDv7's time component and snapshots sort naturally. Capture is time-coalesced (≈ one per note per 5 min of active editing, plus on editor-close / vault-lock); retention is a bounded window (default ~7 days) with a safety backstop, pruned eagerly. Permanently deleting a note purges its snapshots, preserving cryptographic erase (a reused-`item_key` snapshot would otherwise be undecryptable orphan ciphertext). The metadata-leak posture is recorded in `threat-model.md` §7 and the decision in `decisions.md` 2026-06-08. No on-disk-format change to `.myn`, `vault.meta`, `vault.prefs`, or `vault.search`.

### 9.2 Per-note blob (`.myn`) binary format

All multi-byte integers are big-endian. All length-prefixed fields use the listed integer width.

```
Offset  Size       Field                Description
------  ---------  -------------------  ---------------------------------------
0       4 bytes    magic                ASCII "MY01"
4       1 byte     protocol_version     0x01 for this specification
5       1 byte     reserved             MUST be 0x00; non-zero rejects parse
6       16 bytes   items_key_id         Identifier of the itemsKey under which
                                        enc_item_key is wrapped. v0.1 uses a
                                        single itemsKey; this field is the
                                        UUIDv7 of that itemsKey, recorded in
                                        vault.meta. v005 will use this field
                                        to identify the epoch (§3.3).
22      24 bytes   item_key_nonce       192-bit random nonce used to wrap
                                        item_key under itemsKey.
46      2 bytes    enc_item_key_len     Length N of the wrapped item_key
                                        (XChaCha20-Poly1305 ciphertext +
                                        CTX commitment tag, N = 32 + 32 = 64).
48      N bytes    enc_item_key         The item_key (32 B), AEAD-encrypted
                                        under itemsKey with item_key_nonce,
                                        followed by the 32-byte CTX commitment
                                        tag T' (§5.1).
48+N    24 bytes   content_nonce        192-bit random nonce used to encrypt
                                        the note plaintext under item_key.
72+N    4 bytes    ciphertext_len       Length M = plaintext_len + 32 of the
                                        note ciphertext followed by the 32-byte
                                        CTX commitment tag T'.
76+N    M bytes    ciphertext           Note plaintext, AEAD-encrypted under
                                        item_key with content_nonce, followed
                                        by the 32-byte CTX commitment tag T'.
                                        The AAD binding is defined in §5.2.
```

The two AEAD operations (wrapping `item_key`, encrypting note content) use independent random nonces drawn from the OS CSPRNG. XChaCha20-Poly1305's 192-bit nonce makes random-nonce collisions negligible across any realistic usage.

Implementations SHOULD reject `ciphertext_len > 16 MiB + 32`. Larger payloads belong to the Phase 1.5+ attachment subsystem (§11). The cap exists to bound the parser's pre-AEAD allocation footprint — `ciphertext_len` is read and acted upon before any tag verification can run, so a hostile blob with a 4 GiB advertised length would otherwise force an unrecoverable allocation attempt before authenticity is established. See `docs/decisions.md` 2026-05-06 entry for the full rationale.

### 9.3 Vault metadata (`vault.meta`)

```
Offset  Size       Field                       Description
------  ---------  --------------------------  ---------------------------------
0       4 bytes    magic                       ASCII "MYV1"
4       1 byte     protocol_version            0x01
5       1 byte     reserved                    MUST be 0x00
6       16 bytes   account_number_hash         SHA-256 of the account number,
                                               [:16] (§8).

  --- KDF parameters (§4.3 canonical encoding, 11 bytes) ---
22      1 byte     kdf_id                      0x01 = Argon2id (only value
                                               accepted in v0.1).
23      4 bytes    kdf_m_kib                   Memory cost in KiB. v0.1 baseline
                                               = 0x00040000 (256 MiB).
27      4 bytes    kdf_t                       Iterations. v0.1 baseline = 3.
31      1 byte     kdf_p                       Parallelism. v0.1 baseline = 2.
32      1 byte     argon2_version              0x13 (Argon2 1.3).
  --- end KDF parameters ---

33      16 bytes   random_salt_password_16     Per-vault random salt for the
                                               password Argon2id (§3.1).
49      16 bytes   random_salt_recovery_16     Per-vault random salt for the
                                               recovery-phrase Argon2id (§3.1).
65      24 bytes   nonce_password_wrap         Nonce for AEAD wrapping root_key
                                               under password_wrap_key.
89      64 bytes   enc_root_key_password       root_key (32 B) wrapped under
                                               password_wrap_key, followed by
                                               the 32-byte CTX commitment tag.
153     24 bytes   nonce_recovery_wrap         Nonce for AEAD wrapping root_key
                                               under recovery_wrap_key.
177     64 bytes   enc_root_key_recovery       root_key (32 B) wrapped under
                                               recovery_wrap_key, followed by
                                               the 32-byte CTX commitment tag.
241     16 bytes   items_key_id                UUIDv7 of the singleton v0.1
                                               itemsKey.
257     24 bytes   items_key_nonce             Nonce wrapping itemsKey under
                                               itemsKey_wrap_key (§3.3).
281     64 bytes   enc_items_key               itemsKey (32 B) wrapped under
                                               itemsKey_wrap_key, followed by
                                               the 32-byte CTX commitment tag.
345     ...        future fields                Reserved for v0.1 revisions and
                                                v005 (additional credential
                                                wraps, epoch keys, etc.).
```

The KDF parameter block at offset 22 is the canonical encoding referenced in §4.3 and bound into both wrap AADs (§3.1). Tampering with any parameter byte invalidates the AEAD tag on `enc_root_key_password` and `enc_root_key_recovery`.

The two encrypted root_key copies (`enc_root_key_password`, `enc_root_key_recovery`) hold the same 32-byte plaintext under independent wrap keys. Either is sufficient to unlock the vault.

Only `vault.meta` and the `.myn` files leave the device in any future sync scenario. Both are opaque ciphertext + a small public header (magic, version, IDs, nonces, salts, account-hash). No plaintext note content, no plaintext titles, no plaintext recovery-phrase material is ever stored.

### 9.4 What is in plaintext on disk and why

- **Magic bytes (`MY01`, `MYV1`)** — identify the file format for parsing. They reveal "this is a Myne file" to anyone with disk access; this is accepted for v0.1 because at-rest encryption is a defense against an attacker reading file contents, not against an attacker enumerating which application produced a file. The user already chose to install Myne; that fact is not the secret.
- **Protocol version byte** — required for forward-compat parsing; cannot be encrypted because the parser must read it before any key is derived.
- **Reserved bytes** — anchor for future flags without re-version.
- **`items_key_id`, salt, nonces** — public by construction in any AEAD scheme; these are not secrets.
- **`account_number_hash`** — required to derive the salt; revealing it gives an attacker the same precomputation difficulty as the user has, no easier.
- **UUIDv7 file names** — note count and approximate creation times leak. v005 may switch to UUIDv4 if even this is unacceptable.

### 9.5 Vault preferences blob (`vault.prefs`)

`vault.prefs` is a vault-level singleton artifact carrying user-configurable preferences (e.g., the screen-capture-protection toggle of `../threat-model.md` §6). It lives next to `vault.meta` at `<vault-root>/vault.prefs` and is AEAD-encrypted under a `root_key`-derived KEK. The outer envelope follows the same fixed-offset binary discipline as §9.2 and §9.3; the inner plaintext is JSON to keep schema evolution within a major version trivial (additive optional fields), while the outer envelope itself follows the no-JSON-envelope discipline of the rest of §9.

#### 9.5.1 Outer envelope layout

All multi-byte integers are big-endian.

```
Offset  Size       Field                Description
------  ---------  -------------------  ---------------------------------------
0       4 bytes    magic                ASCII "MYP1"
4       1 byte     protocol_version     0x01 for this specification
5       1 byte     reserved             MUST be 0x00; non-zero rejects parse
6       24 bytes   prefs_nonce          192-bit random nonce used to encrypt the
                                        inner plaintext under prefs_key.
30      4 bytes    ciphertext_len       Length M = plaintext_len + 32 of the
                                        inner ciphertext followed by the
                                        32-byte CTX commitment tag T'.
34      M bytes    ciphertext           Inner plaintext (§9.5.2),
                                        AEAD-encrypted under prefs_key with
                                        prefs_nonce, followed by the 32-byte
                                        CTX commitment tag T' (§5.1). The AAD
                                        binding is defined in §9.5.3.
```

The KEK is `prefs_key = DeriveSubkey(root_key, "prefs-key")` per §3.2 + §3.4. Because `prefs_key` is derived deterministically from `root_key` (which any unlocked client already has in memory) and no per-blob identifier is required to select it, no public `prefs_key_id` field appears in the header. This keeps the outer envelope minimal (34 bytes header vs §9.2's 50-byte fixed prefix) and faithful to the "plaintext on disk only when functionally required" discipline of §9.4.

#### 9.5.2 Inner plaintext schema

The inner plaintext is **canonical JSON** of an object whose keys are preference names and whose values are the persisted preference data. v0.1 ships twelve fields — `auto_lock_seconds` (integer, optional, MYND-121), `daily_date_format` (string, optional, MYND-191), `daily_folder` (string, optional, MYND-191), `daily_template` (string, optional, MYND-191), `deliberate_folders` (string array, set semantics, MYND-144), `editor_layout` (nested object, optional, MYND-137), `favorites` (string array, sequence semantics, MYND-183), `folder_icons` (nested object, optional, MYND-185), `item_colors` (nested object, optional, MYND-184), `item_order` (string array, sequence semantics, MYND-183), `screen_capture_protection` (bool), and `theme` (string, optional, MYND-110). Optional fields are **omitted entirely when unset** (`auto_lock_seconds` when the user has no stored timeout; the three `daily_*` fields when the user has not customized that daily-notes preference; `editor_layout` when the user never customized the sidebar layout; the three arrays when empty; the two decoration maps (`folder_icons`, `item_colors`) when empty; `theme` when the user made no explicit choice, i.e. follows the OS), so a vault that configured none encodes to the single-field form:

```json
{"screen_capture_protection":true}
```

A vault with every field encodes every key (lexicographically sorted — `auto_lock_seconds` precedes `daily_date_format` precedes `daily_folder` precedes `daily_template` precedes `deliberate_folders` precedes `editor_layout` precedes `favorites` precedes `folder_icons` precedes `item_colors` precedes `item_order` precedes `screen_capture_protection` precedes `theme`):

```json
{"auto_lock_seconds":300,"daily_date_format":"YYYY-MM-DD","daily_folder":"Daily/","daily_template":"0190…0003","deliberate_folders":["Archive/2025/","Projects/Myne/"],"editor_layout":{"left_collapsed":false,"left_width":312,"right_collapsed":true,"right_width":288},"favorites":["0190…0002"],"folder_icons":{"Archive/2025/":"archive","Projects/Myne/":"book"},"item_colors":{"0190…0001":"moss","Projects/Myne/":"slate"},"item_order":["0190…0002","Projects/Myne/","0190…0001","Archive/2025/"],"screen_capture_protection":true,"theme":"dark"}
```

The `item_order` example interleaves note UUIDs and folder paths in one flat list — `0190…0002` (a note), then `Projects/Myne/` (a folder), then `0190…0001` (a note), then `Archive/2025/` (a folder) — demonstrating that a single sequence expresses notes and folders ordered freely against each other.

**Canonical encoding rules** (load-bearing for cross-implementation byte-stability and for the byte-stable golden vectors in `myne-test-vectors`):

- Object keys MUST be encoded in lexicographic (Unicode-code-point) order.
- No insignificant whitespace — no spaces around `:` or `,`, no leading/trailing whitespace, no newlines.
- String values MUST be UTF-8 normalized to NFC before encoding.
- Integer values MUST be encoded without a trailing `.0`.
- Floating-point values are FORBIDDEN in v0.1. Implementations MUST reject schemas that introduce float-typed preference fields until a future minor revision specifies a deterministic float encoding.
- Booleans, integers, strings, **string arrays**, and nested objects following the same rules are the only permitted v0.1 value types. A string array is encoded `["a","b"]` with no insignificant whitespace; each element follows the string rules above (NFC, plus RFC 8259 escaping of `"`, `\`, and C0 control characters — canonical lowercase `\u00XX` for unnamed controls; `/` left unescaped). A string array carries one of two element-ordering disciplines, fixed per field: a **set** array (`deliberate_folders`) is sorted + exact-deduped (the element set is the value, order is not); a **sequence** array (`item_order`, `favorites`) preserves element order verbatim (the order *is* the value) and is neither sorted nor deduped. Both are deterministic given the same logical value, which is all the byte-stability requirement demands.

**`auto_lock_seconds` field (MYND-121).** An optional non-negative integer — the user's chosen auto-lock-on-idle timeout in seconds. **Omitted entirely when unset**, so a vault that never configured auto-lock is byte-identical to a pre-MYND-121 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find the key MUST treat it as unset; the client then applies its protective-envelope default. Per the general canonical-encoding rules above, the value is a bare decimal integer (no leading zeros, no trailing `.0`); **floating-point is FORBIDDEN** and a fractional value rejects the parse. Crucially, the always-on flag and the code-enforced `AUTO_LOCK_CEILING` that clamp this value are **NOT** stored in `vault.prefs` — they live in the client implementation, so a replayed, deleted, or tampered `vault.prefs` can only make auto-lock *stricter*, never disable it or loosen it past the ceiling (the two-class prefs taxonomy of [`../threat-model.md`](../threat-model.md) §7).

**`daily_date_format` / `daily_folder` / `daily_template` fields (MYND-191).** Three optional string fields configuring the daily-notes feature (the bounded plain-markdown-skeleton + date-navigation feature; see `../decisions.md`). `daily_date_format` is the date-format string for a daily note's title (e.g. `YYYY-MM-DD`); `daily_folder` is the canonical trailing-slash folder path daily notes are filed under (e.g. `Daily/`); `daily_template` is the UUIDv7 of a template note (a `template: true` `.myn`) to instantiate today's note from. Each is **NFC-normalized** and **omitted entirely when unset**, so a vault that configured no daily-notes preference is byte-identical to a pre-MYND-191 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find a key MUST treat it as unset; the client then applies its canonical defaults host-side (`daily_folder` ≡ `Daily/`, `daily_date_format` ≡ `YYYY-MM-DD`, `daily_template` ≡ none → a blank daily note titled with the date). All three are **non-load-bearing** (cold/derivable, AS-low): a replayed or tampered `vault.prefs` can at worst point the daily note at the wrong folder/template or format its title differently — so, like `theme`, they carry **no** protective-envelope clamp. They sort canonically between `auto_lock_seconds` and `deliberate_folders` (`daily_date_format` < `daily_folder` < `daily_template`). Conflict semantics for Phase 2 sync are deferred (last-writer-wins). Designating a `daily_folder` also adds it to `deliberate_folders` (client-side) so the folder survives empty.

**`deliberate_folders` field (MYND-144).** A JSON array of canonical trailing-slash folder paths (e.g. `["Projects/", "Projects/Myne/"]`) — the carrier for deliberately-created folders that hold no note (the empty-folder case of the virtual-folder model; see [`markdown-dialect.md`](markdown-dialect.md) §3.6.2). Canonical array encoding: elements are **NFC-normalized**, **lexicographically sorted** by their NFC bytes, and **exact-deduplicated** (folded-identity/case-insensitive dedup is the set-management layer's job, not the codec's). The array is **omitted entirely when empty**, so a vault with no deliberate folders is byte-identical to a pre-MYND-144 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find the key MUST treat it as the empty list. Conflict semantics for Phase 2 sync = union + add-wins (set semantics; no wall-clock, AS6-safe).

**`item_order` field (unified manual sidebar order, MYND-183).** A single **sequence**-semantics string array carrying the user's manual order across the unified sidebar file-tree — a flat, heterogeneous list whose elements are either note UUIDs or canonical trailing-slash folder display paths, **discriminated by the trailing `/`** (a folder path ends in `/`; a note UUID does not). The client sorts the children of every container (the root, and each folder) — sub-folders and notes **together, freely interleaved** — by each child's index in this one list, with children absent from the list sorting after all listed siblings (notes by `updated:` descending, folders by folded name). Container membership is **structural, not encoded in the list** (a note's container is its `folder:` frontmatter; a folder's container is its parent path), so a single flat list expresses recursive interleaving at every level: each container reads only the indices of its own children. Canonical array encoding: each element is **NFC-normalized**, and **order is preserved verbatim** — the array is **NOT sorted and NOT deduplicated** (contrast `deliberate_folders`; the sequence is the payload). **Omitted entirely when empty**, so a vault that never reordered is byte-identical to one without the key; a decoder that does not find it MUST treat it as the empty list. AS3-Sensitive (note IDs + folder structure); rides inside the AEAD-encrypted blob like every other field. The 64 KiB `MAX_PREFS_PLAINTEXT_LEN` cap (§9.5.4) bounds the practical number of explicitly-ordered items; beyond it a reorder write fails and the client falls back to the recency/name sort (a soft, recoverable degradation, not data loss). `item_order` **supersedes** the separate `note_order` / `folder_order` arrays of the pre-MYND-183 schema (see the schema-evolution note below and `../decisions.md`). Conflict semantics for Phase 2 sync are deferred (last-writer-wins on the whole sequence is the likely shape; no per-element merge in v0.1).

**`favorites` field (MYND-183).** A **sequence**-semantics string array of **note UUIDs only** — the user's favorited notes, in display order, surfaced in a dedicated Favorites section pinned above the sidebar tree. A favorited note ALSO keeps its normal position in the tree (favoriting is a shortcut, not a move). Same canonical encoding as `item_order`: each element **NFC-normalized**, **order preserved verbatim**, **NOT sorted and NOT deduplicated**. **Omitted entirely when empty**, so a vault with no favorites is byte-identical to one without the key; a decoder that does not find it MUST treat it as the empty list. A favorite UUID with no live note is ignored by the client at render time and pruned on the next write — there is no codec-level garbage collection. AS3-Sensitive (note IDs); rides inside the AEAD-encrypted blob. Conflict semantics for Phase 2 sync are deferred (last-writer-wins on the whole sequence).

**`editor_layout` field (MYND-137).** An optional nested object carrying the editor's three-pane sidebar layout — `left_width` and `right_width` (non-negative integer pixels, the *last non-collapsed* width) and `left_collapsed` / `right_collapsed` (booleans). The four nested keys are themselves emitted in canonical (lexicographic) order: `left_collapsed`, `left_width`, `right_collapsed`, `right_width`. The whole object is **omitted entirely when unset** — i.e. when the user has never resized or collapsed a sidebar — so a vault that never touched the layout is byte-identical to a pre-MYND-137 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find the key MUST treat the layout as uncustomized and apply its own default widths. Widths are bare decimal integers (no leading zeros, no trailing `.0`); **floating-point is FORBIDDEN** and a fractional width rejects the parse. The min/max width clamps and the collapse policy are **NOT** stored here — they live in the client, so a replayed or tampered `vault.prefs` is re-clamped into the client's valid range on read (it cannot drive the UI to an unusable state). This field is AS-low (window-layout metadata only — no note content, no folder structure) yet still rides inside the AEAD-encrypted blob like every other field. Conflict semantics for Phase 2 sync are deferred (last-writer-wins on the whole object is the likely shape; no per-key merge in v0.1).

**`theme` field (MYND-110).** An optional string carrying the user's explicit theme choice — `"light"` or `"dark"`. **Absence of the key is the canonical encoding of "system"** (follow the OS `prefers-color-scheme`): there is no `"system"` value, so a vault that made no explicit choice **omits the field entirely** and is byte-identical to a pre-MYND-110 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find the key MUST treat the preference as "system"; the client then follows the OS. The field is canonical key **last** (`theme` sorts after `screen_capture_protection`). A decoder reading an **unrecognized** string value (a hypothetical future `"sepia"`) MUST treat it as "system" — an unknown value is tolerated like an unknown field, **never** a parse failure, because `theme` is **non-load-bearing**: it is a cosmetic UI preference (AS-low), carries **no** protective-envelope clamp (unlike `auto_lock_seconds`), and a tampered or replayed `vault.prefs` can at worst surface the wrong color. The theme choice rides inside the AEAD-encrypted blob like every other field rather than in a plaintext config — a plaintext theme token would leak a behavior fingerprint at rest, the same structural-privacy argument that keeps `auto_lock_seconds` encrypted. Conflict semantics for Phase 2 sync are deferred (last-writer-wins; the choice syncs with the vault).

**`folder_icons` field (MYND-185).** An optional nested object mapping a canonical trailing-slash folder path to an icon name — the user's custom sidebar icon for that folder, replacing the default folder glyph. Keys are folder paths (**NFC-normalized**, emitted in **lexicographic** order); values are names drawn from a curated client-side stroke-glyph set (**no** arbitrary or uploaded icon, **no** emoji). The object is **omitted entirely when empty**, so a vault that assigned no folder icon is byte-identical to a pre-MYND-185 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find the key MUST treat it as the empty map; an entry whose folder no longer exists, or whose value names an unknown icon, is ignored by the client at render time and pruned on the next write — there is no codec-level garbage collection. On folder rename/move the client **prefix-rewrites** the affected keys, and on folder delete it **prunes** them (the same `deliberate_folders` path-rewrite discipline). AS3-Sensitive (folder structure); rides inside the AEAD-encrypted blob like every other field. **Non-load-bearing** (cosmetic, AS-low): like `theme`, it carries **no** protective-envelope clamp and a tampered or replayed `vault.prefs` can at worst surface the wrong glyph. Conflict semantics for Phase 2 sync are deferred (last-writer-wins).

**`item_colors` field (MYND-184).** An optional nested object mapping a sidebar item — a note UUID **or** a canonical trailing-slash folder path, **discriminated by the trailing `/`** exactly as `item_order` discriminates its elements — to a color-slot name, the user's color label for that note or folder (rendered as a small dot). Keys (**NFC-normalized**, emitted in **lexicographic** order) are heterogeneous note-IDs and folder paths in one map; values name a fixed, bounded, theme-aware palette of color slots (**no** arbitrary hex). The object is **omitted entirely when empty**, so a vault that assigned no color is byte-identical to a pre-MYND-184 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find the key MUST treat it as the empty map; an entry whose note/folder no longer exists, or whose value names an unknown slot, is ignored at render time and pruned on the next write. A **note**-keyed entry is stable across note rename/move (the UUID is the filename); a **folder**-keyed entry is prefix-rewritten on folder rename/move and pruned on folder delete (the `deliberate_folders` discipline). AS3-Sensitive (note IDs + folder structure); rides inside the AEAD-encrypted blob. **Non-load-bearing** (cosmetic, AS-low): no protective-envelope clamp; a tampered or replayed `vault.prefs` can at worst surface the wrong color. Conflict semantics for Phase 2 sync are deferred (last-writer-wins).

**Schema evolution within v0.1:** Additive — new fields MAY be appended in any v0.1.x minor revision and are read by older v0.1 clients as unknown-and-ignored (per the implementation's serde discipline; older clients SHOULD NOT reject unknown fields). The MYND-110 `theme` field is the textbook additive case: a new optional key whose absence the older client already treats as a default, with the omit-when-unset rule keeping pre-`theme` vaults byte-identical. The MYND-185 `folder_icons` and MYND-184 `item_colors` maps are further textbook additive cases — new optional keys, omit-when-empty, unknown-and-ignored by older clients. Field removal, type changes, and structural restructuring are MAJOR-version events (MYP5). The MYND-183 replacement of `note_order` / `folder_order` with the unified `item_order` is **not** such an event: it is a **pre-release redefinition** of the v0.1 schema, made while Myne is pre-alpha with no shipped vaults — there is no frozen on-disk format to break, so no migration and no major-version bump apply. Performed post-freeze, the same field swap *would* require MYP5; the exception holds only because no v0.1 vault exists in the wild yet (see `../decisions.md`).

#### 9.5.3 AAD construction

`AAD_prefs_blob` is defined in §5.2:

```
AAD_prefs_blob =
  AAD_prefix || protocol_version (1 B) || "prefs-blob" || account_number_hash (16 B)
```

`"prefs-blob"` is length-prefixed UTF-8 per §5.2's length-prefix discipline (2-B big-endian length + 10 ASCII bytes, total 12 bytes). `account_number_hash` is the same 16-byte field stored in `vault.meta` (§9.3 offset 6); binding it into the AAD makes `vault.prefs` non-portable across vaults at the AEAD-verification layer in addition to the implicit per-vault `root_key`-derived `prefs_key` binding.

Total AAD length: `10 + 1 + 12 + 16 = 39 bytes`.

#### 9.5.4 Size cap and parsing discipline

Implementations SHOULD reject `ciphertext_len > 65536 + 32` (64 KiB plaintext cap + 32-byte CTX commitment tag). The cap exists to bound the parser's pre-AEAD allocation footprint, parallel to the §9.2 `.myn` cap rationale (`../decisions.md` 2026-05-06 entry). v0.1 preferences are bounded to a handful of small typed fields; 64 KiB provides ~13× headroom over any realistic preference set.

The reserved byte at offset 5 MUST be `0x00`. Non-zero values reject the parse, matching the §9.2 and §9.3 discipline. The byte is reserved for v0.1 minor-revision flag carrying.

#### 9.5.5 Migration-less semantic

Reading `vault.prefs` returns the persisted preference set on success, or the **default preference set** on any failure:

- File absent on disk → defaults.
- File truncated or magic-byte mismatch or non-zero reserved byte → defaults.
- AEAD verification failure (tampered ciphertext, wrong AAD, wrong `prefs_key`) → defaults.
- Inner JSON parse failure after a successful AEAD verification → defaults.

This collapses the absence case and the tamper case under a single user-visible behavior (defaults applied), matching the §6.4 non-distinguishing-error discipline. An attacker with disk-write access can therefore only revert preferences to defaults by deleting or tampering the file; arbitrary state injection requires breaking the AEAD, which the security analysis of §6.4 already covers. The local-prefs-replay vector (an attacker restoring a prior valid `vault.prefs` snapshot) is documented as a v0.1 best-effort known limitation in `../threat-model.md` §7.

Cross-vault attack: a `vault.prefs` from vault A placed in vault B's directory fails AEAD verification under vault B's `prefs_key` (different `root_key`) and under vault B's `AAD_prefs_blob` (different `account_number_hash`). Both keys disagree by construction; the AAD binding is defense-in-depth.

A vault has no `vault.prefs` after creation if the implementation chose lazy first-write; recommended practice is eager-write at vault creation (writing `PrefsView::default()` immediately after the `vault.meta` commit) so that the closed invariant "vault.prefs exists for every post-MYND-160 vault" holds. The fall-back-to-defaults semantic above remains the canonical handling for legacy vaults and for any future recovery scenario where the file goes missing.

### 9.6 Search-index blob (`vault.search`)

`vault.search` is a vault-level singleton artifact carrying the **full-text search index** in encrypted form (MYND-29). It lives next to `vault.meta` and `vault.prefs` at `<vault-root>/vault.search` and is AEAD-encrypted under a `root_key`-derived KEK. Like `vault.prefs`, the outer envelope follows the fixed-offset binary discipline of §9.2 / §9.3 / §9.5; unlike `vault.prefs`, the inner plaintext is **opaque to this layer** — the protocol codec treats it as raw bytes that the desktop client assembles and parses.

The search index is **plaintext-derived, RAM-resident state**: built from decrypted note content while the vault is unlocked, queried in memory, and **zeroized on lock alongside the keys** (it is as sensitive as the open notes — [`../threat-model.md`](../threat-model.md) A6). `vault.search` is purely a **persistence cache** of that RAM state — it lets a warm unlock reload the index without decrypting every note. It is never the source of truth; the `.myn` files are. A missing, stale, or unreadable `vault.search` is always recoverable by rebuilding from the notes (§9.6.4).

#### 9.6.1 Outer envelope layout

All multi-byte integers are big-endian.

```
Offset  Size       Field                  Description
------  ---------  ---------------------  -------------------------------------
0       4 bytes    magic                  ASCII "MYS1"
4       1 byte     protocol_version       0x01 for this specification
5       1 byte     index_format_version   0x01 = the v0.1 inner-plaintext format
                                          (§9.6.2). Distinct from protocol_version:
                                          a future engine / serialization change
                                          bumps THIS byte so an old decoder rejects
                                          the blob and falls to rebuild (§9.6.4)
                                          rather than mis-parsing it.
6       24 bytes   search_nonce           192-bit random nonce used to encrypt the
                                          inner plaintext under search_index_key.
30      4 bytes    ciphertext_len         Length M = plaintext_len + 32 of the
                                          inner ciphertext followed by the 32-byte
                                          CTX commitment tag T'.
34      M bytes    ciphertext             Inner plaintext (§9.6.2), AEAD-encrypted
                                          under search_index_key with search_nonce,
                                          followed by the 32-byte CTX commitment tag
                                          T' (§5.1). AAD binding in §9.6.3.
```

The header is 34 bytes, identical in shape to `vault.prefs` (§9.5.1) except offset 5 carries `index_format_version` instead of a reserved byte — the search index, unlike a small typed preference set, has a serialization that may evolve independently of the protocol version. The KEK is `search_index_key = DeriveSubkey(root_key, "search-index-key")` per §3.2 + §3.4; as with `prefs_key`, no `search_index_key_id` field appears (it is selected deterministically from `root_key`).

Magic + `protocol_version` + `index_format_version` MUST all be checked **before** any decryption is attempted (the magic-byte-before-decrypt discipline of §9.2 / §9.3). A mismatch on any of the three rejects the blob and the client rebuilds (§9.6.4).

#### 9.6.2 Inner plaintext (engine-opaque snapshot)

The inner plaintext is an **`index_format_version`-tagged opaque payload**: this specification does NOT fix its internal structure, because the search engine is a client-implementation choice this layer must not constrain. For `index_format_version 0x01` the payload is a [postcard](https://docs.rs/postcard)-serialized snapshot of two parts:

1. a **staleness manifest** — a map `note_id → content_nonce` recording, for each indexed note, the `.myn` `content_nonce` (§9.2) observed when it was indexed; and
2. the **serialized inverted index** — the v0.1 custom BM25 inverted index (postings, per-document metadata, per-note detected language).

Both ride INSIDE the AEAD envelope by necessity: the manifest holds `note_id`s + `content_nonce`s, and the index holds plaintext-derived terms + titles — all confidential vault content (`note_id` / `content_nonce` are per-note correlation tags; terms/titles are note plaintext). None may appear in the cleartext header. Because the payload is engine-opaque, a v0.1 client that ships a different engine — or merely changes the serialization — bumps `index_format_version`; older decoders reject and rebuild.

> **Why postcard, not the canonical JSON of §9.5.2.** `vault.prefs` is a handful of small fields where JSON's schema-evolution ergonomics and byte-stable golden vectors matter. The search index is large (megabytes at 10k notes) and is never cross-validated field-by-field; the MYND-29 benchmark showed canonical JSON inflated the blob to ~5× the indexed text and dominated warm-unlock latency, whereas postcard (varint, no field names) holds it under ~1× text. The two blobs deliberately use different inner encodings (`../decisions.md` 2026-05-31 — "Encrypted search index").

#### 9.6.3 AAD construction

`AAD_search_index_blob` is defined in §5.2:

```
AAD_search_index_blob =
  AAD_prefix || protocol_version (1 B) || "search-index-blob" || account_number_hash (16 B)
```

`"search-index-blob"` is length-prefixed UTF-8 per §5.2's discipline (2-B big-endian length + 17 ASCII bytes, total 19 bytes). `account_number_hash` is the 16-byte field from `vault.meta` (§9.3 offset 6), binding the index blob to its specific vault. Total AAD length: `10 + 1 + 19 + 16 = 46 bytes`. As with `vault.prefs`, `items_key_id` is not bound — `search_index_key` derives from `root_key`, independent of the `itemsKey` lineage.

#### 9.6.4 Staleness detection, incremental reconcile, and fall-to-rebuild

`vault.search` is a cache and MAY be stale relative to the `.myn` files (it is flushed on graceful lock/quit + a periodic timer, but an idle auto-lock deliberately skips the flush — `../decisions.md` 2026-05-31 — so a few minutes' drift is normal). On unlock the client reconciles the loaded index against the current notes WITHOUT decrypting unchanged notes, using the **`content_nonce` as a decryption-free staleness signal**:

- The `.myn` `content_nonce` (§9.2) is regenerated on every save (a fresh random nonce per content encryption, §5.3) and is readable from the file header without decrypting the note (~136-byte header read).
- For each on-disk note: if its current `content_nonce` equals the manifest's recorded value → **unchanged**, skip (no decrypt). If it differs from, or is absent in, the manifest → **changed / new**, decrypt that note and re-index it. A note in the manifest but absent from disk → **deleted**, drop it.
- The reconciled result is identical to a full rebuild of the same corpus (this equivalence is the load-bearing correctness property: a diff bug must never silently produce a different index than a rebuild).

**Fall-to-rebuild** is the fallback when incremental reconcile is impossible or untrusted: `vault.search` absent, magic / version mismatch, AEAD verification failure, or an unreadable manifest. The client then rebuilds the index from scratch by decrypting every `.myn`. The `content_nonce` is NOT a security signal — it is only an optimization hint; a rebuild never trusts the cache. Because rebuild always recovers the correct index, `vault.search` carries no integrity-of-search burden: a disk attacker who deletes or corrupts it costs the user one slower unlock, nothing more.

#### 9.6.5 Residency, size cap, and fall-back semantic

**Residency.** The decrypted index is RAM-resident only while the vault is `Slot::Unlocked`. It is zeroized on the same path as the keys at **every** slot-drop site — manual lock, idle auto-lock, vault deletion, and the credential-rotation force-relock (an external `vault.meta` mutation detected mid-change drops the slot) — with terms, titles, and note ids overwritten before the backing allocations free. Manual lock/quit flush it to `vault.search` first (persist-then-wipe); idle auto-lock skips the flush (fail-closed — no blob-write latency on the idle path) and the next unlock rebuilds the missing delta. Nothing search-derived survives a lock.

**Size cap.** Implementations SHOULD reject `ciphertext_len > 268435456 + 32` (256 MiB plaintext cap + 32-byte CTX tag), bounding the parser's pre-AEAD allocation — parallel to the §9.2 / §9.5.4 cap rationale. The 256 MiB cap is well above the benchmarked 10k-note index and leaves generous headroom.

**Fall-back semantic.** Reading `vault.search` returns the loaded index on success, or triggers fall-to-rebuild (§9.6.4) on any failure — the non-distinguishing-error discipline of §6.4 / §9.5.5, applied to search. An attacker with disk-write access can only force a rebuild (a slower unlock); arbitrary index injection requires breaking the AEAD (§6.4). Cross-vault: a `vault.search` from vault A fails AEAD under vault B's `search_index_key` (different `root_key`) and `AAD_search_index_blob` (different `account_number_hash`).

**At-rest leakage.** The blob's size leaks a coarse signal about indexed vocabulary / total volume, analogous to the `.myn`-count leak — accepted for v0.1 ([`../threat-model.md`](../threat-model.md) A5 / §7).

## 10. Protocol Versioning & Migration

### 10.1 Design principle: forward-incompatible by design

> Myne protocol versions are **forward-incompatible by design**. Each major version (v0.1, v005, v006, …) is a complete, self-contained specification with distinct magic bytes, AAD domain prefix, and key-derivation contexts. Forward compatibility *within* a major version is permitted (v0.1.1 reads v0.1.0 blobs); cross-major compatibility is exclusively achieved through explicit migration. A vault encrypted under one major version cannot be opened by a client of another major version without invoking the migration procedure (§10.4). This design choice eliminates downgrade attacks by construction and permits each major version to be audited as a closed system.

This commitment is normative. Implementations MUST refuse to parse blobs that do not match their declared major version, and MUST present a migration prompt rather than attempt automatic cross-version reads.

### 10.2 Versioning conventions

- **Major versions** are identified by distinct magic bytes (`MY01`, `MYV1` for v0.1; `NT05`, `NTV5` for the future v005; etc.). They have distinct AAD prefixes (`"myne.v0.1|"`, `"myne.v005|"`) and distinct subkey context-string prefixes (`"myne.v0.1 …"`, `"myne.v005 …"`).
- **Minor versions** within a major version (v0.1.0, v0.1.1, …) share magic bytes and prefixes. They MAY add fields by appending after the last reserved offset, MUST NOT change existing fields, and MUST NOT reduce any existing security guarantee. The `protocol_version` byte (currently `0x01` for v0.1) is the single integer governing minor-version compatibility within v0.1; minor revisions encode minor-version information in the reserved byte at offset 5 of the per-note and `vault.meta` headers.
- **Patch revisions** (v0.1.1.1, …) are reserved for editorial fixes that do not change byte layout or semantics; they do not bump any byte in the file.

### 10.3 Major-version registry

This registry is normative. Implementations MUST reject any magic byte / AAD prefix / context prefix that is not in the registry and is not declared by a published successor specification.

| Major version | Per-note magic | Vault-meta magic | Vault-prefs magic | Vault-search magic | AAD prefix          | Context prefix         | Status |
|---|---|---|---|---|---|---|---|
| v0.1 | `MY01` | `MYV1` | `MYP1` | `MYS1` | `"myne.v0.1|"`  | `"myne.v0.1 …"`    | This document. Active. |
| v005 | `NT05` | `NTV5` | `MYP5` | `MYS5` | `"myne.v005|"` | `"myne.v005 …"`   | Reserved. See `protocol-v005-roadmap.md` (TBD). |

### 10.4 Migration procedure (cross-major)

Migration is **always explicit, always one-way, always client-side**. There is no implicit upgrade. The procedure for a v005 client encountering a v0.1 vault:

```
1. Detect:        Read magic bytes of vault.meta. If "MYV1", and the client is v005:
                  refuse to operate on the vault; surface a Migration prompt.
2. Confirm:       User explicitly approves migration. Display: "Migrating from
                  protocol v0.1 to v005. Recommended only after backup. Continue?"
3. Authenticate:  User enters master password (or recovery phrase). The v0.1
                  unlock procedure runs end-to-end and yields the v0.1 root_key
                  in client memory.
4. Re-derive:     A new v005 root_key is generated (random 32 bytes). v005's
                  key hierarchy is built from the new root_key per the v005
                  spec, using the user's existing password as input to v005's
                  KDF (which may differ from v0.1's Argon2id parameters).
5. Re-encrypt:    Each .myn file is decrypted under v0.1 keys and re-encrypted
                  under v005 keys with v005 magic bytes. The v005 client MAY
                  perform this lazily (per-note on first access) or eagerly
                  (bulk migration), at the user's choice.
6. Replace:       vault.meta is rewritten with v005 magic bytes and v005 layout,
                  containing the new root_key wrapped under both new credentials.
                  The old vault.meta and any unmigrated .myn files MAY be retained
                  as a `legacy/` snapshot until the user confirms migration is
                  complete, then deleted with cryptographic erase semantics.
7. Settle:        Migration is complete only when every .myn file has been
                  re-encrypted under v005 keys. Until then, the vault is in a
                  mixed state and the client MUST clearly indicate this.
```

The migration tool is itself part of the v005 client — there is no separate "migrator" binary. v0.1 clients never produce v005 output.

### 10.5 Anti-downgrade properties

Forward-incompatibility produces three structural anti-downgrade properties:

1. **Magic-byte separation**: a v005 client refuses to parse `MY01` blobs except via the migration flow; a v0.1 client refuses to parse `NT05` blobs at all. There is no protocol path that silently accepts the older format.
2. **AAD domain separation**: the AAD prefix `"myne.v0.1|"` is bound into every AEAD tag in v0.1. A v005 attacker who tries to forge a `NT05` blob with a `myne.v0.1` AAD fails AEAD verification; a v0.1 vault opened in a v005 client (during migration) carries its `myne.v0.1` AAD through to verification — the v005 client must use the v0.1 AAD format to succeed.
3. **Context-string separation**: subkey derivations under `"myne.v0.1 …"` produce different bytes than `"myne.v005 …"` even when the same root key, primitive, and parameters are used. Cross-version key substitution is computationally infeasible.

The `protocol_version` byte is included in the AAD (§5.2) for additional defense-in-depth: even within the v0.1 family, downgrade from a future minor version (v0.1.1) to v0.1.0 by stripping a feature flag would fail AEAD verification.

### 10.6 What v0.1 deliberately does NOT prepare for

To keep v0.1 a clean, auditable closed system, the following extension points are **not** built in:

- No capability bitfield, no feature negotiation byte, no "extension" frames. Adding capabilities later is a major-version event.
- No algorithm-agility headers. KDF, AEAD, and primitive choices are fixed by version. Migrating algorithms means migrating major version.
- No reserved expansion fields beyond the per-record reserved byte at offset 5. v005 is a new spec, not a v0.1 extension.

This stance directly contradicts the "additive" approach common in older protocols (TLS 1.0–1.2, OpenPGP). The lessons from those protocols' downgrade-attack history (POODLE, FREAK, Logjam, MEGA 2022) inform this design choice.

## 11. Out of Scope for v0.1

### 11.1 Server-authentication mechanism (Phase 2 decision, intentionally deferred)

The Phase 1 protocol derives a `server-auth` subkey (§3.4) from the user's `root_key`. v0.1 holds this material locally and never transmits it. Phase 2 introduces the sync server and forces a decision between two approaches; the choice is **deliberately deferred** to Phase 2 to avoid premature commitment under low information.

**Option A — Simple verifier (Standard Notes 004 style).** The client transmits the `server-auth` subkey to the server over TLS at registration. The server stores `Argon2id-server(server-auth, server_salt)` as a verifier and validates it on each authenticated request. A server-database compromise allows offline brute-force against the verifier. Note confidentiality is unaffected (notes are E2EE under `root_key`, which never leaves the client); a successful verifier crack only enables sync-entitlement abuse — free storage, request flooding, etc.

**Option B — OPAQUE aPAKE (RFC 9807).** Client and server run an augmented PAKE handshake. The server never sees a password verifier or hash; both parties end the handshake holding a session key derived through the OPRF. A server-database compromise yields material from which offline brute-force is infeasible.

**The decision will be made at Phase 2 start, not before.** Resolution criteria:

- OPAQUE library maturity in the Go and TypeScript ecosystems at Phase 2 start. Specifically: presence of a Cure53 or Trail of Bits audit on a candidate implementation; production deployments at credible scale.
- Self-host operator feedback. OPAQUE adds operator-side complexity. If the Phase 1 user base shows strong self-host intent, this raises the bar for Option B.
- Threat model evolution. If new evidence of partition-style or precomputation attacks against simple verifiers emerges between Phase 1 and Phase 2 ship, this raises the bar for Option A.

**v005 commitment.** The `appname-v005` roadmap canonicalizes Option B (OPAQUE). Option A in Phase 2 is therefore at most a transitional choice; v005 migration would convert any Option-A vaults to OPAQUE.

This deferral is itself a protocol commitment: implementations MUST NOT assume a Phase-2 server-auth decision in v0.1 code. The `server-auth` subkey is opaque material with no defined wire-level use until Phase 2.

### 11.2 Other items deliberately not addressed

Items deliberately not addressed by this specification. Each entry names where it lives instead.

| Item | Where it lives |
|---|---|
| Server-side authentication protocol (`serverPassword` is derived but not transmitted in v0.1) | Phase 2 sync server; `sync-protocol.md` (TBD) |
| Sync wire format, conflict resolution, version vectors | Phase 2; `sync-protocol.md` (TBD) |
| Cross-device synchronization of `vault.prefs` (carried alongside `vault.meta` + `notes/*.myn` as the v0.1 vault-artifact trio) | Phase 2; `sync-protocol.md` (TBD) |
| Multi-device coordination, device key management | Phase 2+; `appname-v005` adopts MLS; `protocol-v005-roadmap.md` (TBD) |
| Inter-user note sharing, prekey bundles, per-recipient wrapping | Phase 4+; `protocol-v005-roadmap.md` (TBD) |
| Real-time collaborative editing, CRDT integration | Phase 4+; `protocol-v005-roadmap.md` (TBD) |
| Post-quantum primitives (ML-KEM-768 hybrid wrap, ML-DSA signatures) | `appname-v005` |
| Group key agreement (MLS, RFC 9420) | `appname-v005` |
| Key Transparency (CONIKS / Trillian-based identity log) | `appname-v005` |
| OPAQUE aPAKE for server authentication | `appname-v005` |
| OHTTP relay/gateway transport, traffic-analysis defense | `appname-v005` |
| Anonymous credentials (KVAC, Privacy Pass) for sync entitlement | `appname-v005` |
| Plugin sandboxing, capability-scoped plugin API | Possibly never; `../vision.md` §what-myne-is-not |
| Attachment encryption, chunked AEAD, Merkle manifests | Phase 1.5 or later; future spec extension |
| Encrypted search index format (FTS5 inside encrypted SQLite) | Phase 1.5 or later; client-internal, not in this spec |
| Bidirectional links, graph view rendering | Out of scope for the cryptographic protocol; client UI concern |
| Mobile / WASM Argon2id parameter profile | Phase 3; this spec ships desktop-only |
| Metadata padding (PURB, Padmé) | `appname-v005` |
| Plausibly-deniable encryption, decoy passwords, duress codes | `appname-v005` and beyond |
| Hardware-backed unlock (WebAuthn-PRF, SE/TPM device key) | `appname-v005` |

This is not a deferral wishlist. Each item is either out of scope for the v0.1 cryptographic core or out of scope for the protocol entirely (UI, indexing, etc.). Items that are deferred to `appname-v005` are documented in the research roadmap, which also captures the user's reasoning for keeping each one out of v0.1.

The matching threat-model section (`../threat-model.md` §5 "NOT Protected Against") names what user-facing failure modes v0.1 does and does not defend against. This protocol spec is the architectural counterpart of that document.

## 12. Decisions Log

A snapshot of choices made during the v0.1 draft. Mirrored to `../decisions.md`.

**Resolved (v0.1)**

- **Doc strategy is Option C**: ship `protocol.md` v0.1 (this document) alongside a separate `protocol-v005-roadmap.md` (to be authored from the user's research). v0.1 is the implementation target; v005 is the long-term aspirational reference.
- **Subkey derivation pattern: `derive_key(root_key, context_string)` with context strings drawn from a registered table (§3.4)**. Adding a new subkey role in a minor revision does not require a protocol bump. Concrete primitive (HKDF-SHA-256 vs BLAKE3 derive_key) is `[DEFERRED]`.
- **Three-level note wrapping**: `itemsKey_wrap_key → itemsKey → item_key → plaintext`. Password rotation re-wraps a single 32-byte itemsKey; no per-note re-encryption.
- **Forward-compat reservation for v005 epoch keys**: the context-string registry reserves the prefix `"myne.v005 epoch-"`; the `items_key_id` field in v0.1 is structurally compatible with v005's epoch identifier. No epoch rotation in v0.1.
- **On-disk binary format with magic bytes**: per-note `MY01` (`.myn`), vault metadata `MYV1` (`vault.meta`). Big-endian integers, fixed offsets, no JSON envelope.
- **AAD construction with explicit version prefix `"myne.v0.1|"`** (TLS 1.3 §4.1.3 model). AAD includes `protocol_version`, `items_key_id`, `note_uuid`, and (for content) `content_type`. Cross-version substitution and downgrade attempts fail AEAD verification.
- **Architectural shift: `root_key` is a 32-byte random persistent value**, not derived from the password. Password derives `password_wrap_key` via Argon2id; that wraps a copy of `root_key`. Recovery phrase derives `recovery_wrap_key` via Argon2id; that wraps a second copy of `root_key`. Either credential is sufficient to unlock; both can be rotated independently.
- **BIP-39 phrase strengthens to `recovery_wrap_key` via Argon2id directly**, not via the BIP-39 standard PBKDF2-2048. Phrase is treated as a 256-bit-entropy encoding, not as wallet-ecosystem-compatible mnemonic.
- **Account number format**: 20-character Crockford base32 with a Damm-32 check digit, displayed as `MY-XXXX-XXXX-XXXX-XXXX-X`. Liberal parsing: prefix optional, separators stripped, case insensitive. Canonical form is uppercase 20 chars.
- **Account-number normalization for hashing**: NFKD + trim + strip prefix/separators + uppercase + length and Damm validation. Hash is `SHA-256(canonical)[:16]`.
- **Forward-incompatible major-version model**: each major version is a closed, complete spec with distinct magic bytes, AAD prefix, and context prefixes. Cross-major reads happen only via explicit migration. This eliminates downgrade attacks structurally and lets each version be audited independently.

**Resolved (post-draft)**

- **Argon2id parameters: middle-ground `m=256 MiB, t=3, p=2`, Argon2 1.3** (resolved 2026-04-26). Stored in `vault.meta` rather than hardcoded; bound into both wrap AADs to defeat parameter-downgrade tampering.
- **Subkey derivation: HKDF-SHA-256 with single canonical helper** (resolved 2026-04-26). libsodium-native, MLS-aligned for v005, audit history mature. The helper-only access pattern (§3.2.1) collapses BLAKE3's "structural context binding" advantage into a codebase-level discipline at no cost.
- **AEAD wrapper: XChaCha20-Poly1305 + CTX commitment with SHA-256 outer hash** (resolved 2026-04-26). Defends against partitioning-oracle attacks (Len–Grubbs–Ristenpart, USENIX 2021). Tag fields grow from 16 to 32 bytes on disk. Canonical encoding `K[32] || N[24] || len(AD)[4 BE] || AD || T[16]` eliminates concatenation ambiguity (Chan & Rogaway 2022).
- **Server-auth deliberately deferred to Phase 2 with intent declaration** (resolved 2026-04-26). v0.1 derives but does not use the `server-auth` subkey. Phase 2 will choose between Option A (simple verifier) and Option B (OPAQUE aPAKE) using criteria documented in §11.1. v005 canonicalizes OPAQUE; Option A in Phase 2 would be transitional only. This is not a decision dodge — it is a discipline of "decide at the right time, not the earliest time".
- **Stack realignment: Tauri (Rust core) + Vite + React + TypeScript UI for desktop** (resolved 2026-04-26; UI bundler refined the same day). Supersedes the prior `../decisions.md` Electron baseline. Crypto core in Rust (libsodium bindings + RustCrypto fallback). Server remains Go. Phase 3 mobile path (RN with Rust bridge vs Tauri Mobile) deferred to Phase 3 start. Phase 3 web client's bundler is deferred to Phase 3 start; shared React components will be extracted to a `packages/ui/` workspace member when that work begins, decoupling the desktop UI bundler from the web bundler. Trade: ~1–2 month delay to Phase 1 ship for Rust ramp-up; gains: structural memory hygiene (`zeroize`/`secrecy`/`subtle` crates), smaller TCB and binary, easier reproducible builds, audit-story upgrade, native MLS/PQ primitive availability for v005, ~10× smaller direct-npm-dependency surface vs Next.js.

**All deferred conflict-points resolved.** v0.1 specification is complete.

Each deferred item has a v0.1 baseline that is internally consistent with this spec and a research alternative documented in `appname-v005`. Resolving any of the two does not require changes to the rest of the protocol structure — only the parameter or primitive at the named call site.

**Open risks**

- **No formal verification model** (Tamarin / ProVerif) accompanies v0.1. The compensating-controls plan (`../threat-model.md` §6) is the v1.0 substitute. Formal verification is an `appname-v005` deliverable.
- **No external cryptographer review** has occurred at draft time. Plan: pre-launch informal review by at least one independent reviewer per `../threat-model.md` §6.
- **Migration tool from v0.1 to v005 has not been written**. The §10.4 procedure describes the intent; concrete code lands when v005 work begins.
- **Mobile parameter profile** for Argon2id is not specified in v0.1; the spec assumes desktop-class memory. Phase 3 must add a profile.
