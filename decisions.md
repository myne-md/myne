# Decisions

> **This file is the running log of every meaningful decision made on the Myne project. Whenever a decision is made — in chat, in a meeting, in a spec, in a PR — append a brief entry here. Keep entries short; link out to the spec, ADR, or PR for the full rationale. Never delete past entries; if a decision is reversed, add a new entry that supersedes it.**

This is not a replacement for `adr/` — ADRs are deeper, single-decision documents. `decisions.md` is the scannable timeline that points at them.

---

## How to use this file

- **Append at the bottom**, in chronological order. Newest entry last.
- **Use the format below.** Every entry has a date, a one-sentence decision, a one-sentence rationale, and (optionally) a reference link.
- **One entry per decision**, even if several land on the same day.
- **Reversals get new entries.** Don't edit history. If decision X is overturned, write a new entry that says "supersedes <date> — <title>".
- **Link generously.** If the decision is captured in a spec, ADR, or PR, link to it. The log is a pointer, not a substitute.
- **Deferrals count.** "We are explicitly not deciding X yet" is itself a decision worth logging.

## Format

```
### YYYY-MM-DD — <short title>
**Decision.** One sentence.
**Rationale.** One sentence.
**Reference.** (optional) `path/to/file.md#section` or PR link.
```

---

## Log

### 2026-04-26 — Project shape: privacy-first, open-source, encrypted markdown notes
**Decision.** Build Myne as an open-source, end-to-end-encrypted markdown notes app with local-first storage and optional zero-knowledge sync (hosted + self-host).
**Rationale.** Founder has a personal need and a product opportunity; the Obsidian-flexibility + true-E2EE + open-source + self-host combination is genuinely unoccupied in the market.
**Reference.** `e2ee-notes-evaluation.md`

### 2026-04-26 — Project name placeholder: Myne
**Decision.** Use "Myne" as the working name; revisit before public launch.
**Rationale.** Placeholder; matches the working directory. Brand decision deferred.
**Reference.** `vision.md`

### 2026-04-26 — Tech stack: Go backend, Next.js web, Electron desktop, React Native mobile [SUPERSEDED 2026-04-26 by Tauri desktop decision below]
**Decision.** Use Go for the sync server, Next.js for the web client, Electron for the desktop app, and React Native for mobile.
**Rationale.** Matches the 2-person team's existing expertise (Go and web). Wails v3 evaluated and deferred — still alpha, not production-ready for a security-critical launch.
**Reference.** `e2ee-notes-evaluation.md#recommended-technology-stack`
**Note.** This Electron baseline was reversed later the same day in favor of Tauri (Rust core); see "Stack realignment to Tauri" entry below. This entry is preserved for audit trail.

### 2026-04-26 — Build phase order: desktop → sync → web/mobile
**Decision.** Phase 1 = Tauri (Rust core) desktop, local-only. Phase 2 = Go sync server. Phase 3 = web + mobile. Phase 4+ = collaboration, sharing.
**Rationale.** Multi-platform is the silent killer in this category (Turtl, Laverna). Desktop-first is the lowest-risk start with the highest-value persona.
**Reference.** `vision.md#phase-1-scope`

### 2026-04-26 — Auth model: self-generated account number, no email
**Decision.** Account identity is a self-generated number (Mullvad-style format), not an email address. Master password + BIP39 24-word recovery phrase derive the encryption keys.
**Rationale.** Email-based recovery silently breaks zero-knowledge. The privacy press will notice. The bar is hard.
**Reference.** `vision.md#what-myne-is-not`

### 2026-04-26 — No VC funding, no acqui-hire path
**Decision.** Myne will not raise venture capital.
**Rationale.** Skiff (2024) is the canonical cautionary tale: VC pressure forced a Notion acquisition, the product was killed inside 12 months, 2M users lost their notes home. Bootstrapped, slow growth is the only model that aligns with a privacy promise.
**Reference.** `vision.md#what-myne-is-not`

### 2026-04-26 — Open-source the entire stack
**Decision.** Client, sync server, protocol spec, build pipeline — all open source. No "open core" model, no proprietary enterprise build.
**Rationale.** Privacy users vet the source; a closed component anywhere in the chain breaks the trust story.
**Reference.** `vision.md#what-myne-is-not`

