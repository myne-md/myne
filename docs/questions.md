# Questions and Answers

This file collects simple questions and answers about the Myne project.
It is a space for summarised or informal counterparts to the specifications;
it is not normative. If an answer here conflicts with `vision.md`,
`threat-model.md`, anything under `spec/`, `glossary.md`, or
`decisions.md`, those documents take precedence — and the answer here is
the one that needs fixing.

Answers point at spec sections rather than restating normative text.
Duplicating a constant or an enumeration into this file is exactly how it
went stale the last time.

## Format

Each entry follows this shape:

```
### Q: <question>

<answer>

Related: <links to docs/... if applicable>
```

---

<!-- Questions start here -->

### Q: If someone brute-forces a random account number, can they directly access that account's sync data?

Short answer: **no, not in practice — the number is only half of the sync credential, and everything behind it is opaque ciphertext anyway.**

Three things have to be separated here:

**1. Can the account number alone unlock the vault?**
No. The account number is **not a key**. It does not encrypt anything. To derive `root_key` you also need the master password and/or the 24-word recovery phrase, which are fed into Argon2id (`m=256 MiB, t=3, p=2`). The account number is mixed into the Argon2id salts only to prevent cross-account precomputation; it is not a secret input to the KDF.

So even an attacker who somehow learns a valid account number sees only encrypted blobs, version counters, and aggregate sizes on the sync server. Plaintext, titles, structure, links, and timestamps stay confidential.

**2. Can the account number be brute-forced?**
The entropy is **95 bits** (19 Crockford-base32 characters × 5 bits, plus a 1-character Damm-32 check digit that is not entropy). That is ≈ 3.96 × 10²⁸ candidates. Even at 1 billion online registration probes per second against the sync server, the expected time to find a single valid account is on the order of 10¹² years. The Damm-32 check rejects ~31/32 of malformed candidates client-side, but that is a UX feature, not a security barrier — it does not meaningfully shrink the search space.

Online enumeration is further limited by:

- Authenticated requests are rate-limited **per account** (keyed on `account_number_hash`), never per IP — per-IP limiting is unavailable by commitment (`threat-model.md` §2 AS14).
- The surface an enumerator would actually hammer — registration and the SCRAM handshake — runs *before* a session exists and so has no account to key on. It is bounded instead by a single account-independent global token bucket plus hard resource caps (a registered-account ceiling, a TTL-swept in-flight-handshake ceiling, small body limits). Neither mechanism observes an IP. See `server-protocol.md` §5.2 for the exact posture.
- The server never stores the raw number. Its account identity is `SHA-256(canonical_form)[:16]`, and since 2026-07-13 the raw form does not cross the sync wire at all — the SCRAM username *is* the hash, and a raw-form username is rejected (`account-number.md` §7; `server-protocol.md` §3.1; `decisions.md` 2026-07-13). A dump of the server's account table yields hashes, not account numbers.

**3. What would a correct guess actually grant?**
Less than the phrase "bearer token" suggests. Under the v0.1 auth mechanism the client authenticates with a **SCRAM-SHA-256 handshake whose verifier is derived from `{account number + master password}` or `{account number + 24-word recovery phrase}`** (`server-protocol.md` §3.1) — the number is one of two inputs, not the credential. Someone holding only the number can start a handshake (which confirms the account exists and returns its SCRAM salt and iteration count) but cannot finish one, and nothing in that exchange is verifier material they could attack offline. On top of that, a new **password-path** device lands *pending* and syncs nothing until an already-approved device admits it (the device-approval gate, SYNC-9).

So the worst case is weaker than "quota abuse": without the second input there is no session, therefore no blob fetch and no storage consumed. And even a full session would only ever hand over ciphertext — the server is outside the trust boundary by construction (`threat-model.md` §3 TB5).

`account-number.md` §7 still says to treat account numbers "like cash", and that still holds — it is half of the sync credential, and it is the value a support channel or an operator could be socially engineered around. It is simply not, on its own, a session.

Related: `spec/account-number.md` §1, §2, §7; `spec/protocol.md` §3.1; `spec/server-protocol.md` §3.1 (auth + device-approval gate), §5.2 (rate-limit, never IP); `threat-model.md` §2 AS9/AS14, §3 TB5.

### Q: Where are encrypted notes stored — is there a database?

Short answer: **still no database — one encrypted file per note, in a directory on the user's filesystem. What has grown since this answer was first written is the number of *other* files sitting beside them, not the shape of the thing.**

A vault is a regular folder at `vaults/<vault-id>/` under the app's data directory (one directory per vault; the older single-`vault/` layout is migrated eagerly at boot — `decisions.md` 2026-06-09). Inside it (`protocol.md` §9.1):

