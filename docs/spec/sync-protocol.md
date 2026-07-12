# Myne Sync Protocol Specification (Phase 2)

> **Status: draft.** Phase 2 multi-device synchronization over an untrusted server (TB5). This document specifies the **vault head** fork-consistency primitive (MYND-416) and will grow to cover the sync wire protocol (push/pull/CAS — MYND-414), server protocol (MYND-415), and conflict resolution. It builds on the at-rest protocol in [`protocol.md`](protocol.md); all cryptographic primitives, the subkey-derivation helper (§3.2), the AAD/encode-then-hash discipline (§5), and the magic-byte registry (§10.3) are inherited from there. v0.1 and v005 remain forward-incompatible (`protocol.md` §10); nothing here changes the v0.1 at-rest vault format — the head is **sync-wire-only** plus one device-local blob (`MYH1`, `protocol.md` §9.15).

---

## 1. Scope & threat

### 1.1 Scope

This document (as of MYND-416) defines the **vault head**: a small, server-relayed, per-push record that lets multiple devices of a single user detect a malicious server's attempts to **rewind, hide, or split** their vault, even though the server can never read or forge their content.

In scope here:
- The head record, its canonical byte encoding, and the HMAC that authenticates it (§3).
- The semantics of the committed fields — the version vector, the manifest, and the push compare-and-swap (§4).
- The on-pull verification algorithm and the detection of rollback / fork / withholding (§5).
- Bootstrap of a fresh device (TOFU) and genesis (§6).
- The device-local last-seen baseline that anchors continuity across restarts (§7).

Out of scope (other Phase 2 work items): the sync wire protocol and the canonical encoding of the **manifest object itself** (MYND-414 — the head only anchors `SHA-256` of its bytes), the server protocol and storage (MYND-415/419/421), server authentication (MYND-420), device enrollment / approval / the bootstrap-fingerprint UI (MYND-425), tombstones / quota / rate-limit (MYND-422), the Rust implementation (MYND-417), and the cross-implementation golden vectors (MYND-418).

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
 || manifest_hash           (32 B   SHA-256 of the canonical manifest bytes; §4)
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

Three distinct SHA-256 inputs exist in the combined protocol, and none may be reinterpretable as another:

| Hash | Input begins with | Defined in |
|---|---|---|
| `manifest_hash` | the manifest canonical prefix (MYND-414) | §4 / MYND-414 |
| `head_id` | `head_mac_input`, i.e. `"myne.v0.1|"` … | §3.4 |
| CTX commitment | the §5.1.3 `canonical_encode` of (K, N, AD, T) | `protocol.md` §5.1.3 |

Each input starts with a distinct, non-overlapping prefix (the head via the `"myne.v0.1|"` AAD prefix; the manifest under its own MYND-414 prefix; the CTX commitment under its fixed-length key/nonce-first layout), so no hash input is a prefix or re-encoding of another. Implementations MUST NOT feed bare, prefix-free data into any of these.

### 3.6 `head_format_version` (forward hook)

`head_format_version` is bound into the MAC so the sync layer can evolve the head's *shape* without a v0.1 major-version event — the head is wire-only, so no on-disk format bakes it in (`protocol.md` §10 reserved-expansion ban does not apply). The documented Phase-3 use is upgrading `manifest_hash` from a flat hash to a Merkle root (enabling light-client / partial-sync inclusion proofs); that is a sync-wire bump, not a vault-format change. v0.1 uses `head_format_version = 0x01`.

---

## 4. Committed-field semantics

§3 fixed the *bytes*; this section fixes what they *mean*.

### 4.1 Version vector

The version vector (VV) is the authority for concurrency and fork detection. Each entry is `device_id → counter`.

**`device_id`** is a **client-generated, 16-byte random** identifier, allocated once when a device is enrolled and registered in the per-account device table (AS16). It MUST be generated by the device itself (OS CSPRNG), not assigned by the server (TB5 — a server-assigned id would let the untrusted server muddy VV semantics). It MUST be kept **separate from the device's secret per-device token**: the token is a revocable/rotatable bearer credential (an *availability* control — revoking it stops that device syncing), whereas `device_id` is permanent *history*. Deriving `device_id` from the token would let a token rotation rewrite VV history and break fork-consistency continuity. A reset or re-enrolled device generates a **new** `device_id`; the old device's component freezes (it authors no further heads) and is **never pruned** in v1.

