# Self-hosting Myne — operator policy

> **Status:** normative operator contract for the Phase 2 sync server (MYND-413). This document is the
> operator-facing projection of `spec/server-protocol.md` §6 and `threat-model.md` TB5/§7. The
> *mechanical* HOW (compose, env vars, snapshot commands) lives in the `myne-ops` runbooks; this is the
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
- **Expose the operator panel (`MYNE_ADMIN_PANEL_ADDR`) to a network you do not control.** This is a
  hazard disclosure, not a configuration ban: §4 below lists the same variable as a knob, and the two
  describe one act. The panel is **read-only and carries no authentication**: anything that can reach
  that address reads your account roster and can issue no command. Three facts an operator has to have
  before binding it anywhere but loopback, none of which the server can enforce:
  - **The listener serves plain HTTP and terminates no TLS**, so on a non-loopback bind the roster
    crosses the network in the clear to any passive observer.
  - **The roster is a list of credentials.** The hash is the selector for the server's pre-auth
    `GET /vault.meta` route, which returns each account's Argon2id salt, cost parameters and both
    wrapped key copies, so it is enough to mount an offline password-cracking attempt. "The hash is
    not reversible" is not the reassurance it sounds like.
  - **The bind address is not validated and the server does not refuse it.** It prints one startup
    warning. The server cannot refuse, because the same knob on the metrics listener has legitimate
    non-loopback uses; the difference is that metrics carries aggregate counters and this carries a
    per-account roster.
  Never add a reverse-proxy route for the panel, and never point it at a public origin.
- **Attempt to weaken the zero-knowledge protocol** in any way — you can't read content regardless, but you
  must not, e.g., add a plaintext side-channel or a metadata-correlation log.

## 4. Policy knobs you control

Set via env vars in the bundle (see the `myne-ops` bundle README for syntax). These bound **storage and
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
- **Operator panel** (`MYNE_ADMIN_PANEL_ADDR`). The browser console: read-only, **off by default**,
  unauthenticated, and the one operator surface that can sit on a network. Set it only if you want the
  page. The bind address is **not validated** and a non-loopback address is **warned about, not
  refused** (see §3 for the three things that warning cannot do for you). Enforcement stays in the
  `myne-server admin` command line, on a local Unix socket reachable by whoever can
  `docker compose exec`. Never add a reverse-proxy route for the panel.
- **Operator panel allowed hosts** (`MYNE_ADMIN_PANEL_HOSTS`). Extra `Host` values the panel will
  answer to; **empty means loopback names only**, which is the safe default. This is the panel's entire
  defence against DNS rebinding, and it is not optional: a rebound hostname is same-origin to whatever
  page is attacking you, and browsers send no `Origin` on a GET, so neither the same-origin policy nor
  an origin check stops a rebound read. If you bind a LAN address and browse to it by name, you must
  name that host here.
- **Metrics** (`MYNE_METRICS_ADDR`). The Prometheus endpoint, disabled by default, on its own separate
  listener. Eight counters, aggregate over every account for the life of the process, with **no
  per-account label and no time series**; that is not a claim you have to take on trust, it is held by a
  structural denylist in the server's own metrics test, so a label that would let an observer separate
  accounts fails the suite. A non-loopback bind is usually correct here, because scraping from another
  host is the ordinary deployment; the server warns rather than refuses. Bind it to localhost or an
  internal address if your scraper is not. (Contrast the panel above, which is per-account by
  construction and therefore keeps only the no-time-series half of that invariant.)
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

The mechanical commands for the part that works are in the `myne-ops` reproducible-build runbook.

## 6. Certificate trust

Your client must trust the server's TLS certificate. Native clients (desktop and mobile) verify
the certificate chain and server hostname against the Mozilla public CA roots bundled with the
application. The browser client uses the browser's own trust store. None of the clients pins a
certificate or asks you to transcribe its SHA-256 fingerprint (`decisions/sync/0620`, which
withdraws the trust-on-first-use and static-pin mechanisms this section previously described). A
self-signed certificate is not trusted by the native clients merely because the operating system
trusts it: the roots are compiled into the application, so a private CA installed on your machine,
on your phone, or pushed to your fleet by device management is **not consulted**.

