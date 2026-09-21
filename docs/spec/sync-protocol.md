# Myne Sync Protocol Specification (Phase 2)

> **Status: draft.** Phase 2 multi-device synchronization over an untrusted server (TB5). This document specifies the **vault head** fork-consistency primitive (MYND-416) and will grow to cover the sync wire protocol (push/pull/CAS — MYND-414), server protocol (MYND-415), and conflict resolution. It builds on the at-rest protocol in [`protocol.md`](protocol.md); all cryptographic primitives, the subkey-derivation helper (§3.2), the AAD/encode-then-hash discipline (§5), and the magic-byte registry (§10.3) are inherited from there. v0.1 and a later major version remain forward-incompatible (`protocol.md` §10); nothing here changes the v0.1 at-rest vault format — the head is **sync-wire-only** plus one device-local blob (`MYH1`, `protocol.md` §9.16).

---

## 1. Scope & threat

### 1.1 Scope

This document (as of MYND-416) defines the **vault head**: a small, server-relayed, per-push record that lets multiple devices of a single user detect a malicious server's attempts to **rewind, hide, or split** their vault, even though the server can never read or forge their content.

In scope here:
- The head record, its canonical byte encoding, and the HMAC that authenticates it (§3).
- The semantics of the committed fields — the version vector, the manifest **and its canonical byte encoding** (§4.2.1), and the push compare-and-swap (§4).
- The on-pull verification algorithm and the detection of rollback / fork / withholding (§5).
- Bootstrap of a fresh device (TOFU) and genesis (§6).
- The device-local last-seen baseline that anchors continuity across restarts (§7).

Out of scope (other Phase 2 work items): the sync wire protocol (MYND-414), the server protocol and storage (MYND-415/419/421), server authentication (MYND-420), device enrollment / approval / the bootstrap-fingerprint UI (MYND-425), tombstones / quota / rate-limit (MYND-422), the Rust implementation (MYND-417), and the cross-implementation golden vectors (MYND-418).

### 1.2 Threat

The sync server is **fully untrusted** (TB5; adversary A1, traffic-analysis-adjacent A13). End-to-end AEAD + AAD (`protocol.md` §5) already defeats content tampering, note substitution, and downgrade. What it does **not** stop is a "dumb blob store" that serves authentic-but-wrong bytes:

| Attack | What the server does | Caught by |
|---|---|---|
| **Rollback** | Serve an older, correctly-MAC'd head/blob (revert an edit, resurrect a deleted note) | VV-dominance (§5), operative, immediate |
| **Withholding** | Refuse to deliver the newest update | own-work: in-band (§5); other/global: best-effort (accepted) |
| **Equivocation / fork** | Show device A and device B divergent histories | delayed in-band on cross-read (§5) + out-of-band fingerprint (§6) |

The server cannot **forge** a head: the head's MAC key is derived from `root_key`, which the server never holds. Its only powers are to replay, withhold, reorder, or equivocate over **real** heads that some device of the user authored. The whole design follows from this single fact.

### 1.3 Conventions

Inherited from `protocol.md` §1.2: RFC 2119 keywords; `||` is concatenation; multi-byte integers are **big-endian** unless stated; `DeriveSubkey(root_key, role)` is the sole subkey helper (`protocol.md` §3.2.1). "Content blob" means a `.myn` note (§9.2) or an attachment (`MYA1`, §9.9) — the only blobs the head's manifest covers (§4).

---

## 2. Vault head — overview

A **vault head** is authored by a device at each **push** (sync point — not per keystroke; edits coalesce per the Phase 2 write cadence). It commits the vault's current state under a symmetric MAC and chains to its predecessor, forming a git-like **hash-DAG**:

- one parent → a linear extension;
- two parents → a legitimate concurrent-push **merge**;
- zero parents → the **genesis** head (§6).

The head commits four things (full encoding in §3, semantics in §4):