**`counter`** is that device's **authored-head count** — incremented by exactly one each time the device authors a head, at **push** granularity (one head per sync point, never per keystroke; edits coalesce per the Phase 2 write cadence, so the counter leaks no per-keystroke activity).

**Composition rules:**
- **genesis** (`parent_count == 0`): the authoring device's component = 1; no other components.
- **linear** (`parent_count == 1`): copy the parent's VV, then `+1` to the author's component.
- **merge** (`parent_count == 2`): take the **componentwise maximum** of the two parents' VVs, then `+1` to the author's component.

**Explicit author + consistency check.** The head carries the `author_device_id` (16 B) explicitly (encoded as part of the head record alongside the VV — chosen for simplicity; deriving it by diffing parent VVs is possible but expensive and off-by-one fragile). A verifier MUST reject a head whose author component is not exactly one above the parents' maximum for that device — i.e. `VV[author] == max(parents' VV[author]) + 1`, and `== 1` at genesis. This turns the redundant field into a free consistency check; it cannot contradict the VV.

**Actor-set authority (no separate roster).** A device's right to be a VV actor is **not** separately authenticated and need not be. Myne is single-user: anyone holding `root_key` is a legitimate author, so a device can introduce a new `device_id` simply by authoring a `root_key`-MAC'd head bearing it. The server, lacking `root_key`, cannot forge a head and therefore cannot inject a phantom `device_id` (it can only replay/withhold/reorder real heads). The VV actor-set is exactly "every `device_id` that appears in a validly-MAC'd head" = the user's enrolled devices. The Phase 2 device-approval gate (MYND-425) is an *availability* control over token issuance, **not** a cryptographic VV roster. Implementations MUST NOT add a roster-authentication step here.

**No pruning (v1).** A VV grows with the user's *lifetime* device count, not the active count. Dropping a component is forbidden in v1: it is "tombstone GC before causal stability" — it would make a fork involving that device undetectable thereafter. For a single user the device count is small, so there is no pressure. If pruning is ever introduced (v005), it MUST ride an authenticated device-retirement event (a current device authoring a head that records "device X retired at component N"), never a unilateral drop — a unilateral drop is a server fork-hiding door.

### 4.2 Manifest, and what "version" means

The **vault-head manifest** is the `uuid → content_nonce` map the head commits (as a `SHA-256` of its canonical bytes, §3.2). Two decisions are load-bearing:

**Scope = content blobs only.** The manifest covers **notes** (`.myn`, keyed by note UUID) and **attachments** (keyed by the **attachment sync-id** — see below). It does **not** cover the synced singletons (`vault.prefs`, `vault.meta`, `vault.dictionary`, `vault.attachments` catalog). Their rollback is the already-accepted "local prefs replay" limitation (`threat-model.md` §7) — `vault.meta` additionally has the Q2 bespoke-merge + the `root_key`-invariant, so a credential-rollback is low-impact — and excluding them keeps the manifest uniform on a single discriminator (`content_nonce`), avoiding a per-singleton exception.

**The discriminator is `content_nonce`, not a counter.** Each note's `content_nonce` (`protocol.md` §9.2) is freshly random per save (§6.3 there: `item_key_nonce` is persistent, `content_nonce` is regenerated every content encryption), so it is the correct per-revision discriminator, and it is readable from the cleartext header **without decrypting**. Committing it gives **two-layer** rollback detection:
1. **Pre-decrypt:** a server serving an older revision presents a header `content_nonce` that ≠ the head's manifest entry → caught on a ~header-sized read, no decryption.
2. **On-decrypt:** the server cannot write the current `content_nonce` into the header while keeping old content — the AEAD binds the nonce to the ciphertext, so decryption fails (the tag was computed under the real nonce).

Binding the server's **opaque per-note version counter** instead would commit only a bare number, leaving which ciphertext counts as "version N" for the server to play with. The opaque counter is therefore **orthogonal** to the head: it is the sync transport's compare-and-swap token for individual note pushes (MYND-421), not something the head commits.

**Attachment sync-id (normative key-width pin).** The manifest's canonical encoding uses a **uniform 16-byte key** for every entry (MYND-414). A note's key is its 16-byte UUID; an attachment's manifest **and wire** key is the **first 16 bytes of its 32-byte `attachment-id`** (`protocol.md` §9.9) — the **attachment sync-id**. The full 32-byte id continues to live in the `attachments/<hex>` filename, the `vault.attachments` catalog, and the attachment byte-transport (`server-protocol.md` §3.2); only the sync metadata plane truncates. The truncation is safe: within a single vault the birthday bound on a 128-bit prefix is ~2^-64 at any plausible attachment count, and the manifest's duplicate-key rule already makes a collision a **hard, visible encode failure** (never a silent overwrite). An attachment's manifest discriminator is the `content_nonce` from its `MYA1` cleartext header (offset 112), read without decryption — exactly the note rule. One consequence is normative for convergence: because an `attachment-id` is keyed over **plaintext** while encryption is randomized, two devices independently importing the same file mint the **same id but different ciphertext/`content_nonce`**. On a nonce mismatch for an attachment whose id both sides hold, a puller MUST adopt the server's bytes verbatim (**server-wins**) rather than treating the mismatch as a conflict — attachment plaintext is immutable per id, so nothing user-visible is lost and the manifests converge; keep-both (§10.1) applies to notes only.

**Deleted notes (tombstones).** A deletion is a `deleted`-marked new note version with its own fresh `content_nonce` (Q3 / MYND-422), so it stays **in the manifest** until horizon-GC — the head commits it, and a server attempting resurrection (serving the pre-deletion `content_nonce`) mismatches the head and is caught. Once horizon-GC fully purges a note, its UUID drops from the manifest; from that point a resurrection is covered not by the head but by Q3's full-reconcile-on-bootstrap + §6 TOFU (a device returning past the horizon is in full-reconcile mode and will not resurrect a vanished note). Pre-GC = head-protected; post-GC = handed to full-reconcile.

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
2. **Structural well-formedness.** `parent_count ∈ {0,1,2}`; `prev_head_hash[]` byte-sorted and the right length; VV well-formed (sorted, no duplicate `device_id`); the explicit-author consistency check of §4.1 (`VV[author] == max(parents)[author] + 1`, `== 1` at genesis). Reject on any failure.
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
- **Withholding of *other* devices' work, and global staleness, is best-effort.** A server can serve a head that dominates *this* device's baseline while omitting another device A's latest push — this is not a dominance violation (the head dominates my VV; it simply does not carry A's newer component). Likewise a server can hide the newest head and serve an older-but-not-rolled-back one; the device cannot distinguish "nothing new" from "withholding." These are **accepted** in v1; a signed freshness-box (a monotonic timestamp token) is deferred to v005.

Spec language MUST say "liveness, best-effort" for the second class and MUST NOT claim withholding is undetectable in general — the self-work case is detected.

### 5.6 Continuity, not bootstrap

Everything in §5 is a **continuity** guarantee: it protects a device that already holds a baseline `B`. A device with no baseline (fresh, reset, re-enrolled) has nothing to compare against and is in **TOFU bootstrap** (§6). This boundary is load-bearing and MUST be stated wherever the rollback guarantee is described.

### 5.7 Properties to verify (MYND-417/418)

This primitive **requires a primitive-level cryptographic review, not merely an architectural one**, before implementation lands. The following properties MUST be covered by `proptest` (Rust, `crypto_properties.rs` discipline) and by the golden vectors (MYND-418, schema in `myne-test-vectors`):

- **Encode→decode roundtrip.** A head encoded per §3 and decoded yields an identical record; `head_id` is stable.
- **Rollback-rejection.** A head with any VV component below the baseline is rejected (§5.3).
- **Fork-incomparability.** Two incomparable heads never both validate as a linear extension of the same baseline (exactly one, or neither, extends; the other forces a merge).
- **Merge-VV-consistency.** For any DAG, a merge head's author component equals `max(parents) + 1` and all other components equal the componentwise max (§4.1); genesis = `{author: 1}`.
- **Canonical-encoding determinism.** Independent encoders (Rust, Go) emit byte-identical `head_mac_input` for the same logical head — the bit-identical bar of §3 (VV sort, merge-parent lexicographic sort, fixed widths, big-endian).

---

## 6. Genesis & TOFU bootstrap

### 6.1 Genesis

The **genesis** head is authored by the first device to push, at **first sync** — not at vault creation (the head is wire-only; a vault that never syncs has no head, and Phase 1 must not gain a sync artefact). Genesis commits the **entire existing local corpus**: `manifest_hash` over every current content blob's `(uuid, content_nonce)`, `VV = {author: 1}`, `seq = 1`, `parent_count = 0`. The authoring device is **authoritative** — it knows its own local state is real, so genesis carries no TOFU risk.

An **empty corpus is a valid genesis.** A device with zero content blobs still authors the genesis head on its first push (the `manifest_hash` is simply computed over the empty manifest) — a **head-only push** (no blobs, `new_head` only). This is required for liveness: a device joining an as-yet-empty account must be able to adopt a verifiable head to complete its §6.3 bootstrap-fingerprint eye-compare; without a genesis-on-empty, a zero-note account would never author a head, the joiner's pull would return no head, and the enrollment compare would be unreachable (the joiner would wait indefinitely). The genesis-on-empty push is gated to **push cycles** (never a poll-only pull — the §8.3 privacy cadence is untouched) and fires **exactly once**: once any head exists, a subsequent no-local-change cycle adopts it (§5) rather than re-authoring.

Head state is fully **re-derivable**: total loss of a device's head state (corrupted/cleared `MYH1`) costs at most a re-genesis (a TOFU reset, §6.2) — the vault *content* is untouched, since the head is a sync artefact, not authoritative content.

### 6.2 TOFU bootstrap

The "first device" is not cryptographically special; **"has a persisted baseline or not"** is. A fresh, reset, or re-enrolled device has no baseline, so §5's continuity guarantee does not yet apply: it adopts the server-served head on **trust-on-first-use**. MAC-verifying that head proves only that *a `root_key` holder authored it* — **not** that it is the latest, unforked head. A malicious server can therefore seat a brand-new device onto a stale or forked history undetectably, because the device has no prior state to contradict it. This is intrinsic to fork-consistency (SUNDR: a client that has observed nothing can detect nothing); it is the same posture as Signal/Matrix key TOFU.

A re-enrolled device generates a **new** `device_id` (§4.1) — it does not reclaim the old one; the old component freezes.

### 6.3 Bootstrap-fingerprint (the only hardening)

The bootstrap is **not** in a vacuum: enrollment (MYND-425) runs a **device-approval gate** where an existing, unlocked device approves the newcomer — so the user is physically at *both* devices, and an out-of-band channel (their eyes) is naturally present. v1 hardens TOFU by having both devices display a short **bootstrap-fingerprint** derived from the adopted `head_id`, for the user to eye-compare — exactly Signal/Matrix safety-number verification. A match turns "trust the untrusted server" into "verified against an existing trusted device."

- The fingerprint is **~SAS-magnitude** (tens of bits — a few words / a 6–8 char code), eye-comparable, a deterministic function of `head_id` (not the full 32-byte value).
- It is **targeted** to the approval moment. If the device-approval gate ships in v1, this compare ships in v1 (the marginal UX cost is one glance on a screen the user is already on, at the exact vulnerability point).
- It is distinct from the **general fork-audit fingerprint** — an always-available affordance to compare current heads across devices at any time — whose prompt-UX stays v1.x. v1 ships the *substrate* (a deterministic fingerprint of any `head_id`); the general UI is later.

Without an out-of-band compare, TOFU adoption remains trust-the-server; with it, the malicious-server bootstrap attack is closed for that enrollment. The spec MUST present TOFU honestly (the guarantee holds only after a verified baseline exists) and MUST NOT imply that MAC-verification alone authenticates freshness.

---

## 7. Device-local baseline (`MYH1`)

The last-seen head (§5.1) is persisted **device-locally** in the `MYH1` `vault.head-state` blob; its on-disk format, integrity rule, and honest limits are normative in [`protocol.md`](protocol.md) §9.15. The sync-relevant properties:

- **Device-local, never synced, never backed up.** The baseline MUST NOT live on the server — a server-held baseline would let the server roll *it* back too, defeating §5 entirely. It is structurally excluded from sync by the closed sync-allowlist's **default-deny** (it is simply not an allowlisted member, not a special-cased exclusion) and from backup by the §9.11.3 allowlist (a restored baseline would be stale → the restored vault re-bootstraps via §6 TOFU).
- **Stores the full wire-head TIP only**, re-verifying the head's own `vault-head-mac` on load (no separate at-rest MAC, no KEK — the head carries no vault plaintext the sync server doesn't already see). Written every accepted-pull and every authored-push.
- **Anti-rollback of the baseline itself is bounded, not absolute.** Lowering the on-disk baseline to force acceptance of a server rollback requires a **conjunction** — local-disk-write **and** a colluding malicious server; neither alone suffices (disk-write-only: an honest server still serves the real, dominating tip; server-rollback-only: an intact baseline rejects it). Impact is bounded to stale *own* data (never forged or decrypted), and the in-session RAM baseline only advances. Accepted for v0.1 and recorded in `threat-model.md` §7; a hardware monotonic counter is the v005 closure (`protocol.md` §9.15).

---

## 8. Sync wire protocol

The vault head (§2–§7) is the integrity spine; this section is the transport that moves blobs and heads between a device and the server. The model is **whole-blob replication** — every Myne blob is an AEAD whole-file unit (`protocol.md` §9), so there is no field-level diffing or server-side merge. Real-time co-editing and a CRDT note-type are Phase 4 (`protocol.md` §11.2); they would arrive as a new major note-type beside the v0.1 blob, not as an extension here.

### 8.1 Endpoints

Two core operations:

- **pull(cursor) → (changed[], new_cursor)** — the server returns, for every content blob changed since `cursor`, a **per-blob sync-meta** record and advances the cursor:
  ```
  sync_meta = { uuid (16 B), version (server opaque counter, §2 server-protocol), content_nonce (24 B), size (bytes) }
  ```
  The client compares each `content_nonce` to its local copy (the §9.6.4 decryption-free staleness signal) and decides which blobs to actually download. The server also returns the current vault head (the client verifies it per §5). `version` is the server's opaque per-note counter (AS6), `size` the AS17 quota unit; neither is trusted for integrity — the head is.
- **push(changed_blobs, new_head)** — the client uploads changed blobs plus the new vault head. The push is a **compare-and-swap**: the head's `prev_head_hash` (§4.3) is the CAS token; the server accepts iff its current-head pointer matches, then atomically advances. A stale base → a 409-like reject (§10).

**Attachments ride the same metadata plane, but their bytes travel out-of-band.** An attachment participates in pull/push as a normal content-blob record keyed by its 16-byte **attachment sync-id** (§4.2) with its `MYA1` header `content_nonce` as the discriminator — but its ciphertext is **not** carried inline in the push body. The bytes move over the dedicated resumable byte-transport (`server-protocol.md` §3.2: `HEAD`/`PUT`/`GET /attachments/{id}`, full 32-byte id, single whole-blob AEAD unit); the push then records the attachment with an **empty inline ciphertext** plus its full `attachment_id` (an optional wire field), and the server echoes that `attachment_id` back in the pull sync-meta so a puller can resolve the sync-id to the full id without waiting on the catalog. Ordering preserves the blobs-first-then-head rule (SYNC-5): a client MUST complete every attachment byte-upload **before** the push that references it, so any head the server accepts only ever commits attachment bytes that are already durably stored.

### 8.2 Cursor

The **sync cursor** is an opaque, per-device, monotone position (a catch-up bookmark). It carries **no wall-clock** — ordering authority is the version vector (§4.1), never the cursor (Pin 4). It is persisted device-locally alongside, but separate from, the `MYH1` head baseline (§7) and the rebuildable caches (it is sync-transport state, owned by the sync engine, not the head).

### 8.3 Change notification — contentless poke

A device learns "something changed, come pull" via a **contentless poke**: a signal with **literally zero payload** — no note-id, no version, no count, no cursor (any of those would leak which/what/how-much to the server or a network observer, A13).

- **The poke (over SSE) is part of the baseline sync behaviour** *(amended — supersedes the original opt-in-layer posture; `decisions.md` 2026-07-12)*. While a vault is unlocked (and, on mobile, foregrounded), the client keeps one SSE poke stream open per enrolled vault. Rationale for the amendment: the fixed-interval polling baseline already disclosed device presence to the server at poll granularity for the entire unlocked window, so the continuous connection's marginal A13 delta (poll-granular → connection-granular presence) was judged too small to carry a user-facing toggle whose privacy value was largely theatrical. What IS load-bearing is unchanged: the poke carries **zero payload**, and the arrival + timing of a push is intrinsic A13 (accepted).
- **Polling remains the fallback cadence.** A device polls on an interval regardless of the stream's health — a broken/parked poke stream degrades latency (back to poll granularity), never correctness. Desktop and mobile share this baseline. Edge triggers (unlock, window focus, mobile foreground) may additionally arm a **one-shot** immediate pull; they are one-shot by construction so they cannot become a high-frequency polling channel.
- **Stream hygiene (normative for clients):** reconnects use jittered exponential backoff; a `401` parks the stream until the device's `(endpoint, token)` identity changes (no reconnect-spin on a revoked token); on every successful (re)connect the client performs one catch-up pull (pokes sent while disconnected are unobservable). Dead connections are detected via the server's heartbeat (`server-protocol.md` §3) — a read timeout above the heartbeat cadence.

### 8.4 Robustness

- **Idempotent push** — the CAS (§8.1) plus content-addressing makes a retried push a no-op rather than a duplicate.
- **Certificate pinning** — the client pins the server certificate (A4 MitM); the channel is authenticated to a session (the auth mechanism is MYND-420, referenced in `server-protocol.md`).
- **Deferred (not v1):** real-time WebSocket co-edit (Phase 4) and contentless mobile-wake push (Phase 3) — both are documented forward paths, not part of this wire spec.

---

## 9. Sync taxonomy

Not every vault artefact syncs. The **sync taxonomy** partitions them into four classes, and the membership is governed by one invariant so it is never re-litigated:

> **Invariant — sync members ⊆ backup members.** A blob syncs only if it is in the `protocol.md` §9.11.3 backup allowlist *and* is authoritative (not a rebuildable cache, not device-local). Sync membership is the authoritative-vs-derivable cut of that allowlist; it is not a separate list a future change can drift.

| Class | Members | Disposition |
|---|---|---|
| **1 — Authoritative data** | `.myn` notes, `snapshots/`, `vault.prefs`, `vault.dictionary`, attachment blobs, `vault.attachments` catalog | **SYNC.** Merge per §10 (bodies = keep-both; prefs/dictionary/catalog = field/set merge). |
| **2 — Identity** | `vault.meta` | **SYNC**, with the §10 bespoke merge that preserves the recovery-side wrapped `root_key` (`protocol.md` §9.3). |
| **3 — Rebuildable cache** | `vault.search` (`MYS1`), `vault.indices` (`MYI1`), `vault.embeddings` (`MYR1`) | **NEVER synced — re-derived locally** from the notes via the §9.6.4 `content_nonce` reconcile. Syncing them would be redundant, create a spurious conflict class, and still require a reconcile; cold-start is bounded (first build once per device, delta thereafter). `vault.embeddings` is a *doubly* Class-3 fit: it is both rebuildable **and model-specific** — its vectors are valid only for the exact embedding model that produced them (`{model_hash, embedding_dim, chunker_version}`), so on a device holding a different model, or none, they are simply wrong; syncing them is actively incorrect, not merely redundant. |
| **4 — Device-local** | `vault.workspace` (`MYW1`), `vault.quickunlock` (`MYQ1`), `vault.head-state` (`MYH1`, §7) | **NEVER synced.** `vault.workspace` is a privacy choice (graceful-exit/coalesced writes would turn at-rest mtime into a server-visible active-edit-timing channel — A13); `vault.quickunlock` is a security MUST-NOT (it wraps a device-hardware-bound copy of `root_key`); `vault.head-state` is each device's own rollback baseline. |

### 9.1 "Continue where you left off"

Resuming the last-open note across devices is **not** done by syncing `vault.workspace` (class 4 — that would leak active-edit timing). Instead it is an **opt-in single field `last_active_note` (note-id only)** that rides the already-synced `vault.prefs` (class 1), following the precedent that the `active_workspace` pointer lives in `vault.prefs` because prefs crash-survives. The leak is bounded to a note-id plus the prefs write cadence; it stays opt-in and coalesced. The `MYW1`-never-sync invariant is preserved.

---

## 10. Conflict model

The server **cannot** decrypt or merge (A1, TB5), so all conflict resolution is **client-side and mandatory**. Detection is the push compare-and-swap (§8.1): a client pushes against a base, and a stale base is **rejected (409-like)**, forcing the loser to pull, resolve, and re-push. Resolution then differs by artefact class (§9):

### 10.1 Note bodies — keep-both

A concurrent edit to the same note resolves by **keeping both versions**: the losing version is written as a **conflict-marked duplicate note** for the user to reconcile. **Pure last-writer-wins on a note body is forbidden** — it would silently destroy an edit the server can't see. (At the head level, the two concurrent heads are version-vector-incomparable and the loser authors a merge head, §5.3; at the content level, the conflicting note becomes a duplicate.) UX for grouping conflict copies is a client concern (out of scope here).

### 10.2 Singletons — post-decrypt field/set merge

Structured singletons merge **field-by-field after decryption**, following `protocol.md` §9.5.2 **exactly** — do not re-derive the taxonomy here, cite it:

- **Set-union** (sorted, deduplicated): `deliberate_folders`, `hidden_bar_items`.
- **Sequence-LWW-on-whole** (the whole ordered list is replaced, never per-element merged): `item_order`, `favorites`, `view_order`.
- **Scalar LWW**: every remaining `vault.prefs` field (`screen_capture_protection`, `label`, `theme`, `auto_lock_seconds`, `custom_theme`, the `daily_*` / `editor_*` fields, `active_workspace`, `editor_default_view_mode`, `editor_layout`, the `editor_focus_*` flags, and the §9.1 `last_active_note`).

`vault.dictionary` merges as a **set-union** of its word sets (conflict-free); the `vault.attachments` catalog merges **per-entry by attachment-id** — a union of entries (the core fields are immutable, content-addressed), refined by the **attachment-catalog-tombstone rules of §11.4** (deletion markers, the revival window, and the `filename` scalar-LWW are the only per-entry reconciliation this merge performs).

### 10.3 `vault.meta` — bespoke merge

`vault.meta` (class 2) is **not** field-merged. It carries two independently-wrapped copies of `root_key` (password-side and recovery-side, `protocol.md` §9.3). A concurrent change on one device (e.g. a password change rewrapping the password-side copy) must **preserve the recovery-side wrapped key** — a naive LWW would let one device's `vault.meta` strand recovery on another. The merge takes the newest password-side wrap while keeping a valid recovery-side wrap, and the KDF-params/`account_number_hash`/`items_key_id` invariants (which must agree across devices) are validated, not overwritten. (`root_key` is a single per-vault random value, not password-derived; every device holds the *same* `root_key` by unwrapping the same synced `vault.meta`, so the merge only ever reconciles the *wraps* of one shared key — never two different keys.)

---

## 11. Deletion & tombstone horizon-GC

### 11.1 Deletion is a tombstone version, not an absence

A note deletion is a **`deleted`-marked new encrypted version** — a fresh `.myn` version with its own `content_nonce`, carried in the vault-head manifest until garbage-collected (§4.2). It is **not** "absent on disk → drop": the §9.6.4 local-reconcile rule (a manifest entry absent from disk → delete it locally) is **overridden for sync**, because under sync, "absent" is ambiguous between "deleted elsewhere" and "not yet pulled here". Without an explicit tombstone, a device that was offline at delete time would treat the deletion as a missed write and **resurrect** the note (the Cassandra-zombie failure). The tombstone is the same nature as Myne's existing `trashed:` / `archived:` managed-frontmatter pattern: a marked version, the opaque version counter advancing, the server never learning the "deleted" meaning (AS6 / zero-knowledge preserved).

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

### 11.4 Attachment deletion & reclamation

§11.1–§11.3 are written for notes, and their central device — "a deletion is a `deleted`-marked **new encrypted version**" — does not transfer to attachments: an attachment is **immutable and content-addressed** (`protocol.md` §9.9; its AAD binds the `attachment-id`), so there is no such thing as a "new version of" an attachment to mark. Attachments therefore diverge here, and this subsection is their normative deletion model. Three pieces compose it: a **catalog-entry tombstone** (the propagation vehicle), a **blob-plane tombstone record** (the server-reclaim trigger), and the existing horizon-GC (the reclamation clock).

**1. Deletion = catalog tombstone + manifest drop + local crypto-erase (one client action).** Deleting an attachment (the explicit delete, or each id swept by "clean unused attachments"), a client MUST atomically-with-respect-to-sync:
- rewrite the `vault.attachments` entry for that id into an **attachment catalog tombstone**: set `deleted_at` (Unix epoch seconds, `protocol.md` §9.10.2) and **scrub the entry's metadata** (`filename` emptied, `content_type` emptied, `size` zeroed) — after the local crypto-erase nothing may keep the deleted file's descriptive metadata alive in a synced artefact. The entry is **not removed**; the tombstone *is* the multi-device deletion signal.
- drop the attachment's sync-id from the head **manifest** (the same head that commits the deletion's push), and
- perform the local erase exactly as in the single-device lifecycle (blob unlink + `MYE1` cache purge; `decisions.md` 2026-06-13).

**2. The wire signal is a normal §11 tombstone — no parallel deletion path.** The push that carries the deletion includes a **tombstone-flagged content-blob record** for the attachment's sync-id (empty inline ciphertext, a fresh random `content_nonce` so the record is a visible change; the full `attachment_id` rides the optional wire field of §8.1). To the server this is byte-for-byte the note-tombstone shape: it marks the record, advances its version counter, and — because the record carries the full id — additionally marks the stored attachment **body** deleted, after which `HEAD`/`GET /attachments/{id}` for that id return the same response as for an id that never existed (deleted is **absent**, non-distinguishing). The server never learns "deleted" as a meaning (AS6): it sees a structural lifecycle marker, the same class of signal the note tombstone flag already exposes (`threat-model.md` §7).

**3. Reclamation rides the note rule — sweep on record-reclaim, not a second clock.** The attachment **body** is reclaimed when horizon-GC reclaims the attachment's tombstone **record** under the unchanged §11.2 rule (every horizon-active device has acked past it). At that moment the server drops the body and its partial-upload state, releases the id's slot under the per-vault id ceiling, and decrements the AS17 quota counter (`server-protocol.md` §5.1). `MYNE_EXTENDED_RETENTION` (self-host) applies to attachment bodies exactly as to note ciphertext — retention is one policy switch, not two. There is deliberately **no attachment-specific GC clock** ("no parallel attachment-GC path"): one horizon, one ack discipline, one retention switch.

**4. Merge rules — the resurrection guard (refines §10.2).** `merge_attachments_catalog` is a per-entry union with exactly three reconciliations, all deterministic and commutative:
- **tombstone vs live:** the live entry survives iff `created_at > deleted_at` (a **re-add** — the user deliberately re-imported the same file after deleting it; content-addressing makes the id identical, and the fresh import's `created_at` postdates the tombstone). Otherwise — including equality — the **tombstone wins**: a live entry whose `created_at` predates the deletion is precisely the stale-catalog resurrection this guard exists to stop.
- **tombstone vs tombstone:** keep the **greater `deleted_at`**.
- **live vs live:** core fields (`content_type`, `created_at`, `size`) are immutable per id — on the same id they agree by construction; `filename` (renameable, MYND-173) merges scalar-LWW on `updated_at` (absent `updated_at` = `created_at`), ties broken toward the lexicographically-greater filename so both sides converge identically.
Clock honesty: `created_at`/`deleted_at`/`updated_at` are client wall-clocks from different devices; skew can make the "wrong" side win a revival or rename race. Accepted — the rule is deterministic and convergent, which is the property that matters; no wall-clock ever reaches the server (AS6).

**5. Pull-side ordering (normative).** Within one sync cycle a client MUST merge the pulled `vault.attachments` catalog **before** acting on pulled attachment records: an id whose merged entry is tombstoned is **not downloaded** (and any local blob is erased); an id with no catalog entry yet is **deferred** to a later cycle (never downloaded blind); only a live entry triggers a byte-download. Processing attachments before the catalog would reopen the exact resurrection window the tombstone closes.

**6. Layered resurrection protection (summary).** Pre-GC, serving a stale manifest that still lists a deleted attachment *is* serving a stale head — caught by §5 VV-dominance; the catalog tombstone independently guards the merge layer, rule 4. Post-horizon, a returning device is in §11.2 full-reconcile. What remains is the accepted singleton-rollback bound: the catalog is **not** head-manifest-covered (§4.2), so a malicious server replaying an old catalog blob to a *bootstrapping* device falls under the `threat-model.md` §7 vault-head limit (5) — the same accepted class as `vault.prefs` replay, further bounded here because a replayed pre-delete catalog entry without a server-side body yields a download failure, not a resurrected file.

**7. Client tombstone pruning.** A client MAY prune an attachment catalog tombstone older than the §11.2 horizon (its reclaim has provably completed or its devices are soft-retired; a returning device full-reconciles anyway). Pruning earlier than the horizon is forbidden — it would re-arm the rule-4 race for any device still inside the ack window. A re-add after pruning is indistinguishable from a first import, which is correct.
