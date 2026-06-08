# Myne — Threat Model v0.1

> **Status: draft.** This document defines the adversaries Myne defends against, the assets it protects, the trust boundaries it draws, and — critically — what it does **not** protect against. Marketing copy must not exceed the guarantees in this document. When the architecture changes, this document changes in the same PR.

---

## 1. Adversary Classes

Each adversary class is assigned one of four status levels:

- **🛡️ Strong guarantee** — The architecture makes the attack technically impossible. Even with full server compromise, source code, and operator cooperation, the attacker cannot succeed.
- **🔒 Mitigated** — The architecture makes the attack significantly harder, but does not provide an absolute guarantee. Specific failure modes are documented.
- **⚠️ Best-effort** — The attack is acknowledged as feasible. We minimize damage and surface area, but defending fully is outside the scope of cryptography.
- **❌ Out of scope** — We do not claim protection against this adversary in v1. The user owns this risk.

| ID | Adversary | Status | Notes |
|---|---|---|---|
| A1 | Passive cloud provider (us, the hosted sync server, or a self-host operator) | 🛡️ Strong | Server stores only opaque ciphertext blobs and key-wrapping material. Plaintext, decryption keys, and master passwords never leave the client. |
| A2 | Compelled lawful access (subpoena, court order, national security letter) | 🛡️ Strong | The server cannot disclose what it does not possess. Account number, ciphertext blobs, sync timestamps, and IP addresses at connection time may be disclosed; note plaintext, titles, and structure cannot. |
| A3 | Passive network attacker (ISP, Wi-Fi sniffer) | 🛡️ Strong | TLS in transit plus client-side E2EE before transit. The attacker sees only encrypted bytes between encrypted bytes. |
| A4 | Active network attacker (MitM, TLS downgrade, BGP hijack) | 🔒 Mitigated | TLS with a strict configuration plus certificate pinning in clients. A successful active MitM still cannot decrypt notes, but could attempt to deliver a malicious client update — see A9. |
| A5 | Lost or stolen device (locked) | 🛡️ Strong | Master key is derived via Argon2id from a password the device does not store. With the password absent, ciphertext on disk is opaque. |
| A6 | Lost or stolen device (unlocked, app open) | 🔒 Mitigated | Auto-lock on idle bounds the exposure window: after a configurable period of machine inactivity, Myne deterministically zeroizes the in-memory keys (no further notes decryptable) and tears the currently-open plaintext out of the application (a synchronous OS-level window hide plus a best-effort WebView reload). An attacker who takes the device *during* the active window, before idle-lock fires, still sees an unlocked vault — auto-lock narrows the window, it does not close it. Residual freed-page memory, swap, and hibernation are **not** scrubbed and remain A7/A10 territory; this is deliberately not a 🛡️ Strong guarantee against forensic RAM capture. See §6 and `spec/recovery-flow.md` §3.5. |
| A7 | Malware on the user's device | ⚠️ Best-effort | Live malware running with user privileges defeats any client-side encryption — keyloggers capture passwords, screen scrapers capture decrypted plaintext. At-rest encryption protects against *dormant* malware that finds disk artifacts but does not run actively. We do not claim protection against active compromise. Some defense-in-depth via native screen-capture exclusion — see §6. |
| A8 | Compromised dependency / supply chain (npm, Go modules) | ⚠️ Best-effort | Direct-dependency hash-pinning, lockfiles checked in, minimal dependency tree, and dependency-update reviews. Cannot fully defend against a compromised transitive dependency that ships malicious code. |
| A9 | Compromised build or distribution channel | 🔒 Mitigated | Reproducible builds, code-signed releases, public release artifact hashes. Determined attackers can still social-engineer the signing key; the mitigation reduces but does not eliminate the risk. |
| A10 | State-level actor (zero-day capabilities, supply-chain access, coercion of operators) | ⚠️ Best-effort | We use boring, well-vetted primitives and publish the spec. We do not claim protection against nation-state adversaries with zero-day capabilities, hardware implants, or the legal power to compel operator cooperation beyond what A2 covers. |
| A11 | Insider threat (Myne team member acting maliciously) | 🛡️ Strong | The architecture grants the team no more access than any external attacker. Insiders cannot decrypt notes because the keys never leave the client. Code-signing keys are the one privileged asset; see A9. |
| A12 | Coerced user ("rubber-hose" / give-me-your-password) | ❌ Out of scope | No plausibly-deniable encryption in v1. If a user is compelled to enter their password, the attacker gets the data. |
| A13 | Traffic analysis (server or network observer correlates sync timing, blob sizes, account activity) | ⚠️ Best-effort | Sync metadata — timing, blob count, blob size, IP at connection — is visible to the server and to anyone observing the network. Padding, cover traffic, and timing randomization are deferred beyond v1. |

