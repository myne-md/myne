# Questions and Answers

This file collects simple questions and answers about the Myne project.
It is a space for summarised or informal counterparts to the specifications;
it is not normative. If an answer here conflicts with `vision.md`,
`threat-model.md`, `spec/protocol.md`, `spec/account-number.md`,
`glossary.md`, or `decisions.md`, those documents take precedence.

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

Short answer: **no, not in practice — and even if they could, they would only get opaque ciphertext.**

Two things have to be separated here:

**1. Can the account number alone unlock the vault?**
No. The account number is **not a key**. It does not encrypt anything. To derive `root_key` you also need the master password and/or the 24-word recovery phrase, which are fed into Argon2id (`m=256 MiB, t=3, p=2`). The account number is mixed into the Argon2id salts only to prevent cross-account precomputation; it is not a secret input to the KDF.

So even an attacker who somehow learns a valid account number sees only encrypted blobs, version counters, and aggregate sizes on the sync server. Plaintext, titles, structure, links, and timestamps stay confidential.

**2. Can the account number be brute-forced?**
The entropy is **95 bits** (19 Crockford-base32 characters × 5 bits, plus a 1-character Damm-32 check digit that is not entropy). That is ≈ 3.96 × 10²⁸ candidates. Even at 1 billion online registration probes per second against the sync server, the expected time to find a single valid account is on the order of 10¹² years. The Damm-32 check rejects ~31/32 of malformed candidates client-side, but that is a UX feature, not a security barrier — it does not meaningfully shrink the search space.

Online enumeration is further limited by:

- Per-account rate limits on the sync server (per-IP limits are intentionally unavailable due to the no-IP-logging commitment, see `threat-model.md` §2 AS14).
- The server stores only `SHA-256(canonical_form)[:32]`, so an offline dump of the server's account table still requires inverting SHA-256 to obtain valid bearer tokens.

**3. What does "sync access" actually grant?**
The account number is documented as a **bearer token** for hosted sync (Phase 2+), Mullvad-style (`account-number.md` §7). Possession lets the holder talk to the sync server *for that account* — i.e. fetch ciphertext blobs, see version counters, and consume that account's storage quota. It does **not** decrypt anything. The worst-case outcome of a (practically impossible) successful guess is denial-of-service / quota abuse against that account, not a confidentiality break.

This is also why the spec says to treat account numbers "like cash" — write them down, do not paste them into untrusted forms — even though losing one does not, by itself, leak any note contents.

Related: `spec/account-number.md` §1, §2, §7; `spec/protocol.md` §3.1; `threat-model.md` §2 AS9, §3 TB5.

### Q: Where are encrypted notes stored — is there a database?

Short answer: **no database in v0.1; encrypted notes live as plain files in a directory on the user's filesystem.**

A Myne vault is a regular folder with two kinds of files:

- `vault.meta` — a single file holding vault-level state: the wrapped `itemsKey`, the two Argon2id salts, the protocol version, the Argon2id parameter block, the password and recovery wraps of `root_key`, and the account-number hash. Magic bytes `MYV1`.
- `notes/<item_id>.myn` — one encrypted blob per note. Magic bytes `MY01`. Fixed-offset binary header (nonce, item_id, itemsKey_id, …) followed by XChaCha20-Poly1305 ciphertext wrapped in a CTX commitment tag.

The on-disk format is binary with fixed offsets and big-endian integers — no JSON envelope, no SQLite container.

**Why not a database?** Two reasons grounded in vision and protocol commitments:

1. `vision.md` commits to "your notes stay plain markdown after decryption" and "no proprietary format, no migration tool required." A SQLite or similar container would re-introduce a proprietary file the user cannot open with a normal editor after decryption.
2. Per-note files make the unit of sync identical to the unit of encryption — each `.myn` is what travels to the server (Phase 2+) and what the per-note version counter is attached to. A single database file would make conflict resolution and partial sync significantly harder.

**What about search?** A future Phase 1.5 client may add an internal encrypted SQLite + FTS5 index for full-text search. That is **client-internal**, not part of the protocol, and stays at-rest encrypted on disk. The `.myn` files remain the source of truth.

**What leaves the device?** Only `vault.meta` and `.myn` files, both opaque ciphertext plus a small public header (magic, version, IDs, nonces, salts, account-hash). No plaintext content, titles, structure, links, or user-meaningful timestamps ever leave the client.

Related: `spec/protocol.md` §9 (vault layout, per-note blob format, vault.meta format), §9.4 (what is plaintext on disk and why); `vision.md` (anti-features, "plain markdown after decryption").

### Q: How many secrets are there in this app?

Short answer: **two user-held secrets, sitting on top of a four-layer key hierarchy plus one binding hash.**

**1. What the user holds (two secrets, different roles)**

- **Master password** — typed every time the vault is opened. Fed into Argon2id (`m=256 MiB, t=3, p=2`) together with `random_salt_password_16` and `account_hash` to derive `password_wrap_key`, which unwraps `root_key`. Changeable (Phase 2 `vault_change_password`).
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

**Why four layers?**

- **Password rotation must not re-encrypt notes.** Phase 2's `vault_change_password` rewraps only `root_key`; `items_key` and every `.myn` ciphertext stay byte-identical. A two-layer design (`password → items_key`) would force re-encrypting every note on password change.
- **Recovery is independent of the password.** A separate `recovery_wrap_key` reaches the same `root_key` through a parallel path, without sharing key material with the password side.
- **`items_key` separation keeps Phase 2 multi-device sync open.** Multiple devices can hold the same `items_key` while each derives its own `password_wrap_key` from a device-local password. The protocol does not yet ship multi-device, but the layering does not foreclose it.

**3. The binding hash (not a secret)**

`account_hash = SHA-256(canonical_account_number)[:32]` is bound into the AAD of every AEAD wrap. It is not secret — it derives from the public account number — but it prevents one account's `vault.meta` from being silently parsed as another account's, and it stops cross-account precomputation against the Argon2id salts. Treat it as a domain-separation tag, not a key.

Related: `spec/protocol.md` §3 (KDF inputs and salt construction), §4 (key hierarchy), §5 (AEAD AAD construction), §9.3 (vault.meta layout); `spec/recovery-flow.md` §4.4 (recovery-side byte preservation across password rotation).