### 2026-04-26 — Business model: local free, hosted sync paid, self-host always free
**Decision.** Local app is fully free. Hosted zero-knowledge sync is the paid tier. Self-hosting the sync server is free and first-class.
**Rationale.** Conversion comes from the convenience of hosted sync, not from feature paywalls. Standard Notes paywalling markdown is the explicit anti-pattern.
**Reference.** `vision.md#what-myne-is-not`

### 2026-04-26 — Crypto primitives: clone Standard Notes 004
**Decision.** Use Argon2id (m=64 MiB, t=5, p=1) for KDF, XChaCha20-Poly1305 for AEAD, X25519 for asymmetric ops, BIP39 24-word phrase wrapping the root key, libsodium as the single client crypto library.
**Rationale.** Standard Notes 004 is the only published, audited spec in this space. Cloning it is the fastest path to credibility without an audit budget.
**Reference.** `e2ee-notes-evaluation.md#recommended-technology-stack`

### 2026-04-26 — Markdown-on-disk as portability commitment
**Decision.** Notes are plain markdown files after decryption. No proprietary format, no internal database that "owns" content.
**Rationale.** Portability is part of the wedge — users can quit and walk away with their files into any editor. If Myne disappears, the data survives.
**Reference.** `vision.md#the-wedge`

### 2026-04-26 — Phase 1 v1.0 includes minimal graph view
**Decision.** v1.0 ships with a lazy-loaded, Cytoscape.js-based graph view in a separate panel.
**Rationale.** The wedge sentence promises "backlinks and graph are first-class". v1 has to credibly back that, even if minimally. Demote to v1.1 only if implementation slips.
**Reference.** `vision.md#phase-1-scope`

### 2026-04-26 — Definition of done for v1.0: the recovery-flow drill
**Decision.** v1.0 ships when a real user can install the desktop app, generate a recovery phrase, write notes for 30 days, deliberately lose their password, recover the vault from the phrase, and never have plaintext touch the disk.
**Rationale.** Recovery is the single highest-risk piece of the project. The DoD has to reflect that.
**Reference.** `vision.md#phase-1-scope`

### 2026-04-26 — No real-time collaboration, no plugin API, no mobile in v1
**Decision.** All three are explicitly out of scope for Phase 1.
**Rationale.** Each is a multi-month line item that would silently kill the v1 timeline. CRDT (Yjs) lands in Phase 4 at earliest. Plugin API is possibly never. Mobile is Phase 3.
**Reference.** `vision.md#phase-1-scope`

### 2026-04-26 — No AI features in v1, possibly never (deferred, not rejected)
**Decision.** No AI / LLM features are built into v1. The category is open for reconsideration only if the answer is a fully local model with no provider call.
**Rationale.** Sending notes to an LLM provider would silently invalidate the privacy claim. Local-only inference might be acceptable later but is not a v1 priority.
**Reference.** `vision.md#what-myne-is-not`

### 2026-04-26 — Audit substitute: public spec + threat model + reproducible builds
**Decision.** No paid third-party audit in v1. Compensating controls are: public protocol spec, public threat model, reproducible signed builds, hash-pinned WASM, security.txt, public bug bounty (acknowledgment-only is acceptable).
**Rationale.** No budget for a paid audit. The above is the credible substitute privacy press requires.
**Reference.** `e2ee-notes-evaluation.md#compensating-controls-for-the-missing-audit`

### 2026-04-26 — Vision one-pager written
**Decision.** Created `vision.md` with seven sections (tagline, problem, target user, wedge, success criteria, anti-features, phase 1 scope) and an embedded decisions log.
**Rationale.** First strategic doc. Anchors all later technical specs against a single shared idea of the product.
**Reference.** `vision.md`

### 2026-04-26 — Adversary catalog: 13 classes with explicit status
**Decision.** Threat model classifies 13 adversary classes (A1–A13) into Strong / Mitigated / Best-effort / Out-of-scope. A1 (passive cloud) and A2 (compelled lawful access) are Strong-guarantee. A6 (unlocked device) and A12 (coerced user) are Out of scope in v1. A7, A10, A13 are Best-effort.
**Rationale.** "All in scope" is unrealistic and would mirror the ProtonMail-2021 marketing-vs-reality trap. Explicit status per class lets marketing copy be reviewed against architecture.
**Reference.** `threat-model.md#1-adversary-classes`

