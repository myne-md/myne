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
- **attachment byte-transport** — store and serve attachment ciphertext (`MYA1`) over the dedicated resumable routes of **§3.2**; attachment *metadata* records still ride pull/push (`sync-protocol.md` §8.1), and attachment deletion is a normal push tombstone (`sync-protocol.md` §11.4) — there is no separate delete route.

All operations are bound to an **authenticated session**. The **v0.1 authentication mechanism** — a SCRAM-SHA-256 verifier handshake that yields a per-device bearer token — is documented in **§3.1** below (it is the `myne-server/internal/authapi` HTTP surface; MYND-420 exposure / MYND-425 client enrollment). `protocol.md` §11.1 records the forward-look (v005 canonicalizes an OPAQUE aPAKE; the v0.1 mechanism is the high-entropy-verifier SCRAM path). Every push/pull/poke MUST be tied to an authenticated session and a poke channel MUST be authenticated (a spoofed poke is at worst low-severity DoS). The server MUST NOT accept an operation that is not session-bound.

### 3.1 Auth & device-enrollment wire (v0.1 mechanism; MYND-420/425)

The v0.1 authentication mechanism is a **SCRAM-SHA-256(-PLUS)** handshake. The account holds a high-entropy **verifier** derived client-side from `{account_number + password}` (or `{account_number + 24-word recovery phrase}`); the server stores only the SCRAM verifier material (`StoredKey`, `ServerKey`, `Salt`, `Iterations`) — **never the secret, never a password-equivalent it could replay**. This preserves TB5: the server authenticates a device without ever being able to derive `root_key` or decrypt a blob. A successful handshake mints a **per-device token** (the revocable bearer credential); the `Authorization: Bearer <token_hex>` header authenticates every subsequent authed request. The token is **distinct from** the client-generated `device_id` (§4) — revoking a token never touches `device_id` (SYNC-2).

All request/response bodies are JSON. Every pre-auth request body is capped (`MaxAuthBodySize`, 8 KiB) and the pre-auth surface is bounded by §5.2 (a single account-independent global limiter + finite resource caps — never IP, never the client-supplied account value). Error responses are `{"error_code": "<code>"}` with an HTTP status.

**Pre-auth (session-less) routes** — no `Authorization` header:

| Route | Request fields | Success response | Semantics |
|---|---|---|---|
| `POST /auth/register` | `account_hash_hex`, `username`, `salt_hex`, `iterations`, `stored_key_hex`, `server_key_hex` | `{"ok": true}` | Upload the SCRAM verifier for an account. **First-write only** — a second register for the same `account_hash` is `409 already_registered` (replacing a verifier requires an authed flow, not in v0.1). `503 capacity` when the registered-account cap is hit. The server stores `StoredKey`/`ServerKey`/`Salt`/`Iterations`/`username`; it never sees the secret. |
| `POST /auth/scram/init` | `account_hash_hex`, `username`, `client_nonce` | `{"handshake_id", "combined_nonce", "salt_hex", "iterations"}` | SCRAM client-first → server-first. An unknown account and a wrong username return the **same** `401 unauthenticated` (no account-enumeration signal). `combined_nonce = client_nonce ∥ server_nonce`. In-flight handshakes are capped + TTL-swept (`503 capacity` at the cap). |
| `POST /auth/scram/final` | `handshake_id`, `client_final` (SCRAM client-final-message), `device_id_hex`, `path` (`"password"` \| `"recovery"`) | `{"approved": bool, "token_hex"?, "server_signature_b64"}` | Verify the client proof, apply the approval gate, and either issue a per-device token (`approved: true`, `token_hex` present) or report pending (`approved: false`, no `token_hex`, `server_signature_b64` still returned so the client can verify the server). A failed proof burns the one-shot handshake and returns `401 unauthenticated` (no online-guessing reuse). |
| `GET /vault.meta` | (device-registry bootstrap) | opaque `vault.meta` bytes (`protocol.md` §9.3) | A **joining** device fetches the account's `vault.meta` **before** it has a session, to derive `root_key` from `{account# + password/phrase}` and bootstrap. The blob is opaque and AEAD-sealed — the server serves bytes it cannot read. Bounded as pre-auth per §5.2. |

**Authed routes** — `Authorization: Bearer <token_hex>` (a valid, non-revoked per-device token); a missing/invalid token is `401 unauthenticated`:

| Route | Request fields | Success response | Semantics |
|---|---|---|---|
| `GET /auth/devices` | — | `{"devices": [{"device_id_hex", "approved", "retired"}]}` | The account's device roster (AS16). |
| `POST /auth/devices/approve` | `device_id_hex` | `{"ok": true}` | An existing approved device approves a **pending** device (the password-path gate). `404 device_not_found` for an unknown `device_id`. |
| `POST /auth/devices/revoke` | `device_id_hex` | `{"ok": true}` | Revoke the device's token (**availability** — sync stops to that device) and retire its registry record. `device_id` is **not** destroyed (SYNC-2); this is not a cryptographic lockout or a remote wipe (§4; the honest-disclosure copy is `REMOVE_DEVICE_DISCLOSURE`). |

