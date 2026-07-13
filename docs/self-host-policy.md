# Self-hosting Myne — operator policy

> **Status:** normative operator contract for the Phase 2 sync server (MYND-413). This document is the
> operator-facing projection of `spec/server-protocol.md` §6 and `threat-model.md` TB5/§7. The
> *mechanical* HOW (compose, env vars, snapshot commands) lives in the `operations` runbooks; this is the
> WHAT-you-are-obligated-to. License: CC-BY-4.0 (like all of `docs/`), so independent server implementations'
> operators can rely on the same contract.

## 1. Self-host = the same trust boundary as hosted

Running your own server **changes the operator, not the security model**. The sync server — hosted by us
or by you — sits **outside** the trust boundary (TB5): it stores only opaque ciphertext, hashed
account-number identifiers, version counters, and aggregate quota counters, and it holds **no keys**. It
cannot read your notes, merge them, or reorder them. The protocol assumes a *curious or compelled* server
either way.

**Self-hosting does not give you cryptographic superiority over the hosted service.** Your client encrypts
the same way against both. What self-hosting gives you is control over the *policy* knobs below — and the
corresponding *responsibility* to honour the obligations below. By TB5 a self-host deployment that honours
the policy column is "exactly as trustworthy — and as untrusted — as the hosted service, no more, no less."

## 2. Protocol guarantees vs your policy obligations

The protocol *guarantees* the structural column — you cannot violate it even if you tried. The right-hand
column is what **you, the operator, must enforce** (it is policy, not structure). This table is the
operator-facing reading of `spec/server-protocol.md` §6.

| The protocol guarantees (structural — you can't break it) | Your policy obligation |
|---|---|
| The server cannot read plaintext or keys (blind blob store) | — (nothing to enforce; structural) |
| Conflict resolution is client-side | — (structural) |
| Version counters are opaque; no user timestamps are stored | **Do not** add a side-channel that records wall-clock push times |
| No persistent IP log is *required* (the protocol works without it) | **Do not add IP logging.** The protocol functions without it; adding it violates the AS14 no-persistent-IP-logging commitment |
| Tombstone GC is bounded by the retention horizon | **Do not retain deleted ciphertext past the horizon.** Cryptographic erase is the client's; you must not hoard old blobs |
| A per-account quota counter is exposed | Set a sane per-account ceiling; enforce it fairly |

## 3. What you must not do

These would each take your deployment *outside* the contract above — they are not configuration options,
they are violations:

- **Enable IP logging** anywhere in your stack (the app strips IPs and the bundled Caddy edge scrubs them;
  if you front the server with your own proxy/LB, scrubbing the client IP there becomes **your**
  responsibility). Per `server-protocol.md` §1.3, deviating requires amending the threat model — i.e. you
  are no longer running Myne's stated security model.
- **Retain deleted ciphertext past the retention horizon** (it defeats the user's cryptographic-erase
  intent). **Encrypted, bounded-retention backups are the one compatible exception** (2026-07-13): a
  backup taken *before* a deletion necessarily carries that ciphertext until the backup itself ages out, so
  operational durability and cryptographic-erase are reconciled by a **bound**, not by having no backups.
  If you back the store up, keep it **encrypted, off-box, and short-cycle** so the *effective* worst-case
  window a deleted blob survives is `horizon + backup-retention`, and **disclose that number** (Myne's
  hosted tier: a 14-day encrypted off-box cycle, so ≤ horizon + 14 days). An **unbounded**, plaintext, or
  never-pruned backup re-creates the hoarding this rule forbids.
- **Attempt to weaken the zero-knowledge protocol** in any way — you can't read content regardless, but you
  must not, e.g., add a plaintext side-channel or a metadata-correlation log.

## 4. Policy knobs you control

Set via env vars in the bundle (see the `operations` bundle README for syntax). These bound **storage and
abuse, not confidentiality** — none of them can weaken the zero-knowledge protocol.

- **Quota ceiling** (`MYNE_QUOTA_CEILING_BYTES`, per-account deduplicated ciphertext bytes). Default `0` =
  **unlimited** — intentional for self-host, because *you* own the disk and *you* control who has accounts.
  Set a ceiling only if you want one.
- **Rate-limit** (`MYNE_RATELIMIT_BURST` / `_REFILL`). A per-account token bucket keyed on the hashed
  account number — **never on IP**. Tune for your user count.
- **Retention horizon** (`MYNE_HORIZON_MARKERS`). The tombstone-GC window. **Clamped to a safe floor
  server-side** — you cannot set it below the minimum margin, by design.
- **Extended retention** (`MYNE_EXTENDED_RETENTION`). Self-host *may* disable Layer-2 ciphertext
  reclamation. **⚠️ Warning:** turning this on means deleted ciphertext is kept longer than the horizon —
  it **weakens your users' "delete means gone" expectation**. It is a documented, deliberate policy
  deviation, not a default; enable it only if you understand the trade-off and tell your users.

Numeric *recommended* quota/rate values for the hosted tier are set elsewhere (the billing epic); for
self-host, this document gives you the **mechanism**, and you choose the number for your deployment.

## 5. Verifying the server image

You should verify the image you run rather than trust a tag. The server image is **reproducibly built and
signed** (extending the desktop reproducible-signed-build commitment to the container):

- **Signature (offline):** the image and its SBOM attestation are signed with our hardware-held key. Verify
  with the **public key alone** — no transparency log or external CA is required, so you can verify
  **air-gapped**.
- **Reproducibility:** rebuild the image from the public source and compare the resulting digest to the
  published one (`rebuild → digest-compare`). Equal digests mean the published image is exactly that
  source.
- **SBOM:** a CycloneDX SBOM is attached as a digest-bound attestation listing what is in the image.

The mechanical commands are in the `operations` reproducible-build runbook.

## 6. Certificate trust

Your client must trust the server's TLS certificate, and the SCRAM channel binding ties the authenticated
session to that exact certificate (so a man-in-the-middle presenting a different certificate fails to
authenticate).

- **Hosted:** the client ships with a pinned certificate for the hosted endpoint (settled).
- **Self-host:** how your client trusts *your* operator-chosen certificate/domain is being finalised with
  the Phase 2 client work (MYND-424). The **proposed** mechanism is **trust-on-first-use (TOFU)**: your
  client pins the certificate it sees on first connection and you **eye-compare a fingerprint** at device
  enrollment (reusing the same out-of-band fingerprint channel the device-approval gate already uses).
  Until MYND-424 ratifies this, treat self-host certificate-pinning as **design-pending** — this section
  will be updated to settled once the client side lands.

## 7. The honest limitation (what TB5 does and doesn't buy you)

The protocol structurally prevents the server from reading your content. It **cannot** structurally prevent
a *malicious or compelled* operator from logging IPs, retaining old ciphertext, or correlating metadata
**at the policy level** — that is exactly why these are *obligations* in §2, not guarantees. When you
self-host, your users are trusting **your** adherence to the policy column; when they use the hosted
service, they are trusting ours. This residual is recorded normatively in `threat-model.md` §7 (self-host
known limitation). Neither hosting model claims more than this — and that honesty is the point.