---

## 2. Assets

Each asset is classified by sensitivity and by where it is visible (client only, client + server-as-ciphertext, server-as-plaintext, or transient).

| ID | Asset | Sensitivity | Where it lives | Server visibility |
|---|---|---|---|---|
| AS1 | Note plaintext | Critical | Client only (decrypted in RAM) | Ciphertext blob only |
| AS2 | Note title | Critical | Inside encrypted blob | Ciphertext blob only — never extracted as a separate field |
| AS3 | Folder / hierarchy structure | Sensitive | Inside encrypted blob | Not visible. Server stores notes as a flat keyed set; structure is reconstructed client-side. |
| AS4 | Wikilinks / backlinks graph | Sensitive | Inside encrypted blob | Not visible. Graph is reconstructed client-side after decryption. |
| AS5 | Tag list | Sensitive | Inside encrypted blob | Not visible. |
| AS6 | User-meaningful timestamps (created_at, updated_at) | Sensitive | Inside encrypted blob | **Not visible.** Server uses an opaque per-note version counter that increments on each push — this is sync-internal state, not a user timestamp, and reveals only that *something* changed, not when. |
| AS7 | Attachment content (images, PDFs) | Critical | Encrypted blob, separate from note | Ciphertext blob only |
| AS8 | Attachment filename | Sensitive | Inside note's encrypted blob (referenced by attachment-id) | Not visible. Attachment blob size is visible (cannot avoid). |
| AS9 | Account number (Mullvad-style identifier) | Pseudonymous | Server stores a hash; raw number is the user's bearer token | Hash only — raw value never persisted server-side after registration check |
| AS10 | Master password | Critical secret | User's memory only | Never. Used only as Argon2id input on the client. |
| AS11 | Recovery phrase (BIP39) | Critical secret | User's offline storage only (paper, password manager) | Never. Server has no representation of the phrase. |
| AS12 | Root encryption key | Critical secret | Client RAM only | Never. Derived locally from password (or recovery phrase) via Argon2id + HKDF. |
| AS13 | Server-auth secret | Sensitive | Derived client-side via HKDF; server stores Argon2id verifier | Verifier hash only — raw secret never persisted server-side |
| AS14 | IP address at sync time | Metadata | Transient — server connection only | **Not logged.** No persistent storage of source IPs. TLS termination sees the IP for the duration of the request and discards it. |
| AS15 | Sync timing (when device X synced) | Metadata | Transient | Visible during the request; **not persistently logged**. The version counter (AS6) reveals that *some* sync happened, but not when. |
| AS16 | Device count per account | Metadata | Server-side registration table | Visible — each registered device gets a server-side record (necessary for revocation). |
| AS17 | Total ciphertext storage size per account | Metadata | Server | Visible — required for quota enforcement on the paid tier. |

### Key consequence of "no server-visible timestamps" (AS6)

Standard sync architectures use the user's `updated_at` timestamp for last-write-wins conflict resolution. Because that is encrypted here, the sync server cannot make conflict decisions. Instead:

- Each note has a **sync-internal version counter** (an integer, not a wall-clock time) that the server increments when a client successfully pushes a new ciphertext blob.
- Conflicts are detected via version-vector mismatch and resolved on the **client** after decryption — typically duplicate-on-conflict, surfacing both versions to the user.
- This pattern follows the Standard Notes 004 model. It costs sync-protocol simplicity for a meaningful metadata-leak reduction.

### Key consequence of "no IP logging" (AS14)

- No traditional access logs. Operational logs (errors, rate-limit triggers, abuse heuristics) must be designed to function on **counts and timestamps without IPs** — e.g., counter-based per-account rate limits, not per-IP.
- This is technically harder for abuse mitigation (no easy IP banning) and **must** be reflected in the sync-protocol design, not retrofitted.
- The "no IP logs" claim is a hard architectural commitment. Any deviation requires this document to be amended in the same change.

## 3. Trust Boundaries

