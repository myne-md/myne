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
  never-pruned backup re-creates the hoarding this rule forbids. The server ships a **built-in feature that
  implements this correctly** (`MYNE_BACKUP_*`, §4) — encrypted, off-box, pruned to a disclosed window — so
  you do not hand-roll it.
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
- **Encrypted off-box backup** (`MYNE_BACKUP_*`). Built-in, server-native backup (`decisions.md`
  2026-07-14): set `MYNE_BACKUP_ENABLED` + a `MYNE_BACKUP_REPOSITORY` + a `MYNE_BACKUP_PASSWORD_FILE` and
  the server drives a bundled restic to snapshot the store to an off-box target on a schedule
  (`MYNE_BACKUP_INTERVAL_SECONDS`), pruned to a disclosed retention window (`MYNE_BACKUP_RETENTION_DAYS`,
  default 14). **Off by default.** This is the mechanism that satisfies §3's "encrypted, off-box,
  short-cycle" requirement without hand-rolling anything — you provide the repository (SFTP / Storage Box
  works out of the box) and hold its key; the server holds no vault keys, and the backup carries only
  already-encrypted ciphertext. It is best-effort (a failed run is logged and retried, never blocks
  serving), and `myne-server restore` / `backup-check` are first-class commands. **Widening the retention
  window past what you disclose re-creates the hoarding §3 forbids** — if you must, re-disclose it
  (threat-model §7 + this section) as §3 requires.

Numeric *recommended* quota/rate values for the hosted tier are set elsewhere (the billing epic); for
self-host, this document gives you the **mechanism**, and you choose the number for your deployment.

## 5. Verifying the server image

You should verify the image you run rather than trust a tag. **One of the three checks below ships and
two do not, and this section presented all three as current until 2026-08-25** (`decisions.md` entry
0534). It also called them an extension of a desktop reproducible-signed-build commitment; desktop has
neither reproducibility nor a signature (`threat-model.md` §1 A9), so there was nothing to extend.

- **Reproducibility (shipped).** Rebuild the image from source and compare the resulting digest to the
  published one (`rebuild → digest-compare`). Equal digests mean the published image is exactly that
  source. `myne-server`'s pipeline runs this gate on every push (`scripts/repro-gate.sh`), so it is
  checked rather than merely offered. The source is not public today, which bounds who can perform it.
- **Signature (designed, not shipped).** The plan is `cosign` over the image and its SBOM attestation
  with an offline hardware-held key, verifiable with the public key alone and therefore air-gapped, with
  no transparency log or external CA. **Nothing signs the image today**: there is no signing step in
  `myne-server`'s pipeline and the key-custody procedure it depends on is unwritten. Do not go looking
  for a signature to verify.
- **SBOM (designed, not shipped).** A CycloneDX SBOM attached as a digest-bound attestation, scanned
  advisory-only. Not attached today.

Both of the unshipped two are deferred beta work rather than dropped commitments: they are the
signing half of the compensating-controls set in `threat-model.md` §6 and they are expected before v1.
Until they land, verify the reproducibility and do not assume the other two.

The mechanical commands for the part that works are in the `operations` reproducible-build runbook.

## 6. Certificate trust

Your client must trust the server's TLS certificate. On a **native client** (desktop, mobile) that trust
is a **certificate pin**, and the pin is the whole of it: the pinned verifier replaces CA-chain validation,
so a certificate other than the pinned one fails the handshake outright.

**The SCRAM channel binding adds nothing to that in any deployment fronted by a terminating proxy**, which
is every deployment described here, the bundle's own Caddy edge included. The `-PLUS` `tls-exporter`
binding is wired end to end on both sides, and it engages **only when the server process itself terminates
TLS 1.3** (`decisions.md` 2026-07-13); behind a proxy that terminates TLS, both ends bind to empty and the
exchange degrades to plain SCRAM-SHA-256 riding pinned TLS. So the man-in-the-middle resistance in the
paragraph above is the pin's, and the binding is latent rather than a second lock on the same door. Making
it real is a topology change — the server terminates TLS 1.3 and the proxy moves to TCP passthrough — and
either way it is gated behind the standing R3 primitive-level review, which is also why no surface in the
client presents certificate trust as *verified* (`threat-model.md` §1 A4).

**Neither the pin nor the binding is available to the web client, and neither ever will be.** A browser
exposes neither TLS-exporter keying material nor a certificate-pinning API to page JavaScript, so a
browser session rests on the browser's own trust store and nothing more — permanently, not pending some
later release (`decisions.md` 2026-07-26). What is unchanged either way: a man-in-the-middle on the sync
connection sees only ciphertext. What a web client additionally depends on is the origin that serves it
the client code, which is a separate boundary with a separate adversary (`threat-model.md` TB11 / A15) —
and if you self-host the web client too, that origin is yours.

- **Hosted:** a build-time static pin for the hosted endpoint is the **settled design** (`decisions.md`
  2026-06-20) and is **not shipped**. The hosted certificate and domain do not exist yet, so the client's
  hosted-pin lookup deliberately answers "no pin", and a hosted endpoint is pinned by TOFU like any other
  — filling in the constant is the whole remaining change and lands with its own `decisions.md` entry at
  hosted launch. What already ships is the *distinction*: the client records where a pin came from and
  surfaces it, so a first-connect TOFU pin is never presented as the pre-vetted hosted one.
- **Self-host:** **trust-on-first-use (TOFU)**, shipped with the Phase 2 client work (MYND-424). When you
  point a native client at your endpoint it completes one TLS handshake, records the SHA-256 of the leaf
  certificate it was served, and verifies every later connection against that pin; you **eye-compare the
  fingerprint** the client shows you across your devices (the same out-of-band channel the device-approval
  gate already uses). It is *assumed* trust rather than verified cryptography — the first connection is
  taken on faith, and the eye-compare is what turns it into something you checked. **When you renew
  that certificate, connected clients stop syncing until they trust the new one** — the pin is the
  whole certificate's hash, so any renewal invalidates it, and the client says so specifically rather
  than reporting a network error. Re-entering the server URL asks you for the new fingerprint (get it
  with `openssl x509 -noout -fingerprint -sha256 -in <your certificate file>`) and will not adopt a
  different certificate without it; that refusal is deliberate, because a renewal and an impostor look
  identical from the client's side. A loopback `http`
  endpoint has no certificate, so nothing is pinned and the client reports that rather than implying a
  pin. A **browser cannot pin at all** (above): it reports that the platform's trust store is doing the
  verifying, which is a third answer rather than a missing one.

## 7. The honest limitation (what TB5 does and doesn't buy you)

The protocol structurally prevents the server from reading your content. It **cannot** structurally prevent
a *malicious or compelled* operator from logging IPs, retaining old ciphertext, or correlating metadata
**at the policy level** — that is exactly why these are *obligations* in §2, not guarantees. When you
self-host, your users are trusting **your** adherence to the policy column; when they use the hosted
service, they are trusting ours. This residual is recorded normatively in `threat-model.md` §7 (self-host
known limitation). Neither hosting model claims more than this — and that honesty is the point.
