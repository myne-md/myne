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
