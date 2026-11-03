# Myne Server Protocol Specification (Phase 2)

> **Status: draft.** Phase 2 sync-server contract — what the server stores, counts, and must not do. It is the server-side companion to [`sync-protocol.md`](sync-protocol.md) (the client wire protocol + the vault head) and builds on the at-rest protocol in [`protocol.md`](protocol.md) and the normative [`threat-model.md`](../threat-model.md). The server is **fully untrusted** (TB5); this document describes a *blind* store, not a trusted coordinator. The server implementation (Go) is the `myne-server` companion (MYND-419/421); this is the spec it implements. The server-auth **mechanism** is **SCRAM-SHA-256(-PLUS)** and is specified in §3.1 below; `decisions.md` 2026-06-20 canonicalized it, superseding the deferral recorded in `protocol.md` §11.1 (MYND-420).

---

## 1. Scope & trust

### 1.1 Trust boundary

The sync server sits **outside** the trust boundary (TB5), and **hosted and self-hosted operators are treated identically** — self-hosting changes the operator, not the protocol's security model. The protocol assumes a *curious or compelled* server (A1, passive/compelled provider) and a network observer (A13, traffic analysis). Implementations and operators MUST NOT introduce any feature that depends on trusting the operator; a guarantee that an operator could violate by policy is a **policy obligation** (§6), not a protocol guarantee.

### 1.2 The server is a blind blob store

The server stores **opaque ciphertext blobs and key-wrapping material** and performs only **structural** operations on them:

- current-head pointer **compare-and-swap** (§2.3),
- the per-note **version-counter** increment (§2.2),
- **quota** accounting (§5) and **rate-limit** counting (§5),
- relaying the **contentless poke** (§3),
- **fan-out** of opaque live-awareness frames to a note room's subscribers (§3.5), never inspecting a frame byte.

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

A successful push that CAS-advances a **tombstoned** record's version clears the record's tombstone and any Layer-2 reclaimed mark (`sync-protocol.md` §11.1): the blob is live content again and is excluded from horizon-GC reclamation until re-tombstoned.

### 2.3 Current-head pointer

The server keeps **one current-head pointer per vault** — the `head_id` of the latest accepted vault head. A push is accepted iff the pushed head's `prev_head_hash` matches the current pointer (the git-push compare-and-swap of `sync-protocol.md` §8.1 / §4.3); the server then atomically advances the pointer. The server treats the head as opaque and HMAC'd: it can only accept, reject, or serve a real head — it cannot forge one (it has no `root_key`) nor fabricate a DAG edge. Concurrent pushes resolve by the loser pulling, merging, and re-pushing (`sync-protocol.md` §5.3, §8.1).

## 3. API surface

The server exposes the operations whose **wire shapes are defined in `sync-protocol.md` §8** — this section does not redefine them, it states the server's obligations:

- **pull(cursor)** — return the per-blob sync-meta `(uuid, version, content_nonce, size)` for everything changed since `cursor`, plus the current vault head; advance the cursor. The server selects by its own version counters; it never inspects content. **Layer-2-reclaimed records are omitted from every page** (plain and reconcile-flagged alike) while the returned cursor still advances across the omitted positions — a page may legitimately carry zero records with an advancing cursor (`sync-protocol.md` §11.3 "Reclaimed-record visibility"). The **ciphertext fetch** the client then performs — one blob at a time or many in one request — is **§3.3**; a fetch for a reclaimed record fails closed there, never as an empty-body 200.
- **push(changed_blobs, new_head)** — accept iff the head CAS holds (§2.3); store the blobs in the vault namespace (§2.1), incrementing each blob's version counter (§2.2); reject a stale base with a 409-like response. **Idempotent**: a retried push with the same head is a no-op (the CAS already advanced).
- **poke** — relay a **contentless** "vault changed" signal (zero payload — no uuid/version/count; `sync-protocol.md` §8.3) over SSE to a vault's other connected devices. Clients keep the stream open while unlocked (§8.3 as amended, `decisions.md` 2026-07-12); polling remains the fallback cadence the server always serves. Server obligations for the stream: (1) a periodic **contentless heartbeat** comment-line (`:hb`, ~30 s cadence — the client's dead-connection read-timeout is calibrated against it; it carries liveness and nothing else); (2) a per-account **concurrent-subscriber cap** (an OOM/fd bound, generous against the device-approval-gated device count); (3) connection attempts spend the **same per-account token bucket** (§5.2) as push/pull — never an IP key. Cap/limit rejections are the 429 `rate` class.
- **awareness**, relay **opaque** live-awareness frames (`sync-protocol.md` §8.3/§8.4) over the session-bound `GET`/`POST /sync/awareness` pair of **§3.5**: a downstream SSE stream fanning a frame out to every subscriber of its note room, and an upstream authenticated POST publishing a batch. The server reads **no frame byte**; it matches the room id exactly and forwards. RAM-only, no persistence, no log beyond the IP-free access line.
- **attachment byte-transport** — store and serve attachment ciphertext (`MYA1`) over the dedicated resumable routes of **§3.2**; attachment *metadata* records still ride pull/push (`sync-protocol.md` §8.1), and attachment deletion is a normal push tombstone (`sync-protocol.md` §11.4) — there is no separate delete route.

All operations are bound to an **authenticated session**. The **v0.1 authentication mechanism** — a SCRAM-SHA-256 verifier handshake that yields a per-device bearer token — is documented in **§3.1** below (it is the `myne-server/internal/authapi` HTTP surface; MYND-420 exposure / MYND-425 client enrollment). `protocol.md` §11.1 records the forward-look (the next major version canonicalizes an OPAQUE aPAKE; the v0.1 mechanism is the high-entropy-verifier SCRAM path). Every push/pull/poke MUST be tied to an authenticated session and a poke channel MUST be authenticated (a spoofed poke is at worst low-severity DoS). The server MUST NOT accept an operation that is not session-bound.

### 3.1 Auth & device-enrollment wire (v0.1 mechanism; MYND-420/425)

The v0.1 authentication mechanism is a **SCRAM-SHA-256(-PLUS)** handshake. The account holds a high-entropy **verifier** derived client-side from the account's `root_key` — which is itself reached from `{account_number + password}` or `{account_number + 24-word recovery phrase}`, but is never either of those (the derivation is normative, below); the server stores only the SCRAM verifier material (`StoredKey`, `ServerKey`, `Salt`, `Iterations`) — **never the secret, never a password-equivalent it could replay**. This preserves TB5: the server authenticates a device without ever being able to derive `root_key` or decrypt a blob. A successful handshake mints a **per-device token** (the revocable bearer credential); the `Authorization: Bearer <token_hex>` header authenticates every subsequent authed request. The token is **distinct from** the client-generated `device_id` (§4) — revoking a token never touches `device_id` (SYNC-2).

**The SCRAM secret (normative — interop-load-bearing).** The value RFC 5802 salts and stretches into `SaltedPassword` is **not** the user's master password, **not** the recovery phrase and **not** the account number. It is the registered `server-auth` subkey (`protocol.md` §3.4):

```
scram_secret   = DeriveSubkey(root_key, "server-auth")              // 32 bytes
SaltedPassword = PBKDF2-HMAC-SHA-256(scram_secret, salt, iterations, dkLen = 32)
```

- **Encoding is pinned.** `scram_secret` is fed to PBKDF2 as the **raw 32 bytes** — never its hex or base64 rendering — and **no SASLprep normalization is applied**. RFC 5802's normalization is defined over human passwords; this input is uniformly-random binary with no character interpretation, and normalizing it would change the bytes.
- **Both credential paths converge on the same secret.** The recovery path unwraps `enc_root_key_recovery` from `vault.meta` with the 24-word phrase (`protocol.md` §9.3) and so reaches the **same** `root_key`, hence the same `scram_secret`, as the password path. The `path` field of `/auth/scram/final` selects the device-approval gate only (SYNC-9); it changes no cryptographic input.
- **Clients MUST NOT** use the master password, the recovery phrase, the account number, or any other credential-equivalent value as the SCRAM secret. That is what "never a password-equivalent it could replay" above means in imperative form: a server handed one could grind it against the vault itself.
- **`salt` is 16 bytes** of client CSPRNG output, generated once at `/auth/register`. The server stores it and echoes it back on every `/auth/scram/init`, so only the first writer's salt is ever used.
- **`username` is the canonical lowercase hex of the 16-byte account hash** (the AS9 rule in the register row below) and is the `n=` value bound into the `AuthMessage`.

All request/response bodies are JSON. Every pre-auth request body is capped (`MaxAuthBodySize`, 8 KiB) and the pre-auth surface is bounded by §5.2 (a single account-independent global limiter + finite resource caps — never IP, never the client-supplied account value). Error responses are `{"error_code": "<code>"}` with an HTTP status.

**Pre-auth (session-less) routes** — no `Authorization` header:

| Route | Request fields | Success response | Semantics |
|---|---|---|---|
| `POST /auth/register` | `account_hash_hex`, `username`, `salt_hex`, `iterations`, `stored_key_hex`, `server_key_hex` | `{"ok": true}` | Upload the SCRAM verifier for an account. **The `username` MUST equal `account_hash_hex`** (the canonical lowercase hex of the 16-byte account hash) — any other value, including a raw display-form account number, is rejected `400 bad_request`; this makes the persisted auth state structurally free of raw account numbers (AS9; `account-number.md` §7, revised 2026-07-13). **First-write only** — a second register for the same `account_hash` is `409 already_registered` (replacing a verifier requires an authed flow, not in v0.1). `503 capacity` when the registered-account cap is hit. `iterations` MUST fall inside the accepted window (below); a v0.1 client registers `4096`. The server stores `StoredKey`/`ServerKey`/`Salt`/`Iterations`/`username`; it never sees the secret. |
| `POST /auth/scram/init` | `account_hash_hex`, `username`, `client_nonce` | `{"handshake_id", "combined_nonce", "salt_hex", "iterations"}` | SCRAM client-first → server-first. An unknown account, a wrong username, and a non-canonical username (anything ≠ `account_hash_hex` — the AS9 rule above) all return the **same** `401 unauthenticated` (no account-enumeration signal). `combined_nonce = client_nonce ∥ server_nonce`. `salt_hex`/`iterations` are the values stored at registration, echoed verbatim; the client MUST validate `iterations` against the accepted window (below) before spending PBKDF2 work on it. In-flight handshakes are capped + TTL-swept (`503 capacity` at the cap). |
| `POST /auth/scram/final` | `handshake_id`, `client_final` (SCRAM client-final-message), `device_id_hex`, `path` (`"password"` \| `"recovery"`) | `{"approved": bool, "token_hex"?, "server_signature_b64"}` | Verify the client proof, apply the approval gate, and either issue a per-device token (`approved: true`, `token_hex` present) or report pending (`approved: false`, no `token_hex`, `server_signature_b64` still returned so the client can verify the server). A failed proof burns the one-shot handshake and returns `401 unauthenticated` (no online-guessing reuse). |
| `GET /vault.meta` | (device-registry bootstrap) | opaque `vault.meta` bytes (`protocol.md` §9.3) | A **joining** device fetches the account's `vault.meta` **before** it has a session, to derive `root_key` from `{account# + password/phrase}` and bootstrap — necessarily so, since the SCRAM secret is derived FROM `root_key`, making an authed-only variant circular. The blob is opaque and AEAD-sealed — the server serves bytes it cannot read. **What the fetcher gets is a different question from what the server learns, and is the one that matters here:** these bytes are the complete offline password-cracking target (Argon2id salt, cost parameters, both wrapped `root_key` copies), so possession of an account number is sufficient to obtain it, from anywhere, with no device. `threat-model.md` §7 records that exposure and §5 states it in plain language; `account-number.md` §7's "treat account numbers like cash" is the handling rule it implies. Bounded as pre-auth per §5.2. |

**B2B additions the server cannot act on (normative).** An `NTV6` `vault.meta`
(`protocol.md` §9.3.2) carries an owner-wrapped group key, a group-key epoch and
an owner-double-signed roster; the server stores it as the same opaque bytes it
stores an `NTV5` blob and **cannot forge, reorder or roll back a roster or a
retirement record** (it has neither `root_key` nor the owner person key). A
retirement record (`myne.group-retirement v1|`, `protocol.md` §9.3.4) carries no
timestamp, so the server cannot order one against a removed member's package
stream. A per-person private AI profile (`profiles/<profile-id>`, `MYY5`) is an
opaque blob on the id-generic plane: the server stores it, cannot read it, and
sees only an id it cannot invert to a person. **The person-private sync plane is
not built in this branch** (Grill 4, alongside person-scoped server auth); the
server's contract above is what the plane will have to satisfy, not a description
of a shipped route.

**Accepted `iterations` window (normative).** `iterations` is the one handshake parameter the client does not choose: the server supplies it on every `/auth/scram/init`, and `/auth/register` — an unauthenticated first write — is where it is first persisted. Both sides MUST bound it.

- The accepted window is **`4096 ≤ iterations ≤ 600000`**. `4096` is the RFC 5802 floor and the value a v0.1 client registers.
- A client MUST reject an `/auth/scram/init` response whose `iterations` falls outside the window **before** computing `SaltedPassword`, and MUST treat that response as a failed handshake.
- A server MUST reject a `/auth/register` whose `iterations` falls outside the window, so a first write cannot persist a value every later handshake would refuse.

The **floor** is not a strength claim: the secret is a uniformly-random 256-bit subkey, so PBKDF2 stretching buys nothing here and a low count costs nothing (a count mismatch simply fails the handshake). The **ceiling** is the load-bearing half, and it is an **availability** bound only — a party that controls what `/auth/scram/init` reports, or that wins the unauthenticated first write, otherwise pins an arbitrary amount of client CPU on every later handshake for that account (on the web client that work runs inline in the Worker, occupying its event loop for the duration). No confidentiality or integrity property depends on it.