A trust boundary is a line in the system where the security model changes — what is trusted on one side is not trusted on the other. Myne's boundaries, from innermost to outermost:

| ID | Boundary | Trusted with | Crossing requires |
|---|---|---|---|
| TB1 | User's memory | Master password, recovery phrase, decision to authenticate | The user's mind. If this boundary breaks (the user reveals or forgets the password and phrase), no other defense applies. |
| TB2 | User's device (kernel + user-space process) | Decrypted plaintext, root key, item keys, transient session state | OS-level isolation. We do not defend against attackers who already control the process at this layer (A6, A7). |
| TB3 | Local on-disk storage | Ciphertext blobs, salt, KDF parameters, version counters, public metadata | Argon2id derivation from the master password to obtain the root key. Disk in isolation is opaque. |
| TB4 | Network (transport) | Ciphertext bytes only | TLS 1.3 with strict configuration; certificate pinning in clients. The transport carries ciphertext-in-ciphertext. |
| TB5 | Sync server (hosted **and** self-hosted treated identically) | Opaque ciphertext blobs, hashed account-number identifiers, version counters, current-connection IPs (transient, not logged), aggregate quota counters | The server is **explicitly outside the trust boundary** regardless of operator. Self-hosting changes the operator, not the protocol's security model. The protocol assumes a curious or compelled server. |
| TB6 | Server persistent storage (Postgres + blob store) | Same set as TB5 minus transient connection state | Storage is treated as if directly readable by an adversary; nothing of value to an attacker is stored unencrypted. |
| TB7 | Code distribution channel (GitHub releases, signed Tauri auto-update, package managers) | Released artifacts authentic to the team's signing key | **Auto-update is enabled and gated by signature + hash verification.** Updates that fail signature or hash verification are refused; the user is not silently downgraded. Reproducible builds let third parties verify that the binary matches the public source. The Tauri updater's smaller TCB compared to Electron's autoUpdater reduces the attack surface here. |
| TB8 | Build pipeline & signing keys (CI runners, code-signing keys, release-tag credentials) | Authority to produce official releases | Internal team controls. Compromise here is the realistic upper-bound attack against A9. Mitigations: hardware-backed signing keys, separation of build and signing, public release-artifact hashes. |
| TB9 | Third-party dependencies (libsodium, Go modules, npm packages) | Source code that runs inside TB2 and TB5 | Hash-pinned lockfiles checked into the repository, minimal dependency tree, periodic dependency review. A compromised transitive dependency can defeat client-side encryption (A8). |

## 4. Protected Against — Specific Mechanisms

For each adversary classified as Strong or Mitigated in Section 1, the specific defense mechanism. This is the cross-product of Sections 1, 2, and 3.

| Adversary | Mechanism |
|---|---|
| **A1. Passive cloud provider** | Client-side encryption before any byte leaves the device (TB2 → TB4). Server (TB5/TB6) stores only ciphertext blobs (AS1, AS2, AS7), opaque version counters (AS6), hashed account identifiers (AS9), and aggregate quota counters (AS17). Root key (AS12), master password (AS10), and recovery phrase (AS11) never leave the client. |
| **A2. Compelled lawful access** | Same architecture as A1. The server cannot disclose what it does not possess. A subpoena forces disclosure of: ciphertext blobs (opaque), hashed account number, current connection IP (transient, no logs), version counter values, aggregate storage size. It cannot force disclosure of: note plaintext, titles, structure, links, tags, user-meaningful timestamps, master password, recovery phrase. |
| **A3. Passive network attacker** | TLS 1.3 in transit (TB4) plus client-side E2EE before transit. Two layers of confidentiality; defeating one still leaves the other. |
| **A4. Active network attacker (MitM)** | TLS 1.3 with strict cipher suites and certificate pinning in all clients. Successful active MitM cannot decrypt note contents (encryption happens above TLS) and cannot deliver an unsigned client update (TB7 verification). |
| **A5. Lost / stolen device (locked)** | At-rest encryption (AS1, AS3–AS7 inside the encrypted blobs in TB3). The root key is derived via Argon2id from the master password, which is not stored. Device disk in isolation is opaque ciphertext. |
| **A9. Compromised build / distribution** | Reproducible builds (any third party can verify that the released binary matches the public source), code-signed releases (TB7 verification refuses unsigned or tampered artifacts), public hashes for every release artifact, signature verification on auto-update before any code runs. |
| **A11. Insider threat (Myne team)** | The architecture grants the team no privileged access. Insiders see what an external attacker on the server (A1) sees — opaque ciphertext. The single privileged asset is the code-signing key (TB8); compromise reduces to A9. |

