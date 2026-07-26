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

*(Aliases: account hash. Myne-divergent: yes — one canonical truncation since 2026-07-13.)*

A SHA-256 hash of the canonical account number, truncated to 16 bytes: `SHA-256(canonical_account_number)[:16]`. **One canonical form for every use site** (revised 2026-07-13, `decisions.md`): Argon2id salt construction (§3.1 of the protocol spec, stored in `vault.meta`) and Phase 2+ server-side identification (`spec/account-number.md` §7 — the storage-namespace key, rate-limit key, and SCRAM identity) use the same value. An earlier draft specified a 32-byte truncation server-side "to avoid identifier reuse across uses"; that was superseded because a longer truncation of the same digest is a strict prefix-extension of the shorter one — it provides no separation (and a domain-separated input would buy nothing either, since the server stores each account's `vault.meta`, which embeds this hash, in that account's namespace). In **multi-vault recovery** the 16-byte `vault.meta` value doubles as an *optional* vault selector: when a user types their account number, the host recomputes `SHA-256(canonical)[:16]` and byte-matches it against each discovered vault's plaintext header field to jump to that vault (header-read only — no decrypt, no `auth_permits`; `decisions.md` 2026-06-09 "Multi-vault recovery").

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

### **archive** &nbsp; 📦 *Product*

