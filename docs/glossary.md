# Myne Glossary

> Canonical reference for terminology used across Myne specifications, threat model, vision, and decisions documents. The intended audience is an external cryptographer or security reviewer walking in cold, plus the founder six months from now disambiguating their own past writing.

---

## Overview & Conventions

### How to read this glossary

Entries are alphabetized in a single A–Z list (§ "Term entries"). Each entry carries a category tag for visual filtering. Terms that diverge from generic usage carry an explicit *Myne-divergent* flag — those are the most important entries.

Three small reference tables at the bottom (§ "Quick-reference indices") cover (a) primitives at a glance, (b) Myne-specific keys, (c) magic-byte and context-prefix registries.

### Category legend

| Tag | Meaning |
|---|---|
| 🔐 *Primitive* | A concrete cryptographic algorithm (Argon2id, SHA-256, etc.) |
| 🏗️ *Construction* | A composition or higher-level scheme (AEAD, CTX, KDF, etc.) |
| 🗝️ *Key/identifier* | A key, derived value, or identifier used by the Myne protocol |
| 📋 *Protocol* | A protocol-level concept (version byte, AAD prefix, magic bytes, etc.) |
| ⚠️ *Threat* | A threat-model term (adversary, asset, trust boundary, attack class) |
| 📦 *Product* | A product / architecture / deployment term (vault, hosted sync, Phase 1) |
| 🛠️ *Tooling* | A library, build artifact, or development tool |

### Notation

- *Myne-divergent* — the term is in widespread general use but Myne's definition or usage differs in a way a reader must know. These entries get longer treatment.
- *(retired YYYY-MM-DD)* — the term was removed from active use. Preserved for audit trail.
- "Used in:" — paths to the docs where the term is most authoritatively defined.
- "Reference:" — RFC, academic paper, or canonical specification source. Provided for primitives and constructions; product terms skip this line.

---

## Term entries

### **AAD (Associated Authenticated Data)** &nbsp; 🏗️ *Construction*

*(Aliases: Associated Data, AD. Myne-divergent: no, but the canonical construction §5.2 is project-specific.)*

A byte string bound into an AEAD operation but not encrypted. The AEAD tag covers both the ciphertext and the AAD, so any AAD tampering causes tag verification to fail. Myne's AAD construction (`spec/protocol.md` §5.2) carries the protocol-version prefix `"myne.v0.1|"`, the protocol version byte, the items_key_id, the note_uuid, and (for content encryption) the content_type, plus (for the wrap operations in §3.1) the canonical KDF parameters block. The combination is what defeats downgrade, key-substitution, blob-substitution, and KDF-parameter-tampering attacks — all fail at the AEAD tag check rather than producing silently wrong plaintext.

Used in: `spec/protocol.md` §5.2, §3.1
Reference: RFC 5116 (AEAD generic interface).

### **AAD construction** &nbsp; 📋 *Protocol*

The full byte string passed as AAD to a Myne AEAD operation. Distinct from the generic AEAD concept in that Myne locks the format and binds project-specific fields. See `spec/protocol.md` §5.2 for the exact byte layout.

Used in: `spec/protocol.md` §5.2

### **AAD prefix** &nbsp; 📋 *Protocol*

The 10-byte ASCII string `"myne.v0.1|"` (including the trailing pipe) that begins every AAD in this protocol version. v005 will use `"myne.v005|"`. The prefix domain-separates protocol versions at the AEAD tag level — a v005 client cannot accidentally decrypt a v0.1 blob.

Used in: `spec/protocol.md` §5.2

### **account_number** &nbsp; 🗝️ *Key/identifier* (deep entry)

Myne's user identifier. A 20-character canonical value composed of 19 random Crockford base32 characters (95 bits of entropy) plus 1 Damm-32 check character, displayed as `MY-XXXX-XXXX-XXXX-XXXX-X`. The account number replaces email at signup; it is bearer-token semantics in Phase 2+ (anyone in possession of it can authenticate sync requests for that account, like a Mullvad VPN account) but it is **not** a key — it does not encrypt anything, and possession alone does not unlock a vault. The cryptographic role is via `account_number_hash`, which binds Argon2id salts to this account and prevents pre-computation attacks across accounts. In **multi-vault recovery** the account number gains an *optional selector* role: a user **may** type it so the host matches `account_number_hash` against on-disk `vault.meta` headers and jumps to that vault — **never required** (the picker is the primary path; the 24-word phrase stays the sole recovery secret; `decisions.md` 2026-06-09 "Multi-vault recovery").

Used in: `spec/account-number.md`, `spec/protocol.md` §8

### **account_number_hash** &nbsp; 🗝️ *Key/identifier* (deep entry, *Myne-divergent*)

*(Aliases: account hash. Myne-divergent: yes — two different truncation lengths in different roles.)*

A SHA-256 hash of the canonical account number. **Truncation differs by use site**: for Argon2id salt construction (§3.1 of the protocol spec) it is 16 bytes — `SHA-256(canonical_account_number)[:16]` — and stored in `vault.meta`. For Phase 2+ server-side identification (`spec/account-number.md` §7) it is 32 bytes — `SHA-256(canonical)[:32]` — stored in the sync server registration table. The two lengths are deliberate to avoid identifier reuse across uses; readers must check which length applies in context. In **multi-vault recovery** the 16-byte `vault.meta` value doubles as an *optional* vault selector: when a user types their account number, the host recomputes `SHA-256(canonical)[:16]` and byte-matches it against each discovered vault's plaintext header field to jump to that vault (header-read only — no decrypt, no `auth_permits`; `decisions.md` 2026-06-09 "Multi-vault recovery").

Used in: `spec/protocol.md` §3.1, §8.3; `spec/account-number.md` §6, §7

### **Active language set** &nbsp; 📦 *Product*