## 5. NOT Protected Against

Written in plain language for users. If any of these scenarios apply to your threat model, Myne alone is not sufficient.

- **You forget your master password and lose your recovery phrase.** Your data is unrecoverable. We cannot help. There is no "forgot password" email, no admin reset, no backdoor. This is the deliberate cost of zero-knowledge.
- **Someone is physically watching your screen.** Open notes are visible to anyone looking at your unlocked device. Myne does not auto-hide content.
- **Someone takes your laptop or phone while it is unlocked and signed in, *during* the active window.** Auto-lock on idle zeroizes your keys and clears the open note after a period of inactivity (A6 is now 🔒 Mitigated), but if an attacker grabs the device while you are actively using it — before the idle timer fires — your notes are decrypted in memory and exposed. Auto-lock narrows this window; it does not eliminate it. Forensic RAM capture, swap, and hibernation are not scrubbed and stay out of scope (A7/A10). (A6)
- **Malware is running on your device with your user permissions.** A keylogger reads your master password. A screen scraper reads your decrypted notes. Active malware defeats any user-mode encryption — no notes app can defend against this. (A7)
- **Someone forces you to enter your password.** Coercion, "rubber-hose cryptanalysis", or legal compulsion to disclose. Myne does not implement plausibly-deniable encryption. The data is exposed. (A12)
- **A nation-state-class adversary targets you specifically.** Zero-day exploits against your operating system, hardware implants, supply-chain attacks against the code-signing key. We use boring well-vetted primitives and publish the spec, but we do not claim protection at this level. (A10)
- **Traffic analysis reveals usage patterns.** A network observer or the sync server can see *that* you synced and *roughly how much* (blob count and size), even though they cannot see *what*. Myne does not pad or randomize sync timing in v1. (A13)
- **Someone in your household reads your recovery phrase.** The phrase is bearer-secret. Anyone with the phrase becomes you. Store it like cash, not like a password.
- **You install a compromised plugin** (when plugin support eventually ships). Plugins run inside the trust boundary of the client and can read decrypted notes. v1 has no plugin API for this reason; future plugin support will be capability-scoped from the first design.
- **The sync-server operator** (us, when you use hosted sync; you, when you self-host) **acts maliciously.** The protocol is symmetric — the server cannot decrypt your notes. But a malicious operator can refuse service, retain ciphertext after deletion, or correlate metadata. The architecture limits damage; it does not prevent operator misbehavior of these kinds.

## 6. Compensating Controls (no audit budget)

Myne has no budget for a paid third-party cryptographic audit. The substitute is a layered set of public, free, verifiable controls. Each control is a real engineering commitment, not a marketing line.

- **Public protocol specification** — `spec/protocol.md`. KDF parameters, AEAD construction, key hierarchy, recovery derivation, account-number scheme, sync wire format. Detailed enough that an academic cryptographer can review it without source-code archaeology.
- **Public threat model** — this document. Updated in the same change as any architectural shift that affects guarantees.
- **Public limits document** — `limits.md`. Marketing copy is reviewed against this document; copy that exceeds the limits is rejected.
- **Reproducible builds** — for desktop (Tauri), web, and server binaries. Third parties can verify that the published binary matches the public source. Build instructions and expected hashes published with every release.
- **Code-signed releases** — desktop installers and auto-update payloads signed with hardware-backed keys. Auto-update verifies signature and hash before any code runs (TB7).
- **Hash-pinned dependencies** — lockfiles checked into the repository for npm, Go modules, and any WASM artifacts. Dependency updates require explicit review.
- **`SECURITY.md` + `.well-known/security.txt`** — vulnerability disclosure policy with a clear contact channel and acknowledged response window.
- **Public bug bounty (acknowledgment-only acceptable in v1)** — a documented page listing past reports and the researchers credited. Cash bounties may follow once the project sustains revenue.
- **Spec-then-bounty cadence** — protocol changes ship as drafts with a public review period before they reach production clients. The privacy-research community is invited to comment.
- **Engagement with the privacy-research community before HN launch** — informal review by at least one external cryptographer or security researcher, with their feedback acknowledged in release notes. Not equivalent to a paid audit, but materially better than silence.
- **Native screen-capture exclusion (macOS + Windows 10 build 19041+).** `tauri::WebviewWindow::set_content_protected(true)` is applied at app startup, wrapping `NSWindowSharingNone` on macOS and `WDA_EXCLUDEFROMCAPTURE` on Windows. The main window is invisible to OS screen-recording and screenshot APIs from the first frame. Best-effort defense-in-depth layer within A7's existing classification — does not change A7's best-effort status. **This layer ONLY protects against OS-level screenshot and screen-recording APIs; it does NOT defend against active in-process malware (keyloggers, framebuffer scrapers, V8 string-heap inspection).** Linux v0.1 has no portable equivalent (no protection applied); older Windows builds silently no-op the API. Users in environments where untrusted screen recording is active — especially Linux — should not rely on this layer.

