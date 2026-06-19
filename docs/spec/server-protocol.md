# Myne Server Protocol Specification (Phase 2)

> **Status: draft.** Phase 2 sync-server contract — what the server stores, counts, and must not do. It is the server-side companion to [`sync-protocol.md`](sync-protocol.md) (the client wire protocol + the vault head) and builds on the at-rest protocol in [`protocol.md`](protocol.md) and the normative [`threat-model.md`](../threat-model.md). The server is **fully untrusted** (TB5); this document describes a *blind* store, not a trusted coordinator. The server implementation (Go) is the `myne-server` companion (MYND-419/421); this is the spec it implements. The server-auth **mechanism** is deferred (`protocol.md` §11.1; MYND-420) and only referenced here.

---

## 1. Scope & trust

### 1.1 Trust boundary

The sync server sits **outside** the trust boundary (TB5), and **hosted and self-hosted operators are treated identically** — self-hosting changes the operator, not the protocol's security model. The protocol assumes a *curious or compelled* server (A1, passive/compelled provider) and a network observer (A13, traffic analysis). Implementations and operators MUST NOT introduce any feature that depends on trusting the operator; a guarantee that an operator could violate by policy is a **policy obligation** (§6), not a protocol guarantee.

### 1.2 The server is a blind blob store

The server stores **opaque ciphertext blobs and key-wrapping material** and performs only **structural** operations on them:

- current-head pointer **compare-and-swap** (§2.3),
- the per-note **version-counter** increment (§2.2),
- **quota** accounting (§5) and **rate-limit** counting (§5),
- relaying the **contentless poke** (§3).

It **never** decrypts, merges, interprets, or reorders content. Plaintext, decryption keys, and the master password never leave the client (A1). Because the server cannot merge, all conflict resolution is **client-side** (`sync-protocol.md` §10). This "blindness" is structural, not a policy promise: the server has no key material with which to read what it relays.

### 1.3 What the server does NOT have

- **No user-meaningful timestamps.** The only time-like value is the opaque per-note version counter (§2.2, AS6); `created_at` / `updated_at` live encrypted inside the blob and are never visible.
- **No persistent IP log.** TLS termination sees the connection IP for the duration of a request and discards it (AS14); operational logging is built on per-account counts and version counters, never source IPs (§5). This is a hard commitment — a deviation requires amending `threat-model.md` in the same change.
- **No global view of content, structure, titles, folders, or tags** — all inside the AEAD envelope (`protocol.md` §9).

## 2. Storage model

### 2.1 Per-vault namespace

Ciphertext blobs are stored in a namespace **scoped to each vault**; there is **no global, cross-vault, content-addressed bucket**. Attachment-ids are vault-scoped keyed-HMAC values (`protocol.md` §9.9), so **cross-vault deduplication is structurally impossible** — and undesired: a global content-addressed bucket would be a known-file confirmation oracle. Deduplication is **intra-vault only**; quota (§5) and the tombstone ledger (`sync-protocol.md` §11) stay clean per vault. The server keys storage on the vault identifier and `account_number_hash`, never on user identity beyond that hash.

### 2.2 Opaque per-note version counter

Each note (and each content blob) carries a server-maintained **opaque, monotonic version counter** — a sync-internal integer, **not** a wall-clock time (AS6). The server increments it on each successful push of a new ciphertext for that blob. It is the **compare-and-swap token for an individual note push**: a push carries the base version the client expects, and a stale base is rejected (`sync-protocol.md` §8.1, §10). It reveals only *that* a blob changed and a coarse change-count — never *when* (no timestamp) and never *what* (opaque ciphertext). It is **orthogonal to the vault head**: the head is authored and verified by the client and stored by the server as an opaque, HMAC'd blob; the version counter is the server's own per-blob bookkeeping.

### 2.3 Current-head pointer

The server keeps **one current-head pointer per vault** — the `head_id` of the latest accepted vault head. A push is accepted iff the pushed head's `prev_head_hash` matches the current pointer (the git-push compare-and-swap of `sync-protocol.md` §8.1 / §4.3); the server then atomically advances the pointer. The server treats the head as opaque and HMAC'd: it can only accept, reject, or serve a real head — it cannot forge one (it has no `root_key`) nor fabricate a DAG edge. Concurrent pushes resolve by the loser pulling, merging, and re-pushing (`sync-protocol.md` §5.3, §8.1).

## 3. API surface

The server exposes the operations whose **wire shapes are defined in `sync-protocol.md` §8** — this section does not redefine them, it states the server's obligations:

- **pull(cursor)** — return the per-blob sync-meta `(uuid, version, content_nonce, size)` for everything changed since `cursor`, plus the current vault head; advance the cursor. The server selects by its own version counters; it never inspects content.
- **push(changed_blobs, new_head)** — accept iff the head CAS holds (§2.3); store the blobs in the vault namespace (§2.1), incrementing each blob's version counter (§2.2); reject a stale base with a 409-like response. **Idempotent**: a retried push with the same head is a no-op (the CAS already advanced).
- **poke** — relay a **contentless** "vault changed" signal (zero payload — no uuid/version/count; `sync-protocol.md` §8.3) over SSE to a vault's other connected devices; polling is the privacy-default alternative the server also serves.

All operations are bound to an **authenticated session**. The authentication **mechanism is deferred** (`protocol.md` §11.1 — high-entropy verifier vs OPAQUE; v005 canonicalizes OPAQUE) and specified separately (MYND-420); this document requires only that every push/pull/poke be tied to an authenticated session and that a poke channel be authenticated (a spoofed poke is at worst low-severity DoS). The server MUST NOT accept an operation that is not session-bound.

## 4. Device registry (AS16)

The server keeps a **per-account device registry** — one record per enrolled device — because revocation requires the server to know which devices exist (AS16; this is the one place device count is necessarily server-visible). Each record is keyed by the **client-generated `device_id`** (the version-vector actor, `sync-protocol.md` §4.1), which is **distinct from the device's secret per-device token**: the `device_id` is permanent, non-secret history; the token is the revocable bearer credential.

- **Enrollment** registers a new `device_id` (subject to the device-approval gate — a server authz concern; the client ceremony is MYND-425).
- **Revocation** = invalidating the per-device token: an **availability** control that stops that device syncing. It is **not** forward-secret — a removed device retains whatever it already synced, and v0.1 offers no cryptographic re-key (that is v005/MLS epoch-key revocation; `threat-model.md` §7). The registry record may be retained frozen for audit (it never re-issues the same `device_id`).
- The registry exposes **device count + per-device enrollment/activity** to the server (AS16 + the A13 per-device push-timing already accepted in `threat-model.md` §7); it holds **no** content and **no** key material.

## 5. Quota & abuse — IP-free

### 5.1 Quota

Storage is bounded by a **per-account quota**: aggregate **deduplicated** ciphertext bytes (AS17), counted once per stored blob (not once per referencing note — dedup is intra-vault, §2.1). On the hosted tier this is the paid-plan ceiling; a self-host operator sets their own (the protocol exposes the byte counter, the operator sets the policy — §6, TB5).

### 5.2 Rate-limit, never IP

Request abuse is bounded by a **per-account token-bucket rate-limit keyed on `account_number_hash`** — **never on IP** (C4). The server keeps **no persistent IP log**: TLS termination sees the connection IP for the request duration and discards it (AS14). The "no IP logging" commitment is **architectural, designed in from the start, not retrofitted** — operational logging (errors, rate-limit triggers, abuse heuristics) MUST function on per-account counts and version counters, not source IPs. A per-device sub-limit bounds a single compromised device.

### 5.3 Sybil posture

Sybil resistance is **reframed** as an operator resource/availability problem, not a user-security one: vaults are independent and zero-knowledge, so a Sybil account reaches no one else's data. On the hosted tier, the **payment-gate is the primary Sybil resistance** (no free anonymous registration surface ⇒ 10k Sybils = 10k subscriptions); per-account quota (§5.1) + rate-limit (§5.2) bound the damage. Proof-of-work is **not** in v1. The payment system itself is a separate epic (MYND-430); only the posture is recorded here. Self-host Sybil is the operator's policy problem.

## 6. Protocol-level vs policy-level (self-host)

TB5 means **self-host changes the operator, not the security model** — so the spec separates what the protocol *guarantees* (an operator cannot violate these) from what an operator *must enforce* (policy obligations):

| Protocol guarantee (structural) | Operator policy obligation |
|---|---|
| Cannot read plaintext / keys (blind blob store, §1.2) | — (nothing to enforce; structural) |
| Conflict resolution is client-side (§1.2) | — (structural) |
| Opaque version counter, no user timestamps (§2.2) | Do not add a side-channel that records wall-clock push times |
| No *required* persistent IP log (§5.2) | **Do not add IP logging** (the protocol works without it; adding it is a policy violation of the AS14 commitment) |
| Tombstone GC bounded by the §11 horizon | **Do not retain deleted ciphertext past the horizon** (cryptographic erase is the client's; the operator must not hoard old blobs) |
| Quota counter exposed | Set a sane per-account ceiling; enforce fairly |

The operator-log-policy limitation (a malicious self-host operator *can still* log IPs, retain old ciphertext, or correlate metadata at the policy level) is recorded in `threat-model.md` §7 (self-host known limitation); this section is its normative counterpart on the protocol side. A self-host deployment that honours the policy column is, by TB5, exactly as trustworthy (and as untrusted) as the hosted service — no more, no less.
