# Myne Protocol Specification v0.1

> **Status: draft.** Phase 1 cryptographic protocol for the Myne desktop client. Targets single-user, single-device, local-only usage. Sync server, multi-device, and sharing are explicitly out of scope for v0.1 — see §11. Forward-compatibility hooks for a later major version's aspirational features are documented in §10.

---

## 1. Overview, Scope, Conventions

### 1.1 Scope

This specification defines the **at-rest** encryption protocol for notes stored on a user's local device by the Myne Phase 1 desktop client. It covers:

- Derivation of the root key from the user's master password.
- The key hierarchy from root key to per-note encryption keys.
- The format of an encrypted note blob on disk.
- The BIP39 recovery-phrase derivation that wraps the root key.
- The format of the user's account-number identifier (full details in `account-number.md`).
- The protocol-version-byte commitment that anchors forward-compatibility for a later major version.

Out of scope (see §11):
- Server-side authentication (`serverPassword` is derived in v0.1 but not transmitted).
- Sync wire protocol (Phase 2).
- Multi-device device-key management (Phase 2+).
- Inter-user sharing (Phase 4+).
- Real-time collaborative editing (Phase 4+).
- Post-quantum primitives (a later major version).
- Group key agreement (MLS) (a later major version).
- Key Transparency (a later major version).

### 1.2 Conventions

- The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are interpreted per RFC 2119.
- `||` denotes byte-string concatenation.
- `[:N]` denotes truncation to the first N bytes.
- `derive_key(root, ctx)` denotes a context-bound subkey derivation; the concrete primitive is **HKDF-SHA-256**, fixed in §3.2 (resolved 2026-04-26 — see §12), and the **calling pattern is fixed in this specification**.
- Context strings used in this specification all begin with the prefix `"myne.v0.1 "` (note: trailing space). This prefix domain-separates v0.1 from any future protocol version.

### 1.3 Protocol identifier

This specification is identified as **`myne-protocol-v0.1`**. The protocol version byte (§10.1) carries the value `0x01` for any blob produced under this specification.

---

## 2. Cryptographic Primitives

> **Conflict-points resolved.** The primitive choices below were flagged `[DEFERRED]` in the v0.1 draft: the baseline was the prior decision in `../decisions.md`, with the next major version's research as the alternative under consideration. They were resolved on 2026-04-26 and 2026-04-28 and are recorded in §12 "Resolved (post-draft)". The **baseline column carries the shipped primitive**; the second column is retained as the record of what was under review and when it was settled.

| Role | v0.1 baseline | `[DEFERRED]` alternative, and its resolution |
|---|---|---|
| KDF (password → root key) | **Argon2id `m=256 MiB (262 144 KiB), t=3, p=2`, Argon2 1.3** (§4.1) | (resolved 2026-04-26 — see §12; `m=1 GiB, t=2, p=4` from the next major version's research roadmap was the alternative under review, against the `m=64 MiB, t=5, p=1` Standard Notes 004 baseline) |
| Subkey derivation | **HKDF-SHA-256** with registered context strings via single canonical helper (§3.2) | (resolved 2026-04-26 — see §12) |
| AEAD | **XChaCha20-Poly1305 (RFC 8439 + extended-nonce variant) + CTX commitment, SHA-256 outer hash** (§5.1), 256-bit key, 192-bit random nonce, 32-byte tag on disk | (resolved 2026-04-26 — see §12; plain XChaCha20-Poly1305 with a 16-byte Poly1305 tag was the prior baseline, and §5.1 records why it is not shippable) |
| Recovery phrase | BIP-39 24 words (256-bit entropy), library `bip39` (rust-bitcoin, in the `protocol/` crate) | (no alternative under review) |
| Hashing | SHA-256 (RustCrypto `sha2` on every Myne client; libsodium / WebCrypto are byte-equivalent for an independent implementation) | BLAKE3 (resolved 2026-04-26 — see §12; it was the alternative under review in the next major version's research roadmap, and the canonical-helper discipline of §3.2.1 collapsed its structural-context-binding advantage) |
| RNG | OS CSPRNG (RustCrypto `getrandom` on every Myne client — via `crypto.getRandomValues` behind its `custom` backend in the browser; libsodium `randombytes_buf` for an independent implementation) | (no alternative under review) |

**Library.** Every Myne client runs **this repository's `protocol/` crate** on the **RustCrypto stack** — `hkdf` (RFC 5869), `argon2` (RFC 9106), `chacha20` + `poly1305` composed to XChaCha20-Poly1305 (RFC 8439 + extended-nonce variant, cross-checked against `chacha20poly1305`), `sha2`, with `subtle` for constant-time comparison, `zeroize` for memory hygiene and `getrandom` for OS CSPRNG. The crate is `#![no_std]` + `extern crate alloc;`, which is what lets all three clients link the same code:

- **Desktop** links it directly (`src-tauri/Cargo.toml`).
- **Mobile** (iOS + Android) links the *same crate by path* from the in-repo `mobile/` client — `protocol = { path = "../../protocol" }`. Tauri 2 Mobile reuses it verbatim rather than binding a platform crypto library, so there is no second crypto codebase and no separate audit surface (`decisions.md` 2026-05-01).
- **Web** compiles it to `wasm32-unknown-unknown` (`web/wasm/Cargo.toml`), so the browser runs the same crate the desktop client runs — no JavaScript provider and no second implementation to keep in agreement. The measured cost of that choice is in §4.1 (`decisions.md` 2026-07-26).

The Go sync server implements none of this: it stores ciphertext and never derives a vault key, and its only cryptography is the SCRAM-SHA-256 handshake over Go's standard library (`crypto/pbkdf2`, `crypto/hmac`, `crypto/sha256`, `crypto/subtle`). It declares no third-party cryptographic dependency at all.

**No Myne client links libsodium** — `decisions.md` 2026-04-28 supersedes the earlier libsodium-bindings clause by name, and no client has reintroduced it since. That is a statement about *Myne's own clients*, not about the format: **an independent implementation MAY use libsodium, libsodium-js, WebCrypto, `golang.org/x/crypto` or any other library implementing the same RFCs, and will get byte-identical results** — RustCrypto and libsodium emit identical bytes for the same inputs because both implement the published RFCs and the CTX commitment construction (§5.1) is a thin SHA-256 wrapper on top. That equivalence is what the `myne-test-vectors/` companion repo validates. **No custom primitive implementations on any client.**

The `chacha20poly1305` RustCrypto crate received an NCC Group audit (Feb 2020, no significant findings); `vodozemac` (Matrix Olm/Megolm in pure Rust on RustCrypto primitives) received a Least Authority audit (Mar 2022, no significant findings); `age`/`rage` ships exclusively on RustCrypto. These audit and prod-deployment evidences anchor the audit-substitute story (`../threat-model.md` §6) for the Rust side. See `../decisions.md` "2026-04-28 — Rust-side primitives: RustCrypto stack as primary".

The `[DEFERRED]` items above were resolved on 2026-04-26 and 2026-04-28, recorded in `../decisions.md` and summarized in §12 "Resolved (post-draft)". This v0.1 specification will be revised in place if a later decision changes the baseline.

---

## 3. Key Hierarchy

The hierarchy is structured to allow forward-compatible evolution toward a later major version without breaking changes. The structural commitment is the **derive_key-with-context** pattern: every subkey is produced by `derive_key(root_key, context_string)` with a context string drawn from the registry in §3.4. New subkey roles can be added in later protocol versions by registering new context strings, with no change to the root-derivation step.

### 3.1 Root key generation and credential wrapping

The root key is the cryptographic core of the vault. It is **a 32-byte random value generated by the OS CSPRNG at vault creation**, stored only as ciphertext on disk, and held in client memory only between unlock and lock. It is **not derived from the password**. This is essential to support a recovery flow — if the root key were a function of the password, losing the password would destroy the vault unconditionally.

Two independent credentials can unlock the vault: the **master password** and the **24-word BIP-39 recovery phrase** (§7). Each credential derives a wrap key via Argon2id with its own salt; each wrap key encrypts an independent copy of the same `root_key`. Both encrypted copies live in `vault.meta` (§9.3). Either credential alone is sufficient to recover the root key. If both are lost, the data is permanently unrecoverable.

This architecture also supports later credentials (e.g., a hardware-backed WebAuthn-PRF unlock in a later major version) by adding a third encrypted copy of `root_key` under a third wrap key, with no change to the rest of the protocol.

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
phrase_normalized = normalize_phrase(phrase_text)      ← §7.4 (NFKD + ASCII case fold + whitespace)

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

The concrete primitive is **HKDF-SHA-256** (RFC 5869). Myne's own clients reach it through the RustCrypto `hkdf` crate (§2); an independent implementation may use any RFC 5869 implementation — libsodium's `crypto_kdf_hkdf_sha256_*` API among them — and MUST produce the same bytes. For each subkey role:

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

The Go above is the language-neutral reference shape. Myne's own clients implement it once, in Rust — `protocol/src/subkey.rs`'s `derive_subkey(root_key, role: SubkeyRole)` over `hkdf::Hkdf<Sha256>`, with the underlying expand kept `pub(crate)` and the role taken from an enum rather than a free string, so the registry is enforced by the compiler. An independent implementation applies the same shape in its own language (a TypeScript one would wrap `@noble/hashes/hkdf` or libsodium-js). Code review MUST reject any direct call to `hkdf.expand` / `crypto_kdf_hkdf_sha256_expand` from outside this single helper.

This pattern collapses the BLAKE3 vs HKDF debate into a non-issue: BLAKE3 `derive_key`'s "structural context binding" advantage is that the context-string format is fixed by the API. With the helper above, Myne achieves the same property at the codebase level, while keeping HKDF-SHA-256 as the underlying primitive — which ships natively in every mainstream crypto library (RustCrypto and libsodium alike, so an independent implementation adds no dependency to follow this spec), is MLS-aligned (RFC 9420), and is already covered by published Tamarin / ProVerif / CryptoVerif models.

#### 3.2.2 Context-string canonical format

Every `info` value passed into `HKDF-Expand` for v0.1 subkey derivation MUST match the form:

```
info = "myne.v0.1 " || role
```

Where `role` is exactly the string from the registry (§3.4). The trailing space after `myne.v0.1` is part of the prefix. Both prefix and role are UTF-8 / ASCII; v0.1 uses ASCII-only role identifiers. Implementations MUST NOT add separators, length prefixes, or trailing null bytes — the `info` parameter is the literal concatenation above.

#### 3.2.3 Next-major forward-compatibility

The next major version will likely retain HKDF-SHA-256 because RFC 9420 MLS mandates it for the MLS key schedule; running two KDF primitives in one client doubles the audit surface for no benefit. The next major version will register its own context prefix (defined by that version, not pre-allocated in v0.1), so v0.1 and next-major subkey derivations cannot collide even when the same root key bytes appear.

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
2. **`itemsKey`** — a single 32-byte random key, generated once on vault initialization, persistent across password changes. Stored on disk as ciphertext under `itemsKey_wrap_key`. Neither re-wrapped nor regenerated when the password changes: `itemsKey_wrap_key` is derived from `root_key`, and a password change does not alter `root_key` (§3.1, §7.3).
3. **`item_key`** — a per-note 32-byte random key, generated when a note is created. Stored alongside that note's ciphertext, wrapped under the current `itemsKey`. The plaintext of the note is encrypted under `item_key` using the AEAD construction defined in §5.

**What a password change touches:** nothing in this hierarchy. `root_key` is a random per-vault value, not password-derived (§3.1), so a password change re-derives only `password_wrap_key` and rewrites `random_salt_password_16`, `nonce_password_wrap` and `enc_root_key_password` in `vault.meta` (§7.3, §9.3). `itemsKey_wrap_key` is derived from the unchanged `root_key`, so `enc_items_key`, every per-note `item_key` and every `.myn` ciphertext stay byte-identical; the recovery-side fields are preserved too, so the recovery phrase keeps unwrapping the same `root_key`. An already-unlocked session is unaffected — only the next unlock uses the new password-side wrap.

**Why three levels and not two:** not for password rotation, which a two-level `root_key → item_key` hierarchy would perform just as cheaply. The third level exists so that `itemsKey` can be rotated as a unit later: under the epoch-key model below, rotating one 32-byte key re-wraps one 64-byte `enc_item_key` per note and never the bulk ciphertext (§6.6), and the `items_key_id` bound into every blob's AAD (§5.2) is what lets blobs wrapped under different generations coexist and be told apart.

**Forward-compatibility for a later major version's epoch-key model.** The research roadmap (`protocol-next-roadmap.md`, to be written) describes per-epoch `itemsKey` rotation that gives notes forward secrecy: each `EK_e` is derived for an epoch, used to wrap a generation of `item_key` material, then deleted on rotation, after which the corresponding ciphertexts become unrecoverable. To allow this evolution without a wire-format break, the v0.1 context-string registry (§3.4) reserves room for future epoch-key derivations (the concrete context prefix is defined by the next major version, not pre-allocated in v0.1), and the per-note blob format (§9) carries an `itemsKey_id` field whose semantics extend cleanly from "the singleton v0.1 itemsKey" to "the later itemsKey for epoch e".

In v0.1, only the singleton `itemsKey` exists. There is no epoch rotation. The reservation is purely structural.

### 3.4 Subkey context-string registry (v0.1)

| Context string | Role | Phase 1 use |
|---|---|---|
| `"myne.v0.1 server-auth"` | Sync-server authentication material — the **SCRAM secret** (Phase 2) | Derived locally and held in memory between unlock and lock; **not transmitted in Phase 1** because no sync server exists. Its use was resolved at Phase 2 and is neither of the two options §11.1 weighed: it is the PBKDF2 input of the **SCRAM-SHA-256(-PLUS)** handshake, passed as the **raw 32 bytes**, so what reaches the server is verifier material (`StoredKey`/`ServerKey`) and never the subkey itself. Wire spec: `server-protocol.md` §3.1; canonicalized by `decisions.md` **2026-06-20**, which supersedes the deferral in §11.1. |
| `"myne.v0.1 itemsKey-wrap"` | KEK for the persistent itemsKey | Active (wraps itemsKey on disk). |
| `"myne.v0.1 backup-key"` | Sealed-backup derivation root — **reserved, not used** | **Not used in v0.1** (demoted 2026-06-10; previously "active when user exports a backup"). The v0.1 backup format (§9.11) is a verbatim ciphertext copy with no outer encryption layer: a `root_key`-derived seal would be circular for fresh-machine restore (the credential wraps live inside the backup's own `vault.meta`) and would forbid exporting while locked. The row is retained, like `server-auth`, so the context string stays allocated; a future sealed-backup variant would activate it. See `decisions.md` 2026-06-10. |
| `"myne.v0.1 prefs-key"` | KEK for `vault.prefs` blob (§9.5) | Active when `vault.prefs` is written. |
| `"myne.v0.1 search-index-key"` | KEK for `vault.search` blob (§9.6) | Active when `vault.search` is written (MYND-29). |
| `"myne.v0.1 session-state-key"` | KEK for the `vault.workspace` blob (§9.7, `MYW1`) | Active when `vault.workspace` is written (MYND-166). `root_key`-derived (itemsKey-independent), like prefs/search — so a saved pane layout survives a later epoch-rotation `itemsKey` evolution. Unchanged across the `0x01 → 0x02` inner-schema bump for named workspaces (§9.7.2); distinct from the AAD role string `"workspace-blob"` (§9.7.3). |
| `"myne.v0.1 vault-indices-key"` | KEK for `vault.indices` blob (§9.8) | Active when `vault.indices` is written (MYND-271; design MYND-31). `root_key`-derived (itemsKey-independent), like prefs/search/workspace. |
| `"myne.v0.1 attachments-catalog-key"` | KEK for `vault.attachments` catalog blob (§9.10) | Active when `vault.attachments` is written. |
| `"myne.v0.1 attachments-id-hmac"` | HMAC-SHA-256 key for content-addressed attachment-id derivation (§9.9) | Active when an attachment is imported. Keys the id over file plaintext; not a blob KEK. |
| `"myne.v0.1 personal-dictionary-key"` | KEK for `vault.dictionary` blob (§9.13) | Active when `vault.dictionary` is written (MYND-266). `root_key`-derived (itemsKey-independent), like prefs/search/workspace. |
| `"myne.v0.1 attachment-text-key"` | KEK for the per-attachment extracted-text blobs (§9.15, `MYE1`) | Active when an attachment's extracted text is cached (MYND-328). `root_key`-derived (itemsKey-independent), like prefs/search/workspace. One KEK for all attachment-text blobs; per-blob separation comes from the `attachment_id` AAD binding (§9.15.3). |
| `"myne.v0.1 ai-embeddings-key"` | KEK for `vault.embeddings` blob (§9.17, `MYR1`) | Active when `vault.embeddings` is written (MYND-453) — i.e. only when the runtime beta opt-in `ai_enabled` is on (AI ships in the default build as of `decisions.md` 2026-07-02; a `--no-default-features` build never writes it). `root_key`-derived (itemsKey-independent), like prefs/search/indices. |
| `"myne.v0.1 graph-layout-key"` | KEK for `vault.graph` blob (§9.19, `MYG1`) | Active when the knowledge-graph layout cache is written. `root_key`-derived (itemsKey-independent), like prefs/search/indices/embeddings. A rebuildable cache — never synced, never backed up. |
| `"myne.v0.1 vault-head-mac"` | HMAC-SHA-256 key for the sync **vault head** fork-consistency MAC (§9.16; full primitive in `sync-protocol.md`) — **placeholder, Phase 2** | Derived locally; **not used in Phase 1** (no sync server exists), exactly like `server-auth`. Keys the monotonic, git-like hash-DAG vault head that hardens multi-device sync against a malicious server (rollback / withholding / equivocation; TB5). The context string is **allocated now** so it stays stable and **activates when Phase 2 sync ships**. The device-local last-seen baseline (`vault.head-state`, `MYH1`, §9.16) re-verifies the head's own MAC under this **same** key — no second context. **HMAC-not-signature** is deliberate: single-user → all devices share `root_key` → a symmetric MAC suffices and stays in the closed RustCrypto primitive set (no Ed25519, no new dependency; `head_mac_key = DeriveSubkey(root_key, "vault-head-mac")`, used like `attachments-id-hmac`). See `sync-protocol.md` (MYND-416). |
| `"myne.v0.1 catalog-sync-id"` | Reserved sync blob-id for the `vault.attachments` catalog (Phase 2 sync; `sync-protocol.md` §8.1) — **not a KEK, not a MAC key** | Active when Phase 2 sync pushes/pulls the catalog (MYND-468). The catalog is a synced singleton outside the head manifest (`sync-protocol.md` §4.2), so it needs a deterministic, device-independent 16-byte identifier in the sync metadata plane: `catalog_sync_id = DeriveSubkey(root_key, "catalog-sync-id")[0..16]`. `root_key`-derived so every device computes the same id while the server cannot distinguish it from a note UUID (it is keyed pseudorandom bytes, not a recognizable sentinel). Like `attachments-id-hmac`, this derives an *identifier*, not key material — the catalog's KEK remains `attachments-catalog-key`. |
| `"myne.v0.1 prefs-sync-id"` | Reserved sync blob-id for `vault.prefs` (Phase 2 sync; `sync-protocol.md` §10.2.1) — **not a KEK, not a MAC key** | Active when Phase 2 sync pushes/pulls `vault.prefs` (MYND-478). Like the attachments catalog, `vault.prefs` is a synced singleton outside the head manifest (`sync-protocol.md` §4.2), so it needs a deterministic, device-independent 16-byte identifier in the sync metadata plane: `prefs_sync_id = DeriveSubkey(root_key, "prefs-sync-id")[0..16]`. `root_key`-derived so every device computes the same id while the server cannot distinguish it from a note UUID (keyed pseudorandom bytes, not a recognizable sentinel). Like `catalog-sync-id`, this derives an *identifier*, not key material — the prefs KEK remains `prefs-key`. |
| `"myne.v0.1 custom-themes-key"` | KEK for the `vault.themes` blob (§9.21) | Active when `vault.themes` is written (MYND-486). `root_key`-derived (itemsKey-independent), like prefs/search/workspace/dictionary — so a custom-theme palette survives a later epoch-rotation `itemsKey` evolution. |
| `"myne.v0.1 themes-sync-id"` | Reserved sync blob-id for `vault.themes` (Phase 2 sync; `sync-protocol.md` §10.2.2) — **not a KEK, not a MAC key** | Active when Phase 2 sync pushes/pulls `vault.themes` (MYND-486). Like `vault.prefs` and the attachments catalog, `vault.themes` is a synced singleton outside the head manifest (`sync-protocol.md` §4.2), so it needs a deterministic, device-independent 16-byte identifier in the sync metadata plane: `themes_sync_id = DeriveSubkey(root_key, "themes-sync-id")[0..16]`. `root_key`-derived so every device computes the same id while the server cannot distinguish it from a note UUID (keyed pseudorandom bytes, not a recognizable sentinel). Like `catalog-sync-id` / `prefs-sync-id`, this derives an *identifier*, not key material — the themes KEK remains `custom-themes-key`. |
| (future next-major contexts) | reserved | not derived in v0.1. |

New v0.1 context strings MAY be added in future revisions of this specification; all v0.1 context strings begin with `"myne.v0.1 "`, and the next major version's context strings use its own prefix, which is not pre-allocated in v0.1.

The **quick-unlock credential blob** (`vault.quickunlock`, §9.14) is deliberately **NOT** in this registry: its KEK is **not** a `DeriveSubkey(root_key, …)` subkey. Because the blob wraps `root_key` itself, a `root_key`-derived KEK would be circular; instead its wrap key is supplied by an external, hardware-bound provider (Apple Keychain biometric secret) or derived from a PIN (§9.14.2). The same holds for the two **device-local staging queues** — the pending-capture queue (`captures/<capture-id-hex>`, §9.18) and the share-import staging queue (`pending-shares/sealed/<share-id-hex>`, §9.20): both must be writable while the vault is locked and `root_key` is unavailable, so both are sealed under a device-local keychain/Keystore `wrap_key` rather than a registered subkey (§9.18.2, §9.20.2). What distinguishes these three is not merely the absence of a row — it is that their sealing key is supplied by an **external, device-bound provider** rather than derived from `root_key` at all. (Per-note blobs (§9.2) and attachment blobs (§9.9) have no row either, for an unrelated reason: their content keys descend from the registered `itemsKey-wrap` lineage rather than from a KEK of their own.) `vault.head-state` (§9.16) also has no row of its own, for a different reason — it is not AEAD-encrypted at all, and its integrity re-uses the registered `vault-head-mac` role. A family that *is* sealed under a `root_key`-derived KEK gets its row above in the same change that ships it.

The use of `server-auth` does not affect the v0.1 at-rest format or any blob produced under v0.1 — the subkey is derived but never written into a blob, and no v0.1 at-rest code reads it. A v0.1 vault opened by a Phase 2 client will still produce the same `server-auth` bytes deterministically; the Phase 2 sync layer (`server-protocol.md` §3.1) feeds them to SCRAM's PBKDF2.

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

This table is the v0.1 **baseline**, not the accepted range. A conforming vault MAY carry other cost values (§4.2); what bounds them is the normative range in §4.2.1.

Approximate cost: ~1 second on a 2024 desktop laptop, ~2–3 seconds on mid-tier mobile (Phase 3).

**Measured browser cost (Phase 3 web client).** These parameters were measured in a browser rather than estimated, because an unverified claim about the KDF is a claim about whether the client is usable at all. On **one Apple Silicon Mac (16 GB, 10 cores)**, deriving with `m=256 MiB, t=3, p=2` through this repository's `protocol` crate compiled to `wasm32-unknown-unknown` — the real production derivation path, not a JS reimplementation — took a median of **464 ms (Chrome 150)**, **558 ms (Safari 26.5.2)** and **680 ms (Firefox 153)**, against **412 ms native on the same machine**: a **1.13–1.65× wasm penalty**. No out-of-memory condition in any browser (wasm linear memory settled at 321 MiB, the 256 MiB block plus allocator overhead), and **all three browsers derived a byte-identical key**.

The machine is named deliberately: **the transferable figure is the ratio, not the milliseconds.** Absolute timings scale with whatever hardware the user has, exactly as the native figures above do; the 1.13–1.65× penalty is the part that carries to other machines. Mobile browsers are a separate matter — iOS Safari cannot allocate 256 MiB reliably, and these parameters are AAD-bound and read from `vault.meta`, so they cannot be lowered for a browser — nor by any other device that joins an existing vault (§4.2, §11.2).

These parameters are calibrated to provide **≥ 80 bits of effective security when combined with a password of ≥ 60 bits of entropy**. Users who select weaker passwords are protected primarily by their recovery phrase, which carries 256 bits of entropy independent of password choice. Implementations SHOULD enforce a minimum password strength (e.g., ≥ 12 characters, zxcvbn score ≥ 3, dictionary check) at signup; this is a UX-level responsibility, not a protocol-level mandate.

### 4.2 Parameters stored in `vault.meta`

The complete parameter set is stored in `vault.meta` (§9.3). Storing parameters per-vault — rather than hardcoding them in the client — has three consequences:

1. **Parameter upgrade applies to new vaults, not existing ones**: if hardware advances make stronger parameters affordable, a future minor revision MAY raise the baseline for **newly created** vaults with no format break — the client that creates a vault chooses its parameters, and every existing vault keeps the ones it was created under. **v0.1 defines no in-format upgrade for an existing vault, and a password change is not one.** The single 11-byte block at offset 22 is bound into *both* wrap AADs (§4.3), so re-parameterising a vault means re-sealing the recovery wrap as well — which needs `recovery_wrap_key`, i.e. the 24-word phrase, which the user does not hold during a password change. A password change therefore MUST rewrite `vault.meta` carrying the vault's existing parameter block byte-for-byte; a client that normalised it to the current default would leave the vault with a recovery wrap no phrase can open. The only flow where a client holds both credentials at once is the post-recovery password reset (§7.3); v0.1 does not define a re-parameterisation there either, and a client MUST NOT invent one. Raising an existing vault's cost at password-change time would require a separate parameter block per credential — a `vault.meta` layout change, i.e. a major version (§10.3, §11), not a minor revision.
2. **Per-vault calibration without forking the format**: the parameter set is a property of the **vault**, not of a device. A mobile-first vault MAY be created with reduced parameters where the device cannot afford 256 MiB — that choice is made once, at creation, and needs no format change. Every device that later joins the account **inherits** the parameters from the synced `vault.meta` and **MUST NOT** alter them: `vault.meta` travels under Phase 2 sync, and the KDF-parameter block is one of the invariants its merge validates rather than reconciles — a divergence is refused, never papered over (`sync-protocol.md` §10.3). A client that cannot afford the vault's parameters MUST refuse to derive and say so; refusing is a **client behaviour**, not a parameter profile (§11.2 states the same rule for the web client). The consequence is stated here rather than left to be inferred: a vault created at reduced cost keeps that cost on **every** device that later joins it, desktops included, and point 1 gives no way to raise it. A genuine per-device profile would need a second wrap slot with its own parameter block — a format change, out of scope for v0.1 (§11.2). What the protocol requires within a single vault is unchanged: the *two Argon2id call sites* use the same parameters. This MAY is bounded rather than open-ended: reduced parameters MUST stay inside the accepted cost range of §4.2.1, which is the envelope the still-open mobile profile (§11.2) has to land inside.
3. **Auditor transparency**: the parameters used to lock the vault are inspectable in `vault.meta` without running the client, supporting the compensating-controls plan in `../threat-model.md` §6.

#### 4.2.1 Accepted cost range (use-site client policy)

The MAY in point 2 is bounded. **Before invoking Argon2id on cost parameters read from a `vault.meta`, an implementation MUST reject the vault when those parameters fall outside the range below.** Rejection is a **structural** failure (`InvalidVaultMeta`-class) and MUST NOT be surfaced as a wrong-password or wrong-phrase signal — the non-distinguishing posture of §7.3 is unaffected by it.

| Bound | Range | What it is for |
|---|---|---|
| Cost floor | `kdf_m_kib × kdf_t ≥ 8192` (KiB-passes — e.g. 8 MiB at one pass) | A vault *created* at brute-forceable cost. The v0.1 baseline is 786 432 (256 MiB × 3 passes), so the floor sits ~96× below it. |
| Memory ceiling | `kdf_m_kib ≤ 4 194 304` (4 GiB) | A `vault.meta` declaring an allocation the client cannot afford. |
| Parallelism | `1 ≤ kdf_p ≤ 16` | Lane counts no legitimate profile uses; the wire field is a `uint8`, so the encoding admits up to 255. |

Three properties of this clause are deliberate.

**It binds the derivation site, not the parser.** §4.3 and §9.3 are the on-disk *encoding* contract, and a decoder that reads a well-formed 11-byte block MUST NOT reject it on cost grounds — cross-implementation encoding vectors legitimately carry sub-floor values, and rejecting them at parse time would make correct decoders non-conforming. The obligation attaches to the step that is about to spend memory and time on those numbers.

**The floor is a cost *area*, not a per-axis minimum.** The memory-by-passes product `kdf_m_kib × kdf_t` is monotone in real Argon2id work and neutral about how an implementation splits its budget between the two axes. A per-axis minimum on `kdf_t` would be actively wrong: RFC 9106's primary recommended profile is `t = 1` with large `m`, so a `kdf_t` floor would refuse a strong `t = 1, m = 2 GiB` vault while still admitting a weak `m = 8 MiB, t = 3` one.

**The ceiling is not redundant with §4.3.** AAD binding defends an *existing* vault against parameter mutation, but it is structurally incapable of covering the ceiling, because the memory is allocated **before** any tag can be verified. The exposure is largest for a joining device, which fetches `vault.meta` **pre-session** (`server-protocol.md` §3.1, `GET /vault.meta`) and would otherwise size an allocation from an answer whose authenticity it has established nothing about.

An implementation MAY enforce a **tighter** range than this one and MUST NOT enforce a looser one. Myne's clients do enforce tighter: a per-axis `kdf_m_kib ∈ [8 MiB, 4 GiB]`, `kdf_t ∈ [1, 16]`, `kdf_p ∈ [1, 16]`, with the web client narrowing the memory ceiling further to 1 GiB because a browser tab's address space is not a desktop's.

This range is a **compatibility commitment**, not a tunable. Raising the floor in a later v0.1 revision would refuse vaults that conformed when they were written, so it is a major-version event (§10) rather than a tightening.

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

The base AEAD is **XChaCha20-Poly1305** per RFC 8439 plus the extended-nonce variant. 256-bit key, 192-bit nonce drawn from the OS CSPRNG — RustCrypto `getrandom` in Myne's clients (§2), libsodium `randombytes_buf` or any equivalent OS-backed source in an independent implementation.

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

Both checks are folded into the single constant-time equality on `T'`. Implementations MUST use a constant-time comparator — RustCrypto `subtle`'s `ConstantTimeEq` in Myne's clients, libsodium `sodium_memcmp` or Go `crypto/subtle.ConstantTimeCompare` elsewhere — and MUST NOT short-circuit on early byte mismatches.

#### 5.1.4 Library availability

- Rust — **this is the path every Myne client takes** (§2; `protocol/src/aead.rs`): RustCrypto `chacha20` + `poly1305` composed by hand, because the high-level `chacha20poly1305` crate does not expose the Poly1305 tag separately from the integrity-checked decrypt path and CTX needs it separately; `sha2` for the outer hash; constant-time compare via `subtle::ConstantTimeEq`. The hand composition is cross-checked byte-for-byte against `chacha20poly1305::XChaCha20Poly1305` in the crate's test suite.
- Go: `golang.org/x/crypto/chacha20poly1305` for the AEAD; stdlib `crypto/sha256` for the outer hash; constant-time compare via `crypto/subtle.ConstantTimeCompare`. **Guidance for an independent Go implementation, not a description of Myne's sync server** — that server stores ciphertext and never performs this operation (§2).
- TypeScript / JS: libsodium-js `crypto_aead_xchacha20poly1305_ietf_encrypt_detached`; stdlib SubtleCrypto `digest("SHA-256", ...)` for the outer hash. **This line is guidance for an independent JavaScript implementation, not a description of Myne's own web client** — Myne's browser client reaches the AEAD through the `protocol/` crate compiled to wasm (§2), and uses no libsodium-js. The guidance stays because `docs/` is CC-BY-4.0 and a third-party implementer in JS needs it.

No new dependencies. The construction is ~30 lines in any of these languages.

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

AAD_wrap_attachment_key =
  AAD_prefix || protocol_version (1 B) || items_key_id (16 B) || attachment_id (32 B)

AAD_encrypt_attachment =
  AAD_prefix || protocol_version (1 B) || items_key_id (16 B) || attachment_id (32 B) || content_type

AAD_attachments_catalog =
  AAD_prefix || protocol_version (1 B) || "attachments-catalog" || account_number_hash (16 B)

AAD_ai_embeddings_blob =
  AAD_prefix || protocol_version (1 B) || "ai-embeddings-blob" || account_number_hash (16 B)
```

`AAD_wrap_items_key` is the AAD bound into the AEAD wrap of the singleton v0.1 `itemsKey` (`vault.meta` §9.3 offset 281). It is distinct from `AAD_wrap_item_key`, which binds the per-note `item_key` wrap and additionally carries the per-note UUID. The singleton `itemsKey` has no per-note UUID, so the AAD reduces accordingly.

`AAD_prefs_blob` is the AAD bound into the AEAD wrap of `vault.prefs` (§9.5). The `"prefs-blob"` role string is length-prefixed UTF-8 (2-B big-endian length + 10 ASCII bytes); `account_number_hash` is the 16-byte field from `vault.meta` (§9.3 offset 6) and binds the prefs blob to its specific vault. `items_key_id` is **not** bound — `vault.prefs` is independent of the `itemsKey` lineage because its KEK derives directly from `root_key` via `"myne.v0.1 prefs-key"` (§3.4), which preserves prefs portability across a later epoch-rotation `itemsKey` evolution.

`AAD_search_index_blob` is the AAD bound into the AEAD wrap of `vault.search` (§9.6), the encrypted search-index blob. It mirrors `AAD_prefs_blob` exactly, with the role string `"search-index-blob"` (length-prefixed UTF-8: 2-B big-endian length + 17 ASCII bytes) and the same 16-byte `account_number_hash` from `vault.meta` (§9.3 offset 6) binding the index blob to its specific vault. As with prefs, `items_key_id` is **not** bound: the search-index KEK derives directly from `root_key` via `"myne.v0.1 search-index-key"` (§3.4), independent of the `itemsKey` lineage.

`AAD_wrap_attachment_key` and `AAD_encrypt_attachment` are the two AADs of an attachment blob (`MYA1`, §9.9). They follow the `.myn` lineage pattern exactly: the attachment blob is wrapped under the vault `itemsKey`, so — unlike the `root_key`-derived prefs/search/catalog blobs — its AADs bind `items_key_id` (not `account_number_hash`), with the 32-byte `attachment_id` taking the structural place of `note_uuid` in `AAD_wrap_item_key` / `AAD_encrypt_content`. Binding `attachment_id` prevents substituting one attachment's blob for another within the same vault; `content_type` (the attachment's actual MIME, length-prefixed UTF-8) is bound into `AAD_encrypt_attachment` so a blob cannot be reinterpreted as a different content type at the AEAD layer. **It is bound as its UTF-8 NFC bytes.** NFC because that is already the form §9.10.2 mandates for the `vault.attachments` entry, and that entry is the only copy a decoder has — §9.9 carries no `content_type` of its own, so the sealer and the opener agree only if the sealer binds what the catalog will store. An implementation MUST normalize to NFC before building this AAD; sealing one form and cataloguing the other produces a blob that no implementation, including the one that wrote it, can ever open. This is a clarification of v0.1, not a revision of it: every `content_type` written to date is ASCII, for which NFC is the identity, so no existing blob and no existing test vector changes by a byte.

`AAD_attachments_catalog` is the AAD bound into the AEAD wrap of `vault.attachments` (`MYC1`, §9.10). It mirrors `AAD_prefs_blob`, with the role string `"attachments-catalog"` (length-prefixed UTF-8: 2-B big-endian length + 19 ASCII bytes) and the 16-byte `account_number_hash` binding the catalog to its vault. As with prefs and search, `items_key_id` is **not** bound: the catalog KEK derives directly from `root_key` via `"myne.v0.1 attachments-catalog-key"` (§3.4), independent of the `itemsKey` lineage.

`AAD_custom_themes_blob` is the AAD bound into the AEAD wrap of `vault.themes` (`MYT1`, §9.21), the encrypted custom-theme palette blob. It mirrors `AAD_prefs_blob` exactly, with the role string `"custom-themes-blob"` (length-prefixed UTF-8: 2-B big-endian length + 18 ASCII bytes) and the same 16-byte `account_number_hash` from `vault.meta` (§9.3 offset 6) binding the blob to its specific vault. As with prefs, search, and the dictionary, `items_key_id` is **not** bound: the themes KEK derives directly from `root_key` via `"myne.v0.1 custom-themes-key"` (§3.4), independent of the `itemsKey` lineage.

`AAD_ai_embeddings_blob` is the AAD bound into the AEAD wrap of `vault.embeddings` (`MYR1`, §9.17), the encrypted AI embedding index. It mirrors `AAD_search_index_blob` exactly, with the role string `"ai-embeddings-blob"` (length-prefixed UTF-8: 2-B big-endian length + 18 ASCII bytes, total 20 bytes) and the 16-byte `account_number_hash` from `vault.meta` (§9.3 offset 6) binding the index blob to its specific vault. As with prefs and search, `items_key_id` is **not** bound: the embeddings KEK derives directly from `root_key` via `"myne.v0.1 ai-embeddings-key"` (§3.4), independent of the `itemsKey` lineage. The model-identity tuple that invalidates the cache on a model / dimension / chunker change is carried **inside** the engine-opaque payload (§9.17.2), not in this AAD — matching the `vault.search` `extractor_version` precedent.

`AAD_pending_capture_blob` is the AAD bound into the AEAD seal of a pending-capture queue entry (`captures/<capture-id>`, `MYK1`, §9.18). It is the one blob AAD that binds **neither** `account_number_hash` **nor** `items_key_id`: the queue is written while the vault is locked and is vault-agnostic (§9.18), so it instead binds the per-entry `capture_id` (16 bytes, also the queue filename) after the role string `"pending-capture-blob"` (length-prefixed UTF-8: 2-B big-endian length + 20 ASCII bytes). Total AAD length: `10 + 1 + 22 + 16 = 49 bytes`. There is no `DeriveSubkey` role — the KEK is a device-local key held in the OS keychain, not `root_key`-derived (§9.18.2).

`AAD_vault_label_blob` is the AAD bound into the AEAD seal of the sealed label store (`vault.label`, `MYL1`, §9.22). Like `AAD_pending_capture_blob` it binds **neither** `account_number_hash` **nor** `items_key_id`, and it has no `DeriveSubkey` role, because its KEK is a **per-vault** device-local key held in the OS keychain rather than a `root_key` product (§9.22.2), and because the file belongs to a vault *directory* rather than to an account (one account can hold two vault directories on one device). It instead binds the 16-byte `vault_id` after the role string `"vault-label-blob"` (length-prefixed UTF-8: 2-B big-endian length + 16 ASCII bytes). Total AAD length: `10 + 1 + 18 + 16 = 45 bytes`. One property is stronger here than in §9.18/§9.20: the bound `vault_id` is the one the **reader expected**, not merely the one the blob's own header carries, so a sealed file moved between vault directories fails AEAD instead of relying on an implementer's comparison. §9.22.3 states that as a MUST.

`AAD_graph_layout_blob` is the AAD bound into the AEAD seal of `vault.graph` (`MYG1`, §9.19), the encrypted knowledge-graph layout cache. It mirrors `AAD_workspace_blob` exactly, with the role string `"graph-layout-blob"` (length-prefixed UTF-8: 2-B big-endian length + 17 ASCII bytes, total 19 bytes) and the 16-byte `account_number_hash` from `vault.meta` (§9.3 offset 6) binding the layout blob to its specific vault. Total AAD length: `10 + 1 + 19 + 16 = 46 bytes`. As with prefs/search/workspace, `items_key_id` is **not** bound: `graph_layout_key` derives directly from `root_key` via `"myne.v0.1 graph-layout-key"` (§3.4), independent of the `itemsKey` lineage.

**Length-prefix encoding for variable-width AAD fields.** All length-prefixed UTF-8 fields in this section and in §3.1 — the `password-wrap` and `recovery-wrap` role strings in `AAD_password_wrap` / `AAD_recovery_wrap`, and the `content_type` field in `AAD_encrypt_content` — are encoded as a **2-byte big-endian unsigned length** followed by the UTF-8 bytes. This matches the binary-format convention elsewhere in this spec (§9.2 reads `enc_item_key_len` as 2 bytes big-endian).

`content_type` in v0.1 is always `"text/markdown"`. The field is included so a later version can introduce attachments and other content types without breaking the AAD layout.

The `AAD_password_wrap` and `AAD_recovery_wrap` AADs (defined in §3.1) additionally carry the canonical KDF parameters block (§4.3), so any tampering with the stored Argon2id parameters invalidates the wrap.

The AAD bytes feed both into Poly1305's MAC computation (standard AEAD behavior) and into the CTX canonical encoding (§5.1.1). A successful decryption proves the encryptor committed to exactly these AAD bytes — downgrade, substitution, key-confusion, content-type-confusion, and KDF-parameter-tampering all fail the CTX commitment check.

### 5.3 Nonce policy

Nonces are 192-bit random values drawn from the OS CSPRNG immediately before each AEAD call. **Every AEAD nonce this specification defines is drawn that way, stored in the cleartext header of the blob it seals, and never reused under any key.** The rule binds `vault.meta` (§9.3) and every §10.3 blob family that seals data under AEAD — not only the per-note blob (§9.2), which is simply the first family this document specified. Two §10.3 families fall outside it because they carry no AEAD nonce at all: the backup container (`MYB1`, §9.11) introduces no cryptography of its own, and the device-local sync baseline (`MYH1`, §9.16) is not AEAD-encrypted. v0.1 uses no deterministic, counter, or input-derived nonces anywhere; deviation is a major-version event.

### 5.4 Constant-time comparison (general rule)

§5.1.3 states the requirement for the CTX commitment tag specifically. It is a general rule, and is stated here once so that every later verifier inherits it rather than each one needing its own clause:

**Every comparison of a MAC, an authentication tag, a key-derived verifier, a proof, a signature, or a bearer token MUST use a constant-time comparator, and MUST NOT short-circuit on an early byte mismatch.** RustCrypto `subtle`'s `ConstantTimeEq` in Myne's clients; libsodium `sodium_memcmp` or Go `crypto/subtle.ConstantTimeCompare` in an independent implementation.

The rule reaches beyond the at-rest format this document otherwise defines, because the values it covers do:

- the CTX commitment tag `T'` (§5.1.3) — the original statement, unchanged;
- the vault-head fork-consistency MAC (§9.16; `sync-protocol.md` §3);
- the SCRAM client proof and the **server signature** a client checks to authenticate the sync server (`server-protocol.md` §3.1). The server signature is the client's only evidence that the peer holds the account's `server-auth`-derived key; nothing downstream re-checks it;
- any device-local or cross-process **bearer token** — the per-device sync token, the browser-clipper pairing token (`threat-model.md` TB10).

The rule is about the comparison, not about what is being protected: it applies on paths whose only observable outcome is accept/reject, and it applies even where a transport (pinned TLS) or a one-shot nonce already makes an oracle expensive to mount. A comparator chosen per-site by whether the site "looks reachable" is how uncovered sites appear, which is the failure this clause exists to prevent.

Two comparisons deliberately fall **outside** it, and are ordinary equality by design: `items_key_id` (§6.4 step 2) and `protocol_version` / magic-byte header checks (§9.2, §9.3). These are public, unkeyed values readable from the blob header by anyone holding the file; comparing them in constant time would protect nothing.

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

The note's `note_uuid` and therefore its filename are unchanged by an update, so `AAD_wrap_item_key` and `AAD_encrypt_content` continue to commit to the same identity bytes across the note's lifetime. The persistence of `enc_item_key` is intentional: a later `itemsKey` rotation (§3.3) rewrites only this one 64-byte field per note, never the note ciphertext. A password change rewrites neither — it rotates only the password-side wrap of `root_key` (§7.3), leaving every `.myn` file byte-identical.

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

- **Protocol version and AAD prefix.** A next-major-version client's own AAD prefix will not verify a v0.1 blob's `"myne.v0.1|"` AAD; cross-major substitution fails by construction (§10.5).
- **itemsKey identity.** A `.myn` file from a different vault cannot be silently accepted: both AEAD AADs bind `items_key_id` and the §6.4 step-2 check additionally requires the id match the singleton recorded in `vault.meta`.
- **Note identity.** Renaming a `.myn` file (changing the UUID in its filename) without re-encrypting fails verification — `note_uuid` is bound into both `AAD_wrap_item_key` and `AAD_encrypt_content`.
- **Content type.** Attachment types added in a later version cannot be substituted into a v0.1 blob: `content_type` is bound into `AAD_encrypt_content` and any mismatch fails the CTX commitment check.

And what they do **not** prevent, stated here because the list above is otherwise read as exhaustive:

- **No freshness, and no completeness.** A successful decrypt proves the bytes are *this note, in this vault, under this protocol version*. It proves nothing about whether they are the note's **current** revision, and nothing about whether the note **set** is intact. Neither property is bound by anything in v0.1: the AADs carry no revision counter or timestamp, and no artefact commits to the collection of `.myn` files as a whole. So an adversary who can write the vault directory — the A4/A7 capability the threat model already concedes — can delete a note or replace it with an earlier revision of itself, and every AEAD check still passes.
  - Deletion is silent by construction, not by oversight: note enumeration is a directory read with no roster to compare against, and §9.6.4, §9.8.4 and §9.17.4 all make the derived caches follow it ("a note in the manifest but absent from disk → **deleted**, drop it").
  - Rollback needs no crafting, because the vault ships the material: `snapshots/` (§9.1) holds byte-verbatim earlier copies of the same note, sealed under the same `item_key` with the same `note_uuid` and `items_key_id`, so copying one over the live file produces a blob that is valid by every check this section lists.
  - Phase 2's vault head (§9.16, `sync-protocol.md`) binds a manifest and closes the *server-side* version of this, and only for the families it covers. It is not an at-rest defence and does not apply to a local disk adversary. `threat-model.md` §7 records the residual.

### 6.6 Why two AEAD calls

Encrypting plaintext directly under `itemsKey` would save one AEAD call per note but tie every note's ciphertext to the lifetime of that single key: rotating `itemsKey` (§3.3) would then force every note to be re-encrypted. The two-call structure isolates per-note cost from `itemsKey` rotation — a future rewrap touches one 64-byte field per note, never the bulk plaintext.

### 6.7 Nonce hygiene

Both `item_key_nonce` and `content_nonce` are drawn under the §5.3 nonce policy, which binds every AEAD nonce in this specification rather than the per-note blob alone. What is specific to `.myn` is the margin: at 192 bits, random collisions are negligible across any realistic note count or revision count under a single `itemsKey` or `item_key`.

## 7. Recovery Phrase Derivation

### 7.1 Phrase format

The recovery phrase is **24 BIP-39 English words** representing 256 bits of entropy plus an 8-bit checksum (BIP-39 §3 encoding). The wordlist is the canonical English BIP-39 list.

Myne uses BIP-39 only as an **encoding** for high-entropy phrases. It does **not** use BIP-39's standard PBKDF2-HMAC-SHA512 seed derivation, which uses 2048 iterations and is too weak by 2026 standards (the next major version's research roadmap, `protocol-next-roadmap.md`, to be written). Instead, the phrase string is fed directly to Argon2id as defined in §3.1 (`recovery_wrap_key` derivation).

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
phrase_normalized = normalize_phrase(user_input)                      ← §7.4
recovery_wrap_key = Argon2id(phrase_normalized, salt_recovery, ...)   ← §3.1
root_key          = AEAD-decrypt(recovery_wrap_key,
                                 nonce_recovery_wrap,
                                 enc_root_key_recovery,
                                 AAD_recovery_wrap)
```

Tag-verification failure means either the phrase was entered wrong or the `vault.meta` was tampered. The client MUST NOT distinguish these two cases to the user beyond "phrase or vault is invalid".

After successful recovery the client prompts the user to set a new master password. The new password generates fresh `random_salt_password_16` and a new `enc_root_key_password`; `vault.meta` is rewritten in place. The recovery phrase **does not change** — its `enc_root_key_recovery` and `salt_recovery` are preserved across password changes.

### 7.4 Phrase normalization

`normalize_phrase` is defined here and **only** here. §3.1 and §7.3 reference it; neither restates it.

```
normalize_phrase(phrase_input):
  Apply NFKD compatibility decomposition to phrase_input, then walk the
  resulting code points left to right, applying both of:

    1. ASCII-only case fold: U+0041..U+005A → U+0061..U+007A.
       Every other code point is left unchanged.
    2. Any run of one or more code points carrying the Unicode `White_Space`
       property becomes a single U+0020, except that a leading or trailing
       run is removed entirely.

  Return the result as UTF-8 bytes.
```

The two rules apply per code point over the NFKD stream and commute, so there is no step-order question to settle: case folding never changes whether a code point is whitespace, and whitespace coalescing never changes the case of a code point it keeps.

The case fold **MUST** be ASCII-only and **MUST NOT** be locale-sensitive. An implementation MUST NOT reach for a default-locale or `tr`/`az`-locale case mapping: those map `I` to U+0131, which changes `phrase_normalized`, therefore the Argon2id password, therefore `recovery_wrap_key`. The resulting tag-verification failure is reported with the single non-distinguishing message §7.3 mandates, so a user holding the correct 24 words — merely typed or pasted in capitals — learns only that the phrase is invalid, never that capitalization was the cause, and §7.5 leaves no partial-recovery path. ASCII-only case folding is not a simplification of Unicode case mapping here; it is the pin. It is byte-identical on every platform and every locale, and it is what every Myne client computes.

NFKD is applied so that visually-identical phrases entered with different keyboard layouts produce identical bytes; it also folds the no-break space (U+00A0) and the ideographic space (U+3000) to U+0020 before the whitespace rule runs. The whitespace class is the Unicode `White_Space` property rather than the ASCII subset — the two disagree on code points a paste can carry through NFKD intact, U+2028 among them — and U+0020 is the single join code point. Because the BIP-39 English wordlist is ASCII lowercase, a phrase Myne generated is already in normalized form; this pipeline exists for what the user types back.

### 7.5 What the phrase does NOT do

- The phrase is **not** the encryption key. It derives `recovery_wrap_key`, which encrypts a copy of `root_key`.
- The phrase is **not** sent to any server in v0.1.
- The phrase **cannot** be combined with a server-side service to provide a partial-recovery path. v0.1 is hard zero-knowledge: lose both phrase and password, lose the vault.
- The phrase **cannot be rotated** in v0.1. No client ships a phrase-rotation command; the change-password flow and the post-recovery password reset both rewrite only the password-side fields of `vault.meta` and preserve the recovery-side bytes verbatim (§7.3). Whoever reads the phrase once therefore holds permanent, unrevocable access to that vault — and, because the recovery-side bytes travel into every backup and every synced copy of `vault.meta`, to those copies too. There is no in-app remedy: the only recourse is to create a new vault and hand-migrate the notes. (`../vision.md` anti-features; `../decisions.md` 2026-07-26.)

## 8. Account Number Scheme

This section summarizes the account-number format used by the protocol. Full generation, display, parsing, and validation rules are specified in `account-number.md`.

### 8.1 Format

- Alphabet: **Crockford base32** (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, excludes `I L O U`).
- Payload: **19 random characters** (95 bits of entropy) + **1 Damm-32 check character**.
- Display: `MY-XXXX-XXXX-XXXX-XXXX-XXXX` — human-readable prefix `MY-` plus 4-4-4-4-4 group separators, covering all 20 canonical characters (27-character display form; the final group's last character is the Damm-32 check character). The prefix and separators are presentation-only. `account-number.md` §2/§3 is normative for the display form.

### 8.2 Generation

```
entropy_bits   = OS_CSPRNG(95 bits)
entropy_chars  = crockford_base32_encode(entropy_bits)        ← 19 chars
check_char     = damm32_check(entropy_chars)                  ← 1 char
account_number = entropy_chars || check_char                  ← 20 chars (canonical form)
display_form   = "MY-" || group_with_dashes(account_number)
```

### 8.3 Normalization for hashing

The account number is normalized before any cryptographic use. `normalize(input)` is defined **normatively and only** in `account-number.md` §5 — an ordered pipeline ending in the canonical 20-character uppercase ASCII string, with an ASCII-only, locale-invariant case step. It is deliberately not restated here.

This section previously carried a second copy of that pipeline whose steps ran in a different order, and the two copies disagreed observably. An input of the form `MY -<20 chars>` — a space inside the prefix, trivially produced by pasting a line-wrapped account number — is accepted under `account-number.md` §5, where whitespace removal precedes the prefix strip, and was rejected under the copy here, where the prefix strip ran first and saw `MY ` rather than `MY-`. The copy also dropped the Crockford-alphabet check and §5's "fail if any other prefix is present" rule. `account-number.md` §5 is the list a v0.1 implementation conforms to.

The cryptographic identifier used throughout the protocol is the SHA-256 of the canonical form, truncated to 16 bytes:

```
account_number_hash = SHA-256(normalize(account_number_input) as ASCII)[:16]
```

This hash is stored in `vault.meta` (§9.3) and used as a salt component in both Argon2id derivations (§3.1).

### 8.4 What this section does NOT cover

- Algorithmic details of Damm-32 (the 32×32 quasigroup table) → `account-number.md`.
- Server-side anti-abuse for account-number creation (rate limiting, captchas) → out of scope for v0.1; relevant when sync server ships in Phase 2.
- Anonymous-credential wrappers (KVAC, Privacy Pass) — a later major version may layer these on top of the account number for sync-server entitlement; the account-number format itself does not change.

## 9. On-Disk Storage Format

### 9.1 Vault layout

A Myne vault is a directory on the user's filesystem containing:

```
<vault-root>/
├── vault.meta            ← single file with vault-level state (MYV1, §9.3)
├── vault.prefs           ← encrypted preferences (MYP1, §9.5)
├── vault.search          ← encrypted full-text index (MYS1, §9.6)
├── vault.workspace       ← encrypted editor workspace state (MYW1, §9.7)
├── vault.indices         ← encrypted structured-metadata index (MYI1, §9.8)
├── vault.attachments     ← encrypted attachments catalog (MYC1, §9.10)
├── vault.dictionary      ← encrypted personal dictionary (MYD1, §9.13)
├── vault.quickunlock     ← device-local quick-unlock credential (MYQ1, §9.14)
├── vault.label           ← device-local sealed label store (MYL1, §9.22)
├── vault.head-state      ← device-local sync baseline (MYH1, §9.16)
├── vault.embeddings      ← encrypted AI embedding index (MYR1, §9.17)
├── vault.graph           ← encrypted graph-layout cache (MYG1, §9.19)
├── vault.themes          ← encrypted custom-theme palettes (MYT1, §9.21)
├── notes/
│   ├── 0184a2b3-...myn   ← one encrypted note per file
│   ├── 0184a2b4-...myn
│   └── ...
├── snapshots/            ← encrypted per-note version history (MYND-96)
│   ├── 0184a2b3-...__0184c1d2-...myn
│   └── ...
├── attachments/          ← encrypted attachment blobs (MYA1, §9.9), one per
│                            <attachment-id-hex>; catalog is vault.attachments (MYC1, §9.10)
└── attachments-text/     ← encrypted per-attachment extracted-text cache (MYE1,
                             §9.15), one per <attachment-id-hex>
```

- **Only `vault.meta` and `notes/` are required.** Every other entry is created lazily, the first time the feature that owns it writes; the tree above is an index, and each `vault.*` singleton's own §9.x section is normative for its envelope, KEK, AAD, size cap, and backup/sync class. A vault missing any of them is well-formed — the reader falls back per §9.x (rebuild for a cache, empty/default for a preference blob), never a parse failure.
- **Device-local sync bookkeeping also sits at the vault root, and is deliberately NOT a §9 blob family** (Phase 2): `sync-state.json` (this device's pull cursor + version-vector observation log, carrying the plaintext `device_id`), `pending-tombstones` and `pending-attachment-tombstones` (delete intents the server has not acknowledged yet), and `vault.meta-dirty` (an empty marker — this device changed a credential and has not pushed it). They hold no note plaintext and no key material, they are never synced and never backed up, and they carry no magic, no version byte, and no §10.3 row. The one at-rest leak recorded as an accepted residual is `sync-state.json`'s plaintext `device_id`, and [`../threat-model.md`](../threat-model.md) §7 records it **only for the web client's OPFS copy** — that bullet states native clients are unaffected. Their sync semantics are in [`sync-protocol.md`](sync-protocol.md). The endpoint configuration (`sync-config.json`) is **not** here — it is device-scoped and vault-independent, so it lives in the app config directory.
- **`vault.quickunlock.attempts` is device-local bookkeeping too, and is the one such file that carries a leading sentinel byte.** It sits at the vault root beside `vault.quickunlock` and holds the consecutive-failed-attempt count of §9.14.4 in a 2-byte body (`sentinel (0xA7) || count_u8`). That leading byte is a **corruption sentinel, not a §10.3 blob-family magic**: the file is unencrypted, holds no key material and no user content, is never synced and never backed up, and has an explicit OUT row in the §9.11.3 allowlist. §10.3 allocates 4-byte magics to AEAD blob families; a 1-byte device-local counter is not one and MUST NOT be registered there.
- **The two device-local staging queues are not under the vault root either.** `captures/<capture-id-hex>` (§9.18) and `pending-shares/sealed/<share-id-hex>` (§9.20) live under the app data container, because both must be writable while no vault is unlocked — and, for the capture queue, before the target vault is even known.
- File extension `.myn` (Myne Note) for per-note ciphertext blobs.
- File extension `.meta` for vault-level metadata (the wrapped `itemsKey`, the random Argon2id salt, the protocol version, and the account number).
- File names are the note's UUIDv7 string. UUIDs are not encrypted; they are random and reveal only "this is a note" plus a coarse creation-time bucket. (UUIDv7 chosen for natural sort order; the time component leaks a creation-time millisecond, which is accepted in v0.1; a later version may switch to UUIDv4 if even coarse leakage is unacceptable.)
- **Folders are virtual (MYND-144).** The `notes/` directory is **always flat** — folder hierarchy is **not** reflected on disk. A note's folder is a path string in its encrypted frontmatter (`folder:`, see [`markdown-dialect.md`](markdown-dialect.md) §3.6.1); the sidebar tree is reconstructed client-side after decryption. This keeps folder structure inside the AEAD-encrypted blob (`threat-model.md` **AS3**, Sensitive) — a filesystem adversary (A4/A7) sees only flat `<uuid>.myn` blobs, never folder names. Deliberately-created (empty) folders are carried in `vault.prefs` (§9.5.2 `deliberate_folders`), also encrypted. No on-disk-format change.
- **Encrypted snapshots (MYND-96).** The `snapshots/` directory holds per-note version history. Each snapshot is a frozen `.myn`-format blob — a **byte-verbatim copy** of the note's `MY01` blob (§9.2) as it stood immediately before an overwrite — so there is **no new magic byte and no §10.3 registry entry**. Verbatim, not re-sealed: the capture layer performs no decryption and no re-encryption, so a snapshot keeps the original `content_nonce` of the revision it froze, and the live note draws a fresh nonce on its next update (no key+nonce pair ever covers two plaintexts). An earlier revision of this paragraph said "re-sealed", which would have implied a fresh nonce; the byte-verbatim reading is the implemented one and is what §6.5's freshness note depends on. Files are flat (no per-note subdirectories, mirroring the `notes/` privacy posture) and named `<note-uuid>__<snapshot-uuidv7>.myn`; the snapshot's capture time is the trailing UUIDv7's time component and snapshots sort naturally. Capture is time-coalesced (≈ one per note per 5 min of active editing, plus on editor-close / vault-lock); retention is a bounded window (default ~7 days) with a safety backstop, pruned eagerly. Permanently deleting a note purges its snapshots, preserving cryptographic erase (a reused-`item_key` snapshot would otherwise be undecryptable orphan ciphertext). The metadata-leak posture is recorded in `threat-model.md` §7 and the decision in `decisions.md` 2026-06-08. No on-disk-format change to `.myn`, `vault.meta`, `vault.prefs`, or `vault.search`.

  **CRDT (`NC05`, v0.2) notes do not use this subsystem.** A CRDT note's Automerge document (§10.7) already carries its full change-history, so the write path captures **no** snapshot for an `NC05` note and it has no `snapshots/` entries — the synced document *is* the version store (`decisions.md` 2026-08-09 — the snapshots-retirement entry, ASM-12→B; that history is bounded later by #423). A migrated note's pre-migration `MY01` snapshots are part of the `legacy/` snapshot (§10.4.1), crypto-erased on the user's migration confirm; CRDT history is forward-from-migration, not a re-import of the old store.

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
                                        vault.meta. A later version will use
                                        this field to identify the epoch (§3.3).
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

Implementations SHOULD reject `ciphertext_len > 16 MiB + 32`. This is the **per-note** cap; arbitrary files (images, SVG, PDF) are not stored in `.myn` blobs but in the attachment subsystem (§9.9, 64 MiB per-blob cap), which **ships in v0.1**. The cap exists to bound the parser's pre-AEAD allocation footprint — `ciphertext_len` is read and acted upon before any tag verification can run, so a hostile blob with a 4 GiB advertised length would otherwise force an unrecoverable allocation attempt before authenticity is established. See `docs/decisions.md` 2026-05-06 entry for the full rationale.

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
                                                a later version (additional
                                                credential wraps, epoch keys, etc.).
```

The KDF parameter block at offset 22 is the canonical encoding referenced in §4.3 and bound into both wrap AADs (§3.1). Tampering with any parameter byte invalidates the AEAD tag on `enc_root_key_password` and `enc_root_key_recovery`. The "v0.1 baseline" values in the rows above are exactly that — a baseline, not a bound: this table is the **encoding** contract, and the cost values a client may act on are constrained at the derivation site by §4.2.1, not here.

The two encrypted root_key copies (`enc_root_key_password`, `enc_root_key_recovery`) hold the same 32-byte plaintext under independent wrap keys. Either is sufficient to unlock the vault.

The artefacts that leave the device under Phase-2 sync are exactly the **sync-taxonomy authoritative + identity members** (`sync-protocol.md` §9): `.myn` notes, `vault.prefs`, `vault.dictionary`, attachment blobs, the `vault.attachments` catalog, and `vault.meta` — **not** `snapshots/` (authoritative but deliberately local-only, §9.2 there) and **not** the rebuildable-cache / device-local families. Every synced artefact is opaque ciphertext + a small public header (magic, version, IDs, nonces, salts, account-hash). No plaintext note content, no plaintext titles, no plaintext recovery-phrase material is ever stored.

### 9.4 What is in plaintext on disk and why

- **Magic bytes (`MY01`, `MYV1`)** — identify the file format for parsing. They reveal "this is a Myne file" to anyone with disk access; this is accepted for v0.1 because at-rest encryption is a defense against an attacker reading file contents, not against an attacker enumerating which application produced a file. The user already chose to install Myne; that fact is not the secret.
- **Protocol version byte** — required for forward-compat parsing; cannot be encrypted because the parser must read it before any key is derived.
- **Reserved bytes** — anchor for future flags without re-version.
- **`items_key_id`, salt, nonces** — public by construction in any AEAD scheme; these are not secrets.
- **`account_number_hash`** — required to derive the salt; revealing it gives an attacker the same precomputation difficulty as the user has, no easier.
- **UUIDv7 file names** — note count and approximate creation times leak. A later version may switch to UUIDv4 if even this is unacceptable.

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

The inner plaintext is **canonical JSON** of an object whose keys are preference names and whose values are the persisted preference data. v0.1 ships the following fields — `active_workspace` (string, optional, MYND-308), `ai_enabled` (bool, optional, local-ai MYND-406), `ai_excluded_folders` (string array, set semantics, optional, local-ai MYND-408), `ai_provider` (string enum, optional, ai-remote-providers myne#415), `ai_provider_consent` (string enum, optional, ai-remote-providers myne#415), `ai_provider_key` (string, optional, **never serialized across IPC**, ai-remote-providers myne#415), `ai_provider_model` (string, optional, ai-remote-providers myne#415), `archive_disabled` (bool, optional, archive-disable), `archived_folders` (string array, set semantics, optional, folder-archive), `attachment_compression_enabled` (bool, optional, ingest-image-compression), `attachment_ocr_enabled` (bool, optional, image-OCR MYND-441), `auto_lock_seconds` (integer, optional, MYND-121), `auto_tag_enabled` (bool, optional, on-device-tag-suggestion MYND-651), `bar_items_order` (string array, sequence semantics, optional, bottom-bar customization), `cli_enabled` (bool, optional, myne-cli MYND-490), `cli_excluded_folders` (string array, set semantics, optional, myne-cli MYND-490), `cli_rate_limit_disabled` (bool, optional, myne-cli MYND-490), `color_groups` (nested array of color-group-rule objects, sequence semantics — order is rule precedence, optional, graph-connection-ux-polish MYND-604), `custom_theme` (string, optional, MYND-297), `daily_date_format` (string, optional, MYND-191), `daily_folder` (string, optional, MYND-191), `daily_template` (string, optional, MYND-191), `date_format` (string enum, optional, myne#279), `deliberate_folders` (string array, set semantics, MYND-144), `developer_mode` (bool, optional, developer-mode MYND-593), `device_names` (nested object, optional, device-naming), `editor_content_width` (string, optional, editor-typography), `editor_default_view_mode` (string enum, optional, MYND-299), `editor_focus_dim_inactive` (bool, optional, MYND-348), `editor_focus_typewriter` (bool, optional, MYND-348), `editor_font_family` (string, optional, editor-typography), `editor_layout` (nested object, optional, MYND-137), `editor_line_numbers` (bool, optional, MYND-314), `editor_line_spacing` (string, optional, editor-typography), `editor_slash_hidden` (string array, set semantics, optional, editor-command customization MYND-336), `editor_slash_order` (string array, sequence semantics, optional, editor-command customization MYND-336), `editor_text_size` (string, optional, editor-typography), `editor_toolbar_hidden` (string array, set semantics, optional, editor-command customization MYND-336), `editor_toolbar_order` (string array, sequence semantics, optional, editor-command customization MYND-336), `editor_vim_mode` (bool, optional, vim-keyboard-mode MYND-313), `favorites` (string array, sequence semantics, MYND-183), `field_clocks` (nested object of integers, optional, MYND-478), `folder_icons` (nested object, optional, MYND-185), `hidden_bar_items` (string array, set semantics, optional, bottom-bar customization), `icon` (string, optional, vault-icon), `item_colors` (nested object, optional, MYND-184), `item_order` (nested object of container-path→sequence-array, container-keyed per-container order, MYND-183/MYND-596), `keymap` (nested object of string arrays, optional, MYND-304), `label` (string, optional, MYND-205), `last_backup_at` (integer, optional, MYND-58), `new_note_location` (string enum, optional, MYND-462), `new_note_location_folder` (string, optional, MYND-462), `paired_extensions` (nested array of browser-clipper pairing-token records, optional, MYND-443), `reminder_horizon_days` (integer, optional, MYND-618), `reminders_enabled` (bool, optional, MYND-618), `right_panel_active_tab` (string, optional, right-panel tabs), `right_panel_hidden_tabs` (string array, set semantics, optional, right-panel tabs), `right_panel_tab_order` (string array, sequence semantics, optional, right-panel tabs), `saved_views` (nested array of view objects, optional, MYND-273), `screen_capture_protection` (bool), `show_note_timestamps` (bool, optional, sidebar-note-timestamps), `show_task_marker` (bool, optional, MYND-613), `spell_enabled` (bool, optional, MYND-267), `spell_languages` (string array, set semantics, optional, MYND-267), `startup_open` (string enum, optional, MYND-462), `startup_open_note` (string, optional, MYND-462), `theme` (string, optional, MYND-110), `time_format` (string enum, optional, myne#279), `timezone` (string, optional, myne#279), `transcription_enabled` (bool, optional, MYND-592), and `view_order` (string array, sequence semantics, optional, MYND-273). Optional fields are **omitted entirely when unset** (`active_workspace` when the vault has a single default named workspace; `archive_disabled` when the user never disabled archiving (archiving on, the default); `auto_lock_seconds` when the user has no stored timeout; `auto_tag_enabled` when the user never turned on the default-off automatic tag suggestion (emitted **only when `true`**, like `ai_enabled`); `bar_items_order` when the user never reordered the bottom bar (the empty sequence); `cli_enabled` when the user never turned on the CLI terminal-access door (emitted **only when `true`**, like `ai_enabled`); `cli_excluded_folders` when no folder is excluded from the CLI (the empty set); `cli_rate_limit_disabled` when the user never touched the CLI socket rate-limit toggle; `color_groups` when the user has defined no color-group rule (the empty sequence); `custom_theme` when no custom theme is selected; the three `daily_*` fields when the user has not customized that daily-notes preference; `editor_default_view_mode` when the user kept the canonical `live` default; the two `editor_focus_*` toggles when kept at their default-on state; `editor_layout` when the user never customized the sidebar layout; `editor_line_numbers` when the user never touched the line-number gutter toggle; `editor_vim_mode` when the user never touched the vim keyboard-mode toggle; the four `editor_*` command-customization arrays (`editor_slash_hidden`, `editor_slash_order`, `editor_toolbar_hidden`, `editor_toolbar_order`) when the user never reordered or hid a slash-menu / floating-toolbar entry (each empty); the four `editor_*` typography presets (`editor_content_width`, `editor_font_family`, `editor_line_spacing`, `editor_text_size`) when the user has not customized that field; the three arrays when empty; the `hidden_bar_items` set when the bottom bar is fully visible; the two decoration maps (`folder_icons`, `item_colors`) when empty; `device_names` when no device has been named (the empty map); `field_clocks` when no shared field has ever been clock-stamped (the empty map — every pre-MYND-478 blob); the `keymap` overrides map when the user rebound no shortcut; `label` when the user set no vault label; `icon` when the user chose no vault icon; `last_backup_at` when the vault was never exported as a backup; `new_note_location` and `new_note_location_folder` when the user kept the default vault-root placement for new notes; `startup_open` and `startup_open_note` when the user kept the default last-opened startup behaviour; `paired_extensions` when no browser extension is paired; `reminder_horizon_days` when this device never set a reminder horizon (the client's built-in horizon then applies); `reminders_enabled` when kept at its default `true` (only the non-default `false` is persisted, so a vault predating MYND-618 decodes with reminders enabled) — **both are device-local and never sync**, because whether a given machine should be interrupted, and how far ahead it hands pending times to its operating system, are properties of that machine; the three `right_panel_*` fields when the right panel keeps its default tab set, order, and active tab (`right_panel_active_tab` unset, `right_panel_hidden_tabs` empty, `right_panel_tab_order` empty); `show_note_timestamps` when kept at its default `true` (only the non-default `false` is persisted); `show_task_marker` when kept at its default `true` (same polarity — only the non-default `false` is persisted, so a vault predating MYND-613 decodes with the marker shown); `transcription_enabled` when kept at its default `true` (same polarity again — only the non-default `false` is persisted, so a vault predating MYND-592 decodes with speech-to-text enabled); `spell_enabled` when the user never toggled spell-check; `spell_languages` when no language is explicitly active (the empty set); `date_format`, `time_format` and `timezone` when the user made no explicit display choice, i.e. follows the app language and this device's own zone; `theme` when the user made no explicit choice, i.e. follows the OS; `saved_views` and `view_order` when the vault has no saved views), `ai_enabled` when the user never turned on the default-off on-device AI (emitted **only when `true`**, like a positive opt-in), `attachment_compression_enabled` when the user never turned OFF the default-**on** [ingest-time image compression](../glossary.md#ingest-time-image-compression) (emitted **only when `false`** — the same inverse-of-`ai_enabled` rule as `attachment_ocr_enabled`, because this one also defaults on; a blob predating this field therefore decodes with compression enabled, and a vault that never touched the toggle stays byte-identical to a pre-feature blob), `attachment_ocr_enabled` when the user never turned OFF the default-**on** image OCR (emitted **only when `false`** — the inverse of `ai_enabled`, because this one defaults on; a blob predating MYND-441 therefore decodes with OCR enabled, and a vault that never touched the toggle stays byte-identical to a pre-feature blob), `ai_excluded_folders` when no folder is excluded from AI (the empty set), the four `ai_provider*` fields when the user has named no remote provider — which is the default and the **unreachable** state, not merely a disabled one, so a vault that never configured one carries no at-rest trace of the feature at all (`ai_provider_consent` is omitted until consent is given, `ai_provider_model` until a model is chosen), `archived_folders` when no folder is archived (the empty set), so a vault that configured none encodes to the single-field form:
```json
{"screen_capture_protection":true}
```

A vault with every field encodes every key (lexicographically sorted — `active_workspace` precedes `ai_enabled` precedes `ai_excluded_folders` precedes `ai_provider` precedes `ai_provider_consent` precedes `ai_provider_key` precedes `ai_provider_model` precedes `archive_disabled` precedes `archived_folders` precedes `attachment_compression_enabled` precedes `attachment_ocr_enabled` precedes `auto_lock_seconds` precedes `auto_tag_enabled` precedes `bar_items_order` precedes `cli_enabled` precedes `cli_excluded_folders` precedes `cli_rate_limit_disabled` precedes `color_groups` precedes `custom_theme` precedes `daily_date_format` precedes `daily_folder` precedes `daily_template` precedes `date_format` precedes `deliberate_folders` precedes `developer_mode` precedes `device_names` precedes `editor_content_width` precedes `editor_default_view_mode` precedes `editor_focus_dim_inactive` precedes `editor_focus_typewriter` precedes `editor_font_family` precedes `editor_layout` precedes `editor_line_numbers` precedes `editor_line_spacing` precedes `editor_slash_hidden` precedes `editor_slash_order` precedes `editor_text_size` precedes `editor_toolbar_hidden` precedes `editor_toolbar_order` precedes `editor_vim_mode` precedes `favorites` precedes `field_clocks` precedes `folder_icons` precedes `hidden_bar_items` precedes `icon` precedes `item_colors` precedes `item_order` precedes `keymap` precedes `label` precedes `last_backup_at` precedes `new_note_location` precedes `new_note_location_folder` precedes `paired_extensions` precedes `reminder_horizon_days` precedes `reminders_enabled` precedes `right_panel_active_tab` precedes `right_panel_hidden_tabs` precedes `right_panel_tab_order` precedes `saved_views` precedes `screen_capture_protection` precedes `show_note_timestamps` precedes `show_task_marker` precedes `spell_enabled` precedes `spell_languages` precedes `startup_open` precedes `startup_open_note` precedes `theme` precedes `time_format` precedes `timezone` precedes `transcription_enabled` precedes `view_order`):
```json
{"active_workspace":"0190…00ff","ai_enabled":true,"ai_excluded_folders":["Private/"],"ai_provider":"openrouter","ai_provider_consent":"openrouter","ai_provider_key":"sk-…","ai_provider_model":"meta-llama/llama-3.1-8b","archive_disabled":true,"archived_folders":["Archive/2024/"],"attachment_compression_enabled":false,"attachment_ocr_enabled":false,"auto_lock_seconds":300,"auto_tag_enabled":true,"bar_items_order":["view-mode","tags","graph"],"cli_enabled":true,"cli_excluded_folders":["Private/"],"cli_rate_limit_disabled":true,"color_groups":[{"color":"moss","enabled":true,"filter":{"kind":"hasTag","tag":"work"},"id":"0190…0007","name":"Work"}],"custom_theme":"solarized-dark","daily_date_format":"YYYY-MM-DD","daily_folder":"Daily/","daily_template":"0190…0003","date_format":"dmy","deliberate_folders":["Archive/2025/","Projects/Myne/"],"developer_mode":true,"device_names":{"3f9a…c2d1":"Studio Mac"},"editor_content_width":"wide","editor_default_view_mode":"reading","editor_focus_dim_inactive":true,"editor_focus_typewriter":false,"editor_font_family":"sans","editor_layout":{"left_collapsed":false,"left_width":312,"right_collapsed":true,"right_width":288},"editor_line_numbers":true,"editor_line_spacing":"relaxed","editor_slash_hidden":["callout","table"],"editor_slash_order":["h1","todo","divider"],"editor_text_size":"lg","editor_toolbar_hidden":["quote","wikilink"],"editor_toolbar_order":["bold","italic","link","heading"],"editor_vim_mode":true,"favorites":["0190…0002"],"field_clocks":{"device_names/3f9a…c2d1":1765432100000,"label":1765432099000},"folder_icons":{"Archive/2025/":"archive","Projects/Myne/":"book"},"hidden_bar_items":["graph","word-count"],"icon":"book","item_colors":{"0190…0001":"moss","Projects/Myne/":"slate"},"item_order":{"":["0190…0002","Projects/","0190…0001"],"projects/":["Projects/Myne/"]},"keymap":{"app.open-settings":["Mod-,"],"graph.show":["Mod-Shift-g"],"vault.lock":[]},"label":"Work","last_backup_at":1765432100,"new_note_location":"specific","new_note_location_folder":"Inbox/","paired_extensions":[{"extension_id":"clipper@myne.md","paired_at":1765432000,"revoked":false,"token_value":"9c1f…b7a4"}],"reminder_horizon_days":7,"reminders_enabled":false,"right_panel_active_tab":"backlinks","right_panel_hidden_tabs":["outline"],"right_panel_tab_order":["backlinks","unlinked","outline"],"saved_views":[{"card_size":300,"filters":{"children":[{"kind":"inFolder","path":"Books/"},{"key":"rating","kind":"property","op":">","value":"4"}],"kind":"and"},"group_by":"status","id":"0190…0005","image":"image","image_aspect_ratio":"1.65","name":"Books","sort":{"direction":"desc","key":"finished"},"view_type":"cards"}],"screen_capture_protection":true,"show_note_timestamps":false,"show_task_marker":false,"spell_enabled":true,"spell_languages":["en-US","tr-TR"],"startup_open":"specific","startup_open_note":"0190…0006","theme":"dark","time_format":"24h","timezone":"Europe/Berlin","transcription_enabled":false,"view_order":["0190…0005"]}```

The `item_order` example is a **container-keyed map** — one entry per container, each holding that container's children in manual order. The root entry (`""`) interleaves note UUIDs and folder paths freely — `0190…0002` (a note), then `Projects/` (a folder), then `0190…0001` (a note) — while the `projects/` entry — its key the folded container identity — carries its own child sub-folder (`Projects/Myne/`, a display path). Notes and folders are still discriminated by the trailing `/`, and each container is ordered independently of the others.

**Canonical encoding rules** (load-bearing for cross-implementation byte-stability and for the byte-stable golden vectors in `myne-test-vectors`):

- Object keys MUST be encoded in lexicographic (Unicode-code-point) order.
- No insignificant whitespace — no spaces around `:` or `,`, no leading/trailing whitespace, no newlines.
- String values MUST be UTF-8 normalized to NFC before encoding.
- Integer values MUST be encoded without a trailing `.0`.
- Floating-point values are FORBIDDEN in v0.1. Implementations MUST reject schemas that introduce float-typed preference fields until a future minor revision specifies a deterministic float encoding.
- Booleans, integers, strings, **string arrays**, and nested objects following the same rules are the only permitted v0.1 value types. A string array is encoded `["a","b"]` with no insignificant whitespace; each element follows the string rules above (NFC, plus RFC 8259 escaping of `"`, `\`, and C0 control characters — canonical lowercase `\u00XX` for unnamed controls; `/` left unescaped). A string array carries one of two element-ordering disciplines, fixed per field: a **set** array (`deliberate_folders`) is sorted + exact-deduped (the element set is the value, order is not); a **sequence** array (`favorites`, and each per-container value array of the `item_order` map) preserves element order verbatim (the order *is* the value) and is neither sorted nor deduped. Both are deterministic given the same logical value, which is all the byte-stability requirement demands.

**`auto_lock_seconds` field (MYND-121).** An optional non-negative integer — the user's chosen auto-lock-on-idle timeout in seconds. **Omitted entirely when unset**, so a vault that never configured auto-lock is byte-identical to a pre-MYND-121 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find the key MUST treat it as unset; the client then applies its protective-envelope default. Per the general canonical-encoding rules above, the value is a bare decimal integer (no leading zeros, no trailing `.0`); **floating-point is FORBIDDEN** and a fractional value rejects the parse. Crucially, the always-on flag and the code-enforced `AUTO_LOCK_CEILING` that clamp this value are **NOT** stored in `vault.prefs` — they live in the client implementation, so a replayed, deleted, or tampered `vault.prefs` can only make auto-lock *stricter*, never disable it or loosen it past the ceiling (the two-class prefs taxonomy of [`../threat-model.md`](../threat-model.md) §7).

**`color_groups` field (graph-connection-ux-polish, MYND-604).** An optional JSON array of color-group-rule objects — the user's ordered graph-node coloring rules, evaluated first-match-wins at render time in the knowledge-graph pane. Each element is a canonical-JSON object with the keys `id` (string, stable rule id), `name` (string, user-visible), `color` (string — a design-token palette key; this codec performs no palette validation), `enabled` (bool — a disabled rule stays in the list but contributes no match), and `filter` (the same recursive filter-AST object `saved_views` uses — see its entry below; v1 exposes only the `hasTag` and `inFolder` leaves through the UI, but the persisted shape is the full AST, so widening later is UI-only). Per-object keys are emitted in lexicographic order (`color` < `enabled` < `filter` < `id` < `name`); all five are required (no optional sub-fields — a rule with nothing set is not representable). **Unlike `saved_views`, the array is encoded in caller order, verbatim — never sorted by `id`**: array position IS rule precedence (first match wins), and there is no separate order field to carry a display order the way `saved_views` has `view_order`. The array is **omitted entirely when empty**, so a vault that never opens the feature is byte-identical to a pre-MYND-604 `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — a **non-breaking, migration-less additive field** on the existing `MYP1` format, exactly like `saved_views`; no new magic, no new `SubkeyRole`, no new AAD role, zero new crypto). A decoder that does not find the key MUST treat it as the empty list. It sorts canonically between `bar_items_order` (`b`) and `custom_theme` (`col` < `cus`). AS3-Sensitive (a rule's name / filter / referenced tag or folder); rides inside the AEAD-encrypted blob like every other field. **Non-load-bearing** (no protective-envelope clamp; a tampered or replayed `vault.prefs` can at worst reset rules to empty or apply a stale rule set — never expose or corrupt note content). Phase 2 sync-merge classification: **shared, whole-value LWW** — merges per `sync-protocol.md` §10.2 on the field's canonical (order-preserving) encoding, exactly like `saved_views`; a per-key or set-union merge would silently corrupt the precedence order, which is why this is whole-value rather than sequence-LWW despite the array being order-preserving.

**`custom_theme` field (MYND-297, custom-themes epic).** An optional string — the name of a user-authored **custom theme**, i.e. a key of the encrypted `vault.themes` store (`MYT1`, §9.21). It named a plaintext file stem under `app_config_dir/themes/` until `../decisions.md` 2026-07-16 promoted palettes to vault content; the blob holds the palettes, this field holds the pointer. A non-null value takes **precedence** over `theme` (the built-in Light/Dark/System choice): when set, the client applies the custom palette and ignores `theme`; `null`/absent means no custom theme is selected. **NFC-normalized** and **omitted entirely when unset**, so a vault that never selected a custom theme is byte-identical to a pre-MYND-297 `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — a migration-less additive field on `MYP1`, exactly like the daily-notes / editor-typography fields). It sorts canonically between `auto_lock_seconds` (a) and the `daily_*` block (d) — the only `c` key. **Non-load-bearing** cosmetic (AS-low): a replayed or tampered `vault.prefs` can at worst select a different or absent palette — a name with no live entry in the store falls back to the built-in `theme`, and an unreadable store reads as empty per §9.21.4 — so, like `theme`, it carries **no** protective-envelope clamp. The name itself is constrained host-side to a path-safe charset (`is_valid_theme_name`); this codec stores it verbatim as a free string. Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices. The palettes themselves *are* shared (`vault.themes` is Class-1 synced data, §9.21.5); it is the *choice of which one is active* that stays per-device, so one account can wear a different theme on each of its devices. Consequently a selection can name a theme this device does not (yet) hold — a theme deleted elsewhere, or one whose sync round has not landed — and the fall-back above is that case, not an error; a client MUST NOT "repair" the pref by clearing it, since a re-add elsewhere revives the theme and the pointer with it.

**`daily_date_format` / `daily_folder` / `daily_template` fields (MYND-191).** Three optional string fields configuring the daily-notes feature (the bounded plain-markdown-skeleton + date-navigation feature; see `../decisions.md`). `daily_date_format` is the date-format string for a daily note's title (e.g. `YYYY-MM-DD`); `daily_folder` is the canonical trailing-slash folder path daily notes are filed under (e.g. `Daily/`); `daily_template` is the UUIDv7 of a template note (a `template: true` `.myn`) to instantiate today's note from. Each is **NFC-normalized** and **omitted entirely when unset**, so a vault that configured no daily-notes preference is byte-identical to a pre-MYND-191 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find a key MUST treat it as unset; the client then applies its canonical defaults host-side (`daily_folder` ≡ `Daily/`, `daily_date_format` ≡ `YYYY-MM-DD`, `daily_template` ≡ none → a blank daily note titled with the date). All three are **non-load-bearing** (cold/derivable, AS-low): a replayed or tampered `vault.prefs` can at worst point the daily note at the wrong folder/template or format its title differently — so, like `theme`, they carry **no** protective-envelope clamp. They sort canonically between `auto_lock_seconds` and `deliberate_folders` (`daily_date_format` < `daily_folder` < `daily_template`). Phase 2 sync-merge classification: **shared** — merges per `sync-protocol.md` §10.2 (scalar-LWW per field). Designating a `daily_folder` also adds it to `deliberate_folders` (client-side) so the folder survives empty.

**`new_note_location` / `new_note_location_folder` + `startup_open` / `startup_open_note` fields (MYND-462, "Files" settings panel).** Four optional string fields, in two mode+target pairs, configuring file-oriented behaviour exposed in the Settings → Files panel. `new_note_location` is a closed enum (`root` / `current` / `specific`) selecting where a newly-created note is filed — vault root, the active note's folder, or the folder named by `new_note_location_folder` (canonical trailing-slash form, meaningful only when the mode is `specific`). `startup_open` is a closed enum (`last` / `empty` / `specific`) selecting which file opens on app launch — restore the last workspace layout, open a fresh empty editor, or open the note whose UUIDv7 is `startup_open_note` (meaningful only when the mode is `specific`). Each is **NFC-normalized** and **omitted entirely when unset**, so a vault that never touched the Files settings is byte-identical to a pre-MYND-462 `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — migration-less additive fields on `MYP1`, exactly like the daily-notes / editor-typography fields). A decoder that does not find a key MUST treat it as unset; the client then applies its canonical defaults host-side (`new_note_location` ≡ `root`, `startup_open` ≡ `last`) and maps an unknown enum value to that default. The two enum strings are stored verbatim as free strings (the client owns the enum interpretation, the `editor_default_view_mode` precedent class). All four are **non-load-bearing** (AS-low): a replayed or tampered `vault.prefs` can at worst place a new note in the wrong folder, or open the wrong note / an empty editor on launch — **the saved workspace blob is never destroyed by a non-default `startup_open`** — so, like `theme`, they carry **no** protective-envelope clamp. `new_note_location`(+`_folder`) sort between `last_backup_at` and `paired_extensions`; `startup_open`(+`_note`) sort between `screen_capture_protection` and `theme`. Phase 2 sync-merge classification (`sync-protocol.md` §10.2): the new-note pair (`new_note_location`, `new_note_location_folder`) is **shared** (scalar-LWW per field — a vault convention); the startup pair (`startup_open`, `startup_open_note`) is **device-local** (session behaviour — the local value always survives the merge). Designating a `specific` `new_note_location_folder` also adds it to `deliberate_folders` (client-side) so the folder survives empty (the `daily_folder` discipline). A stale / deleted `startup_open_note` falls back to the empty editor host-side; the pref is never auto-cleared on a transient read miss.

**Registry reconciliation (2026-07-13, MYND-478).** Seven fields shipped in the reference implementation before their rows landed in this list; they are documented here additively (no outer-envelope / magic change; each follows the omitted-when-default discipline, so pre-feature blobs stay byte-identical): `bar_items_order` — a **sequence**-semantics string array of bottom-bar element ids, the drag-to-reorder twin of `hidden_bar_items` (`view_order` precedent class; NFC per element, order verbatim, omitted when empty; an unknown id is ignored at render and pruned on the next write); `device_names` — a string→string nested object mapping `device_id` (hex) → user-chosen display name, the single home for device names across clients (`folder_icons`-class canonical map encoding: NFC keys and values, lexicographic key order, omitted when empty); `editor_line_numbers` — an optional bool toggling the editor's line-number gutter (MYND-314; unset ≡ the host's default-off policy; omitted when unset); `icon` — the vault-switcher glyph name, the `label` twin (NFC, encrypted-only per SYNC-3, omitted when unset); `show_note_timestamps` — a bool defaulting `true`, with only the non-default `false` persisted; `spell_enabled` — an optional bool (MYND-267; omitted when unset); `spell_languages` — a **set**-semantics string array of BCP-47 language tags (MYND-267; NFC, lexicographically sorted, exact-deduped, omitted when empty). All seven are **non-load-bearing** (AS-low) and carry no protective-envelope clamp.

**`cli_enabled` / `cli_excluded_folders` / `cli_rate_limit_disabled` fields (myne-cli epic, MYND-490).** Three fields configuring the CLI terminal-access door — a local socket the `myne` CLI dials, created only while `cli_enabled` is true **and** the vault is unlocked. The governing rationale (the confused-deputy argument against an identity gatekeeper, the three real controls, the dropped no-bulk-export rule, the retained delete prohibition) is recorded in `../decisions.md` "CLI terminal access is a default-off, unlock-gated local socket with a folder exclusion list (MYND-490)" and `../threat-model.md` §7; this entry documents only the codec shape. `cli_enabled` is a bool — the **default-off** master switch for the door; it is emitted **only when `true`** (the same omit-when-false discipline as `ai_enabled`, so a vault that never enabled the CLI is byte-identical to a pre-feature `vault.prefs`). `cli_excluded_folders` is a **set**-semantics string array of canonical trailing-slash folder paths the CLI can never reach — same canonical encoding as `deliberate_folders` / `ai_excluded_folders` (**NFC-normalized**, **lexicographically sorted**, **exact-deduplicated**), **omitted entirely when empty**; enforcing the exclusion (filtering CLI reads/writes) is a runtime concern of the CLI bridge, not this codec. `cli_rate_limit_disabled` is an optional bool removing the socket's default-on rate limit; it follows the `archive_disabled` shape exactly — `None`/absent ≡ unset → the default-ON rate limit applies, and the client persists an explicit `Some(value)` only when the user makes a choice, **omitted entirely when unset**. This `Option<bool>` shape (rather than a numeric requests-per-second value) was the open question `cli-thin-client` task 2 closed: the Settings control is a single on/off switch, not a tunable rate, and `Some(false)` (re-enabling) is a legal but UI-unproduced value — omitting the field again has the identical effect. A decoder that does not find a key MUST treat `cli_enabled` as `false`, `cli_excluded_folders` as the empty set, and `cli_rate_limit_disabled` as unset. They sort canonically between `bar_items_order` and `custom_theme` (`cli_enabled` < `cli_excluded_folders` < `cli_rate_limit_disabled` < `custom_theme`). All three ride inside the AEAD-encrypted blob like every other field; `cli_excluded_folders` is AS3-Sensitive (folder paths); none carries a protective-envelope clamp — a tampered or replayed `vault.prefs` can at worst open, narrow, or speed up the door, never widen it past what the host's own unlock-gate and folder-filter enforce at runtime. Phase 2 sync-merge classification (`sync-protocol.md` §10.2): `cli_enabled` and `cli_rate_limit_disabled` are **device-local** (a per-machine door and a machine-local performance knob — the local value always survives the merge); `cli_excluded_folders` is **shared**, merging as a set-union — an exclusion added on one device must never be lost in a merge with a device that lacks it. These are additive `MYP1` fields — no `§10.3` change, no new magic, no new `SubkeyRole`, no new AAD role.

**`editor_slash_hidden` / `editor_slash_order` / `editor_toolbar_hidden` / `editor_toolbar_order` fields (editor-command customization, MYND-336).** Four optional string arrays, in two hide+reorder pairs, persisting the user's layout for the editor's two command surfaces — the slash menu and the floating selection toolbar. They are the editor-surface twins of the bottom-bar fields and follow those disciplines exactly: `editor_slash_hidden` and `editor_toolbar_hidden` are `hidden_bar_items`-class **sets** (each element **NFC-normalized**, **lexicographically sorted**, **exact-deduplicated** — the element set is the value, order is not); `editor_slash_order` and `editor_toolbar_order` are `bar_items_order`-class **sequences** (each element NFC-normalized, **order preserved verbatim**, **NOT sorted and NOT deduplicated**). Elements are ids from a **frozen client-side command vocabulary** (slash: `h1`…`h6`, `quote`, `callout`, `divider`, `table`, `todo`, …; toolbar: `bold`, `italic`, `heading`, `wikilink`, …) — the surfaces are configurable *over* that vocabulary, never extensible with user-authored entries (no-code-eval, [`../vision.md`](../vision.md)); the codec stores the ids verbatim and performs no vocabulary validation. Like `keymap` command ids, a persisted id becomes a governed on-disk name — renaming or removing one is a migration concern, not a silent edit. Each array is **omitted entirely when empty**, so a vault that never customized either surface is byte-identical to a pre-MYND-336 `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — migration-less additive fields on `MYP1`, exactly like `hidden_bar_items` / `bar_items_order`; no new magic, no new `SubkeyRole`, no new AAD role, zero new crypto). A decoder that does not find a key MUST treat it as empty; **empty means "never customized", not "show nothing"** — the client then applies its own default hidden set and canonical order, completes a stored order against that canonical order (unknown ids dropped, newly-shipped ids inserted in canonical position), and prunes the dropped ids on the next write. There is no codec-level garbage collection. They interleave with the typography presets in canonical order: `editor_line_spacing` < `editor_slash_hidden` < `editor_slash_order` < `editor_text_size` < `editor_toolbar_hidden` < `editor_toolbar_order` < `editor_vim_mode` (all between `editor_line_numbers` and `favorites`). AS-low (a UI affordance set — no note content, no folder structure) yet they ride inside the AEAD-encrypted blob like every other field. All four are **non-load-bearing**: no protective-envelope clamp — a tampered or replayed `vault.prefs` can at worst hide, reveal, or reorder a formatting affordance, and every such command stays reachable through markdown typed by hand and through the keymap. Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices (the same screen-size-dependent argument that made `hidden_bar_items` device-local).

**`field_clocks` field (MYND-478, Phase 2 prefs sync).** An optional nested object mapping a **shared** preference's field name, or a per-entry name. The per-entry forms are `device_names/<key>`, `item_colors/<key>`, `folder_icons/<key>`, `item_order/<container>` and, since myne-md/myne#613, `<setField>/<entry>` for the CLOCKED set-union fields: `deliberate_folders/<foldedEntry>`, `archived_folders/<foldedEntry>` and `spell_languages/<rawCode>`, folded for the folder sets and raw for the language codes. `ai_excluded_folders` and `cli_excluded_folders` are never stamped, so no key of theirs appears here (`sync-protocol.md` §10.2). Each key maps to the epoch-**milliseconds** integer at which a setter last changed that field: the LWW clock consumed by the `sync-protocol.md` §10.2 merge. Keys follow the standard object rules (NFC, lexicographic order); values are bare non-negative integers (floats FORBIDDEN, as everywhere in this section). **Omitted entirely when empty**, so a pre-MYND-478 `vault.prefs` is byte-identical (existing golden vectors unaffected: a migration-less additive field on `MYP1`, the `label` precedent class). A decoder that does not find the key MUST treat every field's clock as absent; the merge counts an absent clock as 0. Device-local fields (per the `sync-protocol.md` §10.2 classification) are never stamped. **Non-load-bearing** (AS-low): a tampered or replayed clock can at worst make the other replica win a preference merge, bounded by the same accepted singleton-rollback limit (`../threat-model.md` §7), so it carries no protective-envelope clamp. It sorts canonically between `favorites` and `folder_icons`.

**`deliberate_folders` field (MYND-144; semantics widened by myne-md/myne#613).** A JSON array of canonical trailing-slash folder paths (e.g. `["Projects/", "Projects/Myne/"]`): the carrier for folders the user means to keep, whether or not a note currently proves them (the empty-folder case of the virtual-folder model; see [`markdown-dialect.md`](markdown-dialect.md) §3.6.2). Canonical array encoding: elements are **NFC-normalized**, **lexicographically sorted** by their NFC bytes, and **exact-deduplicated** (folded-identity/case-insensitive dedup is the set-management layer's job, not the codec's). The array is **omitted entirely when empty**, so a vault with no deliberate folders is byte-identical to a pre-MYND-144 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find the key MUST treat it as the empty list.

*Entry and exit.* A folder ENTERS the set the first time it holds a note (a note created in it, a note moved into it, an import that created it), and on an explicit folder create. It LEAVES only on an explicit folder delete. It notably does **not** leave when its last note leaves, which is the whole point of the field: under the earlier model, where the set was written on folder create and delete alone, a folder vanished the moment it was emptied although the user had never asked for it to go. A client MUST NOT infer a removal from the absence of a folder in its own view; removals are STATED, per the add/remove verbs the merge discipline in [`sync-protocol.md`](sync-protocol.md) §10.2 depends on. Registration is idempotent, and a client SHOULD register once per user operation rather than once per note, since every write re-encrypts the whole blob.

*Conflict semantics for Phase 2 sync* are set-union with per-entry removal clocks, normative in [`sync-protocol.md`](sync-protocol.md) §10.2. That supersedes the clockless add-wins union this paragraph specified before myne-md/myne#613, under which a folder delete could never propagate to a second device. `ai_excluded_folders` and `cli_excluded_folders` deliberately KEEP the clockless monotone union: they are egress controls rather than preferences, and a union that can only grow is a merge that can only fail closed.

**`developer_mode` field (developer-mode, MYND-593).** An optional boolean — the Developer mode master switch, gating the local-AI Settings surface and its device-local model-path overrides, the device-local Tor-routing switch (MYND-650), and — since myne-md/myne#181 — two settings that stay in their own panels rather than moving into the Developer rail group: the CLI terminal-access block and the vim-mode toggle. `false` ≡ off (the default). **Omitted entirely when `false`**, so a vault that never enabled it is byte-identical to a pre-feature `vault.prefs` (existing golden vectors unaffected — a migration-less additive field on `MYP1`, the same emit-only-when-`true` positive-opt-in convention as `ai_enabled`). It sorts canonically between `deliberate_folders` and `device_names` (`deliberate_` < `developer_` < `device_`). A decoder that does not find the key MUST treat it as `false`. **Non-load-bearing / AS-low** — no protective-envelope clamp; a tampered or replayed value can at worst reveal or hide the developer-gated surface, never bypass the host-side gate that surface itself enforces. Phase 2 sync-merge classification (`sync-protocol.md` §10.2): **device-local** — the local value always survives the merge, for the same reason as `ai_enabled` / `attachment_ocr_enabled`, and the broadened membership only strengthens it: **every** setting the flag gates is itself device-local — `ai_enabled`, the three `cli_*` fields and `editor_vim_mode` here, and the Tor-routing switch, which is device-local by never entering this blob at all. A synced flag would carry visibility onto devices where nothing behind it applies, and for `editor_vim_mode` it would half-undo that field's own deliberate device-local classification (modal editing is an input-hardware choice; §10.2).

**`archived_folders` field (folder-archive).** A JSON array of canonical trailing-slash folder paths (e.g. `["Archive/2024/", "Projects/Old/"]`) — the carrier for folders archived as a **unit** (folder-archive): a folder in this set (and its whole subtree) leaves the working-set sidebar/tree while its notes stay resolvable (backlink/graph/search), the folder-level twin of the per-note `archived:` marker. Because folders are virtual, an archived folder has no note to carry a marker, so the set is the storage. **Same canonical array encoding as `deliberate_folders`** (elements NFC-normalized, lexicographically sorted, exact-deduplicated). The array is **omitted entirely when empty**, so a vault with no archived folders is byte-identical to a pre-feature `vault.prefs` (existing golden vectors unaffected, no outer-envelope change — a migration-less additive field on `MYP1`; sorts between `archive_disabled` and `auto_lock_seconds`). A decoder that does not find the key MUST treat it as the empty list. **Non-load-bearing** (AS-low): a replayed or tampered `vault.prefs` can at worst show or hide a folder subtree from the working set — no note is destroyed, decrypted, or moved — so it carries **no** protective-envelope clamp. Archiving writes **no** note frontmatter, so folder-archive composes independently with the per-note `archived:` layer. Conflict semantics for Phase 2 sync = union + add-wins (set semantics; no wall-clock, AS6-safe).

**`item_order` field (unified manual sidebar order, MYND-183; container-keyed since MYND-596).** A **container-keyed map** (`BTreeMap<String, Vec<String>>`) carrying the user's manual order across the unified sidebar file-tree. Each **key** is a container's identity — `""` ≡ the tree root, or a folder's **folded key** (its normalized-then-case-folded path, e.g. `projects/` — the `folderKey` identity the decoration maps `item_colors` / `folder_icons` key by, `markdown-dialect.md` §3.6.2, so the two clients derive byte-identical container keys); each **value** is that container's children in manual order, an order-preserving **sequence** of note UUIDs and full-path child folder **display** paths, freely interleaved and **discriminated by the trailing `/`** (a folder path ends in `/`; a note UUID does not). The client sorts the children of every container by each child's index in that container's value sequence, with children absent from it sorting after all listed siblings (notes by `updated:` descending, folders by folded name). Container membership is **structural, not encoded** (a note's container is its `folder:` frontmatter; a folder's container is its parent path); the map supplies only the per-container rank, so each container is ordered independently of the others. Canonical encoding: **keys** are **NFC-normalized** and emitted in **lexicographic** order (`BTreeMap`); each **value** sequence is **NFC-normalized** with **order preserved verbatim** — **NOT sorted and NOT deduplicated** (contrast `deliberate_folders`; the sequence is the payload). An empty value array is preserved verbatim (a container whose children were all removed but whose clock is still live). **Omitted entirely when the map is empty**, so a vault that never reordered is byte-identical to one without the key; a decoder that does not find it MUST treat it as the empty map. AS3-Sensitive (note IDs + folder structure); rides inside the AEAD-encrypted blob like every other field. The 64 KiB `MAX_PREFS_PLAINTEXT_LEN` cap (§9.5.4) bounds the practical number of explicitly-ordered items; beyond it a reorder write fails and the client falls back to the recency/name sort (a soft, recoverable degradation, not data loss). `item_order` **supersedes** the separate `note_order` / `folder_order` arrays of the pre-MYND-183 schema, and MYND-596 in turn **supersedes** its own earlier flat-sequence form (a pre-alpha clean redefinition, not an `MYP5` event — v0.1 is unfrozen, so no shipped vault carries a non-empty flat array; see the schema-evolution note below and `../decisions.md`). Phase 2 sync-merge classification: **shared** — merges per `sync-protocol.md` §10.2 (**per-container LWW**: each container races on its own `item_order/<container>` field-clock, so a reorder in one folder never clobbers a concurrent reorder in another — contrast the whole-list replacement of the pre-MYND-596 form).

**`favorites` field (MYND-183).** A **sequence**-semantics string array of **note UUIDs only** — the user's favorited notes, in display order, surfaced in a dedicated Favorites section pinned above the sidebar tree. A favorited note ALSO keeps its normal position in the tree (favoriting is a shortcut, not a move). Same canonical *element-sequence* encoding as an `item_order` container value: each element **NFC-normalized**, **order preserved verbatim**, **NOT sorted and NOT deduplicated** (`favorites` is a single flat sequence array, not a map). **Omitted entirely when empty**, so a vault with no favorites is byte-identical to one without the key; a decoder that does not find it MUST treat it as the empty list. A favorite UUID with no live note is ignored by the client at render time and pruned on the next write — there is no codec-level garbage collection. AS3-Sensitive (note IDs); rides inside the AEAD-encrypted blob. Phase 2 sync-merge classification: **shared** — merges per `sync-protocol.md` §10.2 (sequence-LWW-on-whole).

**`editor_layout` field (MYND-137).** An optional nested object carrying the editor's three-pane sidebar layout — `left_width` and `right_width` (non-negative integer pixels, the *last non-collapsed* width) and `left_collapsed` / `right_collapsed` (booleans). The four nested keys are themselves emitted in canonical (lexicographic) order: `left_collapsed`, `left_width`, `right_collapsed`, `right_width`. The whole object is **omitted entirely when unset** — i.e. when the user has never resized or collapsed a sidebar — so a vault that never touched the layout is byte-identical to a pre-MYND-137 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find the key MUST treat the layout as uncustomized and apply its own default widths. Widths are bare decimal integers (no leading zeros, no trailing `.0`); **floating-point is FORBIDDEN** and a fractional width rejects the parse. The min/max width clamps and the collapse policy are **NOT** stored here — they live in the client, so a replayed or tampered `vault.prefs` is re-clamped into the client's valid range on read (it cannot drive the UI to an unusable state). This field is AS-low (window-layout metadata only — no note content, no folder structure) yet still rides inside the AEAD-encrypted blob like every other field. Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices.

**`editor_content_width` / `editor_font_family` / `editor_line_spacing` / `editor_text_size` fields (editor-typography).** Four optional string fields carrying the editor's typography presets — `editor_text_size` (`sm`/`md`/`lg`/`xl`), `editor_line_spacing` (`tight`/`normal`/`relaxed`), `editor_content_width` (`narrow`/`normal`/`wide`/`full`), `editor_font_family` (`mono`/`sans`). Each is a **closed enum string** but is stored as a free string (the codec performs no value validation — like `daily_date_format`); the **client** is the single authority that maps a preset to a concrete CSS value and that maps a `null`/unknown value to that field's canonical default (`md` / `normal` / `normal` / `mono`). Each is **NFC-normalized** and **omitted entirely when unset** (the user kept the default), so a vault that never customized typography is byte-identical to a pre-feature `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — non-breaking migration-less additive fields on `MYP1`, exactly like the daily-notes fields). A decoder that does not find a key MUST treat it as unset; the client then applies the canonical default host-side. Their canonical positions interleave with `editor_layout`: `editor_content_width` < `editor_font_family` < `editor_layout` < `editor_line_spacing` < `editor_text_size` (all between `deliberate_folders` and `favorites`). Floats are not used (`editor_line_spacing` is an enum string, not a numeric line-height), keeping the codec float-free (the value is mapped to a concrete line-height client-side). All four are **non-load-bearing** cosmetic (AS-low): a replayed or tampered `vault.prefs` can at worst render the editor text at a different size/spacing/width/font — so, like `theme`, they carry **no** protective-envelope clamp (the unknown→default mapping on read is the only "clamp"). Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices.

**`active_workspace` field (named workspaces, MYND-308).** An optional string carrying the **stable slot id** of the currently-active [named workspace](../glossary.md) (the `{slots, active}` descriptor of §9.7; the workspace slot names + layouts themselves live in `vault.workspace`, NOT here). The pointer lives in `vault.prefs` rather than in `MYW1` deliberately: `vault.prefs` writes survive a crash, whereas `MYW1` writes only on graceful exit, so persisting the active pointer here lets the last-active workspace survive a crash within the coalesced write window (§9.7.4). It stores the **id**, not the display name, so renaming a workspace never rewrites it. **Consistency rule:** on unlock, if `active_workspace` names a slot the `MYW1` descriptor no longer holds, the client activates the first/default slot and self-heals on the next write. **NFC-normalized** and **omitted entirely when unset** — a vault with a single default workspace (the post-migration baseline) omits it and is byte-identical to a pre-MYND-308 `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change; a non-breaking migration-less additive field). It sorts canonically **first** (`a` < `auto_lock_seconds`). A decoder that does not find the key MUST treat it as unset (the client then defaults to the first slot). **Non-load-bearing** (a tampered or replayed value can at worst open a different or absent workspace, healed by the consistency rule): no protective-envelope clamp. Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices. (It points at the device-local `MYW1` artefact — a §10.2 reclassification, MYND-478.) Note that even though it points into `MYW1`, this pointer's write cadence follows the **coalesced** workspace cadence of §9.7.4 (≤ once per ~5 min + graceful exit), not a naive on-change `vault.prefs` write — see the §9.7.4 relaxation and `../threat-model.md` §7.

**`ai_enabled` / `ai_excluded_folders` fields (local-ai epic, MYND-406/408, SYNC-14).** Two optional fields carrying the on-device AI opt-in and its folder-exclusion set. `ai_enabled` is a bool — the **default-off** master switch for the experimental on-device AI, a runtime beta opt-in (the `local-inference` engine ships in the default build as of `decisions.md` 2026-07-02; this pref, not a build feature, is the user-facing gate); it is emitted **only when `true`** (the omit-when-false discipline of a positive opt-in, so a vault that never enabled AI is byte-identical to a pre-local-ai `vault.prefs`, and the at-rest "uses AI" fingerprint never leaks). `ai_excluded_folders` is a **set**-semantics string array of canonical trailing-slash folder paths the AI never reads, indexes, embeds, or grounds an answer on — same canonical encoding as `deliberate_folders` (**NFC-normalized**, **lexicographically sorted**, **exact-deduplicated**), **omitted entirely when empty**. A decoder that does not find a key MUST treat `ai_enabled` as `false` and `ai_excluded_folders` as the empty set. They sort canonically between `active_workspace` and `archive_disabled` (`ai_enabled` < `ai_excluded_folders`). `ai_enabled` is AS-low (a device-local capability flag, encrypted at rest so the fingerprint stays inside the AEAD envelope); `ai_excluded_folders` is **AS3-Sensitive** (folder paths) and rides inside the encrypted blob like every other field. Both are **non-load-bearing** in the protective-envelope sense (a replayed/tampered `vault.prefs` can at worst re-enable AI the user disabled or drop an exclusion — the local-prefs-replay known-limitation of [`../threat-model.md`](../threat-model.md) §7 already covers this, and the on-disk `vault.embeddings` cache is a *rebuildable* derived artifact that a fresh unlock reconciles). SYNC-14 enforcement of the exclusion set is **runtime, not codec**: the client applies it at embed-time, at query-time, and by purging already-embedded vectors when a folder is newly excluded (`../threat-model.md` §7). Phase 2 sync-merge classification (`sync-protocol.md` §10.2): `ai_enabled` is **device-local** (a per-device capability opt-in — the local value always survives the merge); `ai_excluded_folders` is **shared**, merging as a set-union — the exclusion is a vault-wide privacy declaration every device's embedder must honor. These are additive `MYP1` fields — no `§10.3` change, no new magic, no new `SubkeyRole` for the pref itself (the `vault.embeddings` cache has its own `ai-embeddings-key`, §9.17).

**`ai_provider` / `ai_provider_consent` / `ai_provider_key` / `ai_provider_model` fields (ai-remote-providers, myne#415, SYNC-15/SYNC-22/SYNC-24).** Four optional fields carrying the **remote** AI provider the user named, their one-time consent, the API key, and which of that provider's models answers. Governing decision: [`../decisions.md`](../decisions.md) 2026-08-09 "User-named AI providers, local and remote"; this entry documents only the codec shape. `ai_provider` is a string holding a closed wire value (`"ollama-cloud"` | `"openrouter"`), **omitted when unset** — and unset is not "off" but **unreachable**: with no provider named there is no remote path to reach. A decoder MUST treat an unrecognized value as no provider rather than rejecting the blob, so a vault written by a client that knows a newer provider still decodes. **The destination is NOT stored here** — each provider's base URL is a compiled-in client constant, so a tampered `vault.prefs` can select among the providers a build already knows but can never redirect traffic to a host of the attacker's choosing. `ai_provider_consent` records **which provider** the consent was given for, omitted until it is; it is a **gate**, not a display flag — the request path checks it, so a client whose UI skipped the screen still cannot send. It carries a provider name rather than a bare `true` because **consent is per provider**: the screen names the recipient, so an approval for one cannot stand in for another, and a request is permitted only when this value **equals** the active `ai_provider`. As a boolean, that invariant would depend on every writer remembering to clear the flag when the selection changes; as a name it is a comparison, and a stale approval is unusable rather than merely discouraged. Rotating the key therefore does not disturb consent (the recipient is unchanged), while switching provider invalidates it by construction. `ai_provider_key` is the provider API key, stored in the blob like any other encrypted vault content but carrying `#[serde(skip_serializing)]` in the reference implementation: `prefs_read` serializes the whole preference view to the WebView, so an independent implementation MUST likewise keep this value out of any host→UI payload and hand the UI a *has-key* boolean instead. It is also logging-DENY-listed. `ai_provider_model` is the model identifier the request names, **omitted until the user chooses one**. There is no default and an implementation MUST NOT substitute one: the value comes from the list the provider itself reports, because a model tag pinned by a client rots faster than the release that pinned it, and on a metered API a default nobody chose is a bill nobody chose. Absent, the remote arm has nothing to ask with and refuses — a refusal, never a silent substitution. Unlike the key beside it, it **does** cross the host→UI boundary: it is a published model name rather than a credential, and the settings surface renders the current selection back to the user. All four sort canonically between `ai_excluded_folders` and `archive_disabled` (`ai_provider` < `ai_provider_consent` < `ai_provider_key` < `ai_provider_model`). `ai_provider_key` is **AS1-class** (a bearer credential); `ai_provider` and `ai_provider_consent` are AS-low. None carries a protective-envelope clamp, and the reason is worth stating: a replayed `vault.prefs` can re-assert a consent the user has since withdrawn, which is the local-prefs-replay known-limitation of [`../threat-model.md`](../threat-model.md) §7 applied to a boundary that now sends data off-device — the mitigation is that revocation deletes the **key**, and without a key there is nothing to send. Phase 2 sync-merge classification (`sync-protocol.md` §10.2): all four are **shared** — one approval and one key cover the account, which means a newly enrolled device inherits them and sends without re-asking. That cost is accepted knowingly and is recorded in [`../threat-model.md`](../threat-model.md) §5 and the glossary rather than left to be discovered here. These are additive `MYP1` fields — no `§10.3` change, no new magic, no new `SubkeyRole`, no new AAD role.

**`date_format` / `time_format` / `timezone` fields (display date & time, myne#279).** Three optional string fields deciding how a date or a time is **displayed**. `date_format` is a closed enum (`system`/`iso`/`dmy`/`mdy`/`dmmmy`); `time_format` is a closed enum (`system`/`24h`/`12h`); `timezone` is an IANA zone identifier. Each is stored as a free string with **no codec-level validation** — the enum interpretation and the unknown-value→default fallback live on the client (the `editor_content_width` precedent class), so a value written by a newer build decodes as unset rather than failing the blob. Each is **NFC-normalized** and **omitted entirely when unset**, so a vault that chose no display format is byte-identical to a pre-feature `vault.prefs` (existing golden vectors unaffected — a migration-less additive field on `MYP1`; no new magic, no new `SubkeyRole`, no new AAD role, zero new crypto). `date_format` sorts canonically between `daily_template` and `deliberate_folders`; `time_format` and `timezone` sort between `theme` and `transcription_enabled`. All three are **non-load-bearing** (cosmetic, AS-low): a replayed or tampered `vault.prefs` can at worst print a date differently, so — like `theme` — they carry **no** protective-envelope clamp.

**These fields are display-side only, and `timezone` in particular does not walk back the zone-free on-disk rule.** `markdown-dialect.md` is normative that a note's stored date and time carry **no timezone offset and no zone identifier**: times are local wall-clock, because that is what a personal reminder means and because it keeps a coarse geolocation datum out of a file that gets exported as plaintext. `timezone` changes neither. It decides exactly two things: what the client treats as "today" (which tasks are overdue, due today, upcoming), and how a genuine **instant** — an attachment's `created_at`, which is UNIX seconds — is printed. A stored wall-clock value is never converted by it; converting one would invent an instant the user never wrote.

Phase 2 sync-merge classification (`sync-protocol.md` §10.2): `date_format` and `time_format` are **shared**, scalar-LWW — how a date is printed is taste, and a device-local value would mean re-choosing it on every new device (the `daily_date_format` class). `timezone` is **device-local**, deliberately unlike its two siblings and following `theme` instead: the right display zone is a property of where a given device *is*, and putting an IANA zone on the sync wire would hand back at the prefs layer the coarse geolocation datum the note layer refuses to carry.

**`auto_tag_enabled` field (on-device-tag-suggestion, MYND-651).** An optional boolean — the **default-off** master switch for automatic on-device tag suggestion (the inline [tag suggestion band](../glossary.md#tag-suggestion-band) fed by a bundled task-model; `../decisions.md` 2026-07-31). Emitted **only when `true`** (the same positive-opt-in omit-when-false convention as `ai_enabled` / `cli_enabled` / `developer_mode`), so a vault that never enabled it is byte-identical to a pre-feature `vault.prefs` (existing golden vectors unaffected — a migration-less additive field on `MYP1`; no new magic, no new `SubkeyRole`, no new AAD role, zero new crypto). A decoder that does not find the key MUST treat it as `false`. It sorts canonically between `auto_lock_seconds` and `bar_items_order` (`auto_l` < `auto_t` < `b`). AS-low (a capability flag, encrypted at rest so the at-rest "suggests tags" fingerprint stays inside the AEAD envelope). **Non-load-bearing** — no protective-envelope clamp, because the flag is only **half** of a two-key gate: the tag pass runs when `ai_enabled` **and** `auto_tag_enabled` are both on, and the client re-reads **both host-side** before it touches the model (`../threat-model.md` §7), so a tampered or replayed `vault.prefs` can at worst enable or disable a background computation that is independently gated — it can never start inference on a vault whose AI opt-in is off. Phase 2 sync-merge classification (`sync-protocol.md` §10.2): **shared**, scalar-LWW — deliberately unlike its co-gate `ai_enabled` (device-local) and following `transcription_enabled` instead: `ai_enabled` is device-local because it gates a device-local model-path override, while this one gates a **bundled task-model** every AI-capable client carries, so wanting automatic tags is taste rather than device capability. The pairing is what makes that safe: a synced `true` arriving on a device whose `ai_enabled` is off still runs nothing.

**`archive_disabled` field (archive-disable).** An optional boolean that disables the [archive](../glossary.md#archive) feature's UI entry points (the sidebar Archive button, the context-menu Arşivle actions). **Defaults to off** (archiving enabled — the pre-feature behaviour), so the canonical "unset" semantic is `false`: a decoder that does not find the key MUST treat it as `false`, and the client persists the field only when the user makes an explicit choice, **omitting it entirely when at the default-off state**, so a vault that never touched the toggle is byte-identical to a pre-feature `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — a non-breaking migration-less additive field, the `editor_line_numbers` precedent class). It sorts canonically between `active_workspace` and `auto_lock_seconds` (`ac` < `ar` < `au`). **Non-load-bearing** (a tampered or replayed value can at worst show or hide the archive controls; the underlying value-strict `archived:` frontmatter field — [`markdown-dialect.md`](markdown-dialect.md) §3.6.1 — is untouched, so already-archived notes stay decodable and a note is never stranded by the flag alone): no protective-envelope clamp. **Enabling the flag is a client-orchestrated transition**, not a codec concern: the desktop client auto-unarchives every currently-archived note (emptying the Archive) *before* persisting `archive_disabled: true`, so the hidden entry points never leave a note inaccessible. Phase 2 sync-merge classification: **shared** — merges per `sync-protocol.md` §10.2 (scalar-LWW).

**`editor_default_view_mode` field (reading-source modes, MYND-299).** An optional **closed-enum string** — `"live"`, `"reading"`, or `"source"` — carrying the user's chosen default [view mode](../glossary.md) for **newly-opened** note tabs (an already-open tab keeps its own per-tab `viewMode`, which rides the engine-opaque `MYW1` descriptor, NOT this blob — §9.7.2). The codec performs no value validation (like `daily_date_format`); the **client** maps a `null`/unknown value to the canonical default `"live"` (the cursor-aware live-preview surface). **NFC-normalized** and **omitted entirely when unset** (the user kept the `live` default), so a vault that never changed the default is byte-identical to a pre-MYND-299 `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — a non-breaking migration-less additive field exactly like the typography fields). It sorts canonically between `editor_content_width` and `editor_focus_dim_inactive`. Float-free (an enum string, never numeric). **Non-load-bearing** cosmetic (AS-low): a replayed or tampered value can at worst open new tabs in a different mode. Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices.

**`editor_focus_dim_inactive` / `editor_focus_typewriter` fields (focus mode, MYND-348).** Two optional booleans configuring the **behaviour** of [focus mode](../glossary.md) (the distraction-free `Mod-Shift-F` state — whose *active* on/off state is **ephemeral** UI state, deliberately NOT persisted to any blob): `editor_focus_dim_inactive` gates [line-focus dimming](../glossary.md) (dim every line except the active one) and `editor_focus_typewriter` gates [typewriter scroll](../glossary.md) (keep the active line vertically centered). **Both default ON**, so the canonical "unset" semantic is on — a decoder that does not find a key MUST treat it as `true`; the client persists a field only when the user toggles it **off** (or back on after an off), and **omits it entirely when at the default-on state**, so a vault that never tuned focus mode is byte-identical to a pre-MYND-348 `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — non-breaking migration-less additive fields). They sort canonically between `editor_default_view_mode` and `editor_font_family` (`editor_focus_dim_inactive` < `editor_focus_typewriter`). Both are **non-load-bearing** cosmetic (AS-low): a replayed or tampered value can at worst toggle a focus-mode reading aid. Both honor `prefers-reduced-motion` at the render layer. Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices.

**`theme` field (MYND-110).** An optional string carrying the user's explicit theme choice — `"light"` or `"dark"`. **Absence of the key is the canonical encoding of "system"** (follow the OS `prefers-color-scheme`): there is no `"system"` value, so a vault that made no explicit choice **omits the field entirely** and is byte-identical to a pre-MYND-110 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find the key MUST treat the preference as "system"; the client then follows the OS. The field is canonical key **last** (`theme` sorts after `screen_capture_protection`). A decoder reading an **unrecognized** string value (a hypothetical future `"sepia"`) MUST treat it as "system" — an unknown value is tolerated like an unknown field, **never** a parse failure, because `theme` is **non-load-bearing**: it is a cosmetic UI preference (AS-low), carries **no** protective-envelope clamp (unlike `auto_lock_seconds`), and a tampered or replayed `vault.prefs` can at worst surface the wrong color. The theme choice rides inside the AEAD-encrypted blob like every other field rather than in a plaintext config — a plaintext theme token would leak a behavior fingerprint at rest, the same structural-privacy argument that keeps `auto_lock_seconds` encrypted. Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices. (A §10.2 decision, MYND-478: presentation is per-device taste.)

**`folder_icons` field (MYND-185).** An optional nested object mapping a canonical trailing-slash folder path to an icon name — the user's custom sidebar icon for that folder, replacing the default folder glyph. Keys are folder paths (**NFC-normalized**, emitted in **lexicographic** order); values are names drawn from a curated client-side stroke-glyph set (**no** arbitrary or uploaded icon, **no** emoji). The object is **omitted entirely when empty**, so a vault that assigned no folder icon is byte-identical to a pre-MYND-185 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find the key MUST treat it as the empty map; an entry whose folder no longer exists, or whose value names an unknown icon, is ignored by the client at render time and pruned on the next write — there is no codec-level garbage collection. On folder rename/move the client **prefix-rewrites** the affected keys, and on folder delete it **prunes** them (the same `deliberate_folders` path-rewrite discipline). AS3-Sensitive (folder structure); rides inside the AEAD-encrypted blob like every other field. **Non-load-bearing** (cosmetic, AS-low): like `theme`, it carries **no** protective-envelope clamp and a tampered or replayed `vault.prefs` can at worst surface the wrong glyph. Phase 2 sync-merge classification: **shared** — merges per `sync-protocol.md` §10.2 (whole-value LWW — the whole map is replaced by the newer clock).

**`hidden_bar_items` field (bottom-bar customization).** An optional **set**-semantics string array of bottom-bar element ids the user chose to hide via the bar's right-click menu — a closed, non-secret UI vocabulary (`sync-status`, `save-status`, `tags`, `views`, `graph`, `settings`, `lock`, `word-count`). Same canonical encoding as `deliberate_folders` / `spell_languages`: each element **NFC-normalized**, **lexicographically sorted**, **exact-deduplicated** (the element set is the value; order is not). **Omitted entirely when empty** — the default, a fully-visible bar — so a vault that hid nothing is byte-identical to a pre-feature `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — a **non-breaking, migration-less additive field** on the existing `MYP1` format, exactly like `label`). A decoder that does not find the key MUST treat it as the empty set; an id outside the closed vocabulary is ignored by the client at render time and pruned on the next write (no codec-level garbage collection). It sorts canonically between `folder_icons` (`f`) and `item_colors` (`i`). AS-low (UI-layout metadata only — no note content, no folder structure) yet still rides inside the AEAD-encrypted blob like every other field. **Non-load-bearing**: no protective-envelope clamp — a tampered or replayed `vault.prefs` can at worst hide or reveal a bar affordance (every hidden affordance has another reach: Settings via `Cmd+,`, lock via auto-lock; and the bar itself stays right-clickable to restore). Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices. (A §10.2 reclassification, MYND-478: the bar layout is screen-size-dependent.)

**`item_colors` field (MYND-184).** An optional nested object mapping a sidebar item — a note UUID **or** a canonical trailing-slash folder path, **discriminated by the trailing `/`** exactly as `item_order` discriminates its elements — to a color-slot name, the user's color label for that note or folder (rendered as a small dot). Keys (**NFC-normalized**, emitted in **lexicographic** order) are heterogeneous note-IDs and folder paths in one map; values name a fixed, bounded, theme-aware palette of color slots (**no** arbitrary hex). The object is **omitted entirely when empty**, so a vault that assigned no color is byte-identical to a pre-MYND-184 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change). A decoder that does not find the key MUST treat it as the empty map; an entry whose note/folder no longer exists, or whose value names an unknown slot, is ignored at render time and pruned on the next write. A **note**-keyed entry is stable across note rename/move (the UUID is the filename); a **folder**-keyed entry is prefix-rewritten on folder rename/move and pruned on folder delete (the `deliberate_folders` discipline). AS3-Sensitive (note IDs + folder structure); rides inside the AEAD-encrypted blob. **Non-load-bearing** (cosmetic, AS-low): no protective-envelope clamp; a tampered or replayed `vault.prefs` can at worst surface the wrong color. Phase 2 sync-merge classification: **shared** — merges per `sync-protocol.md` §10.2 (whole-value LWW).

**`label` field (in-app vault switcher, MYND-205).** An optional string carrying the user's human-readable name for this vault — the name the in-app vault switcher shows. **Omitted entirely when unset**, so a vault that never set a label is byte-identical to a pre-MYND-205 `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — this is a **non-breaking, migration-less additive field** that rides the existing `MYP1` format, exactly like `auto_lock_seconds` and `theme` did; adding it is **not** a major-version event). The value is **NFC-normalized** per the general string rules; it sorts canonically between `item_order` (`i`) and `screen_capture_protection` (`s`). A decoder that does not find the key MUST treat the vault as unlabelled; the client then shows a neutral fallback (`Vault N`). The label lives **encrypted-only** inside `vault.prefs` (never in the on-disk vault registry or the `vaults/<id>/` directory name, which are deliberately decoupled from any per-vault content — see §9.4 / SYNC-3): a filesystem adversary sees only the AEAD ciphertext. It is decrypted into a per-session RAM cache on unlock and is the user's own input on write; it never crosses IPC or touches disk in plaintext otherwise. AS3-Sensitive (a vault name can carry identifying context); rides inside the AEAD-encrypted blob like every other field. **Non-load-bearing** (cosmetic display, AS-low): no protective-envelope clamp — a tampered or replayed `vault.prefs` can at worst surface the wrong display name. Renaming is **unlock-gated by construction** (writing needs `prefs_key`, which only exists for the active/sole-`Unlocked` vault). Phase 2 sync-merge classification: **shared** — merges per `sync-protocol.md` §10.2 (scalar-LWW on the `label` field clock — the vault name follows the vault).

**`keymap` field (rebindable hotkeys, MYND-304).** An optional nested object mapping a command id to an array of **canonical chord strings** — the user's keyboard-shortcut **overrides**. Keys are command ids from the frozen command registry (e.g. `graph.show`) plus the window-level command ids (e.g. `nav.back`, `pane.split-row`); they are load-bearing once persisted (renaming a persisted id is a migration concern). **Overrides only — defaults live in code**, so the effective binding a client applies is `override ?? default`: a command **absent** from the map uses its in-code default; a **non-empty** array overrides it to those chords; an **empty array `[]`** is an *explicit unbind* (the command has no shortcut) — a distinct, meaningful state preserved verbatim, NOT the same as absent. Keys are **NFC-normalized** and emitted in **lexicographic** order; each chord array is **set-canonical** (NFC-normalized, lexicographically sorted, exact-deduped — binding order does not affect dispatch). A **chord string** is the canonical, CodeMirror-`KeyBinding.key`-compatible form: `-`-separated modifier tokens then one logical key (e.g. `Mod-Shift-g`), using the cross-platform `Mod` token stored **unresolved** (Cmd on macOS, Ctrl elsewhere) so a keymap is portable across OSes for Phase-2 sync, the layout-respecting *logical* key, and lowercased single-character keys; **floating-point is FORBIDDEN** (chords are strings, never numeric keycodes). The object is **omitted entirely when empty**, so a vault that never rebound a shortcut is byte-identical to a pre-MYND-304 `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — a **non-breaking, migration-less additive field** on the existing `MYP1` format, exactly like `label`; adding it is **not** a major-version event, and there is no new magic, no §10.x allocation, no new `SubkeyRole`). It sorts canonically between `item_order` (`i`) and `label` (`l`). A decoder that does not find the key MUST treat it as the empty map (no overrides → all defaults); an unknown command id or an unparseable chord string is ignored by the client at read time (it falls back to the command's default), but a structurally malformed value — e.g. a non-array — is a `PlaintextParseFailed` reject. AS-low (a user's specific bindings are mildly fingerprintable) yet rides inside the AEAD-encrypted blob like every other field. **Non-load-bearing**: no protective-envelope clamp — a tampered or replayed `vault.prefs` can at worst rebind or drop a shortcut, and every command remains reachable via the command palette. The keymap binds chords only to **existing** command ids — it can never introduce a new command or user-defined behavior (no-code-eval / no-plugin-API, [`../vision.md`](../vision.md)). Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices.

**`last_backup_at` field (MYND-58, vault-backup-restore epic).** An optional non-negative integer — the Unix epoch **seconds** of the vault's last successful backup export (§9.11). **Omitted entirely when unset** ("never backed up"), so a vault that never exported a backup is byte-identical to a pre-MYND-58 `vault.prefs` (existing golden vectors unaffected, no outer-envelope change — a migration-less additive field exactly like `auto_lock_seconds`). A decoder that does not find the key MUST treat it as unset. The value is a bare decimal integer; **floating-point is FORBIDDEN** and a fractional value rejects the parse. The field is written by an export performed on an **unlocked** vault; a locked export (§9.11 permits one — the copy needs no key material) cannot update it, because writing `vault.prefs` requires `root_key` — accepted, since the field only drives a best-effort reminder ("you haven't backed up in N days", checked client-side after unlock). Because `vault.prefs` is itself a backup member, a restored vault's `last_backup_at` reflects the export moment — which is accurate. It sorts canonically between `label` (`lab` < `las`) and `screen_capture_protection`. **Non-load-bearing** (a tampered or replayed value can at worst suppress or force a reminder): no protective-envelope clamp. Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices. (Inherently per-device: one device's backup time must never overwrite another's.)

**`paired_extensions` field (browser-clipper pairing-token registry, MYND-443).** An optional JSON array of browser-extension pairing-token records — the issued + revoked tokens that authorize the keyless browser clipper to hand off clips (TB10 / A14; the registry the host's `TokenRegistry` re-validates every relayed frame against). Each element is a canonical-JSON object with the keys `extension_id` (string — the exact extension id the token is bound to), the optional `paired_at` (integer — Unix epoch **seconds** of the in-app Accept that issued the pairing; a **user-meaningful timestamp**, so it lives here inside the encrypted blob per the [`CLAUDE.md`](../../CLAUDE.md) commitment), `revoked` (bool — a revoked record keeps its row, **append-only**: a re-pair appends a fresh non-revoked record while the dead one stays), and `token_value` (string — the opaque bearer value, hex of 32 CSPRNG bytes). Per-record keys are emitted in lexicographic order — `extension_id` < `paired_at` < `revoked` < `token_value` — and the array is encoded **sorted by `(extension_id, token_value)`** for byte-stability. `paired_at` is an **additive optional sub-field**: omitted from a record's canonical JSON when absent, so a pre-`paired_at` record is byte-identical to its earlier encoding (existing golden vectors unaffected). The array is **omitted entirely when empty**, so a vault that never paired an extension is byte-identical to a pre-MYND-443 `vault.prefs` (no outer-envelope / magic change — a **non-breaking, migration-less additive field** on the existing `MYP1` format, exactly like `label` / `saved_views`; **no new magic, no new `SubkeyRole`, no new AAD role, zero new crypto** — the registry rides the existing `prefs_key` envelope). A decoder that does not find the key MUST treat it as the empty list (the extension must then re-pair — never a partial/injected grant, §9.5.5). It sorts canonically between `last_backup_at` (`l`) and `saved_views` (`s`). AS3-Sensitive (it correlates a browser install with this vault); rides inside the AEAD-encrypted blob like every other field — and the `token_value` bearer secret is **never** serialized back across the WebView IPC boundary (`#[serde(skip_serializing)]`; the Settings UI reads `extension_id` + `paired_at` only, via the dedicated `pairing_list_paired` command). **The token's scope ceiling is structurally fixed host-side and NEVER persisted here** (`create-clip` + `is-unlocked-status` only — the record cannot express it), so a replayed or tampered `vault.prefs` can only revert the registry to an earlier state (the local-prefs-replay known-limitation of [`../threat-model.md`](../threat-model.md) §7) — it can **never widen a grant**, because a resurrected token still fails the exact-extension-id + scope checks. `paired_at` is **display-only** and never part of validation. Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices. (Pairings are bound to this machine's native-messaging host manifest; the registry never crosses devices.)

**`saved_views` field (Saved Views epic, MYND-273).** An optional JSON array of saved-view definition objects — the user's hand-built filter/sort/group projections over their notes (the "Saved Views" feature). Each element is a canonical-JSON object with the keys `id` (string, stable view id), `name` (string), `view_type` (string — `"table"` / `"cards"` / `"list"`; `"map"` is deliberately NOT a value, it needs a Maps plugin), `filters` (a recursive filter-AST object — see below), and the optional `card_size` (integer pixels), `columns` (string array, sequence semantics — the display columns), `group_by` (string property key), `image` (string — the cover-image frontmatter property name, resolved via `attachment://` by the renderer; NOT pixels), `image_aspect_ratio` (**string**, e.g. `"1.65"` — carried as a string because Obsidian's `.base` aspect ratio is a float and **floating-point is FORBIDDEN** in this canonical JSON), and `sort` (a nested `{"direction":"asc"|"desc","key":<string>}` object). Per-object keys are themselves emitted in lexicographic order; an over-the-cap or absent optional sub-field is omitted. The **`filters` AST** is a CLOSED allow-list (no arithmetic, no `list.map`/formula node — the type cannot express one): a node is one of `{"kind":"and","children":[…]}`, `{"kind":"or","children":[…]}`, `{"kind":"not","child":{…}}`, `{"kind":"hasTag","tag":<string>}` (subtree-inclusive), `{"kind":"inFolder","path":<string>}` (subtree-inclusive), `{"kind":"search","query":<string>}`, `{"kind":"property","key":<string>,"op":<op>,"value":<string>}` (where `<op>` is one of `== != > < >= <= contains`; date comparison operates on frontmatter date properties only), or the degenerate `{"kind":"all"}`. The array is encoded **sorted by view `id`** (set-canonical for byte-stability; the *display* order is the separate `view_order` sequence) and is **omitted entirely when empty**, so a vault with no views is byte-identical to a pre-MYND-273 `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — a **non-breaking, migration-less additive field** on the existing `MYP1` format, exactly like `label`; adding it is **not** a major-version event, and there is no new magic, no §10.6 / §10.x allocation, no new `SubkeyRole`, no §9.11.3 amendment). A decoder that does not find the key MUST treat it as the empty list. Obsidian-Bases `formulas` / `summaries` / `properties-display` blocks are **not representable** (no key carries them) and are **dropped** on `.base` import (accepted-lossy) — the schema never implies an evaluator Myne does not ship (no-code-eval, [`../vision.md`](../vision.md)). View definitions are **authored content** (they must survive a property-index rebuild and a vault restore), which is why they live here in the backed-up + sync-member `vault.prefs` rather than in the rebuildable `MYI1` index (§9.8). The 64 KiB `MAX_PREFS_PLAINTEXT_LEN` cap (§9.5.4) bounds the practical view count — a save that would exceed it fails the encode (a soft, recoverable degradation: the new/edited view is not saved, existing views and prefs are untouched), and a future decision promotes saved views to a dedicated blob + KEK role if a vault ever approaches the cap. AS3-Sensitive (a view's name / filter / referenced property); rides inside the AEAD-encrypted blob like every other field. **Non-load-bearing** (no protective-envelope clamp; a tampered or replayed `vault.prefs` can at worst reset views to empty or surface a stale view — the local-prefs-replay known-limitation of [`../threat-model.md`](../threat-model.md) §7 already covers this). Phase 2 sync-merge classification: **shared** — merges per `sync-protocol.md` §10.2 (whole-value LWW on the canonical `saved_views` encoding).

**`view_order` field (Saved Views epic, MYND-273).** An optional **sequence**-semantics string array of saved-view `id`s in display order — the order the views list and the sidebar Views section render (SYNC-10). Same canonical encoding as `item_order` / `favorites`: each element **NFC-normalized**, **order preserved verbatim**, **NOT sorted and NOT deduplicated** (the order *is* the value). **Omitted entirely when empty**, so a vault that never reordered its views is byte-identical to a pre-MYND-273 `vault.prefs`; a decoder that does not find it MUST treat it as the empty list. It sorts canonically **last** (`view_order` follows `theme`: `t` < `v`). An id with no live view (a deleted view) is ignored by the client at render time and pruned on the next write — there is no codec-level garbage collection (the `favorites` discipline). AS3-Sensitive (view ids); rides inside the AEAD-encrypted blob. **Non-load-bearing** — no protective-envelope clamp. Phase 2 sync-merge classification: **shared** — merges per `sync-protocol.md` §10.2 (sequence-LWW-on-whole).

**`right_panel_active_tab` / `right_panel_hidden_tabs` / `right_panel_tab_order` fields (right-panel tabs).** Three optional fields persisting the editor's multi-tab right panel (the Backlinks / Unlinked-mentions / Outline tabs, modeled on the bottom bar). They are the right-panel twins of the bottom-bar customization fields and follow those disciplines exactly: `right_panel_active_tab` is an `active_workspace`-class free **string pointer** to the tab the editor restores (NFC-normalized, the client owns the unknown-id → host-default interpretation; **consistency rule:** on read, if it names a hidden or unknown tab the client falls back to the first visible tab and self-heals on the next write, never auto-clearing on a transient miss); `right_panel_hidden_tabs` is a `hidden_bar_items`-class **set** (NFC-normalized, lexicographically sorted, exact-deduped); `right_panel_tab_order` is a `bar_items_order`-class **sequence** (NFC-normalized, order preserved verbatim, NOT sorted/deduped — a known tab absent from the array falls back to its canonical default position, an unknown id is ignored at render and pruned on the next write, no codec-level GC). Each is **omitted entirely when default** (pointer unset, set empty, sequence empty), so a vault that never customized the right panel is byte-identical to a pre-feature `vault.prefs` (existing golden vectors unaffected, no outer-envelope / magic change — non-breaking, migration-less additive fields on the existing `MYP1` format; no new magic, no new `SubkeyRole`, no new AAD role, zero new crypto). The three keys sort canonically between `paired_extensions` and `saved_views` (`p` < `right_panel_active_tab` < `right_panel_hidden_tabs` < `right_panel_tab_order` < `sav`). AS-low (a UI affordance set); ride inside the AEAD-encrypted blob like every other field. **Non-load-bearing** (a tampered or replayed value can at worst reorder, hide, or reselect a tab — healed by the consistency rule) — no protective-envelope clamp. Phase 2 sync-merge classification: **device-local** — the local value always survives the `sync-protocol.md` §10.2 merge; it never crosses devices.

**Schema evolution within v0.1:** Additive — new fields MAY be appended in any v0.1.x minor revision and are read by older v0.1 clients as unknown-and-ignored (per the implementation's serde discipline; older clients SHOULD NOT reject unknown fields). The MYND-110 `theme` field is the textbook additive case: a new optional key whose absence the older client already treats as a default, with the omit-when-unset rule keeping pre-`theme` vaults byte-identical. The MYND-185 `folder_icons` and MYND-184 `item_colors` maps are further textbook additive cases — new optional keys, omit-when-empty, unknown-and-ignored by older clients. Field removal, type changes, and structural restructuring are MAJOR-version events (MYP5). The MYND-183 replacement of `note_order` / `folder_order` with the unified `item_order` is **not** such an event: it is a **pre-release redefinition** of the v0.1 schema, made while Myne is pre-alpha with no shipped vaults — there is no frozen on-disk format to break, so no migration and no major-version bump apply. Performed post-freeze, the same field swap *would* require MYP5; the exception holds only because no v0.1 vault exists in the wild yet (see `../decisions.md`). The same exception covers the MYND-596 retyping of `item_order` from a flat sequence array to a container-keyed map (§9.5.2): that is a **type change** — an MYP5 event if performed post-freeze — but it is a pre-release redefinition here for the identical reason (v0.1 is unfrozen, no shipped vault carries a non-empty flat `item_order`).

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

The reserved byte at offset 5 MUST be `0x00`. Non-zero values reject the parse, matching the §9.2 and §9.3 discipline. The byte is reserved for v0.1 minor-revision flag carrying. The cap bounds `ciphertext_len`, not the file's total length: per §10.3.1 a `vault.prefs` MUST be exactly `34 + ciphertext_len` bytes, and a file longer than that rejects the parse.

*Content-scaled fields and the reserved budget* (myne-md/myne#613). The "~13x headroom" above assumes every field is **feature-scaled**: one more preference is one more key, so the plaintext grows with the number of features, and a cap chosen once stays generous indefinitely. `deliberate_folders` is the first field that is **content-scaled**, meaning its size grows with how many folders the user has, which the implementation does not bound and the user does not think of as a setting. A content-scaled field shares a fixed cap with every feature-scaled one, and an over-cap save FAILS rather than truncating (§9.5.5's fall-back-to-defaults covers the READ side only), so with no bound the failure mode is that a large vault stops being able to save ANY preference.

Implementations MUST therefore bound the WHOLE canonical `vault.prefs` plaintext, live set entries and retained `field_clocks` tombstones together, below the cap with headroom, and MUST refuse individual additions past it rather than failing the write. The bound is on the blob, not on a field: five set fields share one cap, so a per-field share cannot be granted to each of them, and a per-field estimate can see neither the other four fields nor the retained clocks below. The reference implementation bounds the measured plaintext at the cap less 4 KiB. (An earlier draft of this paragraph mandated a per-field reserve and then described the reference implementation not doing that, which would have had an independent implementer build the design a review had already rejected.) Two properties of that refusal are normative rather than incidental. Refusals are **ordered**: additions are considered shallowest-first, then alphabetically, so what survives a full budget is the vault's top-level structure rather than an arbitrary slice, and the limit stays explainable to the user. And a **removal is never refused**, since shrinking a set cannot overflow it, and a budget able to block a deletion would trap a user whose only remedy is deleting.

*Removal clocks are retained indefinitely and are inside the bound.* A `field_clocks` entry outlives the set entry it belonged to, by design (`sync-protocol.md` §10.2: dropping it lets a third device resurrect what two others deleted), so a vault that creates and deletes folders accumulates them with no horizon. They are part of the plaintext and therefore part of what the bound measures. An implementation that bounded a field's live entries alone would report room in a blob already past the cap, which is the failure this whole paragraph exists to prevent, arriving through the one component the estimate could not see. Measuring the encoded plaintext rather than estimating one field is what makes the bound honest, and it is what the reference implementation does.

This paragraph sits here rather than in §9.5.2 because it is the property the NEXT content-scaled field should be checked against, not a fact about folders.

#### 9.5.5 Migration-less semantic

Reading `vault.prefs` returns the persisted preference set on success, or the **default preference set** on any failure:

- File absent on disk → defaults.
- File truncated, or longer than the declared layout (§10.3.1), or magic-byte mismatch, or non-zero reserved byte → defaults.
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
5       1 byte     index_format_version   0x01 = the v0.1 codec inner-plaintext format
                                          (§9.6.2). Distinct from protocol_version: a
                                          future ENGINE / codec-serialization change bumps
                                          THIS byte. The inner snapshot's own schema is
                                          the desktop's concern (it carries an
                                          attachment-text extractor_version, §9.6.2/§9.6.4,
                                          §9.15) and evolves without bumping this byte —
                                          an older snapshot simply fails to decode and is
                                          rebuilt. A bumped byte makes an old decoder reject
                                          the blob and fall
                                          to rebuild (§9.6.4) rather than mis-parsing it.
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

The inner plaintext is an **`index_format_version`-tagged opaque payload**: this specification does NOT fix its internal structure, because the search engine is a client-implementation choice this layer must not constrain. For `index_format_version 0x01` the payload is a [postcard](https://docs.rs/postcard)-serialized snapshot of four parts:

1. a **staleness manifest** — a map `note_id → content_nonce` recording, for each indexed note, the `.myn` `content_nonce` (§9.2) observed when it was indexed;
2. the **serialized inverted index** — the v0.1 custom BM25 inverted index (postings, per-document metadata, per-note detected language). As of MYND-448a the index holds **two document kinds**: a note's own body doc (keyed by the bare `note_id`, indexed with the note's plaintext) and, per embedded attachment, that attachment's extracted text as its **own** doc keyed `att:<attachment_id_hex>:<note_id>` — so an attachment-content hit surfaces with its own provenance rather than being folded into the embedding note;
3. the **`extractor_version`** (MYND-328) — the attachment-text extractor generation (§9.15) whose output is indexed as the attachment docs, a `u8`. A snapshot whose `extractor_version` differs from the client's current value (or, for a pre-MYND-328 snapshot, is absent — which manifests as a postcard decode failure since the format is non-self-describing) is rejected → rebuild (§9.6.4); and
4. the **`schema_version`** (MYND-448a) — the index doc-MODEL generation, a trailing `u8`, **independent of `extractor_version`**. `v2` = the separate-attachment-doc model above; a pre-448a snapshot (folded note bodies, no attachment docs) carries a `v1` model or lacks the field entirely, so it is rejected → rebuild into the new model. Keeping this separate from `extractor_version` lets the doc-model change force a search rebuild WITHOUT invalidating the MYE1 extracted-text caches (§9.15).

All four parts ride INSIDE the AEAD envelope — the first two by necessity: the manifest holds `note_id`s + `content_nonce`s, and the index holds plaintext-derived terms + titles — all confidential vault content (`note_id` / `content_nonce` are per-note correlation tags; terms/titles are note plaintext). None may appear in the cleartext header. Because the payload is engine-opaque, a v0.1 client that ships a different **index engine / postings encoding** bumps `index_format_version` so older decoders reject the envelope and rebuild. An *additive* evolution of the snapshot struct itself — such as the MYND-328 trailing `extractor_version` field or the MYND-448a trailing `schema_version` field — does **not** bump the byte: postcard is non-self-describing, so an older snapshot that lacks a trailing field simply fails to decode and is rebuilt (the §9.6.4 fall-to-rebuild path), and the byte continues to denote "the v0.1 codec inner-plaintext format". The byte tracks the codec/engine format; the snapshot's own additive schema versioning is the desktop's concern (the `extractor_version` + `schema_version`, §9.6.4).

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

The v0.1 inner snapshot additionally records the **`extractor_version`** (§9.15) its attachment docs were built under and the **`schema_version`** doc-model generation (MYND-448a) — both trailing fields of the engine-opaque payload, so an older snapshot that lacks them simply fails to decode → rebuild. A stored `extractor_version` that differs from the client's current value triggers a **rebuild** even when every `content_nonce` matches — so an improved extractor (the audio-ASR generation `0x02`, or the image-OCR generation `0x03`, MYND-441) re-extracts the `att:` attachment docs (§9.6.2) rather than serving stale tokens; a mismatched `schema_version` rebuilds likewise when the doc model itself changes, without invalidating the MYE1 extracted-text caches (§9.15). Both are the inner-schema analogue of the `index_format_version` reject-and-rebuild — scoped to attachment-derived content and the doc model respectively — and owned by the desktop codec rather than the protocol envelope byte.

**Rebuild does not itself perform OCR (MYND-441).** The model-backed extraction generations cost seconds per page, which would stall the rebuild — and with it the first search after unlock — for as long as it takes to read every scanned document in the vault. The rebuild therefore runs only the deterministic extractors and reports image / scanned-PDF candidates as `unsupported`, a status the backfill declines to cache (§9.15.4). Those attachments end the rebuild with **no cache blob**, and a background worker drains exactly that set while the vault stays unlocked, refreshing each embedding note's `att:` docs as it goes. The absence of a cache blob *is* the queue state, so nothing extra is persisted and an interrupted run loses only ordering. A PDF is deferred only after its (cheap) text layer has been tried and produced nothing, so a PDF with selectable text is still fully indexed by the rebuild.

**Fall-to-rebuild** is the fallback when incremental reconcile is impossible or untrusted: `vault.search` absent, magic / version mismatch, AEAD verification failure, an unreadable manifest, or a mismatched/absent snapshot `extractor_version` or `schema_version` (MYND-448a). The client then rebuilds the index from scratch by decrypting every `.myn` (and re-reading attachment-text caches, §9.15). The `content_nonce` is NOT a security signal — it is only an optimization hint; a rebuild never trusts the cache. Because rebuild always recovers the correct index, `vault.search` carries no integrity-of-search burden: a disk attacker who deletes or corrupts it costs the user one slower unlock, nothing more.

#### 9.6.5 Residency, size cap, and fall-back semantic

**Residency.** The decrypted index is RAM-resident only while the vault is `Slot::Unlocked`. It is zeroized on the same path as the keys at **every** slot-drop site — manual lock, idle auto-lock, vault deletion, and the credential-rotation force-relock (an external `vault.meta` mutation detected mid-change drops the slot) — with terms, titles, and note ids overwritten before the backing allocations free. Manual lock/quit flush it to `vault.search` first (persist-then-wipe); idle auto-lock skips the flush (fail-closed — no blob-write latency on the idle path) and the next unlock rebuilds the missing delta. Nothing search-derived survives a lock.

**Size cap.** Implementations SHOULD reject `ciphertext_len > 268435456 + 32` (256 MiB plaintext cap + 32-byte CTX tag), bounding the parser's pre-AEAD allocation — parallel to the §9.2 / §9.5.4 cap rationale. The 256 MiB cap is well above the benchmarked 10k-note index and leaves generous headroom.

**Fall-back semantic.** Reading `vault.search` returns the loaded index on success, or triggers fall-to-rebuild (§9.6.4) on any failure — the non-distinguishing-error discipline of §6.4 / §9.5.5, applied to search. An attacker with disk-write access can only force a rebuild (a slower unlock); arbitrary index injection requires breaking the AEAD (§6.4). Cross-vault: a `vault.search` from vault A fails AEAD under vault B's `search_index_key` (different `root_key`) and `AAD_search_index_blob` (different `account_number_hash`).

**At-rest leakage.** The blob's size leaks a coarse signal about indexed vocabulary / total volume, analogous to the `.myn`-count leak — accepted for v0.1 ([`../threat-model.md`](../threat-model.md) A5 / §7).

### 9.7 Editor workspace-state blob (`vault.workspace`)

`vault.workspace` is a vault-level singleton artifact carrying the editor's **workspace state** (MYND-166): the open-tab set per pane, the recursive pane-split layout, each pane's active tab, the focused pane, and per-tab cursor/scroll positions. It lives next to `vault.meta` at `<vault-root>/vault.workspace` and is AEAD-encrypted under `session_state_key = DeriveSubkey(root_key, "session-state-key")` (§3.2 + §3.4). The open-note set + layout is **activity metadata** (AS3-Sensitive: note ids + structure); persisting it as plaintext local app state would leak which notes a user keeps open — and, via file mtime, *when* they switch between them — to a filesystem adversary (A4/A7). Sealing it under AEAD with a graceful-exit-only write cadence (below) keeps that signal inside the encrypted envelope.

Like `vault.search` (§9.6) and unlike `vault.prefs` (§9.5), the inner plaintext is **opaque to this layer** — the desktop client serializes the (variable, evolving) pane tree and the codec treats it as raw bytes. The `workspace_format_version` byte at offset 5 carries the client's inner-schema version for forward-compat; named workspaces (MYND-308) ticked it `0x01 → 0x02` (§9.7.2).

The descriptor also carries the **sidebar file-tree folder-expand set** (MYND-455) — the folded keys of folders the user has open, at the container level (one window-global set, not per named workspace). It is the same AS3 activity-metadata class as the open-tab set (folder paths, already sealed here) and so adds **no new asset**; it rides inside the opaque inner plaintext, added omit-when-default, so it required **no** `workspace_format_version` bump (the named-workspaces precedent). A crash between coalesced flushes loses at most the last few expand/collapse toggles — acceptable under the §9.7.4 best-effort cadence.

#### 9.7.1 Outer envelope layout

```text
Offset  Size  Field                     Notes
------  ----  ------------------------  ----------------------------------
0       4     magic                     ASCII "MYW1"
4       1     protocol_version          0x01
5       1     workspace_format_version  0x02 = the named-workspaces {slots,
                                        active} inner schema (MYND-308); 0x01 =
                                        the original single-workspace schema. An
                                        unknown / older value falls to default
                                        (§9.7.2, §9.7.4)
6       24    nonce                     XChaCha20-Poly1305 nonce
30      4     ciphertext_len            big-endian uint32, plaintext_len + 32
34      M     ciphertext                AEAD ciphertext + 32-byte CTX tag T'
```

Header is 34 bytes, identical in shape to §9.5.1 / §9.6.1 except offset 5 carries `workspace_format_version` (the pane-tree schema evolves independently of the protocol version). No public `session_state_key_id`, no public `account_number_hash` — both bind via key derivation and AAD without consuming header bytes.

#### 9.7.2 Inner plaintext (client-opaque descriptor)

The inner plaintext is the desktop client's serialized workspace descriptor. This layer does not parse it; cross-implementation byte-stability of the descriptor is the client's concern (the protocol vectors pin only the envelope + AAD + the `workspace_format_version` byte, as for `vault.search`). The desktop client structurally validates the descriptor on read and falls back to a single empty pane on any malformation — defense against a tampered-but-AEAD-OK or schema-drifted blob.

The inner schema is versioned by the `workspace_format_version` byte (§9.7.1), **not** by the protocol version, because the pane tree evolves independently:

- **`0x01` (original, MYND-166):** canonical JSON of `{root, focusedPaneId}` where `root` is the recursive `leaf`/`split` pane tree — a single workspace.
- **`0x02` (named workspaces, MYND-308):** the descriptor becomes `{slots, active}` — `slots` is the list of [named workspace slots](../glossary.md) (each carrying a stable `id`, a display `name`, and a `0x01`-shaped `{root, focusedPaneId}` descriptor incl. per-tab `viewMode`) and `active` records the active slot. The inner structure **stays engine-opaque to the codec** — this specification does NOT fix it; only the version byte and the envelope are normative. The active-slot pointer is *also* mirrored in the `vault.prefs` `active_workspace` field (§9.5.2) for crash-survival; on disagreement the §9.5.2 consistency rule self-heals.

**Magic / AAD / HKDF context are unchanged across `0x01 → 0x02`** — the role string stays `"workspace-blob"`, the KEK stays `session_state_key = DeriveSubkey(root_key, "session-state-key")`, the magic stays `MYW1`. Only the inner schema and the one version byte changed; named workspaces did **not** allocate a new blob family or subkey role. Forward-incompatibility is intra-`MYW1`: a client that knows only `0x01` MUST reject a `0x02` blob via the version-before-decrypt check and fall back to the default workspace (§9.7.4) — a downgrade discards the saved named slots, which is acceptable pre-alpha (no shipped `0x02` vaults predate the supporting client). A `0x01`-native blob, if still present, is best-effort wrapped by the TS deserializer as a single "Default" slot; there is no Rust-side migration step.

#### 9.7.3 AAD construction

`AAD_workspace_blob` mirrors `AAD_prefs_blob` / `AAD_search_index_blob` with role string `"workspace-blob"`:

```text
"myne.v0.1|"                   10 bytes  (AAD prefix, §5.2)
0x01                            1 byte   (protocol_version)
u16_be(14) || "workspace-blob"  16 bytes (length-prefixed role)
account_number_hash            16 bytes  (vault identity, §9.3 offset 6)
```

Total 43 bytes. `account_number_hash` (NOT `items_key_id`) binds vault identity — `session_state_key` derives directly from `root_key` via `"myne.v0.1 session-state-key"`, independent of the `items_key` lineage (so it survives a later epoch rotation, same rationale as prefs/search).

#### 9.7.4 Write cadence, size cap, and fall-back semantic

**Write cadence — graceful-exit only (single-workspace baseline).** The descriptor is written on manual lock, idle auto-lock (within its grace window, best-effort), and app quit — **never** on tab open/close/switch or pane-focus change. Per-switch writes would make the blob mtime a high-resolution editor-activity log readable by A4/A7; restricting writes to graceful exits keeps mtime a low-resolution lock/quit signal. Consequence: workspace state is **best-effort, not crash-durable** — a crash drops to the last graceful write (the crash-durable alternative is the rejected mtime leak).

**Coalesced cadence for named workspaces (MYND-308) — a deliberate, bounded relaxation.** Named workspaces (§9.7.2 `0x02`) introduce a hybrid save model (switching away auto-saves the outgoing slot's live layout) plus a `vault.prefs` active-slot pointer (`active_workspace`, §9.5.2) that should survive a crash. A naive realization would write on every workspace switch, reintroducing exactly the high-resolution-mtime editor-activity leak the graceful-exit-only rule above forecloses. Instead, the client **coalesces** both the `MYW1` descriptor flush and the `active_workspace` pointer flush to **at most once per ~5 minutes of active use, plus on graceful exit / auto-lock** — the same time-coalescing pattern the per-note snapshots feature uses (`../decisions.md` 2026-06-08). This is a **deliberate, bounded relaxation** of the graceful-exit-only cadence: it bounds both the mtime-leak granularity AND the crash-loss window to ~5 minutes, and is **never** a per-switch file write. Its threat consequence — workspace-switch timing becomes *coarsely* (≤ ~5 min) observable to a filesystem adversary (A4/A7) — is accepted by design and recorded in `../threat-model.md` §7 and `../decisions.md` 2026-06-17 (the names + layouts themselves stay inside the AEAD envelope under `session_state_key`, AS3 — only the coarse mtime cadence is observable). The rest of this section's discipline (size cap, fall-back semantic, at-rest leakage) is unchanged.

**Mobile exit analogs (MYND-561) — the same rule, resolved for a platform with no quit.** The graceful-exit-only rule above is written for a desktop lifecycle, where "app quit" is a user action the client is notified of. A mobile client has no equivalent: the normal way a phone app dies is an OS kill of an already-backgrounded process, which delivers no quit signal. The mobile client therefore resolves "graceful exit" to **vault lock (manual / idle auto-lock / vault switch) plus app-background** (`visibilitychange` → hidden, and `pagehide` for the terminal case), and writes at those seams only. It is **never** a per-interaction write: the descriptor is flushed at an exit seam only when the state actually changed since the last write, so a session that never touched the persisted state writes nothing at all.

The honest consequence, stated rather than implied: on mobile the blob mtime is a **backgrounding-granularity** signal, not the lock/quit-granularity signal the desktop rule yields — a phone is backgrounded many times a day without being locked. What it reveals is bounded to *that some persisted workspace state changed at some point before this backgrounding*, never what changed; the state itself stays inside the AEAD envelope under `session_state_key` (AS3). This is a **deliberate, bounded relaxation** of the same shape as the MYND-308 coalesced cadence above — accepted because the alternative (writing only on lock) silently loses the state on the platform's normal termination path, which is the failure the feature exists to prevent. Recorded in `../threat-model.md` §7 and `../decisions.md` 2026-07-25.

**Web keeps the desktop cadence, and deliberately NOT the mobile analog (MYND-574).** A browser client faces the mobile problem — there is no reliable "quit" callback, and a tab can be closed or discarded without warning — but it must not adopt the mobile answer. A phone is backgrounded a handful of times an hour; a browser tab is hidden on *every* application or tab switch, so writing at `visibilitychange` → hidden would make the mtime the high-resolution editor-activity log the graceful-exit rule exists to foreclose, at a resolution worse than any client here. The web client therefore writes at **vault lock** (manual / idle auto-lock / vault switch) and on the **coalesced ≤ ~5 min** cadence above, and at no other seam. The residual loss — a tab closed mid-session drops up to the coalescing window — is exactly the crash-loss the coalesced cadence already bounds on desktop, which is why the relaxation mobile needed is not needed here. The RAM staging slot (`workspace_stage`) has no web analog *by construction*: it exists so a host process can outlive its WebView and flush on quit, and in a browser the page and its worker die together.

**Size cap.** Implementations SHOULD reject `ciphertext_len > 1048576 + 32` (1 MiB plaintext cap + 32-byte CTX tag), bounding the parser's pre-AEAD allocation — parallel to §9.2 / §9.5.4 / §9.6. Tabs + a small pane tree + cursor offsets are kilobytes; 1 MiB is generous headroom.

**Fall-back semantic.** Reading `vault.workspace` returns the descriptor on success, or the **default workspace** (a single empty pane) on any failure (absent / magic-or-version mismatch / AEAD-fail / oversize / non-UTF-8 / malformed descriptor) — the non-distinguishing-error discipline of §6.4 / §9.5.5, applied to the workspace. An attacker with disk-write access can only reset the workspace to default; arbitrary state injection requires breaking the AEAD. Cross-vault: a `vault.workspace` from vault A fails AEAD under vault B's `session_state_key` (different `root_key`) and `AAD_workspace_blob` (different `account_number_hash`).

**At-rest leakage.** The blob's size leaks a coarse open-tab-count signal, analogous to the `.myn`-count / `vault.search`-size leaks — accepted for v0.1 ([`../threat-model.md`](../threat-model.md) A5 / §7).

### 9.8 Vault-indices blob (`vault.indices`)

`vault.indices` is a vault-level singleton artifact carrying the **structured-metadata index** in encrypted form (MYND-31 design; persistence landed by MYND-271). It lives next to `vault.meta` at `<vault-root>/vault.indices` and is AEAD-encrypted under a `root_key`-derived KEK. It is the structural sibling of `vault.search` (§9.6): same outer-envelope discipline, same engine-opaque inner plaintext, same fall-to-rebuild posture — but it indexes the vault's *structured* metadata rather than full-text terms: the wikilink forward/reverse (backlink) graph, the nested `#tag` ∪ frontmatter-`tags:` index, the title→note resolution surface, and — added by MYND-271 — the **typed property index** (every note's arbitrary frontmatter keys, each coerced to one of `string` / `number` / `date` / `list` / `checkbox` per [`markdown-dialect.md`](markdown-dialect.md) §3.6.4). `vault.search` (BM25 full-text) and `vault.indices` (structured metadata) are **distinct blob families** with distinct magic and distinct KEK roles — one magic per family (§10.3); properties belong to the VaultIndices lineage, never bolted onto the search blob.

The index is **plaintext-derived, RAM-resident state**: built from decrypted note content while the vault is unlocked (titles, folders, tags, wikilink edges, typed property values are all note plaintext or derived from it), queried in memory, and **zeroized on lock alongside the keys** — it is as sensitive as the open notes ([`../threat-model.md`](../threat-model.md) A6, AS3/AS4). `vault.indices` is purely a **persistence cache** of that RAM state — it lets a warm unlock reload the index without re-extracting from every note. It is never the source of truth; the `.myn` files are. A missing, stale, or unreadable `vault.indices` is always recoverable by rebuilding from the notes (§9.8.4). This rebuildable-cache property is what keeps the structured index — like the search index — within Myne's "not a database" commitment (`vision.md`; `../decisions.md` 2026-06-14 "Saved Views is a read-only derived projection over plain markdown, not a database").

#### 9.8.1 Outer envelope layout

All multi-byte integers are big-endian.

```
Offset  Size       Field                  Description
------  ---------  ---------------------  -------------------------------------
0       4 bytes    magic                  ASCII "MYI1"
4       1 byte     protocol_version       0x01 for this specification
5       1 byte     index_format_version   0x02 = the current inner-plaintext format
                                          (§9.8.2). 0x01 was the pre-MYND-612 form
                                          and is now REJECTED. Distinct from
                                          protocol_version: a future index schema /
                                          serialization change bumps THIS byte so an
                                          old decoder rejects the blob and falls to
                                          rebuild (§9.8.4) rather than mis-parsing it.
6       24 bytes   indices_nonce          192-bit random nonce used to encrypt the
                                          inner plaintext under vault_indices_key.
30      4 bytes    ciphertext_len         Length M = plaintext_len + 32 of the
                                          inner ciphertext followed by the 32-byte
                                          CTX commitment tag T'.
34      M bytes    ciphertext             Inner plaintext (§9.8.2), AEAD-encrypted
                                          under vault_indices_key with indices_nonce,
                                          followed by the 32-byte CTX commitment tag
                                          T' (§5.1). AAD binding in §9.8.3.
```

The header is 34 bytes, identical in shape to `vault.search` (§9.6.1) / `vault.workspace` (§9.7.1): offset 5 carries `index_format_version` (the structured-index schema evolves independently of the protocol version — adding a new property type or edge field bumps this byte). The KEK is `vault_indices_key = DeriveSubkey(root_key, "vault-indices-key")` per §3.2 + §3.4; as with `prefs_key` / `search_index_key`, no `vault_indices_key_id` field appears (it is selected deterministically from `root_key`).

Magic + `protocol_version` + `index_format_version` MUST all be checked **before** any decryption is attempted (the magic-byte-before-decrypt discipline of §9.2 / §9.3). A mismatch on any of the three rejects the blob and the client rebuilds (§9.8.4).

#### 9.8.2 Inner plaintext (engine-opaque snapshot)

The inner plaintext is an **`index_format_version`-tagged opaque payload**: this specification does NOT fix its internal structure, because the index representation is a client-implementation choice this layer must not constrain (identical posture to §9.6.2 / §9.7.2). For `index_format_version 0x02` the payload is a [postcard](https://docs.rs/postcard)-serialized snapshot of:

1. a **staleness manifest** — a map `note_id → content_nonce` recording, for each indexed note, the `.myn` `content_nonce` (§9.2) observed when it was indexed (the same decryption-free staleness signal `vault.search` uses, §9.6.4); and
2. the **serialized structured index** — the wikilink edge set (title-keyed, per-occurrence, with edge metadata), the folded tag index, the title→note resolution map, the **typed property records** (per note: the arbitrary frontmatter `key → {type, value}` pairs typed per §3.6.4, stored as opaque pre-typed values — Rust never re-parses YAML; the typing happens TS-side, MYND-271 Build-B), the **imported block-anchor records** (MYND-382: per note, its `^block-id` markers as `{block_id, preview}` — the enumerate-only source for the `[[^^` vault-wide block-deep-link picker; extracted TS-side by the single dialect scanner, never minted), and the **line-task records** (MYND-612: per note, its task-list lines as `{line_index, raw_line, completed}` plus the five `markdown-dialect.md` §3.8 metadata fields — `due`, `repeat`, `done`, `priority`, `remind` — each an **opaque verbatim source substring**. As with property records, Rust stores and returns them and interprets nothing: no date parsing, no comparison, no arithmetic. The typing authority is §3.6.4 as extended to inline task-field values, and it lives TS-side; a second Rust-side interpretation would be a second type authority).

**MYND-612 bumped this byte from `0x01` to `0x02`**, and the bump is deliberate rather than incidental. The precedent for additive payload growth (§9.6.2's trailing `extractor_version` / `schema_version`) leans on postcard being non-self-describing, so an older snapshot lacking a trailing field simply fails to decode. That is an implementation property of the serializer, **not a guarantee of the format**: if it ever stopped holding, a pre-612 blob would decode successfully against the new struct and yield a silently incorrect index — task records missing from an index that reports itself complete. An explicit version byte, checked before decryption alongside the magic and protocol version, cannot fail that way. A `0x01` blob is therefore rejected outright and the client rebuilds (§9.8.4).

All of (1)+(2) ride INSIDE the AEAD envelope by necessity: `note_id`s + `content_nonce`s are per-note correlation tags, and titles / folders / tags / wikilink targets / property keys-and-values are note plaintext or directly derived from it — all confidential vault content (AS3/AS4). None may appear in the cleartext header. Because the payload is engine-opaque, a v0.1 client that changes the index representation (a new property type, a new edge field, a different serialization) bumps `index_format_version`; older decoders reject and rebuild. As with `vault.search`, postcard (not the canonical JSON of §9.5.2) is chosen because the index is large and never cross-validated field-by-field (§9.6.2's rationale applies verbatim).

#### 9.8.3 AAD construction

`AAD_vault_indices_blob` mirrors `AAD_search_index_blob` / `AAD_workspace_blob` (§5.2 discipline) with role string `"vault-indices-blob"`:

```
AAD_vault_indices_blob =
  AAD_prefix || protocol_version (1 B) || "vault-indices-blob" || account_number_hash (16 B)
```

`"vault-indices-blob"` is length-prefixed UTF-8 (2-B big-endian length + 18 ASCII bytes, total 20 bytes). `account_number_hash` is the 16-byte field from `vault.meta` (§9.3 offset 6), binding the index blob to its specific vault. Total AAD length: `10 + 1 + 20 + 16 = 47 bytes`. As with `vault.prefs` / `vault.search` / `vault.workspace`, `items_key_id` is **not** bound — `vault_indices_key` derives directly from `root_key` via `"myne.v0.1 vault-indices-key"` (§3.4), independent of the `itemsKey` lineage (so it survives a later epoch-rotation `itemsKey` evolution, same rationale as prefs/search/workspace).

#### 9.8.4 Staleness detection, incremental reconcile, and fall-to-rebuild

`vault.indices` is a cache and MAY be stale relative to the `.myn` files. On unlock the client reconciles the loaded index against the current notes using the **`content_nonce` as a decryption-free staleness signal**, identically to `vault.search` (§9.6.4): for each on-disk note, an unchanged `content_nonce` means skip (no decrypt + no re-extract); a changed / absent one means decrypt and re-extract title/folder/tags/edges/properties; a manifest entry absent from disk means drop. The reconciled result is identical to a full rebuild of the same corpus (the load-bearing correctness property: a diff bug must never silently produce a different index than a rebuild).

**Fall-to-rebuild** is the fallback when incremental reconcile is impossible or untrusted: `vault.indices` absent, magic / version mismatch, AEAD verification failure, or an unreadable manifest. The client then rebuilds the index from scratch by decrypting + re-extracting every `.myn`. The `content_nonce` is NOT a security signal — only an optimization hint; a rebuild never trusts the cache. Because rebuild always recovers the correct index, `vault.indices` carries no integrity burden: a disk attacker who deletes or corrupts it costs the user one slower unlock, nothing more, and **loses no data** (the cache is fully derivable from the notes — the SYNC-1 "not a database" invariant in byte form). Trashed / template notes are excluded from the index TS-side (the §3.6.1 live-set rule), exactly as for the search index; the Rust index is trash-blind.

#### 9.8.5 Residency, size cap, and fall-back semantic

**Residency.** The decrypted index is RAM-resident only while the vault is `Slot::Unlocked`. It is zeroized on the same path as the keys at **every** slot-drop site — manual lock, idle auto-lock, vault deletion, and the credential-rotation force-relock — with titles, folders, tags, wikilink targets, and **typed property values** overwritten before the backing allocations free (the property payload is plaintext-derived, AS3/AS4, so it is wiped alongside the rest). Manual lock/quit MAY flush it to `vault.indices` first (persist-then-wipe); idle auto-lock skips the flush (fail-closed) and the next unlock rebuilds the missing delta.

**Size cap.** Implementations SHOULD reject `ciphertext_len > 268435456 + 32` (256 MiB plaintext cap + 32-byte CTX tag), bounding the parser's pre-AEAD allocation — parallel to §9.2 / §9.5.4 / §9.6.5. The 256 MiB cap is well above the benchmarked 10k-note structured index (incl. typed properties) and leaves generous headroom.

**Fall-back semantic.** Reading `vault.indices` returns the loaded index on success, or triggers fall-to-rebuild (§9.8.4) on any failure — the non-distinguishing-error discipline of §6.4 / §9.5.5, applied to the structured index. An attacker with disk-write access can only force a rebuild (a slower unlock); arbitrary index injection requires breaking the AEAD (§6.4). Cross-vault: a `vault.indices` from vault A fails AEAD under vault B's `vault_indices_key` (different `root_key`) and `AAD_vault_indices_blob` (different `account_number_hash`).

**At-rest leakage.** The blob's size leaks a coarse signal about indexed metadata volume (note count, tag/property cardinality), analogous to the `.myn`-count / `vault.search`-size leaks — accepted for v0.1 ([`../threat-model.md`](../threat-model.md) A5 / §7).

### 9.9 Attachment blob (`MYA1`)

An attachment blob holds one arbitrary file (image, SVG, PDF) as encrypted bytes, stored under `<vault-root>/attachments/<attachment-id-hex>` (§9.1). Attachments ship in v0.1 (this supersedes the earlier Phase-1.5 deferral; `decisions.md`). The blob reuses the `.myn` three-level wrapping pattern (§9.2): a per-attachment random `attachment_key` is wrapped under the vault `itemsKey`, and the file bytes are encrypted under `attachment_key`. Because the key lineage is `itemsKey → attachment_key`, an attachment blob is **independent of any single note** — a deduplicated attachment referenced by many notes has exactly one blob and one key.

All multi-byte integers are big-endian.

```
Offset  Size       Field                  Description
------  ---------  ---------------------  ---------------------------------------
0       4 bytes    magic                  ASCII "MYA1"
4       1 byte     protocol_version       0x01 for this specification
5       1 byte     reserved               MUST be 0x00; non-zero rejects parse
6       16 bytes   items_key_id           Identifier of the itemsKey under which
                                          enc_attachment_key is wrapped (UUIDv7,
                                          recorded in vault.meta; later epoch id).
22      24 bytes   attachment_key_nonce   192-bit random nonce wrapping
                                          attachment_key under itemsKey.
46      2 bytes    enc_attachment_key_len Length N of the wrapped attachment_key
                                          (XChaCha20-Poly1305 ciphertext +
                                          CTX commitment tag, N = 32 + 32 = 64).
48      N bytes    enc_attachment_key     attachment_key (32 B), AEAD-encrypted
                                          under itemsKey with attachment_key_nonce,
                                          followed by the 32-byte CTX tag T' (§5.1).
48+N    24 bytes   content_nonce          192-bit random nonce encrypting the file
                                          bytes under attachment_key.
72+N    4 bytes    ciphertext_len         Length M = filebytes_len + 32 of the
                                          file ciphertext followed by the 32-byte
                                          CTX commitment tag T'.
76+N    M bytes    ciphertext             File bytes, AEAD-encrypted under
                                          attachment_key with content_nonce,
                                          followed by the 32-byte CTX tag T'.
                                          The AAD binding is defined in §5.2.
```

The structure is byte-shaped identically to §9.2 (`.myn`) with `MYA1` in place of `MY01`; the two AEAD operations (wrapping `attachment_key`, encrypting file bytes) use independent random nonces from the OS CSPRNG. The `AAD_attachment_blob` (§5.2) additionally binds the `attachment-id` so a blob cannot be substituted across attachments within a vault. `content_type` is likewise absent from the blob: the decoder supplies it from the `vault.attachments` entry (§9.10.2) and MUST bind it in the UTF-8 NFC form stored there, per §5.2.

**Size cap.** Implementations MUST reject `ciphertext_len > 67108864 + 32` (64 MiB + 32). This is the v0.1 attachment subsystem's per-blob ceiling — larger payloads (streamed/chunked AEAD, Merkle manifests) remain out of scope (§11) and would require a new magic + migration, not an extension of `MYA1`. The cap exists to bound the parser's pre-AEAD allocation footprint, parallel to §9.2's rationale.

**Attachment-id.** The `attachment-id` is `HMAC-SHA-256(DeriveSubkey(root_key, "attachments-id-hmac"), file_plaintext_bytes)`, a deterministic 32-byte value used as the on-disk filename (hex) and the dedup key (§9.10). It is keyed under `root_key` so it is stable within a vault but reveals nothing to a disk observer who lacks `root_key` (no known-file confirmation oracle, no cross-vault equality — `threat-model.md` AS7/AS8). Encryption stays randomized (fresh `attachment_key` + nonces per blob); dedup is an id-existence check, **not** convergent encryption.

### 9.10 Attachments catalog (`vault.attachments`, `MYC1`)

`vault.attachments` is a vault-level singleton artifact carrying the **authoritative per-attachment metadata** and is the backing store for the attachments library. It lives next to `vault.meta` at `<vault-root>/vault.attachments` and is AEAD-encrypted under a `root_key`-derived KEK. Like `vault.prefs` (§9.5) and `vault.search` (§9.6), the outer envelope follows the fixed-offset binary discipline; the inner plaintext is canonical JSON.

The catalog holds metadata that must **survive note deletion** (filename, content type, size, creation time) so the library can display an attachment even when no note references it. The note→attachment reference graph ("used in N notes") is **not** stored here — it is derived from note bodies at runtime via the §9.6-style `content_nonce` reconcile (MYND-29), kept in RAM, and rebuilt on demand.

#### 9.10.1 Outer envelope layout

All multi-byte integers are big-endian.

```
Offset  Size       Field                Description
------  ---------  -------------------  ---------------------------------------
0       4 bytes    magic                ASCII "MYC1"
4       1 byte     protocol_version     0x01 for this specification
5       1 byte     reserved             MUST be 0x00; non-zero rejects parse
6       24 bytes   catalog_nonce        192-bit random nonce used to encrypt the
                                        inner plaintext under attachments_catalog_key.
30      4 bytes    ciphertext_len       Length M = plaintext_len + 32 of the
                                        inner ciphertext followed by the
                                        32-byte CTX commitment tag T'.
34      M bytes    ciphertext           Inner plaintext (§9.10.2),
                                        AEAD-encrypted under
                                        attachments_catalog_key with
                                        catalog_nonce, followed by the 32-byte
                                        CTX commitment tag T' (§5.1). The AAD
                                        binding is defined in §5.2 / §9.10.3.
```

The header is 34 bytes, identical in shape to `vault.prefs` (§9.5.1). The KEK is `attachments_catalog_key = DeriveSubkey(root_key, "attachments-catalog-key")` per §3.2 + §3.4 — derived deterministically from `root_key`, so no public key-id field appears. Note that the catalog KEK and the attachment-id HMAC key are **distinct** subkeys (§3.4): the former encrypts this blob, the latter derives content-addressed ids.

#### 9.10.2 Inner plaintext schema

The inner plaintext is canonical JSON per the §9.5.2 discipline (object keys lexicographically sorted by NFC bytes, no insignificant whitespace, UTF-8 NFC strings, integers as bare decimals with no leading zeros or trailing `.0`, floating-point FORBIDDEN). The top-level object maps each lowercase-hex `attachment-id` to a metadata object:

```json
{
  "<attachment-id-hex>": {
    "content_type": "image/png",
    "created_at": 1730000000,
    "filename": "diagram.png",
    "size": 20480
  }
}
```

- `content_type` — the import-time MIME of the file (a hint; the `attachment://` handler re-sniffs at serve time and is the authority for the served content-type). NFC, per the canonical-JSON discipline above — and this is the copy the decoder binds: it is fed verbatim into `AAD_encrypt_attachment` (§5.2) when opening the `MYA1` blob, so the sealer MUST bind the same NFC bytes it stores here.
- `created_at` — Unix epoch seconds (integer).
- `filename` — the display filename (NFC). Free-form: duplicates across attachments are permitted (the id is the key).
- `size` — plaintext byte length (integer).

Three **additive optional fields** exist for Phase 2 sync (MYND-468 + myne-md/myne#405; each absent from a pre-sync catalog and from any entry it doesn't apply to):

- `deleted_at` — Unix epoch seconds (integer), **optional**. Its presence turns the entry into an **attachment catalog tombstone**: the attachment was deleted and the entry is retained purely as the multi-device deletion marker (`sync-protocol.md` §11.4). A tombstone entry's metadata is **scrubbed** at deletion time — `filename` and `content_type` are emptied and `size` zeroed, so the synced catalog keeps no descriptive metadata for a crypto-erased file. An entry without `deleted_at` is live.
- `updated_at` — Unix epoch seconds (integer), **optional**. The `filename` LWW discriminator for the sync merge (set on rename; absent means `created_at`; `sync-protocol.md` §11.4 rule 4). Single-device semantics ignore it.
- `version` — a monotonic **causal merge counter** (integer, u64), **optional**, absent = 0. On any local mutation of the id (import / rename / delete), `version = max(versions this device has observed for that id) + 1`. It is the **primary key of the merge join** (`sync-protocol.md` §11.4 rule 4); the wall-clock fields only break an equal-`version` tie, which is what makes that merge associative. Causal, not a wall-clock — it orders edits and is not a security property. Single-device semantics ignore it.

Per-key the metadata fields are themselves emitted in canonical (lexicographic) order: `content_type`, `created_at`, `deleted_at` (when present), `filename`, `size`, `updated_at` (when present), `version` (when present). An empty catalog is the canonical JSON object `{}`. Schema evolution within v0.1 is additive optional fields (`#[serde(default)]`), per the §9.5.2 / §10.6 discipline — no envelope format-version discriminator (the causal per-entry `version` above is not one); these three additive fields are exactly that discipline in action, so the `MYC1` magic and envelope are **unchanged** (no §10.3 event). Honesty note: a pre-sync reader tolerates unknown fields on decode but **drops them on re-encode** (`#[serde(default)]` round-trips only known fields) — acceptable pre-alpha, since sync ships to all clients simultaneously and a dropped tombstone degrades to the accepted §11.4 rule-6 bootstrap bound, never to data corruption.

#### 9.10.3 AAD construction

The AAD is `AAD_attachments_catalog` (§5.2), binding `account_number_hash` so the catalog is non-portable across vaults at the AEAD-verification layer, mirroring `AAD_prefs_blob`. `items_key_id` is **not** bound (the KEK derives directly from `root_key`, preserving portability across a later epoch-rotation `itemsKey` evolution).

#### 9.10.4 Size cap and read semantics

Implementations SHOULD reject `ciphertext_len` exceeding an implementation-defined catalog ceiling sized to the vault's attachment count (the catalog is bounded by ~120 bytes of metadata per attachment, dominated by the `.myn`/blob count already exposed at rest). The reference implementation pins this ceiling at **16 MiB** (~140k entries). Read semantic is **fall-back-to-empty** on any failure (file absent / truncated / magic-mismatch / AEAD-fail / inner-parse-fail collapse to the empty catalog `{}`), matching the §9.5.5 / §6.4 non-distinguishing-error discipline. Recommended practice is eager-write of the empty catalog at vault creation so the closed invariant "`vault.attachments` exists for every post-attachments vault" holds; the fall-back-to-empty semantic remains canonical for legacy vaults and recovery.

### 9.11 Vault backup file (`.myne-backup`, `MYB1`)

A **vault backup file** is a single-file, user-initiated copy of one vault, written to
a user-chosen destination (file extension `.myne-backup`). It is a *state-transfer*
container, not a portability/export format — the walk-away path for user content remains
decrypted markdown (`vision.md`); and it is not a sync artifact — no server ever produces,
receives, or consumes one. Members are **byte-for-byte copies** of the vault's on-disk
files: the backup introduces **no new cryptography** — no re-encryption, no outer
envelope, no derived keys (see the `backup-key` note in §3.4). Restoring a backup and
unlocking the restored vault therefore requires exactly what unlocking the original
requires: the master password **or** the recovery phrase (both credential wraps travel
inside the embedded `vault.meta`). The metadata-leak posture and the
backups-outlive-erase consequences are normative in `threat-model.md` §7.

The spec is producer-agnostic: anything that emits this byte layout is a valid producer.
One backup file contains exactly one vault.

#### 9.11.1 Container layout

All multi-byte integers are big-endian.

```
Offset  Size       Field                Description
------  ---------  -------------------  ---------------------------------------
0       4 bytes    magic                ASCII "MYB1"
4       1 byte     protocol_version     0x01 for this specification
5       1 byte     reserved             MUST be 0x00; non-zero rejects parse
6       4 bytes    member_count         N — number of members (u32)
10      8 bytes    members_total_len    Sum of all member_len values (u64)
18      4 bytes    member_table_len     T — byte length of the member table (u32)
22      T bytes    member_table         N records, §9.11.2, sorted lexicographically
                                        by raw path bytes
22+T    …          member data          The members' bytes, concatenated in member-
                                        table order, no padding, no separators
```

The container carries **no timestamps** of any kind (creation time, per-member mtimes) —
user-meaningful timestamps live inside the encrypted blobs, and the container adds no
plaintext time signal beyond what UUIDv7 filenames already expose (§9.1).

#### 9.11.2 Member table record

```
Offset  Size       Field        Description
------  ---------  -----------  --------------------------------------------
0       2 bytes    path_len     P (u16); MUST be 1..=1024
2       P bytes    path         Relative member path: UTF-8, NFC, '/' separator,
                                no leading '/', no '.' or '..' segments, no '\'
2+P     8 bytes    member_len   L — byte length of the member (u64)
10+P    32 bytes   sha256       SHA-256 over path_len (2 B, big-endian) || path
                                (P bytes) || the member's L bytes
```

The hash input deliberately includes the record's own `path_len || path` prefix: a
corrupted path byte that still parses as allowlist-valid (one flipped hex digit inside a
UUID filename) would otherwise escape every container check and surface only as a
single-member AEAD failure at first unlock — after the user may have acted on the
export's success report. Binding the path into the hash makes path corruption as
detectable as data corruption, at both verification ends (§9.11.4).

Records are sorted lexicographically by raw `path` bytes; duplicate paths MUST be
rejected. This makes the encoding of a given member set canonical: two producers backing
up identical vault state emit identical bytes.

#### 9.11.3 Member set (closed allowlist)

Membership is a **closed allowlist**. Producers MUST include every existing vault file
matching the IN patterns, MUST NOT include anything else; consumers MUST reject a backup
containing any path outside the allowlist (unknown members are an error, not a warning —
this is the §10.6 no-extension-points discipline applied to the container).

| Pattern | Status | Rationale |
|---|---|---|
| `vault.meta` | IN — REQUIRED | Credential wraps + KDF params (§9.3); a backup without it is not restorable |
| `vault.prefs` | IN if present | User data (label, deliberate folders, ordering — AS3) |
| `vault.dictionary` | IN if present | Personal dictionary is authoritative user data (§9.13) — a Class-1 sync member, so `sync ⊆ backup` (`sync-protocol.md` §9) requires it here |
| `vault.themes` | IN if present | Custom themes are authoritative user data (§9.21) — hand-authored palettes, a Class-1 sync member, so `sync ⊆ backup` (`sync-protocol.md` §9) requires it here |
| `notes/<uuid>.myn` | IN | Note content; trash rides inside (`trashed:` frontmatter) |
| `snapshots/<note-uuid>__<snap-uuid>.myn` | IN | Version history is user data (`decisions.md` 2026-06-10) |
| `vault.attachments` | IN if present | Authoritative attachment metadata (§9.10) |
| `attachments/<attachment-id-hex>` | IN | Attachment blobs (§9.9) |
| `vault.search` | OUT | Pure rebuildable cache; first unlock after restore rebuilds (§9.6.4) |
| `attachments-text/<attachment-id-hex>` | OUT | Rebuildable per-attachment extraction cache (`MYE1`, §9.15); re-extracted from the source attachment on the first index need after restore — same rebuildable-cache class as `vault.search` |
| `vault.embeddings` | OUT | Pure rebuildable **and** model-specific cache (§9.17); re-embedded locally on the first unlock after restore (§9.17.4) — a backed-up index could be wrong on a device holding a different embedding model. Class 3 (`sync-protocol.md` §319) |
| `vault.graph` | OUT | Pure rebuildable knowledge-graph layout cache (`MYG1`, §9.19); re-laid-out locally on the next graph open. Class 3 (`sync-protocol.md` §326) |
| `vault.quickunlock` | OUT | Device-local credential (§9.14); wrap key is bound to *this* device's hardware (`thisDeviceOnly`), so a copy is inert elsewhere — re-set per device after restore |
| `vault.label` | OUT | Device-local sealed label store (`MYL1`, §9.22); the per-vault wrap key lives in *this* device's keychain (`thisDeviceOnly`), so a copy is inert elsewhere. The name is re-cached on the first unlock after restore, from the authoritative `label` inside `vault.prefs`. Carrying it would also put a name into a portable artefact, which is exactly what §9.22.5's erase is a statement about |
| `vault.quickunlock.attempts` | OUT | Device-local failed-attempt counter for that credential (§9.14.4); a 2-byte unencrypted `sentinel \|\| count`, meaningless on another device and re-created on demand — carrying it would only restore a stale lockout |
| `vault.head-state` | OUT | Device-local sync baseline (`MYH1`, §9.16); a backed-up baseline would be stale on restore — the restored vault TOFU-re-bootstraps (`sync-protocol.md` §6) |
| `*.tmp` (any directory) | OUT | Atomic-write residue, never user data |
| `.rename-journal` (notes dir) | OUT | Empty roll-forward marker for the transactional multi-note rename (§9.12); transient WAL sentinel, never user data |
| `vaults/registry.json` | OUT (structurally) | Per-install plaintext cache living outside the vault root |
| `vault.workspace` (§9.7) | OUT | Device-local editor layout (`MYW1`, Class-4 device-local, `sync-protocol.md` §9); rebuilt/reset per device, not carried across a restore |
| `vault.indices` (§9.8) | OUT | Pure rebuildable cache (`MYI1`, Class-3, `sync-protocol.md` §9); re-derived locally from the notes on the first unlock after restore (§9.8.4), same class as `vault.search` |

Members are verbatim file copies at their exact vault-relative paths. Paths are
load-bearing: `.myn` filenames are AAD-bound note UUIDs (§6.4), attachment filenames are
content-addressed ids (§9.9) — a renamed or transformed member fails AEAD/CTX
verification after restore by construction. The container does **not** record the
`VaultId` (the `vaults/<id>/` directory name): it is not cryptographically load-bearing,
and a restoring client mints a fresh one. The `account_number_hash` remains readable
without credentials at the embedded `vault.meta`'s fixed offset (§9.3), which is what
permits credential-free same-vault collision detection at restore time.

#### 9.11.4 Integrity semantics (corruption detection, NOT tamper resistance)

The per-member SHA-256 hashes (covering each record's path bytes AND its member data,
§9.11.2), `member_count`, and `members_total_len` exist to detect **accidental
corruption and truncation** — a half-copied file on failing media, an interrupted
download, a flipped path byte. They are **unkeyed**: an adversary who modifies a member
can recompute them, so the container claims **no tamper resistance**. Substitution, tamper,
and cross-vault-swap defense remains exactly where it is for the live vault: per-blob
AEAD verification with AAD binding at unlock (§6.5).

Two normative obligations follow:

- **Producers MUST verify before reporting success:** after the container is fully
  written to the destination, re-read it *from the destination* and verify every member
  hash and the totals before the final atomic rename into place. A `.myne-backup` file
  that exists at its destination has, by construction, passed verification.
- **Consumers MUST verify before placement:** all member hashes and totals are verified
  before any restored byte becomes visible to vault discovery.

#### 9.11.5 Consistency contract

The member set MUST be a **point-in-time consistent** copy of the vault directory:
no member may reflect a state newer than another in a way the live vault could not have
exhibited at a single instant (e.g., an attachments catalog entry whose blob is absent).
Per-member integrity is inherited from the per-file atomic-write discipline. The
quiescence mechanism (locking, copy ordering) is implementation-defined and not visible
in the wire format.

#### 9.11.6 Validation order and version handling

Consumers validate in this order, all stages credential-free, before any disk placement:

1. `magic` == `MYB1`; `protocol_version` == `0x01`; `reserved` == `0x00`.
2. `member_count`, `members_total_len`, `member_table_len` sanity (caps below).
3. Member table parse: path validity (§9.11.2 rules), allowlist membership (§9.11.3),
   lexicographic order, no duplicates.
4. Per-member SHA-256 over the member data, plus totals.
5. Structural parse of the embedded `vault.meta` (§9.3 header rules) — a backup whose
   `vault.meta` would produce `InvalidVaultMeta` is rejected *here*, so restore can never
   reproduce the corruption it exists to repair.

AEAD verification of members happens only at first unlock of the restored vault, by
design (no key material is available, or wanted, at restore time).

**Salvage mode (explicit, user-invoked).** The default consumer posture is
all-or-nothing: any stage-1..5 failure rejects the whole restore. A consumer MAY offer
an explicit, user-invoked **salvage** mode for a container that failed verification:
salvage MAY place only members whose individual table records verify (path + hash +
family checks), MUST require the embedded `vault.meta` to be among the verified members
(a backup whose `vault.meta` is damaged is not salvageable — nothing restored from it
could ever unlock), MUST report the exact skipped-member set to the caller, and MUST
present the result as a partial restore, never as a complete one. Salvage is a
disaster-recovery concession, not a relaxation of §9.11.4's default obligations.

Caps and cross-consistency (the step-2 sanity rules — the only validation this container
owns itself, everything else delegating to the member families): the container MUST
satisfy `file_length == 22 + member_table_len + members_total_len`,
`member_table_len == Σ (42 + path_len)` over the records (each record is
`2 + path_len + 8 + 32` bytes), and `members_total_len == Σ member_len`. `path_len` ≤
1024; each `member_len` MUST NOT exceed the size cap of the member's own blob family
(§9.2 for `.myn`, §9.9 for attachment blobs, §9.5.4/§9.10.4 for the singleton blobs,
§9.3's fixed-length layout for `vault.meta`). Implementations SHOULD additionally bound
`member_count` and `member_table_len` with implementation-defined ceilings sized to
realistic vaults, bounding pre-hash allocation per the §9.5.4 discipline (the reference
implementation pins `member_count` at 2²⁰ and the member table at 16 MiB). A v0.1 client
MUST reject `MYB5` and any unregistered magic; a next-major-version client MUST refuse `MYB1` with an
explicit migration prompt (§10.4). No extension points, no negotiation (§10.1).

### 9.12 Transactional multi-note rename (the rename journal)

A title rename that auto-updates wikilinks (`markdown-dialect.md` wikilink §8) rewrites
the renamed note's own `.myn` blob **plus** every inbound `[[…]]`-bearing note that
resolved to it. This rewrite is **all-or-nothing**: a partial commit would leave some
inbound `[[Old Title]]` references un-rewritten, and because resolution is title-keyed
(§5.3 / wikilink §5.3) an un-rewritten title-only link then resolves to **no note** —
i.e. a partial commit silently breaks links. The per-blob atomic-write discipline (each
`.myn` written to `<uuid>.myn.tmp` → fsync → atomic `rename(2)` → parent-dir fsync) makes
each *single* blob durable but is **not** collectively atomic across N blobs. The rename
journal restores all-or-nothing across the whole set.

**Two-phase write + roll-forward WAL.** The writer:

1. **Stage.** Encode every updated blob (the renamed note + each inbound note) and write
   each to its `<uuid>.myn.tmp`, `fsync`'d. Any failure in this phase deletes every staged
   `.tmp` and aborts — no live `.myn` was touched, so the vault is unchanged.
2. **Mark.** Once all stages are durable, write an **empty** `.rename-journal` marker in
   the notes directory (`fsync` the file + the parent directory). The marker is
   content-free — its mere existence is the commit signal.
3. **Commit.** Atomically `rename(2)` every `<uuid>.myn.tmp` → `<uuid>.myn`.
4. **Clear.** Delete the marker (and `fsync` the parent directory).

**Recovery (on vault-open, BEFORE the index rebuild).** A client reconciles any pending
rename before resolution runs:

- **Marker present** → a commit was in progress and (by phase 1) every staged blob is
  durable → **roll forward**: `rename(2)` every orphan `<uuid>.myn.tmp` → `<uuid>.myn`,
  then delete the marker.
- **Marker absent** → either a stage crashed before the marker, or a lone per-blob
  `atomic_write` crashed before its own rename → **roll back**: delete every orphan
  `<uuid>.myn.tmp`.

Recovery is idempotent: a crash *during* recovery leaves the same marker-present /
marker-absent state, so the next open re-drives it to the same outcome.

**Single-writer invariant.** v0.1 is single-writer-per-vault (one unlocked client; the
`tauri-plugin-single-instance` + slot CAS guards, §9 / `decisions.md` 2026-05-06). No
`<uuid>.myn.tmp` exists except as in-flight transaction residue, so the recovery sweep
cannot mistake a concurrent writer's staging file for abandoned residue.

**Integrity and attack surface.** The marker is **not** a magic-byte blob and carries no
data — no note UUIDs, no titles, no counts — so it adds no metadata surface beyond the
`.tmp` staging set already inherent to *any* note write. A disk-write adversary who plants
a marker and a forged `<uuid>.myn.tmp` cannot inject readable content: a rolled-forward
blob is still AEAD/CTX-verified with full AAD binding on the next read (§6.4), so a forged
blob fails to decrypt exactly as a tampered live `.myn` would. This is the same
corruption-detection-not-tamper-resistance posture as §9.11.4 — the journal changes *when*
blobs become live, never *whether* they are authenticated. Both the marker and the staged
`.tmp` files are **OUT** of the backup container (§9.11.3): a backup is a point-in-time
consistent snapshot (§9.11.5) and never captures an in-flight rename.

This mechanism introduces **no new load-bearing identifier** and is **not** a major-version
event: the staged blobs are ordinary `MY01` `.myn` files, and the marker is an empty
sentinel with a fixed conventional name (`.rename-journal`), not a versioned format.

### 9.13 Personal dictionary blob (`vault.dictionary`, `MYD1`)

`vault.dictionary` is a vault-level singleton artifact holding the user's personal
spell-check dictionary — the **added-words set** plus a vault-wide **ignore set**
(MYND-266). It lives next to `vault.meta` at `<vault-root>/vault.dictionary` and is
AEAD-encrypted under `personal_dictionary_key = DeriveSubkey(root_key,
"personal-dictionary-key")` (§3.2 + §3.4). Both sets are **AS3-Sensitive** user
vocabulary (names, project terms, private words); storing them as plaintext local app
state would leak that vocabulary to a filesystem adversary (A4/A7), so they ride inside
the AEAD envelope like every other vault blob (the `vault.prefs`/`vault.search` posture).

The blob is **payload-agnostic at the protocol layer**, exactly like `vault.search`
(§9.6.2): this spec fixes the crypto framing (magic, version, AEAD, AAD) — the
load-bearing part — while the inner word-set serialization is the client's concern,
tagged by a `dict_format_version` byte.

#### 9.13.1 On-disk layout

All multi-byte integers are big-endian.

```
Offset  Size       Field                  Description
------  ---------  ---------------------  -------------------------------------
0       4 bytes    magic                  ASCII "MYD1"
4       1 byte     protocol_version       0x01 for this specification
5       1 byte     dict_format_version    0x01 = the v0.1 inner word-set format
                                          (§9.13.2). Distinct from protocol_version:
                                          a future serialization bumps THIS byte so an
                                          old decoder rejects + falls back to empty
                                          (§9.13.4) rather than mis-parsing it.
6       24 bytes   dict_nonce             192-bit random nonce (OS CSPRNG) for the
                                          inner AEAD under personal_dictionary_key.
30      4 bytes    ciphertext_len         Length M = plaintext_len + 32 of the inner
                                          ciphertext followed by the 32-byte CTX tag.
34      M bytes    ciphertext             Inner plaintext (§9.13.2), AEAD-encrypted
                                          under personal_dictionary_key with dict_nonce,
                                          then the 32-byte CTX commitment tag T' (§5.1).
                                          AAD binding in §9.13.3.
```

The 34-byte header is identical in shape to `vault.search` (§9.6.1) — offset 5 carries
`dict_format_version` (the word-set serialization may evolve independently of the
protocol version). No public `personal_dictionary_key_id` and no public
`account_number_hash` byte: both bind cryptographically (key derivation + AAD) without
consuming header bytes, exactly as for `vault.prefs`/`vault.search`. Magic +
`protocol_version` + `dict_format_version` MUST all be checked **before** any decryption
(the magic-byte-before-decrypt discipline of §9.2/§9.3/§9.6.1).

#### 9.13.2 Inner plaintext (`dict_format_version 0x01`)

A [postcard](https://docs.rs/postcard)-serialized struct of two **set-semantics string
arrays**: `personal_words` (added words that count as correct) and `ignore_words` (the
vault-wide ignore set). Each array is canonical: elements **NFC-normalized**,
**lexicographically sorted**, **exact-deduped** (the `deliberate_folders` discipline,
§9.5.2). Both rest INSIDE the AEAD envelope by necessity — the words are confidential
vault vocabulary; none may appear in the cleartext header.

Postcard (not the canonical JSON of §9.5.2) because the payload is unbounded
user-generated content — the same rationale §9.6.2 gives for the search index; a
sorted+deduped `Vec<String>` is deterministic, so cross-implementation golden vectors
stay byte-stable. Case-insensitive **lookup** (does adding "Myne" suppress
"myne"/"MYNE"?) is the client's set-management layer's job — the codec stores exact NFC
bytes and never folds (the §9.5.2 codec-vs-set-layer separation).

#### 9.13.3 AAD construction

`AAD_personal_dictionary_blob` mirrors `AAD_prefs_blob` / `AAD_search_index_blob` with
role string `"personal-dictionary-blob"`:

```text
"myne.v0.1|"                              10 bytes  (AAD prefix, §5.2)
0x01                                       1 byte   (protocol_version)
u16_be(24) || "personal-dictionary-blob"  26 bytes (length-prefixed role)
account_number_hash                       16 bytes  (vault identity, §9.3 offset 6)
```

Total 53 bytes. `account_number_hash` (NOT `items_key_id`) binds vault identity —
`personal_dictionary_key` derives directly from `root_key` via
`"myne.v0.1 personal-dictionary-key"`, independent of the `items_key` lineage (so it
survives a later epoch rotation, same rationale as prefs/search/workspace). The subkey
role string `"personal-dictionary-key"` is DISTINCT from the AAD role string
`"personal-dictionary-blob"` — the same key/blob domain-separation as search.

#### 9.13.4 Size cap, fall-back-to-empty, and non-load-bearing class

Implementations MUST reject `ciphertext_len > 4 MiB + 32`. 4 MiB is generous headroom
over a realistic personal dictionary (hundreds of thousands of words) and bounds the
pre-AEAD allocation footprint (the §9.5.4 / §9.6.5 DoS-allocation discipline).

Read semantic is **fall-back-to-empty** on ANY failure (file absent / truncated /
magic-or-version-or-format mismatch / AEAD verification failure / inner-parse failure) →
both sets empty, per the §9.5.5 / §6.4 non-distinguishing-error discipline. A vault that
never used the feature simply has **no `vault.dictionary` file** (it is written only when
non-empty), so a pre-MYND-266 vault is byte-identical.

The blob is **non-load-bearing** (the two-class prefs taxonomy, `threat-model.md` §7): a
replayed / tampered / stale blob can at worst restore an older word set or flag/unflag
words — it weakens no security guarantee — so it carries **no protective-envelope clamp**
and inherits the documented best-effort local-prefs-replay limitation. Phase-2 sync
conflict semantics are a **clockless union + add-wins** (AS6-safe, no
wall-clock), which means they **cannot express a removal**: a word the user
deleted is restored by any peer that still holds it. That is the same defect
myne-md/myne#613 fixed for the prefs sets, and it is NOT fixed here
(`sync-protocol.md` §10.2 records it). Formerly compared to
`deliberate_folders` (§9.5.2). A v0.1 client MUST reject `MYD5` and any unregistered
magic; a next-major-version client MUST refuse `MYD1` (§10.4).

### 9.14 Quick-unlock credential blob (`vault.quickunlock`, `MYQ1`)

`vault.quickunlock` is a **device-local credential** holding a **third wrapped copy of
`root_key`** — the structural realization of the §3.1 forward-look ("adding a third
encrypted copy of `root_key` under a third wrap key, with no change to the rest of the
protocol"). It exists so a re-lock (auto-lock-on-idle, §9.5 / `auto_lock.rs`) can be
reversed with a fast second credential (Touch ID / Face ID / Windows Hello / a PIN)
instead of the full master-password Argon2id path, **without touching the cryptographic
root**: the
blob wraps the already-derived `root_key`; it never participates in `root_key` derivation
(MYND-329).

Unlike every other §9 blob, `vault.quickunlock` is **NOT** wrapped under a
`DeriveSubkey(root_key, …)` KEK — that would be circular, since the blob *is* what
protects `root_key`. Its wrap key is supplied by an **external wrap-key provider** bound
to OS-backed hardware (an Apple Keychain item gated by `kSecAccessControlBiometryCurrentSet`
— macOS Touch ID or iOS Face ID / Touch ID — or a future Windows Hello / TPM
challenge-response) or, as a fallback, derived from a PIN
via the vault's existing Argon2id parameters. The blob therefore has **no §3.4 subkey
role**.

**Device-local, never synchronized.** `vault.quickunlock` lives at
`<vault-root>/vault.quickunlock` but, unlike the synced artefacts (the sync-taxonomy
authoritative + identity members, `sync-protocol.md` §9; §9.3), it is **never** part of any sync set: the wrap
key is bound to *this* device's hardware (`thisDeviceOnly` keychain accessibility), so a
copy on another device is inert. Each device that opts in mints its own blob. This is the
per-device refinement of §3.1's "third copy lives in `vault.meta`" sketch (which assumed
a single device); see `decisions.md` 2026-06-16.

#### 9.14.1 On-disk layout

All multi-byte integers are big-endian.

```
Offset  Size       Field                  Description
------  ---------  ---------------------  -------------------------------------
0       4 bytes    magic                  ASCII "MYQ1"
4       1 byte     protocol_version       0x01 for this specification
5       1 byte     provider_kind          0x01 = Apple-biometric (Keychain;
                                          macOS Touch ID / iOS Face ID + Touch
                                          ID), 0x02 = PIN (Argon2id). Other
                                          values reserved (Windows Hello /
                                          Android Keystore = future).
                                          Bound into the AAD (§9.14.3) so a blob
                                          minted for one provider cannot be
                                          reinterpreted under another.
6       16 bytes   pin_salt               Argon2id salt for the PIN provider; all
                                          zero when provider_kind != 0x02. The
                                          Argon2id m/t/p parameters are NOT stored
                                          here — the PIN provider reuses the
                                          vault's parameter set from vault.meta
                                          (§4.2), available because quick-unlock
                                          setup happens while unlocked.
22      24 bytes   wrap_nonce             192-bit random nonce (OS CSPRNG) for the
                                          AEAD wrap of root_key under wrap_key.
46      4 bytes    ciphertext_len         M = 32 + 32 (root_key plaintext + CTX tag).
50      M bytes    ciphertext             root_key (32 bytes) AEAD-encrypted under
                                          wrap_key with wrap_nonce, then the 32-byte
                                          CTX commitment tag T' (§5.1). AAD in §9.14.3.
```

Magic + `protocol_version` MUST be checked **before** any decryption (the
magic-byte-before-decrypt discipline of §9.2 / §9.3 / §9.13.1).

#### 9.14.2 Wrap-key providers

The on-disk blob is **provider-agnostic**: it is always `AEAD(wrap_key, root_key)`, and
only the source of the 32-byte `wrap_key` differs. v0.1 defines:

- **`0x01` Apple-biometric** — `wrap_key` is a 32-byte random secret stored in the Apple
  Keychain (macOS login Keychain behind Touch ID; iOS device Keychain behind Face ID /
  Touch ID — same mechanism, one provider kind; `decisions.md` 2026-07-12) under an
  access-control object built with `kSecAccessControlBiometryCurrentSet`
  + `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. Retrieval triggers the OS biometric
  prompt inherently (the resource is gated, not an app-level boolean — the bypass lesson
  of OWASP-MASTG / Teleport RFD 54). The `biometryCurrentSet` flag invalidates the secret
  at the OS level when the enrolled biometric set changes.
- **`0x02` PIN** — `wrap_key = Argon2id(password = pin, salt = SHA-256("myne.v0.1 argon2id-quickunlock-pin|" || account_number_hash || pin_salt)[:16], m,t,p from vault.meta §4.2)`.
  The salt prefix `"myne.v0.1 argon2id-quickunlock-pin|"` is **distinct** from the
  password (`argon2id-password|`) and recovery (`argon2id-recovery|`) prefixes, so a
  PIN wrap key is domain-separated from the credential wrap keys even if a user's PIN
  coincided with their password (§3.1 salt-domain discipline). The memory-hard
  parameters (m = 256 MiB baseline) are what make a low-entropy PIN costly to
  brute-force offline. A minimum 6-digit PIN is enforced host-side.

The provider abstraction is a single Rust trait (the implementation's `QuickUnlockProvider`);
adding Windows Hello later is a new provider value, **not** a format change.

#### 9.14.3 AAD construction

`AAD_quick_unlock_blob` mirrors `AAD_personal_dictionary_blob` (§9.13.3) with role string
`"quick-unlock-blob"`, and additionally binds `provider_kind`:

```text
"myne.v0.1|"                        10 bytes  (AAD prefix, §5.2)
0x01                                 1 byte   (protocol_version)
u16_be(17) || "quick-unlock-blob"   19 bytes  (length-prefixed role)
account_number_hash                 16 bytes  (vault identity, §9.3 offset 6)
provider_kind                        1 byte   (binds the provider; §9.14.1 offset 5)
```

Total 47 bytes. `account_number_hash` binds the blob to its specific vault; binding
`provider_kind` prevents reinterpreting a biometric-minted blob as a PIN blob (or the
reverse) at the AEAD layer.

#### 9.14.4 Lifecycle, invalidation, and threat class

`vault.quickunlock` is written only while the vault is **Unlocked** (the setup path clones
the in-memory `root_key`). It is **deleted** (blob + provider credential) on any of:
(1) **any master-password commit** — both the `change_password` rotation and the
completion of a phrase recovery (§7.3), which commits a new master password by the other
route and is the *stronger* signal of the two, since the user reached it by losing the
password rather than by choosing to rotate it; (2) enrolled-biometric-set change
(automatic at the OS level via `biometryCurrentSet` for provider `0x01`); (3) user
disabling the feature; (4) vault deletion (the blob lives in the vault directory).

**The reason for (1) is access-reset policy, not key lineage.** An earlier revision of
this clause said the wrapped copy is "of the *old* `root_key` lineage", which is false:
neither rotation path changes `root_key` — both re-wrap the same value — and the AAD
(§9.14.3) binds `account_number_hash` + `provider_kind`, neither of which moves either.
So a credential left in place after a rotation does not become stale; it keeps unwrapping
the live `root_key`. Deletion is required because the user asked to reset their access,
and that is the whole of the justification. Stating a lineage reason that does not hold is
what let the recovery path ship without the rule: a reader checking whether recovery
"invalidates the lineage" correctly concluded it does not. A
**code-enforced** failed-attempt counter (the `auto_lock.rs` two-class discipline,
`threat-model.md` §7) wipes the blob after a bounded number of consecutive failures —
this bounds *online* guessing; it does not bound offline brute-force. Each attempt is
counted under the same capacity-1 single-in-flight auth permit that serializes every
other credential operation, so the read-increment-persist of the count cannot interleave
with a second redeem and every rejected attempt is counted exactly once.

The counter is **persisted**, because a per-session counter would reset on relaunch and
bound nothing: it lives at `<vault-root>/vault.quickunlock.attempts` as a 2-byte body
`sentinel (0xA7) || count_u8` — unencrypted, device-local, never synced and never backed
up (§9.1; an explicit OUT row in §9.11.3). The **cap is a code constant, not a stored
field**, and the count is clamped to it on write, so a tampered or replayed file can only
make quick-unlock *stricter*: a wrong-length or wrong-sentinel file is read as *threshold
reached*, and an absent file as a fresh start (correct — the blob and its counter are
deleted together). The leading byte is a corruption sentinel and is deliberately **not** a
§10.3 registration: §10.3 allocates 4-byte magics to AEAD blob families, and a 1-byte
device-local counter is neither.

**Threat class (distinct from the non-load-bearing prefs blobs).** `vault.quickunlock`
is a **credential**, not a cosmetic preference: it holds a wrapped `root_key`. Its
guarantee is an **A6 gate** (brief physical access to a running-but-locked app /
shoulder-surf) layered over the already-encrypted store — it never weakens the
zero-knowledge root (the master-password Argon2id path is unchanged and remains the
primary credential). It does **not** defend against **A7** (active local malware, which
can satisfy the biometric prompt or read process memory — out of scope, `threat-model.md`
§5). For the PIN provider, a disk-copy attacker (**A5**) can attempt offline brute-force
of the blob; the only defense is PIN entropy × the memory-hard Argon2id cost, so PIN-only
quick-unlock is strictly weaker than the hardware-bound biometric path and is documented
as such. A v0.1 client MUST reject `MYQ5` and any unregistered magic; a next-major-version
client MUST refuse `MYQ1` (§10.4).

### 9.15 Extracted-attachment-text blob (`attachments-text/<id>`, `MYE1`)

Each attachment whose text has been extracted gets a per-attachment **extracted-text
cache blob** at `<vault-root>/attachments-text/<attachment-id-hex>` — one file per
attachment, named by the lowercase-hex `attachment_id` (§9.9), mirroring the
`attachments/<attachment-id-hex>` layout of the `MYA1` blob it derives from (MYND-328).
It holds the on-device text extracted from PDF / Word (`.docx`) / text-like (`.txt` /
`.md` / `.csv`) attachments, **plus the on-device transcript of an audio attachment
(ASR / speech-to-text of an `audio/wav` `MYA1` blob — a recorded voice note or an imported
clip, MYND-259/MYND-270)**, fed into the search index (§9.6) so a note becomes findable by
the text inside its embedded attachments — and, for audio, by what was said in it. Image OCR
and scanned (text-layer-less) PDFs joined this at `extractor_version 0x03` (MYND-441),
which reuses this blob unchanged (see "extractor_version" below). The blob is AEAD-encrypted under `attachment_text_key =
DeriveSubkey(root_key, "attachment-text-key")` (§3.2 + §3.4).

Extracted text is **AS3-Sensitive** derived plaintext of user content; storing it as
local app state would leak it to a filesystem adversary (A4/A7), so it rides inside the
AEAD envelope like `vault.search`. Like the search index, this blob is a **rebuildable
cache** — it can always be regenerated by re-extracting from the source `MYA1` blob — so
it carries no integrity-of-content burden (§9.15.4). The blob is **payload-agnostic at
the protocol layer**, exactly like `vault.search` (§9.6.2) and `vault.dictionary`
(§9.13): this spec fixes the crypto framing (magic, version, AEAD, AAD) — the
load-bearing part — while the inner extracted-text serialization is the client's concern,
tagged by an `extractor_version` byte.

#### 9.15.1 On-disk layout

All multi-byte integers are big-endian.

```
Offset  Size       Field                  Description
------  ---------  ---------------------  -------------------------------------
0       4 bytes    magic                  ASCII "MYE1"
4       1 byte     protocol_version       0x01 for this specification
5       1 byte     extractor_version      0x01 = the v0.1 baseline extractor set
                                          (PDF text-layer, DOCX OOXML text, text-like
                                          UTF-8; §9.15.2); 0x02 = that baseline set PLUS the
                                          audio ASR (speech-to-text) extractor generation
                                          (§9.15.2; MYND-270); 0x03 = the above PLUS the
                                          image OCR generation — image attachments and
                                          scanned, text-layer-less PDFs (§9.15.2, MYND-441).
                                          Distinct from protocol_version: a changed extractor
                                          set (better extraction, the added audio ASR
                                          generation, the added OCR generation) bumps THIS
                                          byte so a lower stored value triggers re-extraction
                                          + index rebuild (§9.6.4) rather than serving stale
                                          text. This is an in-major value change, NOT a
                                          protocol_version bump.

                                          The byte is GLOBAL, not per-format: a bump
                                          invalidates every cached extraction of EVERY
                                          format, including ones the new generation does not
                                          improve. The 0x02 -> 0x03 bump therefore re-runs
                                          ASR over every audio attachment for no gain. That
                                          cost is accepted deliberately, not overlooked;
                                          per-format generation counters are tracked
                                          separately as MYND-573.

                                          For a MODEL-BACKED generation whose model is
                                          BUNDLED rather than user-chosen, this byte is also
                                          the only staleness signal that exists: the OCR
                                          payload leaves model_hash unset (§9.15.2), so
                                          CHANGING THE BUNDLED OCR WEIGHTS REQUIRES BUMPING
                                          THIS BYTE. Without the bump, every existing vault
                                          keeps serving text produced by the old weights and
                                          the improvement is invisible.
6       24 bytes   text_nonce             192-bit random nonce (OS CSPRNG) for the inner
                                          AEAD under attachment_text_key.
30      4 bytes    ciphertext_len         Length M = plaintext_len + 32 of the inner
                                          ciphertext followed by the 32-byte CTX tag.
34      M bytes    ciphertext             Inner plaintext (§9.15.2), AEAD-encrypted under
                                          attachment_text_key with text_nonce, then the
                                          32-byte CTX commitment tag T' (§5.1). AAD binding
                                          in §9.15.3.
```

The 34-byte header is identical in shape to `vault.search` (§9.6.1) / `vault.dictionary`
(§9.13.1) — offset 5 carries `extractor_version` (the extracted-text serialization +
extractor generation may evolve independently of the protocol version). The
`attachment_id` is **not** a header field: the file name carries it and the AAD binds it
cryptographically (§9.15.3), so a blob cannot be served for the wrong attachment. No
public `attachment_text_key_id` and no public `account_number_hash` byte: both bind
cryptographically without consuming header bytes, exactly as for `vault.search`. Magic +
`protocol_version` + `extractor_version` MUST all be checked **before** any decryption
(the magic-byte-before-decrypt discipline of §9.2 / §9.3 / §9.6.1).

#### 9.15.2 Inner plaintext

A [postcard](https://docs.rs/postcard)-serialized struct:

- `status` — one of `ok` (text extracted), `empty` (supported format but no extractable
  text, e.g. a scanned PDF with no text layer), `unsupported` (format not handled in this
  extractor generation), or `failed` (extraction errored — corrupt / password-protected).
- `source_format` — the format the extractor dispatched on (`pdf` / `docx` / `text` /
  `audio` / `image`). `audio` is the ASR / speech-to-text generation
  (`extractor_version 0x02`, §9.15.1): the extractor decodes the `audio/wav` `MYA1` blob
  and writes the transcript to `text`. `image` is the OCR generation
  (`extractor_version 0x03`, MYND-441): the extractor decodes a raster image attachment
  and writes the recognized text. A scanned, text-layer-less PDF keeps `source_format =
  pdf` — it *is* a PDF, and `status` plus `text` already distinguish an OCR result from a
  text-layer one; only the attachment's own format selects the variant. An attachment that
  cannot be transcribed or recognized maps to the existing negative `status` values
  (`unsupported` / `failed` / `empty`) — no new `status` is added at either generation, and
  each bump is precisely what re-processes what the previous generation marked
  `unsupported`.

  The variant set is **append-only**. The serialization tags variants by declaration
  index (`pdf`=0, `docx`=1, `text`=2, `other`=3, `audio`=4, `image`=5), so inserting or
  reordering would silently re-interpret every already-written blob. New formats are
  appended, never inserted.
- `text` — the extracted text, **NFC-normalized**, empty unless `status = ok`.
- `char_count` — `u32` length of `text` before any truncation.
- `truncated` — `bool`, set when extraction hit the `MAX_EXTRACTED_TEXT_LEN` cap (§9.15.4).
- `model_hash` — optional `SHA-256` of the model that produced this payload, present only
  for a model-backed generation whose model the **user chose**. It mirrors the
  `vault.embeddings` model-identity rule (§9.17.2): the hash rides the inner payload, never
  the AAD, so the crypto framing stays model-agnostic and a model swap invalidates cached
  results through a payload-side comparison instead. It is `null` for a deterministic
  extractor (PDF / DOCX / text — output is model-independent) and `set` for an ASR
  transcript, whose Whisper model is side-loadable.

  It is also **`null` for OCR**, and deliberately so: the OCR weights are *bundled*, not
  user-chosen, so there is no per-vault model identity to record — every client at a given
  `extractor_version` ran the same weights. The consequence is stated in §9.15.1 and is
  normative: because no payload-side identity exists to catch it, **changing the bundled
  OCR weights requires bumping `extractor_version`.**

The whole struct rests INSIDE the AEAD envelope by necessity — the text is confidential
vault content; none may appear in the cleartext header. Postcard (not the canonical JSON
of §9.5.2) for the same reason as `vault.search` / `vault.dictionary`: the payload is
unbounded user-generated content and is never cross-validated field-by-field. All four
`status` values (including the negative ones) are persisted so a rebuild does **not**
retry extraction that already failed/was-unsupported — until `extractor_version` bumps.

For the audio ASR generation (`extractor_version 0x02`), the selected transcription
model's identity (its SHA-256) rides **inside** this client-opaque payload as part of the
transcript cache-invalidation key — NOT in the cleartext header and NOT in the AAD —
exactly as `vault.search` (§9.6.2) and `vault.embeddings` (§9.17.3) carry their
model-identity in the inner payload. A model swap therefore invalidates a cached transcript
through the inner payload while the §9.15 crypto framing stays payload-agnostic; the
`extractor_version` byte marks the extractor *generation*, not the specific model.

#### 9.15.3 AAD construction

`AAD_attachment_text_blob` mirrors `AAD_search_index_blob` / `AAD_personal_dictionary_blob`
with role string `"attachment-text-blob"`, plus the two bindings that make a per-attachment
cache safe — `attachment_id` and `extractor_version`:

```text
"myne.v0.1|"                            10 bytes  (AAD prefix, §5.2)
0x01                                     1 byte   (protocol_version)
u16_be(20) || "attachment-text-blob"    22 bytes  (length-prefixed role)
account_number_hash                     16 bytes  (vault identity, §9.3 offset 6)
attachment_id                           32 bytes  (binds blob to its specific attachment)
extractor_version                        1 byte   (binds the extractor generation)
```

Total 82 bytes. `account_number_hash` (NOT `items_key_id`) binds vault identity —
`attachment_text_key` derives directly from `root_key` via `"myne.v0.1
attachment-text-key"`, independent of the `items_key` lineage (so it survives a later
epoch rotation, same rationale as prefs/search/dictionary). The `attachment_id` binding
is what makes one KEK safe across all attachment-text blobs: a blob sealed for attachment
A fails AEAD verification if served as attachment B. Binding `extractor_version` in the
AAD (as well as the header byte) prevents a tampered header byte from being silently
accepted — this covers the `0x01 → 0x02` audio-ASR bump (MYND-270), a legal in-major value
change (no `protocol_version` bump): a blob written at `0x02` binds that value into its tag,
so flipping the stored byte back to `0x01` (to force acceptance of a stale generation) fails
AEAD verification rather than being silently served. The subkey role string `"attachment-text-key"` is DISTINCT from the AAD role
string `"attachment-text-blob"` — the same key/blob domain-separation as search.

#### 9.15.4 Size cap, cache semantics, and threat class

Implementations MUST reject `ciphertext_len > 4 MiB + 32`, bounding the pre-AEAD
allocation footprint (the §9.6.5 / §9.13.4 DoS-allocation discipline). The extractor
itself caps emitted text at `MAX_EXTRACTED_TEXT_LEN` (a client constant, ~1 MiB) and sets
`truncated` — the 4 MiB blob ceiling is generous headroom over that cap plus postcard
overhead.

**`unsupported` is NOT written (MYND-441).** Of the four `status` values, three —
`ok`, `empty`, `failed` — are persisted, so a rebuild never retries an extraction that
already reached a verdict. `unsupported` is different: it means *nothing was attempted*
at this generation (the format is not handled, or a model-backed extractor is deferring
to a background pass, §9.6.4). Writing it would freeze that non-attempt as if it were a
verdict, and the attachment could only be revisited by another `extractor_version` bump.
Implementations MUST therefore leave no cache blob for an `unsupported` result. The
absence of the blob is what lets a deferred extraction be picked up later without any
separate queue state.

**Cache semantics.** `attachment_id` is content-addressed over the attachment plaintext
(§9.9), so an attachment's bytes are immutable: once its text is cached at a given
`extractor_version`, it never needs re-extraction at that version. A bump of
`extractor_version` (improved extraction, or a newly added extractor generation) invalidates older
blobs → lazy re-extraction. Read semantic is **fall-back-to-re-extract** on ANY failure
(file absent / truncated / magic-or-version mismatch / AEAD verification failure /
inner-parse failure): the client treats it as a cache miss and regenerates from the
`MYA1` source, per the §9.6.4 cache discipline. The blob is therefore **non-load-bearing**
in the same sense as `vault.search` — a disk attacker who deletes or corrupts it costs at
most one re-extraction, never a wrong or missing security guarantee.

**Lifecycle.** The blob is written eagerly at attachment import and lazily on first index
need for pre-existing attachments. When an attachment is permanently deleted /
garbage-collected, its `attachments-text/<id>` blob is deleted alongside the `MYA1` blob
and the `MYC1` catalog entry, preserving cryptographic-erase semantics (§9.9).

A v0.1 client MUST reject `MYE5` and any unregistered magic; a next-major-version client MUST refuse
`MYE1` (§10.4).

### 9.16 Device-local sync baseline (`vault.head-state`, `MYH1`)

A **device-local** file at `<vault-root>/vault.head-state` that persists the device's **last-seen [vault head](sync-protocol.md)** so the rollback/fork checks of `sync-protocol.md` §5 survive a restart (without it, every launch would be a fresh trust-on-first-use, `sync-protocol.md` §6). It is a Phase 2 artefact: derived/written only once a vault syncs. Like `vault.quickunlock` (§9.14) it is **device-local — never synchronized and never backed up** (excluded from the §9.11.3 allowlist; a restored vault TOFU-re-bootstraps).

```
offset  size       field                  description
0       4 bytes    magic                  ASCII "MYH1"
4       1 byte     protocol_version       0x01
5       1 byte     head_format_version    mirrors the stored head's byte (sync-protocol.md §3.6)
6       N bytes    head_record            the full wire head: head_mac_input || head_mac
                                          (sync-protocol.md §3.2), where the trailing 32 bytes
                                          are the head's own HMAC-SHA-256 tag
```

Only the **TIP** is stored — a single head record, not the chain (ancestors, when needed for a merge, are pulled and verified lazily, `sync-protocol.md` §5.4). The write cadence is **every accepted-pull and every authored-push** (after a push the device's own head becomes its new baseline; otherwise the file would lag).

**Integrity, and the honest limit.** `vault.head-state` is **not** AEAD-encrypted under a KEK and carries **no §3.4 row**: its bytes are exactly the head the sync server already relays (hashes + version-vector metadata, no vault plaintext), so at-rest confidentiality would add nothing the server does not already see. Integrity against a **non-`root_key`** attacker (corruption, a tamperer without the key) is the head's **own** HMAC: on load the client recomputes `HMAC-SHA-256(DeriveSubkey(root_key, "vault-head-mac"), head_mac_input)` and MUST reject a mismatch — this re-uses the head's MAC under the same key (no new context string). What this does **not** provide is **freshness of the baseline itself**: an attacker who can both write the local disk **and** collude with a malicious server could swap the file for an *older but genuine* head (which passes its own HMAC) to make the device accept a server rollback. This is a **conjunction** beyond a pure malicious server (A1) — it requires local-disk-write (A4/A7) too — has bounded impact (stale **own** data, never forged or decrypted), and is narrowed further because the in-session baseline is monotone in RAM (`sync-protocol.md` §5.1). It is **accepted for v0.1 and documented** (`threat-model.md` §7); a hardware monotonic counter (TPM / Secure Enclave) that would close it is iceboxed. A v0.1 client MUST reject `MYH5` and any unregistered magic; a next-major-version client MUST refuse `MYH1` (§10.4).

### 9.17 AI embeddings blob (`vault.embeddings`, `MYR1`)

`vault.embeddings` is a vault-level singleton artifact carrying the **on-device AI embedding index** (semantic-search / Q&A vectors) in encrypted form (MYND-453, local-ai epic MYND-406–412). It lives next to `vault.meta` at `<vault-root>/vault.embeddings` and is AEAD-encrypted under a `root_key`-derived KEK. Like `vault.search` (§9.6) and `vault.indices` (§9.8), the outer envelope follows the fixed-offset binary discipline of §9.2 / §9.3 / §9.5, and the inner plaintext is **opaque to this layer** — the protocol codec treats it as raw bytes that the desktop client assembles and parses. It exists **only** when the `ai_enabled` preference is on; the on-device AI (`local-inference`) ships in the default build (`decisions.md` 2026-07-02), so in a normal build this reduces to the runtime beta opt-in, while a `--no-default-features` build never compiles the AI path and never writes it.

The embedding index is **plaintext-derived, RAM-resident state**: built from decrypted note content while the vault is unlocked, queried in memory for retrieval, and **zeroized on lock alongside the keys** (it is as sensitive as the open notes — [`../threat-model.md`](../threat-model.md) A6, §7). `vault.embeddings` is purely a **persistence cache** of that RAM state — it lets a warm unlock reload the vectors without re-embedding every note (a costly on-device inference pass). It is never the source of truth; the `.myn` files are. A missing, stale, or unreadable `vault.embeddings` is always recoverable by re-embedding from the notes (§9.17.4). It is the structural sibling of `vault.search`: same outer-envelope discipline, same engine-opaque inner plaintext, same `content_nonce` staleness manifest, same fall-to-rebuild posture — differing only in that its payload is dense embedding vectors and it carries a **model-identity invalidation tuple** (below) rather than an `extractor_version`.

#### 9.17.1 Outer envelope layout

All multi-byte integers are big-endian.

```
Offset  Size       Field                   Description
------  ---------  ----------------------  ------------------------------------
0       4 bytes    magic                   ASCII "MYR1"
4       1 byte     protocol_version        0x01 for this specification
5       1 byte     embeddings_format_version  0x02 = the current codec inner-plaintext
                                           format (§9.17.2); 0x01 was its predecessor
                                           and is rejected → rebuild. Distinct from
                                           protocol_version: a change to the ENGINE /
                                           codec SERIALIZATION bumps THIS byte, and
                                           0x01 → 0x02 is exactly that (the model-
                                           identity field became a tagged union).
                                           A snapshot whose model-identity tuple
                                           merely holds different VALUES (a different
                                           model / dimension / chunker) is rejected and
                                           re-embedded WITHOUT any byte changing —
                                           values live in the payload, shape lives
                                           here. A bumped byte makes an old decoder
                                           reject the blob and fall to rebuild
                                           (§9.17.4) rather than mis-parsing it.
6       24 bytes   embeddings_nonce        192-bit random nonce used to encrypt the
                                           inner plaintext under ai_embeddings_key.
30      4 bytes    ciphertext_len          Length M = plaintext_len + 32 of the
                                           inner ciphertext followed by the 32-byte
                                           CTX commitment tag T'.
34      M bytes    ciphertext              Inner plaintext (§9.17.2), AEAD-encrypted
                                           under ai_embeddings_key with
                                           embeddings_nonce, followed by the 32-byte
                                           CTX commitment tag T' (§5.1). AAD binding
                                           in §9.17.3.
```

The header is 34 bytes, identical in shape to `vault.search` (§9.6.1) / `vault.indices` (§9.8) except offset 5 carries `embeddings_format_version`. The KEK is `ai_embeddings_key = DeriveSubkey(root_key, "ai-embeddings-key")` per §3.2 + §3.4; as with `search_index_key` / `vault_indices_key`, no `ai_embeddings_key_id` field appears (it is selected deterministically from `root_key`).

Magic + `protocol_version` + `embeddings_format_version` MUST all be checked **before** any decryption is attempted (the magic-byte-before-decrypt discipline of §9.2 / §9.3). A mismatch on any of the three rejects the blob and the client re-embeds (§9.17.4).

#### 9.17.2 Inner plaintext (engine-opaque snapshot)

The inner plaintext is an **`embeddings_format_version`-tagged opaque payload**: this specification does NOT fix its internal structure, because the embedding store / vector layout is a client-implementation choice this layer must not constrain. For `embeddings_format_version 0x02` the payload is a [postcard](https://docs.rs/postcard)-serialized snapshot of three parts (`0x01` differed only in part 3 and is rejected → rebuild; see there for why the bump rather than a widening):

1. a **staleness manifest** — a map `note_id → content_nonce` recording, for each embedded note, the `.myn` `content_nonce` (§9.2) observed when it was embedded (the same decryption-free staleness signal `vault.search` uses, §9.6.4);
2. the **serialized embedding store** — the per-chunk records (each carrying its owning `note_id`, the chunk span, and the dense embedding vector) that the retrieval engine queries; and
3. a trailing **model-identity tuple** `{model_identity, embedding_dim, chunker_version}` — the identity of the pipeline that produced the vectors. `embedding_dim` is the vector dimensionality the model emits and `chunker_version` is the client's chunker-logic generation, both unchanged. `model_identity` is a **tagged union with two arms**, because as of `embeddings_format_version 0x02` the embedder need not be a file the client can read:

   - **file-hash** — `SHA-256` over the raw bytes of the selected embedding model's safetensors file, computed once at model-selection time (§9.17.4). Unchanged in meaning from `0x01`'s `model_hash`; this is what a side-loaded model still uses.
   - **served** — the model **name** plus the **content digest** the serving runtime reports for it. A model served over an API has no file the client can hash, and before `0x02` that case produced no identity at all — which meant the snapshot was never written and the whole vault was re-embedded on **every unlock**, silently reinstating the cost this blob exists to remove.

   A snapshot whose tuple differs from the client's current values is rejected → rebuild (§9.17.4), including across arms: a file-hash snapshot read by a client now using a served embedder is a mismatch, because the vectors are not comparable.

   **Why `0x02` rather than a compatible widening.** The payload is postcard, which is **non-self-describing**: a `0x01` snapshot begins with the 32 raw bytes of `model_hash`, and a `0x02` decoder reads a leading variant discriminant there. Most first bytes fail to decode, but a *valid-looking* discriminant would succeed and yield a **garbage identity** rather than a clean rejection — and a garbage identity that happens to match serves semantically wrong retrieval instead of rebuilding. The version bump makes the rejection deterministic. It costs nothing: `vault.embeddings` is a rebuildable cache, never synced and never backed up (§9.17.5), so an old snapshot simply rebuilds.

   **Not a major-version event.** This changes the *inner payload* only. `MYR1`, the AAD (§9.17.3), the `"myne.v0.1 ai-embeddings-key"` subkey role and every load-bearing identifier are untouched, and the tuple is deliberately not AAD-bound. `embeddings_format_version` is the envelope's own forward-migration hook and moving it is exactly its designed use — not a vault-identity or protocol event.

   **Residual, stated rather than left implicit.** The *served* arm trusts the runtime's own bookkeeping: a user who re-tags a **different** model under the same name and digest defeats the identity, and only the independent `embedding_dim` check would then notice — and only if the dimensionality also changed. A same-dimension substitution under an identical name is not detected. A fixed-probe-vector identity (embed a constant, hash the result) would catch it and was **rejected**: floating-point variation across hardware and runtimes would trigger spurious full re-embeds of the entire vault, which is a worse and far more frequent failure than the one it prevents (`decisions.md` 2026-08-09).

All three ride INSIDE the AEAD envelope by necessity: the manifest holds `note_id`s + `content_nonce`s (per-note correlation tags), and the store holds dense embedding vectors — a **plaintext-derived semantic representation of note content** (subject to embedding-inversion; [`../threat-model.md`](../threat-model.md) §7). None may appear in the cleartext header. Because the payload is engine-opaque, a v0.1 client that ships a different **vector store / serialization** bumps `embeddings_format_version` so older decoders reject the envelope and rebuild. The model-identity tuple is the embeddings analogue of `vault.search`'s trailing `extractor_version` (§9.6.2): it is an **inner-schema, desktop-codec-owned rebuild trigger, deliberately NOT bound into the AAD** (§9.17.3) and NOT the envelope version byte — a model swap is a cache-invalidation event, not a vault-identity or codec-format event, so it belongs in the same layer as `vault.search`'s `extractor_version`, following that precedent verbatim (design decision recorded in `decisions.md` 2026-07-02; the AAD stays vault-scoped exactly like every sibling blob).

Postcard (not the canonical JSON of §9.5.2) is chosen for the same reason as `vault.search` / `vault.indices` (§9.6.2): the vector store is large (a 384-dimensional `f32` vector is ~1.5 KiB per chunk, megabytes at a few thousand chunks) and is never cross-validated field-by-field.

#### 9.17.3 AAD construction

`AAD_ai_embeddings_blob` is defined in §5.2:

```
AAD_ai_embeddings_blob =
  AAD_prefix || protocol_version (1 B) || "ai-embeddings-blob" || account_number_hash (16 B)
```

`"ai-embeddings-blob"` is length-prefixed UTF-8 per §5.2's discipline (2-B big-endian length + 18 ASCII bytes, total 20 bytes). `account_number_hash` is the 16-byte field from `vault.meta` (§9.3 offset 6), binding the embeddings blob to its specific vault. Total AAD length: `10 + 1 + 20 + 16 = 47 bytes`. As with `vault.prefs` / `vault.search` / `vault.indices`, `items_key_id` is **not** bound — `ai_embeddings_key` derives directly from `root_key` via `"myne.v0.1 ai-embeddings-key"` (§3.4), independent of the `itemsKey` lineage (so it survives a later epoch-rotation `itemsKey` evolution). The model-identity tuple is deliberately **not** part of the AAD (§9.17.2): model-swap invalidation is handled inside the engine-opaque payload, following the `vault.search` `extractor_version` precedent, keeping the AAD shape identical to every sibling blob.

#### 9.17.4 Staleness detection, incremental reconcile, and fall-to-rebuild

`vault.embeddings` is a cache and MAY be stale relative to the `.myn` files (it is flushed lazily — on graceful lock/quit + a periodic timer / batched during a cold build — while an idle auto-lock skips the flush, exactly as `vault.search`). On unlock the client reconciles the loaded index against the current notes WITHOUT re-embedding unchanged notes, using the **`content_nonce` as a decryption-free staleness signal**, identically to `vault.search` (§9.6.4): for each on-disk note, an unchanged `content_nonce` means skip (no decrypt + no re-embed); a changed / absent one means decrypt, re-chunk, and re-embed that note; a manifest entry absent from disk means drop. The reconciled result is identical to a full rebuild of the same corpus under the same model (the load-bearing correctness property: a diff bug must never silently produce a different index than a rebuild).

The snapshot additionally records the **model-identity tuple** `{model_identity, embedding_dim, chunker_version}` (§9.17.2). A stored tuple that differs from the client's current values triggers a **full rebuild even when every `content_nonce` matches** — because embedding vectors are model-specific: a change of embedding model (a different `model_identity`, in either arm and across arms), a change of output dimensionality (`embedding_dim`), or a change of chunk boundaries (`chunker_version`) makes the stored vectors incomparable with freshly-embedded queries, so the whole index is re-embedded rather than serving semantically-wrong retrieval. It is the model-pipeline analogue of the `extractor_version` reject-and-rebuild, scoped to embedding-producing identity and owned by the desktop codec rather than the protocol envelope byte or the AAD.

**Fall-to-rebuild** is the fallback when incremental reconcile is impossible or untrusted: `vault.embeddings` absent, magic / version mismatch, AEAD verification failure, an unreadable manifest, or a mismatched / absent model-identity tuple. The client then rebuilds the index from scratch by decrypting every `.myn`, re-chunking, and re-embedding. The `content_nonce` is NOT a security signal — it is only an optimization hint; a rebuild never trusts the cache. Because rebuild always recovers the correct index, `vault.embeddings` carries no integrity-of-retrieval burden: a disk attacker who deletes or corrupts it costs the user one slower unlock (a full re-embed), nothing more.

#### 9.17.5 Residency, size cap, and fall-back semantic

**Residency.** The decrypted vectors are RAM-resident only while the vault is `Slot::Unlocked`. They are zeroized on the same path as the keys at **every** slot-drop site (manual lock, idle auto-lock, vault deletion, credential-rotation force-relock), on the same discipline as `vault.search` (§9.6.5). Manual lock/quit flushes to `vault.embeddings` first (persist-then-wipe); idle auto-lock skips the flush (fail-closed — no blob-write latency on the idle path) and the next unlock reconciles the missing delta. Nothing embedding-derived survives a lock.

**Size cap.** Implementations SHOULD reject `ciphertext_len > 268435456 + 32` (256 MiB plaintext cap + 32-byte CTX tag), bounding the parser's pre-AEAD allocation — parallel to the §9.6.5 cap rationale.

**Fall-back semantic.** Reading `vault.embeddings` returns the loaded index on success, or triggers fall-to-rebuild (§9.17.4) on any failure — the non-distinguishing-error discipline of §6.4 / §9.5.5, applied to embeddings. An attacker with disk-write access can only force a rebuild (a slower unlock); arbitrary vector injection requires breaking the AEAD (§6.4). Cross-vault: a `vault.embeddings` from vault A fails AEAD under vault B's `ai_embeddings_key` (different `root_key`) and `AAD_ai_embeddings_blob` (different `account_number_hash`).

**At-rest leakage.** The blob's size leaks a coarse signal about embedded volume (note / chunk count), analogous to the `.myn`-count / `vault.search`-size leaks — accepted for v0.1 as a derived-cache size signal ([`../threat-model.md`](../threat-model.md) A5 / §7; the embedding-inversion analysis is recorded there). `vault.embeddings` is a **rebuildable cache**: it is **never synced and never backed up** — device-local, re-derived locally per device (`sync-protocol.md` §319, Class 3), which is also why the model-specific vectors never travel to a device that may hold a different embedding model or none.

### 9.18 Pending-capture queue (`captures/<capture-id>`, `MYK1`)

A **pending capture** is a short piece of dictated note text relayed from a paired Apple Watch (via WatchConnectivity) to the phone while the vault may be **locked**. It cannot be written into the vault immediately (that needs the unlocked `itemsKey`), so it is held in a **device-local, encrypted queue** — one `MYK1` file per capture at `captures/<capture-id-hex>` under the app data directory — and drained into the vault as an ordinary new note on the next unlock (client-side; the watch app is native SwiftUI and holds **no** vault key material). Landed with the mobile watch-capture feature; see `decisions.md` 2026-07-12.

Unlike every other §9 blob, the queue is created while the vault is locked and is **vault-agnostic**: at enqueue time the client does not know which vault the capture will land in (nor which vault the user will unlock next), so the entry binds **neither** `account_number_hash` **nor** `items_key_id`. On unlock the queue drains into **whichever vault is unlocked** — the single-primary-vault model of the feature. The queue and its wrap key are **device-local**: never synced, never backed up (like `vault.embeddings`, `sync-protocol.md` Class 3).

#### 9.18.1 On-disk layout

```text
Offset  Size  Field             Notes
------  ----  ----------------  ------------------------------------
0       4     magic             ASCII "MYK1"
4       1     protocol_version  0x01
5       16    capture_id        random UUIDv7; ALSO the queue filename; AAD-bound
21      24    wrap_nonce        XChaCha20-Poly1305 nonce
45      4     ciphertext_len    big-endian uint32, = plaintext_len + 32
49      ..    ciphertext        dictated UTF-8 AEAD-sealed + 32-byte CTX tag
```

Header = 49 bytes. The 16-byte `capture_id` is a random UUIDv7 that is ALSO the queue filename (`captures/<capture-id-hex>`) and is bound into the AAD (§9.18.3), so a tampered header `capture_id` fails AEAD rather than silently re-labelling the entry. `ciphertext_len` is variable (`plaintext_len + 32`); the reserved-byte / fixed-length disciplines of `vault.prefs` / `vault.quickunlock` do not apply.

#### 9.18.2 Device-local wrap key (no SubkeyRole)

Like `vault.quickunlock` (§9.14), the `MYK1` entry is sealed under a **device-local 32-byte `wrap_key`** held in the OS keychain, **NOT** a `DeriveSubkey(root_key, …)` subkey — a `root_key`-derived KEK would be wrong here because the queue must be writable while `root_key` is unavailable (the vault is locked). The key is minted once per device, is **non-biometric** (so a background enqueue never triggers a biometric prompt), and is stored with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — background-seal-friendly: a capture that arrives while the screen is locked can still be sealed after the first post-boot unlock, minimising the transient plaintext window (§9.18.4). There is no HKDF context string and no §10.3 subkey role for this key (the codec is provider-agnostic — it only ever sees a symmetric `wrap_key`).

#### 9.18.3 AAD

`AAD_pending_capture_blob` binds the per-entry `capture_id` (16 bytes) after the role string `"pending-capture-blob"` (length-prefixed UTF-8: 2-B big-endian length + 20 ASCII bytes):

```text
AAD_pending_capture_blob =
  AAD_prefix (10 B) || protocol_version (1 B) || u16_be(20) || "pending-capture-blob" (20 B) || capture_id (16 B)
```

Total AAD length: `10 + 1 + 22 + 16 = 49 bytes`. Binding `capture_id` — **not** a vault identity — is what makes a single device key safe across every queue entry: a tampered header `capture_id` fails AEAD (§6.4, non-distinguishing), so one entry's ciphertext cannot be re-labelled as another's.

**What the binding does not cover.** The AAD binds the `capture_id` carried in the blob **header**, not the one carried in the **filename**. A sealed entry copied or renamed to a second `capture_id` filename is unaltered, so it still opens: its header and its AAD remain internally consistent. An attacker with write access to the queue directory can therefore cause one dictated capture to drain twice. Detecting that is a **reader-side** obligation, specified in §9.18.4, not a property of this construction — and §9.20.3 carries the same limit for the share-import queue.

#### 9.18.4 Size cap, drain, and transient plaintext

Implementations MUST reject `ciphertext_len > 16384 + 32` (16 KiB plaintext cap + 32-byte CTX tag), bounding the parser's pre-AEAD allocation — a dictated note is short. Drain is **at-least-once**: the client decrypts each entry, creates a note via the ordinary note-create path (§6.1), then deletes the entry; a crash between note-create and delete re-drains that entry into a rare duplicate note (accepted; `decisions.md` 2026-07-12).

**Filename/header agreement (reader-side MUST).** Before draining an entry, the client MUST decode the filename's 32-hex `capture_id` and compare it against the `capture_id` in the blob header (§9.18.1 offset 6), and MUST skip any entry where they differ. This is the check that closes the copy-to-a-second-name duplication §9.18.3 leaves open; the AEAD cannot close it, because a copied file is unaltered and opens correctly. Two constraints on the check itself: the filename decode MUST be case-insensitive (the queue's own filename validator accepts `A-F`, so a lowercase-only decode would reject entries the writer produced), and a mismatched entry MUST be **skipped, not deleted** — its correctly-named twin is a valid drainable entry, and a delete driven by attacker-controlled filesystem state is the wrong reflex. The delete-on-failure policy applies to entries that can never decode, which is a different case.

**Transient plaintext (carve-out).** The dictated text exists as plaintext in two OS-Data-Protection-only transients *before* it is sealed into `MYK1`: the watch's WatchConnectivity outbox and the phone's staging file (written by the native receiver before the Rust seal). These are short-lived, contain only not-yet-committed captures (never existing vault content), and are enumerated in [`../threat-model.md`](../threat-model.md). The watch stays crypto-free by design — encrypting the outbox would require key material on a device deliberately kept key-free (`decisions.md` 2026-07-12).

### 9.19 Graph layout cache (`vault.graph`, `MYG1`)

`vault.graph` is a vault-level singleton **rebuildable cache** holding the knowledge-graph view's laid-out node positions (`note_id → x/y`) plus a schema-version marker, so reopening the app restores the previous force-directed layout instead of recomputing it. It lives next to `vault.meta` at `<vault-root>/vault.graph` and is AEAD-encrypted under a `root_key`-derived KEK. It is a structural sibling of `vault.workspace` (§9.7): same outer-envelope discipline, same **engine-opaque** inner plaintext (the desktop client serializes the position map; the codec sees only bytes), same fall-to-rebuild posture. It differs in that its payload is node coordinates and its staleness handling is **caller-side and loose** — a layout carrying positions for a note-set that has since drifted is still usable (missing notes are seeded fresh, extra positions ignored), and the user can force a full re-layout via the graph's Refresh control.

#### 9.19.1 Outer envelope layout

```text
Offset  Size  Field                        Notes
------  ----  ---------------------------  --------------------------------
0       4     magic                        ASCII "MYG1"
4       1     protocol_version             0x01
5       1     graph_layout_format_version  0x01 = the initial position-map inner
                                           schema; any other value → the client
                                           falls back to recomputing the layout
6       24    nonce                        XChaCha20-Poly1305 nonce
30      4     ciphertext_len               big-endian uint32, plaintext_len + 32
34      M     ciphertext                   AEAD ciphertext + 32-byte CTX tag T'
```

The 34-byte fixed-offset header is the shared blob-envelope framing of §9.6/§9.7. Magic / `protocol_version` / `graph_layout_format_version` / `ciphertext_len` are all validated **before** any decryption; `ciphertext_len` is bounds-checked against `MAX_GRAPH_LAYOUT_PLAINTEXT_LEN + 32` before any slice indexing (DoS-allocation defense).

#### 9.19.2 Inner plaintext (engine-opaque)

The plaintext is a client-serialized position map + a schema version; the codec is byte-transparent. The desktop client's v0.1 form is `{ "v": 1, "pos": [[<note_id>, x, y], …] }`; the mobile client (Phase 3) writes the same form under the same `graph_layout_format_version` `0x01` into its own device-local `vault.graph` — the file never crosses devices (Class 3, never synced/backed up), so the shared form is a convenience, not a cross-device compatibility requirement. A different `graph_layout_format_version` (offset 5) lets a future serialization be recognized and dropped (→ recompute) rather than mis-parsed. Maximum plaintext is **16 MiB** (`MAX_GRAPH_LAYOUT_PLAINTEXT_LEN`) — generous for one small record per note (≈ 200k notes) while still bounding the pre-AEAD allocation.

#### 9.19.3 AAD construction

`AAD_graph_layout_blob` mirrors `AAD_workspace_blob` exactly, with the role string `"graph-layout-blob"` (length-prefixed UTF-8: 2-B big-endian length + 17 ASCII bytes, total 19 bytes) and the 16-byte `account_number_hash` from `vault.meta` (§9.3 offset 6). Total AAD length: `10 + 1 + 19 + 16 = 46 bytes`. As with prefs/search/workspace, `items_key_id` is **not** bound — `graph_layout_key` derives directly from `root_key` via `"myne.v0.1 graph-layout-key"` (§3.4), independent of the `itemsKey` lineage (so it survives a later epoch rotation).

#### 9.19.4 Staleness + rebuild + residency

A missing, unreadable, unsupported-format, or AEAD-failing `vault.graph` is **always recoverable** by recomputing the layout — the `.myn` files (via the wikilink graph) are the source of truth. The reader collapses every such failure to "no restored layout" and recomputes; it never surfaces as data loss. Unlike `vault.search`/`vault.embeddings`, there is **no `content_nonce` reconcile manifest**: the layout is a visual aid whose staleness degrades gracefully (a note added since the last save simply gets a fresh seed on next layout), so precise invalidation is unnecessary. Positions are RAM-resident while the graph is open and are dropped on vault lock (so vault A's layout never seeds vault B). It is **never synced and never backed up** — a device that lacks it re-runs the layout locally (Class 3 rebuildable cache; `sync-protocol.md` §326, backup allowlist §9.11.3).

### 9.20 Share-import staging queue (`pending-shares/<share-id>`, `MYF1`)

> **Magic allocation.** `MYF1`/`MYF5` is a free-pool §10.3 allocation (F = *file*, MYND-507), chosen the same way every family's magic is (implementer-picked from the free pool). A later letter change would be a mechanical rename, not a format change.

A file shared into Myne via the OS share sheet (iOS Share Extension / Android `ACTION_SEND`) arrives at a process that does not hold `root_key` — the iOS extension is a separate sandbox, and on Android the vault may be locked when the intent fires. It cannot enter the attachment library yet (that needs the unlocked `items_key`, §9.9), so it is held in a **device-local encrypted queue** until the next unlock, when it drains into the library via the ordinary `attachment_import` path. This is the file-carrying sibling of §9.18 (pending-capture): same device-key seal and vault-agnostic per-entry-id AAD binding, but the plaintext is a **binary file** (framed with its filename + declared MIME), the cap is **64 MiB** (matching the `MYA1` attachment cap, not 16 KiB), and it drains to an attachment (not a note).

#### 9.20.1 Layout

`<app-container>/pending-shares/sealed/` holds `MYF1` blobs named by the hex `share_id`. How a shared file reaches `sealed/` differs per platform:

- **iOS — plaintext-staging (like §9.18.4).** The Share Extension is a separate sandboxed process that cannot practically link the Rust crypto (doing so pulls the whole WebView runtime into a ~105 MiB extension the OS jetsams on launch), so it does **not** seal in-process. Instead it writes each shared file's bytes plus a `.meta` sidecar as **plaintext** into `<app-group>/pending-shares/staging/` (with `.completeFileProtection`, so iOS encrypts it at rest while the device is locked); the **app** seals each staged file into an `MYF1` blob under `sealed/` and deletes the plaintext on next open. This is the same native-side-stages-plaintext / app-seals pattern as the §9.18.4 watch-capture staging file (a persistent OS-Data-Protection-only plaintext window, not a RAM-only transient). On iOS both directories resolve to the shared **App Group** container so the extension (writer) and the app (reader/sealer) agree.
- **Android — no persistent plaintext file.** The `ACTION_SEND` receiver reads the `content://` bytes, base64-encodes them, and delivers them to the WebView as a `share-intent` event; the JS layer invokes `seal_share`, which seals straight into `sealed/`. There is no `staging/` directory on Android — the plaintext exists only transiently in RAM (and, en route, as a base64 string that crosses the WebView; see §9.20.4).

#### 9.20.2 Key

Like §9.18, the `MYF1` entry is sealed under a **device-local 32-byte `wrap_key`** held in the OS keychain (Apple) / Keystore (Android), **NOT** a `DeriveSubkey(root_key, …)` subkey — the queue must be writable while `root_key` is unavailable. Non-biometric, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` on Apple; the equivalent device-only, non-biometric Android Keystore key on Android. The keychain service string is `md.myne.shareimport`, DISTINCT from `md.myne.captures`. No HKDF context and no §10.3 subkey role (provider-agnostic).

#### 9.20.3 Blob format

Header (49 bytes): `magic "MYF1"(4) ∥ protocol_version 0x01(1) ∥ share_id(16) ∥ wrap_nonce(24) ∥ ciphertext_len(u32 BE)`, then the CTX-committed XChaCha20-Poly1305 ciphertext. AAD = `aad_share_import_blob(share_id)` (length-prefixed role `"share-import-blob"`, AAD prefix `"myne.v0.1|"`), binding the per-entry `share_id` only (vault-agnostic — no `account_number_hash`/`items_key_id`). The sealed plaintext is an opaque, core-framed record `filename_len(u16 BE) ∥ filename(utf8) ∥ mime_len(u16 BE) ∥ mime(utf8) ∥ file_bytes`; filename + MIME are hints (the drain re-sniffs MIME authoritatively per §9.9), so they are confidential-but-not-AAD-bound. The header `share_id` is AAD-bound, so tampering with it fails AEAD rather than re-labelling the entry.

#### 9.20.4 Size cap, drain, and transient plaintext

Implementations MUST reject `ciphertext_len > 67108864 + 32` (64 MiB plaintext cap + 32-byte CTX tag) before allocating. The seal drops any entry whose framed plaintext exceeds the cap (no poison-oversize entry that re-fails every drain). Drain is **at-least-once**: the client decrypts each entry, imports it via `attachment_import` (§9.9), then deletes the entry; a crash between import and delete re-drains into a content-addressed dedup hit (harmless). Landing is the active unlocked vault (as §9.18, "whichever vault unlocks first"). The queue never syncs and is never in a backup (TB2).

**Filename/header agreement (reader-side MUST).** As in §9.18.4, and for the same reason: the AAD binds the `share_id` in the header, not the one in the filename, so a sealed entry copied to a second filename still opens. Before draining, the client MUST decode the filename's 32-hex `share_id` case-insensitively, compare it against the header `share_id` (§9.20.3), and **skip** — never delete — any entry where the two differ. The consequence here is milder than the capture queue's: a duplicate drain lands as a content-addressed dedup hit rather than a duplicate note. The check is specified anyway so the two device-local queues do not diverge on a property a reader of one will assume of the other.

**Transient plaintext (carve-out).** The shared bytes exist as plaintext, protected only by OS Data Protection, *before* they are sealed into `MYF1`:

- **iOS: a persistent plaintext staging file.** The Share Extension writes the file's bytes + a `.meta` sidecar into `<app-group>/pending-shares/staging/` (`.completeFileProtection`), where it persists until the app next opens, seals it, and deletes it — the same at-rest plaintext window as the §9.18.4 watch-capture staging file, not a RAM-only transient. Device-local, in the App-Group container, never synced.
- **Android: a RAM + WebView-transit transient.** The `content://` bytes are read into RAM by the native receiver and cross the WebView as a base64 string (§9.20.1) before `seal_share` seals them; no persistent plaintext file is written.

Both hold only the just-shared file (never existing vault content), are device-local, and are enumerated in [`../threat-model.md`](../threat-model.md) (AS19), analogous to the §9.18.4 carve-out.

### 9.21 Custom-themes blob (`vault.themes`, `MYT1`)

A **custom theme** is a user-authored palette — a flat map of CSS custom properties (`{ "--token": "value" }`, `decisions.md` 2026-06-16) — that overrides the built-in Light/Dark ramp. The palette is **vault content**: it is sealed into a single encrypted `vault.themes` blob, so it is encrypted at rest, synced (§9.21.5), and included in a backup. This supersedes the original device-local-plaintext storage (`app_config_dir/themes/<name>.json`); see `decisions.md` 2026-07-16. The *selection* (which theme is active) remains the `custom_theme` field of `vault.prefs` (§9.5.2) — the blob holds the palettes, prefs holds the pointer.

Like `vault.dictionary` (§9.13), this is a **singleton** blob, not a per-item family with a catalog: a vault has a handful of themes, so the attachment-style separate-blob + catalog (`MYA1`+`MYC1`) would be overkill.

#### 9.21.1 Layout

```text
Offset  Size       Field                  Description
------  ---------  ---------------------  ----------------------------------------
0       4 bytes    magic                  ASCII "MYT1"
4       1 byte     protocol_version       0x01 for this specification
5       1 byte     themes_format_version  0x01 = the v0.1 inner palette-map format
                                          (§9.21.2). Distinct from protocol_version:
                                          the crypto framing (magic, version, AEAD,
                                          AAD) is fixed by this spec, while the inner
                                          plaintext may evolve behind this byte. An
                                          unknown value is rejected BEFORE decryption.
6       24 bytes   nonce                  XChaCha20-Poly1305 nonce
30      4 bytes    ciphertext_len         Big-endian uint32 = plaintext_len + 32
34      ..         ciphertext             AEAD-sealed inner map + 32-byte CTX tag
```

Header = 34 bytes — the minimal vault-singleton envelope shared with `vault.dictionary` (§9.13.1), not §9.2's 50-byte per-note prefix.

There is **no public `account_number_hash` byte** (and no `custom_themes_key_id`): both bind cryptographically — the vault through `AAD_custom_themes_blob` (§9.21.3), the key through `root_key` derivation — without spending header bytes or putting a vault-linkable field on disk in plaintext (§9.4). This is §9.13.1's rule, inherited verbatim.

The size cap and the read semantic are §9.21.4.

#### 9.21.2 Inner format (`themes_format_version = 0x01`) — per-name entries

The sealed plaintext is a deterministic (canonical-key-order) JSON map keyed by theme name:

```text
{ "<name>": { "created_at": <unix-seconds>,
              "deleted_at": <unix-seconds>,   // present iff tombstoned
              "palette": { "--token": "value", … },
              "updated_at": <unix-seconds>,
              "version": <counter>            // causal merge key; absent = 0
            }, … }
```

Keys are emitted in lexicographic order (the canonical-JSON rule of §9.5.2); `deleted_at` is **omitted** unless the entry is a tombstone, so a live entry stays compact and its *presence* is the tombstone discriminator.

Each name carries its **own clocks**. This is load-bearing for the merge (§9.21.5): without per-name clocks, two devices that concurrently add different themes would lose one of them. The clocks are wall-clock **seconds** — the same clock the attachments catalog uses (§9.10), whose tombstone rules this format reuses; note this differs from the `vault.prefs` `field_clocks`, which are milliseconds (§9.5.2). They inherit the clock-honesty caveat of `sync-protocol.md` §11.4 verbatim — they order edits, they are not a security property.

Each name additionally carries a **`version`** — a monotonic causal merge counter (u64, `#[serde(default)]`, absent = 0), bumped to `max(observed for this name) + 1` on any local mutation. It is the **primary key of the merge join** (`sync-protocol.md` §10.2.2): the greater `version` wins, and the wall-clock fields above only break an equal-`version` tie — which is what makes the merge associative (myne-md/myne#405). Like `deleted_at`/`updated_at` for the catalog (§9.10.2) it is an additive optional field, so the `MYT1` magic and envelope are **unchanged** (no §10.3 event) and a pre-#405 blob decodes with `version = 0`. It sorts last in canonical key order (after `updated_at`).

A **tombstone** is an entry whose `deleted_at` is set. Deleting a theme writes a tombstone rather than removing the key, so the deletion propagates instead of the theme resurrecting from another device. The tombstone **MUST scrub the `palette`** so the synced store retains nothing descriptive about a deleted theme (the `AttachmentMeta` rule of §9.10). Scrubbing is a confidentiality measure and **does not** by itself make two tombstones byte-identical — `created_at` and `updated_at` survive it and diverge whenever one device carried an unsynced edit; convergence is delivered by the total-order tie-break of `sync-protocol.md` §10.2.2, not by the scrub. Tombstones are not garbage-collected: a tombstone is a name plus timestamps, and a vault holds single-digit theme counts. Readers (list / read / export) MUST skip tombstoned entries.

Theme names are constrained to `1..=64` characters of `[A-Za-z0-9_-]` (`decisions.md` 2026-06-16 clause (e)) — no `.`, no separators, no traversal. The **value-shape allowlist** (2026-06-16 clause (d)) still gates every palette value at import; promotion to vault content does not relax it. A custom theme remains **validated, not sandboxed**.

The palette's **key set is open beyond the required colour core**, and this is a property of the format rather than a later extension of it. A palette is a flat `{ "--token": "value" }` map: only the required ramp tokens are mandatory and every other key is optional. A key the reading client does not recognize is applied to the DOM and simply resolves to nothing — with one deliberate exception: a key the client recognizes as *ornament* but whose **value** it does not know is dropped on read (`myne#394`), so the primitive renders plain rather than half-configured. That filtering is a read-time behaviour and does not touch the stored blob, but it does mean a theme exported through an older client loses ornament selections that client could not interpret. Growing the vocabulary — the measure tokens, the ornament keys of `decisions.md` 2026-08-06 — therefore changes no byte of this section: no magic, no `themes_format_version` bump, no AAD or subkey change, and no migration, because a pre-existing theme is already a valid instance of the wider vocabulary and a newer theme read by an older client degrades to the keys that client knows. What such growth may **never** do is widen the value-shape allowlist above; the two are independent, and only the allowlist is security-load-bearing.

#### 9.21.3 Key + AAD

`custom_themes_key = DeriveSubkey(root_key, "custom-themes-key")` (§3.2 + §3.4) — `root_key`-derived and `itemsKey`-independent, like prefs/search/workspace/dictionary. The AAD is `AAD_custom_themes_blob` (§5.2), binding `account_number_hash`; `items_key_id` is **not** bound.

#### 9.21.4 Size cap, fall-back-to-empty, and non-load-bearing class

Implementations MUST reject `ciphertext_len > 4 MiB + 32` **before allocating**. 4 MiB is
generous headroom over a realistic theme store (a palette is a flat map of a few dozen short
CSS-variable strings; hundreds of themes stay well under a MiB) and bounds the pre-AEAD
allocation footprint (the §9.5.4 / §9.6.5 DoS-allocation discipline).

Read semantic is **fall-back-to-empty** on ANY failure (file absent / truncated /
magic-or-version-or-format mismatch / AEAD verification failure / inner-parse failure) → the
empty store `{}`, per the §9.5.5 / §6.4 non-distinguishing-error discipline. A vault that never
imported a theme simply has **no `vault.themes` file** (it is written only when non-empty), so a
pre-MYND-486 vault is byte-identical.

Falling back to empty rather than failing closed is safe **because a custom theme is not
load-bearing**: it is a validated (not sandboxed) cosmetic palette, so the worst case of losing
it is the app rendering in the default theme. This is the same class as `vault.dictionary`
(§9.13.4), and it is why an unreadable themes blob must never block unlock.

#### 9.21.5 Sync + backup

`vault.themes` is **Class-1 Authoritative data** (`sync-protocol.md` §9) — a synced singleton outside the head manifest, addressed by the reserved blob-id `themes_sync_id = DeriveSubkey(root_key, "themes-sync-id")[0..16]` (§3.4). Merge is **per-theme-name**, with the palette **LWW within a name** (a palette is one coherent design; merging it token-by-token would produce an incoherent result). Deletion follows the attachments-catalog tombstone rule (`sync-protocol.md` §10.2.2 + §11.4): reconciliation is a join over the per-entry causal **`version`** (§9.21.2) — the greater `version` wins (a re-add observes the delete and outranks the tombstone), and on an equal-`version` tie the tombstone wins (remove-wins, the resurrection guard), which makes the merge associative (myne-md/myne#405). It is also a §9.11.3 backup-allowlist member, preserving the `sync ⊆ backup` invariant.

### 9.22 Sealed label store (`vault.label`, `MYL1`)

> **Magic allocation.** `MYL1`/`MYL5` is a free-pool §10.3 allocation (L = *label*, myne-md/myne#411), chosen the same way every family's magic is (implementer-picked from the free pool, as §9.20's `MYF1` row records). A later letter change would be a mechanical rename, not a format change.

A vault's human-readable **name** is the `label` field of `vault.prefs` (§9.5.2), which is AEAD-sealed under a `root_key`-derived KEK and therefore readable only after that vault is unlocked. The vault picker runs **before** any unlock, so it can only render a neutral fallback. `vault.label` is the device-local cache that closes that gap: one file per vault at the vault root beside `vault.quickunlock`, carrying the label and nothing else, sealed under a **per-vault** 32-byte `wrap_key` held in the OS keychain. Landed with myne-md/myne#411; see `decisions.md` 2026-08-15, which supersedes the "no plaintext label is ever written at rest" clause of 2026-06-09.

It is a sibling of the two device-local staging queues (§9.18, §9.20) and shares their keychain-held `wrap_key`, their **no SubkeyRole** posture and their 49-byte header. It differs from both in that it is **not** vault-agnostic: it belongs to exactly one vault, binds that vault's identity, and its key is scoped the same way (§9.22.2).

A vault this device has never unlocked has no `vault.label` file, and that is the correct state rather than a gap: there is no key with which to read a label the device has never held. The reader falls back to the neutral name.

The store is **device-local**: never synced (`sync-protocol.md` Class 4) and never in a backup, because the §9.11.3 member set is a closed allowlist, so a new family is excluded by construction rather than by an exclusion anyone maintains.

**Generation-independent (normative).** `vault.label` is `MYL1` in every vault, whatever generation the vault itself is. A vault born v0.2 (§10.3.1) carries an `MYL1` `vault.label` beside its `NTV5` `vault.meta` and its `MYP5`/`MYC5` singletons, and a compliant client MUST write `MYL1` there rather than an `MYL5`. This is a **recorded exception** to §10.3.1 point 1 ("a client MUST NOT write a v0.1 blob into a v0.2 vault") rather than an oversight of it, and it follows the precedent §10.4.1 point 2 already sets for the device-local caches, which keep their v0.1 framing on a v0.2 root. It holds here for a stronger reason than it holds there: those caches keep v0.1 because a cache never crosses a generation boundary, whereas this family has **no generation to follow at all**. Its `wrap_key` is an OS-keychain item and not a `DeriveSubkey(root_key, …)` product (§9.22.2), so no KDF, no KEK context and no `root_key` lineage forces a version on its bytes, and its AAD prefix is fixed by this section rather than inherited from the vault. A reader MUST NOT treat an `MYL1` file beside an `NTV5` `vault.meta` as the hybrid-vault defect §10.3.1 point 1 describes. `MYL5` (§10.3) is therefore reserved against a future revision of **this family's own layout**, not against the v0.1/v0.2 boundary, which this file does not cross.

#### 9.22.1 On-disk layout

```text
Offset  Size  Field             Notes
------  ----  ----------------  ------------------------------------
0       4     magic             ASCII "MYL1"
4       1     protocol_version  0x01
5       16    vault_id          the UUIDv7 naming vaults/<id>/; AAD-bound
21      24    wrap_nonce        XChaCha20-Poly1305 nonce
45      4     ciphertext_len    big-endian uint32, = plaintext_len + 32
49      ..    ciphertext        UTF-8 label AEAD-sealed + 32-byte CTX tag
```

Header = 49 bytes, the §9.18.1 / §9.20.3 shape with `vault_id` where those carry a per-entry id. The `vault_id` is already the name of the enclosing directory, so putting it in the header leaks nothing that the filesystem does not; what it buys is a structural reject before any key is touched. `ciphertext_len` is variable (`plaintext_len + 32`).

Magic, `protocol_version`, the `vault_id` binding, `ciphertext_len` and the §10.3.1 strict-trailing equality are all validated **before** any decryption is attempted.

#### 9.22.2 Per-vault wrap key (no SubkeyRole)

The blob is sealed under a **32-byte `wrap_key` held in the OS keychain**, **NOT** a `DeriveSubkey(root_key, …)` subkey. There is no HKDF context string and no §10.3 subkey role; the codec is provider-agnostic and only ever sees a symmetric key. The key is non-biometric (the picker reads it on every launch, and a biometric prompt to render a list would be absurd) and device-only (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` on Apple, the equivalent non-exportable device-only key elsewhere). The keychain service string is `md.myne.vaultlabel`, DISTINCT from `md.myne.quickunlock`, `md.myne.captures` and `md.myne.shareimport`.

Two properties of the key are normative, and both are about erase rather than confidentiality.

**One key per vault, keyed by `VaultId`.** §9.18 and §9.20 each mint one device-global key because an entry is enqueued before anyone knows which vault it lands in. That shape is wrong here: vault deletion carries a per-`VaultId` cryptographic-erase guarantee, and under a shared key a deleted vault's name would stay readable while the key lived, weakening the guarantee at the one artefact a person actually recognises. Per-vault scoping is what lets deletion destroy exactly one vault's name.

**A derived subkey would not do.** It fails twice over. The label must be readable while the vault is **locked**, so `root_key` does not exist at read time; and a derived subkey cannot be destroyed on its own while its root survives, so it would only look like per-vault erase. This is the §9.14/§9.18 no-circular-KEK argument plus an erase argument the queues do not need.

#### 9.22.3 AAD

`AAD_vault_label_blob` binds the 16-byte `vault_id` after the role string `"vault-label-blob"` (length-prefixed UTF-8: 2-B big-endian length + 16 ASCII bytes):

```text
AAD_vault_label_blob =
  AAD_prefix (10 B) || protocol_version (1 B) || u16_be(16) || "vault-label-blob" (16 B) || vault_id (16 B)
```

Total AAD length: `10 + 1 + 18 + 16 = 45 bytes`. Neither `account_number_hash` nor `items_key_id` is bound: the label lives outside every `root_key` lineage, and the vault directory rather than the account is what the file belongs to (one account can hold two vault directories on one device).

**The bound `vault_id` is the one the READER expected, not merely the one the blob carries.** §9.18.3 and §9.20.3 both record a limit they cannot close: their AAD binds the id in the header, so a sealed entry copied to a second filename is unaltered and still opens, and agreement is left to a reader-side check. Here the caller already knows which vault it is reading (the id is the directory it is reading from), so the expected id goes into the AAD and the header's copy is compared against it first. A file moved between vault directories therefore fails AEAD, and does so structurally rather than because an implementer remembered a comparison. Implementations MUST bind the expected `vault_id` and MUST reject a header whose `vault_id` differs from it.

#### 9.22.4 Size cap, empty labels, and read semantics

Implementations MUST reject `ciphertext_len > 4096 + 32` (4 KiB plaintext cap + 32-byte CTX tag) before allocating. A vault name is a few words, so the cap is several orders of magnitude of headroom while still bounding the pre-AEAD allocation (the §9.5.4 / §9.6.5 DoS-allocation discipline). An over-cap label is refused at write time rather than truncated: a silently shortened name is a wrong name.

**Clearing a name removes the file**; an empty label is never stored. Implementations MUST NOT write a zero-length plaintext, so "no file" is the single representation of "this device has no name for that vault" and a reader has one case to get right instead of two.

Read semantic is **fall-back-to-neutral** on any failure (file absent, truncated, magic/version/vault-id mismatch, AEAD verification failure, non-UTF-8 plaintext): the picker shows the neutral label, per the §6.4 non-distinguishing-error discipline. A failure MUST NOT surface as an error on the picker: a name is a convenience, and a vault whose name cannot be read still opens normally.

Two of those failures are worth separating in an implementation, because they are different facts. A file whose **key is gone** can never be read again (the restore-onto-a-new-device case, and what the erase below leaves behind), so the file is deleted and the row falls back silently. The **keychain being unavailable as a whole** is a different state: nothing is wrong with the file, the facility is missing, and an implementation that offers the option below has to be able to say so rather than appear to do nothing.

#### 9.22.5 Erase, and what it does not reach

Making a name unreadable means **destroying its key**, not rewriting or deleting the file. Rewriting a plaintext file removes bytes from the file's current contents and not from the medium: on a copy-on-write or journalled filesystem, and after any snapshot or SSD relocation, the old bytes survive. This is the project's settled posture, fixed by `decisions.md` 2026-05-07 when it rejected platform-specific secure-delete for note deletion. Removing the `vault.label` file is tidiness that follows the key destruction, never a substitute for it, and an implementation MUST destroy the key before removing the file so a crash between the two leaves unreadable ciphertext rather than a live key beside a deleted file.

Two paths destroy a key. **Vault deletion** destroys that vault's key, which is what keeps the per-`VaultId` cryptographic-erase guarantee whole. A device-wide **hide-vault-names** option destroys every per-vault key, removes every `vault.label` file, and stops future writes; turning it off again resurrects nothing, because names reappear only as each vault is unlocked afresh.

Three limits are recorded here rather than rounded off; the first two are stated to the user rather than left to be discovered ([`../threat-model.md`](../threat-model.md) §7):

- **Crypto-erase protects against someone who reads the medium afterwards.** A full-system snapshot taken while names were enabled carries both the ciphertext and the keychain, and destroying the key later does not reach that copy.
- **The cache is device-local and does not sync**, so renaming a vault on one device leaves the old name on every other device's lock screen until that vault is unlocked there. A locked device cannot learn otherwise: the authoritative name is inside `vault.prefs`.
- **The device-wide sweep reaches only the vaults it can still see.** Its set is the vaults discovered by scanning `vaults/`, and a keychain offers `get`/`store`/`delete` of a **named** item, not enumeration of the items one application has stored. A `wrap_key` whose `vaults/<id>/` directory is no longer on disk is therefore never visited and **survives the sweep**. Three ordinary routes reach that state: a vault directory removed outside the app, a vault deletion whose teardown failed after the directory went and before the key did, and a restore that dropped a directory. This limit matters precisely because this section is explicit that deleting the file is not the erase: an orphaned key over a copy of that ciphertext, from a backup image or a snapshot, is the readable state the erase exists to prevent, and it is the one case where the file's removal is doing the work rather than the key destruction. Closing it needs enumeration of the items held under the family's own keychain service (`md.myne.vaultlabel`, §9.22.2), which is a per-platform capability rather than a property of this format, so it is recorded as a limit rather than specified as a requirement.

**Falling back to a plaintext name when no keychain is available is forbidden.** It would look identical on screen while voiding the erase guarantee and making the threat-model paragraph false.

## 10. Protocol Versioning & Migration

### 10.1 Design principle: forward-incompatible by design

> Myne protocol versions are **forward-incompatible by design**. Each major version (v0.1, the next major version, …) is a complete, self-contained specification with distinct magic bytes, AAD domain prefix, and key-derivation contexts. Forward compatibility *within* a major version is permitted (v0.1.1 reads v0.1.0 blobs); cross-major compatibility is exclusively achieved through explicit migration. A vault encrypted under one major version cannot be opened by a client of another major version without invoking the migration procedure (§10.4). This design choice eliminates downgrade attacks by construction and permits each major version to be audited as a closed system.

This commitment is normative. Implementations MUST refuse to parse blobs that do not match their declared major version, and MUST present a migration prompt rather than attempt automatic cross-version reads.

### 10.2 Versioning conventions

- **Major versions** are identified by distinct magic bytes (`MY01`, `MYV1` for v0.1; `NT05`, `NTV5` reserved for the next major version; etc.). They have distinct AAD prefixes and distinct subkey context-string prefixes — v0.1 uses `"myne.v0.1|"` and `"myne.v0.1 …"`; the next major version defines its own, which are not pre-allocated in v0.1.
- **Minor versions** within a major version (v0.1.0, v0.1.1, …) share magic bytes and prefixes. They MAY add fields by appending after the last reserved offset, MUST NOT change existing fields, and MUST NOT reduce any existing security guarantee. The `protocol_version` byte (`0x01` for v0.1) identifies the **major** version and is invariant across the v0.1 family; minor revisions encode minor-version information in the reserved byte at offset 5 of the per-note and `vault.meta` headers.
- **Patch revisions** (v0.1.1.1, …) are reserved for editorial fixes that do not change byte layout or semantics; they do not bump any byte in the file.

### 10.3 Major-version registry

This registry is normative. Implementations MUST reject any magic byte / AAD prefix / context prefix that is not in the registry and is not declared by a published successor specification.

| Major version | AAD prefix | Context prefix | Status |
|---|---|---|---|
| v0.1 | `"myne.v0.1|"` | `"myne.v0.1 …"` | This document. **Active for reading, retired for writing** — every v0.1 blob family stays fully readable and is what the §10.4 migration reads *from*, but no client produces a v0.1 vault any more (§10.3.1). |
| v0.2 (next major) | `"myne.v0.2|"` | `"myne.v0.2 …"` | Defined by the `automerge-sync-migration` epic (`decisions.md` 2026-08-09 — the format-commitment entry). **The birth format** as of `decisions.md` 2026-08-13: a vault created today is `NTV5`/`NC05`/`MY?5` throughout (§10.3.1). The CRDT note-type and these two prefixes are pinned by §10.7; the v0.2 salt domains, the `NTV5` layout and the `MY?5` singleton framing landed with the migration. This supersedes the prior "not pre-allocated in v0.1" posture — pulling the prefixes forward was a direct consequence of the whole-vault §10.4 cutover (Reading A). |

#### 10.3.1 The birth format (normative)

**A vault created by a compliant client is born v0.2.** The creation path derives both credential wrap keys under the v0.2 salt domains, derives the `itemsKey` wrap under the v0.2 subkey context, binds the v0.2 AAD prefix into all three wraps, frames `vault.meta` as `NTV5`, and seeds the singletons it writes eagerly (`vault.prefs`, `vault.attachments`) with their `MY?5` magic. Notes written into it are `NC05` (§10.7).

Two consequences are normative and neither is optional:

1. **A client MUST NOT write a v0.1 blob into a v0.2 vault.** The v0.1 and v0.2 blob families share a byte layout and differ only in magic + AAD + KEK context, and every §10.3 decoder is *magic-detecting* — so a v0.1 blob written into a v0.2 vault decodes correctly, round-trips correctly, and is invisible to every runtime check. A hybrid vault is therefore a defect that only static analysis can catch (`scripts/check-version-routing.mjs` is this repository's).
2. **The flip is a fleet event, not a client-local choice.** §10.5's anti-downgrade refusal means a client that predates v0.2 read support refuses an `NTV5` vault outright, so a device on an older release cannot open — or be enrolled into — an account created after the flip. A published implementation MUST therefore ship v0.2 *read* support to every client it supports before, or in the same release as, the birth-format change.

v0.1 remains a fully specified, fully readable format: `parse_vault_meta_any` accepts it, the migration reads from it, and vaults created before the flip keep working unmigrated for as long as their owner wants. What ends is its production, not its support.

**Magic-byte allocation (normative).** Each blob family has a distinct 4-byte magic. Implementations MUST reject any magic not in this table. This table is the single source of truth for magic-byte allocation — a new blob family MUST claim a free magic here before it is implemented (this discipline exists because the attachments index initially mis-claimed the already-reserved `MYI1`; see `decisions.md` 2026-06-07). **Every family in this table that seals data under AEAD inherits the nonce policy of §5.3 without restatement** — the policy is stated once, generally, and is deliberately not repeated per family.

| Blob / file | v0.1 magic | next major (reserved) | Section | Owner |
|---|---|---|---|---|
| Per-note (`.myn`) | `MY01` | `NT05` | §9.2 | core |
| Vault metadata (`vault.meta`) | `MYV1` | `NTV5` | §9.3 | core |
| Vault prefs (`vault.prefs`) | `MYP1` | `MYP5` | §9.5 | MYND-160 |
| Search index (`vault.search`) | `MYS1` | `MYS5` | §9.6 | MYND-29 |
| Workspace state (`vault.workspace`) | `MYW1` | `MYW5` | §9.7 | MYND-166 |
| Vault indices (`vault.indices`) | `MYI1` | `MYI5` | §9.8 | MYND-31 design / MYND-271 persistence |
| Attachment blob | `MYA1` | `MYA5` | §9.9 | MYND-164 |
| Attachments catalog (`vault.attachments`) | `MYC1` | `MYC5` | §9.10 | MYND-164 |
| Vault backup container (`.myne-backup`) | `MYB1` | `MYB5` | §9.11 | MYND-58 |
| Personal dictionary (`vault.dictionary`) | `MYD1` | `MYD5` | §9.13 | MYND-266 |
| Quick-unlock credential (`vault.quickunlock`) | `MYQ1` | `MYQ5` | §9.14 | MYND-329 |
| Extracted attachment text (`attachments-text/<id>`) | `MYE1` | `MYE5` | §9.15 | MYND-328 |
| Device-local sync baseline (`vault.head-state`) | `MYH1` | `MYH5` | §9.16 | MYND-416 |
| AI embeddings index (`vault.embeddings`) | `MYR1` | `MYR5` | §9.17 | MYND-453 |
| Pending-capture queue (`captures/<id>`) | `MYK1` | `MYK5` | §9.18 | watch-capture |
| Graph layout cache (`vault.graph`) | `MYG1` | `MYG5` | §9.19 | graph-rework |
| Share-import staging queue (`pending-shares/<id>`) | `MYF1` | `MYF5` | §9.20 | MYND-507 |
| Custom-themes blob (`vault.themes`) | `MYT1` | `MYT5` | §9.21 | MYND-486 |
| Sealed label store (`vault.label`) | `MYL1` | `MYL5` | §9.22 | myne-md/myne#411 |
| CRDT note-type (`.myn`, v0.2) | — | `NC05` (allocated, v0.2) | §10.7 | automerge-sync-migration / #418 |

Section §9.8 (vault indices) **landed with MYND-271** (the persistence the MYND-31 design pre-allocated); §9.7 (workspace) landed with MYND-166, and attachments occupy §9.9/§9.10. The per-note and vault-meta families retain their historical `NT05`/`NTV5` next-major reservations; all newer blob families (prefs/search/workspace/indices/attachments/dictionary/attachment-text/head-state/ai-embeddings/graph-layout) use the `MY?5` next-major convention. These reserved magic values are placeholders — the next major version finalizes them. The device-local sync baseline (`vault.head-state`, `MYH1`/`MYH5`, §9.16) landed with MYND-416; the **wire vault head itself has no magic** — it is sync-wire-only (`sync-protocol.md` §2), versioned by its `head_format_version` byte, not a §10.3 family. The **CRDT note-type** row (`NC05`) is **next-major-only** — it has no v0.1 form. Reserved by the `automerge-crdt-spike` (#395), its layout was **finalized as a v0.2 format by the `automerge-sync-migration` epic** (#418): the whole-vault §10.4 cutover (Reading A) turned "later, transport-determined" into "now, transport-agnostic whole-doc snapshots," so `NC05` is allocated under v0.2 and its byte layout is pinned in §10.7 (`decisions.md` 2026-08-09 — the format-commitment entry, which supersedes the 2026-08-07 "reserving the magic commits no layout" clause for this family).

**One row's next-major reservation means something different from every other row's: the sealed label store.** `vault.label` is **generation-independent** (§9.22): it stays `MYL1` inside a v0.2 vault, beside that vault's `NTV5` and `MY?5` neighbours, so `MYL5` is **not** the magic a version cut moves this family to. It is reserved against a future revision of **this family's own** layout, and against nothing else. What lets it be that is the key: the file is sealed under an OS-keychain `wrap_key` rather than any `root_key` product (§9.22.2), so no KDF, KEK context or AAD prefix inherited from the vault ties its bytes to a generation. §10.4.1 point 2 records the migration's matching behaviour, which is that the file is left alone.

#### 10.3.1 Blob total-length discipline ("strict-trailing")

**Normative.** A blob's **total** byte length MUST equal the length its declared layout implies, given the length fields carried in that blob's own header. A blob shorter than that is truncated; a blob longer than that carries bytes no field of the layout accounts for. Both reject the parse. An implementation MUST NOT ignore bytes past the end of the declared layout, and MUST NOT treat them as a forward-compatibility extension point. This rule is referred to as **strict-trailing**.

Applied to the layout shapes in the allocation table above:

- **Envelope families** — a fixed-offset header followed by a single `ciphertext` field of the declared `ciphertext_len` (§9.2, §9.5–§9.10, §9.13–§9.15, §9.17–§9.22). Total length MUST be exactly `header_len + ciphertext_len`, where `header_len` is that family's fixed prefix, itself computed from the header's own length fields where the prefix is variable (§9.2 / §9.9: `76 + enc_item_key_len`).
- **`vault.meta`** (§9.3) — a fixed-length layout; the equality is against that fixed length.
- **The backup container** (§9.11) — states the same equality as its own equation, `file_length == 22 + member_table_len + members_total_len` (§9.11.5), and keeps it. Each member is then subject to the rule for the member's own family, which is what makes §9.11.5's "`member_len` MUST NOT exceed the size cap of the member's own blob family" a bound on the whole member and not merely on its ciphertext.
- **`vault.head-state`** (§9.16) — the 6-byte header is followed by exactly one wire head record; the file MUST end where that record ends (`sync-protocol.md` §3.2 gives its length), with no bytes after the head's own 32-byte MAC.

**Why this is stated separately from the size caps.** The per-family caps (§9.2, §9.5.4, §9.9, §9.10.4, and their peers) bound the **declared `ciphertext_len`**, not the file's total length. Without this subsection nothing bounds the latter at all, while each cap reads as though it did. Nothing past the ciphertext is covered by the AEAD tag or by the AAD (§5.2), so a tolerated tail is unauthenticated bytes that survive decode — and for a family that syncs, bytes a client would persist and re-upload verbatim. This is a **parsing-discipline and cross-implementation-agreement** rule, not a confidentiality or integrity claim: every decoded field is AEAD-authenticated with or without it. What it buys is that two independent implementations agree on which byte strings are blobs of a given family.

**This does not narrow §10.2.** A minor revision within v0.1 still MAY add fields, in the two places where an added field is authenticated and has an offset: inside the AEAD-protected inner plaintext (§9.5.2's additive-field discipline is the worked example), or at a defined offset of a revised layout signalled by the reserved byte at offset 5 — including the `future fields` space §9.3 reserves at `vault.meta` offset 345. What §10.2 does not license is appending bytes after an envelope's ciphertext: such a field would sit outside the AEAD tag and outside the AAD, reducing an existing security guarantee, which §10.2's own "MUST NOT reduce any existing security guarantee" clause already forbids. A reader checks the equality against the layout of the minor version **it** implements; per §10.1, forward compatibility inside a major version runs newer-reads-older, so a reader handed a later minor layout it does not know rejects the blob rather than half-parsing it.

**Citation.** Implementations, code comments and test vectors reasoning about trailing bytes cite **this subsection**. §10.1 governs which *version* a blob may be parsed under and states no length rule; existing references to "§10.1 strict-trailing" mean this rule and point here.

### 10.4 Migration procedure (cross-major)

Migration is **always explicit, always one-way, always client-side**. There is no implicit upgrade. The procedure for a next-major-version client encountering a v0.1 vault:

```
1. Detect:        Read magic bytes of vault.meta. If "MYV1", and the client is
                  the next major version: refuse to operate on the vault; surface
                  a Migration prompt.
2. Confirm:       User explicitly approves migration. Display: "Migrating from
                  protocol v0.1 to the next major version. Recommended only after
                  backup. Continue?"
3. Authenticate:  User enters master password (or recovery phrase). The v0.1
                  unlock procedure runs end-to-end and yields the v0.1 root_key
                  in client memory.
4. Re-derive:     A new next-major root_key is generated (random 32 bytes). The
                  next-major key hierarchy is built from the new root_key per the
                  next-major spec, using the user's existing password as input to
                  the next-major KDF (which may differ from v0.1's Argon2id params).
5. Re-encrypt:    Each .myn file is decrypted under v0.1 keys and re-encrypted
                  under next-major keys with next-major magic bytes. The next-major
                  client MAY perform this lazily (per-note on first access) or
                  eagerly (bulk migration), at the user's choice.
6. Replace:       vault.meta is rewritten with next-major magic bytes and layout,
                  containing the new root_key wrapped under both new credentials.
                  The old vault.meta and any unmigrated .myn files MAY be retained
                  as a `legacy/` snapshot until the user confirms migration is
                  complete, then deleted with cryptographic erase semantics.
7. Settle:        Migration is complete only when every .myn file has been
                  re-encrypted under next-major keys. Until then, the vault is in a
                  mixed state and the client MUST clearly indicate this.
```

The migration tool is itself part of the next-major-version client — there is no separate "migrator" binary. v0.1 clients never produce next-major output.

#### 10.4.1 The `NC05` cut (v0.1 → v0.2): normative migration contract

> **This subsection turns §10.4's intent-only prose into an executable contract for the first concrete cut — v0.1 → v0.2 (the `automerge-sync-migration` epic, #420).** It pins the rules a compliant v0.2 client MUST follow; where it says MUST, §10.4's "MAY" is not exercised. Decision record: `decisions.md` 2026-08-09 (the migration-contract entry, ASM-13 / Reading A), which points at the format-commitment entry for the `NC05` layout and the v0.2 identifiers (§10.7).

1. **The recovery phrase is REQUIRED, not "password or phrase" (closes the §10.4 step-3/step-6 gap).** Step 6 wraps the new v0.2 `root_key` under **both** credentials (password and recovery phrase), and the phrase-derived wrap needs `recovery_wrap_key`, which is derivable **only** from the 24-word phrase (§3.1). A password-only migration would therefore produce a v0.2 vault whose recovery wrap no phrase can open — permanently stranding recovery, in direct violation of the standing commitment that **the recovery phrase is the only recovery path and it is unrevocable/permanent** (§7, `threat-model.md`). A compliant client MUST require the user to enter a **valid** recovery phrase before writing any v0.2 blob, and MUST refuse the migration otherwise with a typed error (the implementation's `RecoveryPhraseRequired`). This is a **backend gate**, not merely a UI affordance — a UI bug must not be able to strand recovery.

2. **Eager / whole-vault, not lazy.** For this cut the client MUST re-encrypt **every note** (→ `NC05` via the §10.7 encode) and re-seal **every synced/persistent singleton** (prefs `MYP5`, themes `MYT5`, dictionary `MYD5`, attachments catalog `MYC5` + blobs `MYA5`) under the new keys with its `MY?5` magic, emitting per-blob progress. The **rebuildable, never-synced caches** (`vault.search`/`.workspace`/`.indices`/`.graph`/`.embeddings`) are **dropped, not re-sealed** — they rebuild on next unlock under the new `root_key` (their KEKs re-derive through the v0.1 `derive_subkey` context on the v0.2 root, which is self-consistent by construction since a cache never crosses a generation boundary — it is written and read only on the migrated vault). §10.4 step 5's "MAY lazy (per-note on first access)" is **not** exercised for the v0.1 → v0.2 cut: the pre-beta fleet is small and controlled (2 founders, 3–5 devices), so a coordinated whole-vault cutover is free and avoids a long-lived mixed-format vault. The transient mixed state exists only *within* the single migration operation, never as a resting state the user lives in.

   **`vault.label` (`MYL1`, §9.22) is neither re-sealed nor dropped: the migration leaves it exactly as it is, and it stays `MYL1` on the migrated vault.** It is device-local and never synced like the caches above, but it is neither rebuildable from the notes nor sealed under anything the re-key touches: its `wrap_key` is an OS-keychain item rather than a `DeriveSubkey(root_key, …)` product (§9.22.2), so the migration has nothing to re-derive and no reason to invalidate it, and the name it holds is unchanged by the cut. This is the same generation-independence a vault **born** v0.2 has (§10.3.1), stated here so the enumeration above is exhaustive: every family in the vault is re-sealed, dropped, or named in this point, and `vault.label` is the one that is left alone.

3. **`vault.meta` → `NTV5` is written LAST, as the completion marker.** Every note and synced singleton MUST be re-encrypted and durably written — **and each original copied to the `legacy/` snapshot (point 5) BEFORE it is overwritten in place** — before `vault.meta` is rewritten from `MYV1` to `NTV5`. The flip is the atomic *commit*, not in-place crash-safety: because notes are re-keyed **in place**, a crash before the flip leaves a **torn** vault — the `MYV1` `vault.meta` still governs, but the notes already rewritten to `NC05` decrypt-fail under the v0.1 keys — whose recovery is a restore from the `legacy/` snapshot. No data is lost (every original is staged in `legacy/` before it is overwritten), and there is no window in which the vault has no openable `vault.meta` (it is never a rootless half-keyed vault). The **`legacy/`-restore now exists** as the user-invocable abort of point 5 (myne-md/myne#430); what remains deferred is **automatic** torn-migration *detection* — nothing yet notices a torn vault on boot and offers the restore, so an interrupted migration is recovered by the user invoking abort. The **fail-closed MAY is taken** (myne-md/myne#441): every singleton is re-sealed for real, and the result discarded, before the in-place note pass begins, so a pre-existing corrupt blob aborts with the vault still fully v0.1 — the torn state above is now reachable only by an actual crash, not by a decode failure.

4. **Attachment ids stay stable across the re-key.** The content-addressed attachment id is `root_key`-derived (§9.9), so a naïve re-key would change every id and force a rewrite of every note's `attachment://<id>` reference, the catalog, and every blob filename. The migration MUST instead **preserve each attachment id unchanged**: it re-wraps the attachment blob under the new `itemsKey` (content re-keyed, `MYA5` magic) but carries the existing id through as the AAD binding, the catalog key, and the filename. The id is a dedup handle, not a secret, and the file content is fully re-keyed — so stability costs no confidentiality while avoiding a note-body rewrite that would also author a migration edit into the pristine `NC05` change-graph. A v0.2 client's *new*-attachment id derivation must reproduce the pre-migration id-key so ids remain comparable (pinned with the `MYA5`/`MYC5` codecs). Decision: `decisions.md` 2026-08-09 (the stable-attachment-id entry).

5. **`legacy/` snapshot + crypto-erase-after-confirm.** Before the commit point the client MUST retain the pre-migration `vault.meta` and blobs as a **device-local `legacy/` snapshot** (sealed under the OLD `root_key`; never synced, never backed up) — the abort-before-sync escape hatch. An **abort** (valid only *pre-sync and pre-confirm*) restores the byte-identical v0.1 vault from `legacy/`. On the user's explicit post-migration **confirm**, the client crypto-erases the old `root_key` and the `legacy/` snapshot (a reused-`item_key` legacy blob would otherwise be undecryptable orphan ciphertext contradicting cryptographic-erase; cf. §6.5 / the snapshot-purge rule). Migration is "settled" (§10.4 step 7) only after this confirm.

   **The staged set includes `snapshots/`, and it is MOVED rather than copied.** A snapshot is a byte-verbatim `MY01` note blob under the vault's `itemsKey` (§9.1 — no snapshot codec or magic of its own), so the re-key leaves every pre-migration snapshot permanently undecryptable. Leaving them in the vault root would be exactly the orphan ciphertext this point exists to prevent, so the migration moves the directory into `legacy/` and abort restores it from there.

   **The pre-sync condition is machine-checked, not advisory.** "Pre-sync" is read off the device-local re-key re-base flag (`sync-protocol.md` §5.6.1): the migration arms it and the push that publishes the re-authored v0.2 head clears it, so "enrolled AND not pending" is precisely "peers have adopted v0.2". Past that point abort MUST refuse — a local roll-back would fork this device from its peers — and the way back is a restore from backup. An unenrolled vault is pre-sync by construction.

   **Until confirm runs, a password rotation does not revoke access to the staged blobs.** `legacy/vault.meta` wraps the old `root_key` under the OLD password and the OLD recovery phrase, and a password change rewrites `<vault>/vault.meta` only. The recovery phrase is unrevocable by design (§7), so for it the exposure lasts as long as the snapshot does. A client MUST therefore surface the confirm rather than leaving the snapshot indefinitely.

6. **The #418/#420 boundary.** The `NC05` note layout and the v0.2 AAD/HKDF prefixes are defined by §10.7 (#418); the v0.2 KDF, the `NTV5` `vault.meta` layout, and the `MY?5` singleton re-seal are defined **with the migration** (#420) as the rest of the v0.2 hierarchy lands. This subsection pins the **procedure**; it chooses **no** identifier value. The `MY?5` header `protocol_version` byte is **FROZEN as a split, normative** (myne-md/myne#441): the item- and meta-scoped v0.2 blobs (`NC05`, `NTV5`, `MYA5`) carry `0x02` at offset 4, while the KEK-singleton families (`MYP5`/`MYC5`/`MYT5`/`MYD5`) retain `0x01` and domain-separate on magic + AAD prefix + KEK context alone. A port MUST reproduce both conventions exactly, and both are pinned by cross-impl vectors (`myne-test-vectors` categories `vault-meta/v0.2` and `vault-themes/v0.2` — the latter being the KEK-envelope archetype `vault.dictionary` shares byte-for-byte).

   The split is frozen rather than collapsed because collapsing it is a **breaking change to bytes that already exist**: v0.2 vaults have been migrated, and their `MYP5`/`MYC5`/`MYT5`/`MYD5` blobs carry `0x01` on disk today. The byte is **not AEAD-bound** in those families, so it buys no separation there — magic, AAD prefix and KEK context already carry all of it — which means a collapse would rewrite every migrated singleton to gain nothing a reader can use. The asymmetry is therefore a fact to be recorded, not a defect to be tidied; what would be a defect is a port guessing it. §10.5's anti-downgrade refusal (a v0.1 client refuses `NTV5`, never half-parses) stays normative and is the fleet safety gate for a cut-over vault reached by an un-upgraded client.

### 10.5 Anti-downgrade properties

Forward-incompatibility produces three structural anti-downgrade properties:

1. **Magic-byte separation**: a next-major-version client refuses to parse `MY01` blobs except via the migration flow; a v0.1 client refuses to parse `NT05` blobs at all. There is no protocol path that silently accepts the older format.
2. **AAD domain separation**: the AAD prefix `"myne.v0.1|"` is bound into every AEAD tag in v0.1. A next-major-version attacker who tries to forge a `NT05` blob with a `myne.v0.1` AAD fails AEAD verification; a v0.1 vault opened in a next-major-version client (during migration) carries its `myne.v0.1` AAD through to verification — the next-major-version client must use the v0.1 AAD format to succeed.
3. **Context-string separation**: subkey derivations under `"myne.v0.1 …"` produce different bytes than derivations under the next major version's context prefix even when the same root key, primitive, and parameters are used. Cross-version key substitution is computationally infeasible.

The `protocol_version` byte is included in the AAD (§5.2) for additional defense-in-depth: a blob whose version byte is altered fails AEAD verification rather than merely failing the §6.4 header check. Within the v0.1 family, the anti-downgrade property that matters is carried by `kdf_params_canonical` (§4.3), which is appended to both `AAD_password_wrap` and `AAD_recovery_wrap` (§3.1) — this is what structurally blocks a KDF-parameter downgrade, the one intra-major change §4.2 contemplates. The reserved byte at offset 5 is **not** AAD-bound in v0.1. A future minor revision that allocates it MUST NOT place a security-load-bearing flag there without binding that byte into the AADs of §3.1 and §5.2 as part of the same revision.

### 10.6 What v0.1 deliberately does NOT prepare for

To keep v0.1 a clean, auditable closed system, the following extension points are **not** built in:

- No capability bitfield, no feature negotiation byte, no "extension" frames. Adding capabilities later is a major-version event.
- No algorithm-agility headers. KDF, AEAD, and primitive choices are fixed by version. Migrating algorithms means migrating major version.
- No reserved expansion fields beyond the per-record reserved byte at offset 5. The next major version is a new spec, not a v0.1 extension.

This stance directly contradicts the "additive" approach common in older protocols (TLS 1.0–1.2, OpenPGP). The lessons from those protocols' downgrade-attack history (POODLE, FREAK, Logjam, MEGA 2022) inform this design choice.

### 10.7 Next-major note-type format: `NC05` (v0.2 CRDT notes)

> **This subsection defines a concrete next-major (v0.2) at-rest format** — the first Myne specifies. It is pulled forward from "reserved, layout-free" (§10.3, the 2026-08-07 reservation) by the `automerge-sync-migration` decision (`decisions.md` 2026-08-09 — the format-commitment entry). A v0.1 client never produces or reads an `NC05` blob (§10.1). An **existing** v0.1 vault reaches this format only through the §10.4 migration; a **newly created** vault is born in it (§10.3.1), so `NC05` is the note format of the default path rather than of the migrated one alone.

**Purpose.** `NC05` is a **CRDT note-type** that replaces the `MY01` per-note body (§9.2). The note's whole content is stored as one encrypted [Automerge](../glossary.md) document, so two devices that edited the same note concurrently **merge** into a single convergent revision rather than fork into a keep-both conflict copy (`sync-protocol.md` §10.1). The merge runs client-side after decryption; the server stays a blind opaque blob store (TB5) and never sees Automerge's native change-sync protocol (which would leak the change-DAG, actor ids, and op counts). This is the async single-user-multi-device foundation the Phase-4 live-collaboration plane later reuses — the same at-rest artifact, so the format is not throwaway toward that path.

**Envelope layout — the §9.2 three-level wrap, three changes.** An `NC05` blob uses the **same byte layout as the `MY01` per-note blob (§9.2)** at the **same offsets** — `magic · protocol_version · reserved · items_key_id · item_key_nonce · enc_item_key_len · enc_item_key · content_nonce · ciphertext_len · ciphertext` — with the same per-note `item_key` (random 32 bytes, wrapped under the vault's singleton `itemsKey`), the same XChaCha20-Poly1305 + CTX construction, and the same 32-byte CTX commitment tag on disk. It differs from `MY01` in exactly three load-bearing ways, each of which domain-separates v0.2 from v0.1 (the §10.5 anti-downgrade properties, applied to this family):

1. **Magic** (offset 0) is `NC05` (`0x4E 0x43 0x30 0x35`), not `MY01`.
2. **`protocol_version`** (offset 4) is `0x02`, not `0x01`.
3. **Both AEAD tags bind the v0.2 AAD prefix + version byte**, not v0.1's. The layouts mirror the v0.1 per-note AADs (§5.2) exactly, with only the leading `"myne.v0.1|" || 0x01` replaced by `"myne.v0.2|" || 0x02`:
   - **item-key wrap AAD** = `"myne.v0.2|" || 0x02 || items_key_id || note_uuid`
   - **content AAD** = `"myne.v0.2|" || 0x02 || items_key_id || note_uuid || u16_be_len("text/markdown") || "text/markdown"`

   An `NC05` tag therefore never verifies under a v0.1 AAD, and a `MY01` tag never verifies under the v0.2 AAD (§10.5 property 2; proven in code by `crdt_note_blob.rs::nc05_wrap_tag_does_not_verify_under_the_v0_1_aad`).

The `content_type` bound into the content AAD stays `"text/markdown"` — an `NC05` note is still markdown, and the **4-byte magic, not the content type, is the discriminator** between a CRDT note and a v0.1 note. Strict-trailing (§10.3.1) applies unchanged: an `NC05` blob MUST be exactly `header_len + ciphertext_len` bytes, where `header_len` is the §9.2 `76 + enc_item_key_len` prefix.

**Inner plaintext is opaque.** The AEAD-sealed payload is the note's Automerge `save()` bytes — the compacted serialization of the CRDT document. This spec does not define that serialization (it is Automerge's, pinned by the crate version in the workspace lockfile); the codec treats it as an opaque byte string, exactly as `vault.search` (§9.6) and `vault.workspace` (§9.7) treat their engine payloads. **One mapping this spec does pin:** the whole note — YAML frontmatter *and* body, as one exact UTF-8 string — is a single Automerge `Text` under the document root. That single-`Text` mapping is what preserves, **by construction**, the §6 C1 byte-exact round-trip, unknown-frontmatter-field preservation, and plain-markdown portability; a structured field-per-frontmatter-key mapping would break all three. A `kind: drawing` note (Excalidraw JSON body) maps identically — still one UTF-8 string in one `Text`.

**No new subkey role.** `NC05` derives **no** `SubkeyRole`: the per-note `item_key` is random and wrapped under the vault's `itemsKey`, exactly as `MY01`. What the v0.2 key hierarchy *above* `itemsKey` looks like — a new `root_key`, the v0.2 KDF, the re-wrapping of `itemsKey` under new credentials — is the **§10.4 migration layer's** concern, not this note-type's. The `items_key_id` field carries the v0.2 vault's `itemsKey` identity, exactly as it carries v0.1's.

**Convergence discriminator (client behavior, not wire).** A device decides an `NC05` note is dirty by comparing the Automerge document **heads** (its change-hash frontier) against the last-synced heads recorded for that blob — **never** by `content_nonce` byte-equality. Automerge's `save()` is non-deterministic: a re-serialize (or an idempotent re-merge that adds nothing) rotates the `content_nonce` and the ciphertext bytes while leaving the heads unchanged, so a nonce-equality dirty test would read perpetually-dirty and re-run the §10.2.2 CAS ping-pong one layer down — the exact fragility the migration set out to escape. The `content_nonce` remains the **server-facing** staleness signal (the server is oblivious to heads and to Automerge entirely); heads are a **device-local** marker, recorded in `sync-state.json` beside each blob's synced version. This is a client-behavior rule (`sync-protocol.md`); the wire format is unchanged, and whole-doc encrypted snapshots ride the existing blind-CAS blob plane with no new server surface.

## 11. Out of Scope for v0.1

### 11.1 Server-authentication mechanism (Phase 2 decision — resolved 2026-06-20)

> **Resolved; this supersedes the deferral recorded below.** Phase 2 canonicalized **SCRAM-SHA-256-PLUS** with `tls-exporter` channel binding (RFC 5802 / 7677 / 9266) as the server-auth mechanism — `decisions.md` **2026-06-20** "SCRAM-SHA-256-PLUS canonicalized as Phase 2 server-auth" (MYND-420). It is **neither Option A nor Option B** below: SCRAM transmits no secret and stores no Argon2id verifier, so it is a third construction in the same non-aPAKE family as Option A rather than Option A itself. The `server-auth` subkey (§3.4) is the SCRAM secret, fed to PBKDF2 as raw bytes; the wire spec is `server-protocol.md` §3.1. The next-major commitment to OPAQUE (below) is unchanged. The remainder of this section is retained as the record of the deliberation.

The Phase 1 protocol derives a `server-auth` subkey (§3.4) from the user's `root_key`. v0.1 holds this material locally and never transmits it. Phase 2 introduces the sync server and forces a decision between two approaches; the choice is **deliberately deferred** to Phase 2 to avoid premature commitment under low information.

**Option A — Simple verifier (Standard Notes 004 style).** The client transmits the `server-auth` subkey to the server over TLS at registration. The server stores `Argon2id-server(server-auth, server_salt)` as a verifier and validates it on each authenticated request. A server-database compromise allows offline brute-force against the verifier. Note confidentiality is unaffected (notes are E2EE under `root_key`, which never leaves the client); a successful verifier crack only enables sync-entitlement abuse — free storage, request flooding, etc.

**Option B — OPAQUE aPAKE (RFC 9807).** Client and server run an augmented PAKE handshake. The server never sees a password verifier or hash; both parties end the handshake holding a session key derived through the OPRF. A server-database compromise yields material from which offline brute-force is infeasible.

**The decision will be made at Phase 2 start, not before.** Resolution criteria:

- OPAQUE library maturity in the Go and TypeScript ecosystems at Phase 2 start. Specifically: presence of a Cure53 or Trail of Bits audit on a candidate implementation; production deployments at credible scale.
- Self-host operator feedback. OPAQUE adds operator-side complexity. If the Phase 1 user base shows strong self-host intent, this raises the bar for Option B.
- Threat model evolution. If new evidence of partition-style or precomputation attacks against simple verifiers emerges between Phase 1 and Phase 2 ship, this raises the bar for Option A.

**Next-major commitment.** The next major version's roadmap canonicalizes Option B (OPAQUE). Option A in Phase 2 is therefore at most a transitional choice; the next major version's migration would convert any Option-A vaults to OPAQUE.

While it stood, this deferral was itself a protocol commitment, and its surviving half is scoped to the at-rest layer: **v0.1 at-rest code** — anything that produces or consumes `vault.meta`, a `.myn` blob or any §10.3 family — MUST NOT assume a server-auth decision, and none does. To that layer the `server-auth` subkey is opaque material with no wire-level use. Its wire-level use is defined by Phase 2 and confined to the sync layer (`server-protocol.md` §3.1).

### 11.2 Other items deliberately not addressed

Items deliberately not addressed by this specification. Each entry names where it lives instead.

| Item | Where it lives |
|---|---|
| Server-side authentication protocol (`serverPassword` is derived but not transmitted in v0.1) | Phase 2; mechanism resolved as SCRAM-SHA-256-PLUS (§11.1 preamble; `decisions.md` 2026-06-20; MYND-420); wire surface in `server-protocol.md` §3.1 |
| Sync wire format, conflict resolution, version vectors | Phase 2; `sync-protocol.md` §8–§11 (fork-consistency vault head §1–§7) |
| Cross-device synchronization of `vault.prefs` (carried alongside `vault.meta` + `notes/*.myn` as the v0.1 vault-artifact trio) | Phase 2; `sync-protocol.md` §9 (taxonomy) + §10 (conflict merge) |
| Multi-device coordination, device key management | Phase 2+; the next major version adopts MLS; `protocol-next-roadmap.md` (TBD) |
| Inter-user note sharing, prekey bundles, per-recipient wrapping | Phase 4+; `protocol-next-roadmap.md` (TBD) |
| Real-time collaborative editing, CRDT integration | Phase 4+; `protocol-next-roadmap.md` (TBD) |
| Post-quantum primitives (ML-KEM-768 hybrid wrap, ML-DSA signatures) | a later major version |
| Group key agreement (MLS, RFC 9420) | a later major version |
| Key Transparency (CONIKS / Trillian-based identity log) | a later major version |
| OPAQUE aPAKE for server authentication | a later major version |
| OHTTP relay/gateway transport, traffic-analysis defense | a later major version |
| Anonymous credentials (KVAC, Privacy Pass) for sync entitlement | a later major version |
| Plugin sandboxing, capability-scoped plugin API | Possibly never; `../vision.md` §what-myne-is-not |
| Single-shot attachment encryption (images/SVG/PDF, ≤64 MiB) | **Ships in v0.1** — `MYA1` blob (§9.9) + `MYC1` catalog (§9.10) |
| Chunked/streamed attachment AEAD, Merkle manifests, **large (>64 MiB) media requiring chunking/streaming** (long video/audio) | Phase 1.5 or later; future spec extension (new magic + migration, not a `MYA1` extension). Single-shot audio ≤64 MiB already ships as a `MYA1` blob (row above), and on-device speech-to-text (§9.15, MYND-270) transcribes it; only media beyond the single-shot cap is deferred here. |
| Encrypted search index format (FTS5 inside encrypted SQLite) | Phase 1.5 or later; client-internal, not in this spec |
| Bidirectional links, graph view rendering | Out of scope for the cryptographic protocol; client UI concern |
| Mobile Argon2id parameter profile | Phase 3 mobile; this spec's baseline targets desktop-class memory. Narrowed rather than open: §4.2 settles the cross-device half — a vault's parameters are fixed at creation and are the same on every device that opens it, because `vault.meta` is a synced singleton — and §4.2.1 bounds whatever profile lands. What stays open is only the **creation-time** values a mobile-created vault should use. |
| WASM Argon2id parameter profile | **Not deferred — there is none.** The Phase 3 web client runs the v0.1 parameters **unchanged**: they are AAD-bound and read from `vault.meta` (§4.2), so a browser cannot lower them without producing a vault no other client can open. Measured browser cost is in §4.1. A client that refuses to derive because the running browser cannot afford 256 MiB is a **client behaviour**, not a parameter profile. |
| Metadata padding (PURB, Padmé) | a later major version |
| Plausibly-deniable encryption, decoy passwords, duress codes | Icebox (a later version and beyond) |
| Hardware-backed unlock (WebAuthn-PRF, SE/TPM device key) | a later major version |

This is not a deferral wishlist. Each item is either out of scope for the v0.1 cryptographic core or out of scope for the protocol entirely (UI, indexing, etc.). Items that are deferred to a later major version are documented in the research roadmap, which also captures the user's reasoning for keeping each one out of v0.1.

The matching threat-model section (`../threat-model.md` §5 "NOT Protected Against") names what user-facing failure modes v0.1 does and does not defend against. This protocol spec is the architectural counterpart of that document.

## 12. Decisions Log

A snapshot of choices made during the v0.1 draft. Mirrored to `../decisions.md`.

**Resolved (v0.1)**

- **Doc strategy is Option C**: ship `protocol.md` v0.1 (this document) alongside a separate `protocol-next-roadmap.md` (to be authored from the user's research). v0.1 is the implementation target; the next major version is the long-term aspirational reference.
- **Subkey derivation pattern: `derive_key(root_key, context_string)` with context strings drawn from a registered table (§3.4)**. Adding a new subkey role in a minor revision does not require a protocol bump. Concrete primitive (HKDF-SHA-256 vs BLAKE3 derive_key) is `[DEFERRED]`.
- **Three-level note wrapping**: `itemsKey_wrap_key → itemsKey → item_key → plaintext`. Password rotation re-wraps a single 32-byte copy of `root_key` on the password side; `itemsKey`, `itemsKey_wrap_key` and every note blob are untouched. The third level exists for a later version's `itemsKey` rotation, which re-wraps one 64-byte field per note and never the ciphertext.
- **Forward-compat reservation for later epoch keys**: the context-string registry reserves room for a later version's epoch-key derivations (the concrete context prefix is defined by the next major version, not pre-allocated in v0.1); the `items_key_id` field in v0.1 is structurally compatible with a later version's epoch identifier. No epoch rotation in v0.1.
- **On-disk binary format with magic bytes**: per-note `MY01` (`.myn`), vault metadata `MYV1` (`vault.meta`). Big-endian integers, fixed offsets, no JSON envelope.
- **AAD construction with explicit version prefix `"myne.v0.1|"`** (TLS 1.3 §4.1.3 model). AAD includes `protocol_version`, `items_key_id`, `note_uuid`, and (for content) `content_type`. Cross-version substitution and downgrade attempts fail AEAD verification.
- **Architectural shift: `root_key` is a 32-byte random persistent value**, not derived from the password. Password derives `password_wrap_key` via Argon2id; that wraps a copy of `root_key`. Recovery phrase derives `recovery_wrap_key` via Argon2id; that wraps a second copy of `root_key`. Either credential is sufficient to unlock; both can be rotated independently.
- **BIP-39 phrase strengthens to `recovery_wrap_key` via Argon2id directly**, not via the BIP-39 standard PBKDF2-2048. Phrase is treated as a 256-bit-entropy encoding, not as wallet-ecosystem-compatible mnemonic.
- **Account number format**: 20-character Crockford base32 with a Damm-32 check digit, displayed as `MY-XXXX-XXXX-XXXX-XXXX-XXXX` (4-4-4-4-4). Liberal parsing: prefix optional, separators stripped, case insensitive. Canonical form is uppercase 20 chars.
- **Account-number normalization for hashing**: NFKD + trim + strip prefix/separators + uppercase + length and Damm validation. Hash is `SHA-256(canonical)[:16]`.
- **Forward-incompatible major-version model**: each major version is a closed, complete spec with distinct magic bytes, AAD prefix, and context prefixes. Cross-major reads happen only via explicit migration. This eliminates downgrade attacks structurally and lets each version be audited independently.

**Resolved (post-draft)**

- **Argon2id parameters: middle-ground `m=256 MiB, t=3, p=2`, Argon2 1.3** (resolved 2026-04-26). Stored in `vault.meta` rather than hardcoded; bound into both wrap AADs to defeat parameter-downgrade tampering.
- **Subkey derivation: HKDF-SHA-256 with single canonical helper** (resolved 2026-04-26). libsodium-native, MLS-aligned for the next major version, audit history mature. The helper-only access pattern (§3.2.1) collapses BLAKE3's "structural context binding" advantage into a codebase-level discipline at no cost.
- **AEAD wrapper: XChaCha20-Poly1305 + CTX commitment with SHA-256 outer hash** (resolved 2026-04-26). Defends against partitioning-oracle attacks (Len–Grubbs–Ristenpart, USENIX 2021). Tag fields grow from 16 to 32 bytes on disk. Canonical encoding `K[32] || N[24] || len(AD)[4 BE] || AD || T[16]` eliminates concatenation ambiguity (Chan & Rogaway 2022).
- **Server-auth deliberately deferred to Phase 2 with intent declaration** (resolved 2026-04-26). v0.1 derives but does not use the `server-auth` subkey. Phase 2 will choose between Option A (simple verifier) and Option B (OPAQUE aPAKE) using criteria documented in §11.1. The next major version canonicalizes OPAQUE; Option A in Phase 2 would be transitional only. This is not a decision dodge — it is a discipline of "decide at the right time, not the earliest time".
- **Stack realignment: Tauri (Rust core) + Vite + React + TypeScript UI for desktop** (resolved 2026-04-26; UI bundler refined the same day). Supersedes the prior `../decisions.md` Electron baseline. Crypto core in Rust (libsodium bindings + RustCrypto fallback). Server remains Go. Phase 3 mobile path (RN with Rust bridge vs Tauri Mobile) deferred to Phase 3 start. Phase 3 web client's bundler is deferred to Phase 3 start; shared React components will be extracted to a `packages/ui/` workspace member when that work begins, decoupling the desktop UI bundler from the web bundler. Trade: ~1–2 month delay to Phase 1 ship for Rust ramp-up; gains: structural memory hygiene (`zeroize`/`secrecy`/`subtle` crates), smaller TCB and binary, easier reproducible builds, audit-story upgrade, native MLS/PQ primitive availability for a later major version, ~10× smaller direct-npm-dependency surface vs Next.js.
- **Rust-side primitives: RustCrypto stack, no libsodium bindings** (resolved 2026-04-28). Supersedes the "libsodium bindings + RustCrypto fallback" clause of the entry directly above, and the "libsodium as the single client crypto library" clause of the original Standard Notes 004 primitive baseline — both by name, in `decisions.md` 2026-04-28. Every Myne client links the `protocol/` crate on RustCrypto and none links libsodium (§2): mobile reuses the crate by path rather than binding a platform library (2026-05-01), and the web client compiles it to wasm (below). The earlier entries in this list are left standing as the record of what was believed at the time — wherever one of them says "libsodium", read §2. The Argon2id parameters, AEAD construction, HKDF-SHA-256 subkey derivation, BIP-39 phrase and X25519 are unchanged by this: only the *library implementing them* changed, and the byte-level format did not, which is why libsodium remains a valid choice for an independent implementation (§2, §5.1.4).

- **Phase 3 web client: in-repo `web/` target, shared `src/` tree, wasm-compiled `protocol/` crate** (resolved 2026-07-26). Supersedes the two clauses above that deferred the web bundler and promised a `packages/ui/` extraction. Neither happened, and the architecture that replaced them is different in kind: the web client compiles the **same** `src/` tree the desktop client compiles, substituting one internal boundary — `src/platform/` — at build time, so there is no UI package to extract and no second bundler to decouple. Its cryptographic provider is this repo's `protocol/` crate compiled to `wasm32-unknown-unknown` (§2), not a JavaScript library. §4.1 carries the measured browser cost. `decisions.md` 2026-07-26 records the repo-topology, capability-set, storage, transport, E2E, origin and self-host decisions; `threat-model.md` A15/TB11 records what the served-code delivery channel gives up. **Appended, not edited in place** — the earlier entries are the record of what was believed at the time.

- **Server-auth resolved: SCRAM-SHA-256-PLUS — neither Option A nor Option B** (resolved 2026-06-20). Supersedes the "Server-auth deliberately deferred to Phase 2" bullet above and the deferral in §11.1. The client proves knowledge of `DeriveSubkey(root_key, "server-auth")` without transmitting it, and the server stores only `StoredKey`/`ServerKey`/`Salt`/`Iterations` — so it is neither the transmitted subkey of Option A nor the OPRF of Option B, which is why `decisions.md` records it by name. The subkey is fed to PBKDF2 as raw bytes; wire spec `server-protocol.md` §3.1. The next major version's OPAQUE commitment is unchanged. **Appended, not edited in place** — the earlier bullet is the record of what was believed at the time.

- **"Both can be rotated independently" is a property of the dual-wrap format, not a v0.1 flow** (clarified 2026-08-04). The `root_key` bullet above is an architectural statement, and as such it is correct: the two wraps are independent, and §9.3 gives the recovery side its own salt, nonce and wrapped-`root_key` copy at fixed offsets, so either side can be rewritten without disturbing the other. What v0.1 **ships** is password rotation only — the change-password flow and the post-recovery password reset, both of which touch only the password-side fields. No client ships a phrase-rotation command, so a recovery phrase is a permanent, unrevocable credential for the life of the vault; §7.5 states that and its consequence. Whether to build phrase rotation on the format headroom the bullet above describes is an open product question, not a v0.1 commitment. **Appended, not edited in place** — the earlier bullet stands as the record of what was believed at the time.

**All deferred conflict-points resolved.** v0.1 specification is complete.

Each deferred item has a v0.1 baseline that is internally consistent with this spec and a research alternative documented in the next major version's research roadmap. Resolving any of the two does not require changes to the rest of the protocol structure — only the parameter or primitive at the named call site.

**Open risks**

- **No formal verification model** (Tamarin / ProVerif) accompanies v0.1. The compensating-controls plan (`../threat-model.md` §6) is the v1.0 substitute. Formal verification is a next-major-version deliverable.
- **No external cryptographer review** has occurred at draft time. Plan: pre-launch informal review by at least one independent reviewer per `../threat-model.md` §6.
- **Migration tool from v0.1 to the next major version has not been written**. The §10.4 procedure describes the intent; concrete code lands when next-major work begins.
- **Mobile parameter profile** for Argon2id is not specified in v0.1; the spec assumes desktop-class memory. Phase 3 must add a profile, and §4.2.1 fixes the range that profile must land inside — what is open is where in that range it sits, not whether it is bounded at all.