## 7. Known Limitations & Open Issues

Items that are acknowledged as imperfect today and will be revisited. Captured here to prevent silent drift.

- **Recovery-phrase-only model has a known UX cost.** Bitwarden, 1Password, and Standard Notes all bleed users at this exact step. Myne holds the line in v1; if support volume becomes unmanageable, the response will be better UX (forced phrase confirmation, optional encrypted recovery file written to user-controlled storage) — *not* email recovery. Any change here triggers a threat-model amendment.
- **Blob size leaks information.** Even with all content encrypted, the size of each ciphertext blob and the count of blobs per account reveal something about note volume and usage. v1 does not pad. A future revision may introduce blob-size bucketing or padding to a granularity (e.g., 4 KiB). **The encrypted search-index blob `vault.search` (MYND-29; `spec/protocol.md` §9.6) is in the same class:** to an at-rest disk observer (A5) / a future sync observer (A13), its size leaks a coarse signal about the vault's indexed vocabulary and total note volume — strictly less than, and dominated by, the `.myn`-count + per-blob-size signal already accepted above (an index built from N notes is bounded by the same N notes). Accepted for v0.1 under the same no-padding posture; the same future bucketing/padding revision would cover it. `vault.search` adds no *new* class of leak — it is a derived cache of content whose size signal is already exposed by the `.myn` files themselves.
- **Encrypted snapshots leak edit cadence at rest.** The per-note version-history feature (MYND-96; `spec/protocol.md` §9.1 `snapshots/`) writes an encrypted `.myn`-format blob per captured revision. To an at-rest disk observer (A5), the *count* of a note's snapshots and their on-disk *ordering* (UUIDv7-named) reveal a coarse signal about how often and how recently that note was edited — a signal the single-current-`.myn` model did not expose. This is accepted for v0.1 under the same no-padding posture as blob size above, and is bounded on several axes: snapshots are **local-only** (single-device; the sync server never receives them, so **AS6** — encrypted user-meaningful timestamps — stays intact), capture is **time-coalesced** (~5 min) rather than per-keystroke, retention is a **bounded window**, and a **flat** `snapshots/` directory (rather than per-note subdirectories) limits how legibly per-note counts are exposed. Snapshots add no *new* class of secret: their plaintext is the same note content already protected by the `.myn` files, sealed under the same `item_key`. Cryptographic erase is preserved — permanently deleting a note purges its snapshots (`decisions.md` 2026-06-08).
- **Sync timing leaks usage patterns.** The version counter changes when a client pushes; an observer can correlate counter increments with real-time activity. v1 does not implement timing randomization or cover traffic.
- **Code-signing key is a single point of compromise.** A leaked or coerced signing key allows distribution of a malicious update that defeats client-side encryption. Mitigations: hardware-backed signing, separation of build and signing, public release-artifact hashes. Cannot eliminate the risk.
- **No formal third-party audit in v1.** Compensating controls (Section 6) are a credible substitute, not equivalent. If revenue from hosted sync grows enough to fund a formal audit, that becomes a priority.
- **No mobile in v1.** Users on iOS/Android remain on substitute stacks (Obsidian + Cryptomator + Möbius). The audience that wants E2EE most acutely on mobile is unserved by Myne during Phase 1–2.
- **No plausibly-deniable encryption.** Coercion (A12) reveals the data. v1 makes no attempt at deniability; consider in v2+ only with caution — partial deniability schemes are easy to misimplement and easy to claim falsely.
- **Self-host operator log policy is out of our control.** The protocol prevents the server from seeing plaintext, but a malicious self-host operator can still log connection IPs, retain old ciphertexts after deletion, or correlate metadata. Self-host documentation will explicitly state which operator behaviors are *protocol-level* (cannot be done) versus *policy-level* (must be enforced by the operator).
- **Argon2id parameters on low-end mobile.** `m=64 MiB, t=5` is heavy on a low-end Android device. Either accept slow logins on low-end phones or ship per-device parameter profiles encoded in the encrypted blob. Decision deferred until mobile work begins.
- **Tauri supply-chain surface.** Tauri's Cargo dependency tree is materially smaller than Electron's npm tree was, but transitive crate compromise (A8) remains feasible. Cargo lockfile pinning, `cargo-vet` or `cargo-audit` in CI, and a deliberately small direct-dependency surface are the response. The UI layer (React inside the Tauri WebView, bundled by Vite at build time) still pulls npm packages, but the security-critical crypto path lives in the Rust core and is isolated from the WebView via the IPC boundary. Choosing Vite + React over Next.js (`decisions.md` 2026-04-26) shrinks the direct-npm-dependency surface roughly tenfold.
- **Screen-capture protection is unavailable on Linux v0.1 and on Windows builds below 19041.** Linux has no portable API for screen-capture exclusion across compositors; Wayland portal-protocol extensions exist for some compositors (Hyprland, Sway, KDE) but no cross-distribution baseline. Windows 10 builds below 19041 (May 2020 Update) silently no-op `SetWindowDisplayAffinity` because `WDA_EXCLUDEFROMCAPTURE` was introduced in that build. Wayland portal extensions are tracked for additive support in a future release; no commitment date.
- **Local prefs replay.** An attacker with disk-write access can restore prior valid `vault.prefs` snapshots (see `spec/protocol.md` §9.5), reverting Myne-managed user preferences to earlier states. The attack is bounded to prior user choices — no arbitrary state injection is possible because AEAD verification (and the `account_number_hash` AAD binding) still applies. The current preference is visible in the Privacy panel UI on the next view, providing user-side detection. No structural defense in v0.1; a monotonic counter or per-blob freshness token was rejected during the MYND-160 grill because the `vault.meta` forensic-frozen discipline (`spec/protocol.md` §10.6) forecloses extending `vault.meta` to carry the counter, and storing the counter outside `vault.meta` adds a second artifact for marginal gain. **Two-class prefs taxonomy (MYND-121).** Preferences in `vault.prefs` split into two classes with respect to this limitation: (1) **best-effort prefs** (e.g. the screen-capture toggle) which inherit the replay limitation above — a replay merely reverts a user choice; and (2) **code-enforced security envelopes** which do **not** inherit it. The auto-lock timeout is class (2): its enabled flag is a code constant and its effective value is `clamp(pref, …, AUTO_LOCK_CEILING)` resolved in code, so a replayed, deleted, or tampered `vault.prefs` can only make auto-lock *stricter*, never disable it or exceed the ceiling. The A6 guarantee that auto-lock provides therefore does not degrade under local prefs replay.