The indefinite-retention declutter layer: a note the user has set aside but keeps forever (no auto-purge), distinct from the Trash. Archiving hides a note from the working set (sidebar tree + favorites display) but — unlike trashing — leaves it discoverable in full-text search and resolvable as a wikilink/backlink target. Archive and trash are two positions on one *location* axis and are mutually exclusive: a note is at most one of live / archived / trashed. Backed by the value-strict [archived field](#archived-field) (MYND-331).

Used in: `spec/markdown-dialect.md` §3.6.1

### **archived field** &nbsp; 📋 *Protocol*

The seventh Myne-managed canonical frontmatter field, `archived:` — a **value-strict** RFC 3339 UTC timestamp marking when a note was archived (the exact twin of `trashed:`; any non-timestamp value leaves the note live). Written only by the archive/unarchive actions (`src/notes/archiveNote.ts`) via `patchArchivedField` over the existing `note_update` IPC; neither transition bumps `updated:`. Mutually exclusive with `trashed:` at the action layer. Rides the existing `.myn` AEAD envelope — no `protocol.md` magic-byte / AAD / version change (MYND-331). See [archive](#archive).

### **archived folder** &nbsp; 📦 *Product*

A folder archived as a **unit** (folder-archive): the whole subtree leaves the working set (sidebar tree + favorites + quick-open + saved-view results) while its notes stay resolvable as backlink/graph/tag targets and in full-text search — the folder-level twin of the per-note [archived field](#archived-field). Because the virtual-folder model has no folder entity to carry a marker, an archived folder is stored as a canonical trailing-slash path in the additive `archived_folders` set inside the encrypted `vault.prefs` (`MYP1`), the same codec as [deliberate folder](#deliberate-folder) / [AI-excluded folder](#ai-excluded-folder). Archiving writes **no** note frontmatter, so it composes independently with per-note archive (a note individually archived inside a folder stays archived when the folder is restored). Matched by folded-prefix (case-fold + NFC, sibling-safe: `Projects/` archives `Projects/Myne/` but not `ProjectsX/`); rename/delete re-root/trim the set. Restore/Delete-to-Trash from the Archive panel. See [archive](#archive), [folder](#folder).

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

### **attachment catalog tombstone** &nbsp; 📋 *Protocol*

A [`vault.attachments`](#vaultattachments) entry whose optional `deleted_at` field is set (`spec/protocol.md` §9.10.2): the multi-device **deletion marker** for an [attachment](#attachment) under Phase 2 sync (`spec/sync-protocol.md` §11.4). Written at delete time with the entry's metadata **scrubbed** (filename/content-type emptied, size zeroed) so the synced catalog keeps nothing descriptive about a crypto-erased file; it defeats stale-catalog resurrection in the per-entry merge (a live entry wins only if its `created_at` postdates `deleted_at` — a deliberate re-add). Prunable client-side after the [tombstone horizon](#tombstone-horizon). **Distinct from** the [deleted-attachment tombstone](#deleted-attachment-tombstone), which is the *UI placeholder* an editor embed renders for an unresolvable id. Phase 2. (MYND-468)

### **attachment-id** &nbsp; 📋 *Protocol*

The 32-byte content-addressed identifier of an [attachment](#attachment): `HMAC-SHA-256(DeriveSubkey(root_key, "attachments-id-hmac"), file_bytes)` (`spec/protocol.md` §9.9). Used as the on-disk filename (hex) and the dedup key — identical content yields one blob within a vault. Because it is keyed under `root_key`, a disk observer without the key cannot test whether the vault holds a specific known file (no confirmation oracle) nor link equal content across vaults (`threat-model.md` AS7/AS8). Notes reference it via the editor form-C embed `![[att:<id>|filename]]`. Dedup is an id-existence check, not convergent encryption. (MYND-164)

### **attachment://** &nbsp; 📋 *Protocol*

The custom WebView protocol scheme that serves a decrypted [attachment](#attachment) to the editor/library. The Rust handler resolves `attachment://<id>`, decrypts the blob in memory, **re-sniffs** the content-type from the bytes and emits only an allowlisted type (`image/*`, `application/pdf`, or `audio/wav` — voice notes, MYND-259), and returns a full response — no plaintext ever written to disk, no `Range`/206 in v0.1. Unlock-gated and main-window-scoped (TB6); the WebView CSP blocks outbound network so a hostile note cannot exfiltrate a blob. (MYND-164)

### **attachment_import** &nbsp; 📋 *Protocol*

The single Tauri command that ingests a file into the attachment store — from inline bytes (clipboard paste / WebView drop) or a path (file picker). Computes the [attachment-id](#attachment-id), performs id-existence dedup, encrypts + stores the [`MYA1`](#mya1) blob, and upserts the [`vault.attachments`](#vaultattachments) metadata; enforces the 64 MiB cap. Since MYND-173 it accepts **any file type** — a file the sniffer does not recognize is stored as `application/octet-stream` (not rejected); the locked reject taxonomy is now oversize / locked (the render allowlist is a serve-time authority on [attachment://](#attachment), not an import gate). Unlock-gated, main-window-scoped. (MYND-164; `decisions.md` 2026-06-14)

### **attachment_export** &nbsp; 📋 *Protocol*

The Tauri command that writes one [attachment](#attachment)'s **decrypted** bytes to a user-chosen destination — the export-only "use" path for a generic file, and the vault-wide Save-As for images/PDF (MYND-173). The frontend opens the native save dialog (the established export-suite convention) and passes the path + overwrite consent; the host decrypts the [`MYA1`](#mya1) blob in Rust memory and writes the plaintext via `atomic_write_unclobbered`, so it never re-enters the WebView. A deliberate user-initiated plaintext crossing of TB3 — exactly the "attachment files" egress already named in `threat-model.md` §3 / §5; it is one-shot and not a plaintext mode. Unlock-gated. See [export](#export). (`decisions.md` 2026-06-14)

### **attachment file-card** &nbsp; 📦 *Product*

The editor representation of a non-renderable (generic) [attachment](#attachment) — a `.docx`, `.zip`, `.txt`, etc. stored as `application/octet-stream`. Unlike an inline image/PDF, the file's content never auto-renders; the form-C embed `![[att:<id>|filename]]` renders as a compact atomic card showing a file-type icon, the [`vault.attachments`](#vaultattachments) filename (the single source of truth — `Rename` edits it globally via `attachment_rename`, not the per-embed alias), a "type · size" line (the type label is derived from the filename extension TS-side, since the catalog stores only `octet-stream`), and a "⋯" overflow menu: Export (→ [attachment_export](#attachment_export)), Rename, Remove from note, Reveal in library. "Using" the file means exporting it. A missing id renders the shared [deleted-attachment tombstone](#deleted-attachment-tombstone). Text-like files (`.txt`/code/`.csv`) and `.docx`/`.xlsx` cards can additionally expand an inline read-only [attachment text preview](#attachment-text-preview) (MYND-268; `.pptx` and the rest stay export-only). (MYND-173; `decisions.md` 2026-06-14)

### **attachment search doc** &nbsp; 📋 *Protocol*

A [search-index](#mys1) document carrying one embedded [attachment](#attachment)'s [extracted text](#attachment-text-extraction) as its **own** result row, keyed `att:<attachment_id_hex>:<note_id>` (`core/src/search/doc_id.rs`) — the MYND-448a separate-doc model that superseded folding attachment text into the embedding note's body doc. The id carries provenance (which attachment, in which note), so an attachment-content hit is badged distinctly ("in attachment") and opens the embedding note. The doc-model generation rides the snapshot's trailing `schema_version` field (`spec/protocol.md` §9.6.2), independent of the [extractor version](#extractor-version) so a model change rebuilds the index without invalidating [`MYE1`](#mye1) caches. Desktop-side only in v0.1; mobile indexes note bodies alone. (MYND-448a; `decisions.md` 2026-07-13)

### **attachment sync-id** &nbsp; 📋 *Protocol*

The **first 16 bytes** of a 32-byte [attachment-id](#attachment-id) — the key under which an [attachment](#attachment) appears in the [vault head](#vault-head) manifest and the sync metadata plane (`spec/sync-protocol.md` §4.2), which use a uniform 16-byte key for notes (UUID) and attachments alike. The full id keeps living in the `attachments/<hex>` filename, the [`vault.attachments`](#vaultattachments) catalog, and the `/attachments/{id}` byte-transport (`spec/server-protocol.md` §3.2); pull sync-meta echoes the full id so a device can resolve the prefix without the catalog. Truncation is safe intra-vault (~2^-64 birthday bound; a collision is a hard manifest encode failure, never silent). Phase 2. (MYND-468)

### **attachment text extraction** &nbsp; 📋 *Protocol*

The on-device extraction of searchable text from an [attachment](#attachment)'s plaintext — PDF text-layer, Word (`.docx`) OOXML text, and text-like files (`.txt`/`.md`/`.csv`) in v0.1 — so a note becomes findable by the contents of the files embedded in it. Extraction runs entirely in the Rust core (no network, no cloud OCR — `vision.md` zero-knowledge), is cached per attachment in an [`MYE1`](#mye1) blob keyed by [attachment-id](#attachment-id), and is indexed into the [search index](#mys1) as a per-embedding-note [attachment search doc](#attachment-search-doc) (MYND-448a — separate docs superseded the original fold-into-note-body; the `MYS1` snapshot records the [extractor version](#extractor-version) and doc-model `schema_version` it was built under — a change in either forces a rebuild; the codec's `index_format_version` byte is unchanged, both ride the engine-opaque inner snapshot). Image OCR + scanned (text-layer-less) PDFs are out of scope for v0.1, deferred to MYND-441, which reuses the same cache by bumping the [extractor version](#extractor-version). (`spec/protocol.md` §9.15; MYND-328)

### **attachment text preview** &nbsp; 📦 *Product*

The inline, read-only expansion of an [attachment file-card](#attachment-file-card) showing the file's decrypted content in the editor — Tier-1 for text-like files (`.txt`/code/`.csv`) via `attachment_read_text`, Tier-2 as a structured render (headings/paragraphs for `.docx`, a sheet grid for `.xlsx`) via `attachment_read_structured`. Both decrypt the [`MYA1`](#mya1) blob in the Rust core and hand the WebView plain text only, rendered via `textContent` (no markup-injection surface) — the text sibling of the [attachment://](#attachment) serve path. Output is size/row-capped; a file the extractors cannot parse falls back to the plain card. Unlock-gated; the EditorHost seam methods are optional, so a host without them (mobile v0.1) keeps the plain card. (MYND-268)

### **AI-excluded folder** &nbsp; 📦 *Product*

A folder the user has excluded from on-device AI ([local inference](#local-inference)): notes inside it (and its subfolders) are never chunked, embedded, summarized, tag-suggested, or offered ghost-text completions. Backed by the additive `ai_excluded_folders` field in the encrypted `vault.prefs` (`MYP1`), canonical trailing-slash folder paths (SYNC-14). Enforced at **both** embed-time (excluded notes are never added to the RAM vector store) and query-time (defense-in-depth), so an excluded note's plaintext never reaches the model. The whole AI surface is additionally gated on the `ai_enabled` pref (default off). See `threat-model.md` §7 "Local AI".

### **auto-lock on idle** &nbsp; 📦 *Product*

A security control that locks the vault after a period of device inactivity, bounding the exposure window of an unattended unlocked Myne (`threat-model.md` A6). A backend-authoritative, fail-closed idle timer fires at a configurable timeout; the lock has two legs — (1) unconditional in-memory key zeroize ("no further notes decryptable"), and (2) best-effort teardown of the decrypted open note (a synchronous OS-level window hide plus a WebView reload). **"Idle" means machine-level** device idle (no input to the whole machine, not merely the Myne window), read per-platform (`GetLastInputInfo` / `CGEventSourceSecondsSinceLastEventType` / `XScreenSaverQueryInfo`); on Wayland, where no portable OS-idle API exists, it falls back to window-level idle as a fail-secure (more-eager) degradation. The timeout preference lives in the encrypted `vault.prefs` blob (`auto_lock_seconds`); the protection itself is always on (see **AUTO_LOCK_CEILING**). Moves A6 from ❌ Out-of-scope to 🔒 Mitigated — deliberately not a 🛡️ Strong guarantee, since freed-page RAM, swap, and hibernation are not scrubbed (A7/A10).

Used in: `threat-model.md` §1 (A6); `decisions.md` 2026-05-30 "Auto-lock on idle"

### **AUTO_LOCK_CEILING** &nbsp; 📦 *Product*

The code-enforced upper bound on the auto-lock timeout — the load-bearing edge of auto-lock's *protective envelope*. The effective timeout is `clamp(vault.prefs value or default, FLOOR?, AUTO_LOCK_CEILING)` and the enabled flag is a code constant, not a preference. Because the ceiling and the always-on flag live in code rather than the replayable `vault.prefs` blob, a disk-level attacker (A4) who replays, deletes, or tampers the preferences file can only make auto-lock *stricter* — never disable it or push it past the ceiling. This is why auto-lock does **not** inherit the local-prefs-replay limitation (`threat-model.md` §7) that best-effort preferences such as the screen-capture toggle do.

Used in: `threat-model.md` §7; `decisions.md` 2026-05-30 "Auto-lock on idle"

### **backup schedule** &nbsp; 📦 *Product*

The device-local configuration that drives a vault's [scheduled backup](#scheduled-backup) (MYND-351): per-`VaultId` it records `enabled`, the cadence (`every-unlock` / `daily` / `weekly`), the target folder, the retention count N, the written-backup ledger (the prune allowlist), and the per-device status/clock (`last_scheduled_success_at`, `last_backup_attempt_at`, `last_backup_status`). Persisted as best-effort plaintext JSON at `<app_data_dir>/vaults/backup-schedule.json` — a sibling of the `registry.json` cache, modelled on it, and Myne's first persistent device-local *user-setting* store. It deliberately stores plaintext filesystem paths (the target folder + ledger), a recorded departure from `registry.json`'s no-paths discipline — backups are ciphertext, so a known location is not a confidentiality break (`decisions.md` 2026-06-18). The schedule does **not** sync across devices (the target is per-device); its clock is intentionally separate from [last_backup_at](#last_backup_at) (the synced reminder clock).

Used in: `decisions.md` 2026-06-18; `myne-agents/features/scheduled-local-backup/`

### **backup-key** &nbsp; 🗝️ *Key/identifier*

A subkey context string (`"myne.v0.1 backup-key"`) **reserved but not used in v0.1** (demoted 2026-06-10; the entry previously claimed it encrypts exported backup files). The v0.1 [vault backup file](#vault-backup-file) is a verbatim ciphertext copy with no outer encryption layer; the demotion rationale lives in the §3.4 registry row and `decisions.md` 2026-06-10. Retained, like `server-auth`, so the context string stays allocated for a potential future sealed-backup variant. **Unrelated to [built-in backup](#built-in-backup)** — that is the operator's restic repository, not a Myne subkey.

### **built-in backup** &nbsp; 📦 *Product*

The Phase 2 sync server's **server-native** encrypted off-box backup (`decisions.md` 2026-07-14; MYND-505): when the operator sets `MYNE_BACKUP_*` (repository, password file, interval), [`myne-server`](#blind-blob-store) drives a **bundled restic** to snapshot its own fs store to an off-box target on a schedule, pruned to a disclosed retention window (default 14 days). **Disabled by default**; enabling requires the fs backend + a repository + a password file. Hosted and self-host use the **same mechanism** (TB5 parity) — a self-hoster gets the same durability with no separate tooling. Confidentiality is unchanged: blobs are already client-encrypted and the server holds no `root_key`, so restic's encryption's load-bearing job is protecting `auth.json` and bounding how long a deleted blob survives off-box (`threat-model.md` §7). Distinct from **[backup-key](#backup-key)** (a reserved client subkey for a future sealed-backup variant) and the client **[vault backup file](#vault-backup-file)** (`.myne-backup`, a device-side whole-vault export) — a different actor (the operator) and a different asset (already-encrypted server ciphertext).

Used in: `decisions.md` 2026-07-14; `self-host-policy.md` §4

Used in: `spec/protocol.md` §3.4, §9.11; `decisions.md` 2026-06-10

### **base import** &nbsp; 📦 *Product*

A one-way, **accepted-lossy** adapter that reads an Obsidian *Bases* `.base` file (plain YAML describing views over the user's own notes) and maps the representable subset onto Myne's canonical [saved view](#saved-view) schema (Saved Views epic, MYND-276). It is **import-only** in v1 (export is the future MYND-279) and a derived bridge — Myne does **not** own or round-trip the `.base` format. Unsupported filter clauses (anything outside the closed [filter AST](#filter-ast) allow-list — `list.map`/arithmetic/`file.hasLink`/`file.mtime`), and the `formulas` / `summaries` / `properties`-display blocks, are **dropped and counted** (no formula/code-eval exists to honor them — the no-database/no-formula commitment of [vision](#vision)); a clause-level warning tally surfaces exactly what came across and what didn't (SYNC-12). Obsidian's recursive `file.inFolder()` matches Myne's subtree-inclusive engine leaf, so that mapping is direct. The reader reuses the vendored YAML parser + the shipped importer file seam (no new dependency / capability), parses in RAM only (PS-1), and persists into the existing `vault.prefs` (`MYP1`) `saved_views` field (no new crypto). The "Bases" / "Obsidian" names are used **nominatively** only (what the importer reads), never as a productized Myne feature name.

Used in: `decisions.md` 2026-06-15; Saved Views (MYND-276)

### **bidirectional links** &nbsp; 📦 *Product*

*(Aliases: backlinks, wikilinks.)*

Links between notes that are queryable from both endpoints — opening a note shows which other notes link to it. Myne supports the `[[wikilink]]` syntax in v0.1 with a backlinks pane; the graph view (d3-force + hand-rolled render) is also part of v1.0 scope (`vision.md` Phase 1 Scope).

Used in: `vision.md` Phase 1 Scope

### **block anchor** &nbsp; 📦 *Product*

An Obsidian-style `^block-id` marker at the end of a line, addressable from a [wikilink](#bidirectional-links) as `[[Note^block-id]]`. Myne is **enumerate-only** about them (MYND-382): the `[[^^` picker mode lists, vault-wide, the anchors that already exist (e.g. imported from Obsidian) via the imported block-anchor records persisted in [`vault.indices`](#myi1) (`spec/protocol.md` §9.8.2), and emitting a link never mints a marker — note bytes are never rewritten to create one. Distinct from the `[[#`/`[[##` heading picker modes, which address document structure rather than an explicit marker. (`decisions.md` 2026-07-13)

### **bookmark note** &nbsp; 📦 *Product*

A content-light `.myn` note created by the [browser clipper](#browser-clipper) holding a source URL (bare autolink) + title + `source:` / `clipped:` frontmatter; no page body. Participates in tags / backlinks / graph / saved views as an ordinary note. Re-clipping a URL creates an independent note (no dedup detection in v1).

Used in: `browser-extension` epic, MYND-447

### **BIP-39** &nbsp; 🏗️ *Construction* (deep entry, *Myne-divergent*)

*(Aliases: mnemonic phrase encoding. Myne-divergent: yes — encoding only.)*

Bitcoin Improvement Proposal 39, defining a mapping from random entropy to a sequence of human-friendly English words plus a checksum. **Myne uses BIP-39 only as an encoding** for 256-bit recovery phrases — the 24 words present, capture, and re-enter 256 bits of secret entropy plus an 8-bit checksum. Myne does **not** use BIP-39's standard PBKDF2-HMAC-SHA512 with 2048 iterations to derive a wallet seed; that derivation is too weak by 2026 cryptographic standards. Instead, the normalized phrase string is fed directly to Argon2id with the protocol's standard parameters to derive `recovery_wrap_key` (`spec/protocol.md` §7.1). This divergence is intentional and load-bearing for the recovery-phrase security argument.

Used in: `spec/protocol.md` §7
Reference: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki

### **bootstrap-fingerprint** &nbsp; 📋 *Protocol*

A short, eye-comparable code derived from a [vault head](#vault-head)'s [head_id](#head_id), compared **out-of-band** between two devices at the device-approval moment to harden the [TOFU bootstrap](#tofu-bootstrap) of a newly-enrolled device against a malicious server — the same role as Signal/Matrix safety numbers. A fresh device has no prior head to compare against, so its first adopted state would otherwise be taken on faith; the user eye-comparing the fingerprint on both screens turns "trust the server" into "verified against an existing trusted device". ~SAS-magnitude (tens of bits), not the full 32-byte MAC. v1 ships the substrate (the fingerprint is a deterministic function of `head_id`); the general always-available fork-audit fingerprint UI is v1.x. Phase 2.

Used in: `spec/sync-protocol.md` (vault head); `spec/protocol.md` §3.4 (MYND-416)

### **blind blob store** &nbsp; 📦 *Product*

The Phase 2 sync server's role: it stores **opaque ciphertext blobs and key-wrapping material only**, and performs **structural** operations on them — current-head pointer compare-and-swap, the per-note version-counter increment, quota accounting — but **never** decrypts, merges, or interprets content (A1; TB5). Plaintext, decryption keys, and the master password never leave the client. Conflict resolution is consequently client-side (`sync-protocol.md` §10). "Blind" = the server is structurally incapable of reading what it relays; self-hosted and hosted operators are identical in this respect (TB5). Phase 2.

Used in: `spec/server-protocol.md` §1–§2

### **bottom bar** &nbsp; 📦 *Product*

The 28px status bar pinned to the bottom of the editor (`BottomBar`, `src/screens/Editor.tsx`). Hosts the connection/sync status text, the [save-status](#optimistic-ui-rollback) badge, and the persistent affordances for the [tag browser](#tag-browser), Saved Views, the whole-vault graph, Settings, vault Lock, and the live document-statistics readout (characters / words / spaces / paragraphs — selection-scoped when a non-empty selection exists, the full breakdown in its hover title; MYND-339, reusing the `word-count` item id). **Bottom-bar customization** (2026-06-15) lets the user hide/show each item via a right-click context menu; the hidden set persists per-vault in the `vault.prefs` `hidden_bar_items` field (set semantics, omitted-when-empty — a fully-visible bar is byte-identical to a pre-feature vault). The bar root stays right-clickable even when fully emptied, which is the only restore path (no Settings-panel mirror). There is deliberately **no** separate top bar — the top controls float into the OS title-bar row (MYND-166).

Used in: `decisions.md` 2026-06-15 "Bottom-bar customization"; `spec/protocol.md` §9.5.2 (`hidden_bar_items`)

### **BLAKE3** &nbsp; 🔐 *Primitive*

A modern hash function and KDF with strong parallelism characteristics. **Not used in Myne v0.1** — researched as an alternative to HKDF-SHA-256 for subkey derivation but rejected (Deferred #2 in `decisions.md`) in favor of HKDF-SHA-256 for libsodium compatibility, MLS alignment with v005, and a smaller dependency surface. The "structural context binding" advantage that BLAKE3 `derive_key` offers is recovered at the codebase level by Myne's single-canonical-helper pattern (§3.2.1).

Used in: `decisions.md` (Deferred #2 rationale)
Reference: https://github.com/C2SP/C2SP/blob/main/BLAKE3.md

### **browser clipper** &nbsp; 📦 *Product*

*(Alias: clipper extension.)*

Myne's **keyless** browser extension (`browser-extension` epic, MYND-442) that captures a web article / selection or a page URL, converts it to **markdown in the page**, and hands it to the desktop core over a [native-messaging host](#native-messaging-host) bridge to be encrypted into the vault. The desktop — not the extension — canonicalizes that markdown to exact [D1](#myne-markdown-dialect-d1) via the [clip serializer](#clip-serializer) (MYND-444: dialect-emit dependencies stay out of the hostile browser runtime, a TB10 boundary property). Holds no key; runs outside TB2; saves to the vault root with no capture-time folder/tag selection; never reads or decrypts the vault. Ships in the separate `myne-clipper` companion repo.

Used in: `browser-extension` epic, MYND-442

### **bug bounty** &nbsp; 🛠️ *Tooling*

A public-facing page listing known security reports and their resolution status, plus a mechanism to receive new reports. Cash payouts are not required at v0.1; acknowledgment-only is acceptable per the compensating-controls plan in `threat-model.md` §6.

Used in: `threat-model.md` §6

### **cargo-vet / cargo-audit** &nbsp; 🛠️ *Tooling*

Rust-ecosystem tools for auditing transitive Cargo dependencies for known vulnerabilities (cargo-audit) and for crowd-sourced trust attestations (cargo-vet). With the Tauri/Rust stack decision, these are part of Myne's supply-chain defense (`threat-model.md` §7).

Used in: `threat-model.md` §7

### **Candle** &nbsp; 🛠️ *Tooling*

The minimalist pure-Rust ML framework (`candle-core` / `candle-nn` / `candle-transformers`, from Hugging Face) Myne uses to run [local inference](#local-inference) on CPU — quantized GGUF generation + BERT embeddings. Added with `default-features = false`, so the model-download crate families (`hf-hub` / `http`) never enter the tree (models are side-loaded, SYNC-1/2). It **ships in the default build** as of `decisions.md` 2026-07-02 (the `local-inference` feature moved into `default`); the zero-ML-symbol auditable binary is now the `--no-default-features` build rather than the default. The largest single third-party surface Myne takes; no-egress is enforced as an absolute property of the shipped tree by a CI denylist gate.

### **ChaCha20-Poly1305** &nbsp; 🔐 *Primitive*

The IETF AEAD specified in RFC 8439, using the ChaCha20 stream cipher and the Poly1305 MAC with a 96-bit nonce. **Not directly used in Myne** — the protocol uses the *extended-nonce* variant XChaCha20-Poly1305 (192-bit nonce) wherever AEAD is invoked. Plain ChaCha20-Poly1305 is referenced only when distinguishing the two; readers must not conflate them.

Used in: `spec/protocol.md` §5.1
Reference: RFC 8439.

### **catalog sync-id** &nbsp; 📋 *Protocol*

The reserved 16-byte sync-plane identifier of the [`vault.attachments`](#vaultattachments) catalog under Phase 2 sync: `DeriveSubkey(root_key, "catalog-sync-id")[0..16]` (`spec/protocol.md` §3.4; MYND-468). The catalog is a synced singleton **outside** the head manifest (`spec/sync-protocol.md` §4.2), so it needs a stable blob-id every device derives identically; because the id is `root_key`-keyed pseudorandom bytes, the server cannot distinguish the catalog's record from a note's. Derives an *identifier*, not key material — the catalog KEK stays `attachments-catalog-key`. Excluded from the manifest by construction. Phase 2.

### **chord** &nbsp; 📦 *Product*

A single keyboard-shortcut combination, e.g. `Mod-Shift-g` (hotkeys epic, MYND-304). Myne's canonical chord string is CodeMirror-`KeyBinding.key`-compatible: a `-`-separated sequence of modifier tokens followed by one logical key, using the cross-platform `Mod` token (Cmd on macOS, Ctrl elsewhere) and the layout-respecting *logical* key (what the user sees on the key, not the physical `code`); single-character keys are lowercased. Stored NFC-normalized inside `vault.prefs` (the `keymap` field). See **keymap**, **key binding**.

Used in: `spec/protocol.md` §9.5.2

### **clip** &nbsp; 📦 *Product*

A captured web article or selection written into the vault as an ordinary [`.myn`](#myn-file) note by the [browser clipper](#browser-clipper). Authored content emitted as canonical [D1](#myne-markdown-dialect-d1) by the [clip serializer](#clip-serializer); images imported as [`MYA1`](#mya1) attachments; saved to the vault root.

### **clip serializer** &nbsp; 🛠️ *Tooling*

*(Alias: D1 clip serializer.)*

The desktop-side `@lezer/markdown`-tree → canonical-D1 emitter that normalizes a clip's Defuddle-produced markdown to Myne's exact dialect — the **first markdown serializer in the codebase** (the dialect layer was previously parse-and-project only). Faithful tables / code / math with safe-degrade (never emits broken markdown).

Used in: MYND-444

### **code-signed releases** &nbsp; 🛠️ *Tooling*

Myne desktop installers and auto-update payloads are cryptographically signed with hardware-backed keys controlled by the team. Auto-update verification (`threat-model.md` §3 TB7) refuses any artifact that fails signature or hash check. The signing keys are themselves the largest unmitigated risk against A9 (compromised distribution).

Used in: `threat-model.md` §3 TB7, §6

### **CodeMirror 6** &nbsp; 🛠️ *Tooling*

The code-editor framework used as the markdown editor in Myne's Phase 1 desktop client. Provides syntax highlighting, live preview, and the foundation for `[[wikilink]]` parsing. Same library that Obsidian uses internally.

Used in: `vision.md` Phase 1 Scope

### **color label** &nbsp; 📦 *Product*

A user-assigned color on a sidebar note or [folder](#folder) row, rendered as a small dot (the title text stays in the ink ramp; a colored left-border is banned by `PRODUCT.md`). Persisted as the `item_colors` field of [`vault.prefs`](#vaultprefs) — an optional nested-object map from a note UUID **or** canonical trailing-slash folder path (discriminated by the trailing `/`, like [item order](#item-order)) to a [label slot](#label-slot) name; NFC-normalized, lexicographically-keyed, omitted-when-empty (`spec/protocol.md` §9.5.2). Note-keyed entries survive note rename/move (the UUID is the filename); folder-keyed entries are prefix-rewritten on folder rename/move and pruned on delete; a stale entry is ignored at render and pruned on the next write. **Non-load-bearing** (cosmetic, AS-low) — a tampered/replayed blob can at worst surface the wrong color. Notes **and** folders both take a color (contrast [custom folder icon](#custom-folder-icon), folders only). See also [label slot](#label-slot), [PrefsView](#prefsview). (MYND-184)

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-07

### **comment (markdown)** &nbsp; 📦 *Product* *(Myne-divergent: yes — unterminated `%%` is inert, unlike Obsidian)*

An editor-only note-to-self in note body text, written `%%text%%` inline or `%%`…`%%` as a block / multi-line span (`spec/markdown-dialect.md` §3.1 / §3.2, MYND-315). The comment is **recognize-and-render-only**: it is rendered **dimmed** in the editor (a de-emphasis [decoration](#cursor-aware-reveal) mutes the span — it stays VISIBLE as a comment, never hidden; "hidden in render" means hidden in the output/export, not the editor) and is **stripped from lossy projections** — HTML, PDF, stripped-TXT, and document statistics — via the single §6 sanctioned export transform (one shared recognize-strip pass over the parsed `DialectComment` / `DialectCommentBlock` nodes). The source `%%` bytes are **never rewritten** (§6 C1), so the byte-verbatim `.md` export keeps them: a comment is author content that survives a walk-away. **Termination is required** — a `%%` with no closing `%%` is **inert** (stays literal text, hides nothing), a deliberate divergence from Obsidian's unterminated-`%%`-swallows-to-EOF behavior, chosen to avoid a "half my note vanished" surprise. No authoring affordance produces a `%%` (render-only, like sub/sup). Distinct from an HTML `<!-- -->` comment (a separate construct).

Used in: `spec/markdown-dialect.md` §3.1, §3.2, §3.7.5, §6, §8; `decisions.md` 2026-06-17

### **command palette** &nbsp; 📦 *Product*

Global keyboard-first action launcher in the Phase 1 desktop client, opened via `Cmd+K` / `Ctrl+K`. Renders a centered modal with a fuzzy-match input + scrollable action list; ArrowUp/Down navigates, Enter runs the highlighted action, Esc dismisses. v1 ships five actions across Vault / App / Navigation / Editor categories: Lock vault, Open settings, Switch to note (transitions into a note-picker sub-palette), Import Obsidian vault (disabled stub for Phase 1.x), Convert wikilinks in this note (disabled stub for `editor-mvp-wikilinks`). Action visibility respects the current `Stage` — non-editor stages hide editor-only actions; the palette never exposes actions unavailable in the current state. The action registry is a frozen `readonly CommandAction[]`; no plugin / scripting API is introduced (acceptance criterion enforced structurally). Distinct from the editor's **slash command** menu, which is editor-internal (cursor-anchored) and bound to insertable markdown elements.

Used in: `myne-agents/features/editor-mvp-baseline/prd.md` (T7), `src/commands/`

### **compelled lawful access** &nbsp; ⚠️ *Threat*

Adversary class A2: subpoena, court order, national security letter, or other legal compulsion forcing the operator to disclose user data. Myne's strong guarantee against A2 is architectural — the server cannot disclose what it does not possess. The disclosure-forced set is limited to ciphertext blobs, hashed account numbers, transient connection IPs, version counters, and aggregate storage size.

Used in: `threat-model.md` §1 (A2)

### **conflict copy** &nbsp; 📋 *Protocol*

The artifact of [keep-both conflict resolution](#keep-both-conflict-resolution): when the sync engine detects a concurrent edit, it materializes the remote revision as a **new** `.myn` note carrying the Myne-managed `conflict: true` + `conflict_of: <original note_uuid>` frontmatter fields (`spec/markdown-dialect.md` §3.6.1) so both edits survive. A conflict copy is excluded from the live sidebar, folder-tree, full-text search, and the backlink resolver — surfaced only in the **Conflicts view**, reached via a count badge — until the user resolves it ("Keep as separate" clears the markers so it re-enters the live set; "Discard" deletes it). TS orchestrator (`src/notes/conflictCopy.ts`) over `note_create` + `patchFrontmatterField`; no backend command, no `.myn` envelope change (MYND-427). Phase 2.

### **content_type** &nbsp; 📋 *Protocol*

A length-prefixed UTF-8 string carried in the AAD of content-encryption AEAD operations. In v0.1 it is always `"text/markdown"`; the field exists so v005 can introduce attachments (with content types like `"image/png"` or `"application/pdf"`) without breaking the AAD layout.

Used in: `spec/protocol.md` §5.2

### **contentless poke** &nbsp; 📋 *Protocol*

The Phase 2 sync change-notification signal: a **zero-payload** "vault changed, come pull" message carrying **no note-id, no version, no count, no cursor** — anything beyond mere arrival would leak which/what/how-much changed to the untrusted server or a network observer (A13). Polling is the **privacy-default baseline** (a device appears online only at poll time); the poke (over SSE) is an **opt-in low-latency** layer. Presence + timing of a poke is intrinsic A13 (a push already reveals it) and accepted; no payload is added on top. See [sync cursor](#sync-cursor). Phase 2.

Used in: `spec/sync-protocol.md` §8

### **context string** &nbsp; 📋 *Protocol*

A canonical UTF-8 string passed as the `info` parameter to HKDF-Expand to domain-separate one subkey from another. Myne context strings are drawn from a registered table (§3.4) and follow the format `"myne.v0.1 " || role`. The `derive_key` pattern (§3.2.1) is the only sanctioned way to construct and use them.

Used in: `spec/protocol.md` §3.2, §3.4

### **context string registry** &nbsp; 📋 *Protocol*

The table in `spec/protocol.md` §3.4 listing every authorized context string and its role for v0.1. Adding a new role in a minor revision means adding a row to the registry, not bumping the protocol version. Registered roles in v0.1: `itemsKey-wrap`, `prefs-key`, `search-index-key`, `attachments-catalog-key`, `attachments-id-hmac` (active), plus `server-auth`, `backup-key`, and `vault-head-mac` (all reserved — derived material unused in v0.1; `backup-key` demoted 2026-06-10; `vault-head-mac` is the Phase 2 [vault head](#vault-head) MAC key, MYND-416). v005 strings will be registered under the `"myne.v005 "` prefix.

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

Used in: `spec/markdown-dialect.md`, `myne-agents/features/editor-mvp/rfc.md`

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

### **default new-note location** &nbsp; 📦 *Product*

The user preference, exposed in Settings → **Files**, controlling where a newly-created note is filed. Two `vault.prefs` fields carry it (`spec/protocol.md` §9.5.2): **`new_note_location`** — a mode of `root` (the vault root, the default), `current` (the same folder as the currently-active note, derived from its `folder:` frontmatter, falling back to root when no note is selected), or `specific` — and **`new_note_location_folder`**, the canonical trailing-slash target folder used only in `specific` mode (also registered as a [deliberate folder](#deliberate-folder) so it survives empty). The preference applies only to the root-level create paths (⌘N, the palette, "+ New Note", a new tab); an explicit folder target (the folder context-menu "New note here") is authoritative and bypasses it. Non-load-bearing. See [decisions.md](decisions.md) 2026-06-27 (MYND-462).

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-27 (MYND-462)

### **deleted field** &nbsp; 📋 *Protocol*

The Myne-managed canonical frontmatter field `deleted:` — a **value-strict** RFC 3339 UTC timestamp marking a note as a **sync deletion tombstone** (the exact twin of `trashed:`; any non-timestamp value leaves the note live). Under sync a delete is rerouted (`src/notes/deleteNote.ts::deleteNoteRouted` → `tombstoneNote` via `patchDeletedField`) to a `deleted: <now>` version the [vault head](#vault-head) commits, so the deletion **propagates** to other devices and cannot be silently resurrected by the blind server; a local-only delete stays the hard cryptographic-erase `unlink`. Excluded from sidebar / folder-tree / search like `trashed:`; GC'd at the [tombstone horizon](#tombstone-horizon). Rides the existing `.myn` AEAD envelope — no `protocol.md` magic-byte / AAD / version change (MYND-426). Phase 2. See [markdown-dialect.md](spec/markdown-dialect.md) §3.6.1.

### **deleted-attachment tombstone** &nbsp; 📦 *Product*

The styleable placeholder an editor embed renders when its [attachment-id](#attachment-id) no longer resolves. Note bodies are **never** rewritten on deletion — the `![[att:<id>|filename]]` reference dangles intentionally and the resolver renders a tombstone, distinguishing a *deleted attachment* (id once existed, removed from the library) from a *broken reference* (id never existed). One shared component across the editor and the attachments library. Consistent with the no-auto-GC, explicit-delete-only attachment lifecycle. **Distinct from** the [attachment catalog tombstone](#attachment-catalog-tombstone), which is the *synced catalog-entry deletion marker* (Phase 2), not a UI element. (MYND-164)

### **deliberate folder** &nbsp; 📦 *Product*

A folder the user explicitly created that persists in the sidebar tree even when it holds no note. Because the virtual-folder model derives folders from each note's `folder:` frontmatter, an empty folder has no note to carry it; deliberate folders are therefore persisted as a set (the top-level `deliberate_folders` array) inside the encrypted `vault.prefs` (`spec/protocol.md` §9.5.2). The set is *cold* — written only on explicit folder create / delete, never on note move — and merges as a union (add-wins) under Phase 2 sync. A folder that exists only because notes carry its path is *implicit* and vanishes when its last note leaves; a deliberate folder survives. Identity is case-fold + NFC (`spec/markdown-dialect.md` §3.6.2). See also [folder](#folder), [item order](#item-order).

Used in: `spec/protocol.md` §9.5.2, `spec/markdown-dialect.md` §3.6.2; `decisions.md` 2026-05-29

### **DEM (Data Encapsulation Mechanism)** &nbsp; 🏗️ *Construction*

The symmetric-encryption layer in a hybrid encryption scheme — pairs with a KEM. Myne does not use KEM-DEM in v0.1 (no asymmetric encryption); referenced in the v005 roadmap for sharing operations.

Used in: `spec/protocol.md` §11 (out of scope for v0.1)

### **derive_key pattern** &nbsp; 📋 *Protocol* (deep entry)

Myne's mandated single-helper pattern for subkey derivation. All HKDF-Expand calls in the protocol go through one canonical function — `DeriveSubkey(rootKey, role) → 32 bytes` — which constructs `info = "myne.v0.1 " || role` from the registered role table (§3.4). Direct calls to HKDF-Expand outside this helper are forbidden by code review. The pattern recovers the API-level safety of BLAKE3's `derive_key` (where context is a first-class argument) while keeping HKDF-SHA-256 as the underlying primitive for libsodium and MLS alignment. Without this helper rule, HKDF's historical misuse mode (malformed or empty `info` parameters) would re-emerge.

Used in: `spec/protocol.md` §3.2.1

### **device-approval gate** &nbsp; 📋 *Protocol*

The server authorization step that admits a newly-enrolled device onto an account, **separate from** the SCRAM proof of account ownership (`spec/server-protocol.md` §3.1). The **first** device on an account and any **recovery-path** device **self-approve** (the bootstrap exception — the 24-word phrase already grants full account takeover); a new **password-path** device lands **pending** and syncs nothing until an already-approved device calls `/auth/devices/approve` for it (SYNC-9). It gates *enrollment*, not *authentication* — a pending device has proved the password but is not yet trusted to sync. Distinct from the [bootstrap-fingerprint](#bootstrap-fingerprint) eye-compare (which hardens the approval moment against a malicious server) and from the [per-device token](#per-device-token) (issued once the gate opens). Phase 2.

Used in: `spec/server-protocol.md` §3.1, §4 (MYND-425)

### **device-join QR** &nbsp; 📋 *Protocol*

A QR the trusted desktop displays and a phone scans to add itself to an account (MYND-466), in place of manually typing the [account_number](#account_number). A scanner-only, versioned (`MYQR`) frame carrying only non-secret material — `{server_url, account#, cert_pin, generated_at}` — and **never** a password or recovery phrase (SYNC-47). Ephemeral (≈3-min TTL) to enforce live co-presence. For a self-host endpoint the scan is treated as the out-of-band channel that **replaces the cert-fingerprint eye-compare** ([TOFU bootstrap](#tofu-bootstrap) / SYNC-26); the [device-approval gate](#device-approval-gate) SAS still runs post-approval. The account number is supplied by a one-time user paste on the desktop (it is a bearer token — [AS9](#account_number) — never persisted at rest; `spec/account-number.md` §8). `MYQR` lives outside the `protocol` crate (no ciphertext → not a major-version event). iOS-only for v1 (Android: MYND-465).

Used in: `decisions.md` 2026-07-19; `threat-model.md` §7

### **device key** &nbsp; 🗝️ *Key/identifier*

Reserved term for `appname-v005` multi-device support: a per-device asymmetric key pair stored in hardware (Secure Enclave / TPM / Android Keystore) that participates in MLS group formation. **Not used in v0.1** — single-device protocol does not need device keys.

Used in: `spec/protocol.md` §11 (out of scope for v0.1)

### **device_id (VV-actor)** &nbsp; 🗝️ *Key/identifier*

The permanent, client-generated 16-byte random identifier of a device as it appears in a [vault head](#vault-head)'s [version vector](#version-vector-vv). Allocated once at enrollment, registered in the per-account device table (**AS16**), and **kept separate from** the device's secret per-device token/credential: the token is revocable/rotatable (an availability control), whereas `device_id` is permanent *history* — deriving the id from the token would let a revocation rewrite version-vector history and break [fork-consistency](#fork-consistency) continuity. Its legitimacy is **not** separately authenticated and need not be: single-user → all devices share `root_key` → the shared-key head MAC is the actor-set authority, and a malicious server (lacking `root_key`) cannot inject a phantom `device_id`. A reset/re-enrolled device generates a **new** `device_id` (the old one's VV component freezes — never pruned in v1). Phase 2.

Used in: `spec/sync-protocol.md` (vault head, version vector)

### **device name** &nbsp; 📦 *Product*

The human-readable label the device list shows for one enrolled device — "Studio Mac", "Travel Laptop" — as opposed to its opaque [device_id](#device_id-vv-actor). Lives **only** in the `device_names` map inside the AEAD-sealed [vault.prefs](#vaultprefs) (`spec/protocol.md` §9.5.2), keyed by the `device_id` hex: it is a [shared pref](#shared-pref) that merges **per key** by union, each entry racing on its own `device_names/<key>` clock (`spec/sync-protocol.md` §10.2). Set at enrollment from an editable field pre-filled with a platform word, and changeable afterwards from **any** device. Three properties are load-bearing and easy to get wrong: it is **never sent to the server in plaintext** — no name field exists in the enrollment request or the device roster (TB5); it travels only inside the AEAD-sealed `MYP1` blob, a **pending** device's name is never shown to the approving device (a label beside an unverified device would read as a trust signal and weaken the [bootstrap-fingerprint](#bootstrap-fingerprint) compare), and there is **no delete** — union merge cannot propagate a removed key, so a name can only ever be replaced. Distinct from the vault `label` (which names a *vault*, not a device). Phase 2.

Used in: `spec/protocol.md` §9.5.2; `spec/sync-protocol.md` §10.2; `decisions.md` 2026-07-25 (MYND-548)

### **device registry** &nbsp; 📦 *Product*

The Phase 2 server's per-account table of enrolled devices, the server-side record that makes **revocation** possible (AS16 — device count per account is server-visible by necessity). Keyed by the client-generated [device_id](#device_id-vv-actor) (the VV-actor), **distinct from** the secret per-device token. Revocation in v0.1 = token iptal (an **availability** control — it stops a device syncing; it is not forward-secret, which is a v005/MLS feature, `threat-model.md` §7). The device-approval gate that admits a new enrollment is a server authz concern (the ceremony is MYND-425). Phase 2.

Used in: `spec/server-protocol.md` §4; `threat-model.md` AS16

### **device-local credential** &nbsp; 🗝️ *Key/identifier*

A credential that lives only on one device and is **never synchronized**, because it is bound to that device's hardware. The v0.1 instance is the [quick-unlock credential](#quick-unlock-credential) blob (`vault.quickunlock`, `spec/protocol.md` §9.14): its wrap key is held in the OS keychain with `thisDeviceOnly` accessibility, so a copy on another device is inert. Contrast the master-password and recovery-phrase credentials, which are device-portable and ride in the synced `vault.meta`. Each device that opts into quick-unlock mints its own device-local credential.

Used in: `spec/protocol.md` §9.14, `decisions.md` 2026-06-16

### **device-local pref** &nbsp; 📋 *Protocol*

One of the two normative [vault.prefs](#vaultprefs) field classes of the Phase 2 prefs sync (`sync-protocol.md` §10.2, MYND-478): a preference that describes how *this device* presents, secures, or operates on the vault — security posture (`auto_lock_seconds`, `screen_capture_protection`), presentation (`theme`, the `editor_*` fields), input (`keymap`), screen-dependent UI layout, and device state (`last_backup_at`, `paired_extensions`). A device-local pref never crosses the merge — the local value always survives — even though the whole encrypted blob transits the server (the same bytes already leave the device inside backups). Contrast [shared pref](#shared-pref). Not to be confused with a [device-local credential](#device-local-credential), which is a *key-material* class.

Used in: `sync-protocol.md` §10.2; `decisions.md` 2026-07-13

### **domain separation** &nbsp; 📋 *Protocol*

The cryptographic principle that contexts which should not produce equal outputs from equal inputs MUST mix in a context-distinguishing string. Myne applies it pervasively: HKDF context strings (§3.2), AAD prefixes (§5.2), KDF-parameter binding (§4.3), and protocol-version magic bytes (§9, §10). Failure to domain-separate is the root cause of many published protocol vulnerabilities.

Used in: `spec/protocol.md` §3.2, §5.2

### **downgrade attack** &nbsp; ⚠️ *Threat*

An attack where the adversary forces the use of a weaker protocol version, KDF parameter set, or cipher suite than the one the parties would otherwise negotiate. Myne structurally prevents downgrade by binding the protocol version, KDF parameters, and AAD prefix into every AEAD tag — any tampering fails verification (`spec/protocol.md` §5.2, §10.5). The forward-incompatible major-version model adds a second layer: cross-major substitution fails because magic bytes and AAD prefixes differ.

Used in: `spec/protocol.md` §10.5

### **dual-credential wrap** &nbsp; 🏗️ *Construction* (deep entry, *Myne-divergent*)

Myne's pattern for unlocking the vault under either of two independent credentials. The 32-byte random `root_key` is wrapped under two keys: `password_wrap_key` (Argon2id of the master password) and `recovery_wrap_key` (Argon2id of the BIP-39 phrase). Both encrypted copies — `enc_root_key_password` and `enc_root_key_recovery` — live in `vault.meta` (§9.3). Either credential alone reconstructs the root_key; both must be lost to render the vault unrecoverable. The architecture cleanly extends to a third wrap (e.g., a hardware-backed WebAuthn-PRF unlock) in `appname-v005`.

Used in: `spec/protocol.md` §3.1, §9.3

### **drawing note** &nbsp; 📦 *Product*

A note whose editing surface is an **Excalidraw canvas** instead of the CodeMirror markdown editor. Stored as an ordinary `.myn` note carrying a value-strict `kind: drawing` frontmatter marker (the 11th Myne-managed canonical field, [`spec/markdown-dialect.md`](spec/markdown-dialect.md) §3.6.1) with the Excalidraw scene serialized into a ` ```excalidraw ` fenced body — so it rides the existing `MY01` envelope with **no protocol change**, syncs/exports like any note, and its text elements are searchable (projected to plain text). Embedded raster images are externalized to attachments (`MYA1`), referenced by a superset `![[att:<id>]]` block so the fail-closed GC never erases a live image. Powered by the vendored, egress-hardened Excalidraw engine (`decisions.md` 2026-07-14). Epic MYND-497.

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

### **effective ceiling** &nbsp; 📋 *Protocol*

The storage or device limit a server would actually enforce for one account: the per-account override from the [account policy store](#account-policy-store) when set, else the global default (`quota_override ?? plan ?? global default`; `decisions.md` 2026-07-13). Load-bearing rule: the [account status endpoint](#account-status-endpoint) and the push/enroll enforcement guard MUST resolve it through the **same** function, so a reported ceiling and a refusal cannot disagree. **`0` means unlimited**, never a ceiling of zero — the ordinary self-host posture, which clients render as usage with no limit, no meter and no upsell (`spec/server-protocol.md` §7.1; MYND-570).

Used in: `spec/server-protocol.md` §7.1; `decisions.md` 2026-07-13, 2026-07-26

### **export** &nbsp; 📦 *Product*

A one-shot, user-initiated operation that decrypts user content and writes it as ordinary **unencrypted** files to a destination the user explicitly chose via the OS file dialog — per-note markdown, the whole-vault markdown tree, attachment files, a rendered PDF, standalone HTML, or stripped plain text (HTML + plain text added by MYND-340). Export is the portability path ("you walk away with your files", `vision.md`): the markdown forms write the stored plaintext **verbatim** (frontmatter included; the only sanctioned mutation is the attachments-mode embed rewrite, `markdown-dialect.md` §6 — HTML's image-sidecar `src` rewrite is the same sanctioned-transform class). PDF/HTML/plain-text are **lossy projections**, not byte-stable round-trips of the source. Terminology wall: an export is never a [vault backup file](#vault-backup-file) (that stays exactly as encrypted as the vault) and never a snapshot (version history). Threat-model framing: a deliberate plaintext crossing of TB3 under user authority — the artifact is outside Myne's protection from the moment it is written (`threat-model.md` §3 TB3, §5). There is no plaintext *mode*: no watch, mirror, or export-on-save exists.

Used in: `threat-model.md` §3/§5, `markdown-dialect.md` §6, `decisions.md` 2026-06-11 (export suite)

### **extended retention** &nbsp; 📦 *Product*

A **self-host-only** operator flag (`MYNE_EXTENDED_RETENTION`) that disables the server's Layer-2 ciphertext reclamation, so deleted blobs are kept past the [tombstone horizon](#tombstone-horizon). A documented, deliberate **policy deviation**, never a default: it **weakens the user's "delete means gone" expectation** and the §6 operator obligation not to retain deleted ciphertext past the horizon. Hosted MUST NOT enable it. The structural guarantees (no plaintext, no required IP log) are unaffected — extended retention trades a retention-policy obligation, not a confidentiality guarantee. Phase 2.

Used in: `self-host-policy.md` §4, `server-protocol.md` §6, `decisions.md` 2026-06-20 (MYND-438/440)
### **extension pairing token** &nbsp; 🗝️ *Key/identifier*

A scoped, revocable, **append-only** credential (create-clip + is-unlocked-status only — never a vault key) issued to the [browser clipper](#browser-clipper) after an in-app Accept/Reject + numeric-challenge handshake bound to the exact extension ID. Crossing [TB10](#native-messaging-host) requires it; a compromised token cannot read, modify, or delete notes. The short numeric code compared during this handshake is the **pairing challenge** (a.k.a. numeric challenge): a 6-digit nonce drawn from the core CSPRNG, shown identically in the in-app pairing dialog and the extension so the user confirms both endpoints share one pairing attempt — a human-comparison value, never a key. The registry of issued/revoked tokens persists encrypted at rest in the [vault.prefs](#vaultprefs) prefs-family blob (`decisions.md` 2026-06-20) so pairing survives a restart and revocation is durable.

### **extractor version** &nbsp; 📋 *Protocol*

The 1-byte generation tag (`extractor_version`) on an [`MYE1`](#mye1) extracted-text blob (`spec/protocol.md` §9.15.1), distinct from `protocol_version`: it identifies which [attachment text extraction](#attachment-text-extraction) generation produced the cached text. Because an [attachment-id](#attachment-id) is content-addressed (the bytes are immutable), cached text never needs re-extraction at a fixed `extractor_version`; a **bump** — a better extractor, or the future OCR layer (MYND-441) — invalidates older blobs and forces lazy re-extraction plus a search-index [rebuild](#fall-to-rebuild) (the index records the version it was built under, §9.6.4). Bound into the blob AAD as well as the header byte so a tampered header cannot be silently accepted. (MYND-328)

### **fall-to-rebuild** &nbsp; 📋 *Protocol*

The fallback path for loading the [search index](#search-index) when the cached `vault.search` blob (`spec/protocol.md` §9.6) cannot be trusted or used — blob absent, magic / version mismatch, AEAD-verification failure, or an unreadable staleness manifest. Instead of incrementally reconciling the cached index against the notes, the client **rebuilds it from scratch** by decrypting every `.myn`. Rebuild always recovers the correct index, so `vault.search` carries no integrity-of-search burden: a disk attacker who deletes or corrupts it costs the user one slower unlock, nothing more. The complement of the **incremental reconcile** happy path (re-index only the notes whose `content_nonce` changed) — fall-to-rebuild is the always-correct safety net beneath it (`decisions.md` 2026-05-31).

Used in: `spec/protocol.md` §9.6.4

### **full-reconcile** &nbsp; 📋 *Protocol*

The Phase 2 sync recovery mode a device enters when incremental catch-up is impossible or untrusted — a [soft-retired](#soft-retire) device returning past the [tombstone horizon](#tombstone-horizon), or any device whose cursor is too stale to trust. Instead of replaying missed deltas, the device reconciles its entire local state against the server's authoritative manifest (the same decryption-free [content_nonce](#content_type) reconcile as [fall-to-rebuild](#fall-to-rebuild), §9.6.4): notes absent from the authoritative manifest are NOT resurrected, and local-only notes fall to a [keep-both conflict](#keep-both-conflict-resolution) copy rather than silently re-appearing. The structural defence against a server-driven resurrection past horizon-GC. Phase 2.

Used in: `spec/sync-protocol.md` §11

### **sync quarantine** &nbsp; 📋 *Protocol*

The client-side **drop disposition** of a [full-reconcile](#full-reconcile): a previously-synced note absent from the authoritative roster (deleted + horizon-GC-reclaimed remotely) is **moved aside** into the device-local `quarantine/` directory — never destroyed, never re-uploaded (`spec/sync-protocol.md` §11.3 "Reclaimed-record visibility"). Re-uploading would resurrect deleted content server-side and lose the reclaimed record's version CAS; destroying would let a lying server erase user data. Doubles as the hostile-server ceiling for roster manipulation: hiding records from the roster can at most cause a recoverable local move, gated to reconcile walks, never echoed back. A sync reset (`clear_device_local_sync`) deliberately does not touch it — it holds user data.

Used in: `spec/sync-protocol.md` §11.3, `decisions.md` 2026-07-17

### **favorites** &nbsp; 📦 *Product*

The user's chosen shortcut list of notes, surfaced in a dedicated Favorites section pinned above the sidebar tree. Persisted as the `favorites` field of `vault.prefs` — a **sequence** array of note UUIDs only (display order is the payload; NFC-normalized, not sorted, not deduped, omitted-when-empty), so favoriting is cheap view-state (a prefs write, no `.myn` re-encrypt) that reverts to empty on a tampered/absent blob (`spec/protocol.md` §9.5.2, §9.5.5). A favorited note **also** keeps its normal position in the tree — favoriting is a shortcut, not a move — so it renders in two rows (disambiguated by section-qualified keys); selection is keyed by note-id (both rows highlight) and keyboard navigation visits it once. Add via a hover star, the context menu, or dragging a note into the section; remove via star/menu only. A favorite UUID with no live note is ignored at render and pruned on the next write. See also [item order](#item-order), [PrefsView](#prefsview). (MYND-183)

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-02

### **filter AST** &nbsp; 📋 *Protocol*

The recursive, **closed-allow-list** tree that expresses a [saved view](#saved-view)'s query (Saved Views epic, MYND-272/MYND-273). A node is a boolean combinator (`and` / `or` / `not`) over a fixed leaf set — `hasTag` and `inFolder` (both subtree-inclusive), full-text `search`, a typed `property` comparison (`== != > < >= <= contains`, date compares on frontmatter dates only), and the degenerate `all`. There is deliberately **no** arithmetic / `list.map` / formula node: the type cannot represent one, so the query layer can never evaluate arbitrary code (the "no databases / no formula" anti-feature of [vision](#vision) expressed in the type system). Serialized canonically (`#[serde(tag = "kind")]`, camelCase kinds + operator literals) inside the `saved_views` field of [vault.prefs](#vaultprefs); the query engine reads it and the renderer never re-derives it. See also [saved view](#saved-view), [property](#property). (MYND-272 / MYND-273)

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-15

### **field clock** &nbsp; 📋 *Protocol*

The per-field LWW timestamp of the Phase 2 prefs sync (`sync-protocol.md` §10.2, MYND-478): an epoch-milliseconds integer, one per [shared pref](#shared-pref) LWW field (or per `device_names/<key>` entry), stored in the additive `field_clocks` map inside the encrypted [vault.prefs](#vaultprefs) payload (`spec/protocol.md` §9.5.2) and stamped by the setter that last changed the field. The merge takes the newer clock per field, counts an absent clock as 0 (pre-feature blobs), and breaks equal clocks byte-lexicographically toward the greater value — the attachments-catalog `filename` precedent — so replicas converge without coordination. Per-field (rather than per-blob) clocks are what let concurrent edits to *different* fields both survive.

Used in: `sync-protocol.md` §10.2, `spec/protocol.md` §9.5.2; `decisions.md` 2026-07-13

### **focus mode** &nbsp; 📦 *Product*

The editor's distraction-free writing state (MYND-348): a `Mod-Shift-F` toggle fades the in-app chrome (sidebars, tab strip, [bottom bar](#bottom-bar), floated title-bar cluster) and centers the column, so only the words remain. The fade is **in-app only** — a CSS rule keyed on the editor root's `data-focus-active` attribute, never OS fullscreen (no Tauri window-API capability is added). The active state is **ephemeral** React state (opt in each session, never auto-entered, not persisted to any blob). Exit via the toggle or **Esc** at low keymap precedence (the editor's autocomplete / multi-cursor consume Esc first). v1 also ships [typewriter scroll](#typewriter-scroll) and [line-focus dimming](#line-focus-dimming), each a Settings → Editor toggle (the `editor_focus_typewriter` / `editor_focus_dim_inactive` MYP1 fields, default on); the command palette and Settings open over focus and return to it on close. Threat-neutral (UI state + two cosmetic prefs fields). See also [typewriter scroll](#typewriter-scroll), [line-focus dimming](#line-focus-dimming).

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-17 (MYND-348)

### **folder** &nbsp; 📦 *Product*

A *virtual* organizational container for notes, shown as a nested tree in the sidebar. A note's folder is a slash-delimited path stored in its `folder:` frontmatter (`spec/markdown-dialect.md` §3.6.1); the on-disk layout never reflects it — `notes/<uuid>.myn` stays flat (`spec/protocol.md` §9.1), so folder structure is encrypted metadata (`threat-model.md` AS3) reconstructed client-side. The tree is a derived view: `dedup_union` of the ancestor-expanded paths from every note's `folder:` field and the [deliberate-folder](#deliberate-folder) set, under case-fold + NFC identity (`spec/markdown-dialect.md` §3.6.2). A folder carried only by notes is *implicit* and vanishes when its last note leaves; a deliberate folder persists when empty. Folders and folderless notes share a single interleaved tree at every level, ordered by [item order](#item-order) (MYND-183) — a folderless note is not bucketed into a separate section but renders at the root level alongside top-level folders. Distinct from a *tag* (a separate, non-hierarchical organizational axis that coexists with folders). See also [item order](#item-order).

Used in: `spec/markdown-dialect.md` §3.6.1–3.6.2, `spec/protocol.md` §9.1, §9.5.2; `decisions.md` 2026-05-29

### **folder note** &nbsp; 📦 *Product*

A note designated the **index note** of its [folder](#folder) via the value-strict `folder_index: true` frontmatter flag — the sixth [Myne-managed canonical frontmatter field](#myne-managed-canonical-frontmatter-field) (`spec/markdown-dialect.md` §3.6.1). The note indexes whichever folder its own `folder:` names; the binding is the boolean alone and carries **no path**, so a folder rename rewrites `folder:` and the binding follows for free (rename drift is structurally impossible). A folder has **exactly one** folder note. It is **hidden from the sidebar folder tree** — no separate row, no pin, no badge — and is opened (or lazily created on first activation) by **double-clicking the folder**; the undesignate inverse lives on the folder's context menu ("Remove folder note"). The hiding is **sidebar-tree-only**: unlike a [note template](#note-template) or a trashed note (hidden everywhere), a folder note stays a fully real, enumerable note in **search, saved views, backlinks, the graph**, and [`[[<folder>/]]`](#folder-target-wikilink) resolution — it is content the user reads, not a hidden skeleton (decisions.md 2026-06-27, supersedes the original "fully visible, pinned, badged" behaviour). Value-strict exactly like `template:`: only the canonical unquoted `true` designates it; `1` / `yes` / `"true"` / absence leave the note ordinary. Owned by the folder-note designate / undesignate actions (`src/notes/folderNote.ts`) only — never written by body autosave; surgery via `patchFolderIndexField`, read via `readFolderIndexFromFmBody`. If two in-folder notes both carry the flag (legacy / imported data only — the UI now prevents a second designation), a deterministic winner is chosen (smallest `note_uuid`) and the rest stay visible, flagged for the user to resolve. Rides the existing `.myn` AEAD envelope — no new magic byte, no AAD / version bump, no on-disk-layout change (within v0.1; forward-incompatible-by-design with v005). See also [folder](#folder), [folder-target wikilink](#folder-target-wikilink), [Myne-managed canonical frontmatter field](#myne-managed-canonical-frontmatter-field). (MYND-370)

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

### **fork-consistency** &nbsp; 🏗️ *Construction*

The integrity property a [vault head](#vault-head) provides against a malicious sync server (**TB5**) that cannot read or forge content but can still **rollback** (serve an older authentic blob), **withhold** (hide an update), or **equivocate / fork** (show different devices divergent histories). Following SUNDR (OSDI 2004): every update is committed into an unforgeable, monotonic, hash-chained head, so the server cannot *heal* a fork — once it shows two devices divergent heads, their [version vectors](#version-vector-vv) never re-converge and the split surfaces on the next cross-read. Fork detection is therefore **delayed and in-band** (caught when devices observe each other's state) or immediate only via an [out-of-band fingerprint](#bootstrap-fingerprint); a lone client with no external comparison cannot detect equivocation (the SUNDR theorem). Withholding of a device's *own* work is caught in-band; withholding of *other* devices' work / global staleness is best-effort. Phase 2.

Used in: `spec/sync-protocol.md` (vault head); `threat-model.md` §7

### **forward-incompatible major version** &nbsp; 📋 *Protocol* (deep entry, *Myne-divergent*)

Myne's architectural commitment that each major protocol version (v0.1, v005, v006, …) is a closed, complete specification with distinct magic bytes, AAD prefix, and context-string prefix. Cross-major reads happen only via explicit user-initiated migration (`spec/protocol.md` §10.4); a v005 client refuses to silently parse a v0.1 blob, and vice versa. The choice contradicts the additive-extension model common in TLS 1.0–1.2 and OpenPGP; the reasoning is that those protocols' downgrade-attack history (POODLE, FREAK, Logjam, MEGA-2022) shows additive extension to be a structural risk. v005's anticipated changes (PQ hybrid wrap, MLS multi-device, OPAQUE auth, KT log) are too deep to be additive in any honest sense.

Used in: `spec/protocol.md` §10.1

### **forward secrecy** &nbsp; ⚠️ *Threat*

The property that compromise of a long-term key does not enable decryption of past messages encrypted with derived ephemeral keys. Myne v0.1 does **not** provide forward secrecy — the persistent `itemsKey` is reusable across all notes for the vault's lifetime. The `appname-v005` roadmap introduces per-epoch `itemsKey` rotation that would provide forward secrecy by deleting old epoch keys after migration.

Used in: `threat-model.md` §7; `spec/protocol.md` §3.3 (forward-compat note)

### **free tier** &nbsp; 📦 *Product*

The permanent no-cost tier of [hosted sync](#hosted-sync): 250 MB storage / 3 devices per account, full protocol, full speed — differentiation from [Myne Sync](#myne-sync) is quantitative only (storage + device count), never speed, features, or guarantees (`decisions.md` 2026-07-13). Its existence revises the `server-protocol.md` §5.3 Sybil posture: a permanent free anonymous registration surface is accepted, bounded by the small quota, the device cap, and the registered-account ceiling — the payment gate remains the primary Sybil resistance for *meaningful* storage. Abandoned free accounts are never reclaimed: doing so would require persisting a new behavioral marker, and the zero-new-observation principle wins over the (bounded, accepted) dead-account storage cost.

Used in: `decisions.md` 2026-07-13

### **frontmatter** &nbsp; 📦 *Product*

The optional YAML metadata block delimited by `---` lines at the top of a note's decrypted markdown (`spec/markdown-dialect.md` §3.6). Carries the five Myne-managed canonical fields (`updated:` / `title:` / `folder:` / `trashed:` / `template:`, §3.6.1) plus arbitrary user-authored keys, all preserved byte-for-byte on write (unknown-field-preservation + §6 C1). The editor's recognizer only *delimits* the block; a separate read-only [property](#property) parse (Saved Views / MYND-271) reads the YAML *body* to type each key for the [property index](#property). Not to be confused with the inline `#tag` / frontmatter `tags:` distinction (§3.7).

Used in: `spec/markdown-dialect.md` §3.6

### **γ1+γ2 hybrid autosave** &nbsp; 📦 *Product*

The canonical Myne autosave call-pattern locked in `decisions.md` 2026-05-07 "`note_update` IPC … UI-level autosave coalescing": a UI-side state machine composing **γ1 idle-debounce** (a save fires after the user has been idle for N milliseconds since the last keystroke) + **γ2 max-debounce** (a save fires regardless every M milliseconds during sustained typing, so a writer who never pauses still gets a save) + a **latest-wins single-in-flight gate** (if a save is already in flight when another fire is due, the in-flight completes first, then a single follow-up save fires with the latest body — no IPC thrashing) + canonical **flush triggers** (`flush-on-vault-lock` from the original entry; `flush-on-blur` and `flush-on-window-close` pinned by `decisions.md` 2026-05-15). Phase 1 v0.1 timings are N=1000ms, M=10000ms. The pattern lives entirely in the UI; the Rust `note_update` command is stateless and plaintext-blind. Backend-side queueing (γ3) was explicitly rejected because the `notes` plugin holds no own state per `decisions.md` 2026-05-07 "notes plugin scaffold". The Greek-letter naming is internal shorthand inherited from the 2026-05-07 MYND-27 grill where four call-pattern alternatives were enumerated (α stateless, β stateful-handle, γ hybrid, δ deferred — α + γ shipped).

Used in: `decisions.md` 2026-05-07 (pattern), 2026-05-15 (concrete timings); MYND-81

### **ghost-text** &nbsp; 📦 *Product*

The dimmed inline completion the writing-assistant ([local inference](#local-inference)) shows at the cursor: a `Decoration.widget` overlay (never in the document buffer) rendering the model's short continuation in `--fg-3` italic, accepted with **Tab** (inserts it as plain markdown, one undo step) and dismissed by **Esc** or any edit. Fired on a paused cursor by a debounced CM6 `ViewPlugin` that cancels any in-flight inference on a doc/viewport change so a stale suggestion never lands. Composed into the editor only when `ai_enabled` (and the note is not an [AI-excluded folder](#ai-excluded-folder)). Modeled on the `spell.ts` StateEffect→StateField loader pattern (MYND-410).

### **graph view** &nbsp; 📦 *Product*

The visualization of `[[wikilink]]` relationships between notes as a force-directed graph. Myne Phase 1 includes a minimal graph view — [d3-force](#d3-force) layout + a hand-rolled canvas renderer — in a separate, lazy-loaded panel (`vision.md` Phase 1 Scope). Nodes are notes only (tags/folders are a filter dimension, not nodes); edges are resolved cross-note references.

Used in: `vision.md` Phase 1 Scope

### **hash-pinned dependencies** &nbsp; 🛠️ *Tooling*

Lockfiles checked into the repository that record the exact SHA hash of every direct and transitive dependency. Myne covers Cargo (Rust), npm (Phase 3 web UI), Go modules (server), and any WASM artifacts. Updates require explicit review.

Used in: `threat-model.md` §6, §7

### **head_id** &nbsp; 🗝️ *Key/identifier*

The identity of a single [vault head](#vault-head): `head_id = SHA-256(serialized full head record INCLUDING its head_mac)`. Hashing over the MAC (not just the pre-MAC content) makes the hash-DAG bind **authentication**, not merely content. A head's parent links (`prev_head_hash[]`) are the `head_id`s of its parents — one parent = linear extension, two = a legitimate concurrent-push merge (byte-sorted lexicographically for encoding determinism). Domain-separated from the [vault-head manifest](#vault-head-manifest) hash and the §5.1 [CTX commitment](#ctx-commitment) by a distinct leading prefix, so no SHA-256 input is reinterpretable as another's. Phase 2.

Used in: `spec/sync-protocol.md` (vault head)

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

### **IP-scrubbing proxy** &nbsp; 🏗️ *Construction*

The self-host bundle's TLS edge (a vetted Caddy reverse proxy) configured to **delete every client-IP-bearing field** from its access log (`remote_ip`, `client_ip`, `X-Forwarded-For`, `X-Real-Ip`, `Forwarded`). Caddy's *default* access log emits the client IP, so the scrub is explicit and load-bearing: it enforces the no-persistent-IP-logging commitment (C4/AS14) at the **edge**, complementing the app's in-process `noIP` middleware (defense in depth). An operator who fronts the bundle with their own load balancer inherits the obligation to scrub the IP there. Phase 2.

Used in: `self-host-policy.md` §3, `decisions.md` 2026-06-20 (MYND-438)

### **inline tag** &nbsp; 📦 *Product*

A `#`-prefixed identifier appearing inside note body text (as opposed to the YAML `tags:` frontmatter list). Recognized by the Myne dialect per `spec/markdown-dialect.md` §3.7. Boundary: line-start or whitespace must precede the `#`; `abc#tag` does not match. Character set: Unicode (excluding the General/Supplemental Punctuation blocks and an explicit ASCII-punctuation set). Numeric-only forms (`#1984`) reject; `#y1984` accepts. Nested forms via `/` (`#parent/child`) supported with unbounded depth. The parser only recognizes; never rewrites — byte-stability per §6 C1 extends to inline-tag bytes. Tag identity (case-fold, NFC normalization) is the consuming index layer's responsibility, not the parser's.

Used in: `spec/markdown-dialect.md` §3.7, §6 C1

### **insider threat** &nbsp; ⚠️ *Threat*

Adversary class A11: a Myne team member acting maliciously. The architecture grants the team no privileged read access — keys never leave the client. The single privileged asset is the code-signing key (TB8); compromise reduces to A9 (compromised distribution).

Used in: `threat-model.md` §1 (A11)

### **import-&-convert** &nbsp; 📦 *Product*

The explicit, byte-change-visible command that turns an imported filename-only image reference (`![[image.png]]`, `![alt](path)`) into a real vault [attachment](#attachment): it resolves the source file (auto-resolve, picker fallback), imports it via [attachment_import](#attachment_import), mints the [attachment-id](#attachment-id), and rewrites the reference to the form-C embed `![[att:<id>|filename]]` — with a mandatory diff-preview before commit (parallel to the wikilink R2 conversion command, `spec/wikilink.md` §189). No silent name-match; without invoking it, imported references stay an unrendered chip (byte-preservation, `spec/markdown-dialect.md` C1). (MYND-164)

### **import adapter** &nbsp; 📦 *Product*

A per-source reader that turns one external note format into Myne-dialect markdown for the [import source](#import-source) seam, so the shared ingest path needs no knowledge of the format. v1 ships four beyond the original Obsidian reader — Evernote (`.enex`), generic HTML, Notion (unzipped export), and CSV (importer-breadth epic, MYND-312). Every adapter is **accepted-lossy** in the [base import](#base-import) sense: it converts the representable subset, names what it could not represent, and never silently drops content (the loss is surfaced through the [import report](#import-report)). Adapters add **no new host capability** — all four read through the existing within-root-validated importer file seam, which is why a Notion export must be unzipped by the user first rather than extracted in-app. Source names ("Notion", "Evernote", "Obsidian") are used **nominatively** only — what the adapter reads — and are never productized as Myne feature names. Apple Notes is deliberately **not** an adapter: it publishes no export artifact, and every mechanism to reach its data would need an exception to the single-external-read-path rule.

Used in: `decisions.md` 2026-07-25

### **import report** &nbsp; 📦 *Product*

An ordinary generated note listing every note that imported successfully but **lost representable detail**, each as a [wikilink](#wikilink) plus its folder path and the names of the dropped constructs. It is the disclosure mechanism for **per-element** fidelity loss, which the pre-existing per-file drop tallies cannot express: an HTML→markdown conversion that loses a callout, a toggle, and coloured text still counts as one successfully imported note, so there is no honest integer to put in a summary row. Chosen over a persisted frontmatter marker specifically to avoid a [dialect](#dialect) commitment — it introduces no value-strict field, no round-trip clause, and no new spec surface, while still surviving the import session (a modal-only list is unrecoverable once dismissed on a large import) and remaining deletable in one action. (MYND-585)

Used in: `decisions.md` 2026-07-25

### **import source** &nbsp; 🏗️ *Construction*

The two-stage seam every [import adapter](#import-adapter) implements: `plan()` enumerates item **descriptors** cheaply (never note content), and `load()` yields one item's markdown at a time. The split is load-bearing in both directions — `plan()` keeps the progress denominator determinate for every source (a bare streaming generator cannot know the total until it has finished, breaking "Importing X of N"), while `load()` preserves the serial-ingest discipline that keeps only one note's plaintext in memory at once. It is also what lets a **one-file-many-notes** source exist at all: Evernote's single `.enex` holds N notes, a shape the original directory walk could not represent. Because every source funnels through one shared ingest loop, per-note fidelity loss has exactly one collection point rather than one per adapter. (MYND-579)

Used in: `decisions.md` 2026-07-25

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

### **internationalization (i18n)** &nbsp; 🛠️ *Tooling*

The desktop UI localization layer: `react-i18next` over bundled flat-per-namespace JSON **locale catalogs**, with **English** as the source language and per-key fallback. Catalogs ship inside the binary (no HTTP backend → no network egress for UI strings). Translated through self-hosted **Weblate**. Deliberately **excludes** load-bearing copy (`src/lib/load-bearing-copy.ts`) — those strings' exact wording is a privacy property and is E2E-pinned in English, so they render verbatim in every locale. Language is a device-local, pre-unlock preference (`localStorage` `myne.lang`), never `vault.prefs`.

Used in: `docs/dev/i18n.md`; `decisions.md` 2026-06-25; `src/i18n/`.

### **locale catalog** &nbsp; 🛠️ *Tooling*

A single language's translation file in the i18n layer: `locales/<lang>/<namespace>.json` (only namespace today: `common`). The English catalog (`locales/en/common.json`) is hand-maintained and is the runtime per-key fallback; every other catalog is **Weblate**-managed and must not be hand-edited in the repo (that races Weblate). New keys are added by `pnpm i18n:extract` (`i18next-cli`).

Used in: `docs/dev/i18n.md`; `locales/`.

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

### **keep-both conflict resolution** &nbsp; 📋 *Protocol*

The Phase 2 sync resolution rule for **note bodies**: when two devices concurrently edit the same note (detected by the push compare-and-swap rejecting a stale base), **both versions are kept** — the loser is written as a conflict-marked duplicate note for the user to reconcile — rather than silently picking a last-writer-wins winner (which would destroy an edit the server can't even see, A1). The paranoid Standard-Notes posture: no silent data loss. Distinct from the **singleton** resolution (post-decrypt field/set merge per `protocol.md` §9.5.2) and the **`vault.meta`** bespoke merge (preserves the recovery-side wrapped `root_key`, §9.3). Pure LWW on bodies is forbidden. Phase 2.

Used in: `spec/sync-protocol.md` §10

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
Used in: `src/editor/code-languages.ts`, `docs/decisions.md` (2026-05-29).

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

### **line-focus dimming** &nbsp; 📦 *Product*

A [focus-mode](#focus-mode) reading aid (MYND-348): every editor line except the one the cursor is on is visually dimmed, so the active line stands out. Implemented as a CodeMirror decoration gated by the editor root's `data-focus-dim` attribute (set only when focus mode is active **and** the `editor_focus_dim_inactive` MYP1 pref is on — default on; the Settings → Editor toggle flips it). Respects `prefers-reduced-motion` and the no-pulsing PRODUCT stance — it is a static opacity step, never an animated pulse. Toggleable because some writers find per-line dimming disorienting. Non-load-bearing cosmetic (AS-low). See also [focus mode](#focus-mode), [typewriter scroll](#typewriter-scroll).

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-17 (MYND-348)

### **link reference definition** &nbsp; 📦 *Product*

A `[label]: url` line (CommonMark "link reference definition") that supplies the destination for a [reference link](#reference-link) (`[text][label]`) or a reference-style image (`![alt][label]`) elsewhere in the same note. Labels match by CommonMark rules — case-folded with internal whitespace collapsed — and the first definition of a given label wins. In the Myne editor a shared collector scans all such definition lines into a `label → { target, range }` map; a definition referenced by a resolved reference link is hidden off-cursor (it reads as body noise otherwise) and revealed when the cursor enters its line. The definition bytes are preserved (§6 C1) and the form is never emitted by an authoring affordance. See also [reference link](#reference-link).

Used in: `spec/markdown-dialect.md` §3.2; `decisions.md` 2026-05-30

### **local inference** &nbsp; 📦 *Product* (*Myne-divergent*)

On-device AI: the local-ai epic (MYND-406–412) runs a **side-loaded** quantized Qwen2 GGUF (generation) and an all-MiniLM-L6-v2 BERT (embedding) through the [Candle](#candle) ML stack, entirely on the user's machine — no cloud model, no download, no telemetry, ever (a standing anti-feature). *Myne-divergent* because "AI" in most note apps means a server API call; here it is a local, **runtime opt-in beta** capability — it ships in the default build (`decisions.md` 2026-07-02) but stays off until the user enables it at Settings → Labs → AI (Beta) (`ai_enabled` pref, default off), and is verified to add **zero networked dependency** by an absolute denylist gate (`ai-no-network-check.sh`). The AI-free auditable binary is the `--no-default-features` build. Powers summarize, semantic search / Q&A, auto-tag, and the writing-assistant ([ghost-text](#ghost-text) + slash commands). Models are the user's own files (untrusted input); v0.1 runs the runtime in-process, with a sandboxed keyless sidecar deferred as pre-default-on hardening. AI outputs are AS1-class RAM, zeroized on lock; excluded per-folder via [AI-excluded folder](#ai-excluded-folder). See `threat-model.md` §7 "Local AI" + `decisions.md` 2026-07-01, 2026-07-02.

### **conversational AI chat** &nbsp; 📦 *Product*

The multi-turn chat surface of the AI Chat right-panel tab (`conversational-ai-chat`, MYND-454): a conversation the user can follow up on, with the assistant's answer **streamed** token-by-token (see [streaming token channel](#streaming-token-channel)) and grounded per-turn in the user's own notes (with visible [chat citations](#chat-citation)). It supersedes the earlier single-shot Q&A box. History is **RAM-only, dropped on lock** — no durable, at-rest chat storage in v0.1 (deferred), so no new magic byte or format. Powered by [local inference](#local-inference) (still fully on-device, no provider call); the model is small and fallible, which is why answers cite their sources. See `decisions.md` 2026-07-04; `threat-model.md` §7 (STI paragraph).

### **streaming token channel** &nbsp; 📋 *Protocol*

The IPC mechanism that streams a [local-inference](#local-inference) generation's tokens to the WebView as they are produced: a `tauri::ipc::Channel<String>` opened by the `chat_stream` command, each decoded token forwarded through a publish-guarded callback (checked against the shared cancel flag before every send, so a vault-lock mid-stream never emits into a torn-down transcript). It is the SYNC-7 "supersede" the local-ai ledger anticipated — streaming was deferred in the spike and added here for the [conversational AI chat](#conversational-ai-chat) surface. Each token is AS1-class plaintext (never logged, DENY-list). See `decisions.md` 2026-07-04.

### **chat citation** &nbsp; 📦 *Product*

A source-note reference shown beneath a grounded [conversational AI chat](#conversational-ai-chat) answer — the `{note_id, byte-range}` chunks the answer was grounded on (reusing the `AskResult.sources` set). Rendered as clickable chips (labelled with the note title) that navigate to the source note. Citations are the honesty counterweight to a small, fallible on-device model: the user verifies each claim against their own words. An answer that grounded on nothing shows no chips (no fabricated citation).

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

### **native-messaging host** &nbsp; 📋 *Protocol*

The small Rust stdio host in the Tauri core that receives a keyless clip handoff from the [browser clipper](#browser-clipper) and pipes it into the existing `note_create` / `attachment_import` pipeline. Allowlists the exact extension ID and treats every handed-off byte as hostile input (size caps, UTF-8 validation, no path traversal, re-sniffed MIME, rate limits). Defines trust boundary TB10.

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

### **Myne Sync** &nbsp; 📦 *Product*

The commercial name of the [hosted sync](#hosted-sync) paid plan — deliberately a **single** plan: 20 GB deduplicated-ciphertext quota (AS17) and 10 devices per account (`decisions.md` 2026-07-13; price points are business-sensitive and live outside this repo). One plan because hosted and self-hosted share TB5: the only honest differentiators are quantitative (storage + devices). Prepaid and time-based — a voucher extends `paid_until`; there is **no auto-renewal**, because nothing identity-bearing is kept on file for an anonymous account. Expiry runs the [read-only grace](#read-only-grace) ladder.

Used in: `decisions.md` 2026-07-13

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

### **MYE1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 [extracted-attachment-text](#attachment-text-extraction) blob (`spec/protocol.md` §9.15), the per-attachment search-extraction cache at `attachments-text/<attachment-id-hex>`. A `MYS1`-style 34-byte envelope over a postcard payload; KEK `DeriveSubkey(root_key, "attachment-text-key")`, with the AAD additionally binding the [attachment-id](#attachment-id) and the [extractor version](#extractor-version). Like [`MYS1`](#mys1) it is a rebuildable cache — [fall to rebuild](#fall-to-rebuild) (here: re-extract from the source [`MYA1`](#mya1)) on any rejection rather than treating it as data loss. Registered in §10.3 with its v005-reserved sibling `MYE5`. The "E" is for *extracted*. Implementations MUST reject any candidate blob whose first four bytes are not `MYE1`. (MYND-328)

### **MYG1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 [`vault.graph`](#vaultgraph) blob (`spec/protocol.md` §9.19) — the encrypted-at-rest knowledge-graph layout cache (node positions + a schema-version marker). Parallel to `MYS1` (search) / `MYI1` (indices) / `MYR1` (embeddings) in the v0.1 magic-byte family; a **distinct family** (one magic per family). `G` = **G**raph. A pure rebuildable cache — [fall to rebuild](#fall-to-rebuild) (re-run the force layout) on any rejection rather than treating it as data loss. KEK `DeriveSubkey(root_key, "graph-layout-key")`; [rebuildable-cache](#sync-artefact-classes) Class 3, so **never synced and never backed up**. Registered in §10.3 alongside its v005-reserved sibling `MYG5`. Implementations MUST reject any candidate `vault.graph` whose first four bytes do not match `MYG1`.

### **MYI1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 [`vault.indices`](#vaultindices) blob (`spec/protocol.md` §9.8) — the encrypted-at-rest structured-metadata index (wikilink graph + tag index + title resolution + typed [property](#property) records). Parallel to `MYS1` (search) / `MYW1` (workspace) in the v0.1 magic-byte family; the structural twin of `MYS1` but a **distinct family** (one magic per family). The magic was **reserved by VaultIndices since 2026-06-07 (MYND-31)** — which is why the attachments catalog took `MYC1` after its initial `MYI1` proposal collided — and the blob spec landed with MYND-271. Registered in §10.3 alongside its v005-reserved sibling `MYI5`. Implementations MUST reject any candidate `vault.indices` whose first four bytes do not match `MYI1` — and [fall to rebuild](#fall-to-rebuild) rather than treating the rejection as data loss.

### **MYP1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 `vault.prefs` blob. Parallel to `MY01` (per-note) and `MYV1` (vault metadata) in the v0.1 magic-byte family. Registered in `spec/protocol.md` §10.3's major-version registry alongside its v005-reserved sibling `MYP5`. Implementations MUST reject any candidate `vault.prefs` whose first four bytes do not match `MYP1`.

Used in: `spec/protocol.md` §9.5, §10.3

### **MYR1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 [`vault.embeddings`](#vaultembeddings) blob (`spec/protocol.md` §9.17) — the encrypted-at-rest on-device AI embedding index (semantic-search / Q&A vectors, MYND-453). Parallel to `MYS1` (search) / `MYI1` (indices) in the v0.1 magic-byte family; a **distinct family** (one magic per family). `R` = **R**etrieval/RAG (the natural `E`-for-embeddings letter was already taken by `MYE1`, extracted-attachment-text). Registered in `spec/protocol.md` §10.3 alongside its v005-reserved sibling `MYR5`. Written only when the runtime beta opt-in `ai_enabled` is on (AI ships in the default build as of `decisions.md` 2026-07-02; a `--no-default-features` build never compiles the AI path and never writes it). Implementations MUST reject any candidate `vault.embeddings` whose first four bytes do not match `MYR1` — and [fall to rebuild](#fall-to-rebuild) (re-embed) rather than treating the rejection as data loss.

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

### **operator console** &nbsp; 📦 *Product*

The hosted-sync admin surface (`decisions.md` 2026-07-13; **built 2026-07-15, MYND-506**): an admin API bound to a **Unix domain socket** (`MYNE_ADMIN_SOCKET` — no bearer secret; access is filesystem permissions; disabled by default) plus a `myne-server admin` CLI (thin client; a stdlib web panel is a later iteration on the same API). Normative posture: the console is a **live projection of already-persisted enforcement state only** — account hash, stored bytes, device count, policy fields — never a new observation channel: no request history, no last-seen wall-clocks, no per-account time series (upholding the MYND-440 aggregate-only-metrics invariant). Shipped enforcement: `list`/`show`/`stats` + `freeze`/`unfreeze`/`set-quota`/`set-max-devices`/`delete` (`plan_id`/`paid_until` reserved for MYND-430 billing). Open-source and shipped to self-hosters like every other component; hosted gets no proprietary tooling. The client-facing counterpart is the authed, token-derived [account status endpoint](#account-status-endpoint). Enforcement state persists in the [account policy store](#account-policy-store).

Used in: `decisions.md` 2026-07-13, 2026-07-15

### **account policy store** &nbsp; 📦 *Product*

The sparse top-level `accounts.json` file (server root, `decisions.md` 2026-07-15; MYND-506) holding per-account operator enforcement policy — `{frozen, quota_override_bytes, max_devices_override, plan_id (reserved), paid_until_day (reserved)}` keyed by [account_number_hash](#account_number_hash). Server-side **plaintext** operator metadata of the same class as the already-visible device count / stored-byte size (AS16/AS17) — never user content. Mirrors `auth.json` (in-memory map + consistent-cut atomic snapshot + coalescing flusher; no magic byte, `schema_version`, forward-incompatible-by-design with v005). **Sparse**: only accounts with non-default policy keep an entry (absence = all defaults). Read by the request-path enforcement (quota guard, enroll cap, push/enroll freeze) and by the [operator console](#operator-console). **Not synced** (operator policy, not user data); captured by the [built-in backup](#built-in-backup) (same volume).

Used in: `decisions.md` 2026-07-15; `spec/server-protocol.md` §7

### **account status endpoint** &nbsp; 📋 *Protocol*

`GET /account/status` (`decisions.md` 2026-07-15; MYND-506; `spec/server-protocol.md` §7 / §7.1): the authed, client-facing counterpart to the [operator console](#operator-console). Returns the caller's own `{stored_bytes, device_count, frozen, quota_bytes, max_devices}`. The account is **resolved from the device token — never from the URL or query** (an identifier there is ignored), so the account number never appears in a request line or log. Both ceilings are **effective** — resolved through the same function the enforcement guard uses, so a reported ceiling and a refusal cannot disagree — and **`0` means unlimited**, never a ceiling of zero (`decisions.md` 2026-07-26; MYND-570). Surfaced in Settings → Sync on desktop and mobile since MYND-570; `plan_id` / `paid_until_day` stay reserved to MYND-430 and are not exposed.

Used in: `decisions.md` 2026-07-15; `spec/server-protocol.md` §7

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

### **pending capture** &nbsp; 📦 *Product*

A short piece of dictated note text captured on the native-SwiftUI Apple Watch companion and relayed to the paired phone over WatchConnectivity, held in a **device-local encrypted queue** (`MYK1`, `spec/protocol.md` §9.18 — one file per capture at `captures/<capture-id>`) until the vault is next unlocked on the phone, at which point it is drained into that vault as an ordinary new note. Sealed under a device-local keychain `wrap_key` (non-biometric, `afterFirstUnlockThisDeviceOnly`; **not** `root_key`-derived, since the queue must be writable while the vault is locked), it is **vault-agnostic** — it binds the per-entry `capture_id` rather than a vault identity, and drains into whichever vault unlocks first. The watch holds no vault keys and runs no crypto (the same outside-the-trust-boundary posture as the home-screen widget); the queue is never synced or backed up. V1 is voice quick-capture only — no reading, editing, or Siri intent. (`decisions.md` 2026-07-12)

### **plausibly-deniable encryption** &nbsp; ⚠️ *Threat*

Encryption schemes (e.g., VeraCrypt's hidden volumes) where a vault can be opened to multiple distinct plaintexts depending on which password is supplied, providing deniability under coercion. Myne v0.1 does not implement plausibly-deniable encryption; coercion (A12) is explicitly out of scope. v005 may revisit but only with caution — partial deniability schemes are easy to misimplement and easy to claim falsely.

Used in: `threat-model.md` §5, §7

### **Poly1305** &nbsp; 🔐 *Primitive*

The one-time MAC algorithm by Daniel J. Bernstein, used as the authenticator inside ChaCha20-Poly1305 and XChaCha20-Poly1305. In Myne's CTX-wrapped construction the 16-byte Poly1305 tag T is recomputed at decrypt time from `(K, N, AAD, ciphertext)` rather than stored on disk; only the 32-byte CTX commitment tag T' is persisted.

Used in: `spec/protocol.md` §5.1

### **quick-unlock credential** &nbsp; 🗝️ *Key/identifier*

A [device-local credential](#device-local-credential) (`vault.quickunlock`, `spec/protocol.md` §9.14, magic `MYQ1`) that holds a **third wrapped copy of `root_key`** so a re-lock (auto-lock-on-idle) can be reversed with a fast second credential — Touch ID / Face ID / Windows Hello, or a PIN — instead of the full master-password Argon2id path. It wraps the already-derived `root_key`; it never participates in `root_key` derivation, so it does not touch the zero-knowledge root (the master password stays the primary credential). Its wrap key comes from a [wrap-key provider](#wrap-key-provider), not a `DeriveSubkey` role. Threat class: an **A6** convenience gate over the already-encrypted store; it does **not** defend against **A7** (active local malware), and the PIN provider's blob is offline-brute-forceable by **A4** bounded only by Argon2id cost. Introduced MYND-329.

Used in: `spec/protocol.md` §9.14, `decisions.md` 2026-06-16

### **wrap-key provider** &nbsp; 🗝️ *Key/identifier*

The pluggable source of the 32-byte symmetric wrap key that protects the [quick-unlock credential](#quick-unlock-credential) blob. The on-disk blob is provider-agnostic — always `AEAD(wrap_key, root_key)` — and only the wrap-key source differs: an Apple Keychain secret gated by `kSecAccessControlBiometryCurrentSet` (biometric — macOS Touch ID, iOS Face ID / Touch ID; one provider kind, `decisions.md` 2026-07-12), a future Windows Hello / TPM challenge-response or Android Keystore secret, or a PIN run through the vault's Argon2id parameters. Modeled as a single Rust trait (`QuickUnlockProvider`); adding a provider is not an on-disk-format change. The biometric provider is hardware-bound and OS-invalidated on biometric-set change; the PIN provider's strength is bounded by PIN entropy × the memory-hard Argon2id cost.

Used in: `spec/protocol.md` §9.14.2, `decisions.md` 2026-07-12

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

### **per-account quota** &nbsp; 📦 *Product*

The Phase 2 hosted-sync storage ceiling: per-account aggregate **deduplicated** ciphertext bytes (AS17 — one stored blob is counted once, not once per referencing note). Keyed on the account, never on identity beyond `account_number_hash`; a self-host operator sets their own ceiling (the protocol exposes the counter, the operator sets policy — TB5). Distinct from the [per-account rate-limit](#per-account-rate-limit) (bytes-at-rest vs request-frequency). Phase 2.

Used in: `spec/server-protocol.md` §5

### **per-account rate-limit** &nbsp; 📦 *Product*

The Phase 2 abuse bound: a per-account **token-bucket keyed on `account_number_hash`**, **never on IP** (C4 / AS14 — the server keeps no persistent IP log; TLS sees the connection IP transiently and discards it). Abuse mitigation is therefore designed in around per-account counters from the start, not retrofitted as IP bans. Bounds the damage a Sybil/abusive account can do; primary Sybil resistance on hosted is the payment-gate (the payment system is MYND-430). Phase 2.

Used in: `spec/server-protocol.md` §5

### **per-blob sync-meta** &nbsp; 📋 *Protocol*

The small, server-visible descriptor a Phase 2 [pull](#sync-cursor) returns for each changed content blob: `(uuid, version, content_nonce, size)`. The client uses it to decide what to fetch — `content_nonce` is the decryption-free staleness discriminator (§9.6.4), `version` the server's opaque per-note counter (AS6), `size` the AS17 quota unit. It exposes nothing the server doesn't already hold (the [vault head](#vault-head) commits the same `content_nonce`s); the client never trusts it for integrity — that is the head's job. Phase 2.

Used in: `spec/sync-protocol.md` §8

### **per-device token** &nbsp; 🗝️ *Key/identifier*

The revocable bearer credential a device receives after a successful SCRAM handshake + [device-approval gate](#device-approval-gate) (`spec/server-protocol.md` §3.1), carried as `Authorization: Bearer <token_hex>` on every authed sync request. It is **distinct from** the [device_id](#device_id-vv-actor): the token is a secret, rotatable *availability* credential, whereas `device_id` is permanent, non-secret [version-vector](#version-vector-vv) history (SYNC-2 — revoking the token never touches `device_id`). Revoking it (the "Remove device" action) stops that device syncing but is **not** forward-secret and **not** a remote wipe — a removed device keeps whatever it already synced (v0.1 offers no cryptographic re-key; that is v005/MLS, `threat-model.md` §7). Stored device-locally in the OS keychain (`thisDeviceOnly`) with a documented weaker `0600`-file fallback (SYNC-16). Phase 2.

Used in: `spec/server-protocol.md` §3.1, §4 (SYNC-2, MYND-425)

### **per-vault namespace** &nbsp; 📋 *Protocol*

The Phase 2 server storage layout: each vault's ciphertext blobs live in a namespace scoped to that vault — there is **no global content-addressed bucket**. Because attachment-ids are vault-scoped keyed-HMAC (`protocol.md` §9.9), cross-vault deduplication is **structurally impossible** (and undesired — a global bucket would be a known-file confirmation oracle). Dedup is intra-vault only; quota (AS17) and the tombstone ledger are kept clean per vault. Phase 2.

Used in: `spec/server-protocol.md` §2

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

### **Reading view** &nbsp; 📦 *Product*

The read-only rendered [view mode](#view-mode) of a note tab (MYND-299): all editor [decorations](#decoration-layer) are applied, but the surface is non-editable and there is **no** [cursor-aware reveal](#cursor-aware-reveal) — markdown source never lifts, so the note reads as finished prose without edit chrome or markup flicker. Keystrokes are no-ops (an optional one-time "⇧⌘E to edit" hint tells the reader how to switch back). It reuses `CMEditor`'s `readOnly` path; §6 C1 keeps the underlying bytes untouched. The primary **Edit ⇄ Reading** toggle is `Mod-Shift-E`. The read-only [preview companion](#view-mode) pane is a side-by-side Reading mirror of the *same* buffer (a linked mirror, not a second `(kind,id)` instance — it preserves the one-editable-buffer-per-note invariant). Contrast [Source mode](#source-mode) (raw markdown, decorations off) and live preview (today's cursor-aware default). See also [view mode](#view-mode), [Source mode](#source-mode), [cursor-aware reveal](#cursor-aware-reveal).

Used in: `spec/protocol.md` §9.5.2, §9.7; `decisions.md` 2026-06-17 (MYND-299)

### **read-only grace** &nbsp; 📦 *Product*

The hosted-sync expiry ladder (`decisions.md` 2026-07-13): when a paid term lapses (or usage exceeds the tier ceiling after a downgrade), push is refused (402-class error) while **pull stays fully open for 90 days** — the user can always take their data out. At the end of grace the server-side vault ciphertext is deleted **atomically**: the server cannot see inside a vault, so selective/partial deletion is structurally meaningless — the server copy either stays whole or goes entirely. The account record (SCRAM verifier + device registry) is kept, and because Myne is local-first the deletion is not data loss — devices hold the plaintext and can re-push within the free tier or after renewal.

Used in: `decisions.md` 2026-07-13

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

A named, **read-only** derived view over a vault's own plain-markdown notes (Saved Views epic, MYND-271) — a filter (over [properties](#property), tags, folders) + a sort + an optional `groupBy`, rendered as one of a closed set of [view types](#view-type). The Obsidian-Bases analogue, deliberately narrowed: **no database, no formula/code-eval** — only a declarative, closed-allow-list query (the query-engine sub-feature) over the derived property index. The view *definition* is authored content persisted in `vault.prefs` / `MYP1` (not the index blob); the data it queries lives in the rebuildable [vault.indices](#vaultindices) / `MYI1` cache. Because it is read-only over plain markdown with `.myn` as the source of truth, it does **not** violate the `vision.md` "no databases" / "no proprietary format" anti-features (same precedent class as the [search index](#search-index)); see `decisions.md` 2026-06-14 "Saved Views is a read-only derived projection over plain markdown, not a database". The [filter AST](#filter-ast) is created and edited through the **filter builder** UI — single-level filter groups over tag / folder / search / [property](#property) conditions, a deliberate representable subset of the AST's full nesting (MYND-282 + its property-condition follow-up).

Used in: Saved Views (MYND-271, MYND-282); `decisions.md` 2026-06-14

### **scheduled backup** &nbsp; 📦 *Product*

An automatic, recurring [vault backup file](#vault-backup-file) written to a user-chosen local folder on a cadence (MYND-351). Runs only while the app is open and the vault is unlocked ("Model A"), driven by an opportunistic elapsed-time check (`now − last success ≥ interval`) on unlock and periodically while unlocked — not a wall-clock timer (auto-lock would starve one). Reuses the manual export path verbatim (no new cryptography; the `.myne-backup` stays exactly as encrypted as the vault). Governed by a device-local [backup schedule](#backup-schedule). Keeps the most recent N (user-set, default 7), pruning only files it wrote. **No email or cloud delivery — ever** (`vision.md` anti-feature); the user's own folder-sync handles offsite. Distinct from [restore (from backup)](#restore-from-backup) and from the manual click-to-back-up action. Leak/egress posture is that of any backup file: `threat-model.md` §7, TB3.

Used in: `decisions.md` 2026-06-18; `myne-agents/features/scheduled-local-backup/`

### **screen-capture protection** &nbsp; 📦 *Product*

Best-effort native window exclusion preventing OS screen-recording and screenshot APIs from capturing Myne content. Applied at app startup via Tauri's `set_content_protected` (macOS `NSWindowSharingNone`, Windows `WDA_EXCLUDEFROMCAPTURE`). Platform support: macOS (all Tauri-supported versions), Windows 10 build 19041+. Unavailable on Linux v0.1.

Used in: `threat-model.md` §6, §7

### **search index** &nbsp; 📦 *Product*

Myne's full-text search over note content (MYND-29). A custom in-memory **BM25 inverted index** (AND-of-terms with a last-term prefix match for type-ahead, plus a title-boost) built from decrypted note plaintext while the vault is unlocked, queried in RAM, and persisted as the encrypted `vault.search` blob. Index-side, each note's language is detected (whatlang, EN/TR/DE) and single-stemmed (the raw token is always indexed too); query-side, terms are multi-stemmed across all supported languages (the query is too short to detect a language) — a deliberate index/query asymmetry. The index is **plaintext-derived RAM**, as sensitive as the open notes: zeroized on lock (`threat-model.md` A6), and never the source of truth (the `.myn` files are). Engine choice sits behind a swappable trait; the MYND-29 benchmark (`decisions.md` 2026-05-31) selected the custom engine over tantivy on the budget table. See also [search-index-key](#search-index-key), [fall-to-rebuild](#fall-to-rebuild).

Used in: `spec/protocol.md` §9.6; `decisions.md` 2026-05-31

### **graph-layout-key** &nbsp; 🗝️ *Key/identifier*

The 32-byte AEAD KEK encrypting [`vault.graph`](#vaultgraph) (`MYG1`, §9.19). Derived deterministically from `root_key` via the canonical `DeriveSubkey(root_key, "graph-layout-key")` helper (`spec/protocol.md` §3.4 registry entry `"myne.v0.1 graph-layout-key"`). Never persisted; re-derived on each read/write of the layout cache. Independent from the `itemsKey` lineage by design — like `search-index-key` / `ai-embeddings-key` it derives straight from `root_key`, so it survives the v005 epoch-rotation `itemsKey` evolution. The AAD `AAD_graph_layout_blob` (role `"graph-layout-blob"`, `spec/protocol.md` §5.2) binds the blob to its vault via `account_number_hash`. **DISTINCT** from the AAD role string `"graph-layout-blob"` (a different load-bearing constant).

### **search-index-key** &nbsp; 🗝️ *Key/identifier*

The 32-byte AEAD KEK encrypting `vault.search`. Derived deterministically from `root_key` via the canonical `DeriveSubkey(root_key, "search-index-key")` helper (`spec/protocol.md` §3.4 registry entry `"myne.v0.1 search-index-key"`). Never persisted; re-derived on each unlock (to load / reconcile the index) and on each persist (graceful lock / periodic flush). Independent from the `itemsKey` lineage by design — like `prefs_key` it derives straight from `root_key`, so it survives the v005 epoch-rotation `itemsKey` evolution. The AAD `AAD_search_index_blob` (role `"search-index-blob"`, `spec/protocol.md` §5.2) binds the blob to its vault via `account_number_hash`.

Used in: `spec/protocol.md` §3.4, §5.2, §9.6

### **session-state-key** &nbsp; 🗝️ *Key/identifier*

The 32-byte AEAD KEK encrypting `vault.workspace` (the [workspace-state blob](#workspace-state-blob)). Derived deterministically from `root_key` via the canonical `DeriveSubkey(root_key, "session-state-key")` helper (`spec/protocol.md` §3.4 registry entry `"myne.v0.1 session-state-key"`). Never persisted; re-derived on each unlock (to restore the workspace) and on each graceful-exit persist. Independent from the `itemsKey` lineage by design — like `prefs_key` / `search-index-key` it derives straight from `root_key`, so it survives the v005 epoch-rotation `itemsKey` evolution. The AAD `AAD_workspace_blob` (role `"workspace-blob"`, `spec/protocol.md` §9.7.3) binds the blob to its vault via `account_number_hash`.

Used in: `spec/protocol.md` §3.4, §9.7

### **named workspace** &nbsp; 📦 *Product*

A user-named, switchable editor layout (MYND-308): a stored snapshot of the open-tab set, pane-split layout, focused pane, per-tab cursor/scroll, and per-tab [view mode](#view-mode), recalled under a chosen name ("Writing", "Research"). The [workspace-state blob](#workspace-state-blob) descriptor evolves from a single workspace to **N named [slots](#workspace-slot)** with an `{slots, active}` inner schema — `workspace_format_version` ticks `0x01 → 0x02` (an old binary hits `FormatUnsupported` and defaults to a single empty pane; magic / AAD / HKDF unchanged). Surfaced via a [bottom-bar](#bottom-bar) dropdown + command palette (save-as / switch / rename / delete; no default chord). Switching is **hybrid**: the outgoing slot auto-saves its live layout, plus explicit Save-as / Reset-to-snapshot. The active-slot pointer lives in MYP1 ([`active_workspace`](#vaultprefs), a stable slot id — survives a crash; falls back to the first slot if the named slot is gone). Names + layouts stay inside the AEAD envelope (AS3). Writes are **coalesced** — ≤ once per ~5 min of active use plus graceful exit / auto-lock — a deliberate, bounded relaxation of the §9.7.4 graceful-exit-only cadence (`threat-model.md` §7). See also [workspace slot](#workspace-slot), [workspace-state blob](#workspace-state-blob).

Used in: `spec/protocol.md` §9.7; `threat-model.md` §7; `decisions.md` 2026-06-17 (MYND-308)

### **workspace slot** &nbsp; 📦 *Product*

One [named workspace](#named-workspace) within the `0x02` [workspace-state blob](#workspace-state-blob) descriptor (MYND-308). A slot carries a **stable `id`** (the durable identity — rename never changes it, so the MYP1 [`active_workspace`](#vaultprefs) pointer is rename-free), a display `name`, and the workspace descriptor itself (pane tree, focused pane, per-tab items incl. [view mode](#view-mode)). Slots are opaque to the protocol codec — the desktop client serializes the `{slots, active}` structure and the codec treats it as raw inner bytes (like the pre-0x02 single descriptor). Deleting the last slot leaves a fresh empty "Default" slot (the container is never slotless). See also [named workspace](#named-workspace).

Used in: `spec/protocol.md` §9.7; `decisions.md` 2026-06-17 (MYND-308)

### **workspace-state blob** &nbsp; 📦 *Product*

The encrypted `vault.workspace` artifact (`MYW1`, `spec/protocol.md` §9.7) carrying the editor's **workspace state** — the open-tab set per pane, the recursive pane-split layout, each pane's active tab, the focused pane, per-tab cursor/scroll positions, and per-tab [view mode](#view-mode) (MYND-166; per-tab view mode added by MYND-299, named slots by MYND-308). AS3-Sensitive (note ids + structure): persisting *which notes are open* is activity metadata, so it rides inside the AEAD envelope under [session-state-key](#session-state-key) rather than as plaintext local state. The inner descriptor is client-opaque to the protocol layer (like the [search index](#search-index)); since MYND-308 it holds `{slots, active}` ([named workspaces](#named-workspace)) and `workspace_format_version` is `0x02` (an old `0x01` binary hits `FormatUnsupported` → single empty pane). Write cadence is **graceful-exit only** in the single-workspace baseline (manual lock / idle auto-lock grace / quit, never per tab-switch), **coalesced to ≤ once per ~5 min of active use** once named workspaces are in play (MYND-308 — a bounded relaxation of §9.7.4, `threat-model.md` §7), and on **mobile** resolves "quit" to **app-background** alongside lock, dirty-gated (MYND-561 — the platform has no quit signal; §9.7.4 "Mobile exit analogs") — so the blob's mtime stays a coarse signal, never a high-resolution editor-activity log. Best-effort, not crash-durable; a missing / tampered / malformed / wrong-version blob falls back to a single empty pane (§9.7.4).

### **selection toolbar** &nbsp; 📦 *Product*

The floating UI surface that appears above an active text selection in the Phase 1 editor, exposing format actions (bold / italic / strikethrough / inline-code / link / heading dropdown). Positioning uses the shared `src/editor/positioning.ts` helper — `getBoundingClientRect` + viewport-edge clamp + flip-below-when-no-room-above. The 🔗 (link) button opens an **inline URL overlay** adjacent to the selection rather than a `window.prompt()` or modal, matching `PRODUCT.md`'s "modals not as first reach for interaction" anti-pattern. Implemented as a CodeMirror 6 `ViewPlugin` that mounts/unmounts the toolbar based on selection state; absent when the selection is empty. **Opt-out per host since MYND-559:** `myneExtensions` / `CMEditorProps` take `selectionToolbar`, default `true` (desktop), and a host that renders its own formatting surface passes `false` — the plugin is then never constructed, rather than mounted-and-hidden. The mobile client does exactly that, driving formatting from its above-keyboard format bar instead, so on mobile this surface does not exist.

Used in: `myne-agents/features/editor-mvp-baseline/prd.md`, `myne-agents/sessions/grill/2026-05-16-mynd-36-editor-inner-scope.md` Q4 + Q8

### **self-host** &nbsp; 📦 *Product*

User-operated deployment of the Myne sync server. First-class in the product plan: same protocol, same security properties as hosted sync. The protocol treats hosted and self-hosted servers as identical trust boundaries (TB5) — the operator does not see plaintext in either case.

Used in: `vision.md`, `threat-model.md` §3

### **server-auth subkey** &nbsp; 🗝️ *Key/identifier*

A subkey derived from `root_key` via `derive_key(root_key, "myne.v0.1 server-auth")`. **Reserved, not used in v0.1.** The exact protocol-level role (simple verifier transmission vs OPAQUE `export_key` integration) is deferred to Phase 2; see `spec/protocol.md` §11.1.

Used in: `spec/protocol.md` §3.4, §11.1

### **serverPassword** &nbsp; 🗝️ *Key/identifier*

A generic term referring to whatever value is sent to the sync server for authentication in Phase 2. The concrete form is one of the two options in §11.1 — a deferred decision. v0.1 defines no transmitted server credential.

Used in: `spec/protocol.md` §1.1, §11.1

### **share-import staging queue** &nbsp; 📋 *Protocol*

The device-local, `MYF1`-sealed queue (`pending-shares/sealed/`, `protocol.md` §9.20) holding a file shared into Myne via the OS share sheet (iOS Share Extension / Android `ACTION_SEND`) until the vault unlocks and it drains into the [attachment library](#attachment) via `attachment_import`. The file-carrying sibling of the [pending-capture queue](#pending-capture) (`MYK1`): same device-key seal and vault-agnostic per-entry-id AAD binding, but a binary payload framed with its filename + declared MIME, a 64 MiB cap, and an attachment (not note) drain target. Device-local (TB2), never synced or backed up.

Used in: `protocol.md` §9.20; `decisions.md` 2026-07-16

### **share_id** &nbsp; 🗝️ *Key/identifier*

The 16-byte random per-entry identifier of a [share-import staging queue](#share-import-staging-queue) blob (`MYF1`, `protocol.md` §9.20.3). Its lowercase-hex form is the on-disk filename under `pending-shares/sealed/`, and it is bound into the blob's AAD (role `"share-import-blob"`) so an attacker with write access to the queue directory cannot swap or duplicate one entry's ciphertext under another entry's slot. Vault-agnostic — it binds no `account_number_hash` or `items_key_id`.

Used in: `protocol.md` §9.20.3; `decisions.md` 2026-07-16

### **shared pref** &nbsp; 📋 *Protocol*

One of the two normative [vault.prefs](#vaultprefs) field classes of the Phase 2 prefs sync (`sync-protocol.md` §10.2, MYND-478): a preference that describes the *vault* — identity (`label`, `icon`), content organization (`favorites`, `item_order`, `folder_icons`, `saved_views`), vault-level conventions (the `daily_*` fields), vault-wide privacy declarations (`ai_excluded_folders`), and the cross-device `device_names` map. Shared prefs sync between devices, merging per discipline (scalar/whole-value LWW on [field clocks](#field-clock), set-union, sequence-LWW-on-whole, per-key map). Contrast [device-local pref](#device-local-pref).

Used in: `sync-protocol.md` §10.2; `decisions.md` 2026-07-13

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

The keystroke-driven menu of insertable elements in the Phase 1 editor, triggered by typing `/` (suppressed inside fenced code block ranges, inline link URL portions, and wikilink ranges so `/` remains content in those contexts). The menu is a fuzzy-match floating list — type `/h1`, `/h`, or `/heading 1` to surface H1; Enter applies, Esc dismisses. `editor-mvp-baseline` ships 11 commands: `/h1`-`/h6`, `/quote`, `/divider`, `/link`, `/bullet`, `/numbered`, `/todo`. **`/wiki` is explicitly excluded** from the baseline set — it ships in `editor-mvp-wikilinks` alongside the autocomplete picker, because the menu should only surface element kinds the editor authoring layer can actually deliver. `/table`, `/code`, `/footnote`, `/callout`, and the date/time inserts `/date` `/day` `/time` `/now` (MYND-338, frozen local-time plain text) ship in their owning sub-feature PRDs.

Used in: `myne-agents/features/editor-mvp-baseline/prd.md`, `myne-agents/sessions/grill/2026-05-16-mynd-36-editor-inner-scope.md` Q2

### **sidebar batch refresh** &nbsp; 📦 *Product*

The Notes sidebar's hybrid refresh strategy pinned in `decisions.md` 2026-05-15: **initial-boot chunked Promise.all** (on Editor mount, call `note_list` → split returned IDs into ≤100-ID chunks per `note_titles_batch`'s `BatchTooLarge` cap → fire all chunks via `Promise.all` → populate the `Map<NoteId, TitleRecord>` cache) **plus action-driven surgical `refreshOne(id)`** (after every successful `saveNote / renameNote / createNote / deleteNote`, call `note_titles_batch([id])` for that single ID and update the matching cache entry). The pattern is event-driven, not poll-based — no periodic background re-fetch, no broadcast-channel listener. Backend events (Tauri `emit("note_updated", ...)`) were explicitly rejected for Phase 1 as premature complexity in a single-window scenario; a future multi-window Myne adopts them by replacing `refreshOne` call sites with event handlers (same function, different trigger). Pairs with `optimistic UI rollback` for instant-feedback paths.

Used in: `decisions.md` 2026-05-15; MYND-82

### **size class** &nbsp; 📦 *Product*

The mobile client's layout axis — the discriminator that decides which pane composition the wired app renders, **derived from window geometry, never from device brand**: `compact` (the phone's full-screen list ⇄ editor swap), `medium` (≥700px: list + detail two-pane), `expanded` (≥1000px: the WS-01 three-pane — sidebar 248 / list 316 / editor). Two inputs: the **window width** (`window.innerWidth`, so an iPad Split View pane narrowed to phone width falls back to the phone layout, and the Playwright flow tier drives every layout purely by viewport) and a **phone guard** on `window.screen`'s smaller dimension (< 480px → always `compact`; reading `screen` rather than window height keeps the Android IME — which shrinks the layout viewport — from flipping the layout and remounting the editor mid-typing). Orthogonal to [platform](#platform) (`PlatformContext` keeps owning biometric copy / brand concerns; `SizeClassContext` owns layout). Breakpoint budget mirrors the desktop `layoutClamp.ts` discipline (editor pane ≥ 360px, the desktop `CENTER_MIN_WIDTH`).

Used in: `decisions.md` 2026-07-12 "Mobile tablet strategy"; `myne-mobile/src/platform/SizeClassContext.tsx`

### **Slot** &nbsp; 📦 *Product*

The three-state enum that holds a vault's auth state inside `VaultRuntimeState`'s `RwLock<HashMap<VaultId, Slot>>` — one entry per vault, keyed by [VaultId](#vaultid) (an absent key IS the `Empty` case; no `Empty` entries are stored). Variants: `Slot::Empty` (no vault open), `Slot::Recovering { ... }` (post-recovery / pre-password-commit), `Slot::Unlocked(UnlockedVault)` (full editor access). Editor commands match only `Slot::Unlocked(uv) => ...`; the `Slot::Recovering` and `Slot::Empty` variants are structurally rejected at compile time (per entry). The shape is the type-system realization of `recovery-flow.md` §4.1 + §4.3's "no soft-unlocked session" guarantee — security lives in the type, not in UI discipline. Multi-vault made the storage a `HashMap<VaultId, Slot>` (the singleton→map type-swap landed 2026-06-09) under the **≤1-`Unlocked` invariant**: at most one entry is ever `Unlocked` — the **active vault** is that sole `Unlocked` entry (no separate pointer), and unlocking a second vault first locks the current one. `auth_permits` stays a single global capacity-1 semaphore (one Argon2id auth op in flight client-wide, never per-vault). The per-entry lifecycle reasoning carries forward unchanged.

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization", 2026-06-09 "Runtime multi-slot core"

### **SlotKind** &nbsp; 📋 *Protocol*

The discriminator for the [`Slot`] enum, exposed across the IPC boundary by the `vault_status` Tauri command. Three variants: `Empty | Recovering | Unlocked`. Serde-Serialize encoding is the bare variant name (no `#[serde(tag)]` wrapper), so the JSON payload on the wire is one of three bare strings — `"Empty"`, `"Recovering"`, `"Unlocked"`. The TypeScript hand-mirror at `src/types/slot-kind.ts` is therefore a string-literal union, not an object discriminator. Used by frontend boot-time and post-WebView-reload routing — never on the post-recovery happy path (the in-process `Slot::Recovering` → `Slot::Unlocked` transition uses the IPC `Ok(())` from `vault_complete_recovery` as the success signal; a defensive `vault_status` round-trip would be paranoia).

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization"

### **snapshot** &nbsp; 📦 *Product*

An encrypted previous version of a note, captured automatically as the note is edited so an accidental overwrite or bad edit can be recovered (the MYND-96 file-recovery feature — Myne's answer to Obsidian File Recovery). A snapshot is a **frozen [`.myn`](#myn-file) revision**: the prior note plaintext re-sealed under the note's own `item_key` in the `MY01` envelope (`spec/protocol.md` §9.2) — **no new magic byte, no new subkey role**. Snapshots live in a flat `<vault-root>/snapshots/` directory (§9.1), captured **time-coalesced** (≈ one per note per 5 min of active editing, plus on editor-close / vault-lock), retained for a **bounded window** (default ~7 days) with a safety backstop, and pruned eagerly. On **permanent** delete a note's snapshots are purged, preserving cryptographic erase; soft-[Trash](#trash) (an ordinary update, the note still exists) keeps snapshotting. Distinct from the unrelated `vault.prefs` *replay* sense ("restore prior valid `vault.prefs` snapshots") in `threat-model.md` §7. See also [`.myn` file](#myn-file), [Trash](#trash).

Used in: `spec/protocol.md` §9.1; `threat-model.md` §7; `decisions.md` 2026-06-08

### **soft-retire** &nbsp; 📋 *Protocol*

The Phase 2 sync state a device enters when its cursor falls behind the [tombstone horizon](#tombstone-horizon) (it has been offline / silent too long to participate in the per-device-ack [tombstone](#tombstone-horizon) GC). A soft-retired device is dropped from the "must-ack" set so its absence can't pin tombstones forever; on return it cannot resume incrementally and must run a [full-reconcile](#full-reconcile). Reuses the AS16 device-retirement mechanism (also needed for revocation) rather than inventing new state. Distinct from a hard device revocation (per-device token iptal). Phase 2.

Used in: `spec/sync-protocol.md` §11

### **Source mode** &nbsp; 📦 *Product*

The raw-markdown [view mode](#view-mode) of a note tab (MYND-299): the [decoration layer](#decoration-layer) is emptied, so the editor shows the exact on-disk markdown with no rendering — headings keep their `#`s, links show their brackets, nothing is hidden. Because §6 C1 guarantees the editor buffer is byte-identical to the stored `.myn`, Source mode displays exactly the stored bytes. It is editable (unlike [Reading view](#reading-view)) — the writer's surface for inspecting or hand-editing raw syntax. Reached via the command palette or the bottom-bar [view-mode switcher](#view-mode), **not** a default chord (the secondary live ↔ source toggle is deliberately chord-free; `Mod-Shift-E` is reserved for Edit ⇄ Reading). Contrast live preview (cursor-aware reveal) and [Reading view](#reading-view) (rendered, read-only). See also [view mode](#view-mode), [Reading view](#reading-view).

Used in: `spec/protocol.md` §9.5.2, §9.7; `decisions.md` 2026-06-17 (MYND-299)

### **speech-to-text (ASR/STT)** &nbsp; 📦 *Product*

On-device transcription of an audio attachment into text — Myne runs it entirely on the user's machine via a Whisper model (a **built-in default on desktop**, overridable with a user's own side-loaded file; `decisions.md` 2026-07-19 "Bundle a default transcription model on desktop") through the [Candle](#candle) stack ([local inference](#local-inference)); **no cloud, no provider call, no telemetry, nothing downloaded at runtime** (a standing anti-feature — decrypted audio never leaves the device, A1). Triggered on-demand per [voice note](#voice-note) (never auto-run on import); the machine [transcript](#transcript) is cached in the note's [`MYE1`](#mye1) extracted-text blob for search parity and can be inserted into the note body by an explicit user action. Gated on `ai_enabled` like the rest of the AI surface; the model is small and **fallible**, so copy treats a transcript as a machine guess, not a record, and — because the runtime is in-process, **not** sandboxed (SYNC-6) — never claims key-isolation. See `decisions.md` 2026-07-19; `threat-model.md` §7 "Local AI". (MYND-270)

### **startup open** &nbsp; 📦 *Product*

The user preference, exposed in Settings → **Files**, controlling which file opens when the app launches. Two `vault.prefs` fields carry it (`spec/protocol.md` §9.5.2): **`startup_open`** — a mode of `last` (restore the last [workspace slot](#workspace-slot) layout, the default and pre-feature behaviour), `empty` (open a fresh empty editor), or `specific` — and **`startup_open_note`**, the target note UUID used only in `specific` mode. Crucially, choosing `empty`/`specific` does **not** destroy the saved [workspace-state blob](#workspace-state-blob): the session skips restoring it and suppresses workspace staging, so toggling back to `last` restores the prior layout intact. A deleted/unreadable `startup_open_note` falls back to the empty editor; the pref is never auto-cleared. Non-load-bearing. Note: semantically overlaps the (currently mock) Privacy "Continue where you left off" toggle — a flagged follow-up. See [decisions.md](decisions.md) 2026-06-27 (MYND-462).

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-27 (MYND-462)

### **state-level actor** &nbsp; ⚠️ *Threat*

Adversary class A10. Nation-state-class adversary with zero-day capabilities, supply-chain access, hardware-implant capability, and the legal power to compel operator cooperation. Myne's status against A10 is Best-effort: boring, well-vetted primitives plus a published spec, with no claim of defense against zero-days or hardware implants beyond what A2 covers.

Used in: `threat-model.md` §1 (A10)

### **stray attachment file** &nbsp; 📋 *Protocol*

An [`MYA1`](#mya1) blob present on disk at `attachments/<attachment-id-hex>` whose id is **absent from the [`vault.attachments`](#vaultattachments) catalog** — a crash remnant from a "clean unused attachments" sweep interrupted between its catalog rewrite and the blob unlinks (the catalog-first ordering deletes the entry first). The unlock-time reconcile unlinks stray files (canonical 64-char lowercase-hex names only), but **never** a cataloged id — including a zero-reference [unused attachment](#unused-attachment) awaiting the user's explicit sweep — and skips entirely if the catalog is present-but-undecodable (no mass-delete on corruption). Distinct from an *unused* attachment, which is cataloged and user-visible. (MYND-171; `decisions.md` 2026-06-13)

### **supply-chain compromise** &nbsp; ⚠️ *Threat*

Adversary class A8: a transitive dependency in npm, Cargo, or Go modules ships malicious code. Myne's mitigations are hash-pinned lockfiles, minimal direct-dependency surface, dependency-review at update time, and `cargo-vet`/`cargo-audit` in CI. Status: Best-effort — cannot fully defend against a determined attacker in the dependency graph, but the Tauri/Cargo dependency tree is materially smaller than Electron/npm would be.

Used in: `threat-model.md` §1 (A8), §7

### **sync cursor** &nbsp; 📋 *Protocol*

The Phase 2 opaque, per-device **monotone position** marking how far a device has pulled. A pull sends the cursor and receives the [per-blob sync-meta](#per-blob-sync-meta) for everything changed since; the cursor then advances. It carries **no wall-clock** (clock/order authority is the [version vector](#version-vector-vv), §4.1 Pin 4) — it is a catch-up bookmark, not a security primitive. Persisted device-locally alongside (but separate from) the [vault head](#vault-head) baseline. Phase 2.

Used in: `spec/sync-protocol.md` §8

### **sync taxonomy** &nbsp; 📋 *Protocol*

The Phase 2 four-class partition of a vault's artefacts by sync disposition: **authoritative-data** (notes, `vault.prefs`, `vault.dictionary`, attachments + `vault.attachments` — SYNC), **identity** (`vault.meta` — SYNC, bespoke merge), **rebuildable-cache** (`vault.search`, `vault.indices`, `vault.embeddings`, `vault.graph` — re-derived locally via the §9.6.4 reconcile or a fresh re-layout, NEVER synced; `vault.embeddings` is additionally model-specific), **device-local** (`vault.workspace`, `vault.quickunlock`, `vault.head-state` — NEVER synced). Governed by the invariant **sync members ⊆ backup members**: sync membership is the authoritative-vs-derivable cut of the `protocol.md` §9.11.3 backup allowlist, not a separate list. One deliberate carve-out: **snapshots** are authoritative and in the backup allowlist yet are *never* synced (syncing per-note snapshot cadence would leak edit timing — A13/AS6; `threat-model.md` §7 is normative, `sync-protocol.md` §9.2). Phase 2.

Used in: `spec/sync-protocol.md` §9

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
Used in: `src/editor/code-highlight.ts`, `docs/decisions.md` (2026-05-29).

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

### **TOFU bootstrap** &nbsp; 📋 *Protocol*

Trust-on-first-use: how a freshly enrolled or reset device adopts its first [vault head](#vault-head). [Fork-consistency](#fork-consistency) via version-vector dominance is a **continuity** guarantee — it only protects a device that already holds a persisted last-seen baseline. A device with no baseline has nothing to compare against, so it takes the server-served head on faith after verifying its MAC (the MAC proves "a `root_key` holder authored this", **not** "this is the latest, unforked head") — the same model as Signal/Matrix key TOFU. The "first device" is not cryptographically special; "has-a-baseline-or-not" is (a reset device is also a TOFU client). The only hardening is an out-of-band [bootstrap-fingerprint](#bootstrap-fingerprint) compared at the device-approval gate. Phase 2.

Used in: `spec/sync-protocol.md` (vault head); `threat-model.md` §7

### **tombstone horizon** &nbsp; 📋 *Protocol*

The Phase 2 bound on how long a deletion [tombstone](#deleted-attachment-tombstone) is retained before garbage collection. A deletion is a `deleted`-marked new encrypted version (carried in the [vault head](#vault-head) manifest until GC, §4.2), not a bare "absent on disk → drop". A tombstone is collected once **every horizon-active device's [sync cursor](#sync-cursor) has acked past** the delete-version; a device that falls behind the horizon is [soft-retired](#soft-retire) and must [full-reconcile](#full-reconcile) on return. The horizon is **month-scale (90–180 days)**, not days — cost is asymmetric (an over-long tombstone is a tiny meta record; too short forces a full-resync). Prevents the Cassandra-zombie resurrection a bare grace-drop would allow. Phase 2.

Used in: `spec/sync-protocol.md` §11

### **traffic analysis** &nbsp; ⚠️ *Threat*

Adversary class A13: a server-side or network observer correlating sync timing, blob sizes, and account activity to infer behavior even without decrypting content. Myne v0.1 is Best-effort against A13 — sync timing, blob count, and blob size are visible to anyone observing the network or the server, and connection IPs are visible transiently (not logged). Padding, cover traffic, and timing randomization are deferred beyond v0.1.

Used in: `threat-model.md` §1 (A13), §7

### **transcript** &nbsp; 📦 *Product*

The machine-produced text of an audio attachment — the output of on-device [speech-to-text](#speech-to-text-asrstt) (ASR). Unlike a lossless PDF text-layer, an ASR transcript is **lossy and model-dependent**: a different Whisper model (or a bump of the [extractor version](#extractor-version)) yields different text, so it is honestly a fallible machine guess, not a verbatim record. Cached per attachment in the [`MYE1`](#mye1) [extracted-text](#attachment-text-extraction) blob (device-local, rebuildable, never synced) for ambient search parity, and separately **insertable into a note body by an explicit user action** (SYNC-17) — that inserted copy is ordinary note text on the `MY01` `note_save` path, so it is synced, backed up, and editable (the hybrid representation, `decisions.md` 2026-07-19). (MYND-270)

### **Trash** &nbsp; 📦 *Product*

The vault-internal soft-delete state introduced in v0.2 (MYND-133): deleting a note moves it to the Trash (recoverable) instead of erasing it; a separate Trash panel lets the user restore a note or permanently delete it (single, or "empty trash"). Represented **inside the encrypted blob** as the Myne-managed `trashed:` frontmatter field (an RFC 3339 timestamp), not as a `<vault>/.trash/` directory — so a filesystem adversary (A4/A7) learns nothing new and the on-disk layout stays flat (`protocol.md` §9.1 unchanged), preserving the same AS3 posture as virtual folders (MYND-144). Trash/restore are **TS orchestrators** (`src/notes/trashNote.ts` — set/clear `trashed:` via the existing `note_update`), not new backend commands; "empty trash" hard-deletes each trashed note via the existing `note_delete` (`src/notes/emptyTrash.ts`). Trash is **manual-only** — nothing auto-expires. Because every state is either a note-content edit (`trashed:` set/clear) or the existing delete-tombstone, soft-trash adds no new Phase 2 sync wire-format state. Distinct from **hard-delete** (`note_delete`, the v0.1 permanent erase that the Trash panel's "Delete permanently" still invokes) and from OS-level "Move to Trash" (permanently rejected, `decisions.md` 2026-05-07). See [markdown-dialect.md](spec/markdown-dialect.md) §3.6.1 (`trashed:` field), [decisions.md](decisions.md) 2026-06-03 (the implementing entry) + 2026-05-07 (the deferral).

Used in: `spec/markdown-dialect.md` §3.6.1, `decisions.md` 2026-06-03 + 2026-05-07 (MYND-133)

### **trust boundary** &nbsp; ⚠️ *Threat*

A line in the system where the security model changes — what is trusted on one side is not trusted on the other. Myne catalogs nine boundaries (TB1–TB9). See `threat-model.md` §3 for the full table.

Used in: `threat-model.md` §3

### **typewriter scroll** &nbsp; 📦 *Product*

A [focus-mode](#focus-mode) writing aid (MYND-348): the line being edited is kept vertically centered in the viewport as the writer types, so the eyes stay in one place instead of drifting to the bottom of the screen. A hand-rolled CodeMirror extension (active-line scroll-margin / `scrollIntoView` centering — **no new dependency**) gated by the editor root's `data-focus-typewriter` attribute (set only when focus mode is active **and** the `editor_focus_typewriter` MYP1 pref is on — default on; the Settings → Editor toggle flips it). Honors `prefers-reduced-motion`. Toggleable because some writers find the constant re-centering disorienting. Non-load-bearing cosmetic (AS-low). See also [focus mode](#focus-mode), [line-focus dimming](#line-focus-dimming).

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-17 (MYND-348)

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

### **vault head** &nbsp; 📋 *Protocol* (deep entry)

The malicious-server hardening primitive for Phase 2 sync: a small, server-relayed, per-push record that commits the vault's current state under an HMAC-SHA-256 keyed by `DeriveSubkey(root_key, "vault-head-mac")` (§3.4). It commits a flat `SHA-256` of the canonical [vault-head manifest](#vault-head-manifest) (`uuid → content_nonce` of content blobs only — notes + attachments), a per-device [version vector](#version-vector-vv), and `prev_head_hash[]` parent links ([head_id](#head_id)s) forming a git-like hash-DAG, plus an auxiliary Lamport `seq`. Provides [fork-consistency](#fork-consistency): devices verify on pull that a new head **extends** their last-seen one (VV-dominance), and divergence surfaces on cross-read. The head is **wire-only** (no on-disk magic; the device-local last-seen baseline is the `MYH1` `vault.head-state` blob, `spec/protocol.md` §9.16). The server, lacking `root_key`, can only replay/withhold/reorder real heads, never forge one. **HMAC-not-signature**: single-user → all devices share `root_key` → a symmetric MAC suffices (no Ed25519, closed primitive set). Phase 2; full spec in `spec/sync-protocol.md`.

Used in: `spec/sync-protocol.md`; `spec/protocol.md` §3.4, §9.16, §10.3; `threat-model.md` §7 (MYND-416)

### **vault-head manifest** &nbsp; 📋 *Protocol*

The `uuid → content_nonce` map of a vault's **content blobs only** (notes + attachments; synced singletons like [vault.prefs](#vaultprefs) / [vault.meta](#vaultmeta) are excluded — their rollback is the already-accepted "local prefs replay" of `threat-model.md` §7). A [vault head](#vault-head) commits a flat `SHA-256` of this map's canonical encoding (uuid-sorted, fixed-width), not the map itself, keeping the head O(1). Binding [content_nonce](#content_type) (fresh-random per save, §6.3) rather than a bare counter gives **two-layer** rollback detection: a server serving an old version mismatches the manifest *before* decryption, and the AEAD nonce-binding makes a header/content splice fail *on* decrypt. The manifest object's own canonical encoding is the sync wire protocol's concern (MYND-414); the head only anchors its hash. Phase 2.

Used in: `spec/sync-protocol.md` (vault head)

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

### **vault.embeddings** &nbsp; 📦 *Product*

Vault-level singleton encrypted blob ([`MYR1`](#myr1), `spec/protocol.md` §9.17) caching the on-device **AI embedding index** — the dense semantic-search / Q&A vectors (MYND-453, local-ai epic). The structural twin of [vault.search](#vaultsearch): same 34-byte fixed-offset header (magic `MYR1`, protocol_version, an `embeddings_format_version` byte, nonce, ciphertext_len), same **engine-opaque** postcard inner plaintext (a `{note_id → content_nonce}` staleness manifest + the serialized vector store), same decryption-free `content_nonce` reconcile + [fall-to-rebuild](#fall-to-rebuild) posture — but stores embedding vectors, not full-text terms, and additionally carries a trailing **model-identity tuple** `{model_hash, embedding_dim, chunker_version}` that forces a full re-embed when the embedding model, its output dimension, or the chunker changes (vectors are model-specific; the embeddings analogue of `vault.search`'s `extractor_version`, carried inside the payload — **not** the AAD, which stays vault-scoped). AEAD-encrypted under `ai_embeddings_key` (`DeriveSubkey(root_key, "ai-embeddings-key")`); a pure **rebuildable cache** (deleting it loses nothing — the `.myn` files are the source of truth) — [rebuildable-cache](#sync-artefact-classes) Class 3, so **never synced and never backed up** (device-local; `sync-protocol.md` §319). Written only when the runtime beta opt-in `ai_enabled` is on (AI ships in the default build as of `decisions.md` 2026-07-02; a `--no-default-features` build never compiles the AI path and never writes it). At-rest size leaks a coarse embedded-volume signal, accepted as a derived-cache leak (`threat-model.md` §7, with the embedding-inversion note).

### **vault.graph** &nbsp; 📦 *Product*

Vault-level singleton encrypted blob ([`MYG1`](#myg1), `spec/protocol.md` §9.19) caching the knowledge-[graph view](#graph-view)'s laid-out **node positions** (`note_id → x/y`) + a schema-version marker, so reopening the app restores the previous force-directed layout instead of recomputing it. A structural sibling of [vault.workspace](#vaultworkspace): same 34-byte fixed-offset header (magic `MYG1`, protocol_version, a `graph_layout_format_version` byte, nonce, ciphertext_len), same **engine-opaque** inner plaintext (the client serializes the position map; the codec sees only bytes), same [fall-to-rebuild](#fall-to-rebuild) posture — but its staleness is caller-side and loose (a layout for a drifted note-set is still usable; missing notes get fresh seeds, and the graph's Refresh forces a full re-layout). AEAD-encrypted under [graph-layout-key](#graph-layout-key) (`DeriveSubkey(root_key, "graph-layout-key")`); a pure **rebuildable cache** (deleting it loses nothing — the `.myn` files are the source of truth) — [rebuildable-cache](#sync-artefact-classes) Class 3, so **never synced and never backed up**. Positions are dropped on vault lock (so vault A's layout never seeds vault B). At-rest size leaks a coarse note-count signal, accepted as a derived-cache leak (`threat-model.md` §7).

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

### **version vector (VV)** &nbsp; 🏗️ *Construction*

A per-device monotonic counter map (`device_id → count`) embedded in and MAC'd by each [vault head](#vault-head), carrying the count of heads each [device](#device_id-vv-actor) has authored (at **push** granularity, not per keystroke). It is the single mechanism behind both concurrency and fork detection: componentwise comparison of a new head's VV to the last-seen one yields **extension** (≥ componentwise → accept), **rollback** (any decreased component → reject), or **incomparable** (concurrent → the device writes a merge head, componentwise-max + author+1). A VV that *never* re-converges across devices is a [fork](#fork-consistency); one that is merely incomparable is a legitimate concurrent edit. This is the same VV the sync conflict layer uses — fork-consistency adds no separate structure. Not pruned in v1 (a unilateral drop would let a server hide a fork; a v005 prune must ride an authenticated device-retirement event). Phase 2.

Used in: `spec/sync-protocol.md` (vault head)

### **view mode** &nbsp; 📦 *Product*

The per-tab live / reading / source axis for a note tab (MYND-299) — the three ways a note's buffer renders: **live** (today's default, the [cursor-aware reveal](#cursor-aware-reveal) live-preview surface), **[reading](#reading-view)** (rendered, read-only, no reveal), and **[source](#source-mode)** (raw markdown, decorations off). Stored per tab as an optional `viewMode?: "live" | "reading" | "source"` field on each tab's [workspace](#named-workspace) descriptor item — engine-opaque inside `MYW1`, omit-when-default (absent ≡ live), serialized exactly like the existing `pinned` flag, **no** `workspace_format_version` bump for the field itself. The vault-wide **default** for newly-opened tabs is the separate MYP1 `editor_default_view_mode` field (enum string, omit-when-default, `live` canonical default). The primary Edit ⇄ Reading toggle is `Mod-Shift-E`; the secondary live ↔ source toggle has no default chord (command palette + the bottom-bar **view-mode switcher**, which reflects the current mode in `data-view-mode`). A read-only **preview companion** can open a [Reading-view](#reading-view) mirror of the same buffer side-by-side without a second editable instance. See also [Reading view](#reading-view), [Source mode](#source-mode), [cursor-aware reveal](#cursor-aware-reveal).

Used in: `spec/protocol.md` §9.5.2, §9.7; `decisions.md` 2026-06-17 (MYND-299)

### **view order** &nbsp; 📦 *Product*

The user-controlled display order of [saved views](#saved-view) in the sidebar "Views" section + the views list (Saved Views epic, MYND-274 / SYNC-10). Persisted as the `view_order` field of [vault.prefs](#vaultprefs) — a **sequence** array of view ids (NFC-normalized, order preserved verbatim, NOT sorted or deduped, omitted-when-empty), exactly the [item order](#item-order) / [favorites](#favorites) discipline. A stale id (a deleted view) is ignored at render and pruned on the next write (no codec GC). The list renders `view_order`'s ids first (in order), then any saved view not yet in it. See also [saved view](#saved-view), [item order](#item-order). (MYND-274)

Used in: `spec/protocol.md` §9.5.2; Saved Views (MYND-273 / MYND-274)

### **view type** &nbsp; 📦 *Product*

The render shape of a [saved view](#saved-view) (Saved Views epic, MYND-271). The closed v0.1 set is **table / cards / list** (Obsidian-Bases' `map` is dropped, SYNC-5); all three ship — cards (MYND-275), table (MYND-277), list (MYND-278) — behind one `viewRenderHost` dispatch. Every view type renders the **same** grouped query result read-only — no editable cells, no kanban drag-columns — so the choice is purely presentational (cards add a cover [`image:`](#attachment) + groupBy headers; table renders the view's property columns; list reuses the note-list row). The view type is one field of the view definition stored in `vault.prefs` / `MYP1`.

Used in: Saved Views (MYND-271)

### **voice note** &nbsp; 📦 *Product*

A note audio clip embedded inline — either a recorded microphone capture or an attached audio file. Stored as an ordinary [attachment](#attachment) (an `audio/wav` [`MYA1`](#mya1) blob — **no new on-disk format**, so a recording made on any client plays on all of them) referenced by the form-C embed `![[att:<id>|filename]]`. **Desktop** captures **natively in Rust via `cpal`** (not the WebView MediaRecorder, so PCM stays Rust-side + `Zeroize`-able) and plays via an inline custom waveform widget. **Mobile** (Tauri Mobile, where `cpal` does not cross-compile as a mic source) captures in the WebView via the **Web Audio API** (`getUserMedia`), wraps the PCM as the same `audio/wav` container in TS, imports it through the ordinary attachment path, and renders an inline `<audio controls>` in reading mode (`decisions.md` 2026-07-12). Both encode mono 16-bit and buffer in RAM only (never a plaintext temp file). `audio/wav` is in the [`attachment://`](#attachment) serve allowlist + the sniffer (a `RIFF`…`WAVE` arm). (MYND-259; `decisions.md` 2026-06-14, 2026-07-12)

### **Vite** &nbsp; 🛠️ *Tooling*

The build tool and dev server used by the Phase 1 desktop client to bundle the React UI before Tauri ships it as a static asset bundle. Chosen over Next.js (`decisions.md` 2026-04-26) because Tauri ships a static bundle — Next.js's SSR / RSC / API-route value is architecturally unused, while its ~10× larger transitive npm dependency footprint vs Vite is paid in full. The smaller direct-npm-dependency surface aligns with the threat-model §7 "deliberately small direct-dependency surface" commitment for A8/TB9.

Used in: `decisions.md`; `threat-model.md` §7
Reference: https://vite.dev

### **unlinked mention** &nbsp; 📦 *Product*

A note whose prose mentions the open note's **title** as a whole-word, fold-identity phrase **without** `[[wikilink]]`-ing it — surfaced as a collapsed-by-default second section of the **backlinks** pane with a one-click "link" action (Obsidian-parity discovery/cleanup aid; MYND-196, build-phase v1.1). Distinct from a backlink, which is an explicit link. Candidate recall rides the existing encrypted `vault.search` body index as a *filter only*; identity is verified by a `foldSegment` word-boundary match on the decrypted candidate body (`vault.search`'s language-detecting tokenizer is never the identity authority). A corpus-relative phrase document-frequency floor (df > ~0.15 → suppress) plus a ≤2-folded-char guard suppress common/short titles; the 0.15 threshold is a **tunable code constant, not spec** (deliberate contrast with the frozen Damm-32 table). Adds **no new at-rest artefact** — the guarantee surface does not move. Clicking "link" inserts `[[Title]]` through the canonical `saveNote` write path and never clobbers an open+dirty note (SYNC-15 guard).

Used in: `myne-agents/features/unlinked-mentions/prd.md`, `spec/wikilink.md`, `vision.md` Phase 1 Scope

### **math (markdown)** &nbsp; 📦 *Product*

LaTeX math rendered in the editor (MYND-48): inline `$…$` (a custom `InlineMath` Lezer node) and block `$$…$$` (a regex block decoration), typeset by lazy-loaded KaTeX, cursor-aware (raw LaTeX revealed on-cursor; invalid LaTeX → source + a subtle dotted-underline hint, never KaTeX's red node). The `$`-disambiguation keeps currency text (`$5`, `$ €`) from parsing as math (opening `$` not followed by whitespace/digit, closing `$` not preceded by whitespace, `$$` = block, single-line). `InlineMath` is a leaf → no `#tags`/emphasis inside; math doesn't parse in code. Render-only, never emitted (§6 C1). Supersedes the §7 math deferral (`decisions.md` 2026-06-08).

Used in: `spec/markdown-dialect.md` §3.2/§7

### **mermaid diagram** &nbsp; 📦 *Product*

A ```mermaid fenced code block rendered as an SVG diagram in the editor (MYND-49) via lazy-loaded Mermaid (`securityLevel:'strict'`, `htmlLabels:false` — mermaid sanitizes its own SVG with its bundled DOMPurify). `fenced-code.ts` skips the `mermaid` info-string so the diagram widget renders it instead of a code card; parse-error / load-failure falls back to a monospace card. Cursor-aware whole-block reveal; render-only (§6 C1). Mermaid is the **heaviest dependency** in the project (≈+100 transitive packages), lazy-loaded so a diagram-free note pays zero bytes — shipped as a conscious decision (`decisions.md` 2026-06-08) over the auto-grill's defer recommendation. PlantUML is not rendered (stays a code card).

Used in: `spec/markdown-dialect.md` §7; `dependency-policy.md`

### **subscript / superscript (markdown)** &nbsp; 📦 *Product*

The `~x~` (subscript) and `^x^` (superscript) inline constructs, rendered with reduced-size, vertically-shifted typography (MYND-156, `.cm-sub` / `.cm-sup`). Use the pre-built `@lezer/markdown` Subscript/Superscript configs; single-run and space-free (Pandoc-style), disjoint from GFM strikethrough `~~…~~` and footnote `[^id]`. Recognize-and-render-only — never emitted; bytes preserved (§6 C1).

Used in: `spec/markdown-dialect.md` §3.2

### **Weblate** &nbsp; 🛠️ *Tooling*

The self-hosted web translation platform at `translate.myne.md` (Komodo stack on the apps VPS; closed registration, admin-invite only) that owns Myne's non-English **locale catalogs**. English source strings are authored in code and committed; Weblate reads the source, lets translators fill `tr`/`de`/`fr`, and flows translations back as commits to a dedicated push branch (merged via PR). File mask `locales/*/common.json`, format *i18next JSON v4*, monolingual base `locales/en/common.json`.

Used in: `docs/dev/i18n.md`; `decisions.md` 2026-06-25.

### **wikilink** &nbsp; 📦 *Product* (deep entry, *Myne-divergent*)

Myne's first-class internal-link syntax: `[[…]]`-bracketed references that resolve against the current vault and render as atomic chip widgets in the editor. Recognized forms include title-only (`[[Note]]`), aliased (`[[Note|Display]]`), heading-anchored (`[[Note#Heading]]`), block-referenced (`[[Note^block-id]]`), path-encoded (`[[vault/relative/path.md|Display]]`), and embed prefixes (`![[Note]]`, `![[image.png]]`). Full grammar in `spec/wikilink.md`. **Myne-divergent from Obsidian conventions in two load-bearing ways:** (1) new Myne-authored wikilinks emit the **path-with-alias** form `[[vault/relative/path.md|Display Title]]` rather than the title-only form, making every Myne-authored wikilink self-resolvable from the markdown alone — improving the wedge sentence from "plain markdown after decryption" to "*resolvable* plain markdown after decryption"; (2) imported Obsidian wikilinks are preserved byte-for-byte (hard rule C1) and coexist indefinitely with Myne-authored path forms. Decoration treats both forms identically as atomic chips; click-resolution differs (title-only via vault-index lookup; path-form follows directly). Auto-update on rename preserves syntactic shape — never promotes form. The manual conversion command (R2 in `wikilink.md` §7) is the only sanctioned migration path from imported title-only to path-form. Wikilinks are **not** standard markdown; no CommonMark / GFM / Pandoc / Djot dialect natively defines them.

Used in: `spec/wikilink.md`, `spec/markdown-dialect.md` §3.5, `vision.md` Phase 1 Scope

### **wikilink chip** &nbsp; 📦 *Product*

The atomic-range rendered widget representing a **wikilink** (`[[Note]]`, `[[Note|Display]]`, `[[Note#Heading]]`, `[[Note^block-id]]`, `[[path.md|Alias]]`, `![[Embed]]`) inside the Phase 1 editor surface. Implemented as a CodeMirror 6 `Decoration.replace` paired with `EditorView.atomicRanges` registration so cursor navigation, selection extension, and Backspace / Delete treat each chip as a single indivisible unit. Unlike other inline-mark decorations, chips do **not** lift on cursor entry — they stay rendered regardless of cursor position; the underlying `[[...]]` source remains in the buffer byte-for-byte. `editor-mvp-baseline` ships chip **rendering** (visual + atomic-range behavior); the authoring layer (autocomplete picker, hover-tooltip path resolution, manual conversion, auto-update on rename) lands in `editor-mvp-wikilinks`.

Used in: `myne-agents/features/editor-mvp-baseline/prd.md`, `spec/wikilink.md` §5.4, `myne-agents/sessions/grill/2026-05-16-mynd-36-editor-inner-scope.md` Q6

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
| `head_mac_key` | Reserved for Phase 2 [vault head](#vault-head) fork-consistency MAC (`vault-head-mac`) | Derived only (not used in v0.1) | Session |
| `account_number` (95-bit + Damm) | User identifier; bearer token in P2+ | User offline storage | Permanent |
| `account_number_hash` (SHA-256[:16]) | Argon2id salt binding | `vault.meta` | Vault lifetime |

### Index 3 — Magic bytes and context-prefix registries

| Major version | Per-note magic | Vault-meta magic | AAD prefix | Context-string prefix | Status |
|---|---|---|---|---|---|
| v0.1 | `MY01` | `MYV1` | `"myne.v0.1|"` | `"myne.v0.1 "` | Active (this document) |
| v005 | `NT05` | `NTV5` | `"myne.v005|"` | `"myne.v005 "` | Reserved; specification TBD |

The four prefixes for a single major version are deliberately non-interchangeable: each lives in a different cryptographic call site, and using one in place of another is a protocol violation. See entry **`myne.v0.1` prefix** and `spec/protocol.md` §10.3.

### Theme preference

The user's Light / Dark / System choice, persisted as the `theme` field of [`vault.prefs`](#prefsview) (`spec/protocol.md` §9.5.2). An optional string — `"light"` or `"dark"` — where **absence of the key is the canonical encoding of "system"** (follow the OS `prefers-color-scheme`); there is no `"system"` value, so a vault that made no explicit choice omits the field and stays byte-identical to a pre-MYND-110 blob. Rendering is a **pure-CSS hybrid**: an explicit choice sets `<html data-theme="light|dark">` (overriding the OS); System and every pre-unlock screen carry no attribute, so a `prefers-color-scheme` `@media` block follows the OS live with no JS. The preference is **non-load-bearing** — a cosmetic UI setting (AS-low) with no protective-envelope clamp (unlike [AUTO_LOCK_CEILING](#auto_lock_ceiling)); a tampered or replayed `vault.prefs` can at worst surface the wrong color, and an unrecognized value decodes to "system" rather than failing. It lives inside the encrypted blob (not plaintext) so a disk-at-rest adversary learns nothing — the same structural-privacy reasoning that keeps [auto-lock](#auto-lock-on-idle)'s timeout encrypted. On lock the attribute is removed (the UI follows the OS), the UI-layer image of zeroize-on-lock. The theme is a [device-local pref](#device-local-pref) (`sync-protocol.md` §10.2, MYND-478): presentation is per-device taste, so it never crosses the Phase 2 prefs merge. Introduced MYND-110. See also [PrefsView](#prefsview), [syntax color tokens](#syntax-color-tokens), [custom theme](#custom-theme).

### custom theme

A user-authored color palette — distinct from the built-in Light/Dark [Theme preference](#theme-preference). A flat map of CSS custom-property names to values (`{ "--paper": "#…", "--ink-1": "#…", … }`): a **single flat palette** that, when selected, *overrides* Light / Dark / System rather than carrying per-mode variants. It is validated host-side (Rust) — the minimal raw-ramp token core must be present, and every value must match a **value-shape allowlist** (hex / `rgb()` / `rgba()` / `hsl()` / named color / `<number><unit>`), the *primary* injection guard because the WebView keeps `style-src 'unsafe-inline'` (`threat-model.md` custom-theme CSS-value surface; `decisions.md` 2026-06-16). **The palette is vault content**: it lives in the encrypted [`vault.themes`](#vaultthemes) blob (`MYT1`, `spec/protocol.md` §9.21) — encrypted at rest, synced, and backed up — while the *selection* `custom:<name>` persists in the encrypted [`vault.prefs`](#prefsview) `custom_theme` field (the blob holds the palettes, prefs holds the pointer). This **supersedes** the original device-local plaintext `app_config_dir/themes/<name>.json` storage (`decisions.md` 2026-07-16); palettes now enter and leave only by explicit user import/export of a `.json`. A custom theme is **validated, not sandboxed**: it is not a security boundary, only a guarded cosmetic surface. Introduced MYND-111 (custom-themes epic); promoted to vault content MYND-486. See also [Theme preference](#theme-preference), [vault.themes](#vaultthemes), [syntax color tokens](#syntax-color-tokens).

### **vault.themes** &nbsp; 📦 *Product*

The encrypted singleton blob (`MYT1`, `spec/protocol.md` §9.21) holding every [custom theme](#custom-theme) palette in a vault, as a map `{ theme_name → { palette, clocks } }`. Sealed under `custom_themes_key = DeriveSubkey(root_key, "custom-themes-key")` — `root_key`-derived and itemsKey-independent, like [vault.prefs](#vaultprefs) / the [personal dictionary](#personal-dictionary) — with AAD role `"custom-themes-blob"` binding `account_number_hash`. A **singleton**, not a per-item family with a catalog: a vault holds a handful of themes. Each name carries its own `created_at`/`updated_at`/`deleted_at` clocks so the Phase-2 sync merges **per theme name** (two devices adding different themes both keep theirs), with the palette LWW within a name and deletions carried as tombstones under the [attachment catalog tombstone](#attachment-catalog-tombstone) resurrection guard (`sync-protocol.md` §10.2.2). Its reserved sync blob-id is `themes_sync_id = DeriveSubkey(root_key, "themes-sync-id")[0..16]` — an *identifier* derivation, not a KEK. A §9.11.3 backup-allowlist member (`sync ⊆ backup`). Introduced MYND-486.

### theme-install deep link &nbsp; 📦 *Product*

A `myne://theme/install?v=1&name=…&author=…&src=…&payload=…` URL that hands a [custom theme](#custom-theme) from the website's Themes page to the desktop app in one click (MYND-567; website half MYND-568). The OS resolves the `myne://` scheme to the installed app — registered at bundle time on macOS / Windows / Linux — which then shows a **confirmation dialog** (name, author, source, palette preview) before anything is written; Apply routes through the ordinary `themes_import` into [`vault.themes`](#vaultthemes), Cancel writes nothing.

The palette travels **inside the URL** as base64url-encoded JSON, not as a link the app fetches: the client has no network egress path (CSP `connect-src` allowlist + no HTTP-client crate, gated by `no_egress.rs`), so a `src=` parameter is **displayed provenance only, never dereferenced**. Every field is treated as hostile input — any website can serve such a link — under explicit caps (16 KiB decoded payload, 64-char name, fatal UTF-8 decoding, control/bidi stripping on display strings), and the payload must still clear the host-side `theme_validator` value-shape allowlist before it is sealed. A link arriving while the vault is locked is held in an in-memory latch and presented after unlock, then dropped with the process if the user never unlocks. The `myne://` scheme is **shared with the mobile client**, which owns the `open` and `capture` actions (`decisions.md` 2026-07-13); each client ignores the other's actions. Introduced `decisions.md` 2026-07-25. See also [custom theme](#custom-theme), [vault.themes](#vaultthemes).

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