The set of bundled dictionaries the [spell checker](#spell-check) currently checks against (SYNC-11). A word is accepted if it is valid in **any** member of the set (set-union, no per-note language detection) or in the **Personal dictionary**. The set is settings-driven (Settings → Appearance language picker) and defaults to the OS locale when bundled, unioned with en-US; it is passed to the engine's batch check as the `spell_check` command's `langs` argument. v0.1 bundles 23 languages (Turkish deferred).

Used in: MYND-262, MYND-267; `src-tauri/src/spell/`.

### **adversary class** &nbsp; ⚠️ *Threat*

A category of attacker against which the threat model defines a specific defensive posture. Myne catalogs 13 classes (A1–A13) with explicit Strong / Mitigated / Best-effort / Out-of-scope status per class. Refer to `threat-model.md` §1 for the full catalog rather than enumerating individual classes here.

Used in: `threat-model.md` §1

### **AEAD (Authenticated Encryption with Associated Data)** &nbsp; 🏗️ *Construction*

A symmetric-encryption mode that simultaneously provides confidentiality of plaintext and authenticity of plaintext + associated metadata. Myne's AEAD construction is XChaCha20-Poly1305 wrapped in CTX commitment (`spec/protocol.md` §5.1).

Used in: `spec/protocol.md` §5
Reference: RFC 5116.

### **age** &nbsp; 🛠️ *Tooling*

A simple, modern file-encryption format and library by Filippo Valsorda. Myne does not use age in v0.1 but the research roadmap (`appname-v005`) considers age-style chunked AEAD streams for attachments. The canonical specification lives at the C2SP repository.

Used in: `e2ee-notes-evaluation.md` (recommended-stack discussion)
Reference: https://github.com/C2SP/C2SP/blob/main/age.md

### **aPAKE (Augmented Password Authentication Key Exchange)** &nbsp; 🏗️ *Construction*

A class of password-authenticated key exchange where the server stores no password verifier the attacker can brute-force offline after a database compromise. OPAQUE (RFC 9807) is the modern aPAKE Myne's `appname-v005` roadmap canonicalizes for sync-server authentication. v0.1 derives but does not transmit the relevant subkey; the actual aPAKE-vs-simple-verifier choice is deferred to Phase 2 (`spec/protocol.md` §11.1).

Used in: `decisions.md` (Deferred #4)
Reference: RFC 9807.

### **Argon2id** &nbsp; 🔐 *Primitive* (deep entry)

The memory-hard password-based key derivation function specified in RFC 9106. Argon2id combines the side-channel resistance of Argon2i with the GPU-cracking resistance of Argon2d. Myne uses Argon2id at two call sites (deriving `password_wrap_key` from the master password, deriving `recovery_wrap_key` from the BIP-39 phrase), with parameters `m=256 MiB, t=3, p=2, version 1.3` stored in `vault.meta` rather than hardcoded so they can be tuned per platform and bound into the wrap AADs to defeat parameter-downgrade tampering. Argon2i and Argon2d are not used in this protocol — the "id" variant is the only correct choice for password-stretching in 2026.

Used in: `spec/protocol.md` §4, §3.1
Reference: RFC 9106.

### **asset** &nbsp; ⚠️ *Threat*

A resource that the threat model identifies as worth protecting, classified by sensitivity (Critical / Sensitive / Pseudonymous / Metadata) and by visibility (client only, encrypted blob on server, plaintext on server, transient). Myne catalogs 17 assets (AS1–AS17). See `threat-model.md` §2 for the full table.

Used in: `threat-model.md` §2

### **atomic range** &nbsp; 📦 *Product*

A region of CodeMirror 6 editor state registered with `EditorView.atomicRanges` so the cursor and selection treat it as a single indivisible unit. Backspace, forward delete, and arrow-key motion at the boundary remove or skip the entire range in one step. Myne uses atomic ranges to make wikilink chips behave as single characters at the user-input level — pressing Backspace next to `[[Note Title]]` deletes the whole chip (delimiters included) rather than chipping away one character at a time. The underlying source bytes are unchanged by atomicity registration; the property is purely about cursor mechanics.

Used in: `spec/wikilink.md` §5.2

### **at-rest encryption** &nbsp; 🏗️ *Construction*

The property that data stored persistently is encrypted whenever it is not actively being processed. Myne's at-rest encryption applies to every byte of note content, vault metadata, and key material on the user's disk (`spec/protocol.md` §9). Distinct from in-transit encryption (TLS), which protects only data crossing the network.

Used in: `spec/protocol.md` §9; `threat-model.md` §1 (A5)

### **auth_permits** &nbsp; 📦 *Product*

A capacity-1 `tokio::sync::Semaphore` on `VaultRuntimeState` (Rust-side singleton in `src-tauri/src/plugins/vault_unlock/state.rs`) held by **every command that creates, destroys, or mutates `vault.meta`**: `vault_unlock`, `vault_recover_with_phrase`, `vault_complete_recovery`, `vault_change_password`, `vault_delete`, `vault_create::commit`, and `vault_repair`. Each acquires via `try_acquire()` (reject, never queue) at the start of its critical section and releases via RAII guard on every return path. The single-permit invariant guarantees **at most one vault.meta-lifecycle mutation in flight client-wide** — a generalization of the original "at most one ~1-second Argon2id derivation in flight" framing, which became inaccurate once non-Argon2id members joined (`vault_delete` and `vault_repair` hold the permit for a pure filesystem sweep, not a KDF). It defends the no-queue posture (`decisions.md` 2026-05-02 "Phase 1 unlock UI semantics") and closes the `vault_repair` ↔ `vault_create::commit` TOCTOU (`decisions.md` 2026-06-06 "vault_repair v0.2", MYND-159). Renamed from `unlock_permits` (the pre-recovery-flow shape) when the recovery commands started sharing the lock.

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization"

### **attachment** &nbsp; 📋 *Protocol*

An arbitrary file of **any type** stored as an encrypted blob in the vault, separate from notes (`threat-model.md` AS7). Each attachment is an [`MYA1`](#mya1) blob (`spec/protocol.md` §9.9) under `attachments/<attachment-id-hex>`, keyed by a per-attachment key wrapped under `itemsKey`; its metadata lives authoritatively in the [`vault.attachments`](#vaultattachments) catalog. Attachments ship in v0.1 (`decisions.md` 2026-06-07, superseding the 2026-04-27 skip-and-placeholder plan). A file the magic-byte sniffer recognizes as a renderable type (`image/*` + SVG + PDF) renders inline; **any other file is stored as `application/octet-stream` and surfaces as an export-only [attachment file-card](#attachment-file-card)** (`decisions.md` 2026-06-14, MYND-173). No remote URL is ever fetched; decrypted bytes never touch disk except on explicit user [export](#export). See [attachment-id](#attachment-id), [MYC1](#myc1). (MYND-164)

### **attachment-id** &nbsp; 📋 *Protocol*

The 32-byte content-addressed identifier of an [attachment](#attachment): `HMAC-SHA-256(DeriveSubkey(root_key, "attachments-id-hmac"), file_bytes)` (`spec/protocol.md` §9.9). Used as the on-disk filename (hex) and the dedup key — identical content yields one blob within a vault. Because it is keyed under `root_key`, a disk observer without the key cannot test whether the vault holds a specific known file (no confirmation oracle) nor link equal content across vaults (`threat-model.md` AS7/AS8). Notes reference it via the editor form-C embed `![[att:<id>|filename]]`. Dedup is an id-existence check, not convergent encryption. (MYND-164)

### **attachment://** &nbsp; 📋 *Protocol*

The custom WebView protocol scheme that serves a decrypted [attachment](#attachment) to the editor/library. The Rust handler resolves `attachment://<id>`, decrypts the blob in memory, **re-sniffs** the content-type from the bytes and emits only an allowlisted type (`image/*`, `application/pdf`, or `audio/wav` — voice notes, MYND-259), and returns a full response — no plaintext ever written to disk, no `Range`/206 in v0.1. Unlock-gated and main-window-scoped (TB6); the WebView CSP blocks outbound network so a hostile note cannot exfiltrate a blob. (MYND-164)

### **attachment_import** &nbsp; 📋 *Protocol*

The single Tauri command that ingests a file into the attachment store — from inline bytes (clipboard paste / WebView drop) or a path (file picker). Computes the [attachment-id](#attachment-id), performs id-existence dedup, encrypts + stores the [`MYA1`](#mya1) blob, and upserts the [`vault.attachments`](#vaultattachments) metadata; enforces the 64 MiB cap. Since MYND-173 it accepts **any file type** — a file the sniffer does not recognize is stored as `application/octet-stream` (not rejected); the locked reject taxonomy is now oversize / locked (the render allowlist is a serve-time authority on [attachment://](#attachment), not an import gate). Unlock-gated, main-window-scoped. (MYND-164; `decisions.md` 2026-06-14)

### **attachment_export** &nbsp; 📋 *Protocol*

The Tauri command that writes one [attachment](#attachment)'s **decrypted** bytes to a user-chosen destination — the export-only "use" path for a generic file, and the vault-wide Save-As for images/PDF (MYND-173). The frontend opens the native save dialog (the established export-suite convention) and passes the path + overwrite consent; the host decrypts the [`MYA1`](#mya1) blob in Rust memory and writes the plaintext via `atomic_write_unclobbered`, so it never re-enters the WebView. A deliberate user-initiated plaintext crossing of TB3 — exactly the "attachment files" egress already named in `threat-model.md` §3 / §5; it is one-shot and not a plaintext mode. Unlock-gated. See [export](#export). (`decisions.md` 2026-06-14)

### **attachment file-card** &nbsp; 📦 *Product*

The editor representation of a non-renderable (generic) [attachment](#attachment) — a `.docx`, `.zip`, `.txt`, etc. stored as `application/octet-stream`. Unlike an inline image/PDF, the file's content is **never** previewed; the form-C embed `![[att:<id>|filename]]` renders as a compact atomic card showing a file-type icon, the [`vault.attachments`](#vaultattachments) filename (the single source of truth — `Rename` edits it globally via `attachment_rename`, not the per-embed alias), a "type · size" line (the type label is derived from the filename extension TS-side, since the catalog stores only `octet-stream`), and a "⋯" overflow menu: Export (→ [attachment_export](#attachment_export)), Rename, Remove from note, Reveal in library. "Using" the file means exporting it. A missing id renders the shared [deleted-attachment tombstone](#deleted-attachment-tombstone). Inline preview of other types (docx/pptx/xlsx/text) is the separate follow-up MYND-268. (MYND-173; `decisions.md` 2026-06-14)

### **auto-lock on idle** &nbsp; 📦 *Product*

A security control that locks the vault after a period of device inactivity, bounding the exposure window of an unattended unlocked Myne (`threat-model.md` A6). A backend-authoritative, fail-closed idle timer fires at a configurable timeout; the lock has two legs — (1) unconditional in-memory key zeroize ("no further notes decryptable"), and (2) best-effort teardown of the decrypted open note (a synchronous OS-level window hide plus a WebView reload). **"Idle" means machine-level** device idle (no input to the whole machine, not merely the Myne window), read per-platform (`GetLastInputInfo` / `CGEventSourceSecondsSinceLastEventType` / `XScreenSaverQueryInfo`); on Wayland, where no portable OS-idle API exists, it falls back to window-level idle as a fail-secure (more-eager) degradation. The timeout preference lives in the encrypted `vault.prefs` blob (`auto_lock_seconds`); the protection itself is always on (see **AUTO_LOCK_CEILING**). Moves A6 from ❌ Out-of-scope to 🔒 Mitigated — deliberately not a 🛡️ Strong guarantee, since freed-page RAM, swap, and hibernation are not scrubbed (A7/A10).

Used in: `threat-model.md` §1 (A6); `decisions.md` 2026-05-30 "Auto-lock on idle"

### **AUTO_LOCK_CEILING** &nbsp; 📦 *Product*

The code-enforced upper bound on the auto-lock timeout — the load-bearing edge of auto-lock's *protective envelope*. The effective timeout is `clamp(vault.prefs value or default, FLOOR?, AUTO_LOCK_CEILING)` and the enabled flag is a code constant, not a preference. Because the ceiling and the always-on flag live in code rather than the replayable `vault.prefs` blob, a disk-level attacker (A4) who replays, deletes, or tampers the preferences file can only make auto-lock *stricter* — never disable it or push it past the ceiling. This is why auto-lock does **not** inherit the local-prefs-replay limitation (`threat-model.md` §7) that best-effort preferences such as the screen-capture toggle do.

Used in: `threat-model.md` §7; `decisions.md` 2026-05-30 "Auto-lock on idle"

### **backup-key** &nbsp; 🗝️ *Key/identifier*

A subkey context string (`"myne.v0.1 backup-key"`) **reserved but not used in v0.1** (demoted 2026-06-10; the entry previously claimed it encrypts exported backup files). The v0.1 [vault backup file](#vault-backup-file) is a verbatim ciphertext copy with no outer encryption layer; the demotion rationale lives in the §3.4 registry row and `decisions.md` 2026-06-10. Retained, like `server-auth`, so the context string stays allocated for a potential future sealed-backup variant.

Used in: `spec/protocol.md` §3.4, §9.11; `decisions.md` 2026-06-10

### **base import** &nbsp; 📦 *Product*

A one-way, **accepted-lossy** adapter that reads an Obsidian *Bases* `.base` file (plain YAML describing views over the user's own notes) and maps the representable subset onto Myne's canonical [saved view](#saved-view) schema (Saved Views epic, MYND-276). It is **import-only** in v1 (export is the future MYND-279) and a derived bridge — Myne does **not** own or round-trip the `.base` format. Unsupported filter clauses (anything outside the closed [filter AST](#filter-ast) allow-list — `list.map`/arithmetic/`file.hasLink`/`file.mtime`), and the `formulas` / `summaries` / `properties`-display blocks, are **dropped and counted** (no formula/code-eval exists to honor them — the no-database/no-formula commitment of [vision](#vision)); a clause-level warning tally surfaces exactly what came across and what didn't (SYNC-12). Obsidian's recursive `file.inFolder()` matches Myne's subtree-inclusive engine leaf, so that mapping is direct. The reader reuses the vendored YAML parser + the shipped importer file seam (no new dependency / capability), parses in RAM only (PS-1), and persists into the existing `vault.prefs` (`MYP1`) `saved_views` field (no new crypto). The "Bases" / "Obsidian" names are used **nominatively** only (what the importer reads), never as a productized Myne feature name.

Used in: `decisions.md` 2026-06-15; Saved Views (MYND-276)

### **bidirectional links** &nbsp; 📦 *Product*

*(Aliases: backlinks, wikilinks.)*

Links between notes that are queryable from both endpoints — opening a note shows which other notes link to it. Myne supports the `[[wikilink]]` syntax in v0.1 with a backlinks pane; the graph view (d3-force + hand-rolled render) is also part of v1.0 scope (`vision.md` Phase 1 Scope).

Used in: `vision.md` Phase 1 Scope

### **BIP-39** &nbsp; 🏗️ *Construction* (deep entry, *Myne-divergent*)

*(Aliases: mnemonic phrase encoding. Myne-divergent: yes — encoding only.)*

Bitcoin Improvement Proposal 39, defining a mapping from random entropy to a sequence of human-friendly English words plus a checksum. **Myne uses BIP-39 only as an encoding** for 256-bit recovery phrases — the 24 words present, capture, and re-enter 256 bits of secret entropy plus an 8-bit checksum. Myne does **not** use BIP-39's standard PBKDF2-HMAC-SHA512 with 2048 iterations to derive a wallet seed; that derivation is too weak by 2026 cryptographic standards. Instead, the normalized phrase string is fed directly to Argon2id with the protocol's standard parameters to derive `recovery_wrap_key` (`spec/protocol.md` §7.1). This divergence is intentional and load-bearing for the recovery-phrase security argument.

Used in: `spec/protocol.md` §7
Reference: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki

### **bottom bar** &nbsp; 📦 *Product*

The 28px status bar pinned to the bottom of the editor (`BottomBar`, `src/screens/Editor.tsx`). Hosts the connection/sync status text, the [save-status](#optimistic-ui-rollback) badge, and the persistent affordances for the [tag browser](#tag-browser), Saved Views, the whole-vault graph, Settings, vault Lock, and the live word count. **Bottom-bar customization** (2026-06-15) lets the user hide/show each item via a right-click context menu; the hidden set persists per-vault in the `vault.prefs` `hidden_bar_items` field (set semantics, omitted-when-empty — a fully-visible bar is byte-identical to a pre-feature vault). The bar root stays right-clickable even when fully emptied, which is the only restore path (no Settings-panel mirror). There is deliberately **no** separate top bar — the top controls float into the OS title-bar row (MYND-166).

Used in: `decisions.md` 2026-06-15 "Bottom-bar customization"; `spec/protocol.md` §9.5.2 (`hidden_bar_items`)

### **BLAKE3** &nbsp; 🔐 *Primitive*

A modern hash function and KDF with strong parallelism characteristics. **Not used in Myne v0.1** — researched as an alternative to HKDF-SHA-256 for subkey derivation but rejected (Deferred #2 in `decisions.md`) in favor of HKDF-SHA-256 for libsodium compatibility, MLS alignment with v005, and a smaller dependency surface. The "structural context binding" advantage that BLAKE3 `derive_key` offers is recovered at the codebase level by Myne's single-canonical-helper pattern (§3.2.1).

Used in: `decisions.md` (Deferred #2 rationale)
Reference: https://github.com/C2SP/C2SP/blob/main/BLAKE3.md

### **bug bounty** &nbsp; 🛠️ *Tooling*

A public-facing page listing known security reports and their resolution status, plus a mechanism to receive new reports. Cash payouts are not required at v0.1; acknowledgment-only is acceptable per the compensating-controls plan in `threat-model.md` §6.

Used in: `threat-model.md` §6

### **cargo-vet / cargo-audit** &nbsp; 🛠️ *Tooling*

Rust-ecosystem tools for auditing transitive Cargo dependencies for known vulnerabilities (cargo-audit) and for crowd-sourced trust attestations (cargo-vet). With the Tauri/Rust stack decision, these are part of Myne's supply-chain defense (`threat-model.md` §7).

Used in: `threat-model.md` §7

### **ChaCha20-Poly1305** &nbsp; 🔐 *Primitive*

The IETF AEAD specified in RFC 8439, using the ChaCha20 stream cipher and the Poly1305 MAC with a 96-bit nonce. **Not directly used in Myne** — the protocol uses the *extended-nonce* variant XChaCha20-Poly1305 (192-bit nonce) wherever AEAD is invoked. Plain ChaCha20-Poly1305 is referenced only when distinguishing the two; readers must not conflate them.

Used in: `spec/protocol.md` §5.1
Reference: RFC 8439.

### **chord** &nbsp; 📦 *Product*

A single keyboard-shortcut combination, e.g. `Mod-Shift-g` (hotkeys epic, MYND-304). Myne's canonical chord string is CodeMirror-`KeyBinding.key`-compatible: a `-`-separated sequence of modifier tokens followed by one logical key, using the cross-platform `Mod` token (Cmd on macOS, Ctrl elsewhere) and the layout-respecting *logical* key (what the user sees on the key, not the physical `code`); single-character keys are lowercased. Stored NFC-normalized inside `vault.prefs` (the `keymap` field). See **keymap**, **key binding**.

Used in: `spec/protocol.md` §9.5.2

### **code-signed releases** &nbsp; 🛠️ *Tooling*

Myne desktop installers and auto-update payloads are cryptographically signed with hardware-backed keys controlled by the team. Auto-update verification (`threat-model.md` §3 TB7) refuses any artifact that fails signature or hash check. The signing keys are themselves the largest unmitigated risk against A9 (compromised distribution).

Used in: `threat-model.md` §3 TB7, §6

### **CodeMirror 6** &nbsp; 🛠️ *Tooling*

The code-editor framework used as the markdown editor in Myne's Phase 1 desktop client. Provides syntax highlighting, live preview, and the foundation for `[[wikilink]]` parsing. Same library that Obsidian uses internally.

Used in: `vision.md` Phase 1 Scope

### **color label** &nbsp; 📦 *Product*

A user-assigned color on a sidebar note or [folder](#folder) row, rendered as a small dot (the title text stays in the ink ramp; a colored left-border is banned by `PRODUCT.md`). Persisted as the `item_colors` field of [`vault.prefs`](#vaultprefs) — an optional nested-object map from a note UUID **or** canonical trailing-slash folder path (discriminated by the trailing `/`, like [item order](#item-order)) to a [label slot](#label-slot) name; NFC-normalized, lexicographically-keyed, omitted-when-empty (`spec/protocol.md` §9.5.2). Note-keyed entries survive note rename/move (the UUID is the filename); folder-keyed entries are prefix-rewritten on folder rename/move and pruned on delete; a stale entry is ignored at render and pruned on the next write. **Non-load-bearing** (cosmetic, AS-low) — a tampered/replayed blob can at worst surface the wrong color. Notes **and** folders both take a color (contrast [custom folder icon](#custom-folder-icon), folders only). See also [label slot](#label-slot), [PrefsView](#prefsview). (MYND-184)

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-07

### **command palette** &nbsp; 📦 *Product*

Global keyboard-first action launcher in the Phase 1 desktop client, opened via `Cmd+K` / `Ctrl+K`. Renders a centered modal with a fuzzy-match input + scrollable action list; ArrowUp/Down navigates, Enter runs the highlighted action, Esc dismisses. v1 ships five actions across Vault / App / Navigation / Editor categories: Lock vault, Open settings, Switch to note (transitions into a note-picker sub-palette), Import Obsidian vault (disabled stub for Phase 1.x), Convert wikilinks in this note (disabled stub for `editor-mvp-wikilinks`). Action visibility respects the current `Stage` — non-editor stages hide editor-only actions; the palette never exposes actions unavailable in the current state. The action registry is a frozen `readonly CommandAction[]`; no plugin / scripting API is introduced (acceptance criterion enforced structurally). Distinct from the editor's **slash command** menu, which is editor-internal (cursor-anchored) and bound to insertable markdown elements.

Used in: `agent-tooling/features/editor-mvp-baseline/prd.md` (T7), `src/commands/`

### **compelled lawful access** &nbsp; ⚠️ *Threat*

Adversary class A2: subpoena, court order, national security letter, or other legal compulsion forcing the operator to disclose user data. Myne's strong guarantee against A2 is architectural — the server cannot disclose what it does not possess. The disclosure-forced set is limited to ciphertext blobs, hashed account numbers, transient connection IPs, version counters, and aggregate storage size.

Used in: `threat-model.md` §1 (A2)

### **content_type** &nbsp; 📋 *Protocol*

A length-prefixed UTF-8 string carried in the AAD of content-encryption AEAD operations. In v0.1 it is always `"text/markdown"`; the field exists so v005 can introduce attachments (with content types like `"image/png"` or `"application/pdf"`) without breaking the AAD layout.

Used in: `spec/protocol.md` §5.2

### **context string** &nbsp; 📋 *Protocol*

A canonical UTF-8 string passed as the `info` parameter to HKDF-Expand to domain-separate one subkey from another. Myne context strings are drawn from a registered table (§3.4) and follow the format `"myne.v0.1 " || role`. The `derive_key` pattern (§3.2.1) is the only sanctioned way to construct and use them.

Used in: `spec/protocol.md` §3.2, §3.4

### **context string registry** &nbsp; 📋 *Protocol*

The table in `spec/protocol.md` §3.4 listing every authorized context string and its role for v0.1. Adding a new role in a minor revision means adding a row to the registry, not bumping the protocol version. Registered roles in v0.1: `itemsKey-wrap`, `prefs-key`, `search-index-key`, `attachments-catalog-key`, `attachments-id-hmac` (active), plus `server-auth` and `backup-key` (both reserved — derived material unused in v0.1; `backup-key` demoted 2026-06-10). v005 strings will be registered under the `"myne.v005 "` prefix.

Used in: `spec/protocol.md` §3.4

### **CRDT (Conflict-free Replicated Data Type)** &nbsp; 🏗️ *Construction*

A class of data structures that allow concurrent edits across multiple replicas to be merged without coordination. Myne plans to use Yjs (a CRDT library) for Phase 4+ real-time collaborative editing. CRDTs are not in v0.1.

Used in: `vision.md` (Phase 4 scope)

### **Crockford base32** &nbsp; 🏗️ *Construction*

The 32-character alphanumeric base-32 encoding defined by Douglas Crockford, excluding the visually ambiguous `I L O U`. Myne encodes account-number entropy as 19 Crockford characters (95 bits) plus 1 Damm-32 check character (`spec/account-number.md` §2).

Used in: `spec/account-number.md` §2
Reference: https://www.crockford.com/base32.html

### **cryptographic erase** &nbsp; 🏗️ *Construction*

Per NIST SP 800-88 Rev. 1: securely deleting data by destroying the key under which it was encrypted, rendering the ciphertext unrecoverable even if it persists physically (e.g., on SSD wear-leveled cells, in cloud backups). Myne's three-level note-key wrapping (§3.3) makes per-note cryptographic erase a primitive: deleting a note's `item_key` entry from the wrapped storage renders that note's ciphertext unrecoverable.

Used in: `spec/protocol.md` §3.3 (implicit)

### **CTX commitment** &nbsp; 🏗️ *Construction* (deep entry)

The key-committing AEAD construction defined by Chan & Rogaway (ESORICS 2022) that wraps a non-committing AEAD to provide commitment to the key. Myne instantiates CTX with XChaCha20-Poly1305 as the inner AEAD and SHA-256 as the outer hash. The Poly1305 tag T (16 bytes) is replaced on disk by the 32-byte commitment tag T' = SHA-256(canonical_encode(K, N, AD, T)), where `canonical_encode` uses a length-prefixed encoding of AD to eliminate concatenation ambiguity per Chan & Rogaway §3. This defends against partitioning-oracle attacks (Len–Grubbs–Ristenpart, USENIX 2021): without CTX, an attacker with a partial-decrypt oracle could construct a ciphertext that decrypts under multiple keys, enabling binary-search brute-force against weak passwords. The cost is ~30 lines of code, ~0.001% performance, and ~16 extra bytes per AEAD operation on disk.

Used in: `spec/protocol.md` §5.1
Reference: Chan & Rogaway, "On Committing Authenticated Encryption", ESORICS 2022.

### **cursor-aware reveal** &nbsp; 📦 *Product*

The Phase 1 editor pattern where decorations on the line containing the cursor lift to expose the underlying markdown source for editing, then reapply when the cursor leaves the line. There is no separate "rendered view" / "source view" mode-switch — cursor location *is* the reveal. Headings show their leading `#`s on the active line and hide them off-line; bold and italic delimiters reveal on entry; inline link URLs become editable when the cursor enters their parent line. Wikilink chips are an exception per `spec/wikilink.md` §5.4 (chips stay atomic regardless of cursor position).

Used in: `spec/markdown-dialect.md`, `agent-tooling/features/editor-mvp/rfc.md`

### **custom folder icon** &nbsp; 📦 *Product*

A user-chosen icon replacing a [folder](#folder)'s default sidebar glyph, rendered in `currentColor` (icons are never colored independently, `PRODUCT.md`). Persisted as the `folder_icons` field of [`vault.prefs`](#vaultprefs) — an optional nested-object map from a canonical trailing-slash folder path to an icon name drawn from a curated client-side stroke-glyph set (no arbitrary/uploaded icon, no emoji); NFC-normalized, lexicographically-keyed, omitted-when-empty (`spec/protocol.md` §9.5.2). Folder-keyed entries are prefix-rewritten on folder rename/move and pruned on delete; a stale or unknown-icon entry is ignored at render and pruned on the next write. **Non-load-bearing** (cosmetic, AS-low). Folders only — notes get a [color label](#color-label) but not a custom icon. See also [color label](#color-label), [PrefsView](#prefsview). (MYND-185)

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-07

### **Cytoscape.js** &nbsp; 🛠️ *Tooling*

Originally selected for Myne's minimal graph view, but **superseded 2026-06-08 by [d3-force](#d3-force) + a hand-rolled canvas renderer** (see `decisions.md` 2026-06-08). The leaner decomposition — a dep only for the force-simulation, with render/interaction hand-rolled — cleared `dependency-policy.md` "The bar" Q1 where the full framework did not. Retained here for historical reference.

### **d3-force** &nbsp; 🛠️ *Tooling*

The force-directed-layout simulation library (`d3-force`, ISC) used for Myne's minimal graph view in Phase 1. It computes node positions only; the canvas render, pan/zoom/hit-test, and interaction are hand-rolled (no graph framework). Lazy-loaded into a separate panel rather than rendered in the editor surface. Chosen over [Cytoscape.js](#cytoscapejs) per `decisions.md` 2026-06-08 — the Envelope-A scale target (smooth to low-thousands of nodes, controlled degradation above) shrinks the dependency question to "force-simulation only", which `dependency-policy.md` Q1 then resolves to the hand-roll-plus-leaf-dep form.

### **decoration layer** &nbsp; 📦 *Product*

The CodeMirror 6 render overlay that hides or replaces ranges of the markdown buffer visually without mutating the underlying text. Decorations come in four kinds: `mark` (apply a CSS class to a range — used to hide leading `#`s), `widget` (insert a DOM element at a position — used for wikilink chips, task list checkboxes), `replace` (hide a range and substitute a widget — used for table widgets and code-block frames), and `line` (per-line attributes on the wrapping `cm-line` div — used for blockquote left-border styling). The decoration layer reads the `@lezer/markdown` AST and produces decorations per node type. The text buffer is canonical; decorations are ephemeral state derived from the buffer plus cursor position.

Used in: `vision.md` Phase 1 Scope

### **definition list** &nbsp; 📦 *Product*

A Pandoc-style block construct: a *term* line immediately followed by one or more *definition* lines, each introduced by a leading `:` marker (`Term` ⏎ `: Definition`). Myne v0.1 recognizes and renders a **pinned tight subset** — term immediately followed (no blank line) by `:`-prefixed definition line(s), multiple definitions allowed; the loose/blank-line-separated form, lazy continuation, and multiple-terms-per-block are excluded and preserved byte-stably as ordinary paragraphs. The GFM grammar has no definition-list node, so a custom `MarkdownConfig` block parser produces a `DefinitionList` node (`DefinitionTerm` / `DefinitionMarker` / `DefinitionDesc` children); the editor renders the term styled with the definitions indented and the leading `:` hidden off-cursor. Recognized and rendered but **never emitted** — no authoring affordance produces one. Moved into v0.1 scope by a 2026-05-30 scope reversal (previously out of scope per the D1 dialect entry). See also [decoration layer](#decoration-layer), [reference link](#reference-link).

Used in: `spec/markdown-dialect.md` §3.1, §8; `decisions.md` 2026-05-30

### **DecryptedNote** &nbsp; 📦 *Product*

The opaque Rust handle returned by `protocol::decode_note` on a successful per-note decryption (`spec/protocol.md` §6.4). Carries — privately — the original 112-byte header slab from the source `.myn` blob (bytes 0..47+N: magic + version + reserved + items_key_id + item_key_nonce + enc_item_key_len + enc_item_key), the unwrapped 32-byte `item_key` in `Zeroizing<[u8; 32]>`, the decrypted markdown plaintext in `Zeroizing<Vec<u8>>`, and the `note_uuid` carried out-of-band per §9.1 (the `.myn` filename, not in the blob bytes). All four fields are private; consumers reach the non-secret subsets through accessor methods that slice into the slab. The slab retention is load-bearing for §6.3's "bytes 0..47+N byte-identical across revisions" invariant: `encode_update` splices the slab verbatim into the new blob, never reconstructs the prefix from fields. `Drop` zeroizes both `item_key` and `plaintext`; the `Debug` impl is hand-written and emits redacted markers (a regression test pins the no-leak property). `encode_update` consumes the handle by value (typestate "one decode, one update"); `encode_update_blob_raw` borrows for D6-style nonce-permutation tests.

Used in: `spec/protocol.md` §6, `decisions.md` 2026-05-05 "`item_key` persistence across note revisions"

### **Damm-32 / Damm algorithm** &nbsp; 🏗️ *Construction*

A check-digit algorithm using a **weak** totally anti-symmetric quasigroup with zero diagonal (Damm 2004), generalized here to a 32-character alphabet matching Crockford base32. Myne appends one Damm-32 character to the 19-character account-number payload to catch single-character substitutions, all adjacent transpositions, and a high fraction of two-character errors. The 32×32 quasigroup table is frozen in `spec/account-number.md` §4.2 — derived over GF(2⁵) (x⁵+x²+1, bitmask 37) and pinned both as a literal table and a `myne-test-vectors` `damm32-table` vector. The operation is commutative (hence weak — not fully — anti-symmetric), which is correct: the Damm check equation requires only weak total anti-symmetry. Changing the table is a major-version event.

Used in: `spec/account-number.md` §4

### **daily note** &nbsp; 📦 *Product*

An ordinary `.myn` note representing one calendar day, identified by **folder + date-title** (e.g. a note titled `2026-06-07` inside the `Daily/` folder) — **not** a calendar object, date-object model, or date-indexed database. The "Open today's note" command resolves today's note idempotently: it computes today's date-title from `now` via the `daily_date_format` pref and looks for a non-trashed, non-template note matching the daily folder + date-title under case-fold + NFC identity (`spec/markdown-dialect.md` §3.6.2); found → open, not found → create (from the [note template](#note-template) the `daily_template` pref points at, or blank with the date as title) and open. Three `vault.prefs` fields configure it (`spec/protocol.md` §9.5.2): **daily folder** (`daily_folder`, default `Daily/`, also registered as a [deliberate folder](#deliberate-folder) so it survives empty), **daily date format** (`daily_date_format`, default `YYYY-MM-DD`), and **daily template** (`daily_template`, a template UUID or unset). Past days are reached via the ordinary sidebar folder — no date-picker, no jump-to-date. Bounded as a plain-markdown skeleton + date navigation by construction, respecting the anti-Notion / no-calendar commitment (`vision.md`). See [decisions.md](decisions.md) 2026-06-07 (MYND-191).

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-07 (MYND-182 / MYND-191)

### **deleted-attachment tombstone** &nbsp; 📦 *Product*

The styleable placeholder an editor embed renders when its [attachment-id](#attachment-id) no longer resolves. Note bodies are **never** rewritten on deletion — the `![[att:<id>|filename]]` reference dangles intentionally and the resolver renders a tombstone, distinguishing a *deleted attachment* (id once existed, removed from the library) from a *broken reference* (id never existed). One shared component across the editor and the attachments library. Consistent with the no-auto-GC, explicit-delete-only attachment lifecycle. (MYND-164)

### **deliberate folder** &nbsp; 📦 *Product*

A folder the user explicitly created that persists in the sidebar tree even when it holds no note. Because the virtual-folder model derives folders from each note's `folder:` frontmatter, an empty folder has no note to carry it; deliberate folders are therefore persisted as a set (the top-level `deliberate_folders` array) inside the encrypted `vault.prefs` (`spec/protocol.md` §9.5.2). The set is *cold* — written only on explicit folder create / delete, never on note move — and merges as a union (add-wins) under Phase 2 sync. A folder that exists only because notes carry its path is *implicit* and vanishes when its last note leaves; a deliberate folder survives. Identity is case-fold + NFC (`spec/markdown-dialect.md` §3.6.2). See also [folder](#folder), [item order](#item-order).

Used in: `spec/protocol.md` §9.5.2, `spec/markdown-dialect.md` §3.6.2; `decisions.md` 2026-05-29

### **DEM (Data Encapsulation Mechanism)** &nbsp; 🏗️ *Construction*

The symmetric-encryption layer in a hybrid encryption scheme — pairs with a KEM. Myne does not use KEM-DEM in v0.1 (no asymmetric encryption); referenced in the v005 roadmap for sharing operations.

Used in: `spec/protocol.md` §11 (out of scope for v0.1)

### **derive_key pattern** &nbsp; 📋 *Protocol* (deep entry)

Myne's mandated single-helper pattern for subkey derivation. All HKDF-Expand calls in the protocol go through one canonical function — `DeriveSubkey(rootKey, role) → 32 bytes` — which constructs `info = "myne.v0.1 " || role` from the registered role table (§3.4). Direct calls to HKDF-Expand outside this helper are forbidden by code review. The pattern recovers the API-level safety of BLAKE3's `derive_key` (where context is a first-class argument) while keeping HKDF-SHA-256 as the underlying primitive for libsodium and MLS alignment. Without this helper rule, HKDF's historical misuse mode (malformed or empty `info` parameters) would re-emerge.

Used in: `spec/protocol.md` §3.2.1

### **device key** &nbsp; 🗝️ *Key/identifier*

Reserved term for `appname-v005` multi-device support: a per-device asymmetric key pair stored in hardware (Secure Enclave / TPM / Android Keystore) that participates in MLS group formation. **Not used in v0.1** — single-device protocol does not need device keys.

Used in: `spec/protocol.md` §11 (out of scope for v0.1)

### **device-local credential** &nbsp; 🗝️ *Key/identifier*

A credential that lives only on one device and is **never synchronized**, because it is bound to that device's hardware. The v0.1 instance is the [quick-unlock credential](#quick-unlock-credential) blob (`vault.quickunlock`, `spec/protocol.md` §9.14): its wrap key is held in the OS keychain with `thisDeviceOnly` accessibility, so a copy on another device is inert. Contrast the master-password and recovery-phrase credentials, which are device-portable and ride in the synced `vault.meta`. Each device that opts into quick-unlock mints its own device-local credential.

Used in: `spec/protocol.md` §9.14, `decisions.md` 2026-06-16

### **domain separation** &nbsp; 📋 *Protocol*

The cryptographic principle that contexts which should not produce equal outputs from equal inputs MUST mix in a context-distinguishing string. Myne applies it pervasively: HKDF context strings (§3.2), AAD prefixes (§5.2), KDF-parameter binding (§4.3), and protocol-version magic bytes (§9, §10). Failure to domain-separate is the root cause of many published protocol vulnerabilities.

Used in: `spec/protocol.md` §3.2, §5.2

### **downgrade attack** &nbsp; ⚠️ *Threat*

An attack where the adversary forces the use of a weaker protocol version, KDF parameter set, or cipher suite than the one the parties would otherwise negotiate. Myne structurally prevents downgrade by binding the protocol version, KDF parameters, and AAD prefix into every AEAD tag — any tampering fails verification (`spec/protocol.md` §5.2, §10.5). The forward-incompatible major-version model adds a second layer: cross-major substitution fails because magic bytes and AAD prefixes differ.

Used in: `spec/protocol.md` §10.5

### **dual-credential wrap** &nbsp; 🏗️ *Construction* (deep entry, *Myne-divergent*)

Myne's pattern for unlocking the vault under either of two independent credentials. The 32-byte random `root_key` is wrapped under two keys: `password_wrap_key` (Argon2id of the master password) and `recovery_wrap_key` (Argon2id of the BIP-39 phrase). Both encrypted copies — `enc_root_key_password` and `enc_root_key_recovery` — live in `vault.meta` (§9.3). Either credential alone reconstructs the root_key; both must be lost to render the vault unrecoverable. The architecture cleanly extends to a third wrap (e.g., a hardware-backed WebAuthn-PRF unlock) in `appname-v005`.

Used in: `spec/protocol.md` §3.1, §9.3

### **Ed25519** &nbsp; 🔐 *Primitive*

The EdDSA signature scheme over the twisted Edwards form of Curve25519 (RFC 8032). Not used by Myne's at-rest cryptography in v0.1; reserved for code-signing of releases (`threat-model.md` §3 TB7) and for v005 multi-device identity.

Used in: `threat-model.md` §3 TB7
Reference: RFC 8032.

### **editor typography** &nbsp; 📦 *Product*

The user-tunable presets for the editor's reading surface: **text size** (`sm`/`md`/`lg`/`xl`), **line spacing** (`tight`/`normal`/`relaxed`), **content width** (`narrow`/`normal`/`wide`/`full`), and **font** (`mono`/`sans`). Each is a closed enum stored as a free string in the four `editor_*` fields of the encrypted `vault.prefs` (`spec/protocol.md` §9.5.2); the client is the single authority mapping a preset to a concrete CSS value and mapping a `null`/unknown value to that field's canonical default (`md` / `normal` / `normal` / `mono`). Cosmetic and **non-load-bearing** (AS-low) — a tampered value can at worst change how the text renders. Applied live in the editor via CSS custom properties (no remount); the heading sizes are `em`-relative so they scale with the base text size. Configured in Settings → Editor. See also [vault.prefs](#vaultprefs).

Used in: `spec/protocol.md` §9.5.2

### **enc_item_key** &nbsp; 🗝️ *Key/identifier*

The on-disk wrapped form of a per-note `item_key`. Layout per `spec/protocol.md` §9.2: 32 bytes of XChaCha20-Poly1305 ciphertext over the random `item_key`, followed by the 32-byte CTX commitment tag. Encrypted under the singleton `itemsKey` with `item_key_nonce`.

Used in: `spec/protocol.md` §9.2

### **enc_items_key** &nbsp; 🗝️ *Key/identifier*

The on-disk wrapped form of the singleton `itemsKey`, stored in `vault.meta`. 32 bytes of XChaCha20-Poly1305 ciphertext over the `itemsKey` plus the 32-byte CTX tag, encrypted under `itemsKey_wrap_key`.

Used in: `spec/protocol.md` §9.3

### **enc_root_key_password / enc_root_key_recovery** &nbsp; 🗝️ *Key/identifier*

The two on-disk wrapped copies of `root_key` in `vault.meta`. Each is 32 bytes of XChaCha20-Poly1305 ciphertext over `root_key` plus a 32-byte CTX commitment tag. Encrypted respectively under `password_wrap_key` and `recovery_wrap_key`. The dual-credential wrap pattern requires both to exist at vault creation.

Used in: `spec/protocol.md` §3.1, §9.3

### **export** &nbsp; 📦 *Product*

A one-shot, user-initiated operation that decrypts user content and writes it as ordinary **unencrypted** files to a destination the user explicitly chose via the OS file dialog — per-note markdown, the whole-vault markdown tree, attachment files, or a rendered PDF. Export is the portability path ("you walk away with your files", `vision.md`): the markdown forms write the stored plaintext **verbatim** (frontmatter included; the only sanctioned mutation is the attachments-mode embed rewrite, `markdown-dialect.md` §6). Terminology wall: an export is never a [vault backup file](#vault-backup-file) (that stays exactly as encrypted as the vault) and never a snapshot (version history). Threat-model framing: a deliberate plaintext crossing of TB3 under user authority — the artifact is outside Myne's protection from the moment it is written (`threat-model.md` §3 TB3, §5). There is no plaintext *mode*: no watch, mirror, or export-on-save exists.

Used in: `threat-model.md` §3/§5, `markdown-dialect.md` §6, `decisions.md` 2026-06-11 (export suite)

### **fall-to-rebuild** &nbsp; 📋 *Protocol*

The fallback path for loading the [search index](#search-index) when the cached `vault.search` blob (`spec/protocol.md` §9.6) cannot be trusted or used — blob absent, magic / version mismatch, AEAD-verification failure, or an unreadable staleness manifest. Instead of incrementally reconciling the cached index against the notes, the client **rebuilds it from scratch** by decrypting every `.myn`. Rebuild always recovers the correct index, so `vault.search` carries no integrity-of-search burden: a disk attacker who deletes or corrupts it costs the user one slower unlock, nothing more. The complement of the **incremental reconcile** happy path (re-index only the notes whose `content_nonce` changed) — fall-to-rebuild is the always-correct safety net beneath it (`decisions.md` 2026-05-31).

Used in: `spec/protocol.md` §9.6.4

### **favorites** &nbsp; 📦 *Product*

The user's chosen shortcut list of notes, surfaced in a dedicated Favorites section pinned above the sidebar tree. Persisted as the `favorites` field of `vault.prefs` — a **sequence** array of note UUIDs only (display order is the payload; NFC-normalized, not sorted, not deduped, omitted-when-empty), so favoriting is cheap view-state (a prefs write, no `.myn` re-encrypt) that reverts to empty on a tampered/absent blob (`spec/protocol.md` §9.5.2, §9.5.5). A favorited note **also** keeps its normal position in the tree — favoriting is a shortcut, not a move — so it renders in two rows (disambiguated by section-qualified keys); selection is keyed by note-id (both rows highlight) and keyboard navigation visits it once. Add via a hover star, the context menu, or dragging a note into the section; remove via star/menu only. A favorite UUID with no live note is ignored at render and pruned on the next write. See also [item order](#item-order), [PrefsView](#prefsview). (MYND-183)

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-02

### **filter AST** &nbsp; 📋 *Protocol*

The recursive, **closed-allow-list** tree that expresses a [saved view](#saved-view)'s query (Saved Views epic, MYND-272/MYND-273). A node is a boolean combinator (`and` / `or` / `not`) over a fixed leaf set — `hasTag` and `inFolder` (both subtree-inclusive), full-text `search`, a typed `property` comparison (`== != > < >= <= contains`, date compares on frontmatter dates only), and the degenerate `all`. There is deliberately **no** arithmetic / `list.map` / formula node: the type cannot represent one, so the query layer can never evaluate arbitrary code (the "no databases / no formula" anti-feature of [vision](#vision) expressed in the type system). Serialized canonically (`#[serde(tag = "kind")]`, camelCase kinds + operator literals) inside the `saved_views` field of [vault.prefs](#vaultprefs); the query engine reads it and the renderer never re-derives it. See also [saved view](#saved-view), [property](#property). (MYND-272 / MYND-273)

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-15

### **folder** &nbsp; 📦 *Product*

A *virtual* organizational container for notes, shown as a nested tree in the sidebar. A note's folder is a slash-delimited path stored in its `folder:` frontmatter (`spec/markdown-dialect.md` §3.6.1); the on-disk layout never reflects it — `notes/<uuid>.myn` stays flat (`spec/protocol.md` §9.1), so folder structure is encrypted metadata (`threat-model.md` AS3) reconstructed client-side. The tree is a derived view: `dedup_union` of the ancestor-expanded paths from every note's `folder:` field and the [deliberate-folder](#deliberate-folder) set, under case-fold + NFC identity (`spec/markdown-dialect.md` §3.6.2). A folder carried only by notes is *implicit* and vanishes when its last note leaves; a deliberate folder persists when empty. Folders and folderless notes share a single interleaved tree at every level, ordered by [item order](#item-order) (MYND-183) — a folderless note is not bucketed into a separate section but renders at the root level alongside top-level folders. Distinct from a *tag* (a separate, non-hierarchical organizational axis that coexists with folders). See also [item order](#item-order).

Used in: `spec/markdown-dialect.md` §3.6.1–3.6.2, `spec/protocol.md` §9.1, §9.5.2; `decisions.md` 2026-05-29

### **folder note** &nbsp; 📦 *Product*

A note designated the **index note** of its [folder](#folder) via the value-strict `folder_index: true` frontmatter flag — the sixth [Myne-managed canonical frontmatter field](#myne-managed-canonical-frontmatter-field) (`spec/markdown-dialect.md` §3.6.1). The note indexes whichever folder its own `folder:` names; the binding is the boolean alone and carries **no path**, so a folder rename rewrites `folder:` and the binding follows for free (rename drift is structurally impossible). Unlike a [note template](#note-template) or a trashed note (both **hidden** from the views), a folder note stays a **fully visible, enumerable** child of its folder — pinned to the top with a badge, never excluded from sidebar / folder-tree / search. It is targetable by a [folder-target wikilink](#folder-target-wikilink) `[[<folder>/]]`. Value-strict exactly like `template:`: only the canonical unquoted `true` designates it; `1` / `yes` / `"true"` / absence leave the note ordinary. Owned by the folder-note designate / undesignate actions (`src/notes/folderNote.ts`) only — never written by body autosave; surgery via `patchFolderIndexField`, read via `readFolderIndexFromFmBody`. If two in-folder notes both carry the flag, a deterministic winner is chosen (smallest `note_uuid`) and the rest are flagged. Rides the existing `.myn` AEAD envelope — no new magic byte, no AAD / version bump, no on-disk-layout change (within v0.1; forward-incompatible-by-design with v005). See also [folder](#folder), [folder-target wikilink](#folder-target-wikilink), [Myne-managed canonical frontmatter field](#myne-managed-canonical-frontmatter-field). (MYND-370)

Used in: `spec/markdown-dialect.md` §3.6.1, `spec/wikilink.md` §5.5; `decisions.md` 2026-06-17

### **folder-target wikilink** &nbsp; 📦 *Product*

The trailing-slash wikilink form `[[<folder>/]]` (form 11, `spec/wikilink.md` §2 / §5.5) that resolves to a folder's [folder note](#folder-note) — its index note (`folder_index: true`). The trailing `/` is the sole discriminator from a title-only target: `[[Projects]]` targets a note titled "Projects", `[[Projects/]]` targets the index note of the *folder* "Projects". It reuses the ordinary wikilink machinery — backlinks, hover, graph — so it is a different spelling of "link to this note", not a different link kind. Two distinct broken hints: **"(no folder note)"** when the folder exists but has no index note, **"(no match)"** when the folder does not exist. A folder rename refreshes inbound folder-target links' path segment on the best-effort §8.1 pass (the index-note binding itself is path-free, so the target note tracks the rename regardless). Recognized and resolved but not the canonical authoring emission (Myne emits the note-targeting form 6); round-trips byte-for-byte. See also [folder note](#folder-note), [bidirectional links](#bidirectional-links). (MYND-370)

Used in: `spec/wikilink.md` §2, §5.5, `spec/markdown-dialect.md` §3.5; `decisions.md` 2026-06-17

### **footnote definition** &nbsp; 📦 *Product*

A `[^N]: definition text` block in the Myne dialect (`spec/markdown-dialect.md` §3.4), where `N` is any non-whitespace identifier. Recognized by a custom footnote `MarkdownConfig` (`src/dialect/lezer/footnote.ts`, MYND-153) as a `FootnoteDefinition` **composite** block; position is not normative (§3.4). The body continues onto blank or ≥4-column-indented following lines (Pandoc / GitHub continuation), so a footnote may hold multiple paragraphs, fenced code, or blockquotes; a footnote-definition line interrupts an open paragraph so consecutive `[^1]:`/`[^2]:` lines are distinct. In the Phase 1 editor the in-source line is left byte-stable in place (never moved or rewritten — D1 hard rule C1), de-emphasized off-cursor and revealed at full prominence on-cursor, while a derived read-only "Footnotes" list at document end renders every definition's text (the list is a VIEW, not a serialization). A definition that no [footnote reference](#footnote-reference) points at is collected and flagged *unreferenced*. Distinct from a [reference link definition](#link-reference-definition) (`[ref]: url`), which a footnote definition outranks at parse.

Used in: `spec/markdown-dialect.md` §3.4, §8; `decisions.md` 2026-05-31; `src/dialect/lezer/footnote.ts`, `src/editor/decorations/footnote.ts`

### **footnote reference** &nbsp; 📦 *Product*

An inline `[^N]` marker in the Myne dialect (`spec/markdown-dialect.md` §3.4), where `N` is any non-whitespace identifier (typically an integer, but `[^note]` / `[^a1]` are permitted). Recognized as a `FootnoteReference` node (`src/dialect/lezer/footnote.ts`, MYND-153) and rendered in the Phase 1 editor as a small superscript glyph (the identifier) with the `[^` / `]` brackets hidden off-cursor; the cursor entering the span reveals raw `[^N]` for editing (the cursor-aware reveal shared with links). Clicking a reference whose [footnote definition](#footnote-definition) exists jumps the cursor to that definition; an *orphan reference* (no matching definition) renders a muted error-tinted variant and clicking is a safe no-op.

Used in: `spec/markdown-dialect.md` §3.4, §8; `decisions.md` 2026-05-31; `src/dialect/lezer/footnote.ts`, `src/editor/decorations/footnote.ts`

### **forward-incompatible major version** &nbsp; 📋 *Protocol* (deep entry, *Myne-divergent*)

Myne's architectural commitment that each major protocol version (v0.1, v005, v006, …) is a closed, complete specification with distinct magic bytes, AAD prefix, and context-string prefix. Cross-major reads happen only via explicit user-initiated migration (`spec/protocol.md` §10.4); a v005 client refuses to silently parse a v0.1 blob, and vice versa. The choice contradicts the additive-extension model common in TLS 1.0–1.2 and OpenPGP; the reasoning is that those protocols' downgrade-attack history (POODLE, FREAK, Logjam, MEGA-2022) shows additive extension to be a structural risk. v005's anticipated changes (PQ hybrid wrap, MLS multi-device, OPAQUE auth, KT log) are too deep to be additive in any honest sense.

Used in: `spec/protocol.md` §10.1

### **forward secrecy** &nbsp; ⚠️ *Threat*

The property that compromise of a long-term key does not enable decryption of past messages encrypted with derived ephemeral keys. Myne v0.1 does **not** provide forward secrecy — the persistent `itemsKey` is reusable across all notes for the vault's lifetime. The `appname-v005` roadmap introduces per-epoch `itemsKey` rotation that would provide forward secrecy by deleting old epoch keys after migration.

Used in: `threat-model.md` §7; `spec/protocol.md` §3.3 (forward-compat note)

### **frontmatter** &nbsp; 📦 *Product*

The optional YAML metadata block delimited by `---` lines at the top of a note's decrypted markdown (`spec/markdown-dialect.md` §3.6). Carries the five Myne-managed canonical fields (`updated:` / `title:` / `folder:` / `trashed:` / `template:`, §3.6.1) plus arbitrary user-authored keys, all preserved byte-for-byte on write (unknown-field-preservation + §6 C1). The editor's recognizer only *delimits* the block; a separate read-only [property](#property) parse (Saved Views / MYND-271) reads the YAML *body* to type each key for the [property index](#property). Not to be confused with the inline `#tag` / frontmatter `tags:` distinction (§3.7).

Used in: `spec/markdown-dialect.md` §3.6

### **γ1+γ2 hybrid autosave** &nbsp; 📦 *Product*

The canonical Myne autosave call-pattern locked in `decisions.md` 2026-05-07 "`note_update` IPC … UI-level autosave coalescing": a UI-side state machine composing **γ1 idle-debounce** (a save fires after the user has been idle for N milliseconds since the last keystroke) + **γ2 max-debounce** (a save fires regardless every M milliseconds during sustained typing, so a writer who never pauses still gets a save) + a **latest-wins single-in-flight gate** (if a save is already in flight when another fire is due, the in-flight completes first, then a single follow-up save fires with the latest body — no IPC thrashing) + canonical **flush triggers** (`flush-on-vault-lock` from the original entry; `flush-on-blur` and `flush-on-window-close` pinned by `decisions.md` 2026-05-15). Phase 1 v0.1 timings are N=1000ms, M=10000ms. The pattern lives entirely in the UI; the Rust `note_update` command is stateless and plaintext-blind. Backend-side queueing (γ3) was explicitly rejected because the `notes` plugin holds no own state per `decisions.md` 2026-05-07 "notes plugin scaffold". The Greek-letter naming is internal shorthand inherited from the 2026-05-07 MYND-27 grill where four call-pattern alternatives were enumerated (α stateless, β stateful-handle, γ hybrid, δ deferred — α + γ shipped).

Used in: `decisions.md` 2026-05-07 (pattern), 2026-05-15 (concrete timings); MYND-81

### **graph view** &nbsp; 📦 *Product*

The visualization of `[[wikilink]]` relationships between notes as a force-directed graph. Myne Phase 1 includes a minimal graph view — [d3-force](#d3-force) layout + a hand-rolled canvas renderer — in a separate, lazy-loaded panel (`vision.md` Phase 1 Scope). Nodes are notes only (tags/folders are a filter dimension, not nodes); edges are resolved cross-note references.

Used in: `vision.md` Phase 1 Scope

### **hash-pinned dependencies** &nbsp; 🛠️ *Tooling*

Lockfiles checked into the repository that record the exact SHA hash of every direct and transitive dependency. Myne covers Cargo (Rust), npm (Phase 3 web UI), Go modules (server), and any WASM artifacts. Updates require explicit review.

Used in: `threat-model.md` §6, §7

### **HKDF (HKDF-SHA-256)** &nbsp; 🔐 *Primitive*

The HMAC-based Extract-and-Expand Key Derivation Function defined in RFC 5869, instantiated with SHA-256. Myne calls `HKDF-Extract(salt=zero_32, IKM=root_key)` once per session to produce the PRK, then `HKDF-Expand(PRK, info=context_string, L)` for each subkey. All HKDF-Expand invocations go through the `derive_key` helper (§3.2.1) — direct invocation is forbidden.

Used in: `spec/protocol.md` §3.2
Reference: RFC 5869.

### **HNDL (Harvest Now, Decrypt Later)** &nbsp; ⚠️ *Threat*

A class of attack where an adversary captures encrypted traffic or storage today, expecting future cryptographic advances (notably quantum computing) to enable decryption later. Myne v0.1 does not provide post-quantum protection; the `appname-v005` roadmap introduces hybrid X25519 + ML-KEM-768 wrap to address HNDL for sync-server scenarios.

Used in: `threat-model.md` §1 (A10 discussion); `e2ee-notes-evaluation.md`

### **embedded HTML rendering** &nbsp; 📦 *Product*

The editor's rendering of a curated safe subset of note-authored raw HTML (MYND-209): inline `<kbd>`/`<mark>`/`<sub>`/`<sup>`/`<abbr title>` and block `<p>`/`<details>`/`<summary>`. The raw span is sanitized through DOMPurify (lazy-loaded) under an ultra-tight allowlist (8 tags, `title`-only) and rendered via `innerHTML` of the **sanitized output only** — the SYNC-5 trusted-input boundary. Off-allowlist tags (`<script>`/`<iframe>`/`<img>`) and HTML inside code are not rendered (stay plain text). `<details>` is natively interactive with open/closed in a WebView-only map (never the buffer, §6 C1). Supersedes the prior "raw HTML → plain monospace, no XSS surface" posture (`markdown-dialect.md` §8; `decisions.md` 2026-06-08).

Used in: `spec/markdown-dialect.md` §3.1/§8, `threat-model.md` §6

### **callout (admonition)** &nbsp; 📦 *Product*

A `> [!TYPE]` blockquote rendered as a styled container with a colored tint, icon, and title (MYND-47) — the GitHub/Obsidian admonition convention. `src/editor/decorations/callout.ts` promotes the blockquote via a separate cursor-aware layer that composes with `blockquote.ts` (does not modify it); the Obsidian-full ~12-type set is case-insensitive and maps to the existing semantic color tokens + a local icon set. Custom title supported; unknown type → plain blockquote; `[!TYPE]` bytes preserved, revealed on-cursor (§6 C1). A `/callout` slash command emits `> [!note] ` (§5). The interactive fold (`+`/`-`) marker is recognized + round-trips but the collapse toggle is a follow-up.

Used in: `spec/markdown-dialect.md` §5/§7

### **emoji shortcode** &nbsp; 📦 *Product*

A `:name:` token (e.g. `:rocket:`) the editor renders as the corresponding unicode emoji glyph (MYND-156). The `@lezer/markdown` Emoji config tags the token; a lazy-loaded name→glyph map (`src/dialect/emoji-shortcodes.ts`, code-split per SYNC-4) resolves mapped names, leaving unmapped ones as literal text. The `:` autocomplete inserts the unicode glyph directly (not the `:shortcode:`), so authoring emits a plain char. The source `:name:` is render-only — never rewritten in the buffer (§6 C1).

Used in: `spec/markdown-dialect.md` §3.2

### **highlight (markdown)** &nbsp; 📦 *Product*

The `==text==` inline construct, rendered with a muted warm-amber `--highlight` wash (MYND-156). The one hand-rolled `MarkdownConfig` in Myne's dialect (`@lezer/markdown` ships sub/sup/emoji but no highlight). Cursor-aware: the `==` markers hide off-cursor and reveal on-cursor; bytes preserved (§6 C1). Has a canonical emit form via the highlight selection-toolbar button (§5). The `.cm-highlight` class is shared with the embedded-HTML `<mark>` element render (SYNC-6). `==text==` is always the **default yellow**; non-yellow highlights use [multi-color highlight](#multi-color-highlight) instead.

Used in: `spec/markdown-dialect.md` §3.2, §5

### **multi-color highlight** &nbsp; 📦 *Product*

A 5-color highlight palette — yellow (default), green, blue, pink, purple — usable within a single note (decisions.md 2026-06-15). Because `==text==` carries no color, a non-yellow highlight is stored as the portable [embedded HTML](#embedded-html-rendering) form `<mark class="hl-green|hl-blue|hl-pink|hl-purple">text</mark>` (the toolbar's color swatches emit it; yellow keeps emitting `==text==`). The `hl-*` class set is **closed** and enforced at the DOMPurify boundary (`ALLOWED_ATTR` widened to `[title, class]`, then an `uponSanitizeAttribute` hook keeps `class` only as one allowlisted token on a `<mark>`); an unknown/multi-class value is stripped and falls back to the default-yellow `<mark>` render, with note bytes preserved verbatim (§6 C1). Not Pandoc attribute syntax (§7 still excludes that) — a fixed closed vocabulary, not general `.class` parsing. The per-color washes are the `--highlight-{green,blue,pink,purple}` tokens.

Used in: `spec/markdown-dialect.md` §3.2, §5, §7, §8

### **hosted sync** &nbsp; 📦 *Product*

The convenience-paid tier in Myne's freemium model. Myne-operated zero-knowledge sync server (Phase 2+); identical protocol-level guarantees to a self-hosted instance. Status in v0.1: not yet shipped.

Used in: `vision.md`, `decisions.md`

### **in-note find** &nbsp; 📦 *Product*

The editor's Cmd/Ctrl+F find bar (MYND-175): a **literal, single-document** search over the one open note's decrypted CodeMirror doc text — exact substring, case-fold toggle, no regex — with all-match highlighting, next/prev navigation (Enter / Shift+Enter, wrapping), and a live "k/N" count. Built on the `@codemirror/search` engine with a Myne-token *docked* panel (not the stock widget); the WebView's native Cmd/Ctrl+F is suppressed app-wide. **Deliberately distinct from the [search index](#search-index)**: that is the stemmed, BM25-ranked, Rust-side *cross-note* surface ("which notes relate to this term"); in-note find is the unranked literal *locate* tool ("exactly where in the note I'm reading"). The count is a read-only projection over the engine's match set (never a filter); matches inside folded tables/code are counted and un-fold on navigation, while a frontmatter match is counted but not raw-revealed (always-on Properties widget). The query + match cache are **WebView-only, never persisted**, released on the lock-time reload — best-effort (V8 strings can't be zeroized; AS1-dominated), **not** "zeroize-on-lock" (which is the Rust-side index). See also [search index](#search-index) (`decisions.md` 2026-05-31).

Used in: `decisions.md` 2026-05-31

### **in-transit encryption** &nbsp; 🏗️ *Construction*

TLS 1.3 with strict cipher configuration plus client-side certificate pinning. The transport layer in Myne's protocol is TLS-only — no plaintext fallback (`threat-model.md` §3 TB4). Distinct from at-rest encryption and from the AEAD that ciphertext bytes carry inside their TLS payload.

Used in: `threat-model.md` §3 TB4

### **inline tag** &nbsp; 📦 *Product*

A `#`-prefixed identifier appearing inside note body text (as opposed to the YAML `tags:` frontmatter list). Recognized by the Myne dialect per `spec/markdown-dialect.md` §3.7. Boundary: line-start or whitespace must precede the `#`; `abc#tag` does not match. Character set: Unicode (excluding the General/Supplemental Punctuation blocks and an explicit ASCII-punctuation set). Numeric-only forms (`#1984`) reject; `#y1984` accepts. Nested forms via `/` (`#parent/child`) supported with unbounded depth. The parser only recognizes; never rewrites — byte-stability per §6 C1 extends to inline-tag bytes. Tag identity (case-fold, NFC normalization) is the consuming index layer's responsibility, not the parser's.

Used in: `spec/markdown-dialect.md` §3.7, §6 C1

### **insider threat** &nbsp; ⚠️ *Threat*

Adversary class A11: a Myne team member acting maliciously. The architecture grants the team no privileged read access — keys never leave the client. The single privileged asset is the code-signing key (TB8); compromise reduces to A9 (compromised distribution).

Used in: `threat-model.md` §1 (A11)

### **import-&-convert** &nbsp; 📦 *Product*

The explicit, byte-change-visible command that turns an imported filename-only image reference (`![[image.png]]`, `![alt](path)`) into a real vault [attachment](#attachment): it resolves the source file (auto-resolve, picker fallback), imports it via [attachment_import](#attachment_import), mints the [attachment-id](#attachment-id), and rewrites the reference to the form-C embed `![[att:<id>|filename]]` — with a mandatory diff-preview before commit (parallel to the wikilink R2 conversion command, `spec/wikilink.md` §189). No silent name-match; without invoking it, imported references stay an unrendered chip (byte-preservation, `spec/markdown-dialect.md` C1). (MYND-164)

### **isolated note** &nbsp; 📦 *Product*

*(Alias: orphan note.)*

A note with **zero resolved cross-note wikilink edges** in the graph view — nothing links to it and it links to nothing (MYND-198 / SYNC-13). Graph-STRUCTURAL, not "no authored links": a note whose only outbound link is broken (`[[Typo]]`) is still isolated (a broken link is not an edge), and a note connected only by a shared tag is still isolated (the graph is notes-only — tags are a filter, not nodes). Embed / anchor / block-ref references (`![[Note]]`, `[[Note#h]]`, `[[Note^b]]`) DO count as edges, so a note reached only by an embed is not isolated. Surfaced by the graph view's "Isolated" filter (a degree-0 index query that works at any vault size).

Used in: `vision.md` Phase 1 Scope (graph view); `decisions.md` 2026-06-08 (graph visualization)

### **item order** &nbsp; 📦 *Product*

The user's manual order across the unified sidebar file-tree, persisted as the `item_order` field of `vault.prefs`. A single **sequence** array — a flat, heterogeneous, sibling-local list whose elements are either note UUIDs or canonical trailing-slash [folder](#folder) paths, discriminated by the trailing `/`. Container membership is *structural* (a note's container is its `folder:`; a folder's container is its parent path); the list supplies only a global rank, and each container sorts its own children (sub-folders + notes **together, freely interleaved**) by their index in the one list, unlisted children falling back to recency (notes) / folded name (folders). A single flat list therefore expresses **recursive interleaving** at every level. Canonical encoding: NFC-normalized, order preserved verbatim, not sorted, not deduped, omitted-when-empty (`spec/protocol.md` §9.5.2). **Supersedes** the separate `note_order` + `folder_order` arrays of the pre-MYND-183 schema (`decisions.md` 2026-06-02, which retires the two-array model). See also [favorites](#favorites), [PrefsView](#prefsview). (MYND-183)

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-02

### **item_key** &nbsp; 🗝️ *Key/identifier*

The 32-byte random key that encrypts a single note's plaintext. Generated when the note is created. Stored on disk (in the note's `.myn` blob) wrapped under the singleton `itemsKey` via `enc_item_key`. The third level in Myne's three-level note-key wrapping (`spec/protocol.md` §3.3).

Used in: `spec/protocol.md` §3.3, §9.2

### **item_key_nonce** &nbsp; 🗝️ *Key/identifier*

The 192-bit random nonce used in the AEAD operation that wraps an `item_key` under `itemsKey`. Stored in the per-note blob alongside the wrapped key.

Used in: `spec/protocol.md` §9.2

### **items_key_id** &nbsp; 🗝️ *Key/identifier*

A 16-byte UUIDv7 identifying the `itemsKey` under which a given `item_key` was wrapped. In v0.1, every blob references the singleton vault `itemsKey`'s ID. The field generalizes structurally to v005 epoch identifiers — a v005 vault would have multiple `itemsKey` rotations, each with its own ID.

Used in: `spec/protocol.md` §3.3, §9.2

### **itemsKey** &nbsp; 🗝️ *Key/identifier* (deep entry)

The persistent 32-byte symmetric key that wraps every `item_key` in a vault. Generated once at vault creation (random, from OS CSPRNG) and stored on disk as `enc_items_key` in `vault.meta`, wrapped under `itemsKey_wrap_key`. Re-wrapped — not regenerated — when the user changes their master password: the new `root_key`-derived `itemsKey_wrap_key` decrypts the existing `itemsKey` and re-encrypts it. None of the per-note `item_key` material is touched, and none of the note ciphertexts are re-encrypted, which is essential for vaults of non-trivial size. v005 will rotate `itemsKey` per epoch to provide forward secrecy.

Used in: `spec/protocol.md` §3.3, §9.3

### **itemsKey_wrap_key** &nbsp; 🗝️ *Key/identifier*

The KEK derived from `root_key` via `derive_key(root_key, "myne.v0.1 itemsKey-wrap")`. Wraps the singleton `itemsKey`. The first level in Myne's three-level note-key wrapping.

Used in: `spec/protocol.md` §3.3

### **Ignore list (spell-check)** &nbsp; 📦 *Product*

The set of words the spell checker suppresses without treating as correct
elsewhere (MYND-266). v0.1 has a vault-wide ignore set, persisted (folded) in the
encrypted `vault.dictionary` blob (§9.13), plus a RAM-only "ignore this session"
set that is never written. Distinct from the **Personal dictionary**: ignoring a
word silences its squiggle; adding a word to the personal dictionary asserts it
is correctly spelled.

Used in: `spec/protocol.md` §9.13; MYND-266.

### **KDF (Key Derivation Function)** &nbsp; 🏗️ *Construction*

The generic class of functions that derive cryptographic keys from input keying material plus context. Myne uses two KDFs: Argon2id for password-stretching at vault unlock, HKDF-SHA-256 for fast subkey derivation post-unlock.

Used in: `spec/protocol.md` §4, §3.2

### **KDF parameters canonical encoding** &nbsp; 📋 *Protocol*

The 11-byte big-endian encoding of Myne's Argon2id parameters: `kdf_id (1 B) || kdf_m_kib (4 B) || kdf_t (4 B) || kdf_p (1 B) || argon2_version (1 B)`. Stored in `vault.meta` and bound into both wrap AADs (§3.1) so any tampering with parameters in `vault.meta` fails the AEAD tag check on the wrapped root-key copies.

Used in: `spec/protocol.md` §4.3

### **KEK (Key Encryption Key)** &nbsp; 🏗️ *Construction*

A key whose role is exclusively to encrypt other keys. Myne's `password_wrap_key`, `recovery_wrap_key`, and `itemsKey_wrap_key` are all KEKs.

Used in: `spec/protocol.md` §3

### **KEM (Key Encapsulation Mechanism)** &nbsp; 🏗️ *Construction*

The asymmetric building block of a hybrid encryption scheme. Generates a random symmetric key and an "encapsulation" of it that only the recipient's private key can decapsulate. Myne does not use KEMs in v0.1; ML-KEM-768 (the post-quantum KEM standardized as FIPS 203) is canonical in `appname-v005`.

Used in: `spec/protocol.md` §11 (out of scope for v0.1)

### **key binding** &nbsp; 📦 *Product*

An association between a **chord** and a command id (hotkeys epic, MYND-304). A command may have zero, one, or several key bindings. Defaults live in the application's command registry (in code); user changes persist as overrides in the **keymap**. The effective binding is `override ?? default`.

Used in: hotkeys epic (MYND-304)

### **key-committing AEAD** &nbsp; 🏗️ *Construction*

An AEAD that commits to its key, in the sense that no two distinct keys can decrypt the same ciphertext to two valid plaintexts. Plain XChaCha20-Poly1305 is **not** key-committing; Myne achieves the property by wrapping it in CTX commitment.

Used in: `spec/protocol.md` §5.1
Reference: Chan & Rogaway 2022.

### **keymap** &nbsp; 📦 *Product*

The set of user keybinding *overrides* persisted in `vault.prefs` (the `keymap` field, MYND-304): a map from command id to its set of **chord**s. Overrides only — a command absent from the keymap uses its in-code default; a command mapped to an empty set (`[]`) is explicitly unbound (no shortcut). The effective binding is `override ?? default`. Additive optional `MYP1` field (no new magic / major-version event); non-load-bearing (a tampered value can at worst rebind or drop a shortcut — every command stays reachable via the **command palette**).

Used in: `spec/protocol.md` §9.5.2

### **Key Transparency (KT)** &nbsp; ⚠️ *Threat*

A mechanism for publishing user-key bindings to a verifiable log so that clients can detect malicious server-side key substitution. Out of scope for v0.1 (no multi-device or multi-user identity); a `appname-v005` deliverable.

Used in: `spec/protocol.md` §11; `e2ee-notes-evaluation.md`

### **label slot** &nbsp; 📦 *Product*

One of a fixed, bounded set of named, theme-aware colors a [color label](#color-label) may take — six muted hue-named slots (matched to Myne's iron/ochre/brick/forest register, not bright Finder tags) plus "none". Defined as `--label-*` design tokens in `docs/design/colors_and_type.css` with light/dark value pairs mirroring the state tokens; the dot is a solid fill (no `-soft` variant). Slots are fixed and hue-named, **not** user-renamable, and are **not** a repurpose of the semantic state colors (`--danger` etc.) — a label must not read as a state. See also [color label](#color-label). (MYND-184)

Used in: `decisions.md` 2026-06-07

### **language pack (Tier 1)** &nbsp; 🛠️ *Tooling*
A per-language CodeMirror 6 grammar package (`@codemirror/lang-*`, or a CM5 stream-mode from `@codemirror/legacy-modes`) that provides syntax tokenization for a fenced code block's body. "Tier 1" distinguishes these from the Tier-0 core editor packs: they are **hand-curated** (not pulled via `@codemirror/language-data`) to keep the dependency tree minimal (TB9), and **eager-imported** (revised 2026-05-29 from the original lazy plan, which didn't color reliably in the Tauri WebView). Adopted in the 2026-05-29 decision (MYND-154).
Used in: `src/editor/code-languages.ts`, `design-notes.md` (2026-05-29).

### **last_backup_at** &nbsp; 📦 *Product*

An optional `vault.prefs` field (Unix epoch seconds, encrypted like every pref) recording when the vault was last exported as a [vault backup file](#vault-backup-file); absent ≡ never backed up. Drives the client's backup reminder. Normative field semantics (omit-when-unset, float ban, the locked-export-cannot-update caveat) live in `spec/protocol.md` §9.5.2.

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-10

### **libsodium** &nbsp; 🛠️ *Tooling*

The canonical cryptographic library across Myne's stack. Used via Rust bindings (`libsodium-sys-stable` or `sodiumoxide`) in the desktop client, Go via `golang.org/x/crypto` (parts of which mirror libsodium primitives) on the server, and `libsodium-js` in the Phase 3 web client. RustCrypto crates are an acceptable fallback for primitives where libsodium bindings prove inadequate, but libsodium remains canonical for audit consistency.

Used in: `spec/protocol.md` §2.2

### **libsodium-js** &nbsp; 🛠️ *Tooling*

WebAssembly-compiled JavaScript port of libsodium. Used in the Phase 3 web client (bundler choice deferred to Phase 3 start; framework is React) and in the Phase 3 React Native mobile clients (via `react-native-libsodium`). Provides Argon2id, XChaCha20-Poly1305, HKDF, and the other primitives the protocol requires.

Used in: `spec/protocol.md` §5.1.4

### **libsodium-sys-stable / sodiumoxide** &nbsp; 🛠️ *Tooling*

Rust FFI bindings to the libsodium C library. The desktop crypto layer uses one of these (selected at implementation time).

Used in: `decisions.md` (Tauri stack realignment)

### **link reference definition** &nbsp; 📦 *Product*

A `[label]: url` line (CommonMark "link reference definition") that supplies the destination for a [reference link](#reference-link) (`[text][label]`) or a reference-style image (`![alt][label]`) elsewhere in the same note. Labels match by CommonMark rules — case-folded with internal whitespace collapsed — and the first definition of a given label wins. In the Myne editor a shared collector scans all such definition lines into a `label → { target, range }` map; a definition referenced by a resolved reference link is hidden off-cursor (it reads as body noise otherwise) and revealed when the cursor enters its line. The definition bytes are preserved (§6 C1) and the form is never emitted by an authoring affordance. See also [reference link](#reference-link).

Used in: `spec/markdown-dialect.md` §3.2; `decisions.md` 2026-05-30

### **local graph** &nbsp; 📦 *Product*

The open note's neighborhood (1-2 hop) subgraph in the [graph view](#graph-view) — the note plus the notes it links to and that link to it, expanded one or two hops (MYND-199). It is a MODE of the graph modal (a note-relative entry centered on the open note), NOT a separate sidebar pane — a deliberate choice to keep the persistent UI calm (a persistent animated graph beside the editor would be the loudest element against the no-decorative-motion canon; deferred behind a dogfood trip-wire as a v1.x canon amendment). A single click pivots (re-centers on the clicked node, no navigation); a double-click opens the note. Selecting the "All" filter chip returns to the whole-vault graph.

Used in: `vision.md` Phase 1 Scope (graph view)

### **magic bytes** &nbsp; 📋 *Protocol*

Fixed ASCII byte sequences at the start of Myne on-disk files that identify the format version. v0.1: `MY01` for per-note `.myn` files, `MYV1` for `vault.meta`. Reserved for v005: `NT05`, `NTV5`. Magic bytes plus the AAD prefix and context-string prefix together implement the forward-incompatible major-version model.

Used in: `spec/protocol.md` §9.1, §9.2, §9.3, §10.3

### **master password** &nbsp; 🗝️ *Key/identifier*

The user's primary authentication credential. Held in user memory only. Fed to Argon2id with `salt_password` to derive `password_wrap_key`, which encrypts a copy of `root_key`. Myne recommends ≥12 characters and zxcvbn score ≥3 at signup; users with weaker passwords are protected primarily by their recovery phrase.

Used in: `spec/protocol.md` §3.1, §4.1

### **migration (cross-major)** &nbsp; 📋 *Protocol*

The user-initiated upgrade procedure between major protocol versions (e.g., v0.1 → v005). Always explicit, never automatic, never silent. The Phase-2-or-later v005 client decrypts the v0.1 vault end-to-end, generates a new v005 `root_key`, builds the v005 key hierarchy, re-encrypts every blob under v005 keys with v005 magic bytes, and rewrites `vault.meta`. v0.1 clients never produce v005 output.

Used in: `spec/protocol.md` §10.4

### **MIN_PASSWORD_LEN** &nbsp; 🛠️ *Tooling*

Project-wide minimum number of Unicode characters a master password must contain before any Argon2id-bound auth-pipeline plugin (`vault_creation`, `vault_recover`, `vault_change_password`) accepts it. Phase 1 value: `12`. Defined in `protocol::password_policy`; mirrored by the frontend `PasswordForm` component (TS hand-mirror; Phase-1-end CI drift check planned). A **structural floor against trivial bypass** (e.g., DevTools-IPC manipulation), not an entropy guarantee — entropy gating (zxcvbn) is deliberately frontend-only per `decisions.md` 2026-05-06 "Auth-pipeline backend MIN_PASSWORD_LEN floor; project-wide retroactive". Counts via `str::chars().count()`, not UTF-8 byte length.

Used in: `protocol/src/password_policy.rs`, `decisions.md` 2026-05-06.

### **MLS (Messaging Layer Security)** &nbsp; 🏗️ *Construction*

The IETF group-key-agreement protocol standardized as RFC 9420. Myne plans to use MLS in `appname-v005` for multi-device and multi-user group key management. Not used in v0.1.

Used in: `spec/protocol.md` §11 (out of scope for v0.1)
Reference: RFC 9420.

### **NFKD normalization** &nbsp; 🏗️ *Construction*

Unicode Normalization Form KD (compatibility decomposition). Applied to recovery-phrase input and account-number input before hashing or feeding to Argon2id (`spec/protocol.md` §3.1, §7.4; `spec/account-number.md` §5). Ensures visually-identical inputs produced by different keyboard layouts hash to the same bytes.

Used in: `spec/protocol.md` §3.1, §7.4

### **nonce** &nbsp; 📋 *Protocol*

A non-repeating value used with a key in an encryption scheme. Myne nonces are 192-bit random values from the OS CSPRNG, drawn fresh for each AEAD call and stored alongside the ciphertext on disk. The 192-bit width makes random-nonce collisions negligible at any realistic vault size, removing the operational burden of nonce uniqueness tracking.

Used in: `spec/protocol.md` §5.3

### **note template** &nbsp; 📦 *Product*

A reusable note skeleton the user picks at note-creation time. Stored as an ordinary AEAD-sealed [`.myn`](#myn-file) note carrying the value-strict Myne-managed `template:` flag (`spec/markdown-dialect.md` §3.6.1) — **not** a `vault.prefs` field, so it inherits the 16 MiB/note ceiling, per-note fault isolation, and a free [UUIDv7](#note_uuid) identity (rename-safe; the template's name is its `title:` field, its content is the note body). A note template is the inverse-visibility twin of [Trash](#trash): excluded from the sidebar file-tree, folder-tree, and search, surfaced **only** in the template picker and the management UI. Location-agnostic (no target-folder baked in) and minimal: no declared-variables field — the [template variable](#template-variable) engine infers `{{...}}` tokens from the body at fill time. Myne ships **none** — a fresh vault has zero templates (start-empty). See [markdown-dialect.md](spec/markdown-dialect.md) §3.6.1 (`template:` row), [decisions.md](decisions.md) 2026-06-07 (MYND-186).

Used in: `spec/markdown-dialect.md` §3.6.1; `decisions.md` 2026-06-07 (MYND-186)

### **note_uuid** &nbsp; 🗝️ *Key/identifier*

The unique identifier of a note. UUIDv7 in v0.1 (time-ordered, naturally sortable). Used as the filename on disk (with the `.myn` extension) and bound into the AAD of content encryption. UUIDv7's millisecond-resolution time component leaks creation-time bucket; v005 may switch to UUIDv4 if even this is unacceptable.

Used in: `spec/protocol.md` §9.1, §5.2

### **NoteId** &nbsp; 🗝️ *Key/identifier* (*Myne-divergent*)

Host-side newtype around the per-note UUIDv7 (`note_uuid`). Generated server-side by the `note_create` Tauri command (`NoteId::new_v7`) and returned to the UI as the canonical lowercase-hyphenated 36-char form; the UI never produces a `NoteId` — only consumes the string returned by `note_create` and passes it back unchanged to subsequent reads/updates. `NoteId::parse(&str)` is **strict**: 36 chars + lowercase ASCII letter/digit/hyphen + hyphens at fixed positions 8/13/18/23 + `uuid::Uuid::parse_str` succeeds + `version_num == 7`. Each rejection routes through a `pub(crate) InvalidNoteIdCause` (5 sub-causes) emitted via `tracing::debug!` for ops debugging, then collapses to the single public `InvalidNoteId` IPC variant per the unlock-error-discipline boundary policy (`decisions.md` 2026-04-26). The strict contract delivers three structural defenses: path-traversal becomes impossible (no UI string reaches a path component without `parse` succeeding), filesystem case-sensitivity inconsistency between APFS / ext4 is structurally prevented, and the backend-gen v7-only contract is double-pinned (a v4 UUID submitted by a buggy/hostile UI is rejected at `WrongVersion` before any path concat).

Used in: `spec/protocol.md` §9.1, §5.2; `decisions.md` 2026-05-07 "Note UUIDv7 backend-gen" + "NoteId strict parse"; `src-tauri/src/plugins/notes/note_id.rs`

### **Myne markdown dialect (D1)** &nbsp; 📦 *Product* (deep entry, *Myne-divergent*)

The markdown dialect Myne v0.1 reads and writes: **GFM (GitHub-Flavored Markdown) plus a footnote extension plus a wikilink extension plus YAML frontmatter recognition**. Internally referenced as **D1**. Codified in `spec/markdown-dialect.md`. The dialect is selected as the smallest pin that covers Myne v0.1's editor decoration commitments (tables, task lists, footnotes, wikilinks, frontmatter) while preserving byte-stable round-trip with Obsidian-imported notes (`vision.md` Phase 1 importer commitment). Two alternatives were considered and declined in `decisions.md` 2026-05-01: D2 (D1 + Pandoc extras — declined because the extras are not load-bearing for v0.1 and Obsidian renders them as raw text) and D3 (Djot — declined because `.dj` is not markdown and would break the "walk away into any markdown editor" wedge). Hard rule **C1**: vault imports never silently rewrite content; non-canonical syntax in imported notes is preserved byte-for-byte. Forward-incompatible with v005 by design — v005 will pin its own dialect.

### **Myne-managed canonical frontmatter field** &nbsp; 📋 *Protocol*

A YAML frontmatter field whose value is written by the Myne dialect surgery module (`src/dialect/surgery.ts`) rather than left purely user-authored. v0.1 defines two such fields: `updated` (RFC 3339 string, UTC, **autosave-driven** — overwritten on every `note_update` via `patchUpdatedField` to record the user's last-edit timestamp on the device) and `title` (YAML string scalar, **rename-driven** — overwritten only when the user renames a note from the sidebar AND the read-precedence chain resolves to the frontmatter slot, via `patchTitleField`; the `<NoteRow>` sidebar reads from the same field per the mirror-existing source-of-truth decision tree). Both fields are **unprefixed** (no `myne_` namespace) to align with Obsidian / Logseq / Bear convention and the `PRODUCT.md` plain-markdown-portability commitment. Other frontmatter fields (`tags:`, user-defined keys) are user-authored and preserved per `markdown-dialect.md` §3.6 "Unknown frontmatter fields are preserved on write." The set of Myne-managed canonical fields is forward-incompatible-by-design with v005.

Used in: `spec/markdown-dialect.md` §3.6.1; `decisions.md` 2026-05-07 "User-meaningful timestamp storage path"; `decisions.md` 2026-05-15 "Note title write target"

### **`myne.v0.1` prefix** &nbsp; 📋 *Protocol* (deep entry, *Myne-divergent*)

The literal string `"myne.v0.1 "` (with trailing space) used as the prefix for HKDF context strings in §3.2 of the protocol. Distinct from the AAD prefix `"myne.v0.1|"` (with trailing pipe, no space) used in AAD construction in §5.2. The two prefixes are deliberately non-identical because they live in different cryptographic call sites — context strings feed `info` to HKDF-Expand, while AAD bytes feed Poly1305 MAC and the CTX outer hash. Mistakenly using one for the other is a protocol violation. v005 strings will use `"myne.v005 "` and `"myne.v005|"` respectively.

Used in: `spec/protocol.md` §3.2, §5.2, §10.3

### **MYA1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 [attachment](#attachment) blob (`spec/protocol.md` §9.9). Part of the v0.1 magic family; registered in §10.3's magic-allocation table with its v005-reserved sibling `MYA5`. An `MYA1` blob reuses the `.myn` three-level wrap (per-attachment key under `itemsKey`), single-shot AEAD, 64 MiB cap. Implementations MUST reject any candidate attachment blob whose first four bytes are not `MYA1`.

### **MYC1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying the v0.1 [`vault.attachments`](#vaultattachments) catalog blob (`spec/protocol.md` §9.10), the authoritative per-attachment metadata store. A `MYP1`-style 34-byte envelope over canonical JSON; KEK `DeriveSubkey(root_key, "attachments-catalog-key")`. Registered in §10.3 with its v005-reserved sibling `MYC5`. The "C" is for *catalog* — chosen after the initial `MYI1` proposal collided with the already-reserved VaultIndices magic (`decisions.md` 2026-06-07).

### **MYI1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 [`vault.indices`](#vaultindices) blob (`spec/protocol.md` §9.8) — the encrypted-at-rest structured-metadata index (wikilink graph + tag index + title resolution + typed [property](#property) records). Parallel to `MYS1` (search) / `MYW1` (workspace) in the v0.1 magic-byte family; the structural twin of `MYS1` but a **distinct family** (one magic per family). The magic was **reserved by VaultIndices since 2026-06-07 (MYND-31)** — which is why the attachments catalog took `MYC1` after its initial `MYI1` proposal collided — and the blob spec landed with MYND-271. Registered in §10.3 alongside its v005-reserved sibling `MYI5`. Implementations MUST reject any candidate `vault.indices` whose first four bytes do not match `MYI1` — and [fall to rebuild](#fall-to-rebuild) rather than treating the rejection as data loss.

### **MYP1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 `vault.prefs` blob. Parallel to `MY01` (per-note) and `MYV1` (vault metadata) in the v0.1 magic-byte family. Registered in `spec/protocol.md` §10.3's major-version registry alongside its v005-reserved sibling `MYP5`. Implementations MUST reject any candidate `vault.prefs` whose first four bytes do not match `MYP1`.

Used in: `spec/protocol.md` §9.5, §10.3

### **MYS1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 `vault.search` (search-index) blob. Parallel to `MY01` (per-note), `MYV1` (vault metadata), and `MYP1` (preferences) in the v0.1 magic-byte family. Registered in `spec/protocol.md` §10.3's major-version registry alongside its v005-reserved sibling `MYS5`. Implementations MUST reject any candidate `vault.search` whose first four bytes do not match `MYS1` — and [fall to rebuild](#fall-to-rebuild) rather than treating the rejection as data loss.

Used in: `spec/protocol.md` §9.6, §10.3

### **MYW1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 `vault.workspace` ([workspace-state blob](#workspace-state-blob)). Parallel to `MY01` (per-note), `MYV1` (vault metadata), `MYP1` (preferences), and `MYS1` (search) in the v0.1 magic-byte family. Registered in `spec/protocol.md` §10.3's major-version registry alongside its v005-reserved sibling `MYW5`. Implementations MUST reject any candidate `vault.workspace` whose first four bytes do not match `MYW1` — and fall back to the default (single empty pane) workspace rather than treating the rejection as data loss.

Used in: `spec/protocol.md` §9.7, §10.3

### **`.myn` file** &nbsp; 📦 *Product*

Myne Note: the binary encrypted blob holding a single note. File extension `.myn`, magic bytes `MY01` for v0.1. Layout in `spec/protocol.md` §9.2: header, items_key_id, item_key_nonce, length-prefixed `enc_item_key`, content_nonce, length-prefixed ciphertext + CTX tag.

Used in: `spec/protocol.md` §9.1, §9.2

### **OPAQUE** &nbsp; 🏗️ *Construction*

The aPAKE protocol standardized as RFC 9807 (March 2025). Server stores no offline-brute-forceable password verifier. Myne's `appname-v005` roadmap canonicalizes OPAQUE for sync-server authentication. Phase 2 will choose between OPAQUE and a simple-verifier alternative; the choice is documented in `spec/protocol.md` §11.1 with criteria for resolution.

Used in: `spec/protocol.md` §11.1
Reference: RFC 9807.

### **optimistic UI rollback** &nbsp; 📦 *Product*

The UI pattern where a state change (sidebar row appended, removed, title overwritten) is applied to the local React cache **before** the underlying Tauri IPC call resolves, giving the user instant feedback. On IPC rejection (disk full, vault locked mid-save, structural error) the change is reverted from the cache and the user is informed via a non-blocking error toast. Myne uses optimistic UI rollback in three sidebar paths per `decisions.md` 2026-05-15 "Save-handler discipline": `createNote` (row appended optimistically), `deleteNote` (row removed optimistically), `renameNote` (title overwritten optimistically). `saveNote` (autosave) is **not** optimistic — body autosave doesn't typically alter the sidebar's title row, and the BottomBar save-status indicator (`SaveStatus` component, `Saving…` → `Saved · 2s ago` / `Save failed · Retry`) provides feedback without preempting the IPC. The pattern requires a paired rollback discipline at every optimistic call site; an IPC-rejected optimistic action that doesn't rollback is a UX-state-corruption bug.

Used in: `decisions.md` 2026-05-15; MYND-82

### **orphan vault artefact** &nbsp; 📋 *Protocol*

A residual file under `<app_data_dir>/vault/` that survives a partial-fail `vault_delete` — most often an orphan `.myn` blob (plus its containing `notes/` + `vault/` directories) left when `vault.meta` was unlinked successfully but a later unlink hit a file lock (antivirus / Spotlight / OneDrive sync), or a `vault.meta.tmp` / `vault.prefs.tmp` mid-write tempfile from an interrupted `atomic_write`. Once `vault.meta` is gone the artefacts are computationally-unrecoverable junk (the `items_key` that sealed each `.myn` left with it), yet they block a fresh `vault_create` (the `vault_artifacts_present` guard) and cannot be removed by `vault_delete` (which rejects `VaultNotFound` when `vault.meta` is absent). In-app cleanup is the v0.2 `vault_repair` feature, which sweeps everything under `vault_dir` while leaving the create-able container (Plane MYND-159; `decisions.md` 2026-06-06 "vault_repair v0.2"). *Alias: vault residue.*

Used in: `decisions.md` 2026-05-26 "vault_delete partial-fail posture", 2026-06-06 "vault_repair v0.2"; MYND-105, MYND-159

### **partitioning oracle** &nbsp; ⚠️ *Threat*

An attack class against non-key-committing AEAD where an attacker constructs a single ciphertext that decrypts validly under multiple keys (Len–Grubbs–Ristenpart, USENIX Security 2021). With a partial-decrypt oracle, this enables binary-search-style brute-force across a password dictionary, dramatically faster than naive offline attack. Myne's CTX commitment construction (§5.1) closes this attack vector.

Used in: `spec/protocol.md` §5.1
Reference: Len, Grubbs, Ristenpart, "Partitioning Oracle Attacks", USENIX Security 2021.

### **password_wrap_key** &nbsp; 🗝️ *Key/identifier*

The 32-byte key derived from the master password via Argon2id with `salt_password`. Encrypts one of the two copies of `root_key` in `vault.meta` (`enc_root_key_password`).

Used in: `spec/protocol.md` §3.1

### **PBKDF2** &nbsp; 🔐 *Primitive*

Password-Based Key Derivation Function 2. **Not used by Myne** — referenced only as a baseline that Myne explicitly avoids (BIP-39's standard 2048-iteration PBKDF2-HMAC-SHA512 is too weak by 2026 standards; the recovery phrase is fed to Argon2id directly instead).

Used in: `spec/protocol.md` §7.1
Reference: RFC 8018.

### **Personal dictionary** &nbsp; 📦 *Product*

The user's own set of words the spell checker treats as correctly spelled
(MYND-266) — names, project terms, coined words. AS3-Sensitive vocabulary,
stored encrypted in the per-vault `vault.dictionary` blob (`MYD1`, §9.13),
hydrated into RAM on unlock and zeroized on lock. "Add to dictionary" in the
correction menu appends to it. Matching is case-insensitive (folded); storage is
exact NFC. Distinct from the **Ignore list** (which suppresses without asserting
correctness) and from the bundled read-only language dictionaries.

Used in: `spec/protocol.md` §9.13; MYND-266.

### **Phase 1, Phase 2, Phase 3, Phase 4** &nbsp; 📦 *Product*

Myne's product phasing. See `vision.md` Phase 1 Scope and `decisions.md` for definitions and timelines. Roughly: P1 = single-user desktop local-only; P2 = sync server + optional web client; P3 = mobile clients + full web client; P4 = sharing + real-time collaboration + plugin API.

Used in: `vision.md`, `decisions.md`

### **plausibly-deniable encryption** &nbsp; ⚠️ *Threat*

Encryption schemes (e.g., VeraCrypt's hidden volumes) where a vault can be opened to multiple distinct plaintexts depending on which password is supplied, providing deniability under coercion. Myne v0.1 does not implement plausibly-deniable encryption; coercion (A12) is explicitly out of scope. v005 may revisit but only with caution — partial deniability schemes are easy to misimplement and easy to claim falsely.

Used in: `threat-model.md` §5, §7

### **Poly1305** &nbsp; 🔐 *Primitive*

The one-time MAC algorithm by Daniel J. Bernstein, used as the authenticator inside ChaCha20-Poly1305 and XChaCha20-Poly1305. In Myne's CTX-wrapped construction the 16-byte Poly1305 tag T is recomputed at decrypt time from `(K, N, AAD, ciphertext)` rather than stored on disk; only the 32-byte CTX commitment tag T' is persisted.

Used in: `spec/protocol.md` §5.1

### **quick-unlock credential** &nbsp; 🗝️ *Key/identifier*

A [device-local credential](#device-local-credential) (`vault.quickunlock`, `spec/protocol.md` §9.14, magic `MYQ1`) that holds a **third wrapped copy of `root_key`** so a re-lock (auto-lock-on-idle) can be reversed with a fast second credential — Touch ID / Windows Hello, or a PIN — instead of the full master-password Argon2id path. It wraps the already-derived `root_key`; it never participates in `root_key` derivation, so it does not touch the zero-knowledge root (the master password stays the primary credential). Its wrap key comes from a [wrap-key provider](#wrap-key-provider), not a `DeriveSubkey` role. Threat class: an **A6** convenience gate over the already-encrypted store; it does **not** defend against **A7** (active local malware), and the PIN provider's blob is offline-brute-forceable by **A4** bounded only by Argon2id cost. Introduced MYND-329.

Used in: `spec/protocol.md` §9.14, `decisions.md` 2026-06-16

### **wrap-key provider** &nbsp; 🗝️ *Key/identifier*

The pluggable source of the 32-byte symmetric wrap key that protects the [quick-unlock credential](#quick-unlock-credential) blob. The on-disk blob is provider-agnostic — always `AEAD(wrap_key, root_key)` — and only the wrap-key source differs: a macOS Keychain secret gated by `kSecAccessControlBiometryCurrentSet` (biometric), a future Windows Hello / TPM challenge-response, or a PIN run through the vault's Argon2id parameters. Modeled as a single Rust trait (`QuickUnlockProvider`); adding a provider is not an on-disk-format change. The biometric provider is hardware-bound and OS-invalidated on biometric-set change; the PIN provider's strength is bounded by PIN entropy × the memory-hard Argon2id cost.

Used in: `spec/protocol.md` §9.14.2

### **post-compromise security** &nbsp; ⚠️ *Threat*

The property that protocol participants can recover from a compromise of state — future communication remains protected even after a transient compromise. Provided by ratchet-style protocols (Signal Double Ratchet, MLS); not provided by Myne v0.1's static key hierarchy. A `appname-v005` design goal.

Used in: `threat-model.md` §7

### **post-quantum cryptography** &nbsp; 🔐 *Primitive*

Cryptographic primitives believed secure against quantum-computing attacks. Myne v0.1 is not post-quantum. The `appname-v005` roadmap introduces hybrid X25519 + ML-KEM-768 (FIPS 203) for KEM operations and Ed25519 + ML-DSA-65 (FIPS 204) for signatures.

Used in: `e2ee-notes-evaluation.md`; `spec/protocol.md` §11

### **PQXDH (Post-Quantum Extended Triple Diffie-Hellman)** &nbsp; 🏗️ *Construction*

Signal's post-quantum-augmented X3DH key-agreement protocol, with hybrid X25519 + ML-KEM-768. Reference design pattern for Myne's `appname-v005` user-to-user key agreement (sharing).

Used in: `spec/protocol.md` §11 (out of scope for v0.1)

### **prefs_key** &nbsp; 🗝️ *Key/identifier*

The 32-byte AEAD KEK encrypting `vault.prefs`. Derived deterministically from `root_key` via the canonical `DeriveSubkey(root_key, "prefs-key")` helper (`spec/protocol.md` §3.2 + §3.4 registry entry `"myne.v0.1 prefs-key"`). Never persisted; re-derived on each `vault_unlock` (in-pipeline) and on each `set_*` prefs writer call. Independent from `items_key` lineage by design — preserves prefs portability across the v005 epoch-rotation `items_key` evolution (`decisions.md` 2026-05-27 "Vault preferences blob: root_key-derived prefs_key").

Used in: `spec/protocol.md` §3.4, §9.5; `decisions.md` 2026-05-27 "Vault preferences blob"

### **PrefsView** &nbsp; 🛠️ *Tooling*

Rust struct (and matching TypeScript IPC payload type) shape of the decrypted `vault.prefs` plaintext. Defines the v0.1 preference fields — `screen_capture_protection: bool` (MYND-160), `deliberate_folders` (set array, MYND-144), `auto_lock_seconds` (optional integer, MYND-121), `editor_layout` (optional nested object, MYND-137), the unified manual sidebar sequence [`item_order`](#item-order) (MYND-183, superseding the earlier `note_order` / `folder_order` pair), [`favorites`](#favorites) (MYND-183) — the latter two ordered string arrays whose element order is preserved verbatim — and the [theme preference](#theme-preference) `theme` (optional `"light"`/`"dark"`, absent ≡ system, MYND-110) — plus the `Default` impl that drives the fall-back-to-defaults semantic on absence / AEAD-fail / parse-fail (`spec/protocol.md` §9.5.5). Serialized via canonical JSON (sorted keys, no whitespace, NFC strings, no floats; set arrays sorted+deduped, sequence arrays order-preserved) before AEAD encryption — drift-detected by the `myne-test-vectors` byte-stable KAT vectors.

Used in: `src-tauri/src/plugins/prefs/`; `protocol/src/prefs.rs`; `spec/protocol.md` §9.5

### **property** &nbsp; 📦 *Product*

A typed `key → value` pair derived from a note's YAML [frontmatter](#frontmatter) body by the Saved Views property-index (MYND-271). Every arbitrary frontmatter key is read and coerced to exactly one Myne type — `string` / `number` / `date` / `list` / `checkbox` — by the canonical value-typing ruleset (`spec/markdown-dialect.md` §3.6.4); the property-index is the **single type authority** for the Saved Views epic (sibling features consume its typing, never redefine it). Tags (`#tag` ∪ frontmatter `tags:`) and the `folder:` value are queryable alongside properties as pseudo-properties. The parse is read-only and non-mutating (the `.myn` file stays source of truth); the typed values live in the derived [vault.indices](#vaultindices) / `MYI1` cache. A [saved view](#saved-view) filters and sorts on properties.

Used in: `spec/markdown-dialect.md` §3.6, §3.6.4 (MYND-271)

### **protocol identifier** &nbsp; 📋 *Protocol*

The string `"myne-protocol-v0.1"` that names this specification. Distinct from the protocol version *byte* (`0x01`), the AAD prefix (`"myne.v0.1|"`), and the context-string prefix (`"myne.v0.1 "`). All four reference the same major version but appear in different call sites.

Used in: `spec/protocol.md` §1.3

### **protocol version** &nbsp; 📋 *Protocol*

The single-byte field at offset 4 of every Myne on-disk file (per-note `.myn` and `vault.meta`). v0.1 = `0x01`. Bound into the AAD of every AEAD operation so that any version downgrade fails the tag check.

Used in: `spec/protocol.md` §1.3, §10

### **React** &nbsp; 🛠️ *Tooling*

The UI library used for the Phase 1 desktop client UI inside the Tauri WebView, and the planned UI library for the Phase 3 web and mobile clients (the latter via React Native). React 19 with TypeScript per the scaffold. Chosen for the maturity of its CodeMirror 6 (`@uiw/react-codemirror`) integration — the largest UI dependency in the Phase 1 scope. (The graph view uses [d3-force](#d3-force) for layout with a hand-rolled canvas renderer rather than a React graph wrapper, so it adds no React-specific UI dependency — superseding the earlier `react-cytoscapejs` plan, `decisions.md` 2026-06-08.) Shared React components are anticipated to live in a future `packages/ui/` workspace member when Phase 3 web work begins, decoupling the desktop UI bundler from the web bundler.

Used in: `decisions.md`; `threat-model.md` §7
Reference: https://react.dev

### **Recovering** (slot state) &nbsp; 📦 *Product*

The intermediate variant of the [`Slot`] enum representing a vault that has successfully completed phrase-based recovery (`vault_recover_with_phrase`) but has not yet committed a new master password (`vault_complete_recovery`). Carries `root_key`, `items_key`, `items_key_id`, and `recovered_at: Instant` in `Zeroizing` wrappers — both keys are derived eagerly during the recovery step so the entire credential chain is verified before the slot transitions. Editor commands cannot pattern-match `Slot::Recovering` and are therefore structurally denied access during this window per `recovery-flow.md` §4.1's non-dismissible chained step. The only legal transitions out are `Slot::Recovering → Slot::Unlocked` (via `vault_complete_recovery` success) or `Slot::Recovering → Slot::Empty` (via `vault_lock` — the §4.3 within-session bail case).

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization"

### **recovery phrase** &nbsp; 🗝️ *Key/identifier* (deep entry)

The 24-word BIP-39-encoded representation of 256 bits of secret entropy plus an 8-bit checksum, used as Myne's secondary credential for vault unlock. Generated at vault creation from OS CSPRNG output, presented to the user with a forced-confirmation flow before vault creation completes (`spec/protocol.md` §7.2; full UX in `spec/recovery-flow.md` §2). The phrase string, after NFKD normalization, is fed directly to Argon2id with `salt_recovery` to derive `recovery_wrap_key`. **Myne does not use BIP-39's standard PBKDF2-HMAC-SHA512 derivation** — that step is replaced by Argon2id with the same parameters as the password path. The phrase is never sent to any server. If the user loses both the phrase and the master password, the vault is permanently unrecoverable; this is a hard architectural commitment.

Used in: `spec/protocol.md` §7, `spec/recovery-flow.md`

### **recovery_wrap_key** &nbsp; 🗝️ *Key/identifier*

The 32-byte key derived from the recovery phrase via Argon2id with `salt_recovery`. Encrypts the second of the two copies of `root_key` in `vault.meta` (`enc_root_key_recovery`).

Used in: `spec/protocol.md` §3.1, §7

### **reference link** &nbsp; 📦 *Product*

A CommonMark link that names a [link reference definition](#link-reference-definition) instead of carrying its URL inline: full `[text][label]`, collapsed `[text][]` (label = the text), or shortcut `[label]`. Myne v0.1 recognizes and **renders** reference links — a usage whose label resolves against a definition shows its visible text as a link and its definition line hides off-cursor — while a dangling reference (no matching definition) stays plain text. Rendering is cursor-aware and byte-preserving (§6 C1); the canonical emit form for new links is the inline `[text](url)`, so reference links are recognized and rendered but **never emitted**. Distinguished from an inline link by the parse tree (a reference link has a `LinkLabel` child or no `URL`); resolution uses the shared collector, since the parser alone emits a node even for a broken full reference. See also [link reference definition](#link-reference-definition), [decoration layer](#decoration-layer).

Used in: `spec/markdown-dialect.md` §3.2, §5; `decisions.md` 2026-05-30

### **rename journal** &nbsp; 📋 *Protocol*

The empty `.rename-journal` marker file in a vault's notes directory that makes a [wikilink](#wikilink)-rename's multi-note rewrite **all-or-nothing**. A title rename rewrites the renamed note's own `.myn` blob plus every inbound `[[…]]`-bearing note; because a single per-blob atomic write is not collectively atomic across N blobs, the writer stages every updated blob to `<uuid>.myn.tmp`, writes the (content-free) marker, then commits every rename, then clears the marker. On the next vault-open — before the resolution index rebuilds — recovery rolls **forward** (marker present ⇒ rename all staged `.tmp` into place) or **back** (marker absent ⇒ delete orphan `.tmp`), so a crash mid-commit never leaves a half-renamed vault with broken title-keyed links. The marker carries no data (no UUIDs, no titles), is not a magic-byte format, and is excluded from backups; rolled-forward blobs are still AEAD/CTX-verified on read, so it adds no tamper surface. See also [wikilink](#wikilink), [wikilink chip](#wikilink-chip).

Used in: `spec/protocol.md` §9.12, §9.11.3; `decisions.md` 2026-06-13

### **reproducible builds** &nbsp; 🛠️ *Tooling*

Build artifacts that can be regenerated bit-for-bit from public source code by independent third parties. Myne commits to reproducible builds for desktop (Tauri), web, and server binaries — feasible in months for Tauri (vs. ~10 person-years for Chromium-based Electron). Part of the compensating-controls plan in lieu of a paid third-party audit.

Used in: `threat-model.md` §6
Reference: https://reproducible-builds.org

### **restore (from backup)** &nbsp; 📦 *Product*

Recreating a vault from a [vault backup file](#vault-backup-file): the file is validated credential-free (container structure + per-member SHA-256 + structural parse of the embedded `vault.meta`), staged into a discovery-invisible directory, then committed atomically as a fresh `vaults/<id>/` (new `VaultId` minted; the backup carries none). The restored vault starts locked and unlocks with the master password **or** the recovery phrase, exactly like the original — both credential wraps travel inside the copied `vault.meta`. Identity collisions (same `account_number_hash` already on disk) surface a user choice: keep both side-by-side, or replace the existing vault only after the restore has fully succeeded. Default handling of a damaged backup is all-or-nothing rejection; an explicit salvage mode restores intact members with an honest skipped-list summary. Restoring an old backup is a whole-vault replay — see `threat-model.md` §7.

Used in: `spec/protocol.md` §9.11; `threat-model.md` §7; `decisions.md` 2026-06-10

### **root_key** &nbsp; 🗝️ *Key/identifier* (deep entry)

The cryptographic core of a Myne vault. A 32-byte random value generated by the OS CSPRNG at vault creation. **Not derived from the password** — instead, two copies are stored on disk encrypted under independent wrap keys (`password_wrap_key` and `recovery_wrap_key`), per the dual-credential wrap pattern. Held in client memory only between unlock and lock; zeroized on lock or process exit. Every Myne subkey (the `server-auth` reservation, the active `itemsKey_wrap_key`, the `backup-key` reservation) is derived from `root_key` via the `derive_key` helper. The architecture is essential to recovery — if `root_key` were a function of the password, losing the password would unconditionally destroy the vault.

Used in: `spec/protocol.md` §3.1

### **RustCrypto** &nbsp; 🛠️ *Tooling*

A collection of pure-Rust cryptographic crates (`hkdf`, `chacha20poly1305`, `argon2`, `ml-kem`, `ml-dsa`, etc.). Myne uses RustCrypto as a fallback when libsodium bindings prove inadequate, but libsodium remains the canonical reference. The `ml-kem` and `ml-dsa` crates are the likely Rust path for v005's post-quantum primitives.

Used in: `spec/protocol.md` §2.2

### **salt** &nbsp; 📋 *Protocol*

A non-secret, per-vault random value mixed into KDF input to prevent precomputation attacks across accounts and time. Myne constructs two distinct 16-byte salts — `salt_password` and `salt_recovery` — each from a SHA-256 of `(domain prefix || account_number_hash || random_16_bytes)`, with the random component generated once at vault creation and stored in `vault.meta`.

Used in: `spec/protocol.md` §3.1

### **saved view** &nbsp; 📦 *Product*

A named, **read-only** derived view over a vault's own plain-markdown notes (Saved Views epic, MYND-271) — a filter (over [properties](#property), tags, folders) + a sort + an optional `groupBy`, rendered as one of a closed set of [view types](#view-type). The Obsidian-Bases analogue, deliberately narrowed: **no database, no formula/code-eval** — only a declarative, closed-allow-list query (the query-engine sub-feature) over the derived property index. The view *definition* is authored content persisted in `vault.prefs` / `MYP1` (not the index blob); the data it queries lives in the rebuildable [vault.indices](#vaultindices) / `MYI1` cache. Because it is read-only over plain markdown with `.myn` as the source of truth, it does **not** violate the `vision.md` "no databases" / "no proprietary format" anti-features (same precedent class as the [search index](#search-index)); see `decisions.md` 2026-06-14 "Saved Views is a read-only derived projection over plain markdown, not a database". The [filter AST](#filter-ast) is created and edited through the **filter builder** UI — single-level filter groups over tag / folder / search conditions, a deliberate representable subset of the AST's full nesting (MYND-282).

Used in: Saved Views (MYND-271, MYND-282); `decisions.md` 2026-06-14

### **screen-capture protection** &nbsp; 📦 *Product*

Best-effort native window exclusion preventing OS screen-recording and screenshot APIs from capturing Myne content. Applied at app startup via Tauri's `set_content_protected` (macOS `NSWindowSharingNone`, Windows `WDA_EXCLUDEFROMCAPTURE`). Platform support: macOS (all Tauri-supported versions), Windows 10 build 19041+. Unavailable on Linux v0.1.

Used in: `threat-model.md` §6, §7

### **search index** &nbsp; 📦 *Product*

Myne's full-text search over note content (MYND-29). A custom in-memory **BM25 inverted index** (AND-of-terms with a last-term prefix match for type-ahead, plus a title-boost) built from decrypted note plaintext while the vault is unlocked, queried in RAM, and persisted as the encrypted `vault.search` blob. Index-side, each note's language is detected (whatlang, EN/TR/DE) and single-stemmed (the raw token is always indexed too); query-side, terms are multi-stemmed across all supported languages (the query is too short to detect a language) — a deliberate index/query asymmetry. The index is **plaintext-derived RAM**, as sensitive as the open notes: zeroized on lock (`threat-model.md` A6), and never the source of truth (the `.myn` files are). Engine choice sits behind a swappable trait; the MYND-29 benchmark (`decisions.md` 2026-05-31) selected the custom engine over tantivy on the budget table. See also [search-index-key](#search-index-key), [fall-to-rebuild](#fall-to-rebuild).

Used in: `spec/protocol.md` §9.6; `decisions.md` 2026-05-31

### **search-index-key** &nbsp; 🗝️ *Key/identifier*

The 32-byte AEAD KEK encrypting `vault.search`. Derived deterministically from `root_key` via the canonical `DeriveSubkey(root_key, "search-index-key")` helper (`spec/protocol.md` §3.4 registry entry `"myne.v0.1 search-index-key"`). Never persisted; re-derived on each unlock (to load / reconcile the index) and on each persist (graceful lock / periodic flush). Independent from the `itemsKey` lineage by design — like `prefs_key` it derives straight from `root_key`, so it survives the v005 epoch-rotation `itemsKey` evolution. The AAD `AAD_search_index_blob` (role `"search-index-blob"`, `spec/protocol.md` §5.2) binds the blob to its vault via `account_number_hash`.

Used in: `spec/protocol.md` §3.4, §5.2, §9.6

### **session-state-key** &nbsp; 🗝️ *Key/identifier*

The 32-byte AEAD KEK encrypting `vault.workspace` (the [workspace-state blob](#workspace-state-blob)). Derived deterministically from `root_key` via the canonical `DeriveSubkey(root_key, "session-state-key")` helper (`spec/protocol.md` §3.4 registry entry `"myne.v0.1 session-state-key"`). Never persisted; re-derived on each unlock (to restore the workspace) and on each graceful-exit persist. Independent from the `itemsKey` lineage by design — like `prefs_key` / `search-index-key` it derives straight from `root_key`, so it survives the v005 epoch-rotation `itemsKey` evolution. The AAD `AAD_workspace_blob` (role `"workspace-blob"`, `spec/protocol.md` §9.7.3) binds the blob to its vault via `account_number_hash`.

Used in: `spec/protocol.md` §3.4, §9.7

### **workspace-state blob** &nbsp; 📦 *Product*

The encrypted `vault.workspace` artifact (`MYW1`, `spec/protocol.md` §9.7) carrying the editor's **workspace state** — the open-tab set per pane, the recursive pane-split layout, each pane's active tab, the focused pane, and per-tab cursor/scroll positions (MYND-166). AS3-Sensitive (note ids + structure): persisting *which notes are open* is activity metadata, so it rides inside the AEAD envelope under [session-state-key](#session-state-key) rather than as plaintext local state. Written **only on graceful exit** (manual lock / idle auto-lock grace / quit) — never per tab-switch — so the blob's mtime stays a low-resolution lock/quit signal and never becomes an editor-activity log (a filesystem adversary A4/A7 learns nothing about *which* notes are open or *when* they were switched). Best-effort, not crash-durable; a missing / tampered / malformed blob falls back to a single empty pane (§9.7.4). The inner descriptor is client-opaque to the protocol layer, like the [search index](#search-index).

### **selection toolbar** &nbsp; 📦 *Product*

The floating UI surface that appears above an active text selection in the Phase 1 editor, exposing format actions (bold / italic / strikethrough / inline-code / link / heading dropdown). Positioning uses the shared `src/editor/positioning.ts` helper — `getBoundingClientRect` + viewport-edge clamp + flip-below-when-no-room-above. The 🔗 (link) button opens an **inline URL overlay** adjacent to the selection rather than a `window.prompt()` or modal, matching `PRODUCT.md`'s "modals not as first reach for interaction" anti-pattern. Implemented as a CodeMirror 6 `ViewPlugin` that mounts/unmounts the toolbar React subtree based on selection state; absent when the selection is empty.

Used in: `agent-tooling/features/editor-mvp-baseline/prd.md`, `agent-tooling/sessions/grill/2026-05-16-mynd-36-editor-inner-scope.md` Q4 + Q8

### **self-host** &nbsp; 📦 *Product*

User-operated deployment of the Myne sync server. First-class in the product plan: same protocol, same security properties as hosted sync. The protocol treats hosted and self-hosted servers as identical trust boundaries (TB5) — the operator does not see plaintext in either case.

Used in: `vision.md`, `threat-model.md` §3

### **server-auth subkey** &nbsp; 🗝️ *Key/identifier*

A subkey derived from `root_key` via `derive_key(root_key, "myne.v0.1 server-auth")`. **Reserved, not used in v0.1.** The exact protocol-level role (simple verifier transmission vs OPAQUE `export_key` integration) is deferred to Phase 2; see `spec/protocol.md` §11.1.

Used in: `spec/protocol.md` §3.4, §11.1

### **serverPassword** &nbsp; 🗝️ *Key/identifier*

A generic term referring to whatever value is sent to the sync server for authentication in Phase 2. The concrete form is one of the two options in §11.1 — a deferred decision. v0.1 defines no transmitted server credential.

Used in: `spec/protocol.md` §1.1, §11.1

### **session token** &nbsp; 🗝️ *Key/identifier*

An opaque UUIDv4 identifying an in-flight vault-creation session held in the Tauri-managed `VaultCreationState` map between the `begin` and `commit` IPC calls. The session token is **not a secret** — it is a bearer reference to the session row, which contains the actual secret material (`root_key`, password and recovery wrap keys, recovery phrase, account number). Sessions live at most 10 minutes (`SESSION_TTL_SECS`); evicted tokens are tombstoned for up to 1 hour so a subsequent `commit` returns `SessionExpired` instead of the generic `SessionNotFound`.

Used in: `decisions.md` 2026-04-28 "Vault creation flow: backend session pattern", "Vault creation session TTL"

### **SHA-256** &nbsp; 🔐 *Primitive*

The 256-bit Secure Hash Algorithm 2 (FIPS 180-4). Used in Myne for: salt construction (§3.1), the CTX commitment outer hash (§5.1), the account-number hash (§8), and HMAC underlying HKDF-SHA-256 (§3.2).

Used in: `spec/protocol.md` §3.1, §5.1, §8.3, §3.2
Reference: FIPS 180-4.

### **SHA-512** &nbsp; 🔐 *Primitive*

The 512-bit Secure Hash Algorithm 2. **Not used by Myne** — referenced only when explaining the standard BIP-39 derivation (PBKDF2-HMAC-SHA512) that Myne explicitly avoids.

Used in: `spec/protocol.md` §7.1

### **slash command** &nbsp; 📦 *Product*

The keystroke-driven menu of insertable elements in the Phase 1 editor, triggered by typing `/` (suppressed inside fenced code block ranges, inline link URL portions, and wikilink ranges so `/` remains content in those contexts). The menu is a fuzzy-match floating list — type `/h1`, `/h`, or `/heading 1` to surface H1; Enter applies, Esc dismisses. `editor-mvp-baseline` ships 11 commands: `/h1`-`/h6`, `/quote`, `/divider`, `/link`, `/bullet`, `/numbered`, `/todo`. **`/wiki` is explicitly excluded** from the baseline set — it ships in `editor-mvp-wikilinks` alongside the autocomplete picker, because the menu should only surface element kinds the editor authoring layer can actually deliver. `/table`, `/code`, `/footnote`, `/callout` ship in their owning sub-feature PRDs.

Used in: `agent-tooling/features/editor-mvp-baseline/prd.md`, `agent-tooling/sessions/grill/2026-05-16-mynd-36-editor-inner-scope.md` Q2

### **sidebar batch refresh** &nbsp; 📦 *Product*

The Notes sidebar's hybrid refresh strategy pinned in `decisions.md` 2026-05-15: **initial-boot chunked Promise.all** (on Editor mount, call `note_list` → split returned IDs into ≤100-ID chunks per `note_titles_batch`'s `BatchTooLarge` cap → fire all chunks via `Promise.all` → populate the `Map<NoteId, TitleRecord>` cache) **plus action-driven surgical `refreshOne(id)`** (after every successful `saveNote / renameNote / createNote / deleteNote`, call `note_titles_batch([id])` for that single ID and update the matching cache entry). The pattern is event-driven, not poll-based — no periodic background re-fetch, no broadcast-channel listener. Backend events (Tauri `emit("note_updated", ...)`) were explicitly rejected for Phase 1 as premature complexity in a single-window scenario; a future multi-window Myne adopts them by replacing `refreshOne` call sites with event handlers (same function, different trigger). Pairs with `optimistic UI rollback` for instant-feedback paths.

Used in: `decisions.md` 2026-05-15; MYND-82

### **Slot** &nbsp; 📦 *Product*

The three-state enum that holds a vault's auth state inside `VaultRuntimeState`'s `RwLock<HashMap<VaultId, Slot>>` — one entry per vault, keyed by [VaultId](#vaultid) (an absent key IS the `Empty` case; no `Empty` entries are stored). Variants: `Slot::Empty` (no vault open), `Slot::Recovering { ... }` (post-recovery / pre-password-commit), `Slot::Unlocked(UnlockedVault)` (full editor access). Editor commands match only `Slot::Unlocked(uv) => ...`; the `Slot::Recovering` and `Slot::Empty` variants are structurally rejected at compile time (per entry). The shape is the type-system realization of `recovery-flow.md` §4.1 + §4.3's "no soft-unlocked session" guarantee — security lives in the type, not in UI discipline. Multi-vault made the storage a `HashMap<VaultId, Slot>` (the singleton→map type-swap landed 2026-06-09) under the **≤1-`Unlocked` invariant**: at most one entry is ever `Unlocked` — the **active vault** is that sole `Unlocked` entry (no separate pointer), and unlocking a second vault first locks the current one. `auth_permits` stays a single global capacity-1 semaphore (one Argon2id auth op in flight client-wide, never per-vault). The per-entry lifecycle reasoning carries forward unchanged.

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization", 2026-06-09 "Runtime multi-slot core"

### **SlotKind** &nbsp; 📋 *Protocol*

The discriminator for the [`Slot`] enum, exposed across the IPC boundary by the `vault_status` Tauri command. Three variants: `Empty | Recovering | Unlocked`. Serde-Serialize encoding is the bare variant name (no `#[serde(tag)]` wrapper), so the JSON payload on the wire is one of three bare strings — `"Empty"`, `"Recovering"`, `"Unlocked"`. The TypeScript hand-mirror at `src/types/slot-kind.ts` is therefore a string-literal union, not an object discriminator. Used by frontend boot-time and post-WebView-reload routing — never on the post-recovery happy path (the in-process `Slot::Recovering` → `Slot::Unlocked` transition uses the IPC `Ok(())` from `vault_complete_recovery` as the success signal; a defensive `vault_status` round-trip would be paranoia).

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization"

### **snapshot** &nbsp; 📦 *Product*

An encrypted previous version of a note, captured automatically as the note is edited so an accidental overwrite or bad edit can be recovered (the MYND-96 file-recovery feature — Myne's answer to Obsidian File Recovery). A snapshot is a **frozen [`.myn`](#myn-file) revision**: the prior note plaintext re-sealed under the note's own `item_key` in the `MY01` envelope (`spec/protocol.md` §9.2) — **no new magic byte, no new subkey role**. Snapshots live in a flat `<vault-root>/snapshots/` directory (§9.1), captured **time-coalesced** (≈ one per note per 5 min of active editing, plus on editor-close / vault-lock), retained for a **bounded window** (default ~7 days) with a safety backstop, and pruned eagerly. On **permanent** delete a note's snapshots are purged, preserving cryptographic erase; soft-[Trash](#trash) (an ordinary update, the note still exists) keeps snapshotting. Distinct from the unrelated `vault.prefs` *replay* sense ("restore prior valid `vault.prefs` snapshots") in `threat-model.md` §7. See also [`.myn` file](#myn-file), [Trash](#trash).

Used in: `spec/protocol.md` §9.1; `threat-model.md` §7; `decisions.md` 2026-06-08

### **state-level actor** &nbsp; ⚠️ *Threat*

Adversary class A10. Nation-state-class adversary with zero-day capabilities, supply-chain access, hardware-implant capability, and the legal power to compel operator cooperation. Myne's status against A10 is Best-effort: boring, well-vetted primitives plus a published spec, with no claim of defense against zero-days or hardware implants beyond what A2 covers.

Used in: `threat-model.md` §1 (A10)

### **stray attachment file** &nbsp; 📋 *Protocol*

An [`MYA1`](#mya1) blob present on disk at `attachments/<attachment-id-hex>` whose id is **absent from the [`vault.attachments`](#vaultattachments) catalog** — a crash remnant from a "clean unused attachments" sweep interrupted between its catalog rewrite and the blob unlinks (the catalog-first ordering deletes the entry first). The unlock-time reconcile unlinks stray files (canonical 64-char lowercase-hex names only), but **never** a cataloged id — including a zero-reference [unused attachment](#unused-attachment) awaiting the user's explicit sweep — and skips entirely if the catalog is present-but-undecodable (no mass-delete on corruption). Distinct from an *unused* attachment, which is cataloged and user-visible. (MYND-171; `decisions.md` 2026-06-13)

### **supply-chain compromise** &nbsp; ⚠️ *Threat*

Adversary class A8: a transitive dependency in npm, Cargo, or Go modules ships malicious code. Myne's mitigations are hash-pinned lockfiles, minimal direct-dependency surface, dependency-review at update time, and `cargo-vet`/`cargo-audit` in CI. Status: Best-effort — cannot fully defend against a determined attacker in the dependency graph, but the Tauri/Cargo dependency tree is materially smaller than Electron/npm would be.

Used in: `threat-model.md` §1 (A8), §7

### **tag browser** &nbsp; 📦 *Product*

The modal surface for browsing + filtering notes by tag (tag-system / MYND-46). A palette-style carve-out launched from the command palette (`tags.show`) + a BottomBar affordance: a search field + an All/Any (AND/OR) toggle, the vault's tags as clickable chips (the whole chip toggles selection into the filter), and the matching note list directly below. Filtering goes through the single `by_tag` path (subtree-inclusive, trash-excluded, AND = intersection / OR = union); results are recency-sorted. Read-only over the in-RAM [tag index](#tag-index) — selection state is ephemeral, no new at-rest artefact. Completes MYND-200's blocked interactive surface.

Used in: tag-system (MYND-46), [tag index](#tag-index)

### **tag chip** &nbsp; 📦 *Product*

The editor decoration that renders an inline `#tag` as a styled, clickable pill (tag-system / MYND-45). Purely visual — recognize-only / byte-stable (the underlying bytes are never rewritten, `spec/markdown-dialect.md` §3.7.7); cursor-aware (it reveals the raw text when the caret is inside, so a tag can be typed or edited). Clicking a chip opens the [tag browser](#tag-browser) filtered to that tag. Per SYNC-17 the chip ships ONLY together with the tag browser — never as a standalone editor-polish change (a clickable-looking tag with nowhere to go is a dead affordance). The same pill token styles both the editor chip and the browser's tag rows.

Used in: tag-system (MYND-45), `spec/markdown-dialect.md` §3.7.7

### **tag index** &nbsp; 📦 *Product*

The derived index of a vault's tags — inline `#tags` ∪ frontmatter `tags:` (source-agnostic union) — part of VaultIndices (MYND-31). Tags are folded to a canonical key (`foldSegment` = NFC + Unicode lowercase, the §3.7.8 tag-identity rule) on the TS side; the index stores the exact folded tag and derives a hierarchy by splitting nested `#a/b/c` on `/` (direct + subtree counts). `by_tag` is subtree-inclusive — a parent tag includes its descendants. The Rust index is trash-blind; trashed members are excluded TS-side via the `isTrashed` live-set.

Used in: VaultIndices (MYND-31), `spec/markdown-dialect.md` §3.7

### **Spell check** &nbsp; 📦 *Product*

Myne's offline spell checker (epic MYND-261): a Rust-core engine (the `spellbook`
Hunspell-format speller) flags misspelled words in the editor with a squiggle, and
a correction menu offers suggestions plus add-to-dictionary / ignore. Fully local
— bundled dictionaries, no network, no OS/cloud speller (note content is
AS3-Sensitive). A word is correct if valid in **any** active-language dictionary
(set-union, no per-note language detection) or in the **Personal dictionary**.
v0.1 bundles 23 languages (en-US + 22 verified-loadable, AGPL-compatible dicts);
Turkish is deferred (a spellbook flag-format incompatibility).

Used in: `spec/protocol.md` §9.13; MYND-261…267.

### **Suggestion (spell-check)** &nbsp; 📦 *Product*

A candidate correct spelling the [spell checker](#spell-check) offers for a misspelled word, produced by the `spellbook` speller and surfaced (capped at 5, SYNC-14) in the right-click correction menu. Choosing one applies a surgical, byte-stable range edit that replaces exactly the flagged word; it is a presentation affordance only — never an auto-correct, never mutating the buffer until the user picks one. Distinct from the **Personal dictionary** / **Ignore list** actions in the same menu (which change verdicts, not text).

Used in: MYND-265; `src/editor/spell/correction-menu.ts`.

### **Tauri** &nbsp; 🛠️ *Tooling*

A Rust-based framework for building cross-platform desktop applications with web-technology UIs. Myne's Phase 1 desktop-client framework (`decisions.md` Deferred #5 resolution). Supersedes the prior Electron baseline. Advantages: small TCB, ~10 MB binary vs ~150 MB Electron, ~40 MB idle RAM vs ~250 MB, achievable reproducible builds, structural memory hygiene via Rust's `zeroize`/`secrecy`/`subtle` crates, smaller updater attack surface.

Used in: `decisions.md`, `vision.md`, `threat-model.md` §3 TB7

### **syntax highlighting** &nbsp; 📦 *Product*
Language-aware token coloring of a fenced code block's contents inside the editor, applied as a presentation overlay over the live markdown source (never mutating it — notes stay plain markdown after decryption). Implemented via a nested Lezer parser + a code-only `HighlightStyle`; distinct from the cursor-aware *reveal* used for other markdown chrome (code is always colored, not hidden/revealed). Introduced MYND-154.
Used in: `src/editor/code-highlight.ts`, `design-notes.md` (2026-05-29).

### **syntax palette (`--syntax-*` tokens)** &nbsp; 📦 *Product*
The family of CSS design tokens (`--syntax-keyword`, `--syntax-string`, `--syntax-comment`, …) defining the syntax-highlighting colors, with a light and a dark value each. Every hue clears WCAG AA (≥4.5:1) contrast against the `--paper-2` code-card fill in both themes. The editor's code `HighlightStyle` maps Lezer code tags onto these tokens; no ad-hoc hex. Defined in the runtime `src/styles/tokens.css` (what the app loads) and mirrored in the canonical `docs/design/colors_and_type.css`. Introduced MYND-154.
Used in: `src/styles/tokens.css`, `docs/design/colors_and_type.css`, `src/editor/code-highlight.ts`.

### **template variable** &nbsp; 📦 *Product*

A `{{token}}` placeholder in a [note template](#note-template) body that the variable engine substitutes against a fixed built-in registry at note-creation time. The v1 registry is `{{date}}`, `{{time}}`, `{{title}}`, `{{datetime}}`, `{{weekday}}` (lowercase-only; unknown tokens are left literal, which doubles as the escape mechanism). Substitution is **deterministic, one-shot, eager** — parse → registry lookup → substitute, never an expression, formula, callback, or format-argument mini-language (the anti-plugin / no-scripting commitment, `vision.md`). The engine is inferred-not-declared: it scans the template body for tokens at fill time rather than reading a declared-variables field, and reads no clock or locale itself (the host injects the time-derived values). Output is plain markdown — a rendered token emits only literal text. See `spec/markdown-dialect.md` §3.6.1, the variable-engine module in `protocol/`, MYND-188.

Used in: `protocol/` variable engine (MYND-188); `spec/markdown-dialect.md` §3.6.1

### **test vector** &nbsp; 📋 *Protocol*

Cross-implementation byte-level fixture pinning an `input → expected-output` mapping for a specific Myne v0.1 protocol primitive. Lives in the `myne-test-vectors/` companion repository under `vectors/<category>/v0.1/cases.json`, validated against the canonical machine-readable contract at `schema/v0.1.json` (JSON Schema 2020-12, with `oneOf` dispatch on the top-level `schema` field to per-category sub-schemas in `schema/v0.1/<category>.json`). Each `cases[i]` entry carries a stable, immutable `vector_id` plus inputs (`input_<semantic>_<encoding>`) and expected outputs (`expected_<semantic>_<encoding>`) following a canonical naming convention; categories with multiple case shapes add a `case_kind` discriminator. v0.1 vectors live under the `v0.1/` directory dimension; future major-version vectors land alongside under `v005/` without ambiguity (the two versions are forward-incompatible by design). Vectors are the byte-level audit-substitute leg of `threat-model.md` §6 — alongside reproducible builds (TB8) and hash-pinned lockfiles (TB9 supply chain) — that compensates for the missing third-party cryptography audit at v0.1. A vector failure in any independent port (Phase 2 Go server, Phase 3 web / mobile clients) is a stop-the-world bug: either the port has drifted or the spec is wrong. Sometimes referred to as KAT (Known-Answer Test) vectors; the `vault.prefs`-related entries in this glossary use that older term — both name the same thing.

Used in: `myne-test-vectors/` (the companion repository carrying every landed `cases.json`), `protocol/tests/vectors.rs` (the integration test driving the live Rust impl against each landed category and asserting byte-equality), `threat-model.md` §6 (the audit-substitute discipline the vectors operationalize), `decisions.md` 2026-05-28 entry "Canonical test-vector schema + first new category (HKDF DeriveSubkey) landed (MYND-66 + MYND-67)" (the canonical schema mechanism), `prefs-blob` glossary entry (which mentions "byte-stable KAT vectors" — cross-reference for the older terminology).

### **threat model** &nbsp; ⚠️ *Threat*

The structured catalog of adversaries, assets, trust boundaries, and defensive posture that defines what Myne protects against and what it explicitly does not. The authoritative document is `threat-model.md`. Marketing copy must not exceed the guarantees there; that document is normative for what users may rely on.

Used in: `threat-model.md`

### **traffic analysis** &nbsp; ⚠️ *Threat*

Adversary class A13: a server-side or network observer correlating sync timing, blob sizes, and account activity to infer behavior even without decrypting content. Myne v0.1 is Best-effort against A13 — sync timing, blob count, and blob size are visible to anyone observing the network or the server, and connection IPs are visible transiently (not logged). Padding, cover traffic, and timing randomization are deferred beyond v0.1.

Used in: `threat-model.md` §1 (A13), §7

### **Trash** &nbsp; 📦 *Product*

The vault-internal soft-delete state introduced in v0.2 (MYND-133): deleting a note moves it to the Trash (recoverable) instead of erasing it; a separate Trash panel lets the user restore a note or permanently delete it (single, or "empty trash"). Represented **inside the encrypted blob** as the Myne-managed `trashed:` frontmatter field (an RFC 3339 timestamp), not as a `<vault>/.trash/` directory — so a filesystem adversary (A4/A7) learns nothing new and the on-disk layout stays flat (`protocol.md` §9.1 unchanged), preserving the same AS3 posture as virtual folders (MYND-144). Trash/restore are **TS orchestrators** (`src/notes/trashNote.ts` — set/clear `trashed:` via the existing `note_update`), not new backend commands; "empty trash" hard-deletes each trashed note via the existing `note_delete` (`src/notes/emptyTrash.ts`). Trash is **manual-only** — nothing auto-expires. Because every state is either a note-content edit (`trashed:` set/clear) or the existing delete-tombstone, soft-trash adds no new Phase 2 sync wire-format state. Distinct from **hard-delete** (`note_delete`, the v0.1 permanent erase that the Trash panel's "Delete permanently" still invokes) and from OS-level "Move to Trash" (permanently rejected, `decisions.md` 2026-05-07). See [markdown-dialect.md](spec/markdown-dialect.md) §3.6.1 (`trashed:` field), [decisions.md](decisions.md) 2026-06-03 (the implementing entry) + 2026-05-07 (the deferral).

Used in: `spec/markdown-dialect.md` §3.6.1, `decisions.md` 2026-06-03 + 2026-05-07 (MYND-133)

### **trust boundary** &nbsp; ⚠️ *Threat*

A line in the system where the security model changes — what is trusted on one side is not trusted on the other. Myne catalogs nine boundaries (TB1–TB9). See `threat-model.md` §3 for the full table.

Used in: `threat-model.md` §3

### **unused attachment** &nbsp; 📋 *Protocol*

An [attachment](#attachment) referenced by **zero live notes** — either orphaned (its referencing note(s) deleted) or never inserted (imported into the library but not yet embedded). It stays in the [`vault.attachments`](#vaultattachments) catalog and visible in the library (Myne is library-first; `protocol.md` §9.10 keeps metadata after note deletion); it is **never** auto-deleted. The only thing that removes it is the explicit user-triggered "Clean unused attachments" sweep, which recomputes the zero-reference set authoritatively (scanning every note, fail-closed) and cryptographically erases the confirmed set. Distinct from a [stray attachment file](#stray-attachment-file) (catalog-less crash remnant). (MYND-171; `decisions.md` 2026-06-13)

### **UUIDv4** &nbsp; 📋 *Protocol*

Random-only UUID variant. Not used in Myne v0.1; reserved as a candidate for v005 if the millisecond-resolution timing leakage of UUIDv7 (used for note filenames) becomes unacceptable.

Used in: `threat-model.md` §7 (deferred consideration)

### **UUIDv7** &nbsp; 📋 *Protocol*

Time-ordered UUID variant (RFC 9562). Used as the filename of `.myn` files in v0.1, providing natural sort order at the cost of leaking a millisecond-resolution creation-time bucket. The leak is documented in §9.4 and accepted in v0.1.

Used in: `spec/protocol.md` §9.1

### **v0.1** &nbsp; 📦 *Product*

The first Myne protocol specification (`spec/protocol.md`). Covers Phase 1 at-rest encryption only. Sync, multi-device, sharing, and post-quantum primitives are out of scope; they appear in `appname-v005`.

Used in: `spec/protocol.md` (titled v0.1)

### **v005 / appname-v005** &nbsp; 📦 *Product*

The aspirational long-term protocol specification, drawn from the founder's research and to be authored as `spec/protocol-v005-roadmap.md`. Introduces post-quantum hybrid wrap (X25519 + ML-KEM-768), MLS multi-device, OPAQUE aPAKE, Key Transparency, OHTTP transport, KVAC anonymous credentials, Yjs-based real-time collaboration, and other v0.1-out-of-scope features. Cross-major migration from v0.1 to v005 is explicit and one-way (`spec/protocol.md` §10.4).

Used in: `decisions.md` (Doc strategy = Option C)

### **VaultId** &nbsp; 🗝️ *Key/identifier*

A random **UUIDv7** that names a vault: it is both the `vaults/<id>/` on-disk directory name and the runtime `HashMap<VaultId, Slot>` key. Opaque and **decoupled from `account_number_hash`** — the directory name leaks no account-correlation tag to a disk observer (a deliberate rejection of an `account_hash_short`-derived name). Minted via `VaultId::mint()` (a directory collision triggers mint-and-retry); rendered/parsed as its 36-char hyphenated form. Not a secret and not a key — it encrypts nothing. Introduced for multi-vault.

Used in: `decisions.md` 2026-06-09 "Vault disk layout: vaults/<id>/ + eager boot migration"

### **vault** &nbsp; 📦 *Product*

A user's encrypted note collection — the unit of Myne's data model. Concretely: a directory containing `vault.meta`, a `notes/` subdirectory of `.myn` files, and (reserved for v0.1) an `attachments/` subdirectory.

Used in: `spec/protocol.md` §9.1

### **vault backup file** &nbsp; 📦 *Product*

*(Alias: `.myne-backup`.)*

A single-file, user-initiated copy of one vault, written to a user-chosen destination with extension `.myne-backup` (magic `MYB1`; format in `spec/protocol.md` §9.11). Members are byte-for-byte ciphertext copies of the vault's files per a closed allowlist ("user data in, caches out": `vault.meta`, `vault.prefs`, notes, snapshots, attachments + catalog; `vault.search` excluded). A plaintext member table carries paths, lengths, and per-member SHA-256 — **unkeyed corruption detection, no tamper-resistance claim**; producers verify by re-reading the destination before reporting success, consumers verify before placement. No new cryptography: no outer envelope, no derived keys (see [backup-key](#backup-key)). Not a sync artifact and not the portability path (that remains decrypted markdown). User-facing term is "backup" — never "archive" or "snapshot". Leak posture and backups-outlive-erase consequences: `threat-model.md` §7.

Used in: `spec/protocol.md` §9.11; `threat-model.md` §7; `decisions.md` 2026-06-10

### **vault creation session** &nbsp; 📦 *Product*

The backend-resident state held between the `begin` and `commit` IPC calls of the vault-creation flow. A `VaultCreationSession` (Rust struct in `src-tauri/src/plugins/vault_creation/state.rs`) carries the freshly generated `account_number`, `recovery_phrase`, `root_key`, two Argon2id salts, the cached password and recovery wrap keys, the chosen `KdfParams`, and a `created_at: Instant` timestamp. Lives in a `Mutex<HashMap<Uuid, VaultCreationSession>>` indexed by **session token**. Bounded by `MAX_CONCURRENT_SESSIONS = 4` and `SESSION_TTL_SECS = 600` (10 minutes); evicted by a background `tokio::time::interval(60s)` task whose evicted tokens land in a parallel **tombstone** map for up to `TOMBSTONE_RETENTION_SECS = 3600` (1 hour). `root_key` and the wrap keys never cross the IPC boundary — they live only in this session until `commit` consumes it.

Used in: `decisions.md` 2026-04-28 "Vault creation flow", "Vault creation session TTL"

### **vault label** &nbsp; 📦 *Product*

A per-vault human-readable name shown in the [vault picker](#vault-picker) and [vault switcher](#vault-switcher). Stored **encrypted-only** inside that vault's [vault.prefs](#vaultprefs) (a non-breaking field on the §9.5 extensible prefs JSON — no new magic, the `MYP1` envelope is unchanged), decrypted into a RAM cache on unlock. Set via the `vault_set_label` IPC, **unlock-gated by construction** (only the active/sole-`Unlocked` vault is writable — a locked vault cannot be renamed). Never written in plaintext at rest and never crosses IPC except as the user's own input; a vault not unlocked this session shows a neutral "Vault N" fallback instead (SYNC-3). Introduced for multi-vault.

Used in: `decisions.md` 2026-06-09 "Multi-vault in-app switcher + label management"

### **vault picker** &nbsp; 📦 *Product*

The startup vault-selection surface, shown **only when ≥2 vaults exist** (0 vaults → Welcome; exactly 1 → unlock directly) — a payload-free `{ name: "picker" }` [Stage](#slot) variant produced only by the boot probe `initialStageFromProbe(vaultList, slotMap)`, never via `transition`. Lists each discovered vault (disk-scan + [vault registry](#vault-registry)) by a neutral fallback label ("Vault N", ordered most-recently-opened first); real labels stay encrypted in each vault's [vault.prefs](#vaultprefs) and show only for a this-session-unlocked vault. Selecting a row opens that vault (its [VaultId](#vaultid) flows to the unlock IPC; lock-then-unlock evicts any prior open vault). A distinct "Create another vault" affordance routes to vault creation. Pre-unlock it surfaces only the vault **count + last-unlock timing** (an accepted leak, `threat-model.md` §7) — never names, content, or account identity. The recovery picker reuses the same view-model.

Used in: `decisions.md` 2026-06-09 "Multi-vault onboarding + vault picker"

### **vault registry** &nbsp; 📦 *Product*

A best-effort, **rebuildable** on-disk cache (`<app_data_dir>/vaults/registry.json`) holding only each vault's opaque [VaultId](#vaultid) + last-unlock timestamp — **no human label** at rest (labels live encrypted in [vault.prefs](#vaultprefs)). It is **not authoritative**: the discovery authority is the disk-scan of `vaults/<id>/` directories, so a missing or corrupt registry is transparently rebuilt from disk and discovery never fails when the cache is gone. Serves the pre-unlock picker's stable ordering. Introduced for multi-vault.

Used in: `decisions.md` 2026-06-09 "Vault disk layout: vaults/<id>/ + eager boot migration"

### **vault root** &nbsp; 📦 *Product* *(retired 2026-06-02)*

*Retired as a named sidebar section by MYND-183 (`decisions.md` 2026-06-02): folderless notes are no longer bucketed under a separate "Vault root" header but render at the root level of the unified [item-order](#item-order) tree, alongside top-level folders. The **logical root position** it described — a note whose `folder:` frontmatter is **absent** — remains first-class and unchanged (`spec/markdown-dialect.md` §3.6 still uses "root / unfiled" for that state); only the dedicated sidebar section is gone. Unrelated: "vault root" in `spec/wikilink.md` means the on-disk vault directory (the folder holding `vault.meta`), a different sense untouched here. Preserved for audit trail.*

The top of the virtual folder tree — the home of *unfiled* notes. A note is at the vault root when its `folder:` frontmatter field is **absent** (`folder: ""` is read as root and normalized to absent; `folder: "/"` is rejected). Distinct from the *vault directory* on the filesystem: the vault root is a logical position in the sidebar tree, not a path on disk (the on-disk layout is always flat `notes/<uuid>.myn`). A new note created with no folder selected, and a note moved out of every folder, both land at the vault root. See also [folder](#folder).

Used in: `spec/markdown-dialect.md` §3.6.1–3.6.2; `decisions.md` 2026-05-29

### **vault switcher** &nbsp; 📦 *Product*

The in-app surface for changing the active vault while running — the sidebar-header account chip opens a dropdown listing the discovered vaults (the [vault picker](#vault-picker) view-model: real [label](#vault-label) for a this-session-unlocked vault, neutral "Vault N" fallback otherwise, last-unlock ordering, active vault marked). Selecting a non-active vault **switches** to it via **lock-then-unlock** (NOT a pointer-flip): the param-less `vault_lock()` runs the four-surface teardown (keys + search index + VaultIndices + attachment-refs) + `flushIfDirty`, then the target is unlocked (vault-addressed) — so the prior vault's plaintext is fully torn down before the next opens (SYNC-1/8). A brief "saving…" state covers the chain; selecting the active vault is a no-op. Introduced for multi-vault.

Used in: `decisions.md` 2026-06-09 "Multi-vault in-app switcher + label management"

### **vault.meta** &nbsp; 📦 *Product* (deep entry)

The single binary file holding vault-level cryptographic state. Magic bytes `MYV1` for v0.1. Layout per `spec/protocol.md` §9.3: protocol version, account_number_hash, the 11-byte canonical KDF parameters block, both salt-randomness fields (`random_salt_password_16`, `random_salt_recovery_16`), nonces and ciphertexts for both wrapped root-key copies (`enc_root_key_password`, `enc_root_key_recovery`), and the items_key_id, items_key_nonce, and `enc_items_key`. `vault.meta` plus the `.myn` files are the only artifacts that leave the device in any future sync scenario; both are opaque ciphertext plus a small public header.

Used in: `spec/protocol.md` §9.3

### **vault.prefs** &nbsp; 📦 *Product*

Vault-level singleton encrypted blob holding user-configurable preferences (Phase 1: the screen-capture-protection toggle from MYND-55/MYND-160). Magic bytes `MYP1` for v0.1. Lives at `<app_data_dir>/vault/vault.prefs` next to `vault.meta`. Outer envelope is a 34-byte fixed-offset header followed by AEAD-wrapped canonical JSON plaintext under `prefs_key`; layout + AAD construction + canonical encoding rules + size cap + migration-less semantic in `spec/protocol.md` §9.5. Written eagerly at `vault_create` (closed invariant: post-MYND-160 vaults always have `vault.prefs` on disk) and lazily re-read by every `prefs_read` IPC call (disk is canonical; not cached in `Slot::Unlocked`). Read failure (absent / truncated / AEAD-fail / parse-fail) returns `PrefsView::default()` per the §9.5.5 non-distinguishing semantic.

Used in: `spec/protocol.md` §9.5; `decisions.md` 2026-05-27 "Vault preferences blob"

### **vault.attachments** &nbsp; 📦 *Product*

The vault-level singleton catalog ([`MYC1`](#myc1) blob, `spec/protocol.md` §9.10) holding **authoritative** per-[attachment](#attachment) metadata — `id → {content_type, created_at, filename, size}` — so the attachments library can display an attachment even when no note references it (the filename survives note deletion; the in-note alias is a cosmetic copy). AEAD-encrypted under a `root_key`-derived KEK (`"myne.v0.1 attachments-catalog-key"`); canonical-JSON inner; fall-back-to-empty on absent/tampered; eager-written at vault creation. The note→attachment reference graph ("used in N notes") is **not** stored here — it is derived from note bodies at runtime via the `content_nonce` reconcile (the [search index](#search-index) MYND-29 pattern), kept in RAM and rebuilt on demand. (MYND-164)

### **vault.indices** &nbsp; 📦 *Product*

Vault-level singleton encrypted blob ([`MYI1`](#myi1), `spec/protocol.md` §9.8) caching the [VaultIndices](#vaultindices) structured-metadata index — the wikilink graph + tag index + title resolution + the **typed [property](#property) records** (MYND-31 design; persistence landed by MYND-271). The structural twin of [vault.search](#vaultsearch): same 34-byte fixed-offset header (magic `MYI1`, protocol_version, an `index_format_version` byte, nonce, ciphertext_len), same **engine-opaque** postcard inner plaintext (a `{note_id → content_nonce}` staleness manifest + the serialized structured index), same decryption-free `content_nonce` reconcile + [fall-to-rebuild](#fall-to-rebuild) posture — but indexes *structured* metadata, not full-text terms. AEAD-encrypted under [vault-indices-key](#vault-indices-key); a pure **rebuildable cache** (deleting it loses nothing — the `.myn` files are the source of truth), which is what keeps it inside the "not a database" commitment (`vision.md`). Distinct blob family from `vault.search` (one magic per family; `MYI1` ≠ `MYS1`). At-rest size leaks a coarse metadata-volume signal, accepted (`threat-model.md` A5).

Used in: `spec/protocol.md` §9.8; `decisions.md` 2026-06-14 (MYND-271)

### **vault-indices-key** &nbsp; 🗝️ *Key/identifier*

The 32-byte AEAD KEK encrypting [vault.indices](#vaultindices) (`MYI1`). Derived deterministically from `root_key` via the canonical `DeriveSubkey(root_key, "vault-indices-key")` helper (`spec/protocol.md` §3.4 registry entry `"myne.v0.1 vault-indices-key"`). Never persisted; re-derived on each unlock (to load / reconcile the index) and on each persist. Independent from the `itemsKey` lineage by design — like `prefs_key` / `search-index-key` / `session-state-key` it derives straight from `root_key`, so it survives the v005 epoch-rotation `itemsKey` evolution. The AAD `AAD_vault_indices_blob` (role `"vault-indices-blob"`, `spec/protocol.md` §9.8.3) binds the blob to its vault via `account_number_hash`. Distinct from `search-index-key` (one KEK role per blob family). (MYND-271)

Used in: `spec/protocol.md` §3.4, §9.8

### **vault.search** &nbsp; 📦 *Product*

Vault-level singleton encrypted blob caching the [search index](#search-index) (MYND-29). Magic bytes `MYS1` for v0.1. Lives at `<app_data_dir>/vault/vault.search` next to `vault.meta` and `vault.prefs`. Outer envelope is a 34-byte fixed-offset header (magic, protocol_version, an `index_format_version` byte where `vault.prefs` carries a reserved byte, nonce, ciphertext_len) followed by AEAD-wrapped plaintext under [search-index-key](#search-index-key); layout + AAD + staleness/reconcile + size cap in `spec/protocol.md` §9.6. The inner plaintext is **engine-opaque** (postcard-serialized `{note_id → content_nonce}` staleness manifest + the serialized inverted index) — distinct from `vault.prefs`'s canonical JSON, because the index is large and never field-validated. A pure **cache**: a warm unlock loads it and incrementally reconciles via the decryption-free `content_nonce` diff; on absence / AEAD-fail it [falls to rebuild](#fall-to-rebuild) (the `.myn` files are the source of truth). Flushed on graceful lock/quit + a periodic timer; idle auto-lock skips the flush (fail-closed). At-rest blob size leaks a coarse vocabulary/volume signal, accepted (`threat-model.md` A5).

Used in: `spec/protocol.md` §9.6; `decisions.md` 2026-05-31

### **vault_<verb_past> tracing event-name pattern** &nbsp; 🛠️ *Tooling*

Project-wide naming discipline for `tracing::info!(event = "...")` success-event emissions across the auth-pipeline plugins. Format: `vault_<verb in past tense>`. Concrete instances in v0.1: `vault_unlocked` (vault_unlock command success), `vault_locked` (vault_lock command success), `vault_recovered_with_phrase` (A8d phrase-recovery success), `vault_recovery_completed` (A8f post-recovery password commit success), and the forthcoming `vault_password_changed` (MYND-22's vault_change_password commit success). Future Phase 2 plugins (OPAQUE, hardware-unlock, etc.) extend the pattern without per-plugin `decisions.md` entries — the convention is self-evident from the existing instances. Phase 2 ops-tooling primitive: log aggregation queries can pattern-match `event = "vault_*"` once a `tracing-subscriber` is wired (deferred today). Pinned by `decisions.md` 2026-05-06 "Tracing event-name pattern: vault_<verb_past> across auth-pipeline plugins".

Used in: `src-tauri/src/plugins/{vault_unlock,vault_recover}/commands.rs`; `decisions.md` 2026-05-06.

### **vault_meta_bytes_hash** &nbsp; 🛠️ *Tooling*

Public-material `[u8; 32]` field on the desktop client's `Slot::Unlocked` carrying `SHA-256(vault.meta bytes)` captured at slot-populate time. Populated by `vault_unlock` (digest of unlock-time read bytes) and by `vault_complete_recovery` (digest of the freshly-rewritten bytes; AFTER `atomic_write` succeeds). Serves as the **in-memory CAS anchor** for `vault_change_password`'s in-place rewrite — the command compares the slot-held hash against a fresh digest of the on-disk bytes before committing the rewrite, returning `VaultMetaChangedExternally` and force-relocking on mismatch. SHA-256 of public bytes is itself public material; held bare without `Zeroize`. Pinned by `decisions.md` 2026-05-06 entry "Slot::Unlocked anchor field for vault.meta CAS" (MYND-22 foundation hardening).

Used in: `src-tauri/src/plugins/vault_unlock/state.rs::UnlockedVault.vault_meta_bytes_hash`; `decisions.md` 2026-05-06.

### **vault_status** &nbsp; 🛠️ *Tooling*

The Tauri command `vault_unlock:status` that returns the current [`SlotKind`]. Read-only (`tokio::sync::RwLock::read`); never fails in practice — the `Result<SlotKind, VaultUnlockError>` return is purely IPC-contract uniformity with the rest of the unlock plugin. Lives in `vault_unlock` because the plugin owns the runtime-state singleton; permission `vault-unlock:default allow-status`. Frontend boot-time and post-WebView-reload routing call `vault_status` to recover from the case where Tauri's Rust state outlives the WebView's JS state across Cmd+R / hot-reload — `Empty` routes to unlock (or vault-creation if no `vault.meta` exists), `Recovering` routes to the password-reset form, `Unlocked` routes to the editor. Explicitly NOT part of the post-recovery happy path: a defensive round-trip after `vault_complete_recovery` would be paranoia per `decisions.md` 2026-05-02 (the IPC contract pins `Slot::Unlocked` as the success postcondition).

Used in: `src-tauri/src/plugins/vault_unlock/commands.rs::status`; `src/types/slot-kind.ts`

### **VaultIndices** &nbsp; 📦 *Product*

The in-RAM, plaintext-derived index of a vault's wikilink graph — forward links + reverse adjacency (backlinks) — and its tag index, plus the title→note resolution surface (MYND-31). The structural twin of `vault.search`: rebuilt on unlock, wiped on lock, never written to disk in plaintext; persisted encrypted-at-rest as the [vault.indices](#vaultindices) / `MYI1` blob (`spec/protocol.md` §9.8 — the MYND-31 design, persistence landed by MYND-271 alongside the typed [property](#property) index). Built **Build-B**: dialect extraction stays on the TS side (one dialect source of truth, `title_extract.rs` / MYND-82) while the struct, query surface (`backlinks` / `forward` / `by_tag` / `tag_tree` / `resolveTitle`), and persistence are Rust-side. Edges are title-keyed, not UUID-keyed (Model-2), and resolution runs through the single `resolveWikilink` resolver (`spec/wikilink.md` §5.3, "plain-B"). See `decisions.md` 2026-06-07.

Used in: `decisions.md` 2026-06-07 (MYND-31)

### **view order** &nbsp; 📦 *Product*

The user-controlled display order of [saved views](#saved-view) in the sidebar "Views" section + the views list (Saved Views epic, MYND-274 / SYNC-10). Persisted as the `view_order` field of [vault.prefs](#vaultprefs) — a **sequence** array of view ids (NFC-normalized, order preserved verbatim, NOT sorted or deduped, omitted-when-empty), exactly the [item order](#item-order) / [favorites](#favorites) discipline. A stale id (a deleted view) is ignored at render and pruned on the next write (no codec GC). The list renders `view_order`'s ids first (in order), then any saved view not yet in it. See also [saved view](#saved-view), [item order](#item-order). (MYND-274)

Used in: `spec/protocol.md` §9.5.2; Saved Views (MYND-273 / MYND-274)

### **view type** &nbsp; 📦 *Product*

The render shape of a [saved view](#saved-view) (Saved Views epic, MYND-271). The closed v0.1 set is **table / cards / list** (Obsidian-Bases' `map` is dropped, SYNC-5); v1 ships **cards** only, with table and list as post-v1 follow-ups (MYND-277 / MYND-278). Every view type renders the **same** grouped query result read-only — no editable cells, no kanban drag-columns — so the choice is purely presentational (cards add a cover [`image:`](#attachment) + groupBy headers; list reuses the note-list row). The view type is one field of the view definition stored in `vault.prefs` / `MYP1`.

Used in: Saved Views (MYND-271)

### **voice note** &nbsp; 📦 *Product*

A note audio clip embedded inline — either a recorded microphone capture or an attached audio file. Stored as an ordinary [attachment](#attachment) (an `audio/wav` [`MYA1`](#mya1) blob — **no new on-disk format**) referenced by the form-C embed `![[att:<id>|filename]]` and played by an inline custom waveform widget. Recording captures **natively in Rust via `cpal`** (not the WebView MediaRecorder, so PCM stays Rust-side + `Zeroize`-able), encodes to WAV/PCM at the device-native rate (mono, 16-bit), buffers in RAM only (never a plaintext temp file), and auto-finalizes at the 64 MiB cap into a seamless next clip. The mic is unlock-gated, gesture-driven, and aborted on lock / auto-lock. `audio/wav` joins the [`attachment://`](#attachment) serve allowlist + the sniffer (a `RIFF`…`WAVE` arm). (MYND-259; `decisions.md` 2026-06-14)

### **Vite** &nbsp; 🛠️ *Tooling*

The build tool and dev server used by the Phase 1 desktop client to bundle the React UI before Tauri ships it as a static asset bundle. Chosen over Next.js (`decisions.md` 2026-04-26) because Tauri ships a static bundle — Next.js's SSR / RSC / API-route value is architecturally unused, while its ~10× larger transitive npm dependency footprint vs Vite is paid in full. The smaller direct-npm-dependency surface aligns with the threat-model §7 "deliberately small direct-dependency surface" commitment for A8/TB9.

Used in: `decisions.md`; `threat-model.md` §7
Reference: https://vite.dev

### **unlinked mention** &nbsp; 📦 *Product*

A note whose prose mentions the open note's **title** as a whole-word, fold-identity phrase **without** `[[wikilink]]`-ing it — surfaced as a collapsed-by-default second section of the **backlinks** pane with a one-click "link" action (Obsidian-parity discovery/cleanup aid; MYND-196, build-phase v1.1). Distinct from a backlink, which is an explicit link. Candidate recall rides the existing encrypted `vault.search` body index as a *filter only*; identity is verified by a `foldSegment` word-boundary match on the decrypted candidate body (`vault.search`'s language-detecting tokenizer is never the identity authority). A corpus-relative phrase document-frequency floor (df > ~0.15 → suppress) plus a ≤2-folded-char guard suppress common/short titles; the 0.15 threshold is a **tunable code constant, not spec** (deliberate contrast with the frozen Damm-32 table). Adds **no new at-rest artefact** — the guarantee surface does not move. Clicking "link" inserts `[[Title]]` through the canonical `saveNote` write path and never clobbers an open+dirty note (SYNC-15 guard).

Used in: `agent-tooling/features/unlinked-mentions/prd.md`, `spec/wikilink.md`, `vision.md` Phase 1 Scope

### **math (markdown)** &nbsp; 📦 *Product*

LaTeX math rendered in the editor (MYND-48): inline `$…$` (a custom `InlineMath` Lezer node) and block `$$…$$` (a regex block decoration), typeset by lazy-loaded KaTeX, cursor-aware (raw LaTeX revealed on-cursor; invalid LaTeX → source + a subtle dotted-underline hint, never KaTeX's red node). The `$`-disambiguation keeps currency text (`$5`, `$ €`) from parsing as math (opening `$` not followed by whitespace/digit, closing `$` not preceded by whitespace, `$$` = block, single-line). `InlineMath` is a leaf → no `#tags`/emphasis inside; math doesn't parse in code. Render-only, never emitted (§6 C1). Supersedes the §7 math deferral (`decisions.md` 2026-06-08).

Used in: `spec/markdown-dialect.md` §3.2/§7

### **mermaid diagram** &nbsp; 📦 *Product*

A ```mermaid fenced code block rendered as an SVG diagram in the editor (MYND-49) via lazy-loaded Mermaid (`securityLevel:'strict'`, `htmlLabels:false` — mermaid sanitizes its own SVG with its bundled DOMPurify). `fenced-code.ts` skips the `mermaid` info-string so the diagram widget renders it instead of a code card; parse-error / load-failure falls back to a monospace card. Cursor-aware whole-block reveal; render-only (§6 C1). Mermaid is the **heaviest dependency** in the project (≈+100 transitive packages), lazy-loaded so a diagram-free note pays zero bytes — shipped as a conscious decision (`decisions.md` 2026-06-08) over the auto-grill's defer recommendation. PlantUML is not rendered (stays a code card).

Used in: `spec/markdown-dialect.md` §7; `dependency-policy.md`

### **subscript / superscript (markdown)** &nbsp; 📦 *Product*

The `~x~` (subscript) and `^x^` (superscript) inline constructs, rendered with reduced-size, vertically-shifted typography (MYND-156, `.cm-sub` / `.cm-sup`). Use the pre-built `@lezer/markdown` Subscript/Superscript configs; single-run and space-free (Pandoc-style), disjoint from GFM strikethrough `~~…~~` and footnote `[^id]`. Recognize-and-render-only — never emitted; bytes preserved (§6 C1).

Used in: `spec/markdown-dialect.md` §3.2

### **wikilink** &nbsp; 📦 *Product* (deep entry, *Myne-divergent*)

Myne's first-class internal-link syntax: `[[…]]`-bracketed references that resolve against the current vault and render as atomic chip widgets in the editor. Recognized forms include title-only (`[[Note]]`), aliased (`[[Note|Display]]`), heading-anchored (`[[Note#Heading]]`), block-referenced (`[[Note^block-id]]`), path-encoded (`[[vault/relative/path.md|Display]]`), and embed prefixes (`![[Note]]`, `![[image.png]]`). Full grammar in `spec/wikilink.md`. **Myne-divergent from Obsidian conventions in two load-bearing ways:** (1) new Myne-authored wikilinks emit the **path-with-alias** form `[[vault/relative/path.md|Display Title]]` rather than the title-only form, making every Myne-authored wikilink self-resolvable from the markdown alone — improving the wedge sentence from "plain markdown after decryption" to "*resolvable* plain markdown after decryption"; (2) imported Obsidian wikilinks are preserved byte-for-byte (hard rule C1) and coexist indefinitely with Myne-authored path forms. Decoration treats both forms identically as atomic chips; click-resolution differs (title-only via vault-index lookup; path-form follows directly). Auto-update on rename preserves syntactic shape — never promotes form. The manual conversion command (R2 in `wikilink.md` §7) is the only sanctioned migration path from imported title-only to path-form. Wikilinks are **not** standard markdown; no CommonMark / GFM / Pandoc / Djot dialect natively defines them.

Used in: `spec/wikilink.md`, `spec/markdown-dialect.md` §3.5, `vision.md` Phase 1 Scope

### **wikilink chip** &nbsp; 📦 *Product*

The atomic-range rendered widget representing a **wikilink** (`[[Note]]`, `[[Note|Display]]`, `[[Note#Heading]]`, `[[Note^block-id]]`, `[[path.md|Alias]]`, `![[Embed]]`) inside the Phase 1 editor surface. Implemented as a CodeMirror 6 `Decoration.replace` paired with `EditorView.atomicRanges` registration so cursor navigation, selection extension, and Backspace / Delete treat each chip as a single indivisible unit. Unlike other inline-mark decorations, chips do **not** lift on cursor entry — they stay rendered regardless of cursor position; the underlying `[[...]]` source remains in the buffer byte-for-byte. `editor-mvp-baseline` ships chip **rendering** (visual + atomic-range behavior); the authoring layer (autocomplete picker, hover-tooltip path resolution, manual conversion, auto-update on rename) lands in `editor-mvp-wikilinks`.

Used in: `agent-tooling/features/editor-mvp-baseline/prd.md`, `spec/wikilink.md` §5.4, `agent-tooling/sessions/grill/2026-05-16-mynd-36-editor-inner-scope.md` Q6

### **wrap key cache** &nbsp; 🗝️ *Key/identifier*

The two 32-byte Argon2id outputs (`password_wrap_key`, `recovery_wrap_key`) derived from the master password and recovery phrase respectively, cached on a **vault creation session** between `begin` and `commit`. Argon2id at the v0.1 baseline (`m_kib = 262_144`, `t = 3`, `p = 2`) takes ~1–2 seconds per call; deriving once at `begin` time and reusing at `commit` time eliminates a second ~2-second pass through the recovery-phrase Argon2id. The wrap keys are `Zeroizing<[u8; 32]>`; they are wiped when the session is dropped (commit, cancel, or TTL eviction).

Used in: `decisions.md` 2026-04-28 "Vault creation flow"

### **X25519** &nbsp; 🔐 *Primitive*

The Diffie-Hellman key-agreement function on Curve25519 (RFC 7748). Not used in Myne's v0.1 at-rest encryption; reserved for `appname-v005` user-to-user key agreement (sharing) and multi-device coordination.

Used in: `e2ee-notes-evaluation.md`; `spec/protocol.md` §11
Reference: RFC 7748.

### **XChaCha20-Poly1305** &nbsp; 🔐 *Primitive* (deep entry)

The extended-nonce variant of ChaCha20-Poly1305 with a 192-bit nonce instead of the standard 96 bits. Specified as an IETF draft and widely deployed via libsodium. Myne's only AEAD primitive — every encryption operation in the protocol uses XChaCha20-Poly1305 wrapped in CTX commitment (§5.1). The 192-bit nonce removes the operational burden of nonce-uniqueness tracking: random nonce collisions are negligible at any realistic vault size (~2^96 operations to expect a collision). Plain ChaCha20-Poly1305 (96-bit nonce) is **not** used in the protocol; readers must distinguish.

Used in: `spec/protocol.md` §5.1
Reference: https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha (draft-arciszewski-xchacha-03 informational), and libsodium's `crypto_aead_xchacha20poly1305_ietf_*` API.

### **Yjs** &nbsp; 🛠️ *Tooling*

A CRDT library for collaborative editing. Myne plans to use Yjs in Phase 4 for real-time collaboration (`vision.md` Phase 4). Not used in v0.1.

Used in: `vision.md` (Phase 4 scope)
Reference: https://yjs.dev

### **zero-knowledge** &nbsp; ⚠️ *Threat* (deep entry, *Myne-divergent*)

*(Aliases: zero knowledge, ZK. Myne-divergent: yes — informal usage, not the formal ZK proof.)*

In Myne's documents, "zero-knowledge" is used in the **informal industry sense**: the server cannot read users' note plaintext, cannot derive their root keys, cannot recover their passwords, and cannot meaningfully assist a compelled-disclosure request beyond handing over opaque ciphertext and limited transient metadata. This is **not** a formal cryptographic zero-knowledge proof in the Goldwasser–Micali–Rackoff sense. Marketing copy that claims "zero-knowledge" must be backed by the architectural commitments in `threat-model.md` §1 (A1, A2 strong guarantees) and §6 (compensating controls), and must not exceed them. A formal zero-knowledge proof is not part of the protocol design.

Used in: `vision.md`, `threat-model.md` §1

### **zxcvbn** &nbsp; 🛠️ *Tooling*

A password-strength estimation library. Myne recommends using zxcvbn at signup to enforce a minimum strength score (≥3) on the master password.

Used in: `spec/protocol.md` §4.1

---

## Quick-reference indices

### Index 1 — Cryptographic primitives at a glance

| Primitive | Used for | Library |
|---|---|---|
| Argon2id (`m=256 MiB, t=3, p=2`) | Password and recovery-phrase stretching → wrap keys | libsodium |
| HKDF-SHA-256 | Subkey derivation from root_key (via `derive_key` helper) | libsodium |
| XChaCha20-Poly1305 (192-bit nonce) | Every AEAD operation | libsodium |
| SHA-256 | CTX commitment outer hash, account hash, salt construction | libsodium / stdlib |
| BIP-39 (encoding only) | Recovery phrase presentation | `@scure/bip39` |
| Crockford base32 | Account number alphabet | hand-rolled |
| Damm-32 | Account number check digit | hand-rolled (frozen table, `account-number.md` §4.2) |

### Index 2 — Myne-specific keys and where they live

| Symbol | Role | Storage | Lifetime |
|---|---|---|---|
| `master_password` | User credential 1 | User memory | Session |
| `recovery_phrase` | User credential 2 (BIP-39 24 words) | User offline storage | Permanent |
| `root_key` (32 B random) | Vault cryptographic core | Encrypted ×2 in `vault.meta` | Vault lifetime |
| `password_wrap_key` | KEK for `root_key` from password | Derived only | Session |
| `recovery_wrap_key` | KEK for `root_key` from phrase | Derived only | Session |
| `itemsKey_wrap_key` | KEK for the singleton `itemsKey` | Derived only | Session |
| `itemsKey` (32 B random) | Wraps every per-note `item_key` | Encrypted in `vault.meta` | Vault lifetime |
| `item_key` (32 B random) | Encrypts one note's plaintext | Encrypted in `.myn` file | Note lifetime |
| `server-auth` subkey | Reserved for Phase 2 sync auth | Derived only (not transmitted in v0.1) | Session |
| `backup-key` | Reserved for a future sealed-backup variant — not used in v0.1 (demoted 2026-06-10) | Derived only (reserved) | — |
| `account_number` (95-bit + Damm) | User identifier; bearer token in P2+ | User offline storage | Permanent |
| `account_number_hash` (SHA-256[:16]) | Argon2id salt binding | `vault.meta` | Vault lifetime |

### Index 3 — Magic bytes and context-prefix registries

| Major version | Per-note magic | Vault-meta magic | AAD prefix | Context-string prefix | Status |
|---|---|---|---|---|---|
| v0.1 | `MY01` | `MYV1` | `"myne.v0.1|"` | `"myne.v0.1 "` | Active (this document) |
| v005 | `NT05` | `NTV5` | `"myne.v005|"` | `"myne.v005 "` | Reserved; specification TBD |

The four prefixes for a single major version are deliberately non-interchangeable: each lives in a different cryptographic call site, and using one in place of another is a protocol violation. See entry **`myne.v0.1` prefix** and `spec/protocol.md` §10.3.

### Theme preference

The user's Light / Dark / System choice, persisted as the `theme` field of [`vault.prefs`](#prefsview) (`spec/protocol.md` §9.5.2). An optional string — `"light"` or `"dark"` — where **absence of the key is the canonical encoding of "system"** (follow the OS `prefers-color-scheme`); there is no `"system"` value, so a vault that made no explicit choice omits the field and stays byte-identical to a pre-MYND-110 blob. Rendering is a **pure-CSS hybrid**: an explicit choice sets `<html data-theme="light|dark">` (overriding the OS); System and every pre-unlock screen carry no attribute, so a `prefers-color-scheme` `@media` block follows the OS live with no JS. The preference is **non-load-bearing** — a cosmetic UI setting (AS-low) with no protective-envelope clamp (unlike [AUTO_LOCK_CEILING](#auto_lock_ceiling)); a tampered or replayed `vault.prefs` can at worst surface the wrong color, and an unrecognized value decodes to "system" rather than failing. It lives inside the encrypted blob (not plaintext) so a disk-at-rest adversary learns nothing — the same structural-privacy reasoning that keeps [auto-lock](#auto-lock-on-idle)'s timeout encrypted. On lock the attribute is removed (the UI follows the OS), the UI-layer image of zeroize-on-lock. The theme syncs with the vault (it is vault state, not a device-local preference). Introduced MYND-110. See also [PrefsView](#prefsview), [syntax color tokens](#syntax-color-tokens), [custom theme](#custom-theme).

### custom theme

A user-authored color palette loaded from a plaintext `.json` file the user places at `app_config_dir/themes/<name>.json` — distinct from the built-in Light/Dark [Theme preference](#theme-preference). The file is a flat map of CSS custom-property names to values (`{ "--paper": "#…", "--ink-1": "#…", … }`): a **single flat palette** that, when selected, *overrides* Light / Dark / System rather than carrying per-mode variants. It is validated host-side (Rust) before use — the minimal raw-ramp token core must be present, and every value must match a **value-shape allowlist** (hex / `rgb()` / `rgba()` / `hsl()` / named color / `<number><unit>`), the *primary* injection guard because the WebView keeps `style-src 'unsafe-inline'` (`threat-model.md` custom-theme CSS-value surface; `decisions.md` 2026-06-16). The theme *file* is a **device-local plaintext asset** — not vault content, not synced (the [registry.json](#vault-registry) structural-privacy class) — while the *selection* `custom:<name>` persists in the encrypted [`vault.prefs`](#prefsview) `custom_theme` field. A custom theme is **validated, not sandboxed**: it is not a security boundary, only a guarded cosmetic surface. Introduced MYND-111 (custom-themes epic). See also [Theme preference](#theme-preference), [syntax color tokens](#syntax-color-tokens).

### Threat-model enumerations (link out, not enumerated here)

- **Adversary classes A1–A13** → `threat-model.md` §1
- **Assets AS1–AS17** → `threat-model.md` §2
- **Trust boundaries TB1–TB9** → `threat-model.md` §3

These enumerations are normative and frequently referenced from other docs (e.g., "TB7 mitigates A9 via signed auto-update"), but enumerating each one in the glossary would duplicate the threat model. Read those sections directly when an entry references an A/AS/TB number.

---

## Maintenance

- **Add a term**: when a new term first appears in any Myne doc and falls within the scope filter (cryptographic primitives, constructions, project-specific keys, protocol concepts, threat-model framework terms, product/architecture vocabulary, implementation tooling), add an entry in the same change that introduces the term. Don't let a doc change ship without the corresponding glossary entry.
- **Update a term**: if a term's definition changes via `decisions.md`, update the corresponding glossary entry in the same change. Glossary drift is a documented audit failure mode.
- **Retire a term**: when a term is removed from all docs, mark its glossary entry with `*(retired YYYY-MM-DD; see decisions.md)*` rather than deleting the entry. Preserves the audit trail and helps readers of older spec versions.
- **Inconsistencies**: if the same term is used inconsistently across docs (e.g., the four `account_number_hash` truncation lengths surfaced during the v0.1 scan), the glossary is the place to record the resolution. Where the resolution is non-obvious, link out to `decisions.md`.