## 8. Comparison vs. Adjacent Products

A side-by-side comparison of how Myne's threat model differs from the closest alternatives. Drawn from each product's published documentation, source code, and public security incidents as of early 2026.

| Axis | Myne (v1) | Notesnook | Standard Notes | Joplin (E2EE on) | Obsidian Sync |
|---|---|---|---|---|---|
| Account identity | Self-generated number, no email | Email | Email | Email | Email |
| Server can read note content | No | No | No | No | No (claimed; closed-source client) |
| Server can read note titles | No | No | No | **Yes** (titles + IDs leak per issue #6456) | Unknown / closed source |
| Server can read folder/structure | No | Partial | Partial | Yes | Unknown / closed source |
| Server can read user-meaningful timestamps | No | Yes | Yes | **Yes** | Unknown / closed source |
| IP address logging | None | Per provider policy | Per provider policy | Per chosen sync target | Per provider policy |
| Open-source client | Yes | Yes | Yes | Yes | **No** |
| Open-source server | Yes | Yes | Yes (server-side) | Yes (Joplin Server) | **No** |
| Self-host option | Yes (first-class) | Yes | Yes | Yes | **No** |
| Independent published audit | Compensating controls only | Planned, none yet | Trail of Bits 2021 | Informal only | None published |
| Recovery model | Master password + 24-word BIP39 phrase | Email + master password | Master password (no recovery) | Master password (no recovery) | Master password + email |
| Encryption on by default | **Always** (no plaintext mode) | Always | Always | **Off by default** (must enable) | Yes |
| Plugin model | None in v1; future API capability-scoped | None | Editor swaps | Plugins yes, **broken on mobile** | Yes (full vault read access — privacy hole) |
| Markdown files plaintext on disk after decryption | **Yes** | No (proprietary store) | No | Sort of (SQLite + attachments) | Yes (no E2EE on disk) |

The differentiator is the combination, not any single column: **plain-markdown-on-disk + no email + encrypted titles + encrypted timestamps + no IP logs + open-source full stack + first-class self-host**. No incumbent matches all of these.

---

## Decisions Log (this document)

A snapshot of choices made during the v0.1 draft. Mirrored to `decisions.md`.

**Resolved**

- 13 adversary classes catalogued (A1–A13) with explicit Strong / Mitigated / Best-effort / Out-of-scope status per class.
- A1 (passive cloud) and A2 (compelled lawful access) are both Strong-guarantee — the architectural commitment is "the server cannot disclose what it does not possess".
- A12 (coerced user) is explicitly Out of scope in v1. A6 (unlocked stolen device) was Out-of-scope in the v0.1 draft and is now **🔒 Mitigated** by auto-lock on idle (`decisions.md` 2026-05-30 "Auto-lock on idle"; MYND-121 + MYND-122) — key-zeroize + best-effort open-note teardown, exposure-window-narrowing, not a Strong guarantee against forensic RAM capture.
- A7 (malware), A10 (state-level), A13 (traffic analysis) are Best-effort, with the limits documented to prevent marketing overreach.
- **AS6 — User-meaningful timestamps are encrypted.** Server uses an opaque per-note version counter (sync-internal monotonic integer) for conflict detection; conflict resolution happens on the client after decryption. This is a sync-protocol commitment.
- **AS14 — No IP logging.** Hard architectural commitment. Operational logs and abuse mitigation must function on per-account counters without IP addresses.
- TB5 — hosted sync and self-hosted sync are the **same** trust boundary. The protocol does not give the operator more access in either case.
- TB7 — auto-update is enabled and gated by signature + hash verification. Updates that fail verification are refused.
- Compensating controls for the missing audit are codified: public spec, public threat model, public limits doc, reproducible builds, signed releases, hash-pinned dependencies, SECURITY.md, security.txt, public bug bounty (acknowledgment-only acceptable in v1), spec-then-bounty cadence, pre-launch external review.
- **Hard line: no email recovery, ever.** If recovery-phrase UX support volume becomes unmanageable, the response is better in-product UX, not email-based recovery.

**Deferred**

- Argon2id parameter tuning on low-end mobile devices — decision blocked on Phase 3 mobile work.
- Blob-size padding / bucketing — deferred beyond v1; A13 remains Best-effort meanwhile.
- Sync-timing randomization / cover traffic — deferred beyond v1.
- Plausibly-deniable encryption against coerced-user (A12) — out of scope in v1; v2+ only with caution.
- Decrypted-memory wiping *beyond best-effort* for A6 (forensic-grade freed-page / swap / hibernation scrubbing) — deferred. Auto-lock on idle (`decisions.md` 2026-05-30) now delivers key-zeroize + best-effort open-note teardown (OS window-hide + WebView reload), moving A6 to 🔒 Mitigated; userspace-deterministic RAM scrubbing remains out of scope (A7/A10).

**Open risks**

- Code-signing key compromise (TB8) is the single largest unmitigated risk against A9. Hardware-backed keys + separation of build and signing reduces but does not eliminate.
- Tauri's Cargo dependency surface plus the React UI layer's npm dependencies together form a non-trivial supply-chain attack surface; transitive compromise (A8) remains feasible despite hash pinning. The Vite + React choice (`decisions.md` 2026-04-26) keeps the npm side as small as practical, but it does not eliminate the surface.
- The "no formal audit" gap will widen if Notesnook publishes one before Myne does. Accept the risk; the compensating controls are the response.
- Self-host operator log policy is outside the protocol — documentation must surface the protocol-level vs. policy-level distinction so users understand which guarantees follow them when they switch operators.