**The device-approval gate (SYNC-9).** SCRAM only proves *account ownership*; admitting the device is a separate authorization step. The **first** device on an account and any **recovery-path** device **self-approve** (the bootstrap exception — the 24-word phrase already grants full account takeover, the accepted hole). A new **password-path** device lands **pending** and syncs nothing until an already-approved device calls `/auth/devices/approve` for it. A device that returns after approval re-runs the handshake and is issued its token.

**Channel binding (R3 — not yet channel-bound).** The mechanism is **SCRAM-SHA-256-PLUS** with channel binding = the **TLS exporter** (`tls-server-end-point`-class exporter keying material). Over the loopback-http test harness there is **no** TLS exporter, so the server's expected channel-binding data is **empty** and the client matches it; over real TLS both ends feed the exporter. Wiring the live exporter on both the Go server (`serverCbind`) and the client rustls transport is the **R3-pending** step. **Until R3 lands, no channel-binding / "-PLUS"-verified claim may be made** — the handshake authenticates the account and mints a token, but it is not yet bound to the TLS channel (documented so a reader does not over-read the `-PLUS` suffix). See the epic sync-ledger R3.

### 3.2 Attachment byte-transport (`/attachments/{id}`; MYND-423/468)

Attachment ciphertext does not travel inline in `push` (a 64 MiB blob in a one-shot base64-JSON body has no resume story). It moves over three dedicated, **session-bound** routes keyed by the full lowercase-hex 32-byte `attachment-id` (`protocol.md` §9.9). The server stores the bytes as an opaque unit in the vault namespace (§2.1); it never parses them.

| Route | Request | Success response | Semantics |
|---|---|---|---|
| `HEAD /attachments/{id}` | — | `200` + `X-Uploaded-Length: <n>`, `X-Complete: true\|false` | Resume/dedup probe: how many bytes the server holds for this id, and whether the upload is complete. `404` for an unknown **or deleted** id (deleted-is-absent, non-distinguishing; `sync-protocol.md` §11.4). |
| `PUT /attachments/{id}?offset=N&total=M` | raw ciphertext chunk (`application/octet-stream`) | `200` + `X-Uploaded-Length` | **Strict-sequential resumable upload**: `offset` MUST equal the server's current uploaded length (else `409` — the client re-probes with `HEAD` and resumes from the real offset); `total` is the declared final ciphertext length, checked against the 64 MiB + 32 cap (`413`) and — at `offset=0` — against the **unified AS17 quota** (§5.1) and the **per-vault attachment-id ceiling** (`507`). The upload is complete when the stored length reaches `total`. A `PUT` to a previously-deleted id restarts it as a fresh upload (re-add; `sync-protocol.md` §11.4 rule 4). |
| `GET /attachments/{id}` | optional single `Range: bytes=start-end` | `200` (whole blob) / `206` (the range) | Download with resume. Multi-range is rejected (`400`); an unsatisfiable range is `416`; unknown/deleted id is `404`. |

Normative rules:

- **The AEAD unit is never chunked.** An `MYA1` blob is one atomic whole-file AEAD+CTX unit (`protocol.md` §9.9); `PUT`/`GET` offsets and ranges slice **opaque transport bytes only**. The client verifies the whole-blob tag after reassembly and discards the blob on failure — the CCS-2024 unauthenticated-chunking class is structurally excluded, and the server can corrupt nothing without detection.
- **All three routes are authenticated** (Bearer per-device token, §3.1) and covered by the **same per-account rate-limit** as push/pull (§5.2) — the attachment path is not a second, uncounted budget (the 2026-07-03 AS17 unification, `decisions.md`).
- **Quota reserves on declaration.** The `offset=0` check counts `total` against the account's unified ciphertext ceiling (blob bytes + attachment bytes, one number); the per-vault id ceiling counts **incomplete uploads too** (a half-uploaded 64 MiB body is the real resource).
- **Deletion has no route here.** The lifecycle signal is the push tombstone (`sync-protocol.md` §11.4); on receiving it the server marks the body deleted (absent to `HEAD`/`GET`), and physically reclaims it — body, partial state, id-slot, quota bytes — when horizon-GC reclaims the tombstone record (§11.2 ack rule; `MYNE_EXTENDED_RETENTION` keeps bodies exactly as it keeps note ciphertext).

## 4. Device registry (AS16)

The server keeps a **per-account device registry** — one record per enrolled device — because revocation requires the server to know which devices exist (AS16; this is the one place device count is necessarily server-visible). Each record is keyed by the **client-generated `device_id`** (the version-vector actor, `sync-protocol.md` §4.1), which is **distinct from the device's secret per-device token**: the `device_id` is permanent, non-secret history; the token is the revocable bearer credential.