### 2026-04-26 — Encrypted timestamps + opaque server-side version counter (AS6)
**Decision.** User-meaningful timestamps (created_at, updated_at) live inside the encrypted blob. The sync server uses an opaque per-note monotonic integer for conflict detection; conflict resolution happens client-side after decryption.
**Rationale.** Joplin issue #6456 is the cautionary tale — plaintext timestamps leak usage patterns and get the project killed in r/PrivacyGuides. Cost: sync-protocol simplicity. Benefit: no metadata leak.
**Reference.** `threat-model.md#2-assets`

### 2026-04-26 — Hard architectural commitment: no IP logging (AS14)
**Decision.** The sync server does not persistently log source IP addresses. TLS termination sees the IP for the duration of a request and discards it. Abuse mitigation must function on per-account counters, not per-IP.
**Rationale.** ProtonMail 2021 — IP logs scrubbed from marketing after a Swiss legal incident. The cleanest defense is to never have the data. This commitment must be reflected in the sync-protocol design from day one.
**Reference.** `threat-model.md#2-assets`

### 2026-04-26 — Self-hosted server is the same trust boundary as hosted (TB5)
**Decision.** The protocol treats hosted and self-hosted sync servers identically. Self-hosting changes the operator, not the security model.
**Rationale.** Symmetric trust. A user moving from hosted to self-host (or vice versa) gets the same protocol guarantees with no new threat model.
**Reference.** `threat-model.md#3-trust-boundaries`

### 2026-04-26 — Auto-update enabled, gated by signature + hash verification (TB7)
**Decision.** Desktop client supports auto-update. Updates are refused if signature or content hash verification fails.
**Rationale.** Security patches need to ship fast; manual-update only delays user safety. Verification gate prevents A4/A9 attacks via the update channel. Reproducible builds let third parties verify the released artifact.
**Reference.** `threat-model.md#3-trust-boundaries`

### 2026-04-26 — Compensating controls codified as audit substitute
**Decision.** v1 ships without a paid third-party audit but with: public protocol spec, public threat model, public limits doc, reproducible builds, signed releases, hash-pinned dependencies, SECURITY.md + security.txt, public bug-bounty page, spec-then-bounty cadence, and pre-launch external review by at least one independent cryptographer or security researcher.
**Rationale.** No audit budget. Compensating controls are credible substitutes the privacy-research community recognizes; silence is worse than acknowledged limits.
**Reference.** `threat-model.md#6-compensating-controls-no-audit-budget`

### 2026-04-26 — Hard line: no email recovery, ever
**Decision.** If recovery-phrase UX support volume becomes unmanageable, the response is better in-product UX (forced phrase confirmation, optional encrypted recovery file written to user-controlled storage). Email recovery will not be added as a compensating control.
**Rationale.** Adding email recovery silently invalidates the zero-knowledge claim — Standard Notes / Bitwarden bleed users at this step but hold the line for exactly this reason. Reversal of this decision requires a threat-model amendment with explicit user communication.
**Reference.** `threat-model.md#7-known-limitations--open-issues`

### 2026-04-26 — Threat model v0.1 written
**Decision.** Created `threat-model.md` with eight sections (adversaries, assets, trust boundaries, protected against, NOT protected against, compensating controls, limitations, comparison) plus a Decisions log.
**Rationale.** Required pre-code artifact. Establishes the boundary that the protocol spec must defend.
**Reference.** `threat-model.md`