- `vault.meta` — a single file holding vault-level state: the wrapped `itemsKey`, the two Argon2id salts, the protocol version, the Argon2id parameter block, the password and recovery wraps of `root_key`, and the account-number hash. Magic bytes `MYV1`.
- `notes/<note-uuid>.myn` — one encrypted blob per note. Magic bytes `MY01`. Fixed-offset binary header (magic, version, `items_key_id`, the wrapped per-note `item_key`, nonces) followed by XChaCha20-Poly1305 ciphertext wrapped in a CTX commitment tag. The directory is **always flat**: folders are virtual, carried as a path string inside the encrypted frontmatter, so no folder name ever reaches the filesystem.
- `snapshots/` (per-note version history, re-sealed `.myn`-format blobs), `attachments/`, `attachments-text/`, and a set of vault-level singletons beside `vault.meta` — preferences, the search index, workspace state, the attachments catalog, the personal dictionary, and so on. Each is its own magic-tagged, separately-keyed AEAD envelope. **Don't read that as the roster**: `protocol.md` §10.3 is the single source of truth for which blob families exist, and §9.5–§9.21 specify them one at a time.

Only `vault.meta` and `notes/` are required. Everything else is created lazily by the feature that owns it, and a vault missing any of it is still well-formed — the reader rebuilds a cache or falls back to defaults rather than failing to parse.

The on-disk format is binary with fixed offsets and big-endian integers — no JSON envelope, no SQLite container, at any layer.

(The web client is the one place where the *container* differs: OPFS gives no crash-atomic rename, so singletons are double-buffered into alternating `.a` / `.b` copies instead of temp-file-plus-rename. The blobs themselves are byte-identical to what desktop writes — same magic, same AAD, same ciphertext. `decisions.md` 2026-07-26.)

**Why not a database?** Two reasons grounded in vision and protocol commitments:

1. `vision.md` commits to "your notes stay plain markdown after decryption" and "no proprietary format, no migration tool required." A SQLite or similar container would re-introduce a proprietary file the user cannot open with a normal editor after decryption.
2. Per-note files make the unit of sync identical to the unit of encryption — each `.myn` is what travels to the server and what the per-note version counter is attached to. A single database file would make conflict resolution and partial sync significantly harder. Sync shipped on exactly that assumption; `sync-protocol.md` §10.1 resolves a concurrent edit by keeping both note bodies, which is only cheap because a note *is* a file.

**What about search?** The full-text index shipped, as `vault.search` (`MYS1`, §9.6) — and it is not a database either. The index is built in RAM from decrypted note content while the vault is unlocked, queried in memory, and zeroized on lock alongside the keys; `vault.search` is purely a *persistence cache* so a warm unlock doesn't have to decrypt every note again. A missing, stale, or unreadable one is always recoverable by rebuilding from the `.myn` files, which stay the source of truth. The other derived blobs (`vault.indices`, `vault.embeddings`, `vault.graph`) have exactly the same standing.

**What leaves the device?** Only ciphertext, and only for the artefact classes sync admits. `sync-protocol.md` §9 partitions every vault artefact into authoritative / identity / rebuildable-cache / device-local and is the list of record — rebuildable caches and device-local blobs never sync at all, and `snapshots/` are a deliberate carve-out (authoritative and backed up, yet never synced). Whatever does travel is opaque ciphertext plus a small public header (magic, version, IDs, nonces, salts, account-hash). No plaintext content, titles, structure, links, or user-meaningful timestamps ever leave the client.

Related: `spec/protocol.md` §9.1 (vault layout), §9.2 (per-note blob), §9.3 (`vault.meta`), §9.4 (what is plaintext on disk and why), §9.5–§9.21 (the other blob families), §10.3 (the magic-byte registry); `spec/sync-protocol.md` §9 (sync taxonomy); `vision.md` (anti-features, "plain markdown after decryption").

### Q: How many secrets are there in this app?

Short answer: **two user-held secrets, sitting on top of a four-layer key hierarchy plus one binding hash.** Almost everything else on disk is keyed by a *derivation* from those layers rather than by a new secret; the handful of exceptions are device-local and named below.

**1. What the user holds (two secrets, different roles)**

- **Master password** — typed every time the vault is opened. Fed into Argon2id (`m=256 MiB, t=3, p=2`) together with `random_salt_password_16` and `account_hash` to derive `password_wrap_key`, which unwraps `root_key`. Changeable at any time — Settings → Account, backed by the `vault_change_password` core plugin.
- **Recovery phrase** (24 BIP-39 words) — generated once at vault creation, stored offline by the user (paper, password manager). Fed through NFKD normalization, then Argon2id with `random_salt_recovery_16` and `account_hash` to derive `recovery_wrap_key`, which unwraps the **same** `root_key`. Never rotates: changing the master password leaves the recovery phrase still valid, because `vault.meta` rewrites only the password-side fields and preserves the recovery-side bytes (`enc_root_key_recovery`, `random_salt_recovery_16`, `nonce_recovery_wrap`) byte-for-byte.