**The case where this leaves you with no supported answer, stated rather than left implicit.** If
you serve on a private network, an internal hostname, or a bare IP address, no public CA will issue
you a certificate, and no public CA bundle contains your root. Native clients will therefore refuse
the endpoint on the first connection, and there is nothing in Settings that recovers it: the
client will not accept a private root, and the refusal is not a pin mismatch to be replaced. This
paragraph is the whole of the operator contract for that case, and it is short because the
product has no answer to give. What is available, in the order I would reach for:

- **Get a publicly trusted certificate for a name that resolves.** A real domain with a public
  certificate is the supported path, and it is the only one the client verifies.
- **Terminate elsewhere and give the clients a public name.** If the sync server is reachable only
  on a LAN, a reverse proxy or tunnel that presents a publicly trusted certificate to the client
  is the shape that works; the client never sees the private leg.
- **Do not sync from a client that must use the private address.** A desktop pointed at a loopback
  endpoint is the exception the client still permits, and it is a developer case rather than an
  operator one.

None of these is automatic, and I am not going to describe any of them as though it were. If your
deployment genuinely cannot satisfy one, the honest statement is that native sync does not work
against it, and the failure mode you will see is a TLS error on connect with your configured
endpoint left intact on disk.

**The SCRAM channel binding adds nothing to TLS authentication in any deployment fronted by a terminating proxy**, which
is every deployment described here, the bundle's own Caddy edge included. The `-PLUS` `tls-exporter`
binding is wired end to end on both sides, and it engages **only when the server process itself terminates
TLS 1.3** (`decisions.md` 2026-07-13); behind a proxy that terminates TLS, both ends bind to empty and the
exchange degrades to plain SCRAM-SHA-256 riding verified TLS. So the man-in-the-middle resistance in the
paragraph above is the CA-chain and hostname check, and the binding is latent. Making
it real is a topology change — the server terminates TLS 1.3 and the proxy moves to TCP passthrough — and
either way it is gated behind the standing R3 primitive-level review, which is also why no surface in the
client presents certificate trust as *verified* (`threat-model.md` §1 A4).

**The channel binding is unavailable to the web client.** A browser
exposes neither TLS-exporter keying material nor a certificate-pinning API to page JavaScript, so a
browser session rests on the browser's own trust store and nothing more — permanently, not pending some
later release (`decisions.md` 2026-07-26). What is unchanged either way: a man-in-the-middle on the sync
connection sees only ciphertext. What a web client additionally depends on is the origin that serves it
the client code, which is a separate boundary with a separate adversary (`threat-model.md` TB11 / A15) —
and if you self-host the web client too, that origin is yours.

- **Hosted and self-hosted:** a native client checks the same public CA roots and hostname at
  first connect and on every reconnect, including over Tor. A valid renewed certificate does
  not interrupt sync. An untrusted, expired or wrong-hostname certificate fails the handshake;
  neither a stored legacy pin nor a QR payload can override that refusal. Two consequences follow
  from the bundled-roots model that this section owns: a root a browser has stopped trusting keeps
  being trusted by a client until Myne ships a release that updates the bundle, and revocation is
  never checked, so a certificate its issuer has withdrawn stays usable until it expires
  (`threat-model.md` §1 A4 amendment). A loopback `http` endpoint has no TLS, and any client build
  will accept one on loopback, which is what makes the local E2E harness and a developer's own
  machine work; it is a developer case rather than a restricted one, and no shipped setting turns
  it off.

## 7. The honest limitation (what TB5 does and doesn't buy you)

The protocol structurally prevents the server from reading your content. It **cannot** structurally prevent
a *malicious or compelled* operator from logging IPs, retaining old ciphertext, or correlating metadata
**at the policy level** — that is exactly why these are *obligations* in §2, not guarantees. When you
self-host, your users are trusting **your** adherence to the policy column; when they use the hosted
service, they are trusting ours. This residual is recorded normatively in `threat-model.md` §7 (self-host
known limitation). Neither hosting model claims more than this — and that honesty is the point.