### 2026-04-26 — Protocol spec strategy: Option C (v0.1 + v005 roadmap)
**Decision.** Ship `spec/protocol.md` v0.1 as the implementation-target protocol, alongside a separate `spec/protocol-v005-roadmap.md` (to be authored from the founder's research) as the long-term aspirational reference. v0.1 is shippable in 1–2 weeks; v005 captures the multi-year direction without blocking v1.
**Rationale.** Writing v005 as the primary spec is a 4–6-month project including formal verification. Phase 1 needs a closed, auditable spec now. v005 stays as a reference document so the research investment is not wasted.
**Reference.** `spec/protocol.md`

### 2026-04-26 — Subkey derivation pattern: derive_key with registered context strings
**Decision.** All subkeys are produced by `derive_key(root_key, context_string)`. Context strings are drawn from a registered table prefixed with `"myne.v0.1 "`. Adding a new subkey role in a minor revision does not require a protocol bump; only a new context string is registered.
**Rationale.** Forward-compatibility for v005's anticipated additional subkey roles (epoch keys, sharing keys, hardware-unlock derivatives) without breaking v0.1's wire format.
**Reference.** `spec/protocol.md` §3.2, §3.4

### 2026-04-26 — Three-level note key wrapping
**Decision.** `itemsKey_wrap_key → itemsKey → item_key → plaintext`. The persistent itemsKey is a singleton 32-byte random value in v0.1, re-wrapped (not regenerated) when the password changes.
**Rationale.** Password rotation is a single AEAD operation regardless of vault size. Per-note `item_key` material is untouched. The `items_key_id` field on each blob structurally generalizes to v005's epoch identifier.
**Reference.** `spec/protocol.md` §3.3

### 2026-04-26 — On-disk binary format with magic bytes
**Decision.** Per-note encrypted blobs use the `MY01` magic and `.myn` extension; vault metadata uses `MYV1` magic in `vault.meta`. All multi-byte integers are big-endian. No JSON envelope.
**Rationale.** Compact, deterministic parse; v005 will use `NT05`/`NTV5` to make cross-version substitution structurally impossible.
**Reference.** `spec/protocol.md` §9

### 2026-04-26 — AAD construction with `"myne.v0.1|"` domain prefix
**Decision.** Both AEAD operations (item-key wrap and content encryption) bind an AAD that begins with `"myne.v0.1|"` and includes `protocol_version`, `items_key_id`, `note_uuid`, and (for content) `content_type`.
**Rationale.** TLS 1.3 §4.1.3 model. Downgrade, key substitution, blob substitution, and cross-version substitution all fail the AEAD tag check rather than producing silently wrong plaintext.
**Reference.** `spec/protocol.md` §5.2

### 2026-04-26 — Architectural shift: random root_key + dual-credential wrap
**Decision.** `root_key` is a 32-byte random persistent value generated at vault creation, not derived from the password. The master password and the BIP-39 recovery phrase each derive an Argon2id-strengthened wrap key; each wraps an independent copy of `root_key`. Both encrypted copies live in `vault.meta`.
**Rationale.** Required for the previously-committed recovery flow. If `root_key` were a function of the password, losing the password would unconditionally destroy the vault. The dual-wrap pattern also forward-compats to v005 hardware-unlock as a third wrap.
**Reference.** `spec/protocol.md` §3.1

### 2026-04-26 — BIP-39 phrase strengthened via Argon2id directly
**Decision.** The 24-word recovery phrase is fed directly to Argon2id (with the same parameters as the password path) to produce `recovery_wrap_key`. BIP-39's standard PBKDF2-HMAC-SHA512-2048 is **not** used; BIP-39 here is purely an encoding for 256-bit entropy.
**Rationale.** PBKDF2-2048 is too weak by 2026 standards; brute-forcing a recovery phrase is feasible if the user picks one from any structured source. Argon2id raises the cost of phrase brute-force to match the password path.
**Reference.** `spec/protocol.md` §7

### 2026-04-26 — Account number format: Crockford base32 + Damm-32 check
**Decision.** 19 random Crockford base32 characters (95 bits entropy) + 1 Damm-32 check character = 20 canonical characters. Display as `MY-XXXX-XXXX-XXXX-XXXX-X`. Normalization: NFKD, strip prefix/separators, uppercase, validate length and Damm. Cryptographic identifier is `SHA-256(canonical)[:16]`.
**Rationale.** Higher entropy (95 vs Mullvad's ~53 bits) and stronger error detection (Damm catches more two-character errors than Luhn). The "MY-" prefix is human-readable presentation only and not part of the canonical form.
**Reference.** `spec/protocol.md` §8; `spec/account-number.md`

### 2026-04-26 — Forward-incompatible major-version model
**Decision.** Each major protocol version (v0.1, v005, …) is a closed, complete spec with distinct magic bytes, AAD prefix, and context-string prefixes. Cross-major reads occur only via explicit user-initiated migration. v0.1 contains no extension points, no capability bitfield, no algorithm-agility headers.
**Rationale.** Eliminates downgrade attacks structurally. Each version can be audited as a self-contained system. Future architectural changes (PQ hybrid, MLS, OPAQUE, KT) are too deep to ship as additive extensions; pretending otherwise produces a sham-compatibility illusion. Lessons from POODLE/FREAK/Logjam/MEGA-2022.
**Reference.** `spec/protocol.md` §10

### 2026-04-26 — Five protocol decisions deferred to dedicated sessions
**Decision.** The following five choices are recorded as `[DEFERRED]` in `spec/protocol.md` and will be resolved before v1.0 ship: (1) Argon2id parameters (m=64 MiB vs m=1 GiB), (2) subkey derivation primitive (HKDF-SHA-256 vs BLAKE3), (3) AEAD wrapper (plain XChaCha20-Poly1305 vs CTX commitment), (4) server authentication (simple Argon2id vs OPAQUE), (5) stack realignment (Electron+Go vs Tauri+Rust).
**Rationale.** The v005 research proposes alternatives to current `decisions.md` baselines. Each is independent of the protocol structure and can be resolved without rewriting the spec. Deferring keeps v0.1 momentum while preserving the option to upgrade.
**Reference.** `spec/protocol.md` §2, §4, §5, §10

### 2026-04-26 — Protocol spec v0.1 written
**Decision.** Created `spec/protocol.md` with twelve sections (overview, primitives, key hierarchy, KDF, AEAD, per-note encryption, recovery, account number, on-disk format, versioning/migration, out of scope, decisions log) and a sibling `spec/account-number.md` skeleton.
**Rationale.** Required pre-code artifact and the credible substitute for the missing third-party audit (per threat-model §6 compensating controls).
**Reference.** `spec/protocol.md`

### 2026-04-26 — Argon2id parameters resolved: m=256 MiB, t=3, p=2, version 1.3 (Deferred #1 of 5)
**Decision.** Argon2id parameters are `m=256 MiB, t=3, p=2`, Argon2 version 1.3. Parameters are **stored in `vault.meta`** as an 11-byte canonical block (kdf_id || kdf_m_kib || kdf_t || kdf_p || argon2_version), not hardcoded in the client. The canonical block is bound into both `AAD_password_wrap` and `AAD_recovery_wrap` so any tampering invalidates the AEAD tag on the wrapped root_key copies.
**Rationale.** Middle-ground between SN004 baseline (64 MiB, weak by 2026 standards) and the research recommendation (1 GiB, doesn't fit Phase 3 web/mobile). 256 MiB is ~4× SN004 and works on all target platforms (desktop ≈1s, mid-tier mobile ≈2–3s, libsodium.js in browser). Storing parameters in vault.meta enables (a) future parameter upgrades without format break, (b) per-platform calibration, (c) auditor transparency. AAD binding eliminates parameter-downgrade attacks structurally.
**Reference.** `spec/protocol.md` §4

### 2026-04-26 — Password strength expectations clarified
**Decision.** Argon2id parameters are calibrated to provide ≥80 bits of effective security when combined with a password of ≥60 bits of entropy. Implementations SHOULD enforce minimum password strength at signup (≥12 chars, zxcvbn ≥3, dictionary check). Users with weaker passwords are protected primarily by their 256-bit recovery phrase.
**Rationale.** KDF parameters cannot fully protect a 30-bit-entropy password regardless of m/t/p. The architectural defense for weak passwords is the recovery phrase being independent of password choice.
**Reference.** `spec/protocol.md` §4.1

### 2026-04-26 — Subkey derivation primitive resolved: HKDF-SHA-256 (Deferred #2 of 5)
**Decision.** Subkey derivation uses **HKDF-SHA-256** (RFC 5869) via libsodium's native API. All subkey derivations go through a **single canonical helper** that constructs the `info` parameter as `"myne.v0.1 " || role` from a registered role identifier. Direct calls to HKDF-Expand outside this helper are forbidden by code review.
**Rationale.** Three sharp constraints decided this. (1) v005 will adopt MLS, and RFC 9420 mandates HKDF for the MLS key schedule — running two KDFs in one client doubles audit surface for no benefit. (2) HKDF has published Tamarin/ProVerif/CryptoVerif models (TLS 1.3, Signal, MLS, WireGuard); BLAKE3 derive_key would require new modeling, increasing the formal-verification investment cost. (3) HKDF is libsodium-native; BLAKE3 requires a separate dependency, increasing supply-chain surface. BLAKE3's "structural context binding" advantage is recovered at codebase level via the single-helper pattern at zero cost.
**Reference.** `spec/protocol.md` §3.2

### 2026-04-26 — Single canonical helper enforces context-string discipline
**Decision.** All HKDF-Expand calls for subkey derivation MUST go through `DeriveSubkey(rootKey, role)` (or its language equivalent), which constructs `info = "myne.v0.1 " || role` from the registered role table (§3.4). Code review MUST reject any direct invocation of `hkdf.expand` / `crypto_kdf_hkdf_sha256_expand` outside this helper.
**Rationale.** HKDF's historical misuse pattern is malformed or empty `info` parameters. The single-helper rule eliminates this risk structurally — no developer can pass a wrong info string because the only path constructs it from the registry. This recovers the API-level guarantee that BLAKE3 derive_key offers natively.
**Reference.** `spec/protocol.md` §3.2.1

### 2026-04-26 — AEAD wrapper resolved: XChaCha20-Poly1305 + CTX commitment, SHA-256 outer (Deferred #3 of 5)
**Decision.** Every AEAD operation in the protocol uses XChaCha20-Poly1305 wrapped in the CTX commitment construction (Chan & Rogaway, ESORICS 2022): `T' = SHA-256(K[32] || N[24] || len(AD)[4 BE] || AD || T[16])`. The Poly1305 tag T is recomputed at decrypt time and not stored on disk; the 32-byte CTX commitment tag T' takes its place. All on-disk tag fields grow from 16 to 32 bytes (§9.2 enc_item_key, ciphertext; §9.3 enc_root_key_password, enc_root_key_recovery, enc_items_key).
**Rationale.** Plain XChaCha20-Poly1305 is not key-committing; partitioning-oracle attacks (Len–Grubbs–Ristenpart, USENIX 2021) exploit this against weak passwords + leaked vault.meta. The audit story would otherwise be inconsistent: the v005 research roadmap explicitly recommends CTX, and shipping v0.1 without it would force "we know about this attack and ignored it" as the answer to an auditor. Cost is ~30 lines of code, ~0.001% performance, ~32 bytes per note on disk. The canonical encoding with length-prefixed AD eliminates concatenation ambiguity per Chan & Rogaway §3.
**Reference.** `spec/protocol.md` §5.1

### 2026-04-26 — Server-auth deliberately deferred to Phase 2, with v005 OPAQUE commitment (Deferred #4 of 5)
**Decision.** The choice between simple verifier (Standard Notes 004 style) and OPAQUE aPAKE (RFC 9807) for sync-server authentication is **not made in v0.1**. v0.1 derives the `server-auth` subkey but does not transmit it. The Phase 2 ship will resolve the choice using documented criteria: OPAQUE library maturity at that time, presence of credible audits, self-host operator feedback from Phase 1 dogfooders, threat-model evolution. v005 canonicalizes OPAQUE.
**Rationale.** Phase 2 is 6–9 months away. OPAQUE ecosystem is moving fast: more production deployments and audits will exist by Phase 2 start. Self-host operator complexity tolerance is unknown until Phase 1 ships. Deciding now risks (a) committing to a simple verifier that v005 will throw away, or (b) committing to OPAQUE on libraries that may not be audit-ready. The disciplined position is to resolve at the right time, not the earliest time. RFC 9420 (MLS) sets precedent: spec contains explicit "to be determined in future ciphersuite" sections without losing rigor.
**Reference.** `spec/protocol.md` §11.1

### 2026-04-26 — Stack realignment to Tauri (Rust core) for desktop (Deferred #5 of 5)
**Decision.** Phase 1 desktop client is **Tauri (Rust core) + Next.js UI**, not Electron. Crypto core in Rust using libsodium bindings (`libsodium-sys-stable` or equivalent), with RustCrypto crates as a fallback for primitives where libsodium bindings prove inadequate. Server remains Go. Phase 3 web remains Next.js with libsodium-js. Phase 3 mobile path (React Native + Rust bridge vs Tauri Mobile vs other) is deferred to Phase 3 start. **Supersedes** the prior Electron decision recorded earlier on 2026-04-26.
**Rationale.** Five concrete gains: (1) Structural memory hygiene via `zeroize`, `secrecy`, `subtle` crates — Rust enforces what Electron + JS GC cannot. (2) Smaller TCB and binary (~10 MB vs ~150 MB; ~40 MB idle RAM vs ~250 MB). (3) Reproducible builds achievable in months, not the 10 person-years Tor Browser took for Chromium. (4) Native availability of OpenMLS, RustCrypto ml-kem/ml-dsa for the v005 transition — no JS bridge wrappers needed. (5) Audit story upgrade — auditors will not ask "why JS for security-critical code?". Trade-offs accepted: ~1–2 month Phase 1 timeline extension for Rust ramp-up; smaller hiring pool for additional team members.
**Reference.** `spec/protocol.md` §2.2; `vision.md` Phase 1 Scope; `threat-model.md` §3 TB7, §3 TB9, §7 Tauri supply-chain

### 2026-04-26 — Glossary v0.1 written; canonical terminology home
**Decision.** Created `glossary.md` as the single canonical reference for terminology used across Myne specifications, threat model, vision, and decisions. ~115 entries covering cryptographic primitives, constructions, project-specific keys, protocol concepts, threat-model framework, product/architecture, and implementation tooling. Three small quick-reference indices at the bottom (primitives at a glance; Myne-specific keys; magic-byte and context-prefix registries). Maintenance policy is active: every new term added in any doc must be accompanied by a glossary entry in the same change.
**Rationale.** External-cryptographer review is the v1.0-ship-blocking compensating control (`threat-model.md` §6). A reviewer walking in cold needs a single term lookup; without it, every "what does Myne mean by X?" is a friction point. The cross-doc scan also surfaced four inconsistencies that the glossary now seals: ChaCha20 vs XChaCha20 distinction, BIP-39 used as encoding-only (not for PBKDF2 seed), `account_number_hash` truncation differs by use site (16 vs 32 bytes), "zero-knowledge" used informally rather than as a formal proof.
**Reference.** `glossary.md`

### 2026-04-26 — Rebrand: NoteTake → Myne (atomic protocol-identifier change)
**Decision.** The project working name changes from **NoteTake** to **Myne**. The change is atomic and includes the cryptographically load-bearing protocol identifiers, not only the prose. Specifically:

- Prose noun: `NoteTake` → `Myne` (all docs).
- AAD prefix (§5.2 of protocol spec): `"notetake.v0.1|"` (14 ASCII bytes) → `"myne.v0.1|"` (10 ASCII bytes). Bound into every AEAD tag.
- HKDF context-string prefix (§3.2): `"notetake.v0.1 "` (with trailing space) → `"myne.v0.1 "`. The single canonical helper `DeriveSubkey(rootKey, role)` constructs `info` from this new prefix. v005 prefix becomes `"myne.v005 "`.
- Salt domain prefixes (§3.1): `"notetake.v0.1 argon2id-password|"` → `"myne.v0.1 argon2id-password|"`; same for `argon2id-recovery|`.
- Magic bytes (§9): per-note blob `NT01` → **`MY01`**; vault metadata `NTV1` → **`MYV1`**. v005 reservation: `NT05`/`NTV5` → `MY05`/`MYV5`.
- File extension: `.ntn` (NoteTake Note) → **`.myn`** (Myne Note).
- Account-number display prefix: `NT-XXXX-...` → **`MY-XXXX-...`**. Liberal-parsing rule strips `MY-` / `my-` (case-insensitive).
- Protocol identifier string: `notetake-protocol-v0.1` → `myne-protocol-v0.1`.

The change is safe because **no implementation has shipped yet** — no v0.1 client exists, no vault on any disk uses the old identifiers. The five spec docs (`vision.md`, `threat-model.md`, `protocol.md`, `account-number.md`, `glossary.md`) plus this `decisions.md` were updated in a single sed-driven pass with verification.

**Rationale.** GitHub organization registered as `myne-md` with billing email `info@myne.md` and domain `myne.md` reserved — the brand commitment is real and should be reflected in cryptographic identifiers from day one of v0.1. Letting the prose be Myne while the AAD prefix said `notetake.v0.1|` would be a silent inconsistency that an auditor would flag immediately, and any future prefix change would be a major-version event because it is bound into every AEAD tag. Better to do it now, while the cost is a search-and-replace, than later when it is a migration. The repo organization (10 private repos under `myne-md`, all named `myne-*` except the flagship which is just `myne`) is the parallel structural decision.

**Reference.** Repos at https://github.com/myne-md (private). Verification: post-rebrand grep on `*` returns 0 occurrences of `NoteTake|notetake|NT01|NTV1|.ntn|"NT-"`.