1. `manifest_hash` — a flat `SHA-256` of the canonical [vault-head manifest](#42-manifest-and-what-version-means) (`uuid → content_nonce` of content blobs only). Keeping a *hash* (not the map) makes the head O(1) in vault size.
2. `version_vector` — a per-device monotonic counter map; the authority for concurrency and fork detection.
3. `prev_head_hash[]` — the `head_id`(s) of the parent head(s); the structural backbone that makes a fork permanent.
4. `seq` — an auxiliary monotonic Lamport scalar (`max(parent_seq)+1`); fast-compare / display only, **never** a second source of truth over the VV.

The head is **HMAC-SHA-256**'d, not signed: Myne is single-user, so all devices share `root_key` and a symmetric MAC suffices. This keeps the construction inside the closed RustCrypto primitive set (HMAC-SHA-256 already keys attachment-ids, `protocol.md` §9.9) — no Ed25519, no new dependency, preserving the §6 audit-substitute posture. The accepted cost: `root_key` compromise is total compromise (no forward secrecy; `protocol.md` §11), which a signature scheme would not have improved for a single user.

The head is **wire-only** — it has no on-disk magic and is never stored in the synced vault tree. Each device keeps its own last-seen head as a device-local `MYH1` baseline (§7).

---

## 3. Head record & canonical encoding

The head is authenticated by an HMAC over a canonically-encoded message. As with the CTX commitment (`protocol.md` §5.1.3) and the AAD construction (§5.2), the encoding is **encode-then-MAC** with fixed-width and length/count-prefixed segments, so two independent implementations produce **bit-identical** bytes and no attacker can shift bytes between a fixed and a variable region (Chan & Rogaway). All multi-byte integers are big-endian.

### 3.1 Head MAC key

```
head_mac_key = DeriveSubkey(root_key, "vault-head-mac")        (32 bytes)
```

Per `protocol.md` §3.2 / §3.4. This is the only subkey this primitive introduces; the device-local baseline (§7) re-verifies the head's own MAC under this same key — there is no second context string.

### 3.2 Canonical HMAC message

```
head_mac_input =
    "myne.v0.1|"            (10 B   ASCII domain prefix, incl. pipe — protocol.md §5.2)
 || protocol_version        ( 1 B   = 0x01)
 || head_format_version     ( 1 B   = 0x01; the sync-format version hook — see §3.6)
 || account_number_hash     (16 B   the vault-binding field, protocol.md §9.3 / §5.2)
 || manifest_hash           (32 B   SHA-256 of the canonical manifest bytes; §4.2.1)
 || seq                     ( 8 B   u64 big-endian; §4)
 || parent_count            ( 1 B   0 = genesis, 1 = linear, 2 = merge)
 || prev_head_hash[i]       (32 B × parent_count, byte-sorted; §3.4)
 || vv_len                  ( 4 B   u32 big-endian — byte length of vv_canonical)
 || vv_canonical            (vv_len B; §3.3)

head_mac  = HMAC-SHA-256(head_mac_key, head_mac_input)          (32 B, full tag — no truncation)
```

Notes:
- **`account_number_hash` is bound** even though `head_mac_key` is already vault-specific. This mirrors the deliberate redundancy of `protocol.md` §5.2 (which binds it into the prefs/search/catalog AADs despite their root_key-derived KEKs): it is defense against a future key-derivation bug on our side (e.g. a fixture that reused a key across vaults), forcing cross-vault heads to mismatch regardless. It leaks nothing new (the field is already in `vault.meta` and the storage key).
- **No in-message role/domain tag** beyond the version bytes. The MAC key is purpose-specific (its `DeriveSubkey` context), and `head_format_version` already disambiguates "this is a head" inside the `myne.v0.1` domain. Adding a separate `"vault-head"` role string would be a needless separator, against the §3.2.2 spirit.
- **Full 32-byte tag**, no truncation — consistent with the on-disk CTX commitment tag width.
- `parent_count` MUST be 0, 1, or 2. A head with `parent_count > 2` is rejected (v0.1 sync produces at most a two-way merge; an N-way concurrent burst resolves as a chain of two-way merges).

### 3.3 Version-vector canonical encoding

`vv_canonical` pins the inner order so the outer `vv_len` prefix is not the only determinism guarantee:

```
vv_canonical =
    entry_count               ( 4 B   u32 big-endian)
 || for each entry, SORTED ASCENDING BY device_id (lexicographic, byte-order):
        device_id             (16 B)
        counter               ( 8 B   u64 big-endian)
```

`device_id` is the 16-byte VV-actor identifier (§4); `counter` is that device's authored-head count. Entries MUST be sorted by `device_id` and a `device_id` MUST appear at most once. (Semantics of `device_id` and `counter`: §4.)

### 3.4 `head_id` and the hash-DAG

A head's identity binds its **authentication**, not merely its content:

```
head_id = SHA-256( head_mac_input || head_mac )        (32 B — the full record, MAC included)
```

`prev_head_hash[i]` values are the `head_id`s of the parent head(s). When `parent_count == 2`, the two `prev_head_hash` values MUST be emitted **sorted ascending lexicographically (byte-order)** — a hash-sort is encoding-deterministic without any seq/VV lookup, so two implementations merging the same two parents emit identical bytes (a missing or unstable order would produce a different `head_mac` and a *spurious* fork). The genesis head has `parent_count == 0` and no `prev_head_hash`.

Because `head_id` covers `head_mac`, the chain is unforgeable end-to-end: a server cannot fabricate a `prev_head_hash` pointing at a head it did not receive from a real device, and cannot alter any ancestor without breaking every descendant's `head_id`.

### 3.5 SHA-256 domain separation

Four distinct SHA-256 inputs exist on the combined protocol's head / manifest / commitment path, and none may be reinterpretable as another:

| Hash | Input begins with | Defined in |
|---|---|---|
| `manifest_hash` | the domain prefix `"myne.v0.1\|vault-manifest\|"` (25 B), then the manifest's own version bytes | §4.2.1 |
| `head_id` | `head_mac_input`, i.e. `"myne.v0.1|"` … | §3.4 |
| `head_fingerprint` digest | the domain string `"myne.v0.1 vault-head-fingerprint"`, then `head_id` | §6.3 |
| CTX commitment | the §5.1.3 `canonical_encode` of (K, N, AD, T) | `protocol.md` §5.1.3 |

Each input starts with a distinct, non-overlapping prefix (the head via the `"myne.v0.1|"` AAD prefix; the manifest under its own `"myne.v0.1|vault-manifest|"` prefix, §4.2.1; the bootstrap fingerprint under its own `"myne.v0.1 vault-head-fingerprint"` domain string — which begins with the HKDF-style context prefix `"myne.v0.1 "`, **trailing space**, not the AAD prefix `"myne.v0.1|"`, so a fingerprint digest input can never be read as a `head_mac_input`; the CTX commitment under its fixed-length key/nonce-first layout), so no hash input is a prefix or re-encoding of another. In particular the fingerprint hashes `head_id` **under a domain**, never bare: displaying a truncation of `head_id` itself would make the displayed code a re-encoding of the identifier it is supposed to attest. Implementations MUST NOT feed bare, prefix-free data into any of these.

**On the manifest prefix's shape.** `"myne.v0.1|vault-manifest|"` is the AAD prefix `"myne.v0.1|"` **extended by a role segment** (`vault-manifest|`), which is the one place in this document where a role string appears inside a hashed message — the second note under §3.2 argues *against* one for the head. The two are consistent, and the asymmetry is the point: the head is the message that owns the bare `"myne.v0.1|"` domain, so the byte immediately following that prefix is a `protocol_version` byte (`0x01`) and never ASCII `v` (`0x76`). A `manifest_canonical` and a `head_mac_input` therefore diverge at the first byte after the shared 10-byte prefix, and neither can be read as the other without any type field to distinguish them. The head needs no role tag because its key is purpose-specific and its version bytes already say "head" inside the `myne.v0.1` domain; the manifest, which is hashed under no key at all, has only its prefix to do that work — so it carries one. `"myne.v0.1|vault-manifest|"` is load-bearing in the sense of the root `AGENTS.md` identifier table: drift changes every `manifest_hash`, therefore every `head_mac`, therefore every `head_id`.

### 3.6 `head_format_version` (forward hook)

`head_format_version` is bound into the MAC so the sync layer can evolve the head's *shape* without a v0.1 major-version event — the head is wire-only, so no on-disk format bakes it in (`protocol.md` §10 reserved-expansion ban does not apply). The documented Phase-3 use is upgrading `manifest_hash` from a flat hash to a Merkle root (enabling light-client / partial-sync inclusion proofs); that is a sync-wire bump, not a vault-format change. v0.1 uses `head_format_version = 0x01`.

---

## 4. Committed-field semantics

§3 fixed the *bytes*; this section fixes what they *mean*.

### 4.1 Version vector

The version vector (VV) is the authority for concurrency and fork detection. Each entry is `device_id → counter`.

**`device_id`** is a **client-generated, 16-byte random** identifier, allocated once when a device is enrolled and registered in the per-account device table (AS16). It MUST be generated by the device itself (OS CSPRNG), not assigned by the server (TB5 — a server-assigned id would let the untrusted server muddy VV semantics). It MUST be kept **separate from the device's secret per-device token**: the token is a revocable/rotatable bearer credential (an *availability* control — revoking it stops that device syncing), whereas `device_id` is permanent *history*. Deriving `device_id` from the token would let a token rotation rewrite VV history and break fork-consistency continuity. A reset or re-enrolled device generates a **new** `device_id`; the old device's component freezes (it authors no further heads) and is **never pruned** in v1.

**On a web client, `device_id` lives in evictable storage, and the never-pruned rule therefore has a cost the desktop rule does not.** A browser client's only home for it is OPFS, which the browser may evict under storage pressure, and which is scoped to the origin *and* to the browsing profile. So a cleared profile, a new browser, or a private window is a **new device** by this definition, and each one permanently adds a frozen VV component. The v1 rationale for never pruning — "for a single user the device count is small" — holds for installed applications and does **not** hold for a browser used across machines the user does not own. This is stated rather than fixed: pruning is a v1 non-goal, and the consequence is unbounded VV growth proportional to how often a user's browser storage is reset. An implementation MUST NOT work around it by deriving `device_id` from anything stable-but-shared (the account, the origin, a fingerprint): a re-used `device_id` across two concurrently-live browsers would make two devices author under one VV component, which breaks fork detection outright — strictly worse than an oversized vector.

**`counter`** is that device's **authored-head count** — incremented by exactly one each time the device authors a head, at **push** granularity (one head per sync point, never per keystroke; edits coalesce per the Phase 2 write cadence, so the counter leaks no per-keystroke activity).

**Composition rules:**
- **genesis** (`parent_count == 0`): the authoring device's component = 1; no other components.
- **linear** (`parent_count == 1`): copy the parent's VV, then `+1` to the author's component.
- **merge** (`parent_count == 2`): take the **componentwise maximum** of the two parents' VVs, then `+1` to the author's component.

**Implicit author + consistency check.** The head carries **no** `author_device_id` field. §3.2's byte list is exhaustive and ends at `vv_canonical`; `protocol.md` §9.16's `head_record` is exactly that message plus its tag, so there is no place in the record for one under either document. The author is instead **derived from the VV**, which is already inside `head_mac_input` and therefore already authenticated:

> **`author = the sole device_id whose component is exactly one above the parents' componentwise maximum for that device`** — i.e. the unique `d` with `H.VV[d] == max(parents' VV[d]) + 1` (absent components read as 0). At genesis (`parent_count == 0`) the parents' maximum is the all-zero vector, so this reduces to: `H.VV` is exactly `{d: 1}` for a single `d`, and that `d` is the author.

A verifier holding the parents MUST reject a head for which **no** such component exists, for which **more than one** does, or for which any *other* component differs from the parents' componentwise maximum. This is the same consistency check the earlier "redundant explicit field" framing bought, obtained without the field — and obtained *better*. An explicit copy riding **outside** the MAC'd message would be unauthenticated, yet §5.2 step 2 mandates a consistency check against the author: the untrusted relay would control that check's input. An explicit copy riding **inside** the message would cost every implementation 16 more bytes of byte-level agreement in exchange for no authority the VV does not already carry, and two implementations disagreeing about whether those bytes are there compute different `head_mac`s and different `head_id`s over the same vault state.

The derivation needs the parents' VVs. Where a parent is on hand (the common case: the baseline is a parent of the candidate) the check runs; where a merge parent is unfetchable past the horizon, it is **skipped** exactly as §5.4 states, and is never replaced by an unauthenticated field. The author is a derived quantity, so it cannot contradict the VV by construction.

**Actor-set authority (no separate roster).** A device's right to be a VV actor is **not** separately authenticated and need not be. Myne is single-user: anyone holding `root_key` is a legitimate author, so a device can introduce a new `device_id` simply by authoring a `root_key`-MAC'd head bearing it. The server, lacking `root_key`, cannot forge a head and therefore cannot inject a phantom `device_id` (it can only replay/withhold/reorder real heads). The VV actor-set is exactly "every `device_id` that appears in a validly-MAC'd head" = the user's enrolled devices. The Phase 2 device-approval gate (MYND-425) is an *availability* control over token issuance, **not** a cryptographic VV roster. Implementations MUST NOT add a roster-authentication step here.

**No pruning (v1).** A VV grows with the user's *lifetime* device count, not the active count. Dropping a component is forbidden in v1: it is "tombstone GC before causal stability" — it would make a fork involving that device undetectable thereafter. For a single user the device count is small, so there is no pressure. If pruning is ever introduced (a later version), it MUST ride an authenticated device-retirement event (a current device authoring a head that records "device X retired at component N"), never a unilateral drop — a unilateral drop is a server fork-hiding door.

### 4.2 Manifest, and what "version" means

The **vault-head manifest** is the `uuid → content_nonce` map the head commits (as a `SHA-256` of its canonical bytes, §3.2). Two decisions are load-bearing:

**Scope = content blobs only.** The manifest covers **notes** (`.myn`, keyed by note UUID) and **attachments** (keyed by the **attachment sync-id** — see below). It does **not** cover the synced singletons (`vault.prefs`, `vault.meta`, `vault.dictionary`, `vault.attachments` catalog). Their rollback is the already-accepted "local prefs replay" limitation (`threat-model.md` §7) — `vault.meta` additionally has the Q2 bespoke-merge + the `root_key`-invariant, so a credential-rollback is low-impact — and excluding them keeps the manifest uniform on a single discriminator (`content_nonce`), avoiding a per-singleton exception.

**The discriminator is `content_nonce`, not a counter.** Each note's `content_nonce` (`protocol.md` §9.2) is freshly random per save (§6.3 there: `item_key_nonce` is persistent, `content_nonce` is regenerated every content encryption), so it is the correct per-revision discriminator, and it is readable from the cleartext header **without decrypting**. Committing it gives **two-layer** rollback detection:
1. **Pre-decrypt:** a server serving an older revision presents a header `content_nonce` that ≠ the head's manifest entry → caught on a ~header-sized read, no decryption.
2. **On-decrypt:** the server cannot write the current `content_nonce` into the header while keeping old content — the AEAD binds the nonce to the ciphertext, so decryption fails (the tag was computed under the real nonce).

Binding the server's **opaque per-note version counter** instead would commit only a bare number, leaving which ciphertext counts as "version N" for the server to play with. The opaque counter is therefore **orthogonal** to the head: it is the sync transport's compare-and-swap token for individual note pushes (MYND-421), not something the head commits.

**Attachment sync-id (normative key-width pin).** The manifest's canonical encoding uses a **uniform 16-byte key** for every entry (§4.2.1). A note's key is its 16-byte UUID; an attachment's manifest **and wire** key is the **first 16 bytes of its 32-byte `attachment-id`** (`protocol.md` §9.9) — the **attachment sync-id**. The full 32-byte id continues to live in the `attachments/<hex>` filename, the `vault.attachments` catalog, and the attachment byte-transport (`server-protocol.md` §3.2); only the sync metadata plane truncates. The truncation is safe: within a single vault the birthday bound on a 128-bit prefix is ~2^-64 at any plausible attachment count, and the manifest's duplicate-key rule already makes a collision a **hard, visible encode failure** (never a silent overwrite). An attachment's manifest discriminator is the `content_nonce` from its `MYA1` cleartext header (offset 112), read without decryption — exactly the note rule. One consequence is normative for convergence: because an `attachment-id` is keyed over **plaintext** while encryption is randomized, two devices independently importing the same file mint the **same id but different ciphertext/`content_nonce`**. On a nonce mismatch for an attachment whose id both sides hold, a puller MUST adopt the server's bytes verbatim (**server-wins**) rather than treating the mismatch as a conflict — attachment plaintext is immutable per id, so nothing user-visible is lost and the manifests converge; keep-both (§10.1) applies to notes only.

**Deleted notes (tombstones).** A deletion is a `deleted`-marked new note version with its own fresh `content_nonce` (Q3 / MYND-422), so it stays **in the manifest** until horizon-GC — the head commits it, and a server attempting resurrection (serving the pre-deletion `content_nonce`) mismatches the head and is caught. Once horizon-GC fully purges a note, its UUID drops from the manifest; from that point a resurrection is covered not by the head but by Q3's full-reconcile-on-bootstrap + §6 TOFU (a device returning past the horizon is in full-reconcile mode and will not resurrect a vanished note). Pre-GC = head-protected; post-GC = handed to full-reconcile.

#### 4.2.1 Canonical manifest encoding (normative)

The manifest object is **not** a wire message: no device ever transmits it, and the server never sees, computes, or verifies it (it holds no MAC key, by design). It exists only as the byte string whose `SHA-256` the head commits — which is why its encoding is specified here rather than deferred to the wire protocol. `manifest_hash` is bound into `head_mac_input` (§3.2) and therefore into every `head_mac` and every `head_id` (§3.4), so a client that gets these bytes wrong computes a different head from a correct client over identical vault state, and the two cannot share a hash-DAG at all. This is a **client-to-client** contract; every independent client implementation MUST reproduce it bit-identically.

Like `head_mac_input` (§3.2) and the CTX commitment (`protocol.md` §5.1.3), the encoding is **encode-then-hash**: fixed-width, count-prefixed, totally ordered.

```
manifest_canonical =
    "myne.v0.1|vault-manifest|"   (25 B  ASCII domain prefix, both pipes included; §3.5)
 || protocol_version              ( 1 B  = 0x01)
 || manifest_format_version       ( 1 B  = 0x01; the manifest's forward hook)
 || entry_count                   ( 4 B  u32 big-endian — the number of entries that follow)
 || for each entry, SORTED ASCENDING BY id, id unique:
        id                        (16 B  note UUID, or attachment sync-id per the pin above)
        content_nonce             (24 B  the per-revision discriminator, protocol.md §9.2)

manifest_hash = SHA-256(manifest_canonical)                         (32 B)
```

Normative rules:

- **Order.** Entries MUST be sorted **ascending by `id`, compared as 16 unsigned bytes (lexicographic byte-order)** — the same comparison §3.3 applies to `device_id` and §3.4 to `prev_head_hash[]`. An encoder MUST sort; it MUST NOT emit caller order, and MUST NOT sort by any derived or display form of the id.
- **Uniqueness.** An `id` MUST appear at most once. A duplicate `id` is a **hard encode failure** — never a silent overwrite, never last-one-wins. This is the rule that makes the 16-byte attachment sync-id truncation safe (see the pin above): a prefix collision surfaces as a refused encode rather than as a lost blob.
- **Widths and endianness.** `entry_count` is u32 big-endian (`protocol.md` §1.2 applies throughout). Each entry is exactly 40 bytes with no per-entry length prefix and no padding, so a well-formed manifest is always exactly `31 + 40 × entry_count` bytes long.
- **Empty manifest.** `entry_count == 0` is valid and encodes to the 31-byte header alone. The genesis head over an empty corpus (§6.1) commits `SHA-256` of exactly those bytes.
- **Scope, restated as an encoding rule.** Only content blobs get entries (see "Scope = content blobs only" above). A singleton MUST NOT be given an entry, even a synthetic one, since the manifest is uniform on a single 16-byte key and a single 24-byte discriminator.
- **`manifest_format_version` is the manifest's forward hook**, the same shape as `head_format_version` (§3.6) and the same shape as the blob families' format byte (`protocol.md` §10.2): it is what a later sync format bumps to change the manifest's structure — the documented Phase-3 case is replacing the flat map with a Merkle tree. v0.1 uses `0x01`. `protocol_version` is the v0.1 protocol byte and is **not** a negotiation point.
- **Strict decode.** Decoding is not on the sync happy path (a client encodes its own manifest and compares hashes), but implementations that decode — golden-vector runners, cross-checks, audit tooling — MUST reject: a domain-prefix mismatch, `protocol_version ≠ 0x01`, a `manifest_format_version` they do not implement, a total length that is not exactly `31 + 40 × entry_count` (both truncation *and* trailing bytes; trailing bytes are a rejection, never ignorable padding), and entries that are not **strictly** ascending by `id` (which folds the duplicate-id rule into the decode direction).

The bytes and the resulting `manifest_hash` are pinned by the cross-implementation golden vectors (the `manifest` category in `myne-test-vectors`), including an unsorted-input case that catches a port which skips the sort and a tombstone-bearing case that confirms a `deleted`-marked version is an ordinary entry.

### 4.3 Push compare-and-swap = `prev_head_hash`

The head pointer is updated by an optimistic **compare-and-swap**, and `prev_head_hash` **is** the CAS token — there is no separate head counter. The server keeps exactly one *current-head pointer* per vault and, on a push, accepts the new head iff its current pointer matches one of the pushed head's `prev_head_hash` values, then sets the current pointer to the pushed `head_id`. The server treats the head as an opaque, MAC'd blob; it performs only the pointer comparison, learning nothing (server-trust-minimal).

Concurrent push resolves exactly as in git: if device A wins (`H0 → head_A`), device B's push (still `prev = H0`) fails the CAS; B pulls `head_A`, finds `head_A.VV` **incomparable** to `head_B.VV`, authors a two-way **merge** head (parents byte-sorted per §3.4), and pushes it — which now CAS-matches the current `head_A`. The server cannot forge a DAG edge (every `prev_head_hash` is bound into an unforgeable `head_id`); it can only accept or reject, which is the Q9-consistent availability bound.

---

## 5. Verification

### 5.1 Persisted baseline

Each device persists its **last-seen head** — the full wire-head record of the most recent head it accepted (or authored) — in the device-local `MYH1` baseline (§7). Verification is *relative to* this baseline; a device with no baseline is bootstrapping (§6, TOFU). In-session, the baseline is held in memory and only ever advances (a pull can never lower it); `MYH1` is the restart anchor.

### 5.2 On-pull algorithm

On receiving a candidate head `H` from the server, a device with last-seen baseline `B` MUST, in order:

1. **MAC-verify.** Recompute `head_mac` over `H`'s canonical `head_mac_input` (§3.2) under `head_mac_key`; reject if it does not match (constant-time compare). A head that fails here was not authored by a `root_key` holder — discard it. *(This is the only check the server could even attempt to attack, and it cannot: it lacks `root_key`.)*
2. **Structural well-formedness.** `parent_count ∈ {0,1,2}`; `prev_head_hash[]` byte-sorted and the right length; VV well-formed (non-empty, sorted, no duplicate `device_id`). Then, **when the parents' VVs are on hand**, the implicit-author consistency check of §4.1: exactly one component sits one above the parents' componentwise maximum, every other component equals that maximum, and at genesis the VV is exactly `{d: 1}`. Reject on any failure. The parent-dependent half follows §5.4 — skipped, not failed, when a merge parent is unfetchable past the horizon.
3. **VV-dominance (the operative rollback test).** Compare `H.VV` to `B.VV` **componentwise** (treat absent components as 0). This is O(devices) on the single head's embedded VV — **no chain walk, no intermediate-head fetch**. Route to §5.3.

The `prev_head_hash` chain is **not** walked in the happy path. It is the structural backbone for fork-permanence and for **lazy merge-parent verification** (§5.4) only. VV-dominance is sufficient for rollback rejection precisely because the server cannot forge a head with a fabricated VV (step 1): any head it serves carries the *real* VV its author committed.

### 5.3 The three cases

- **`H.VV ≥ B.VV` componentwise, with at least one component strictly greater → extension.** Accept; `H` becomes the new baseline.
- **Any component of `H.VV` is *less* than `B.VV` → rollback.** Reject. (The server is replaying an older real head.)
- **`H.VV` is incomparable to `B.VV` (some components greater, some less) → concurrent.** This is a *legitimate* concurrent edit, **not** a fork. The device's response is **active**: it authors a two-way **merge** head (componentwise-max + author+1, §4.1) and pushes it (§4.3). That single move is both the conflict resolution (the merge becomes the new converged head) **and** the fork-test: if the server refuses to serve the merge to the other branch, the divergence surfaces (§5.5).

A fork is distinguished from mere concurrency by **convergence over time**: incomparable-then-merged is concurrency; incomparable that **never re-converges** across devices (one device's accepted head is never an ancestor of what another device later reads) is a **fork** — caught delayed, in-band, on cross-read, and confirmed only via the out-of-band fingerprint (§6).

### 5.4 Lazy merge-parent verification

For a linear head (`parent_count == 1`) the device never walks the chain. For a **merge** head (`parent_count == 2`), the device fetches and MAC-verifies (§5.2 step 1) any parent `head_id` it does not already hold, and applies the merge-VV consistency check (`merge.VV == componentwise-max(parents) + author+1`). If a parent is **unfetchable** (beyond the Q3 horizon-GC), the device skips that consistency check and accepts the merge on faith — its author is a `root_key`-MAC'd device, i.e. one of the user's own, so the check guards against the user's *own* bug (like the `account_number_hash` redundancy of §3.2), not against the server. The walk is therefore lazy and best-effort-if-parents-on-hand; it is never part of the happy-path latency.

### 5.5 Withholding (honest split)

Withholding is a liveness attack and is **not** fully preventable — but v1 is **not blind to its own work**:

- **Withholding of the device's *own* authored work is caught in-band.** Because VV-dominance includes the self component, any head the server serves must carry `H.VV[self] ≥ B.VV[self]` (the device's own pushes are real heads it remembers authoring). A server that lowers, omits, or rolls back the self component is caught immediately at §5.3 — the device knows what it authored.
- **Withholding of *other* devices' work, and global staleness, is best-effort.** A server can serve a head that dominates *this* device's baseline while omitting another device A's latest push — this is not a dominance violation (the head dominates my VV; it simply does not carry A's newer component). Likewise a server can hide the newest head and serve an older-but-not-rolled-back one; the device cannot distinguish "nothing new" from "withholding." These are **accepted** in v1; a signed freshness-box (a monotonic timestamp token) is iceboxed.