Both paths reach the same `root_key`. The on-disk `vault.meta` file carries two independent wraps of `root_key` — `enc_root_key_password` and `enc_root_key_recovery` — so loss of the password is recoverable as long as the phrase survives, and vice versa.

**2. What the crypto stack derives (four key layers, invisible to the user)**

| Key | Provenance | Role |
|---|---|---|
| `password_wrap_key` | `Argon2id(password \|\| random_salt_password_16 \|\| account_hash, params)` | Wraps / unwraps `root_key` (password path) |
| `recovery_wrap_key` | `Argon2id(NFKD(phrase) \|\| random_salt_recovery_16 \|\| account_hash, params)` | Wraps / unwraps `root_key` (recovery path) |
| `root_key` | CSPRNG (32 bytes) at vault creation | Wraps / unwraps `items_key` |
| `items_key` | CSPRNG (32 bytes) at vault creation | Encrypts each note (per-note subkey via HKDF-SHA-256) |

Chain: `password OR phrase → wrap_key → root_key → items_key → note`.

That chain is the *note* path, and attachment blobs ride it too. Everything else in the vault — preferences, the search index, the attachments catalog, the personal dictionary, the theme palettes, the rebuildable caches — hangs off `root_key` directly, one HKDF-derived KEK per blob family, deliberately independent of the `itemsKey` lineage so those artefacts survive a future `itemsKey` rotation. Those are derivations, not additional secrets; `protocol.md` §3.4 is the registry of record for which context strings exist and what each one keys.

Three families are keyed from *outside* that registry, and those are the only places a genuinely separate secret appears: the quick-unlock credential blob and the two device-local staging queues (pending watch captures, pending share-imports). All three must be written while the vault is locked and `root_key` is unavailable, so their wrap keys come from the OS keychain/Keystore — or, for quick-unlock, from a PIN — instead. All three are device-local: never synced, never backed up (§3.4, §9.14, §9.18, §9.20).

**Why four layers?**

- **Password rotation must not re-encrypt notes.** `vault_change_password` rewraps only `root_key`; `items_key` and every `.myn` ciphertext stay byte-identical. A two-layer design (`password → items_key`) would force re-encrypting every note on password change.
- **Recovery is independent of the password.** A separate `recovery_wrap_key` reaches the same `root_key` through a parallel path, without sharing key material with the password side.
- **`items_key` separation is what makes multi-device sync cheap.** Multi-device sync ships (`sync-protocol.md`): every device unwraps the *same* `root_key` from the same synced `vault.meta`, so a rotation on one device rewraps one copy rather than re-keying content the other devices would then have to chase. `vault.meta` is the one synced artefact with a bespoke merge, precisely so a concurrent password change on one device cannot strand the recovery-side wrap on another (`sync-protocol.md` §10.3).

**3. The binding hash (not a secret)**

`account_hash = SHA-256(canonical_account_number)[:16]` is bound into the AAD of the two credential wraps in `vault.meta` and of the `root_key`-derived vault blobs (prefs, search, workspace, indices, attachments catalog, dictionary, themes, …). Per-note and attachment AADs bind `items_key_id` plus the item's own identity instead — the exact composition for each is in `protocol.md` §5.2. It is not secret — it derives from the public account number — but it prevents one account's `vault.meta` from being silently parsed as another account's, and it stops cross-account precomputation against the Argon2id salts. Treat it as a domain-separation tag, not a key.

**16 bytes, one canonical form, everywhere.** An earlier draft of this file (and of `account-number.md` §7) said `[:32]` for the server-side identity, on the theory that a different truncation would avoid reusing one identifier across two roles. It would not: a longer truncation of the same digest is a strict prefix-extension of the shorter one, so it separates nothing. Corrected 2026-07-13 — `decisions.md` and `account-number.md` §6/§7 carry the reasoning, and `protocol.md` §9.3 pins the 16-byte field in `vault.meta`.

Related: `spec/protocol.md` §3 (key hierarchy — §3.1 credential wrapping and salt construction, §3.3 three-level note wrapping, §3.4 subkey context-string registry), §4 (KDF parameters), §5 (AEAD AAD construction), §9.3 (`vault.meta` layout); `spec/account-number.md` §6, §7; `spec/recovery-flow.md` §4.4 (a post-recovery password reset writes the password side only).