- **Enrollment** registers a new `device_id` (subject to the device-approval gate — a server authz concern; the client ceremony is MYND-425).
- **Revocation** = invalidating the per-device token: an **availability** control that stops that device syncing. It is **not** forward-secret — a removed device retains whatever it already synced, and v0.1 offers no cryptographic re-key (that is v005/MLS epoch-key revocation; `threat-model.md` §7). The registry record may be retained frozen for audit (it never re-issues the same `device_id`).
- The registry exposes **device count + per-device enrollment/activity** to the server (AS16 + the A13 per-device push-timing already accepted in `threat-model.md` §7); it holds **no** content and **no** key material.

## 5. Quota & abuse — IP-free

### 5.1 Quota

Storage is bounded by a **per-account quota**: aggregate **deduplicated** ciphertext bytes (AS17), counted once per stored blob (not once per referencing note — dedup is intra-vault, §2.1). The counter is **one number per account** across note blobs *and* attachment bodies (§3.2) — the attachment path has no separate budget. Reclamation decrements it: when horizon-GC drops a tombstoned body (`sync-protocol.md` §11.2/§11.4), the reclaimed bytes leave the counter. On the hosted tier this is the paid-plan ceiling; a self-host operator sets their own (the protocol exposes the byte counter, the operator sets the policy — §6, TB5).

### 5.2 Rate-limit, never IP

Request abuse is bounded by a **per-account token-bucket rate-limit keyed on `account_number_hash`** — **never on IP** (C4). The server keeps **no persistent IP log**: TLS termination sees the connection IP for the request duration and discards it (AS14). The "no IP logging" commitment is **architectural, designed in from the start, not retrofitted** — operational logging (errors, rate-limit triggers, abuse heuristics) MUST function on per-account counts and version counters, not source IPs. A per-device sub-limit bounds a single compromised device.

The per-account limit covers **authenticated** requests. A few operations run **before** a session exists — device registration, the SCRAM handshake, and the pre-auth `vault.meta` fetch (§3, device-registry bootstrap) — and so have no `account_number_hash` to key on. Keying these on IP is forbidden (C4/AS14), and keying on the *client-supplied* account value would itself be an unbounded-map abuse surface. This pre-auth surface is therefore bounded by two structural mechanisms, neither of which observes an IP: (1) a **single global (account-independent) token-bucket** whose per-key state is zero by construction, so it cannot key on IP or account — it smooths churn only; and (2) **finite resource caps** that are the hard bound — a ceiling on the registered-account count, a ceiling plus a short TTL on in-flight handshakes, a per-vault attachment-id ceiling, and a small body-size limit on every pre-auth request. Under a sustained flood the caps keep memory and disk bounded (the server does not fail) while pre-auth availability degrades to best-effort refusals (a rate signal vs a capacity signal) — the accepted DoS posture (§5.3; A13-class, `threat-model.md` §1). Proof-of-work is **not** used (§5.3).

### 5.3 Sybil posture

Sybil resistance is **reframed** as an operator resource/availability problem, not a user-security one: vaults are independent and zero-knowledge, so a Sybil account reaches no one else's data. On the hosted tier, the **payment-gate is the primary Sybil resistance** (no free anonymous registration surface ⇒ 10k Sybils = 10k subscriptions); per-account quota (§5.1) + rate-limit (§5.2) bound the damage. **Until the payment gate ships (MYND-430), the registration surface is open**, bounded only by the §5.2 pre-auth global limiter, the registered-account cap, and the request body-size limit — enough to keep the server from being exhausted, not to prevent Sybil registration itself (that is the payment gate's job). Proof-of-work is **not** in v1. The payment system itself is a separate epic (MYND-430); only the posture is recorded here. Self-host Sybil is the operator's policy problem.

## 6. Protocol-level vs policy-level (self-host)

TB5 means **self-host changes the operator, not the security model** — so the spec separates what the protocol *guarantees* (an operator cannot violate these) from what an operator *must enforce* (policy obligations):

| Protocol guarantee (structural) | Operator policy obligation |
|---|---|
| Cannot read plaintext / keys (blind blob store, §1.2) | — (nothing to enforce; structural) |
| Conflict resolution is client-side (§1.2) | — (structural) |
| Opaque version counter, no user timestamps (§2.2) | Do not add a side-channel that records wall-clock push times |
| No *required* persistent IP log (§5.2) | **Do not add IP logging** (the protocol works without it; adding it is a policy violation of the AS14 commitment) |
| Tombstone GC bounded by the §11 horizon | **Do not retain deleted ciphertext past the horizon** — note blobs and attachment bodies alike (`sync-protocol.md` §11.4; cryptographic erase is the client's; the operator must not hoard old blobs) |
| Quota counter exposed | Set a sane per-account ceiling; enforce fairly |

The operator-log-policy limitation (a malicious self-host operator *can still* log IPs, retain old ciphertext, or correlate metadata at the policy level) is recorded in `threat-model.md` §7 (self-host known limitation); this section is its normative counterpart on the protocol side. A self-host deployment that honours the policy column is, by TB5, exactly as trustworthy (and as untrusted) as the hosted service — no more, no less.