Spec language MUST say "liveness, best-effort" for the second class and MUST NOT claim withholding is undetectable in general — the self-work case is detected.

### 5.6 Continuity, not bootstrap

Everything in §5 is a **continuity** guarantee: it protects a device that already holds a baseline `B`. A device with no baseline (fresh, reset, re-enrolled) has nothing to compare against and is in **TOFU bootstrap** (§6). This boundary is load-bearing and MUST be stated wherever the rollback guarantee is described.

### 5.6.1 Re-key re-base: the head after a whole-vault migration (normative; myne-md/myne#429)

The §10.4 whole-vault migration (`protocol.md` §10.4.1) mints a **fresh `root_key`**, and the vault head's MAC is keyed by `vault-head-mac`, a subkey of it. Every head the server holds therefore stops opening on the migrating device the moment the migration commits — and "this head does not open" is byte-identical to the signal a forged head produces (§5.3). Left unhandled the device raises the malicious-server alert against a migration the user themselves ran, and aborts the cycle **before** the push, so the head is never re-authored and the state is self-perpetuating.

A client MUST therefore treat a local re-key as a **head re-base**, not as an integrity event:

1. **The migrating device.** It records a device-local, one-shot re-base flag and drops its `vault.head-state` baseline (§9.16 — that baseline's integrity is the old head's own MAC, so it can no longer verify itself). On the next cycle its pull accepts the server's head **unverified**, taking only `head_id = SHA-256(record)`, which is keyless and asserts nothing about the head's contents. The cycle then authors a fresh head under the new `root_key` with that id as the CAS parent and pushes it — **even with nothing else to push**, because the stale-generation head is the thing being replaced. The flag is cleared by the server's acknowledgement of that push, never optimistically: a re-base that did not land must stay pending. Every other check is untouched — the advertised `head_id` MUST still match the record's hash, and blob-level verification (§11.3) is unchanged.
2. **Every other device.** Its pull fails to open the same head, and it has no re-base flag. Before treating that as an integrity event it MUST ask the one question that separates a migration from an attack: **is the server's `vault.meta` a newer generation than the local one?** Only the migration produces that, and no server can fabricate one that is *usable* — a v0.2 meta opens only under credentials the user holds. If so, the device MUST NOT raise the integrity alert; it locks the vault and tells the user it was upgraded elsewhere and needs unlocking again. Any doubt — an unreachable server, an unreadable meta — MUST fall back to the ordinary integrity path.

   **How that device actually joins the new generation (normative; myne-md/myne#447).** "Unlock again" is only a remedy if the new `vault.meta` is on disk when the user does it, and the peer cannot verify the server's copy — it holds no key for the generation those bytes belong to. So adoption is split into a fetch that commits to nothing and a promotion that a credential pays for:

   - **Stage, never overwrite.** On taking the re-key branch the device MUST persist the server's meta beside its own (`vault.meta.incoming`) and MUST leave `vault.meta` byte-identical. Overwriting on a server's say-so is a data-availability hole rather than a confidentiality one: `vault.meta` holds the only local copy of the wrapped `root_key`, so a fabricated `NTV5` blob would strand every local note behind a key nothing can recover.
   - **Promote only on proof.** At the next unlock the device MUST try the staged meta **before** its own, and MUST promote it to `vault.meta` only once the user's credential has opened it. Trying it second is not equivalent and MUST NOT be implemented: the device's own meta still opens under the same password, so a fallback-only order never promotes anything and the device re-locks on every cycle forever. A staged meta the credential does not open MUST be discarded and the local meta MUST answer, so a hostile one costs one wasted KDF and nothing else.
   - **Promotion carries the artefacts with it.** Everything the replaced `root_key` sealed MUST go in the same operation — the rebuildable caches, the device-local sync baseline (§9.16), any quick-unlock credential (which wraps a now-stale `root_key` copy), and the synced singletons the peer cannot re-seal (`vault.prefs`, `vault.attachments`, `vault.themes`). Those three are not merely stale: their readers answer an undecryptable blob as **empty**, and an empty local singleton is one push away from overwriting the migrating device's real data. They return from the server under the new generation's sync-ids. Note blobs MUST NOT be dropped — the pull replaces them, and deleting them first discards content before its replacement arrives.
   - **Credential paths that bypass `vault.meta` MUST be suspended while a meta is staged.** A quick-unlock credential (§9.14) wraps its own `root_key` copy and reads no meta, so redeeming it would hand back the previous generation's key and promote nothing — leaving a user who only ever unlocks with a PIN in the loop this clause exists to end.

The new generation starts from a fresh version vector and `seq`, because an unopened head contributes neither. **The SCRAM verifier is replaced in the same cycle (normative).** The account's SCRAM secret is `DeriveSubkey(root_key, "server-auth")`, so the re-key invalidates the verifier the server holds. `POST /auth/register` is **first-write-only** — that is what stops an unauthenticated caller overwriting a credential — so the replace MUST go through an **authenticated** route (`POST /auth/verifier`), and the server MUST take the account from the bearer session rather than from the request body: a device may replace only the verifier of the account it already authenticated against. The client MUST attempt it **while the current token is still valid**, in the same cycle that lands the re-based head, and MUST NOT clear its re-base flag until both have succeeded. The failure this ordering avoids is delayed and total: an enrolled device presents a stored token and keeps working, so nothing looks wrong until that token expires or a new device enrols — and then every handshake fails 401 with no client-side remedy.

**Known consequence, and the reclaim it owes (normative; myne-md/myne#443).** The reserved sync-ids of the synced singletons (`catalog-sync-id`, `prefs-sync-id`, `themes-sync-id`, `protocol.md` §3.4) are `root_key`-derived and so all change with the re-key; the blobs behind the previous ids are stranded server-side. They are inert to every client (a puller accepts `MY01`/`NC05` note magic only), and horizon-GC does not reclaim them on its own, because it reclaims `deleted`-marked records and nothing marks these.

The migrating device MUST therefore queue a **§11.4 tombstone record for each old sync-id**, device-locally, at the moment it re-bases the sync plane — and it MUST capture each id's last-known blob version **before** discarding that baseline, because the version is the tombstone push's CAS base and it exists nowhere else afterwards. An id the device never pushed has no baseline and is owed no tombstone: there is no server-side record to reclaim. The records carry an empty ciphertext and a freshly-minted `content_nonce`, exactly like the attachment tombstone of §11.4.

**The reclaim MUST NOT be able to cost the account its sync.** A queued base version can be stale — a peer may have written to the same old id while the migrating device was offline — and a `blob_stale` 409 fails the whole push request. A client MUST therefore push these tombstones in a **request of their own**, after the content push and carrying no head, and MUST triage the outcome rather than propagating it: a refusal *about these blobs* (`blob_stale`, quota, payload, malformed) abandons them permanently, since the server returns no current version and there is nothing to retry with; a transport-level failure leaves them queued for the next cycle. Abandoning returns the account to exactly the pre-#443 state — inert blobs nobody addresses — which is the correct floor for a storage errand the user never asked for.

### 5.7 Properties to verify (MYND-417/418)

This primitive **requires a primitive-level cryptographic review, not merely an architectural one**, before implementation lands. The following properties MUST be covered by `proptest` (Rust, `crypto_properties.rs` discipline) and by the golden vectors (MYND-418, schema in `myne-test-vectors`):

- **Encode→decode roundtrip.** A head encoded per §3 and decoded yields an identical record; `head_id` is stable.
- **Rollback-rejection.** A head with any VV component below the baseline is rejected (§5.3).
- **Fork-incomparability.** Two incomparable heads never both validate as a linear extension of the same baseline (exactly one, or neither, extends; the other forces a merge).
- **Merge-VV-consistency.** For any DAG, a merge head's author component equals `max(parents) + 1` and all other components equal the componentwise max (§4.1); genesis = `{author: 1}`.
- **Canonical-encoding determinism.** Independent encoders (Rust, Go) emit byte-identical `head_mac_input` for the same logical head — the bit-identical bar of §3 (VV sort, merge-parent lexicographic sort, fixed widths, big-endian).
- **Manifest canonical-encoding determinism.** Independent encoders emit byte-identical `manifest_canonical`, and therefore an identical `manifest_hash`, for the same logical `{id → content_nonce}` set regardless of the order the entries were supplied in; a duplicate `id` fails the encode rather than producing bytes; the empty set encodes to the 31-byte header (§4.2.1). This is a **client-to-client** property — the server never computes a manifest — so a missing Go runner for its vectors is not a coverage gap.

---

## 6. Genesis & TOFU bootstrap

### 6.1 Genesis

The **genesis** head is authored by the first device to push, at **first sync** — not at vault creation (the head is wire-only; a vault that never syncs has no head, and Phase 1 must not gain a sync artefact). Genesis commits the **entire existing local corpus**: `manifest_hash` over every current content blob's `(uuid, content_nonce)`, `VV = {author: 1}`, `seq = 1`, `parent_count = 0`. The authoring device is **authoritative** — it knows its own local state is real, so genesis carries no TOFU risk.

An **empty corpus is a valid genesis.** A device with zero content blobs still authors the genesis head on its first push (the `manifest_hash` is simply computed over the empty manifest) — a **head-only push** (no blobs, `new_head` only). This is required for liveness: a device joining an as-yet-empty account must be able to adopt a verifiable head to complete its §6.3 bootstrap-fingerprint eye-compare; without a genesis-on-empty, a zero-note account would never author a head, the joiner's pull would return no head, and the enrollment compare would be unreachable (the joiner would wait indefinitely). The genesis-on-empty push is gated to **push cycles** (never a poll-only pull — the §8.3 privacy cadence is untouched) and fires **exactly once**: once any head exists, a subsequent no-local-change cycle adopts it (§5) rather than re-authoring.

Head state is fully **re-derivable**: total loss of a device's head state (corrupted/cleared `MYH1`) costs at most a re-genesis (a TOFU reset, §6.2) — the vault *content* is untouched, since the head is a sync artefact, not authoritative content.

### 6.2 TOFU bootstrap

The "first device" is not cryptographically special; **"has a persisted baseline or not"** is. A fresh, reset, or re-enrolled device has no baseline, so §5's continuity guarantee does not yet apply: it adopts the server-served head on **trust-on-first-use**. MAC-verifying that head proves only that *a `root_key` holder authored it* — **not** that it is the latest, unforked head. A malicious server can therefore seat a brand-new device onto a stale or forked history undetectably, because the device has no prior state to contradict it. This is intrinsic to fork-consistency (SUNDR: a client that has observed nothing can detect nothing); it is the same posture as Signal/Matrix key TOFU.

A re-enrolled device generates a **new** `device_id` (§4.1) — it does not reclaim the old one; the old component freezes.

**On a web client, re-bootstrap is routine rather than once-per-device.** The baseline that decides "has a persisted baseline or not" is the `MYH1` device-local head-state of §7, and on web that record — along with the §8.2 cursor and the `device_id` itself — lives in evictable OPFS. Browser storage eviction therefore drops the client back into exactly this TOFU state, and §5's continuity guarantee does not cover the gap: a device that has observed nothing can detect nothing. A web client MUST treat eviction as *re-bootstrap*, not as data loss (there is nothing to lose — the vault is on the server and every byte of it is ciphertext), and MUST re-run the §6.3 bootstrap-fingerprint compare on **every** re-bootstrap, not only at first enrolment. Skipping the compare on a re-bootstrap because "this device already enrolled once" would silently discard the only hardening this step has, in precisely the situation it exists for.

### 6.3 Bootstrap-fingerprint (the only hardening)

The bootstrap is **not** in a vacuum: enrollment (MYND-425) runs a **device-approval gate** where an existing, unlocked device approves the newcomer — so the user is physically at *both* devices, and an out-of-band channel (their eyes) is naturally present. v1 hardens TOFU by having both devices display a short **bootstrap-fingerprint** derived from the adopted `head_id`, for the user to eye-compare — exactly Signal/Matrix safety-number verification. A match turns "trust the untrusted server" into "verified against an existing trusted device."

- The fingerprint is **~SAS-magnitude** — 40 bits rendered as an 8-character eye-comparable code, a deterministic function of `head_id` (not the full 32-byte value). The exact construction is normative below.
- It is **targeted** to the approval moment. If the device-approval gate ships in v1, this compare ships in v1 (the marginal UX cost is one glance on a screen the user is already on, at the exact vulnerability point).
- It is distinct from the **general fork-audit fingerprint** — an always-available affordance to compare current heads across devices at any time — whose prompt-UX stays v1.x. v1 ships the *substrate* (a deterministic fingerprint of any `head_id`); the general UI is later.

**Construction (normative).** The compare is only worth anything if both sides derive the same code, so the derivation is fixed here rather than left to the client:

```text
digest      = SHA-256("myne.v0.1 vault-head-fingerprint" || head_id)
fingerprint = crockford32(digest[0..5])   ← first 40 bits, big-endian,
                                             eight 5-bit groups, MSB group first
display     = fingerprint[0..4] || "-" || fingerprint[4..8]
```

- The **domain string** is `"myne.v0.1 vault-head-fingerprint"` — 32 ASCII bytes, no trailing separator, prepended verbatim. It is **load-bearing**: any drift changes every displayed fingerprint on every device. Note it carries the HKDF-style context prefix `"myne.v0.1 "` (trailing **space**), not the AAD prefix `"myne.v0.1|"` (§3.5). It is a domain-separated hash input, **not** an HKDF context — no subkey is derived and no `protocol.md` §3.4 row exists for it.
- `head_id` is the full 32-byte value of §3.4, appended verbatim; the fingerprint never hashes a truncation of it.
- The **alphabet** is the frozen Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — the same one, with the same `I`/`L`/`O`/`U` exclusions, that [`account-number.md`](account-number.md) §2 fixes. There is **no** check character: this is a code the user compares by eye, not one they type, so the Damm-32 machinery of `account-number.md` §4 does not apply.
- The **display form** is the 8 characters grouped `XXXX-XXXX` (9 characters including the dash). Both devices MUST show the same grouping — an ungrouped or differently-grouped rendering of the same head reads as a mismatch to the user.

Every element above is **cross-implementation byte-identical** and is pinned by the `head-fingerprint` golden vectors in the `myne-test-vectors` companion. A second implementation that changed the domain string, the truncation width, the bit-packing order, the alphabet, or the grouping would display a different code for the *same* head — the compare would then fail for the wrong reason, and a user trained to expect mismatches is a user who clicks through the real one.

**Which head each side displays (normative; myne-md/myne#462).** The construction above fixes how a `head_id` becomes a code and says nothing about *which* `head_id` each screen picks — a gap implementations filled with "the most recent observation", which is not the same anchor as "the adopted head" and is not stable for the length of a compare.

- The **joining** device displays the fingerprint of the `head_id` it currently holds, **tracked rather than latched**, with a head that moves while the screen is open **announced** to the user rather than swapped in silently. A latch was the first design and is rejected: a latched side against a tracking side can never agree, and "keep looking until they match" is a convergence wait rather than a comparison, which a server that forked two devices and later served them the same tip would pass. The announcement is what keeps it a comparison.
- The **approving** device also displays the head it currently holds, which on an already-enrolled device is at first the one it held **before** the approval. That first value is a convergence artefact rather than news, so a change during a bounded grace window after the screen opens is not announced. The window **MUST** be bounded by something that always elapses (a wall clock), never by the first sync cycle completing: an untrusted server can stall a cycle indefinitely, and a grace window keyed to it would leave the announcement disarmed for as long as the server chose, on the one screen where the user's eyes are the whole defence.
- **The fingerprint's input MUST be a `head_id` the displaying device itself derived** from a record whose `head_mac` it verified under `vault-head-mac` (or which it authored). A client **MUST NOT** render the fingerprint of a `head_id` supplied by the server, and **MUST NOT** display any server-supplied value as a code on this screen. The server chooses which real head to serve (§6.2); if it could *also* choose the code displayed, it would set the two independently and a **match** would prove nothing. This is the difference between a fail-safe compare and an attacker-chosen constant.
- A match attests **history**, not device identity: it says the two devices hold the same head, not that the pending row approved is the device in the user's hand.

**Holding pushes for the duration of the compare (normative; myne#462).** A head is not a stable identity — every push authors a new one — so a compare whose two screens sample at different moments disagrees for reasons that are not attacks. While a verify screen is open, a client **MUST NOT** author a **content** head, and **MUST** continue to pull (both sides reach the head they display by pulling, and §5.5 withholding detection depends on it). Two properties are required rather than optional:

- The hold **MUST** carry a bound that releases it without cooperation — a lease, a ceiling, or both — so a client that dies mid-compare cannot leave its own edits unpushed indefinitely.
- The §6.1 **genesis-on-empty push is exempt**, and *on-empty* is load-bearing rather than descriptive. On an account with no head, the genesis head is the only thing a joining device can adopt, so suppressing it would leave both screens waiting forever on exactly the accounts a first compare happens on. But the exemption **MUST** be conditioned on the local corpus actually being empty: a device with content blobs on disk and no head yet would otherwise author a head whose manifest commits `content_nonce`s for blobs the server does not hold, inverting the §5 ordering, and a peer pulling in that window cannot tell an over-claiming author from a withholding server.
- A **re-key rebase** authors a head through the hold by design (#429): the stale-generation head is the thing being replaced, and waiting would leave the vault head unopenable and this device's sync wedged until the user happens to type. The compare can therefore see the head move for that reason, which the announcement above surfaces.

The hold is **extend-only** with respect to push timing: nothing fires earlier than it would have, and pending push intent is retained rather than consumed, so the §8.3 A13 posture is unchanged.

Without an out-of-band compare, TOFU adoption remains trust-the-server; with it, the malicious-server bootstrap attack is closed for that enrollment. The spec MUST present TOFU honestly (the guarantee holds only after a verified baseline exists) and MUST NOT imply that MAC-verification alone authenticates freshness.

---

## 7. Device-local baseline (`MYH1`)

The last-seen head (§5.1) is persisted **device-locally** in the `MYH1` `vault.head-state` blob; its on-disk format, integrity rule, and honest limits are normative in [`protocol.md`](protocol.md) §9.16. The sync-relevant properties:

- **Device-local, never synced, never backed up.** The baseline MUST NOT live on the server — a server-held baseline would let the server roll *it* back too, defeating §5 entirely. It is structurally excluded from sync by the closed sync-allowlist's **default-deny** (it is simply not an allowlisted member, not a special-cased exclusion) and from backup by the §9.11.3 allowlist (a restored baseline would be stale → the restored vault re-bootstraps via §6 TOFU).
- **Stores the full wire-head TIP only**, re-verifying the head's own `vault-head-mac` on load (no separate at-rest MAC, no KEK — the head carries no vault plaintext the sync server doesn't already see). Written every accepted-pull and every authored-push.
- **Anti-rollback of the baseline itself is bounded, not absolute.** Lowering the on-disk baseline to force acceptance of a server rollback requires a **conjunction** — local-disk-write **and** a colluding malicious server; neither alone suffices (disk-write-only: an honest server still serves the real, dominating tip; server-rollback-only: an intact baseline rejects it). Impact is bounded to stale *own* data (never forged or decrypted), and the in-session RAM baseline only advances. Accepted for v0.1 and recorded in `threat-model.md` §7; a hardware monotonic counter is the next major version's closure (`protocol.md` §9.16).

---

## 8. Sync wire protocol

The vault head (§2–§7) is the integrity spine; this section is the transport that moves blobs and heads between a device and the server. The model is **whole-blob replication** — every Myne blob is an AEAD whole-file unit (`protocol.md` §9), so there is no field-level diffing or server-side merge. Real-time co-editing and a CRDT note-type are Phase 4 (`protocol.md` §11.2); they would arrive as a new major note-type beside the v0.1 blob, not as an extension here.

### 8.1 Endpoints

Two core operations:

- **pull(cursor) → (changed[], new_cursor)** — the server returns, for every content blob changed since `cursor`, a **per-blob sync-meta** record and advances the cursor:
  ```
  sync_meta = { uuid (16 B), version (server opaque counter, §2 server-protocol), content_nonce (24 B), size (bytes) }
  ```
  The client compares each `content_nonce` to its local copy (the §9.6.4 decryption-free staleness signal) and decides which blobs to actually download. The server also returns the current vault head (the client verifies it per §5). `version` is the server's opaque per-note counter (AS6), `size` the AS17 quota unit. A client MAY additionally use `size` to **plan** a batch ciphertext fetch (`server-protocol.md` §3.3) — an advisory use, not a trusted one: it MUST bound the response it will actually read independently of the advertised total, and MUST degrade (narrow the window, then fall back to the single-blob route) rather than fail, so an under-reporting server costs a round-trip instead of wedging every cycle identically. Neither field is trusted for integrity — the head is.
- **push(changed_blobs, new_head)** — the client uploads changed blobs plus the new vault head. The push is a **compare-and-swap**: the head's `prev_head_hash` (§4.3) is the CAS token; the server accepts iff its current-head pointer matches, then atomically advances. A stale base → a 409-like reject (§10).

**Attachments ride the same metadata plane, but their bytes travel out-of-band.** An attachment participates in pull/push as a normal content-blob record keyed by its 16-byte **attachment sync-id** (§4.2) with its `MYA1` header `content_nonce` as the discriminator — but its ciphertext is **not** carried inline in the push body. The bytes move over the dedicated resumable byte-transport (`server-protocol.md` §3.2: `HEAD`/`PUT`/`GET /attachments/{id}`, full 32-byte id, single whole-blob AEAD unit); the push then records the attachment with an **empty inline ciphertext** plus its full `attachment_id` (an optional wire field), and the server echoes that `attachment_id` back in the pull sync-meta so a puller can resolve the sync-id to the full id without waiting on the catalog. Ordering preserves the blobs-first-then-head rule (SYNC-5): a client MUST complete every attachment byte-upload **before** the push that references it, so any head the server accepts only ever commits attachment bytes that are already durably stored.

### 8.2 Cursor

The **sync cursor** is an opaque, per-device, monotone position (a catch-up bookmark). It carries **no wall-clock** — ordering authority is the version vector (§4.1), never the cursor (Pin 4). It is persisted device-locally alongside, but separate from, the `MYH1` head baseline (§7) and the rebuildable caches (it is sync-transport state, owned by the sync engine, not the head).

### 8.3 Change notification — contentless poke

A device learns "something changed, come pull" via a **contentless poke**: a signal with **literally zero payload** — no note-id, no version, no count, no cursor (any of those would leak which/what/how-much to the server or a network observer, A13).

- **The poke (over SSE) is part of the baseline sync behaviour** *(amended — supersedes the original opt-in-layer posture; `decisions.md` 2026-07-12)*. While a vault is unlocked (and, on mobile, foregrounded), the client keeps one SSE poke stream open per enrolled vault. Rationale for the amendment: the fixed-interval polling baseline already disclosed device presence to the server at poll granularity for the entire unlocked window, so the continuous connection's marginal A13 delta (poll-granular → connection-granular presence) was judged too small to carry a user-facing toggle whose privacy value was largely theatrical. What IS load-bearing is unchanged: the poke carries **zero payload**, and the arrival + timing of a push is intrinsic A13 (accepted).
- **Polling remains the fallback cadence.** A device polls on an interval regardless of the stream's health — a broken/parked poke stream degrades latency (back to poll granularity), never correctness. Desktop and mobile share this baseline. Edge triggers (unlock, window focus, mobile foreground) may additionally arm a **one-shot** immediate pull; they are one-shot by construction so they cannot become a high-frequency polling channel.
- **The §6.3 verification push-hold is the one sanctioned pause**, and it is extend-only: while a device-verification eye-compare is open the client withholds content pushes so the head under the compare stands still. Nothing fires earlier than it would have and pending push intent is retained, so the A13 timing posture above is unchanged — a delayed push discloses strictly less than a sent one.
- **Stream hygiene (normative for clients):** reconnects use jittered exponential backoff; a `401` parks the stream until the device's `(endpoint, token)` identity changes (no reconnect-spin on a revoked token); on every successful (re)connect the client performs one catch-up pull (pokes sent while disconnected are unobservable). Dead connections are detected via the server's heartbeat (`server-protocol.md` §3) — a read timeout above the heartbeat cadence.

### 8.4 Robustness

- **Idempotent push** — the CAS (§8.1) plus content-addressing makes a retried push a no-op rather than a duplicate.
- **Certificate pinning** — the client pins the server certificate (A4 MitM); the channel is authenticated to a session (the auth mechanism is MYND-420, referenced in `server-protocol.md`). **This obligation binds NATIVE clients only.** A browser exposes no certificate-pinning API and no TLS-exporter keying material to page JavaScript, so a web client is **structurally exempt** from both this and the SCRAM channel binding — permanently, not pending (`decisions.md` 2026-07-26 "No channel binding and no certificate pinning on the web client"; `threat-model.md` A4 is qualified per client on exactly this). A web client's transport defence is the browser's own trust store and nothing more. The mitigation that survives is unchanged in kind: a MitM on the sync origin sees only ciphertext. What it does **not** survive is a MitM on the origin that serves the client code, which is a different adversary (A15) across a different boundary (TB11).
- **Deferred (not v1):** real-time WebSocket co-edit (Phase 4) and contentless mobile-wake push (Phase 3) — both are documented forward paths, not part of this wire spec.

---

## 9. Sync taxonomy

Not every vault artefact syncs. The **sync taxonomy** partitions them into four classes, and the membership is governed by one invariant so it is never re-litigated:

> **Invariant — sync members ⊆ backup members.** A blob syncs only if it is in the `protocol.md` §9.11.3 backup allowlist *and* is authoritative (not a rebuildable cache, not device-local). Sync membership is the authoritative-vs-derivable cut of that allowlist; it is not a separate list a future change can drift. **One deliberate carve-out:** `snapshots/` are authoritative and backed up yet are *never* synced — see §9.2.

| Class | Members | Disposition |
|---|---|---|
| **1: Authoritative data** | `.myn` notes, `vault.prefs`, `vault.dictionary`, `vault.themes`, attachment blobs, `vault.attachments` catalog, `vault.chats` catalog, per-conversation `chats/<id>` files, `vault.agent-memory` catalog + per-entry `memories/<id>` files, `vault.personality` | **SYNC.** Merge per §10 (bodies = keep-both; prefs/dictionary/catalog = field/set merge; themes = per-name map merge, §10.2.2; chats = catalog per-id causal join + turn-list prefix/suffix merge, §10.2.5; agent-memory = catalog per-id causal join + per-entry adopt, §10.2.6; personality = whole-value LWW, §10.2.7). |
| **2 — Identity** | `vault.meta` | **SYNC**, with the §10 bespoke merge that preserves the recovery-side wrapped `root_key` (`protocol.md` §9.3). |
| **3 — Rebuildable cache** | `vault.search` (`MYS1`), `vault.indices` (`MYI1`), `vault.embeddings` (`MYR1`), `vault.graph` (`MYG1`) | **NEVER synced — re-derived locally** from the notes via the §9.6.4 `content_nonce` reconcile. Syncing them would be redundant, create a spurious conflict class, and still require a reconcile; cold-start is bounded (first build once per device, delta thereafter). `vault.embeddings` is a *doubly* Class-3 fit: it is both rebuildable **and model-specific** — its vectors are valid only for the exact embedding model that produced them (`{model_hash, embedding_dim, chunker_version}`), so on a device holding a different model, or none, they are simply wrong; syncing them is actively incorrect, not merely redundant. |
| **4 — Device-local** | `vault.workspace` (`MYW1`), `vault.quickunlock` (`MYQ1`), `vault.head-state` (`MYH1`, §7), `vault.label` (`MYL1`) | **NEVER synced.** `vault.workspace` is a privacy choice (graceful-exit/coalesced writes would turn at-rest mtime into a server-visible active-edit-timing channel — A13); `vault.quickunlock` is a security MUST-NOT (it wraps a device-hardware-bound copy of `root_key`); `vault.head-state` is each device's own rollback baseline; `vault.label` (`protocol.md` §9.22) is a security choice of the same shape as `vault.quickunlock`, one step weaker: its `wrap_key` is a per-vault device-local keychain item, so a synced copy would be inert on every other device, and syncing a vault's user-authored name would put that name somewhere the device-local key destruction of §9.22.5 cannot reach. |

**Class-4 disposition on a web client** (MYND-574). The never-synced rule is unchanged for all four; what differs is whether the artefact exists at all, and how durable it is:

| Class-4 member | Web disposition |
|---|---|
| `vault.workspace` (`MYW1`) | **Exists**, in evictable OPFS. Still never synced — the A13 active-edit-timing reason is client-independent. Losing it to eviction costs pane/tab layout and nothing else. |
| `vault.quickunlock` (`MYQ1`) | **Does not exist on web.** There is no quick-unlock in this release: every reload costs a full Argon2id derivation (`decisions.md` 2026-07-26, web capability set). A browser has no hardware-bound key store to wrap a third `root_key` copy under, so the security MUST-NOT is satisfied by absence rather than by policy. WebAuthn PRF is deferred (MYND-578). |
| `vault.label` (`MYL1`) | **Does not exist on web** (myne-md/myne#411). The locked picker it feeds never renders in a browser: an origin holds exactly one vault container, so the two-or-more-vaults branch that produces the picker is unreachable, and the capability is classified absent rather than pending. A browser also has no keychain to hold the per-vault `wrap_key`, so the store could not exist even where the picker did. Absence rather than policy, exactly as with `vault.quickunlock`. |
| `vault.head-state` (`MYH1`, §7) | **Exists**, in evictable OPFS, and its loss is the eviction case §6.2 describes: the device falls back to TOFU re-bootstrap and re-runs the §6.3 fingerprint compare. It remains each device's own rollback baseline; it is not reconstructible from the server, by design. |

### 9.1 "Continue where you left off" — icebox

**Icebox (`decisions.md` 2026-08-01).** Resuming the last-open note **across devices** is parked. No `last_active_note` field exists on `vault.prefs` — it was never implemented — and the Settings → Privacy toggle that appeared to gate it was a backendless mock, removed in the same change. Same-device resume is unaffected and is not this: it is the `startup_open: "last"` pref (§10.2, device-local) restoring the [workspace-state blob](protocol.md) the device already keeps.

The design is recorded here rather than deleted, because the part worth keeping is what it **rules out**. Should this be revisited, it must **not** be done by syncing `vault.workspace` (class 4 — that would leak active-edit timing): the `MYW1`-never-sync invariant is not negotiable. The shape that was designed instead was an **opt-in single field `last_active_note` (note-id only)** riding the already-synced `vault.prefs` (class 1), following the precedent that the `active_workspace` pointer lives in `vault.prefs` because prefs crash-survives — bounding the leak to a note-id plus the prefs write cadence, opt-in and coalesced. It is parked rather than shipped because the convenience is marginal against a synced presence-ish signal ("which note, when") that sits awkwardly beside the no-behavioural-metadata posture (A13), even default-off.

### 9.2 Snapshots — authoritative but local-only

`snapshots/` (per-note version history) is the one artefact that does not fit a single class cleanly: it is **authoritative** user data and it **is** in the `protocol.md` §9.11.3 backup allowlist (a restore must preserve version history), yet it is **never synced**. Syncing the per-note snapshot cadence would turn each device's local editing rhythm into a server-visible timing channel (A13) and widen what the server can observe about note history (AS6), so snapshots stay single-device by construction. This is the one deliberate exception to reading the Class-1 "authoritative ⇒ SYNC" pattern straight off the table: **`threat-model.md` §7 is normative here** ("snapshots are local-only; the sync server never receives them, so AS6 stays intact"), and the sync engine enforces it structurally — the push/pull scan only ever walks `notes/` + `attachments/`, never `snapshots/`. A device recovers its own snapshots from its own backup; they are not reconstructed from peers.

---

## 10. Conflict model

The server **cannot** decrypt or merge (A1, TB5), so all conflict resolution is **client-side and mandatory**. Detection is the push compare-and-swap (§8.1): a client pushes against a base, and a stale base is **rejected (409-like)**, forcing the loser to pull, resolve, and re-push. Resolution then differs by artefact class (§9):

### 10.1 Note bodies — keep-both

A concurrent edit to the same note resolves by **keeping both versions**: the losing version is written as a **conflict-marked duplicate note** for the user to reconcile. **Pure last-writer-wins on a note body is forbidden** — it would silently destroy an edit the server can't see. (At the head level, the two concurrent heads are version-vector-incomparable and the loser authors a merge head, §5.3; at the content level, the conflicting note becomes a duplicate.) UX for grouping conflict copies is a client concern (out of scope here).

> **Keep-both is the `MY01` (v0.1) note model.** A next-major CRDT note (`NC05`, `protocol.md` §10.7) resolves the same concurrent-edit situation by an **automatic CRDT interleave-merge** instead — both edits survive in one convergent revision, so no conflict copy is produced and the head-level merge carries the merged body rather than a keep-both duplicate. The client dispatches on the cleartext blob magic (`MY01` → keep-both, `NC05` → merge), surfaces the CRDT case only as a calm "updated from another device" hint, and the keep-both Conflicts view is `MY01`-only (`../decisions.md` 2026-08-10, ASM-6→B, #422). This clarifies the model split; it changes no wire format, identifier, or the head/VV integrity spine.

### 10.2 Singletons — post-decrypt field/set merge

Structured singletons merge **field-by-field after decryption**, in RAM (SYNC-3: the plaintext never rests outside the AEAD'd blob), with field names and value shapes following `protocol.md` §9.5.2 **exactly** — do not re-derive the codec taxonomy here, cite it.

**Revised 2026-07-13 (MYND-478; supersedes this section's original "every remaining field is scalar-LWW" posture — see `decisions.md`).** `vault.prefs` fields are normatively partitioned into two classes:

- a **shared pref** describes the *vault* — its identity, content organization, and vault-level conventions — and syncs;
- a **device-local pref** describes how *this device* presents, secures, or operates on the vault — it never crosses the merge (the local value always survives), even though the whole encrypted blob transits the server (the same bytes already leave the device inside `MYB1` backups).

The table below is the **single normative classification**. The implementation mirrors it in exactly one place, guarded by a conformance test that fails when a new prefs field ships unclassified. A future field lands with a row here in the same change.

| Field(s) | Class | Merge discipline |
|---|---|---|
| `label`, `icon` | shared | scalar-LWW |
| `archive_disabled` | shared | scalar-LWW |
| `transcription_enabled` | shared | scalar-LWW — **deliberately unlike `ai_enabled` and `attachment_ocr_enabled` below**, which are device-local. Those two gate per-device *compute* (an embedding walk, an OCR pass) or a device-local model-path override; speech-to-text runs a bundled model every client carries and is invoked one file at a time by the user, so wanting the feature at all is a vault-level preference rather than a device capability (MYND-592). **Defaults to `true`**, emitted only when `false`, so a blob predating the field decodes with it enabled |
| `ai_provider`, `ai_provider_key`, `ai_provider_model` | shared | scalar-LWW: the remote-provider fields (myne#415, ledger SYNC-15/SYNC-24). **Deliberately unlike `ai_enabled` below**, which is device-local: that one answers "should THIS machine spend its CPU on inference", a property of the machine, while naming a *remote* provider is a statement about where this vault's notes may be sent. LWW rather than any union, because a credential cannot be merged: rotating on one device must REPLACE everywhere, and **revocation propagates as an LWW write of `None`**, which is the only reason "revoke" reaches the other devices at all. A device that inherits everything but the chosen model would be configured with nothing to ask, since SYNC-24 ships no fallback model to paper over it. `ai_provider_model` is shared for the same reason `ai_provider` is and the AI **endpoint** is not: naming a model at a remote provider is a choice about this vault's provider, while an endpoint names a daemon on one machine. `ai_provider_key` is a bearer credential and must not cross the host→UI boundary (`protocol.md` §9.5.2). **This row was a quartet including `ai_provider_consent` until myne-md/myne#456**, which reclassified the consent as device-local; see its own row below |
| `daily_date_format`, `daily_folder`, `daily_template` | shared | scalar-LWW |
| `date_format`, `time_format` | shared | scalar-LWW (myne#279; the row was missing until myne-md/myne#609 added it, while five sites cited this table for these fields). How a date is printed is taste, and a device-local value would mean re-choosing it on every new device, which is the `daily_date_format` class one row up |
| `timezone` | device-local | local wins (myne#279; same omission, same fix). The right display zone is a property of where a given device IS, so a phone that travels and a computer that does not need not agree, which is the `theme` class rather than the `daily_date_format` one. Device-local is what this column says it is and no more: the local value survives the merge, while the encrypted `vault.prefs` blob carrying the zone is pushed and pulled verbatim like every other prefs field, and §10.2.1 has a newly enrolled device adopt it as a starting default |
| `new_note_location`, `new_note_location_folder` | shared | scalar-LWW |
| `attachment_compression_enabled` | shared | scalar-LWW — a deliberate divergence from the neighboring `attachment_ocr_enabled` / `ai_enabled` / `spell_enabled` cluster below: those are compute-budget switches whose effect is local and reversible, while this one gates [ingest-time image compression](../glossary.md#ingest-time-image-compression) (`protocol.md` §9.9/§9.10), an irreversible, vault-wide content-fidelity change applied to every future imported attachment — the switch must have the same reach as the effect it controls, so it syncs. **Defaults to `true`**, so it is emitted only when `false` and a blob predating the field decodes with the feature on |
| `deliberate_folders`, `archived_folders` | shared | set-union, **case-insensitive** (folded by `folderKey` per `markdown-dialect.md` §3.6.2 so `personal/` ≡ `PERSONAL/` collapse to the lexicographic-min display; sorted, deduplicated) with a **per-entry removal clock**. Revised 2026-07-19 (MYND-562, the fold) and again by myne-md/myne#613 (the removal clock, superseding "clockless"). **A removal is a stamped absence**, the same rule the decoration maps carry two rows down: removing an entry stamps `<field>/<foldedEntry>` on the removing side, and a single-sided entry is DROPPED when the absent side's clock is strictly greater than the present side's. Equal clocks keep the entry ("absent sorts lowest", the recoverable direction). **Adding an entry stamps it too**, which is not decoration: without an add stamp a re-added entry carries no clock of its own and loses to its own tombstone permanently, so a folder deleted and later refilled could never come back. |
| `ai_excluded_folders`, `cli_excluded_folders` | shared | set-union, **case-insensitive** (same fold as the row above), **monotone and clockless**: an entry present on either side survives, and a removal is never inherited from a peer. These two are **egress controls rather than preferences**, and the asymmetry is deliberate (myne-md/myne#613). `../threat-model.md` A17 rests its remote-provider mitigation on the first of them, and the shipped interface promises both absolutely. A removal clock would order un-exclusion by wall clock, so a forward-skewed device could unexclude a folder that no correctly-clocked device can restore, because a re-add stamps the smaller clock: the failure direction is note plaintext leaving the device. The monotone union can only fail closed. **The cost, stated rather than implied:** a removal is not representable, so once a second device holds an exclusion it is add-only, and removing one means removing it on every device. `cli_excluded_folders` appears in this table for the first time here; `protocol.md` §9.5.2 had always classified it as a shared set-union, and its absence from the normative table was an omission |
| `spell_languages` | shared | set-union (sorted, deduplicated) with the same **per-entry removal clock** as the row above, keyed on the **raw** code: language codes are case-sensitive, so folding them would collapse `de-DE` into `de-de` and silently drop one of two legitimately distinct entries. The folded/raw split is carried in the implementation's classification table rather than chosen at each merge site, so the stamper and the merge cannot derive different clock keys for one entry |
| `favorites`, `view_order` | shared | sequence-LWW-on-whole (the whole ordered list is replaced, never per-element merged; one clock per list) |
| `saved_views` | shared | whole-value LWW (the whole array is replaced; one clock) |
| `color_groups` | shared | whole-value LWW (the whole array is replaced; one clock) — array order IS rule precedence, so a set-union or per-key merge would silently corrupt it; whole-value LWW races it as a unit (graph-connection-ux-polish, MYND-604) |
| `folder_icons`, `item_colors` | shared | **per-key map merge** — union of keys; a key edited on both sides resolves LWW on its own `<field>/<key>` clock (revised 2026-07-19, MYND-562 — supersedes the original whole-value-LWW discipline, which dropped a concurrent edit to a *different* folder). **A removal is a stamped absence** (myne#296): clearing a key stamps `<field>/<key>` on the removing side, and a single-sided key is DROPPED when the absent side's clock is strictly greater than the present side's. Equal clocks keep the value — "absent sorts lowest", the same tiebreak the module uses elsewhere, and the recoverable direction. Without it a removal was indistinguishable from "this device never had the key", so the union restored the peer's copy and clearing a colour or resetting a folder icon was undone within two rounds. Keyed by the folded folder identity (`folderKey`, `markdown-dialect.md` §3.6.2) + note UUIDs |
| `device_names` | shared | **per-key map merge** — union of keys; a key edited on both sides resolves LWW on its own `device_names/<key>` clock. The stamped-absence rule above applies mechanically, but no clear affordance exists by design, so no removal is produced |
| `item_order` | shared | **per-key map merge** — union of container keys; the stamped-absence rule applies mechanically, though no code path removes a container key; a container reordered on both sides resolves LWW on its own `item_order/<container>` clock (MYND-596 — supersedes the sequence-LWW-on-whole discipline, which dropped a concurrent reorder in a *different* container, the exact loss MYND-562 fixed for the decoration maps above). Keyed by container path: `""` ≡ the tree root, plus canonical trailing-slash folder paths (folded by `folderKey`, `markdown-dialect.md` §3.6.2) |
| `periodic_notes` | shared | **per-key map merge**, a union of `<period>.<setting>` keys; a key edited on both sides resolves LWW on its own `periodic_notes/<period>.<setting>` clock, and the stamped-absence rule applies, so clearing one setting is a removal rather than a value the peer restores. The per-SETTING granularity is why the field is a flat map rather than a map of nested per-period objects (myne#177): a folder edit on one device and a template edit on another, to the SAME period in the same round, both survive. Shared rather than device-local because where a weekly note is filed is a vault convention, the `daily_folder` class |
| `field_clocks` | — | merge metadata, not a preference: the merged blob carries the winning clock per field (see below) |
| `auto_lock_seconds`, `screen_capture_protection` | device-local | local wins (security posture is per-device) |
| `theme`, `custom_theme`, `show_note_timestamps`, `editor_content_width`, `editor_default_view_mode`, `editor_focus_dim_inactive`, `editor_focus_typewriter`, `editor_font_family`, `editor_layout`, `editor_line_numbers`, `editor_line_spacing`, `editor_text_size` | device-local | local wins (presentation) |
| `keymap`, `editor_vim_mode` | device-local | local wins (input hardware) — a physical keyboard and a touch keyboard want different answers, so a modal-editing choice made on the desktop must not follow the vault onto a phone (MYND-313) |
| `attachment_ocr_enabled` | device-local | local wins (per-device compute budget) — image OCR (`protocol.md` §9.15, MYND-441) is CPU-heavy, and battery and thermal capacity differ per device, so turning it off on a phone must not turn it off on a desktop. Same reasoning as `ai_enabled`. **Defaults to `true`**, so it is emitted only when `false` and a blob predating the field decodes with the feature on |
| `hidden_bar_items`, `bar_items_order`, `right_panel_active_tab`, `right_panel_hidden_tabs`, `right_panel_tab_order`, `editor_toolbar_order`, `editor_toolbar_hidden`, `editor_slash_order`, `editor_slash_hidden` | device-local | local wins (screen-size-dependent UI layout) |
| `startup_open`, `startup_open_note`, `active_workspace` | device-local | local wins (session/startup behaviour; `active_workspace` points at the device-local `MYW1` artefact) |
| `ai_provider_consent` | device-local | local wins, always. Reclassified from shared/scalar-LWW by myne-md/myne#456. It carries a **provider name**, not a boolean, and the gate compares it for equality against the active provider, so a consent that races behind a provider switch is unusable rather than wrongly satisfying the new selection. **Why it stopped travelling.** Its old row recorded the cost of sharing it as accepted: a newly enrolled device inherited the selection, the consent AND the key, and began sending without anyone at that device having seen the consent screen: the invariant held at ACCOUNT scope rather than device scope (`../threat-model.md` §5, ledger SYNC-22). What made that acceptable was the absence of a remedy: a device with a provider and a key but no consent would be configured and silently refused, with no screen anywhere to fix it. myne-md/myne#456 builds that screen on mobile, which is what expired the argument. **The SPLIT is the property, not the class.** The key stays shared, so a revoke still reaches every device; only the approval is per-device. An implementation that moved the whole cluster to device-local would satisfy the letter of this row while breaking revocation. Like every device-local field it carries no clock into the merged map, so a later merge cannot resurrect it as a shared value |
| `last_backup_at`, `paired_extensions`, `ai_enabled`, `spell_enabled` | device-local | local wins (device state / device capability) |
| `developer_mode` | device-local | local wins (device state / device capability) — gates a device-local model-path override (`protocol.md` §9.5.2, developer-mode MYND-593), so a synced flag would read "on" on a device with no override behind it. Same reasoning as `ai_enabled` / `attachment_ocr_enabled`. Membership broadened by myne-md/myne#181 (CLI terminal access, vim mode) **without** changing this row: every setting it gates is device-local too, including `editor_vim_mode` on the input-hardware row below — syncing the gate would half-undo that field's own classification |

Two rows are **deliberate reclassifications** of this section's original posture: `hidden_bar_items` (was set-union synced) and `active_workspace` (was scalar-LWW) are device-local now — the first is screen-size-dependent bar layout, the second points at an artefact (`vault.workspace`, class 4) that never syncs. And one field the original posture silently misclassified is now honest: `last_backup_at` is inherently per-device.

`editor_toolbar_order` / `editor_toolbar_hidden` — and, from the same MYND-336 change, their slash-menu twins `editor_slash_order` / `editor_slash_hidden`, plus `editor_vim_mode` (MYND-313) on the input-hardware row — join their rows **as a gap closure, not a reclassification**: all five landed in `vault.prefs` and were classified in the implementation but never here, so their merge behaviour was undefined rather than wrong. The four command-layout arrays are device-local for the same reason the rest of the bar-layout row is: a toolbar or slash-menu layout is a function of the screen it is laid out on. `editor_vim_mode` is device-local for the `keymap` reason instead — modal editing is an input-hardware choice, not a vault convention. That also settles the cross-client question MYND-555 raised — a phone's above-keyboard format bar and a desktop's floating toolbar are the same *preference* on incomparable form factors, so the field must not propagate. **Consequence, stated so it is not discovered later:** desktop↔desktop toolbar layout no longer converges either. That is the intended reading of "screen-size-dependent", not an omission — a 13" laptop and a 32" display are as incomparable as a phone and a laptop.

Because the fields are device-local, each client interprets the stored ids against **its own** vocabulary, and the two vocabularies legitimately differ (mobile's bar carries `undo` / `redo` / `heading1` / `heading2`; desktop's carries `strike` / `highlight` / `numberedList` and dropdown clusters). Divergence is harmless in normal operation — the value never crosses. The one path that *can* carry ids across clients is a **backup restore** (`vault.prefs` is inside `MYB1`, class 1): a resolver MUST therefore drop ids absent from its own vocabulary and append its own canonical remainder, which is already the required behaviour for a stale id from the same client's older build. No id is ever renamed or removed silently — the vocabulary is governed on-disk data the moment a vault persists a layout (`protocol.md` §9.5), so a rename is a migration event.

**Field clocks.** Every shared LWW field (scalar, sequence-on-whole, whole-value, each per-key map entry (`device_names/<key>`, `item_colors/<key>`, `folder_icons/<key>`, `item_order/<container>`, plus, since myne-md/myne#613, each entry of a CLOCKED set-union field: `deliberate_folders/<foldedEntry>`, `archived_folders/<foldedEntry>`, `spell_languages/<rawCode>`. `ai_excluded_folders` and `cli_excluded_folders` are NOT in that list: they are the two monotone egress controls of the row above, they are never stamped, and a port that stamped and honoured a removal clock on them would unexclude a folder handed to it by a forward-skewed peer, which is the direction the row exists to exclude)) races on its own **field clock**: an epoch-milliseconds timestamp in the `field_clocks` map inside the encrypted payload (`protocol.md` §9.5.2), stamped by the setter that last changed the field. The newer clock wins; **an absent clock counts as 0** (the §11.4 "absent `updated_at` = `created_at`" analogue; this also defines migration: a pre-feature blob loses to the first clocked write, and a subsequent edit repairs everywhere); equal clocks tie-break **byte-lexicographically toward the greater value** (comparing the values' **§9.5.2 canonical encodings**: for a nested-object field such as `saved_views` this means the codec's canonical byte form, never an implementation's native serializer output, or independent implementations could deterministically pick opposite winners; with one refinement: an absent/unset value sorts **below** every present value, so a device that set a preference never loses it to a device that left it unset in a clockless tie), exactly like the §11.4 catalog `filename` rule, so both sides converge independently with no coordination. **Set-union fields race per ENTRY** on `<field>/<entry>`, where the entry key is the folded folder identity for the two clocked folder sets and the raw code for `spell_languages` (myne-md/myne#613, superseding this sentence's original wording, which read `Set-union fields are clockless (union is conflict-free).`). The union half is still conflict-free and unchanged: an entry either side holds survives. What the clock adds is the one thing a union cannot express, which is a **removal**. Without it a deletion is an absence, indistinguishable from "this device never had the entry", so the peer's copy is restored by the next union and the deletion undoes itself within two rounds, with no concurrency required. That is the same defect myne-md/myne#296 fixed for the per-key maps, and it was left standing here until every folder a note lands in began entering `deliberate_folders`, which turned it from a defect affecting hand-made folders into one affecting every folder delete. An entry held by both sides carries the greater of the two clocks forward, so a later removal on either device has something to beat. **A `<field>/<entry>` clock is retained even when NEITHER side holds the entry**, and retention is indefinite: it is the tombstone, and dropping it lets a third device that still holds the entry at an older clock resurrect what two others deleted. A horizon was considered and rejected, because a device offline longer than the horizon is exactly the case the clock exists for. The per-key MAP rows below do not yet carry this rule; their orphan clocks are dropped, which is recorded debt rather than a decision. Wall-clock skew is accepted for the same reason it is accepted for catalog filenames: prefs are non-load-bearing, and a skewed winner is repaired by the next genuine edit. The merge is deterministic and commutative on the shared subset: `merge(a,b) = merge(b,a)`.

**A mixed fleet does not converge on a removal, and the direction of that is worth stating.** A reader that predates the per-entry clock accepts every byte written under this rule: no field is added, no magic changes, and `field_clocks` is an existing `string -> u64` map whose new keys decode like any other. What such a reader does NOT do is carry them: it builds its merged clock map fresh and its set-union arm inserts nothing, so its output drops every `<field>/<entry>` tombstone, and its clockless union then restores the deleted entry from its own copy. The consequence is that **a folder delete does not converge until every device is upgraded**: an upgraded device deletes, a legacy peer's merge strips the tombstone and re-adds, and the entry comes back on both. Nothing detects the mixed state and nothing reports it, so an implementation shipping this rule owes its users the sentence rather than the diagnosis. It is not data loss in the note plane, and the repair is automatic once the last device upgrades: the next delete has a tombstone nothing strips.

#### 10.2.1 How `vault.prefs` syncs

`vault.prefs` is a synced singleton outside the vault-head manifest (§4.2), exactly like the attachments catalog, and rides the same machinery:

- **Identity.** Its reserved sync blob-id is `prefs_sync_id = DeriveSubkey(root_key, "prefs-sync-id")[0..16]` (`protocol.md` §3.4) — deterministic across devices, indistinguishable from a note UUID to the server.
- **Transport.** The at-rest `MYP1` blob is pushed/pulled verbatim on the generic `/sync/blob` channel with CAS. **Zero server changes**: the server stores an opaque blob under an opaque id.
- **Push gate.** A device pushes only when the hash of its **shared subset** (the shared fields + their clocks, canonically encoded) differs from the last state it pushed or adopted — a purely device-local edit generates **no traffic** (A13 hygiene). The comparison baseline lives **in RAM only, never at rest**: persisting an unkeyed digest of decrypted shared prefs would hand a filesystem observer a confirmation oracle over the vault's label/folder names (the plaintext-at-rest class SYNC-3 forbids). A nonce short-circuit backs it: a local blob whose outer nonce still equals the synced baseline's is provably unchanged (every prefs write re-encrypts under a fresh nonce), so the common no-change cycle consults no plaintext-derived state at all. A lost baseline (app restart after an unsynced device-local edit) degrades to at most **one redundant push** — never a wrong merge.
- **Conflict.** A stale push is CAS-rejected; the device pulls, runs the §10.2 merge post-decrypt, applies the result through the same single write path user edits use (disk → session cache → change event, so open UIs refresh), and re-pushes.
- **Initial publish.** A device that finds **no** prefs blob on the server pushes its local blob unconditionally once — so a vault whose owner never changes a shared pref still delivers its identity to the next enrolled device. (One repair-only corner: a vault with no `vault.prefs` file at all has nothing to publish yet — the reference implementation eagerly writes the file at vault creation, so this arises only after manual deletion — and its first prefs write triggers the publish.)
- **Enrollment seed.** Enrollment adopts the server's prefs blob **wholesale** as the device's initial `vault.prefs`, device-local fields included as starting defaults, **except two that are cleared and re-encoded before the write**: `ai_provider_consent` and `ai_enabled` (myne-md/myne#456). Both carve-outs exist for the same reason and it is a security one rather than a preference: a device that inherited a consent it never gave would begin sending this vault's note text to a named remote provider with nobody at that device having seen the consent screen, and `../threat-model.md` TB13 cites this seed path by name as one of the two that had to close for the per-device consent claim to hold. If the server's blob is absent, the device proceeds on its own defaults. After the seed, only merges run: steady-state sync never wholesale-adopts.
- **Rollback bound.** Unchanged from `threat-model.md` §7: a malicious server can replay an older prefs blob; every shared field is non-load-bearing (the protective-envelope clamps stay client-side and no clamped field is shared), so the bound stays acceptable.
- **Pre-write verification (§11.3).** A pulled prefs blob is subject to the same header-`content_nonce` check as a note, on the enrollment seed as well as the steady-state merge, and `decode_prefs_blob` succeeding does not discharge it. Note the difference from the rollback bound above: a *replay* serves a coherent older revision, whereas an unverified adopt lets the server make the client durably record a baseline for a revision it does not hold.

`vault.dictionary` merges as a **set-union** of its word sets. That union is **clockless, and therefore cannot express a removal** (myne-md/myne#613): a word deleted from the personal dictionary on one device is restored from the peer copy on the next union, within two rounds and with no concurrency needed. This is the third instance of one defect, after the per-key maps (myne-md/myne#296) and the `vault.prefs` set fields (myne-md/myne#613, the row above). It is **not** fixed here: `vault.dictionary` carries no clock map at all, so closing it is a `dict_format_version` bump rather than a merge change. Tracked as myne-md/myne#640, which is what makes this sentence checkable rather than a claim about somebody's intentions. The word "conflict-free" is struck rather than left standing, because that exact wording over the prefs sets is what kept the second instance invisible until a folder delete started undoing itself; the `vault.attachments` catalog merges **per-entry by attachment-id**, a union of entries (the core fields are immutable, content-addressed), refined by the **attachment-catalog-tombstone rules of §11.4** (deletion markers, the revival window, and the `filename` scalar-LWW are the only per-entry reconciliation this merge performs).

#### 10.2.2 How `vault.themes` syncs

`vault.themes` (`MYT1`, `protocol.md` §9.21) is a synced singleton outside the vault-head manifest (§4.2), riding the same machinery as `vault.prefs`:

- **Identity.** Its reserved sync blob-id is `themes_sync_id = DeriveSubkey(root_key, "themes-sync-id")[0..16]` (`protocol.md` §3.4) — deterministic across devices, indistinguishable from a note UUID to the server. An **identifier** derivation, not a KEK; the themes KEK stays `custom-themes-key`.
- **Transport.** The at-rest `MYT1` blob is pushed/pulled verbatim on the generic `/sync/blob` channel with CAS. **Zero server changes** — an opaque blob under an opaque id.
- **Merge — per-theme-name, palette LWW within a name.** The inner map (`protocol.md` §9.21.2) keys each theme by name and carries **per-name clocks**, so two devices that concurrently add *different* themes both keep theirs. Only a concurrent edit of the **same** name reconciles, and it does so by greater `updated_at` over the **whole palette** — a palette is one coherent design, so it is never merged token-by-token (that would yield an incoherent result).
- **Deletion — tombstones under the causal-version guard (myne-md/myne#405).** Deleting a theme sets `deleted_at` rather than dropping the key; otherwise the theme would resurrect from another device's copy. Reconciliation reuses the attachments-catalog tombstone rules of §11.4 verbatim: each entry carries a monotonic **causal `version`** (`protocol.md` §9.21.2; on any local mutation of a name, `version = max(versions this device has observed for that name) + 1`, absent = 0), and the winner is the entry with the **greater `version`** — a deliberate re-add observes the delete and so carries a higher `version` than the tombstone, while a stale live copy that never observed the delete carries a lower one and loses to it. **On an equal-`version` tie** (a true concurrent add-vs-delete) the **tombstone wins** (remove-wins — the resurrection guard's intent, preserved). Tombstone vs tombstone keeps the greater `version`, then the greater `deleted_at`.
- **Commutativity + associativity — a TOTAL order over `version` first, normative.** The merge is "pick the maximum under a total order," which is commutative, idempotent **and associative** by construction. The order is **`version` first**, then — only to break an equal-`version` tie — over **every retained field**: tombstone-ness (remove-wins) first, then tombstone-vs-tombstone on `deleted_at` then `created_at`/`updated_at`; live-vs-live on `updated_at` then `palette` then `created_at`. Leaving any field out of the tie-break makes the **argument order** the tie-breaker (a tombstone's palette scrub, `protocol.md` §9.21.2, does **not** equalise `created_at`/`updated_at`), so the tie-break must stay a total order. The failure this closes is not cosmetic: the push is gated on `merged == remote`, so two devices that merge the same inputs to different bytes each see a mismatch and re-push forever — the **CAS ping-pong** §10.3 avoids by the same means.
- **Associativity — closed (myne-md/myne#405).** With the causal `version` as the primary key, the merge is a join over a total order, so `(a ∨ b) ∨ c = a ∨ (b ∨ c)` for every triple — the three-device ping-pong the earlier wall-clock guard admitted (`L1{created:10,updated:10}`, `T{deleted:5}`, `L2{created:1,updated:100}`, which merged to `L2` or `L1` by pairing order) now converges under any pairing order, because the greater `version` decides it regardless of order. This closes the shared tombstone-guard limit that §11.4 inherited verbatim (the "richer tombstone" the earlier note called for **is** the `version` field); both families are fixed by the same field, and the property is pinned by the §5.7 associativity `proptest` and the `myne-test-vectors` merge vectors.
- **Tombstone GC — none.** A themes tombstone is a name plus a timestamp and a vault holds single-digit theme counts, so the horizon-GC of §11 is unnecessary here; the map stays trivially small.
- **Rollback bound.** As with prefs: a malicious server can replay an older themes blob. A custom theme is a cosmetic, non-load-bearing surface (`threat-model.md` — validated, not sandboxed), so the bound stays acceptable.
- **Pre-write verification (§11.3).** Same check, and this family is the one where skipping it costs most: the local store decodes to EMPTY when it cannot be read, so an unverified adopt of junk satisfies the merge-equals-remote condition and replaces the live `vault.themes` with that junk.

### 10.2.5 `vault.chats` + `chats/<id>`: the AI conversations pair (myne-md/myne#675)

The AI chat history is a storage PAIR, and each half syncs through the mechanism its shape demands:

**The catalog singleton (`vault.chats`, `MYM1`)** rides the generic `/sync/blob` channel under the reserved id `chats_catalog_sync_id = DeriveSubkey(root_key, "chats-catalog-sync-id")[0..16]` (`protocol.md` §3.4): the themes pattern. Merge is the **per-id causal join** of §10.2.2 / §11.4 verbatim: the greater `version` wins, an equal-`version` tie is broken by a total order with remove-wins tombstone-ness (delete beats a concurrent append; the appended turns are discarded at merge, a cost recorded in `decisions/ai/0581` with the confirm modal as the user-facing guard), and the join is commutative, idempotent and associative by construction.

**The per-conversation files (`chats/<id-hex>`, `MYJ1`)** push and pull as id-generic blobs under the conversation id's own 16 bytes as the sync blob-id (the attachment-id pattern: the server cannot distinguish a conversation id from a note UUID, and no separate `SubkeyRole` exists). The merge for one conversation's turn list is NEW, and it is an append-ordered shape rather than a per-key map: **keep the common prefix verbatim, keep BOTH divergent suffixes, order the suffix turns by the turn-id total order** (lexicographic on the id string; the id scheme embeds a client discriminator, so cross-client collisions cannot arise and the order is argument-independent). No turn is ever dropped; a turn present on both sides is one turn. The merge is commutative, idempotent and associative by construction, which is what closes the §10.3 CAS ping-pong.

**Enrollment seed.** Per-conversation blobs arrive on enrollment like attachment blobs (the adopting device pulls the catalog, then the conversation files it names). The catalog seeds wholesale like every other synced singleton: including its tombstones, so a conversation deleted before a device enrolled does not resurrect there.

**Rollback bound.** A malicious server can replay an older catalog or an older conversation file. Unlike the cosmetic singletons this family is **load-bearing user content**, so the read side does NOT fall back to empty (the `report-don't-empty` rule, `protocol.md` §9.23.3) and a replay is bounded only by the same accepted singleton-rollback limit the prefs family carries: an older conversation state can be re-served, and the next write re-bumps the causal version. No cross-round fork consistency claim is made for the catalog beyond what the singleton plane already gives.

**Tombstone GC: none** (the themes disposition: the catalog stays trivially small).

**Server-side reclaim.** The catalog tombstone erases every device copy, but the server ciphertext needs its own record: on delete the deleter queues the conversation id in `<vault>/pending-chats-tombstones`, and the next push sends an empty-ciphertext blob-plane tombstone record for it (the attachment-tombstone shape, §11.4), so horizon-GC reclaims the server copy. A queued id whose row is live again is stale (dropped, never pushed); an id with no synced baseline has no server-side record to reclaim (dropped, the migration rule). Without this the catalog tombstone orphans the server copy permanently: never downloaded, never classified, never deleted.

### 10.2.6 The agent-memory pair (`vault.agent-memory` + `memories/<id>`), myne-md/myne#697

The personal-agent memory (`protocol.md` §9.25/§9.26) syncs through the chats pair's mechanism, each half through the mechanism its shape demands. **The whole plane is behind the `ai_enabled` gate**: a device with the opt-in off runs no memory phase and pushes/pulls nothing for these ids, exactly as a vault with no conversations stays chats-silent; the gate is per-device, so a vault's memory still syncs among the devices that have AI on.

**The catalog singleton (`vault.agent-memory`, `MYN1`)** rides the generic `/sync/blob` channel under the reserved id `agent_memory_catalog_sync_id = DeriveSubkey(root_key, "agent-memory-catalog-sync-id")[0..16]` (`protocol.md` §3.4): the themes/chats pattern. Merge is the **per-id causal join** of §10.2.5/§11.4 verbatim: the greater `version` wins, an equal-`version` tie is broken by a total order with remove-wins tombstone-ness (delete beats a concurrent write; a concurrent model-edit of the same entry is resolved by the tie-break's `updated_at`/text ordering, the `chats_entry_tie_break` shape), and the join is commutative, idempotent and associative by construction.

**The per-entry files (`memories/<id-hex>`, `MYX1`)** push and pull as id-generic blobs under the entry id's own 16 bytes as the sync blob-id (the attachment-id/conversation-id pattern: the server cannot distinguish a memory id from a note UUID, and no separate `SubkeyRole` exists). There is **no per-file merge**: an entry is one mutable text, not an append list, so a pull adopts the bytes of the catalog-winner's version (the conversation-file cadence: content-addressed by id, the catalog owns causal ordering, and the §10.2.5 turn-merge has no analogue because nothing about an entry is append-only). A concurrent same-entry edit converges when the catalog row it wrote under wins the tie-break; the loser's bytes are then adopted-over, which is the same remove-wins cost the chats catalog records in `decisions/ai/0581`, here bounded by the one-write-per-run rule (`protocol.md` §9.26.2) rather than by a modal.

**Enrollment seed.** Per-entry blobs arrive on enrollment like attachment/conversation blobs (the adopting device pulls the catalog, then the entry files it names). The catalog seeds wholesale like every other synced singleton: including its tombstones, so an entry deleted before a device enrolled does not resurrect there.

**Rollback bound.** As with the chats pair: this family is load-bearing user content, so the read side does NOT fall back to empty (the `report-don't-empty` rule, `protocol.md` §9.25.3) and a replay is bounded only by the same accepted singleton-rollback limit the prefs family carries: an older memory state can be re-served, and the next write re-bumps the causal version.

**Tombstone GC: none** (the themes disposition: the catalog stays trivially small; the client layer's 100-live-entry bound sits below the catalog's 1-MiB cap by two orders of magnitude).

**Server-side reclaim.** The chats queue shape, one plane over: on delete the deleter queues the entry id in `<vault>/pending-memory-tombstones`, and the next push sends an empty-ciphertext blob-plane tombstone record for it (the attachment-tombstone shape, §11.4), so horizon-GC reclaims the server copy. A queued id whose row is live again is stale (dropped, never pushed); an id with no synced baseline has no server-side record to reclaim (dropped, the migration rule). Without this the catalog tombstone orphans the server copy permanently.

### 10.2.7 `vault.personality`: whole-value LWW singleton, myne-md/myne#697

The personality singleton (`protocol.md` §9.27) rides the same machinery as `vault.themes`, with ONE merge rule and none of a map's structure:

- **Identity.** Its reserved sync blob-id is `agent_personality_sync_id = DeriveSubkey(root_key, "agent-personality-sync-id")[0..16]` (`protocol.md` §3.4): deterministic across devices, indistinguishable from a note UUID to the server. An **identifier** derivation, not a KEK; the personality KEK stays `agent-personality-key`.
- **Transport.** The at-rest `MYZ1` blob is pushed/pulled verbatim on the generic `/sync/blob` channel with CAS. **Zero server changes**: an opaque blob under an opaque id.
- **Merge: whole-value LWW on the canonical encoding.** The personality is one coherent voice (`protocol.md` §9.27.3), so two devices that concurrently edit reconcile by the greater `updated_at` over the WHOLE blob (never directive-by-directive, the themes-palette rule verbatim). There are no per-directive clocks, no tombstone rows and no field clocks: the discriminator is the greater max `updated_at` over the decoded whole value (ties go remote), and the CAS gate closes the loop. Wall-clock residual, stated not smoothed: the key is client timestamps, not a causal version, so a device with a future-dated clock wins every future merge until a peer writes past it. Sync peers are the user's own authenticated devices (not an attacker surface), and the v0.1 inner schema is frozen, so a causal counter waits on a schema generation that does not exist yet; until then a skewed clock heals by writing once from a correct clock.
- **Deletion = absence, synced as a tombstone.** Clearing every directive removes the file (the omit-when-empty rule, §9.27); the next push carries a tombstone record against the last synced nonce, so peers drop their copy instead of resurrecting it. Without the tombstone the server copy would come back on the next pull.
- **Rollback bound.** As with prefs: a malicious server can replay an older personality blob. The cost is an older voice, self-healing on the next edit, and bounded by the same accepted singleton-rollback limit.
- **Gate.** Behind `ai_enabled` (device-local): a device with the opt-in off runs no personality phase and pushes/pulls nothing for this id, exactly as §10.2.5 states for the chats plane. A copy stored during an earlier opt-in era stays on disk unread (it is Class-1 vault content); it is simply not read into any system turn until that device's own opt-in is on.

### 10.3 `vault.meta` — bespoke merge

`vault.meta` (class 2) is **not** field-merged. It carries two independently-wrapped copies of `root_key` (password-side and recovery-side, `protocol.md` §9.3). A concurrent change on one device (e.g. a password change rewrapping the password-side copy) must **preserve the recovery-side wrapped key** — a naive LWW would let one device's `vault.meta` strand recovery on another. The merge takes the newest password-side wrap while keeping a valid recovery-side wrap, and the KDF-params/`account_number_hash`/`items_key_id`/itemsKey-wrap invariants (which must agree across devices) are validated, not overwritten — a divergent invariant is **refused**, never papered over. (`root_key` is a single per-vault random value, not password-derived; every device holds the *same* `root_key` by unwrapping the same synced `vault.meta`, so the merge only ever reconciles the *wraps* of one shared key — never two different keys. A password change rotates only the password-side wrap; `root_key` and itemsKey are untouched, so notes stay readable and an already-unlocked session is unaffected — only the next unlock uses the new wrap.)

**Reconcile mechanics (how the merge is driven).** A credential change pushes the new `vault.meta` to the server immediately (best-effort; an offline failure leaves a device-local `vault.meta-dirty` marker). Each sync cycle then runs a **meta phase** independent of the head/blob plane (`vault.meta` is never head-committed): the device does an authed `GET /vault.meta` and compares the server copy against a device-local **baseline** (the SHA-256 of the `vault.meta` it last saw as synced). This distinguishes *only I changed since the baseline* (server unchanged → push my copy) from *the server also changed* (someone else rotated → a genuine concurrent change). The concurrent case merges with a **deterministic, commutative tiebreak** — the greater `enc_root_key_password` (byte-lexicographic) wins — so both devices independently pick the same winner and converge with **no server-side version counter and no ping-pong** (CRDT-style, exactly like the §10.2 attachments-catalog merge). A device with no local change simply adopts the server's copy (after validating the invariant). The loser of a concurrent password change finds only the winning password valid afterward — the deterministic, expected resolution of two simultaneous credential rotations.

**The membership field is device-local, and the local value always survives.** The sealed vault
membership field (`vault.meta` §9.3.1) is classified **device-local** in this bespoke merge: it is
**not** one of the invariants the merge validates, and it is **not** reconciled across devices. When
the merge produces a winner, the winning device's membership field is **not** adopted by the loser;
each device keeps the membership field it already held, and a device that had none keeps none. The
reason is the account/vault split (`decisions.md` 2026-09-07): grouping is a per-device
organisational choice, not a vault property, so two devices grouping the same vault differently must
never produce a conflict surface and must never converge. The same holds on the pure-adopt path (no
local change): the adopted bytes carry the local field transplanted in, never the server's, and the
baseline advances to what was written. The field is carried inside the
`vault.meta` blob (so it travels with the credential wraps), but its *value* is local-wins: a
divergent grouping across devices merges silently, with each device preserving its own. No new
conflict UX is reachable from this field, and the merged blob stays well-formed for both generations
(the field is an `NTV5`-only extension, `vault.meta` §9.3.1; an `MYV1` blob never carries it).

**The one exception: the 0x02 roster extension is SHARED** (b2b-identity-substrate,
`decisions/protocol/0592`). The membership field's `reserved` byte `0x02` shape (`vault.meta` §9.3.1)
carries the vault roster, which is a **shared** fact, not a per-device organisational choice, so it
is union-merged with the attachments-catalog §11.4 causal-join pattern (greater `version` wins,
equal-version tie remove-wins) exactly as §10.2 classifies a shared member. The split is inside the
single membership field: the 0x00/0x01 single-account half keeps the device-local rule above, and
only the 0x02 roster extension converges. The roster merge runs at the **caller** that holds the
unlocked `root_key`; the merge function itself sees only opaque ciphertext, so it cannot open the
envelopes and is handed the already-decrypted rosters.

**The `NTV6` generation replaces that envelope with an owner-signed roster and a
group-key epoch** (`decisions/protocol/0594`, `protocol.md` §9.3.2). A merge between
two `NTV6` `vault.meta` blobs MUST accept a roster whose signed `group_key_epoch` is
**strictly greater** than the local one, MUST **refuse an equal epoch** rather than
tie-break (two conflicting owner-signed rosters at one epoch cannot both be
canonical, and picking one would let the server choose), and MUST **refuse a lower
epoch** as a rollback. A retired epoch is recorded by an owner-double-signed
`myne.group-retirement v1|` record (`protocol.md` §9.3.4) that carries no timestamp,
so the server can neither forge a retirement nor order one against a removed
member's package stream. **Live propagation of a new epoch is not delivered by the
local rotation model** in this branch: the removing device's `vault.meta` is ahead
of its peers, and nothing here carries the new epoch to them (Grill 4).

**Per-person private AI profiles ride a separate plane.** A `profiles/<profile-id>`
blob (`MYY5`, `protocol.md` §9.28) is keyed from the person's own phrase and is
**never** a member of the shared group manifest: its existence there would disclose
one person's private AI use to the other members. The person-private sync plane
(which authenticated session carries it) is Grill 4 work alongside person-scoped
server auth; until then a profile is local to the device that wrote it.

---

## 11. Deletion & tombstone horizon-GC

### 11.1 Deletion is a tombstone version, not an absence

A note deletion is a **`deleted`-marked new encrypted version** — a fresh `.myn` version with its own `content_nonce`, carried in the vault-head manifest until garbage-collected (§4.2). It is **not** "absent on disk → drop": the §9.6.4 local-reconcile rule (a manifest entry absent from disk → delete it locally) is **overridden for sync**, because under sync, "absent" is ambiguous between "deleted elsewhere" and "not yet pulled here". Without an explicit tombstone, a device that was offline at delete time would treat the deletion as a missed write and **resurrect** the note (the Cassandra-zombie failure). The tombstone is the same nature as Myne's existing `trashed:` / `archived:` managed-frontmatter pattern: a marked version, the opaque version counter advancing, the server never learning the "deleted" meaning (AS6 / zero-knowledge preserved).

A tombstone record is superseded by content: a push that CAS-advances the record's version past the tombstoned final version (a legitimate concurrent-edit resurrection racing the delete) **clears the server-side tombstone record and any Layer-2 reclaimed mark** — the blob is live again and MUST NOT be reclaimed off the stale tombstone (a reclaim keyed to a superseded tombstone would destroy the live body).

**Delete-vs-edit on a CRDT (`NC05`) note is remove-wins, decided BEFORE the merge (normative; myne-md/myne#431).** A `NC05` note's content is one Automerge `Text` (`protocol.md` §10.7) and its deletion is, as above, a `deleted:` marker in the managed frontmatter — so the deletion lives in the string the CRDT carries rather than in the CRDT itself. A client MUST therefore resolve a divergent pair by inspecting both revisions' `deleted:` markers **first**, and MUST NOT merge the documents when either side carries one:

- **Either side tombstoned → the tombstone wins**, unchanged and whole; the concurrent edit is discarded. This is the same remove-wins rule §11.4 and §10.2.2 apply to the attachments catalog and the themes map, and it is chosen for the same reason: resurrecting content the user permanently deleted is the worse of the two failures.
- **Both sides tombstoned →** the greater `deleted:` value wins; ties break over a **total order on retained content** (`deleted:`, then the note text, then the document heads). Every component is symmetric in the two revisions, so the two devices — which hold the same pair with the local/remote labels swapped — MUST select the same winner.
- The winning blob is adopted **verbatim**. Re-sealing it would rotate `content_nonce` for a revision neither side changed, re-running the §10.2.2 CAS ping-pong.

Merging instead of deciding is not a lesser form of the same answer, it is a different and wrong one: the two revisions' managed-frontmatter blocks overlap, so the interleave **fabricates field values neither device ever wrote** (an observed case blends one device's `deleted:` with the other's `updated:` into a third, well-formed timestamp). A reader cannot detect that, because the result parses. `MY01` notes are unaffected — they keep §10.1 keep-both.

### 11.2 Hybrid horizon-GC

A tombstone is garbage-collected by **one rule**: it is dropped once **every device counted active within the horizon has acked it** — its sync cursor (§8.2) has advanced past the delete-version. This is the per-device-cursor-ack discipline, not a bare grace-period drop.

- A device that falls behind the horizon is dropped from the must-ack set — **soft-retired** (reusing the AS16 device-retirement mechanism that revocation needs anyway, so this is not new machinery).
- A soft-retired device that returns **cannot resume incrementally**: it must run a **full-reconcile** against the authoritative manifest (§11.3). Its local-only notes do not silently resurrect — they fall to a §10 keep-both conflict copy.
- The **horizon is month-scale (90–180 days)**, not days. The cost is asymmetric: an over-long tombstone is a tiny `(uuid, final_version, tombstone_marker)` meta record; too short a horizon forces a full-resync. In the common case (all devices online within the window) a tombstone is collected well before the horizon via the per-device acks; the horizon only bites an abandoned device.

### 11.3 Server-side reclamation (two layers)

Two distinct layers, so the server never learns "deleted":

1. **Resurrection-proof, client-visible** — the `deleted`-marked version (§11.1); a device "acks" by advancing its cursor past it.
2. **Storage reclamation** — past the horizon, the server may drop the ciphertext body and keep only `(note_uuid, final_version, tombstone_marker)`. The server learns only that a uuid reached a final version, never that it means "deleted" (AS6 preserved).

Post-GC (the uuid fully purged from the manifest), a returning-past-horizon device is in **full-reconcile** mode (§11.2) and will not resurrect a vanished note — so resurrection is head-protected pre-GC (§4.2) and full-reconcile-protected post-GC. A malicious server's attempt to *withhold* a tombstone (hide a deletion) is the §5.5 withholding case: caught in-band if it is the requesting device's own deletion, best-effort otherwise.

**Reclaim floor vs. pagination (normative).** Layer-2 reclamation advances a per-vault **reclaim floor** (the highest change-position whose tombstone body was dropped); a plain incremental `pull(cursor)` whose cursor is below the floor is rejected (`cursor_expired`) to force the §11.2 full-reconcile. But a full-reconcile is itself a paginated walk of the whole manifest from cursor 0, and a vault larger than one pull page advances through intermediate cursors that may legitimately sit **below** the floor. Such a walk MUST therefore carry an explicit **reconcile flag**, and the server MUST exempt a reconcile-flagged pull from the `cursor_expired` floor check — otherwise the page-2 request of the reconcile walk is itself rejected and the device wedges at `cursor_expired` forever, never catching up (the device has acked the floor as a stale high-water mark, so horizon-GC's must-ack gate does not protect it). The reconcile walk reconstructs deletions from manifest-absence (§11.2), so it needs no replayable tombstone history and the exemption preserves resurrection-protection.

**Reclaimed-record visibility (normative).** A Layer-2-reclaimed record is **absent, not empty**, on every read surface:

- The server MUST **omit** reclaimed records from every pull page — plain incremental *and* reconcile-flagged alike — while the returned cursor MUST still **advance across** the omitted positions (otherwise a device draining a window whose highest change-positions are all reclaimed lands below the reclaim floor and 410-loops forever). A page MAY therefore legitimately return zero records with an advancing cursor.
- A ciphertext fetch for a reclaimed record MUST **fail closed** (`410` `blob_reclaimed`), never succeed with an empty body: a zero-length 200 is indistinguishable from ciphertext to a blind client and was observed destroying live local notes.
- A client MUST verify a downloaded blob's header `content_nonce` against the pulled record **before** any local mutation (the disk write *and* the baseline adoption); on any mismatch — empty, truncated, junk, or wrong-nonce bytes — it skips the record with **no local mutation** and keeps the prior baseline authoritative.
  - **This binds every synced blob, not only notes.** The rule was first written for the per-note path and said "a downloaded *note's*", which read as note-scoped and left the synced singletons — the `vault.attachments` catalog (`MYC1`), `vault.prefs` (`MYP1`) and `vault.themes` (`MYT1`) — with no pre-write check at all. They need it *more* than notes do, not less: §4.2's pre-decrypt manifest layer explicitly does not cover them (they sit outside the head), so this is their only defence. Decoding the bytes successfully is **not** a substitute — a genuine older revision replayed under a newer record's nonce decodes perfectly and is precisely what the check exists to catch.
  - **This binds a batch fetch too, and gains a second failure mode there.** On a multi-id fetch (`server-protocol.md` §3.3) a reclaimed record is reported by **omission from the payload plus an explicit per-id code**, never as a payload entry carrying empty bytes. And a client MUST NOT synthesize a body for an id the response accounted for **nowhere**: a lookup that defaults a missing key to empty bytes is the same destructive shape as the empty-`200` above, arrived at through a different door and invisible to the status check that catches the first one. The unaccounted id stays queued and is re-requested.
  - **"No local mutation" includes a baseline self-heal.** A phase that heals a missing CAS base on the no-changed-record path MUST NOT do so for a record it just refused; adopting a refused record's advertised nonce is the baseline half of the mutation this rule forbids.
  - The failure this prevents is not merely a wasted download. A client that adopts unverified bytes records the nonce the server *advertised* while the file on disk carries a different one, so every later cycle re-classifies the record as changed and re-adopts it. When the served bytes additionally lack the family magic, the local nonce read is empty, the push side has nothing to send, and the blob can never heal — the vault keeps the served bytes and the loop does not terminate.
- The client-side **drop disposition** for a previously-synced note absent from the reconcile roster (§11.2 "drop") is a **device-local quarantine**: the ciphertext is moved aside (`quarantine/`), never destroyed and never re-uploaded. Re-uploading would resurrect deleted content server-side and lose the reclaimed record's version CAS; destroying would let a lying server erase user data. The quarantine bound is also the hostile-server ceiling for roster manipulation: a server that hides records from the roster can at most cause a recoverable local move, gated to reconcile walks, never echoed back to it.

### 11.4 Attachment deletion & reclamation

§11.1–§11.3 are written for notes, and their central device — "a deletion is a `deleted`-marked **new encrypted version**" — does not transfer to attachments: an attachment is **immutable and content-addressed** (`protocol.md` §9.9; its AAD binds the `attachment-id`), so there is no such thing as a "new version of" an attachment to mark. Attachments therefore diverge here, and this subsection is their normative deletion model. Three pieces compose it: a **catalog-entry tombstone** (the propagation vehicle), a **blob-plane tombstone record** (the server-reclaim trigger), and the existing horizon-GC (the reclamation clock).

**1. Deletion = catalog tombstone + manifest drop + local crypto-erase (one client action).** Deleting an attachment (the explicit delete, or each id swept by "clean unused attachments"), a client MUST atomically-with-respect-to-sync:
- rewrite the `vault.attachments` entry for that id into an **attachment catalog tombstone**: set `deleted_at` (Unix epoch seconds, `protocol.md` §9.10.2) and **scrub the entry's metadata** (`filename` emptied, `content_type` emptied, `size` zeroed) — after the local crypto-erase nothing may keep the deleted file's descriptive metadata alive in a synced artefact. The entry is **not removed**; the tombstone *is* the multi-device deletion signal.
- drop the attachment's sync-id from the head **manifest** (the same head that commits the deletion's push), and
- perform the local erase exactly as in the single-device lifecycle (blob unlink + `MYE1` cache purge; `decisions.md` 2026-06-13).

**2. The wire signal is a normal §11 tombstone — no parallel deletion path.** The push that carries the deletion includes a **tombstone-flagged content-blob record** for the attachment's sync-id (empty inline ciphertext, a fresh random `content_nonce` so the record is a visible change; the full `attachment_id` rides the optional wire field of §8.1). To the server this is byte-for-byte the note-tombstone shape: it marks the record, advances its version counter, and — because the record carries the full id — additionally marks the stored attachment **body** deleted, after which `HEAD`/`GET /attachments/{id}` for that id return the same response as for an id that never existed (deleted is **absent**, non-distinguishing). The server never learns "deleted" as a meaning (AS6): it sees a structural lifecycle marker, the same class of signal the note tombstone flag already exposes (`threat-model.md` §7).

**3. Reclamation rides the note rule — sweep on record-reclaim, not a second clock.** The attachment **body** is reclaimed when horizon-GC reclaims the attachment's tombstone **record** under the unchanged §11.2 rule (every horizon-active device has acked past it). At that moment the server drops the body and its partial-upload state, releases the id's slot under the per-vault id ceiling, and decrements the AS17 quota counter (`server-protocol.md` §5.1). `MYNE_EXTENDED_RETENTION` (self-host) applies to attachment bodies exactly as to note ciphertext — retention is one policy switch, not two. There is deliberately **no attachment-specific GC clock** ("no parallel attachment-GC path"): one horizon, one ack discipline, one retention switch.

**4. Merge rules — the causal-version guard (refines §10.2, myne-md/myne#405).** `merge_attachments_catalog` is a per-entry union whose reconciliation is a **join over the entry's causal `version`** (`protocol.md` §9.10.2; on any local mutation of an id, `version = max(versions this device has observed for that id) + 1`, absent = 0), deterministic, commutative **and associative**:
- **greater `version` wins.** A deliberate re-add (the user re-imported the same file after deleting it — content-addressing makes the id identical) observes the delete and carries a higher `version` than the tombstone; a stale-catalog live entry that never observed the delete carries a lower one and loses to the tombstone. This replaces the old `created_at > deleted_at` wall-clock guard, whose non-total order made the three-way merge non-associative (§10.2.2).
- **equal-`version` tie:** break by a deterministic total order over the retained fields — **tombstone-ness first (remove-wins**, the resurrection guard's intent); then tombstone-vs-tombstone on `deleted_at`; live-vs-live on `updated_at` then `filename` (lexicographically-greater) then `created_at`. Core fields (`content_type`, `created_at`, `size`) are immutable per id and agree by construction.
Clock honesty: `created_at`/`deleted_at`/`updated_at` are client wall-clocks and now only ever break an equal-`version` tie; `version` itself is causal, not a wall-clock, so skew can no longer wedge the fleet into a ping-pong. The rule is deterministic and convergent, which is the property that matters; no wall-clock ever reaches the server (AS6).

**5. Pull-side ordering (normative).** Within one sync cycle a client MUST merge the pulled `vault.attachments` catalog **before** acting on pulled attachment records: an id whose merged entry is tombstoned is **not downloaded** (and any local blob is erased); an id with no catalog entry yet is **deferred** to a later cycle (never downloaded blind); only a live entry triggers a byte-download. Processing attachments before the catalog would reopen the exact resurrection window the tombstone closes.

**6. Layered resurrection protection (summary).** Pre-GC, serving a stale manifest that still lists a deleted attachment *is* serving a stale head — caught by §5 VV-dominance; the catalog tombstone independently guards the merge layer, rule 4. Post-horizon, a returning device is in §11.2 full-reconcile. What remains is the accepted singleton-rollback bound: the catalog is **not** head-manifest-covered (§4.2), so a malicious server replaying an old catalog blob to a *bootstrapping* device falls under the `threat-model.md` §7 vault-head limit (5) — the same accepted class as `vault.prefs` replay, further bounded here because a replayed pre-delete catalog entry without a server-side body yields a download failure, not a resurrected file.

**7. Client tombstone pruning.** A client MAY prune an attachment catalog tombstone older than the §11.2 horizon (its reclaim has provably completed or its devices are soft-retired; a returning device full-reconciles anyway). Pruning earlier than the horizon is forbidden — it would re-arm the rule-4 race for any device still inside the ack window. A re-add after pruning is indistinguishable from a first import, which is correct.