**Authed routes** — `Authorization: Bearer <token_hex>` (a valid, non-revoked per-device token); a missing/invalid token is `401 unauthenticated`. **A B2B member's per-vault membership token (§3.1a) is also accepted on the sync routes** (`/sync/push`, `/sync/pull`, `/sync/blob`, `/sync/blobs`, `/sync/poke`, `/account/status`), authorizing exactly the vault namespace it is bound to, so a member with no account of its own can read and write shared content. It is still refused for the `vault.meta` write (§3.4, `403 forbidden`), because the roster is owner-authored. A membership token carries no device id, so a member's pull cursor shares the zero-device slot; that costs at most a re-pull and never a wrong read. (myne-md/myne#711 task 24.)

| Route | Request fields | Success response | Semantics |
|---|---|---|---|
| `GET /auth/devices` | - | `{"devices": [{"device_id_hex", "approved", "retired"}]}` | The account's device roster (AS16). |
| `POST /auth/devices/approve` | `device_id_hex` | `{"ok": true}` | An existing approved device approves a **pending** device (the password-path gate). `404 device_not_found` for an unknown `device_id`. |
| `POST /auth/devices/revoke` | `device_id_hex` | `{"ok": true}` | Revoke the device's token (**availability** — sync stops to that device) and retire its registry record. `device_id` is **not** destroyed (SYNC-2); this is not a cryptographic lockout or a remote wipe (§4; the honest-disclosure copy is `REMOVE_DEVICE_DISCLOSURE`). |

**The device-approval gate (SYNC-9).** SCRAM only proves *account ownership*; admitting the device is a separate authorization step. The **first** device on an account (a person account included, §3.1a) and any **recovery-path** device **self-approve** (the bootstrap exception: the 24-word phrase already grants full account takeover, the accepted hole). A new **password-path** device lands **pending** and syncs nothing until an already-approved device calls `/auth/devices/approve` for it. A device that returns after approval re-runs the handshake and is issued its token.

**Channel binding (R3 — not yet channel-bound).** The mechanism is **SCRAM-SHA-256-PLUS** with channel binding = the **TLS exporter** (`tls-server-end-point`-class exporter keying material). Over the loopback-http test harness there is **no** TLS exporter, so the server's expected channel-binding data is **empty** and the client matches it; over real TLS both ends feed the exporter. Wiring the live exporter on both the Go server (`serverCbind`) and the client rustls transport is the **R3-pending** step. **Until R3 lands, no channel-binding / "-PLUS"-verified claim may be made** — the handshake authenticates the account and mints a token, but it is not yet bound to the TLS channel (documented so a reader does not over-read the `-PLUS` suffix). See the epic sync-ledger R3.

**Non-channel-bound sessions are accepted; a bound client cannot be downgraded (MYND-574).** A browser obtains neither TLS-exporter keying material nor a certificate pin — no browser exposes either to page JavaScript — so the Phase 3 web client can **never** be channel-bound (`decisions.md` 2026-07-26; `threat-model.md` A4 splits per client on exactly this). The server therefore accepts a client that authenticates with the RFC 5802 unbound gs2 form (`n,,`, no channel-binding data), under these normative rules:

- **The unbound form is accepted only where the server advertised no channel binding.** If the init response advertised `cbind: "tls-exporter"` — i.e. the application itself terminated TLS 1.3 and a real exporter exists — a client-final carrying `n,,` MUST be **refused**. Accepting it there would mean an attacker who strips the advertisement can talk a bindable client out of binding.
- **Accepting `n,,` does not weaken a bound client.** The gs2 header is part of the `c=` attribute, `c=` is part of the AuthMessage, and the AuthMessage is what the client proof MACs. Rewriting `p=tls-exporter,,` to `n,,` on the wire therefore invalidates the proof. A client that always binds cannot be downgraded; accepting the unbound form affects only clients that genuinely send it.
- **Empty channel-binding data MUST NOT be a silent fallback over terminated TLS.** Where the server terminates TLS but cannot produce an exporter — TLS below 1.3, or an exporter call that fails — it MUST refuse the handshake rather than bind to empty data. Binding a real-TLS session to nothing while the client believes it is bound is strictly worse than refusing. The empty-`serverCbind` path remains legitimate **only** where the application does not terminate TLS at all (a terminating reverse proxy, or the loopback test harness), because there the absence of a binding is the honest state and is advertised as such.
- **The refusal is indistinguishable from any other auth failure** (the same `401`), so no deployment detail leaks.
- **A per-account "bound sessions only" opt-out is reserved, not built** (MYND-577). The verification path reports which form the client used, so an account-level predicate can refuse a session without a schema change or a wire change. No field is added for it here. Two things about it are normative, because the obvious reading of both is wrong:
  - **The predicate is "a binding exists", not "the client committed to the expected header".** The verification path's `bound` result means only the latter — and where the server does not terminate TLS, both sides legitimately bind to *empty* data, so `bound` is true while no channel binding exists at all. An opt-out keyed on `bound` alone would therefore admit every session in precisely the deployment where nothing is bound. The normative predicate is **`the server had non-empty exporter material AND the client committed to it`**.
  - **It can never be a web-vs-native discriminator.** Whether a binding exists is a property of the *deployment*, not of the client: behind a terminating reverse proxy the opt-out refuses every client including the native ones, and where the server terminates TLS itself it admits every native client regardless of what any browser does. An operator who wants to refuse browser access needs a different signal.

**What "the unbound form is accepted" describes today.** No Myne client emits `n,,`. The client-side SCRAM construction is unconditional — every client, native and web, sends `p=tls-exporter,,` — so the server's bound/unbound signal reports the same value for every session that reaches it, including browsers that cannot channel-bind at all. The rules above are therefore the *server's* contract with any conforming client, and they are correct as written; what they are not is a description of an exercised code path. Making the web client actually emit `n,,` means parameterising the gs2 header on client capability (never on the server's advertisement — behind a terminating proxy that condition is true for the entire native fleet, so gating on it would flip every desktop to the unbound form as well) and is a compatibility decision, since a self-hosted server on a pre-MYND-574 build refuses `n,,` outright. Until that lands, `bound` is best read as "the client committed to the header the server expected".

**`device_revoked` — a revoked device is not an expired token (MYND-574 task 94).** Every authed route answers a bad credential with `401`, and until now it answered every kind of bad credential with the same `{"error_code": "unauthenticated"}`. Three different situations arrive that way: a token that expired, a token the server has never heard of, and a token whose **device row was revoked or retired** by `/auth/devices/revoke`. The first two are fixed by re-authenticating and say nothing about anyone's intent; the third is a **deliberate act by the account owner from another client**, and a client that cannot tell it apart cannot honour it.

The server MUST therefore answer a request whose bearer token maps to a revoked or retired device row with:

```
401 {"error_code": "device_revoked"}
```

Normative points:

- **The status stays `401`.** It is an authentication outcome, and a new status would break every existing client's error handling for no gain. What is new is the code inside the body, which is the vocabulary §3.1 already establishes (`unauthenticated`, `cursor_expired`, `blob_stale`, `head_stale`, `frozen`, `blob_reclaimed`).
- **It applies only to a token that resolves to a KNOWN, revoked device row.** A token the server cannot resolve at all stays `unauthenticated` — the server genuinely does not know whether it was revoked, expired, or never existed, and claiming otherwise would let a client act on a guess. This is also what keeps the code from becoming a device-enumeration oracle: it is emitted only to the holder of a token the server itself issued.
- **It carries no information about WHICH device or WHEN.** No `device_id`, no timestamp, no actor. The revoked device already knows its own identity, and everything else is the account roster's business, reachable through `GET /auth/devices` by a device that still has a session.
- **A client MUST NOT treat this code as a retry class.** Retrying cannot help: only re-enrolment can, and only if the account owner allows it.
- **What the client does with it is client policy, not server policy, and the two ship differently on purpose.** Desktop and mobile park and prompt to re-enrol, exactly as they already do on `unauthenticated` — the machine is the user's own, its vault directory is theirs, and erasing it on a server signal would be a destructive power nobody asked the server to have. The **web** client's storage is a cache of a sync-held vault (`decisions.md` 2026-07-26 makes sync required there), so it treats the code as terminal: lock, erase this browser's copy, and explain. The server emits one code; it does not know or care which policy is on the other end.
- **This is not a remote wipe and not a cryptographic lockout, and no copy anywhere may imply that it is.** A device that already decrypted content cannot un-decrypt it, and an attacker holding the vault file plus the password is entirely unaffected — revocation is an **availability** control (§4). `REMOVE_DEVICE_DISCLOSURE` states exactly this and remains normative.

### 3.1a Person accounts and vault membership (B2B; myne-md/myne#711)

The B2B access model (`decisions/protocol/0603`) makes server accounts **person-level**: one account per person, independent of any vault. This section is the server's half; `internal/authapi` implements it. The invite relay routes and the owner-only `vault.meta` refusal are the neighbouring sections (tasks 8 and 9 of the same feature).

**A person account is an account in the §3.1 SCRAM namespace, keyed by `person_id_hash`.** The person's server credential derives CLIENT-side from the normalized recovery phrase under the domain `"myne.v0.2 argon2id-person-server-auth|"` (plus `person_id_hash`), exactly as a vault account's derives from `root_key` under `server-auth`; the server is handed only a SCRAM verifier and never the secret. It registers and authenticates through `/auth/register`, `/auth/scram/init` and `/auth/scram/final` with `account_hash_hex = person_id_hash` and `username` the canonical lowercase hex of that same id. **There is deliberately no separate person-auth route**: the two ids are both 16 opaque bytes and the server cannot tell them apart, because it is blind to the difference. The id-typed namespace **is** the person namespace.

**A device may hold its OWN SCRAM credential on the person account** (`decisions/protocol/0735`). Beside the
account's phrase-derived verifier, an account may carry one verifier per device, installed BY a device that is
already authenticated against that account, and since `decisions/protocol/0783` also by the joining device itself
once its row is approved: `POST /auth/devices/credential` with
`{device_id_hex, username, salt_hex, iterations, stored_key_hex, server_key_hex}`. The account is taken from the
session and never from the body, so a device installs only into its own account; and the username is NOT
caller-chosen: it is `dev:<device_id_hex>`. The `dev:` prefix is what keeps the two namespaces apart, since an
account id and a device id are both 16 bytes and both encode to 32 lowercase hex characters. A credential
authenticates through the SAME `/auth/scram/init` and `/auth/scram/final` pair, naming that username; `init`
serves the DEVICE's salt rather than the account's. An unknown account, a wrong username and a non-canonical
username are one `401`, and a device credential that is not installed answers that same `401`, so nothing here
leaks whether a device id is installed. A repeat install of the SAME verifier is `200 {existing: true}` and a
DIFFERENT verifier for an installed device is `409 already_installed`, so two devices admitting the same newcomer
at once cannot race into two credentials for one id.

**The install and the approval are one act, and revocation has to reach the verifier.** The route registers the
device pending and approves it in the same call, because a credential nobody approved is a device that
authenticates and then syncs nothing while an approval of a device that cannot authenticate is a promise. The
operator gates (`frozen`, the device cap) apply exactly as they do at `/auth/scram/final`, so neither can be
reached by pre-approving around them.

**The joining device may be the caller, and that installs nothing before the gate.** In the shipped flow
(`decisions/protocol/0783`) the device that will hold the credential is the one that calls this route, under the
account session its phrase derived, AFTER an already-approved device of the account approved its row. That is not
a self-approval and it is not a new authority: a device whose row is pending is issued no token by `/auth/scram/final`,
so it cannot reach an authed route at all, and what admits it is the other device's approval of a registry record.
The route's own approval step is idempotent for a row that is already approved, which is why the caller does not
have to know which state it is in. What the caller gains is PERSISTENCE rather than reach — the reachability change
`0735` recorded and `threat-model.md` §7 states — and the sequence is pinned end to end in
`core/src/plugins/sync/sim.rs`. `POST /auth/devices/revoke` now deletes the device's verifier as well as
retiring its registry row: retiring the row refuses the TOKEN, and an unauthenticated device would otherwise run
the handshake again and mint a new one, which would make "removed" mean "sign in again".

**The out-of-band exchange, and the check that makes it safe.** The joining device shows
`MYNE-DEVICE-1:<person_id_hex>:<device_id_hex>:<ed_pk_hex>:<mldsa_vk_hex>:<salt_hex>:<iterations>:<stored_key_hex>:<server_key_hex>`
(empty `ed_pk`/`mldsa_vk` on a platform with no device-key rung). The code carries a CREDENTIAL-EQUIVALENT
verifier, so it is handled as a one-time credential: the admitting device shows a short authentication string
derived over the whole code (class `"myne.device-admission-sas v1|"`, eight hex characters, displayed `XXXX-XXXX`)
for a human to compare between the two screens, and the write is bound to the string the user confirmed, so the
code cannot change between display and signature. The verifier is one-way over the joining device's secret, so
the admitting device forwards a value it cannot authenticate with. **No client ships this exchange since
`decisions/protocol/0764`, and `0783` does not reinstate it**: the shipped join installs the verifier from the
device that owns it, so no code and no SAS travels, and the one human comparison is the vault-head fingerprint
eye-compare `threat-model.md` §7 records. This paragraph describes the codec, which stays; it is not a
description of a surface.

**The device-approval gate governs a person account unchanged (member-devices).** A person account is an account in the §3.1 namespace, so its devices are admitted by the §3.1 gate (SYNC-9) and by nothing else: the **first** device on the person account and any **recovery-path** device self-approve, and a **password-path** device lands pending until an already-approved device of that same account calls `/auth/devices/approve` (§3.1). `path` selects the gate and changes no cryptographic input (§3.1), and because the server cannot tell a person id from a vault id it cannot verify the declaration, so **`path` is a client posture rather than an enforced rule**. Two shipped paths use it differently, deliberately. A person setup that supplies an existing phrase (the recovery-in-place path) declares `"recovery"` and self-approves. A device being ADDED to an account by a scanned code (`person_join_device_from_host`) declares `"password"`, so it lands pending until an already-approved device of that account calls `/auth/devices/approve`; the "no releaser" dead end is the FIRST-device case only, and it is why the join path never takes the recovery gate. A client is free to declare `"recovery"` instead, which is why `threat-model.md` §5 states the bound as "the phrase alone is enough": the gate is what an honest client honours, not what the server can demand. The exception grants the person plane no authority a vault account lacks, because the phrase is full account takeover on both (the accepted hole §3.1 records).

**A person session is a sync authorization class (myne-md/myne#911 task 7).** A person authenticates exactly as §3.1 says, on its person account, and the resulting device token is the **person token**: the single credential a client needs, because it addresses a vault with an `?account=<account_number_hash>` query parameter instead of holding one token per vault. Authorization is per request: the server MUST resolve the parameter against the membership table and allow the request only when the caller is bound to that vault (`403 forbidden` otherwise, never a silent fall back to the caller's own namespace and never a `404` that distinguishes "unknown vault" from "not yours"). A request without the parameter keeps the pre-existing behaviour exactly, so a vault device token and a per-vault membership token are unaffected. What the server learns is unchanged: the same person-to-vault mapping the membership table already holds, read on every request rather than once at issuance.

**A membership token names the device it was issued to (myne-md/myne#911 task 9).** A per-vault membership token carries the `device_id` of the device it was minted for, and that attribution is checked on every membership path rather than once at issuance. When the device is revoked, the tokens it held are refused with `device_revoked` (not with a generic unauthorized and not by falling through to an empty binding), so revocation reaches the credential the device actually holds. That is what makes one revocation remove a device from every vault instead of one revocation per vault: the account-level device record is what refuses, and the per-vault bindings never get consulted. Retiring the device also reports its held tokens to the live-awareness relay, which closes their open streams at once (§3.5); a post-revocation RECONNECT on the awareness route is not refused by the registry today, which is recorded as owed rather than claimed. A **joining** device learns which vaults to expect from `GET /b2b/vaults` (the discovery row below): it lists the account's bindings and materialises each vault's frame, without any key, corpus or password, and the first unlock of each vault is still that vault's own password.

**Publishing binds the owner.** `PUT /vault.meta?account=<hash>` under a person session is the act that makes a device-local vault a server vault, so it is also the act that records its owner: a vault with no owner binding gains this person as owner (owner-at-first-write, the same transition §3.1a gives `POST /b2b/vaults/{account_hash}/members`), a vault owned by this person is written, and a vault owned by anyone else is `403 forbidden` before any bytes are stored. This is what lets an offline-created vault publish without a vault account of its own, and it is why the client never has to bind an owner in a second round trip.

**Vault discovery.** `GET /b2b/vaults` answers, for the calling account, the bindings that account holds. It authorizes nothing by itself: each vault it lists is authorized again on the request that syncs it, so a stale answer cannot outlive a removal.

**The authed `vault.meta` fetch resolves the selector too.** `GET /vault.meta?account=<hash>` under a session is served from THAT vault's namespace when the caller is bound to it, and refused `403` otherwise. It must not fall back to the session's own namespace: a person namespace holds no `vault.meta`, so the fallback answers `404` on every poll, a password change made on one device never reaches another, and a device whose local frame is dirty pushes its stale copy over the server's. That is a silent credential rollback, and it is the reason the arm goes through the same resolver as `/sync/*`.

**Account erasure enumerates what the account owns.** Deleting a person account removes the account's own namespace, every vault it owns ALONE (its blobs, its attachments, its policy row), its binding in every vault it shares, the per-vault tokens issued to it, and its sealed profile in each of those vaults. A vault the erased account SHARES is deliberately left standing, with its bytes and its other members' data, and loses only this person's binding: the remaining members' content is not the erased account's to destroy, and the vault is left owner-less rather than silently deleted. The order is remove-then-forget, so a failure part-way leaves a retryable state rather than an orphaned owner, and it has to be complete because the person id is derived from the phrase: a binding that survives deletion is resurrected by the next registration of the same phrase.

| Route | Auth | Request fields | Success response | Semantics |
|---|---|---|---|---|
| `GET /b2b/vaults` | any authenticated session | - | `{"vaults": [{"account_hash_hex", "role"}]}` | The bindings this ACCOUNT holds, owner first then by vault id. For a person that is its vault list; for a vault's own device token it is normally empty, which is the honest answer rather than an error. `401` for an unknown bearer. (myne-md/myne#911 task 7.) |

**Access to a vault is a membership binding, not a key.** The server keeps a person↔vault table; a binding carries a role (owner or member) and issues a **per-vault bearer token** scoped to exactly that `(person, vault)`. The binding is an **availability** control: the server reads no roster plaintext, no fingerprint and no name, verifies no owner signature, and holds no public key. What it does learn is the pseudonymous person-to-vault mapping, which is the collaboration social graph already accepted by `decisions.md` 0459 (`threat-model.md` §7(4)).

**Authorization on the membership routes.** Three credentials are accepted, and they are
not interchangeable. The owner is bound by the **vault's own device session**: the
owner's device is enrolled on the vault account, whose `account_number_hash` is the
vault's public id and storage namespace (§2.1). That is "owner at registration" and it
is first-write only. Every later member-management call is authorized by the **owner's
per-vault membership token** (the same credential the owner-only `vault.meta` refusal
consumes). And on a vault **born under a person identity** (`NTV7`, `protocol.md`
§9.3.5) neither of those exists, because such a vault is published under a random
namespace and never enrols under an account. There the owner's own **person session**
is accepted: it may bind a member, and it may re-mint the owner's own binding token, but
it may not CREATE the owner binding (that is the publish act's, `PUT /vault.meta?account=`)
and it may not make a second person the owner. The singleton owner is fixed at
registration and cannot be re-assigned or removed through these routes.

| Route | Auth | Request fields | Success response | Semantics |
|---|---|---|---|---|
| `POST /b2b/vaults/{selector}/members` | vault device token (owner registration) **or** the owner's per-vault token (add member) **or** the owner's person session on an `NTV7` vault | `person_id_hex`, `role` (`"owner"` \| `"member"`) | `{"person_id_hex", "role", "token_hex"}` | Create a binding and issue its per-vault token. `{selector}` is the 16-byte vault binding at offset 6 of `vault.meta`: the account-number hash on a vault enrolled under an account, the vault's random namespace on one born under an identity (`protocol.md` §9.3, §10.3.1). With the **vault device token**, only `role = "owner"` is accepted and the vault must have no owner yet (`409 already_owned` otherwise). With the **owner per-vault token**, only `role = "member"` is accepted (`400` for owner) and the token must be the owner of THIS vault (`403` otherwise); a re-bind is `409 already_bound`. With the **person session**, the caller must already be recorded as this vault's OWNER in the membership table (`403` otherwise, which also covers a member session), `role = "member"` binds a member, and `role = "owner"` is accepted only for the caller's own person id (a re-mint, not a claim). |
| `DELETE /b2b/vaults/{account_hash}/members/{person_id}` | owner's per-vault token | (none) | `{"ok": true}` | Delete one person's binding to one vault and revoke every outstanding token for that `(person, vault)`. `403` when the caller is not this vault's owner or when the target is the owner (the owner leaves only by deleting the vault); `404 not_found` when the person is not bound. A person's other vaults and their tokens are untouched. Revoking the token also closes that member's open awareness streams at once (§3.5). |

Normative points:

- **The per-vault token is bound to `(person, vault)` and to nothing else.** A token minted for one vault MUST NOT authorize another, and revocation MUST be per-binding: one `DELETE` stops one vault's access for one person, never the person's other vaults.
- **Only the vault's own session may register its owner, and only once.** A second owner for the vault is `409 already_owned`; neither an owner token nor a person session may promote anyone to owner, and a person session may re-mint only its own binding.
- **`person_id_hex` is the lowercase hex of the 16-byte `person_id_hash`.** A malformed value is `400 bad_request`.
- **The server verifies nothing about the vault's contents on these routes.** It stores no roster, no retirement record and no `MYY5` profile here; those ride the opaque blob plane (task 9 and the vault-scoped profile route), unchanged and unparsed.
- **Self-host and hosted run the same binary, the same handler and the same route set.** These routes are registered unconditionally; no operator configuration adds, removes or reorders them. There is no operator override of a membership decision.

**Sealed invite relay (the same feature, task 8).** An invite is delivered through the server as a **blind postbox**: the owner's authenticated session posts it addressed to the recipient's person account, the server stores it opaquely and releases it to that account on claim, then marks it claimed. The outer routing frame carries **only** the recipient person id, the vault id and the sealed payload; the account hashes, fingerprints and public halves the old frame carried in the clear live INSIDE the sealed payload now, so neither the server nor the vault's owner can read a member's fingerprint from the relay (`decisions/protocol/0603`, Grill 4 Q10). An invite is a slot, not a queue: it retains its sealed payload, the `claimed` flag records that it was claimed at least once, and a re-claim by the **same** recipient is idempotent only while that person's binding to the vault still stands, returning the stored payload again and minting a fresh token so a member's second device can obtain its own per-vault access without the owner (`member-devices`); a recipient the owner has since removed, and every other caller, sees the same `404` an unknown id gives.

| Route | Auth | Request fields | Success response | Semantics |
|---|---|---|---|---|
| `POST /b2b/invites` | **owner's per-vault token** | `recipient_person_id_hex`, `payload_b64` | `{"invite_id_hex", "vault_account_hash_hex", "recipient_person_id_hex"}` | Store a sealed invite addressed to the recipient for the token's vault. The vault comes from the token, not the path, so a member token is refused (`403`) and an unknown bearer is `401`. A payload over the cap is `400`. |
| `GET /b2b/invites` | **recipient's person session** | - | `{"invites": [{"invite_id_hex", "vault_account_hash_hex", "claimed"}]}` | List the invites addressed to the caller, unclaimed and claimed alike. No payload is returned here; the claim is what releases it. |
| `POST /b2b/invites/{invite_id}/claim` | **recipient's person session** | - | `{"payload_b64", "vault_account_hash_hex", "token_hex"}` | Release the invite, without consuming it: return the sealed payload byte-identically, create the member↔vault binding, and issue the claiming person's per-vault token (the member-facing issuance path; the owner-side bind route is the other). A wrong-account claim and an unknown id are the **same `404`**, so one person cannot confirm another's invite exists. A claim consumes nothing: the payload is retained for the invite's lifetime, so a later claim by the **same** recipient whose binding to the vault still stands is idempotent and returns the same `{"payload_b64", "vault_account_hash_hex", "token_hex"}` shape with a freshly minted token (`member-devices`); a recipient the owner has since removed is refused with the same `404`. |
| `DELETE /b2b/invites/{invite_id}` | **recipient's person session** | - | `{"invite_id_hex", "vault_account_hash_hex"}` | Decline the invitation: the sealed payload is **dropped**, so the slot can never be claimed and the claim route answers the same `404` an unknown id gives. A payload-free tombstone (the two ids and the `declined` flag) stays so the owner's view can tell "declined" from "not accepted yet". A wrong account, an unknown id and a repeat decline by the same recipient are one `404`/`200` pair and not an oracle; an already-**claimed** invite is `409 already_claimed`, because ending that membership is the owner's removal. (myne-md/myne#911 follow-up, `decisions/protocol/0732`.) |
| `GET /b2b/vaults/{account_hash}/invites` | **owner's per-vault token** | - | `{"invites": [{"invite_id_hex", "recipient_person_id_hex", "claimed", "declined"}]}` | The owner-side view: the invitations the owner sent for the token's vault, with the recipient person id it supplied and the two terminal states. A member token is `403`; no payload is returned. (myne-md/myne#711 task 11; `declined` is the `0732` follow-up.) |
| `PUT /b2b/vaults/{account_hash}/profiles/{profile_id}` | **person's own account session** + a membership binding to the vault | opaque `MYY5` bytes | `{"ok": true}` | Store one person's private AI profile in a vault-scoped namespace SEPARATE from the shared group manifest. `403` when the person is not bound to the vault, `401` for an unknown bearer, `400` when the body is empty or over-cap. The server records the writing account so member removal can schedule deletion after the retention grace; it reads none of the bytes. (myne-md/myne#711 task 16, `decisions/protocol/0608`.) |
| `GET /b2b/vaults/{account_hash}/profiles/{profile_id}` | same | - | opaque `MYY5` bytes | Return the stored profile bytes byte-identically, or `404 not_found`. |

Normative points:

- **The server reads no fingerprint, public half or group key.** The stored frame is the recipient id, the vault id and opaque payload bytes; nothing in the relay parses, interprets or reorders the payload.
- **A recipient must already hold a person account**, which is why identity setup registers one before any vault exists; the relay is addressed by `person_id_hash`.
- **The relay is not a second access authority.** Claiming creates a membership binding through the same table §3.1a describes; a person with no invite cannot bind themselves, and a recipient can hold at most one binding per vault.
- **A decline deletes the payload rather than hiding the row.** The recipient is the only party that may decline, and the act leaves a tombstone carrying no sealed bytes, no fingerprint and no public half, so the retention it adds is one routing row the relay already had. The alternative, a client-side hide, would have left the owner reading "not accepted yet" forever, which is the state this route exists to end (`decisions/protocol/0732`).
- **A re-claim is idempotent only for the invite's own recipient whose binding still stands.** A `POST /b2b/invites/{invite_id}/claim` by the person the invite was addressed to returns the stored sealed payload and mints a fresh per-vault token only while that person is still a member of the invite's vault; the binding is checked before the token is minted, so the response can never create a binding that is absent. A recipient the owner has removed in the meantime is refused with the **same `404 not_found`** a wrong recipient or an unknown id gets, so the endpoint is not an oracle and the rule is not a route back into a vault the owner removed you from. The `claimed` flag keeps recording "claimed at least once" for the owner's §3.1a view and does not gate the response, and retaining the payload adds no server-side retention the relay did not already carry (`internal/relay` stores the whole invite and never deletes it).

### 3.1b Cross-origin access for the web client (CORS; MYND-574)

The Phase 3 web client runs on **its own origin** (`decisions.md` 2026-07-26 — OPFS is origin-scoped, so the app may not share an origin with anything else), which makes every call it issues to the sync origin cross-origin. Until this section the server assumed a native caller and answered no preflight, so a browser could not complete even the first step of the handshake.

The server MUST therefore answer CORS, and MUST do so under the following normative constraints.

**Configured allowlist, never a wildcard.** Allowed origins are an operator-configured, exact-match list (`MYNE_ALLOWED_ORIGINS`, comma-separated in the reference implementation). `*` MUST NOT be honoured: it cannot be combined with credentialed requests, and a wildcard turns a configuration typo into an edge any page on the internet may address. An **empty list disables CORS entirely**, which is the correct state for a deployment with no browser client and preserves the pre-web behaviour exactly. Matching is exact — no scheme-insensitivity, no trailing-slash tolerance, no subdomain wildcards: an origin is a precise string in the browser's model, and a normalising comparison is how an allowlist ends up matching something the operator did not intend.

**Both deployment modes, by configuration.** The hosted app origin is not privileged: a self-hoster configures their own. This is TB5 applied to the browser edge — the same protocol and the same security model, a different operator.

**Every route the browser reaches, including the pre-auth ones.** The policy MUST cover the session-less routes of §3.1 (`POST /auth/register`, `POST /auth/scram/init`, `POST /auth/scram/final`, `GET /vault.meta`) as well as the authed surface (`/auth/devices`, `/auth/devices/approve`, `/auth/devices/revoke`, `/sync/push`, `/sync/pull`, `/sync/blob`, `/sync/blobs`, `/sync/poke`, `/sync/awareness` (GET and POST), `/account/status`, and `HEAD|GET|PUT /attachments/{id}` of §3.2). `POST /auth/scram/init` carries a JSON body and is therefore **not** a CORS-simple request: it is preflighted. A policy scoped to "authed routes" would leave the browser's **first** call unanswered, and authentication would fail before any token existed.

**Preflight is answered by the policy, not by a route handler.** An `OPTIONS` request carrying `Access-Control-Request-Method` MUST be answered directly with the allowed methods, allowed request headers and a max-age, and MUST NOT reach a route handler — several routes implement no `OPTIONS` at all, and a `404`/`405` reads to the browser as an unexplained denial. A preflight from a **disallowed** origin MUST be refused with no CORS headers at all.

**`Access-Control-Allow-Headers` MUST include `Authorization`, `Content-Type` and `Range`** — the per-device bearer token, the JSON bodies, and the resumable attachment reads of §3.2.

**`Access-Control-Expose-Headers` MUST include `X-Uploaded-Length`, `X-Complete`, `Content-Range` and `Accept-Ranges`.** None of these is CORS-safelisted, so without the header a cross-origin reader sees them as *absent* rather than as an error: the §3.2 resumable-upload probe would read a half-transferred attachment as zero bytes uploaded and restart from the beginning, and a Range `GET` would be indistinguishable from an unranged one. This is a correctness requirement, not a convenience.

**A response carrying a reflected origin MUST `Vary: Origin`**, or a shared cache may serve one origin's response to another.

**Non-browser clients are unaffected.** A request with no `Origin` header — every native client — MUST proceed exactly as before. Enforcement for browsers happens in the browser: a disallowed origin simply receives no `Access-Control-Allow-Origin` and the page is denied the response. Refusing such requests server-side would break every native caller instead.

**Placement.** The policy is outermost middleware, directly inside the no-IP layer (§5.2 / AS14) and outside everything else. It MUST NOT be positioned outside the no-IP layer: CORS reflects a client-supplied header and must never sit where it could observe a source IP.

### 3.2 Attachment byte-transport (`/attachments/{id}`; MYND-423/468)

**The vault selector applies here too (normative; myne-md/myne#911).** A
**person session** carries no vault, so it names the vault whose bytes it is
moving with the same `?account=<account_number_hash>` parameter the sync routes
take (§3.1a), and the server MUST authorize it against the membership table
before touching the store: bound means the bytes live in that vault's namespace,
unbound is `403 forbidden`, malformed is `400 bad_request`. A request without the
parameter keeps the pre-change behaviour exactly (the session's own account), so
a vault device token and a per-vault membership token are unaffected. Without
this, a person-born vault's attachment uploads landed in the PERSON's own
namespace, where no other device could ever fetch them, because every attachment
request is scoped to the account that stored the bytes.

Attachment ciphertext does not travel inline in `push` (a 64 MiB blob in a one-shot base64-JSON body has no resume story). It moves over three dedicated, **session-bound** routes keyed by the full lowercase-hex 32-byte `attachment-id` (`protocol.md` §9.9). The server stores the bytes as an opaque unit in the vault namespace (§2.1); it never parses them.

| Route | Request | Success response | Semantics |
|---|---|---|---|
| `HEAD /attachments/{id}` | - | `200` + `X-Uploaded-Length: <n>`, `X-Complete: true\|false` | Resume/dedup probe: how many bytes the server holds for this id, and whether the upload is complete. `404` for an unknown **or deleted** id (deleted-is-absent, non-distinguishing; `sync-protocol.md` §11.4). |
| `PUT /attachments/{id}?offset=N&total=M` | raw ciphertext chunk (`application/octet-stream`) | `200` + `X-Uploaded-Length` | **Strict-sequential resumable upload**: `offset` MUST equal the server's current uploaded length (else `409` — the client re-probes with `HEAD` and resumes from the real offset); `total` is the declared final ciphertext length, checked against the 64 MiB + 32 cap (`413`) and — at `offset=0` — against the **unified AS17 quota** (§5.1) and the **per-vault attachment-id ceiling** (`507`). The upload is complete when the stored length reaches `total`. A `PUT` to a previously-deleted id restarts it as a fresh upload (re-add; `sync-protocol.md` §11.4 rule 4). |
| `GET /attachments/{id}` | optional single `Range: bytes=start-end` | `200` (whole blob) / `206` (the range) | Download with resume. Multi-range is rejected (`400`); an unsatisfiable range is `416`; unknown/deleted id is `404`. |

Normative rules:

- **The AEAD unit is never chunked.** An `MYA1` blob is one atomic whole-file AEAD+CTX unit (`protocol.md` §9.9); `PUT`/`GET` offsets and ranges slice **opaque transport bytes only**. The client verifies the whole-blob tag after reassembly and discards the blob on failure — the CCS-2024 unauthenticated-chunking class is structurally excluded, and the server can corrupt nothing without detection.
- **All three routes are authenticated** (Bearer per-device token, §3.1) and covered by the **same per-account rate-limit** as push/pull (§5.2) — the attachment path is not a second, uncounted budget (the 2026-07-03 AS17 unification, `decisions.md`).
- **Quota reserves on declaration.** The `offset=0` check counts `total` against the account's unified ciphertext ceiling (blob bytes + attachment bytes, one number); the per-vault id ceiling counts **incomplete uploads too** (a half-uploaded 64 MiB body is the real resource).
- **Deletion has no route here.** The lifecycle signal is the push tombstone (`sync-protocol.md` §11.4); on receiving it the server marks the body deleted (absent to `HEAD`/`GET`), and physically reclaims it — body, partial state, id-slot, quota bytes — when horizon-GC reclaims the tombstone record (§11.2 ack rule; `MYNE_EXTENDED_RETENTION` keeps bodies exactly as it keeps note ciphertext).

### 3.3 Ciphertext fetch (`/sync/blob`, `/sync/blobs`; myne-md/myne#240)

A pull returns per-blob sync-metas, not bodies (§8.1 of `sync-protocol.md`), so the client decides from `content_nonce` which ciphertexts it actually needs and fetches those. Two routes serve them — one blob per request, or up to `MaxBlobFetchIDs` in one request. Both are **session-bound**, both relay opaque bytes the server cannot read, and both are covered by the same per-account rate-limit as push/pull (§5.2). Neither consults the frozen flag: a frozen account's reads are never refused (§7.2, "frozen is minimal").

| Route | Request | Success response | Semantics |
|---|---|---|---|
| `GET /sync/blob?id=<hex>` | - | `200` + `{ciphertext_b64, version}` | One blob. `410` `blob_reclaimed` for a Layer-2 reclaimed record, `404` `not_found` for an unknown id, `400` for a malformed one. |
| `POST /sync/blobs` | `{"blob_ids_hex": ["<hex>", …]}` | `200` + `{blobs: [{blob_id_hex, ciphertext_b64}], omitted: [{blob_id_hex, error_code}]}` | Many blobs. The response accounts for a **prefix** of the request in order (see below). Over `MaxBlobFetchIDs` ids → `413` `too_large`; any malformed id → `400` for the whole request; an empty list is a `200` with two empty arrays. |

Normative rules:

- **Absent, never empty — restated for the batch shape.** A reclaimed or unknown id MUST appear in `omitted` with `blob_reclaimed` / `not_found` and MUST NOT appear in `blobs`. **A `blobs` entry with an empty `ciphertext_b64` is forbidden.** This is `sync-protocol.md` §11.3 "Reclaimed-record visibility" applied to a second read surface: the rule was written for a route that returns one blob, and a route that returns many has a new way to violate it.
- **Every id the response reaches is accounted for exactly once**, and the two arrays are disjoint. An id in **neither** array was **not served** — the client MUST keep it queued and re-request it, and MUST NOT synthesize a body for it. A lookup that defaults a missing key to empty bytes is the same destructive shape as the empty-`200` this rule exists to prevent, arrived at through a different door.
- **The response is a prefix, and the server MUST account for at least the first requested id.** That obligation is what lets a client detect a response it cannot make progress on, instead of re-requesting the same window forever.
- **The count cap refuses; the byte cap truncates.** They differ deliberately. A client knows its own id count exactly, so exceeding `MaxBlobFetchIDs` is a client bug and gets a loud `413` — unlike the pull page size of §3, which *clamps*, because a clamped page still advances a cursor and therefore still makes progress. The byte budget is the opposite case: the client windows on the advisory `size` from the pull meta, which is server-advertised and untrusted and which an older server omits entirely, so it cannot always plan correctly and the server serves what fits. A single blob larger than the whole budget MUST still be served alone, or the client's window can never shrink below one and it loops.
- **The server MUST NOT emit a response larger than a conforming client will read.** A body past that ceiling is not a slow path but a wedge: the next cycle plans the identical window and fails identically forever.
- **Per-account namespacing is per-id.** An id belonging to another account is `not_found` — never `blob_reclaimed`, which would confirm the id exists somewhere, and never a whole-batch `403`, which a client could bisect.
- **An unreadable body is a per-id omission** (`internal`), not a refusal of the whole response. A refusal poisons the window, which fails the client's cycle, which means one corrupt record wedges that account's sync permanently; as an omission the client skips the record without adopting a baseline and the next cycle re-lists it.
- **Absent route is a legitimate client state.** A server predating this section answers `404`, or `405` behind a proxy that knows the `/sync` prefix but not the method; a client MUST fall back to `GET /sync/blob` for the remainder of that sync attempt. A **transport-level** failure is NOT that signal and MUST NOT trigger the fallback — it is an outage, and treating it as a missing route would mask one as a slow success.

### 3.4 Owner-only `vault.meta` write and namespace retirement (B2B; myne-md/myne#711)

Two server-side B2B enforcements ride the sync plane and share one authority: the owner's per-vault membership token (§3.1a). The server verifies **no signature and holds no public key** in either; the owner's authenticated session is the authority, and the owner-double-signed retirement record remains the PEER-verifiable artefact that travels the opaque blob plane (Grill 4 Q13).

**`vault.meta` write gate.** For a vault that has an owner membership binding (a B2B vault), `PUT /vault.meta` MUST carry the **owner's per-vault token**: a member token is `403 forbidden`, and a device token is `403 owner_required`, because a device token carries no role and the roster is owner-authored. A vault with **no** owner binding (a single-user vault) keeps the pre-B2B device-token path unchanged, so the gate landing breaks no existing vault. The server learns nothing new: `vault.meta` stays opaque.

| Route | Auth | Request fields | Success response | Semantics |
|---|---|---|---|---|
| `POST /b2b/vaults/{account_hash}/retire` | **owner's per-vault token** for that vault | `retired_epoch`, `replacement_epoch`, `namespace_kind` (`"group-key"` \| `"items-key"`), `namespace_id_hex`, `reclaim_sync_ids_hex` | `{"ok": true}` | Record a namespace retirement for the vault. `replacement_epoch` MUST equal `retired_epoch + 1` and `retired_epoch` MUST be non-zero (the record's own invariant). A `group-key` retirement's `namespace_id` MUST equal the vault's `account_hash`; an `items-key` retirement may name any id. A missing/member/unknown bearer is `401`/`403`. |

Normative server behaviour after a retirement:

- **A write to a retired sync id is refused** (`409 retired`), permanently, so a stale device cannot resurrect a namespace the owner rotated away from.
- **The retired blobs are reclaimed only after a bounded grace** (a recovery window, default 7 days, operator-adjustable). Reclamation never runs before the window elapses. The server may always delay or withhold reclamation — that is a storage errand, not a guarantee, and a client MUST NOT treat a still-present old blob as evidence the retirement did not happen.
- **No retirement recalls data.** It prevents FUTURE access once the rotation propagates; it cannot delete content already synced or copied. The server holds no key and deletes only what it stored.
- **The server's retirement fields are provenance, not verification.** The epochs and namespace kind/id are recorded so an operator/audit read sees what was retired; enforcement keys on the sync ids the owner named, which is what a write can be matched against.

### 3.4a Group-rotation package delivery (`/b2b/vaults/{account_hash}/group-packages/{person_id}`; `collab-b2b-sessions`, extending `decisions/protocol/0603` + `0607`)

When an owner removes a member, the vault's group key rotates (the local rotation is `b2b-member-sync`; its live-session consequences are `collab-b2b-sessions`). Each REMAINING member must receive the new group key, wrapped to its own person public half and signed by the owner, at the new epoch; the removed member gets none. The server is a **blind, latest-per-recipient postbox** for that one artefact.

| Route | Auth | Request fields | Success response | Semantics |
|---|---|---|---|---|
| `PUT /b2b/vaults/{account_hash}/group-packages/{person_id}` | **owner's per-vault token** for that vault | `{"epoch": <u64>, "package_b64": "<opaque owner-signed bytes>"}` | `{"ok": true}` | Store one remaining member's rotation package for the vault. A member token or a token for another vault is `403`; an unknown bearer is `401`; an empty, malformed or over-cap (64 KiB) package is `400`. The vault comes from the token, not the path. |
| `GET /b2b/vaults/{account_hash}/group-packages/{person_id}` | **recipient's own account session** + a membership binding to the vault | (none) | `{"epoch": <u64>, "package_b64": "<opaque owner-signed bytes>"}` | Return the recipient's OWN current package byte-identically. `{person_id}` MUST be the caller's own; a different person id, an unbound caller or an absent package is the same `404 not_found`, so the route cannot address another member's package. |

Normative rules:

- **The payload is opaque; `epoch` is the only cleartext field.** The server never decodes `package_b64` and holds no key. The package is an owner-double-signed group-key wrap (`myne.group-package v1|`, `protocol.md` §9.3.3) whose verification is entirely client-side against the owner public half PINNED at accept; the server records the epoch for retention order only.
- **Latest-per-recipient, and NOT one-shot consumed.** A write at an epoch not greater than the stored one is ignored, so a replayed or stale write cannot regress a caught-up recipient. Unlike an invite, a package stays retrievable until the recipient's next sync catches up; it is never marked claimed.
- **The removed member is never a recipient.** The rotation produces a package only for each remaining live member, so the recipient set is exactly the post-removal roster minus the removed row.
- **RAM-only, IP-free, unlogged.** Like the invite relay, the store holds nothing but the opaque bytes and does not survive a restart; no package byte is written to a log.

### 3.5 Live-awareness relay (`/sync/awareness`; `live-collab`, `decisions/sync/0655`)

Real-time collaboration adds a live plane beside the poke: a client publishes its own **opaque, end-to-end-sealed** awareness frames (a cursor/selection/presence update, or an opaque Automerge change delta) and receives other clients' frames, over one `GET`/`POST /sync/awareness` pair. The relay is the fifth structural operation of §1.2 and it reads **no frame byte**.

| Route | Request | Success response | Semantics |
|---|---|---|---|
| `GET /sync/awareness?rooms=<hex,hex,...>` | initial room set (optional; comma-separated lowercase-hex room ids) | `200` + `text/event-stream` | Open the downstream SSE stream, subscribed to the declared room set. The server writes each frame it fans out to this connection in the `{room_id_hex, frame_b64}` envelope; it forwards only frames whose room id is in the connection's **current** set. |
| `POST /sync/awareness` | `{"rooms_subscribe":[…], "rooms_unsubscribe":[…], "frames":[{"room_id_hex":"…","frame_b64":"…"}, …]}` (all fields optional) | `{"ok": true}` | A batch publish and/or a subscription update on the **same** stream (no teardown). The three lists are independent: a POST may publish frames, change the subscribed set, or both. |

Normative rules:

- **The frame is opaque; the room id is an exact-match routing key.** The server never decodes `frame_b64`, never parses `room_id_hex` beyond an exact 16-byte equality test, and holds no key. A frame carries no note id, no plaintext and no person id the server can read.
- **Fan-out is device-agnostic and includes the publisher.** A frame published in a room reaches every subscriber of that room in the vault namespace, the publishing device included; the client drops its own echo. Fan-out keys on the resolved vault namespace (§3.1a), so an owner and every member share one relay.
- **RAM-only, and never logged.** The relay keeps no persistent per-room record and writes nothing beyond the standard IP-free access line; the server may observe that a vault has live rooms and how active each is (a `threat-model.md` §7, A13 accepted limit, asset AS24), never which notes or what is typed.
- **Caps and refusal classes.** A frame over `MaxAwarenessFrameSize` (64 KiB) or a batch over `MaxAwarenessFramesPerPost` (16) is `413 too_large`; a malformed envelope is `400 bad_request`; a subscriber at the per-vault cap or an over-rate POST is `429 rate`. The publisher's own POST carries the frames plus any subscription change.
- **A separate, account-keyed rate sub-bucket.** Awareness POSTs spend a budget **separate** from the push/pull/attachment bucket (§5.2), keyed on `account_number_hash`, never IP, so awareness can neither starve sync nor be starved by it. Exhausting the awareness bucket does not refuse a push.
- **A larger, configurable per-vault subscriber cap.** The poke's single-user cap of 8 (an OOM/fd bound) is too small for a shared vault; awareness uses its own default (64) as an operator knob, still capped to bound memory and fds.
- **Bounded drop-oldest, not blocking.** A subscriber that cannot keep up drops its **oldest** queued frame and keeps the newest, rather than blocking the publisher or being disconnected: cursor/selection frames are self-contained snapshots, and a dropped content frame is caught up by the durable blob plane (`sync-protocol.md` §10.1).
- **Immediate termination on member removal.** When a member is removed (`DELETE /b2b/vaults/{account_hash}/members/{person_id}`, §3.1a/§3.4), the relay closes every open awareness stream authenticated with the removed member's **revoked token**, so future access ends at once rather than at the next reconnect. The relay keys streams on the **authenticating token**, not on a person or device, so it stays person-agnostic.
- **Auth.** Both routes accept a per-device token (§3.1) and, on device-token failure, a per-vault membership token (§3.1a), exactly as `/sync/poke` does; fan-out keys on the resolved vault namespace. A non-flushable writer fails closed with `500`, never a silent hang.
- **The poke stays untouched.** Awareness is a **separate** stream; the `GET /sync/poke` channel remains literally zero-payload (§3).

## 4. Device registry (AS16)

The server keeps a **per-account device registry** — one record per enrolled device — because revocation requires the server to know which devices exist (AS16; this is the one place device count is necessarily server-visible). Each record is keyed by the **client-generated `device_id`** (the version-vector actor, `sync-protocol.md` §4.1), which is **distinct from the device's secret per-device token**: the `device_id` is permanent, non-secret history; the token is the revocable bearer credential.

- **Enrollment** registers a new `device_id` (subject to the device-approval gate — a server authz concern; the client ceremony is MYND-425).
- **Revocation** = invalidating the per-device token: an **availability** control that stops that device syncing. It is **not** forward-secret — a removed device retains whatever it already synced, and v0.1 offers no cryptographic re-key (that is iceboxed/MLS epoch-key revocation; `threat-model.md` §7). The registry record may be retained frozen for audit (it never re-issues the same `device_id`).
- The registry exposes **device count + per-device enrollment/activity** to the server (AS16 + the A13 per-device push-timing already accepted in `threat-model.md` §7); it holds **no** content and **no** key material.

## 5. Quota & abuse — IP-free

### 5.1 Quota

Storage is bounded by a **per-account quota**: aggregate **deduplicated** ciphertext bytes (AS17), counted once per stored blob (not once per referencing note — dedup is intra-vault, §2.1). The counter is **one number per account** across note blobs *and* attachment bodies (§3.2) — the attachment path has no separate budget. Reclamation decrements it: when horizon-GC drops a tombstoned body (`sync-protocol.md` §11.2/§11.4), the reclaimed bytes leave the counter. On a paid tier this is the plan ceiling; an operator sets their own (the protocol exposes the byte counter, the operator sets the policy — §6, TB5).

### 5.2 Rate-limit, never IP

Request abuse is bounded by a **per-account token-bucket rate-limit keyed on `account_number_hash`** — **never on IP** (C4). The server keeps **no persistent IP log**: TLS termination sees the connection IP for the request duration and discards it (AS14). The "no IP logging" commitment is **architectural, designed in from the start, not retrofitted** — operational logging (errors, rate-limit triggers, abuse heuristics) MUST function on per-account counts and version counters, not source IPs. A per-device sub-limit bounds a single compromised device.

**A request whose cost scales with its size is charged proportionally.** The bucket is otherwise one-token-per-request, which is right when every request buys roughly the same work. The batch ciphertext fetch of §3.3 breaks that assumption by design — one request can carry `MaxBlobFetchIDs` ids — so it spends `ceil(ids / BlobFetchIDsPerToken)` tokens, minimum one. This keeps the limiter's meaning intact in both directions: batching buys **round-trips**, not budget, and a one-id batch still costs exactly one token, so a client falling back to the single-blob route against an older server is not penalised for it. The alternative — one flat token per batch — would multiply the per-account egress ceiling by the id cap with **nothing behind it**: `507` (§5.1) bounds *stored* bytes and has no path on a read route at all, so on a fetch this bucket is the only egress bound there is. Charging per-id instead would reproduce exactly the round-trip ceiling §3.3 exists to remove. This also keeps §3's "one budget" posture whole — SSE poke connections and the §3.2 attachment routes already spend this same bucket rather than a second, uncounted one.

> A note for anyone re-deriving this argument: §5.2's "it smooths churn only" language belongs to the **pre-auth global** limiter described two paragraphs below, **not** to the per-account bucket, which carries no such disclaimer. The proportional charge stands on the caps and on the absence of a `507` behind a read, not on that sentence.

**Application-level care is not sufficient, and an implementation must close the runtime's own channel too.** The commitment is about what reaches a log sink, and an HTTP runtime typically has a connection-level logger of its own that sits *above* the handler chain — so a middleware that scrubs the request cannot reach it. In Go this is `http.Server.ErrorLog`, which receives `http: panic serving <addr>` on a handler panic and `http: TLS handshake error from <addr>` on a failed handshake; both carry the address captured at accept time, not the one on the request struct, and the second never passes through a handler at all. A conforming implementation MUST route that logger to a discard sink (or an equivalent that strips the address) **and** recover panics itself, so a panic still produces a bounded, address-free record rather than silence. Discarding without recovering trades a privacy leak for an observability one.

The per-account limit covers **authenticated** requests. A few operations run **before** a session exists — device registration, the SCRAM handshake, and the pre-auth `vault.meta` fetch (§3, device-registry bootstrap) — and so have no `account_number_hash` to key on. Keying these on IP is forbidden (C4/AS14), and keying on the *client-supplied* account value would itself be an unbounded-map abuse surface. This pre-auth surface is therefore bounded by two structural mechanisms, neither of which observes an IP: (1) a **single global (account-independent) token-bucket** whose per-key state is zero by construction, so it cannot key on IP or account — it smooths churn only; and (2) **finite resource caps** that are the hard bound — a ceiling on the registered-account count, a ceiling plus a short TTL on in-flight handshakes, a per-vault attachment-id ceiling, and a small body-size limit on every pre-auth request. Under a sustained flood the caps keep memory and disk bounded (the server does not fail) while pre-auth availability degrades to best-effort refusals (a rate signal vs a capacity signal) — the accepted DoS posture (§5.3; A13-class, `threat-model.md` §1). Proof-of-work is **not** used (§5.3).

### 5.3 Sybil posture

Sybil resistance is **reframed** as an operator resource/availability problem, not a user-security one: vaults are independent and zero-knowledge, so a Sybil account reaches no one else's data. On a paid tier, the **payment-gate is the primary Sybil resistance** (no free anonymous registration surface ⇒ 10k Sybils = 10k subscriptions); per-account quota (§5.1) + rate-limit (§5.2) bound the damage. **Until the payment gate ships (MYND-430), the registration surface is open**, bounded only by the §5.2 pre-auth global limiter, the registered-account cap, and the request body-size limit. Enough to keep the server from being exhausted, not to prevent Sybil registration itself (that is the payment gate's job). Proof-of-work is **not** in v1. The payment system itself is a separate epic (MYND-430); only the posture is recorded here. Self-host Sybil is the operator's policy problem.

**A server may additionally gate new-account registration behind a shared invite code** (`MYNE_INVITE_CODE`; `decisions/sync/0627`). With it set, `POST /auth/register` refuses an account the server has never seen unless the request carries the matching `invite_code`, compared in constant time, never logged, and never associated with the account (a pure door, no code-to-account record). An account that already exists is unaffected: its later devices return `409 already_registered` before the gate runs and need no code. Unset is open, so self-host and a fresh clone are unchanged, and a code below 32 characters is refused at startup. This is admission control for an operator who wants a closed group, not Sybil resistance; the payment gate remains that on a paid tier.

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

## 7. Operator console (admin API) + account status (MYND-506)

The server exposes an operator admin API over a **local Unix domain socket** (`MYNE_ADMIN_SOCKET`; no bearer secret — access is filesystem permissions; **disabled by default**). The **admin API on that socket** is never a TCP port or the public edge; its read-only browser counterpart is the separate listener of §7.0b, which is also never the public edge. A `myne-server admin` CLI is a thin client over it (server-mediated only). The API is a **live projection of already-persisted enforcement state only** (account hash, stored bytes, device count, policy) — never request history, last-seen wall-clocks, or per-account time series (§5 / `threat-model.md` §7 aggregate-only invariant).

Routes (JSON over the socket):

- `GET /admin/accounts` · `GET /admin/accounts/{hash}` — accounts merged with live stats (stored bytes = the blob + attachment AS17 total; device count) + policy (frozen, quota/device overrides).
- `GET /admin/stats` — aggregates (total accounts, total stored bytes, `MYNE_MAX_ACCOUNTS`).
- `POST /admin/accounts/{hash}/{freeze,unfreeze,quota,max-devices}` — enforcement writes; `0` clears an override. `frozen` blocks push + enroll, **never pull** ("frozen is minimal").
- `DELETE /admin/accounts/{hash}` — irreversible; removes the account's vault + attachments + device registry + SCRAM verifier + policy (the MYND-496 self-service-deletion primitive).

Enforcement policy persists in a **sparse top-level `accounts.json`** (server-side plaintext, `schema_version`; not synced; captured by the built-in backup). A per-account quota override also gates the attachment transport (one AS17 total, no bypass).

`GET /account/status` (on the normal **authed** HTTPS API, *not* the admin socket) returns the authenticated user's own `{stored bytes, device count, frozen, effective quota + device ceilings}`. The account is **resolved from the device token — never from the URL or query** (an identifier placed there is ignored, not a selector), so the account number never appears in a request line or log. Enforcement fields carry no cryptographically load-bearing identifier; `accounts.json` is a new server-side plaintext format, forward-incompatible-by-design with a later major version.

### 7.0b The operator panel (normative; myne-md/myne#787)

A browser cannot dial a Unix domain socket, so the operator console's browser surface
is a **separate TCP listener** gated by `MYNE_ADMIN_PANEL_ADDR` (empty = disabled,
the default). It renders the same enforcement state §7 describes and **nothing else**.

Four properties are normative here rather than left to the implementation, because each
one is what lets the threat model's "no boundary expansion" claim survive an access
criterion that genuinely changed:

1. **It is READ-ONLY, structurally.** The panel's route table registers the read verbs
   only, so no write route is reachable on its listener under any method. `freeze`,
   `unfreeze`, quota, device-cap and the irreversible `delete` stay on the Unix socket
   and the CLI. A read-only surface has **no cross-origin request surface at all**,
   rather than one to mitigate, which is why the panel needs no token.
2. **It is NETWORK-BINDABLE and never the public edge.** The bind address is whatever the
   operator writes and is **not validated**; a non-loopback address produces one startup
   warning naming the resolved address, and is not refused. Refusing was rejected on a
   measurement rather than a preference: for the `/metrics` listener a non-loopback bind
   is frequently the *correct* configuration, since Prometheus scraping from another host
   is the ordinary deployment. **The consequence an implementation MUST state to the
   operator: this listener terminates no TLS.** On a non-loopback bind the per-account
   roster crosses TB4 in cleartext to any passive observer on the path, which is a
   different exposure from `/metrics` and is why the loopback bind is the documented
   default rather than a convenience.
3. **It carries no authentication and NO request log at all**, in either direction: no
   access-log middleware, and the standard library's connection-level error log is
   discarded. `self-host-policy.md` §3 prohibits IP logging anywhere in an operator's
   stack, so a request log here would make a deployment violate its own contract. The
   panel is therefore the only HTTP surface in this server that records nothing.
   **Discarding the error log MUST be paired with recovering panics in the handler
   chain**, per §5.2: a handler panic is logged by the standard library with the peer
   address, and discarding without recovering trades a privacy leak for silence. The
   recovery records a bounded, address-free line and answers 500.
4. **It MUST validate the `Host` header against a known set, and that is the whole
   authentication story.** A hostile page the operator visits must not be able to read
   the roster, and neither of the usual answers works here. The same-origin policy does
   not: a rebound name (`attacker.test` re-resolving to `127.0.0.1`) is **same-origin to
   the attacker's own page**, so the browser hands it the response. An `Origin` check does
   not: browsers **omit `Origin` on a GET**, so the header that would catch a rebound
   fetch is never sent, and `Sec-Fetch-Site` reports `same-origin` for the rebound request,
   because by then it genuinely is. Validating `Host` is the only check that survives
   both. The allowed set is loopback names by default; an operator who binds a LAN address
   MUST name the host they will browse to (`MYNE_ADMIN_PANEL_HOSTS`). Note the scope
   precisely: read-only removes the **state-changing** cross-origin surface, so there is
   nothing there to forge, but it does not remove the **read** surface, and the read is
   what the `Host` check exists for.
5. **It is an instantaneous projection and renders no time value of any kind.** It reads
   live on every request and stores nothing
   between them (no "read at" line), because
   The reason it cannot render one is **not** that the server holds none: per AS6 the
   server DOES hold note `created_at` at millisecond resolution, derived from the UUIDv7
   embedded in the per-vault index, and it holds file and record times besides. The
   property is a rule about the projection rather than a fact about the store: **a derived
   time value MUST NOT be added to it** (a file mtime, a UUIDv7 creation time, a
   device-record age), because that is exactly the per-account time series the
   aggregate-only invariant forbids.
6. **It is a per-account read surface, and that is a change of shape, not new history.**
   The panel renders one row per account, so it is **per-account by construction**: it
   keeps the "no time series" half of the aggregate-only invariant and does not keep the
   "no per-account label" half, which the `/metrics` surface does. It stores nothing, so it
   is not the same as keeping history, but a party that can reach the bind address can poll
   it and **derive** a per-account series of stored bytes and device count by diffing
   successive responses, with no server-side state at all. The honest statement is that the
   panel adds no new **persistence**, not that it adds no observation capability.
   Relatedly, §3.1's deliberate refusal to distinguish an unknown account from a wrong
   username on `/auth/scram/init` is an anti-enumeration property the panel does not have:
   it publishes the complete roster to an unauthenticated reader.
7. **Its cost MUST be bounded like the rest of the unauthenticated surface.** A page load
   enumerates the store, so an implementation MUST build the summary from the rows it has
   already projected rather than projecting twice, MUST answer `Cache-Control: no-store`
   for the roster page, and SHOULD bound concurrency or response size on this listener.

**What it may render.** The fields the account projection already carries: account hash,
stored bytes, device count, frozen state, and the quota and device-ceiling overrides,
plus the deployment totals. It **cannot render an account number, because none exists on
the server**: the raw number never crosses the wire, the server stores
`account_number_hash := SHA-256(canonical_form)[:16]` (`account-number.md` §6, §7), and a
raw-form username is refused `400 bad_request` (§3.1, AS9).
**That does not make the roster harmless, and the distinction must not be collapsed into
"readability rather than privacy".** "Non-reversible" is a property of the hash as a string
and is not the property that decides the exposure. Per §3.1, the pre-auth
`GET /vault.meta` route is keyed on that same hash, and it returns **the complete offline
password-cracking target**: the Argon2id salt, the cost parameters, and both wrapped
`root_key` copies. So the panel's roster is a list of **credentials for that route**, and
anyone who can reach both the panel and the public sync API can mount an offline cracking
campaign against every account on the deployment without any further access. On this
surface the hash is the account number for every purpose the pre-auth route cares about.

**Deferred:** whether anything panel-shaped is reachable from a public origin is an
open `myne-ops` decision (public aggregates, or nothing). This spec places the panel off
the public edge so that decision has something to add to rather than something to
rewrite.

### 7.1 `GET /account/status` response (normative; MYND-570)

```json
{ "stored_bytes": 0, "device_count": 0, "frozen": false, "quota_bytes": 0, "max_devices": 0 }
```

- **One figure per PERSON account (normative; myne-md/myne#911 task 11).** The account is resolved from the token, and a person session's account is its `person_id_hash` (§3.1a). A person's own namespace holds no blobs (its content lives in the vaults it owns), so a projection that read the account's own counter would answer `0` for an account with ten full vaults. The server therefore answers with the **sum of the unified stored-byte totals of the vaults that account OWNS**, and sets two additional fields:

```json
{ "stored_bytes": 0, "device_count": 0, "frozen": false, "quota_bytes": 0, "max_devices": 0,
  "person": true, "vault_count": 2 }
```

  - `person` is absent (or `false`) for a vault session, which reports that vault's own figure exactly as before. A client MUST NOT render an account total as a per-vault figure: it is the sum of several vaults and the meter's denominator would be a ceiling that no single vault is judged against.
  - `vault_count` is how many owned vaults the total covers, so the copy can say what the figure spans.
  - **A vault the person merely JOINED does not count.** A member's bytes belong to the vault's owner, who can free them; reporting them as the member's usage would show a figure the member cannot act on and that the owner's account already counts.
  - **The person's ceiling is REPORTED and not ENFORCED.** The push guard reads the vault's own ceiling, because that is the namespace whose counter it reads (§5.1). A client MUST therefore render this figure without a meter and without limit language even when `quota_bytes` is non-zero, and an implementation MUST NOT thread the person ceiling into a vault's push guard without its own decision entry: that would be a write block, and it is out of this section's scope.
  - An account with no owned vaults takes the vault path, because the server cannot tell a person id from a vault id (§3.1a) and an account with no bindings has no aggregate to report. The answer is that account's own figure, which for a fresh person is `0`.
- **Ceilings are EFFECTIVE, never raw overrides.** `quota_bytes` and `max_devices` are the values enforcement would actually apply — the per-account override when set, else the global default (`decisions.md` 2026-07-13: `quota_override ?? plan ?? global default`). The server MUST resolve them through the **same** function the push/enroll enforcement guard calls, so a reported ceiling and a refusal cannot disagree. Exposing the raw override here would be wrong twice over: an account with no override would report `0`, and the number a client displays would not be the number it is judged against.
- **`0` means UNLIMITED, for both ceilings** — never a ceiling of zero. This is the existing server convention (`MYNE_QUOTA_CEILING_BYTES`, `MYNE_MAX_DEVICES_PER_ACCOUNT`). A client MUST render usage **without** a limit, a meter, or any limit language when it sees `0`, and MUST NOT compute a ratio against it. This is the ordinary self-host posture (§6, TB5): a deployment that sets no ceilings answers successfully with `0`, so no error path and no hosted-only concept is ever forced onto a self-hoster.
- **Absent route is a legitimate client state.** A server predating this section answers `404`; a client MUST treat that as "no usage to show" and degrade to a neutral state, never an error.
- **No plan and no expiry.** `plan_id` and `paid_until_day` exist in the `accounts.json` schema but are **reserved to MYND-430** and MUST NOT be exposed here until billing ships; nothing writes them, so exposing them would publish a permanently-null field. The same applies to any billing-capability flag.
- Still a live projection of already-persisted enforcement state only — no history, no wall-clocks, no per-account time series.

### 7.2 Refusal bodies carry a machine-readable reason (normative; MYND-570)

§3.1 already fixes the error body as `{"error_code": "<code>"}`. That shape is **normative for every refusal on the authed sync surface**, not only the auth wire, because a client must be able to tell refusals apart without parsing prose:

| Status | `error_code` | Meaning |
|---|---|---|
| `403` | `frozen` | Operator freeze — push + enroll refused, **pull never refused** ("frozen is minimal") |
| `413` | `too_large` | *This request* exceeded the body cap — a property of the request, not the account |
| `507` | `quota` | The account is at its effective storage ceiling |
| `429` | `rate` | Per-account token-bucket limit (§5.2) |
| `409` | `blob_stale` / `head_stale` | CAS loss — the pre-existing use of this field |
| `409` | `retired` | The sync id was retired by the owner (§3.4) — a write is refused permanently; reclamation is separate and grace-bounded |
| `403` | `owner_required` | A B2B vault's `vault.meta` write arrived with a device token rather than the owner's per-vault token (§3.4) |
| `410` | `blob_reclaimed` | The body was Layer-2 reclaimed (`sync-protocol.md` §11.3) — fail-closed, never an empty-body `200` |
| `404` | `not_found` | No such id **in this account's namespace** — never a statement about whether it exists elsewhere |

The last two rows are the ciphertext-fetch outcomes of §3.3, and they are the one place on this surface where an `error_code` is **not** attached to a refusal status: on `POST /sync/blobs` they ride **per-id inside a `200`**, in the `omitted` array, alongside `internal` for a body the server holds but cannot read. That is deliberate — see §3.3 for why a per-id omission beats failing the whole response.

A client MUST NOT collapse these into one generic failure: each implies a different user action, and `413` in particular is **not** an account-level condition and can never be reported by `/account/status`. Carrying the reason on the refusal itself is also what keeps the client off a second request on the refusal path, where the §5.2 limiter could answer `429` and mask the very refusal being explained.
