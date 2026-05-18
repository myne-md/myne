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

Myne's user identifier. A 20-character canonical value composed of 19 random Crockford base32 characters (95 bits of entropy) plus 1 Damm-32 check character, displayed as `MY-XXXX-XXXX-XXXX-XXXX-X`. The account number replaces email at signup; it is bearer-token semantics in Phase 2+ (anyone in possession of it can authenticate sync requests for that account, like a Mullvad VPN account) but it is **not** a key — it does not encrypt anything, and possession alone does not unlock a vault. The cryptographic role is via `account_number_hash`, which binds Argon2id salts to this account and prevents pre-computation attacks across accounts.

Used in: `spec/account-number.md`, `spec/protocol.md` §8

### **account_number_hash** &nbsp; 🗝️ *Key/identifier* (deep entry, *Myne-divergent*)

*(Aliases: account hash. Myne-divergent: yes — two different truncation lengths in different roles.)*

A SHA-256 hash of the canonical account number. **Truncation differs by use site**: for Argon2id salt construction (§3.1 of the protocol spec) it is 16 bytes — `SHA-256(canonical_account_number)[:16]` — and stored in `vault.meta`. For Phase 2+ server-side identification (`spec/account-number.md` §7) it is 32 bytes — `SHA-256(canonical)[:32]` — stored in the sync server registration table. The two lengths are deliberate to avoid identifier reuse across uses; readers must check which length applies in context.

Used in: `spec/protocol.md` §3.1, §8.3; `spec/account-number.md` §6, §7

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

A capacity-1 `tokio::sync::Semaphore` on `VaultRuntimeState` (Rust-side singleton in `src-tauri/src/plugins/vault_unlock/state.rs`) shared across all three Argon2id-bound vault auth commands: `vault_unlock`, `vault_recover_with_phrase`, and `vault_complete_recovery`. Each command acquires via `try_acquire()` (reject, never queue) at the start of its critical section and releases via RAII guard on every return path. The single-permit invariant guarantees at most one ~1-second Argon2id derivation in flight client-wide, defending the no-queue posture (`decisions.md` 2026-05-02 "Phase 1 unlock UI semantics") uniformly across plugins. Renamed from `unlock_permits` (the pre-recovery-flow shape) when the recovery commands started sharing the lock.

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization"

### **backup-key** &nbsp; 🗝️ *Key/identifier*

A subkey derived from `root_key` via the `derive_key` pattern with context string `"myne.v0.1 backup-key"`. Used to encrypt user-initiated backup files exported from the client. Stored only transiently during the backup operation.

Used in: `spec/protocol.md` §3.4

### **bidirectional links** &nbsp; 📦 *Product*

*(Aliases: backlinks, wikilinks.)*

Links between notes that are queryable from both endpoints — opening a note shows which other notes link to it. Myne supports the `[[wikilink]]` syntax in v0.1 with a backlinks pane; the graph view (Cytoscape-based) is also part of v1.0 scope (`vision.md` Phase 1 Scope).

Used in: `vision.md` Phase 1 Scope

### **BIP-39** &nbsp; 🏗️ *Construction* (deep entry, *Myne-divergent*)

*(Aliases: mnemonic phrase encoding. Myne-divergent: yes — encoding only.)*

Bitcoin Improvement Proposal 39, defining a mapping from random entropy to a sequence of human-friendly English words plus a checksum. **Myne uses BIP-39 only as an encoding** for 256-bit recovery phrases — the 24 words present, capture, and re-enter 256 bits of secret entropy plus an 8-bit checksum. Myne does **not** use BIP-39's standard PBKDF2-HMAC-SHA512 with 2048 iterations to derive a wallet seed; that derivation is too weak by 2026 cryptographic standards. Instead, the normalized phrase string is fed directly to Argon2id with the protocol's standard parameters to derive `recovery_wrap_key` (`spec/protocol.md` §7.1). This divergence is intentional and load-bearing for the recovery-phrase security argument.

Used in: `spec/protocol.md` §7
Reference: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki

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

### **code-signed releases** &nbsp; 🛠️ *Tooling*

Myne desktop installers and auto-update payloads are cryptographically signed with hardware-backed keys controlled by the team. Auto-update verification (`threat-model.md` §3 TB7) refuses any artifact that fails signature or hash check. The signing keys are themselves the largest unmitigated risk against A9 (compromised distribution).

Used in: `threat-model.md` §3 TB7, §6

### **CodeMirror 6** &nbsp; 🛠️ *Tooling*

The code-editor framework used as the markdown editor in Myne's Phase 1 desktop client. Provides syntax highlighting, live preview, and the foundation for `[[wikilink]]` parsing. Same library that Obsidian uses internally.

Used in: `vision.md` Phase 1 Scope

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

The table in `spec/protocol.md` §3.4 listing every authorized context string and its role for v0.1. Adding a new role in a minor revision means adding a row to the registry, not bumping the protocol version. Registered roles in v0.1: `server-auth`, `itemsKey-wrap`, `backup-key`. v005 strings will be registered under the `"myne.v005 "` prefix.

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

### **Cytoscape.js** &nbsp; 🛠️ *Tooling*

The graph-visualization library used for Myne's minimal graph view in Phase 1. Lazy-loaded into a separate panel rather than rendered in the editor surface.

### **decoration layer** &nbsp; 📦 *Product*

The CodeMirror 6 render overlay that hides or replaces ranges of the markdown buffer visually without mutating the underlying text. Decorations come in four kinds: `mark` (apply a CSS class to a range — used to hide leading `#`s), `widget` (insert a DOM element at a position — used for wikilink chips, task list checkboxes), `replace` (hide a range and substitute a widget — used for table widgets and code-block frames), and `line` (per-line attributes on the wrapping `cm-line` div — used for blockquote left-border styling). The decoration layer reads the `@lezer/markdown` AST and produces decorations per node type. The text buffer is canonical; decorations are ephemeral state derived from the buffer plus cursor position.

Used in: `vision.md` Phase 1 Scope

### **DecryptedNote** &nbsp; 📦 *Product*

The opaque Rust handle returned by `protocol::decode_note` on a successful per-note decryption (`spec/protocol.md` §6.4). Carries — privately — the original 112-byte header slab from the source `.myn` blob (bytes 0..47+N: magic + version + reserved + items_key_id + item_key_nonce + enc_item_key_len + enc_item_key), the unwrapped 32-byte `item_key` in `Zeroizing<[u8; 32]>`, the decrypted markdown plaintext in `Zeroizing<Vec<u8>>`, and the `note_uuid` carried out-of-band per §9.1 (the `.myn` filename, not in the blob bytes). All four fields are private; consumers reach the non-secret subsets through accessor methods that slice into the slab. The slab retention is load-bearing for §6.3's "bytes 0..47+N byte-identical across revisions" invariant: `encode_update` splices the slab verbatim into the new blob, never reconstructs the prefix from fields. `Drop` zeroizes both `item_key` and `plaintext`; the `Debug` impl is hand-written and emits redacted markers (a regression test pins the no-leak property). `encode_update` consumes the handle by value (typestate "one decode, one update"); `encode_update_blob_raw` borrows for D6-style nonce-permutation tests.

Used in: `spec/protocol.md` §6, `decisions.md` 2026-05-05 "`item_key` persistence across note revisions"

### **Damm-32 / Damm algorithm** &nbsp; 🏗️ *Construction*

A check-digit algorithm using a totally anti-symmetric quasigroup (Damm 2004), generalized here to a 32-character alphabet matching Crockford base32. Myne appends one Damm-32 character to the 19-character account-number payload to catch single-character substitutions, all adjacent transpositions, and a high fraction of two-character errors. The 32×32 quasigroup table itself is an open issue in `spec/account-number.md` §4 — it must be selected from a published source and frozen before v1.0 ship.

Used in: `spec/account-number.md` §4

### **DEM (Data Encapsulation Mechanism)** &nbsp; 🏗️ *Construction*

The symmetric-encryption layer in a hybrid encryption scheme — pairs with a KEM. Myne does not use KEM-DEM in v0.1 (no asymmetric encryption); referenced in the v005 roadmap for sharing operations.

Used in: `spec/protocol.md` §11 (out of scope for v0.1)

### **derive_key pattern** &nbsp; 📋 *Protocol* (deep entry)

Myne's mandated single-helper pattern for subkey derivation. All HKDF-Expand calls in the protocol go through one canonical function — `DeriveSubkey(rootKey, role) → 32 bytes` — which constructs `info = "myne.v0.1 " || role` from the registered role table (§3.4). Direct calls to HKDF-Expand outside this helper are forbidden by code review. The pattern recovers the API-level safety of BLAKE3's `derive_key` (where context is a first-class argument) while keeping HKDF-SHA-256 as the underlying primitive for libsodium and MLS alignment. Without this helper rule, HKDF's historical misuse mode (malformed or empty `info` parameters) would re-emerge.

Used in: `spec/protocol.md` §3.2.1

### **device key** &nbsp; 🗝️ *Key/identifier*

Reserved term for `appname-v005` multi-device support: a per-device asymmetric key pair stored in hardware (Secure Enclave / TPM / Android Keystore) that participates in MLS group formation. **Not used in v0.1** — single-device protocol does not need device keys.

Used in: `spec/protocol.md` §11 (out of scope for v0.1)

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

### **enc_item_key** &nbsp; 🗝️ *Key/identifier*

The on-disk wrapped form of a per-note `item_key`. Layout per `spec/protocol.md` §9.2: 32 bytes of XChaCha20-Poly1305 ciphertext over the random `item_key`, followed by the 32-byte CTX commitment tag. Encrypted under the singleton `itemsKey` with `item_key_nonce`.

Used in: `spec/protocol.md` §9.2

### **enc_items_key** &nbsp; 🗝️ *Key/identifier*

The on-disk wrapped form of the singleton `itemsKey`, stored in `vault.meta`. 32 bytes of XChaCha20-Poly1305 ciphertext over the `itemsKey` plus the 32-byte CTX tag, encrypted under `itemsKey_wrap_key`.

Used in: `spec/protocol.md` §9.3

### **enc_root_key_password / enc_root_key_recovery** &nbsp; 🗝️ *Key/identifier*

The two on-disk wrapped copies of `root_key` in `vault.meta`. Each is 32 bytes of XChaCha20-Poly1305 ciphertext over `root_key` plus a 32-byte CTX commitment tag. Encrypted respectively under `password_wrap_key` and `recovery_wrap_key`. The dual-credential wrap pattern requires both to exist at vault creation.

Used in: `spec/protocol.md` §3.1, §9.3

### **forward-incompatible major version** &nbsp; 📋 *Protocol* (deep entry, *Myne-divergent*)

Myne's architectural commitment that each major protocol version (v0.1, v005, v006, …) is a closed, complete specification with distinct magic bytes, AAD prefix, and context-string prefix. Cross-major reads happen only via explicit user-initiated migration (`spec/protocol.md` §10.4); a v005 client refuses to silently parse a v0.1 blob, and vice versa. The choice contradicts the additive-extension model common in TLS 1.0–1.2 and OpenPGP; the reasoning is that those protocols' downgrade-attack history (POODLE, FREAK, Logjam, MEGA-2022) shows additive extension to be a structural risk. v005's anticipated changes (PQ hybrid wrap, MLS multi-device, OPAQUE auth, KT log) are too deep to be additive in any honest sense.

Used in: `spec/protocol.md` §10.1

### **forward secrecy** &nbsp; ⚠️ *Threat*

The property that compromise of a long-term key does not enable decryption of past messages encrypted with derived ephemeral keys. Myne v0.1 does **not** provide forward secrecy — the persistent `itemsKey` is reusable across all notes for the vault's lifetime. The `appname-v005` roadmap introduces per-epoch `itemsKey` rotation that would provide forward secrecy by deleting old epoch keys after migration.

Used in: `threat-model.md` §7; `spec/protocol.md` §3.3 (forward-compat note)

### **γ1+γ2 hybrid autosave** &nbsp; 📦 *Product*

The canonical Myne autosave call-pattern locked in `decisions.md` 2026-05-07 "`note_update` IPC … UI-level autosave coalescing": a UI-side state machine composing **γ1 idle-debounce** (a save fires after the user has been idle for N milliseconds since the last keystroke) + **γ2 max-debounce** (a save fires regardless every M milliseconds during sustained typing, so a writer who never pauses still gets a save) + a **latest-wins single-in-flight gate** (if a save is already in flight when another fire is due, the in-flight completes first, then a single follow-up save fires with the latest body — no IPC thrashing) + canonical **flush triggers** (`flush-on-vault-lock` from the original entry; `flush-on-blur` and `flush-on-window-close` pinned by `decisions.md` 2026-05-15). Phase 1 v0.1 timings are N=1000ms, M=10000ms. The pattern lives entirely in the UI; the Rust `note_update` command is stateless and plaintext-blind. Backend-side queueing (γ3) was explicitly rejected because the `notes` plugin holds no own state per `decisions.md` 2026-05-07 "notes plugin scaffold". The Greek-letter naming is internal shorthand inherited from the 2026-05-07 MYND-27 grill where four call-pattern alternatives were enumerated (α stateless, β stateful-handle, γ hybrid, δ deferred — α + γ shipped).

Used in: `decisions.md` 2026-05-07 (pattern), 2026-05-15 (concrete timings); MYND-81

### **graph view** &nbsp; 📦 *Product*

The visualization of `[[wikilink]]` relationships between notes as a force-directed graph. Myne Phase 1 includes a minimal Cytoscape.js-based graph view in a separate, lazy-loaded panel (`vision.md` Phase 1 Scope).

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

### **hosted sync** &nbsp; 📦 *Product*

The convenience-paid tier in Myne's freemium model. Myne-operated zero-knowledge sync server (Phase 2+); identical protocol-level guarantees to a self-hosted instance. Status in v0.1: not yet shipped.

Used in: `vision.md`, `decisions.md`

### **in-transit encryption** &nbsp; 🏗️ *Construction*

TLS 1.3 with strict cipher configuration plus client-side certificate pinning. The transport layer in Myne's protocol is TLS-only — no plaintext fallback (`threat-model.md` §3 TB4). Distinct from at-rest encryption and from the AEAD that ciphertext bytes carry inside their TLS payload.

Used in: `threat-model.md` §3 TB4

### **inline tag** &nbsp; 📦 *Product*

A `#`-prefixed identifier appearing inside note body text (as opposed to the YAML `tags:` frontmatter list). Recognized by the Myne dialect per `spec/markdown-dialect.md` §3.7. Boundary: line-start or whitespace must precede the `#`; `abc#tag` does not match. Character set: Unicode (excluding the General/Supplemental Punctuation blocks and an explicit ASCII-punctuation set). Numeric-only forms (`#1984`) reject; `#y1984` accepts. Nested forms via `/` (`#parent/child`) supported with unbounded depth. The parser only recognizes; never rewrites — byte-stability per §6 C1 extends to inline-tag bytes. Tag identity (case-fold, NFC normalization) is the consuming index layer's responsibility, not the parser's.

Used in: `spec/markdown-dialect.md` §3.7, §6 C1

### **insider threat** &nbsp; ⚠️ *Threat*

Adversary class A11: a Myne team member acting maliciously. The architecture grants the team no privileged read access — keys never leave the client. The single privileged asset is the code-signing key (TB8); compromise reduces to A9 (compromised distribution).

Used in: `threat-model.md` §1 (A11)

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

### **key-committing AEAD** &nbsp; 🏗️ *Construction*

An AEAD that commits to its key, in the sense that no two distinct keys can decrypt the same ciphertext to two valid plaintexts. Plain XChaCha20-Poly1305 is **not** key-committing; Myne achieves the property by wrapping it in CTX commitment.

Used in: `spec/protocol.md` §5.1
Reference: Chan & Rogaway 2022.

### **Key Transparency (KT)** &nbsp; ⚠️ *Threat*

A mechanism for publishing user-key bindings to a verifiable log so that clients can detect malicious server-side key substitution. Out of scope for v0.1 (no multi-device or multi-user identity); a `appname-v005` deliverable.

Used in: `spec/protocol.md` §11; `e2ee-notes-evaluation.md`

### **libsodium** &nbsp; 🛠️ *Tooling*

The canonical cryptographic library across Myne's stack. Used via Rust bindings (`libsodium-sys-stable` or `sodiumoxide`) in the desktop client, Go via `golang.org/x/crypto` (parts of which mirror libsodium primitives) on the server, and `libsodium-js` in the Phase 3 web client. RustCrypto crates are an acceptable fallback for primitives where libsodium bindings prove inadequate, but libsodium remains canonical for audit consistency.

Used in: `spec/protocol.md` §2.2

### **libsodium-js** &nbsp; 🛠️ *Tooling*

WebAssembly-compiled JavaScript port of libsodium. Used in the Phase 3 web client (bundler choice deferred to Phase 3 start; framework is React) and in the Phase 3 React Native mobile clients (via `react-native-libsodium`). Provides Argon2id, XChaCha20-Poly1305, HKDF, and the other primitives the protocol requires.

Used in: `spec/protocol.md` §5.1.4

### **libsodium-sys-stable / sodiumoxide** &nbsp; 🛠️ *Tooling*

Rust FFI bindings to the libsodium C library. The desktop crypto layer uses one of these (selected at implementation time).

Used in: `decisions.md` (Tauri stack realignment)

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

### **Phase 1, Phase 2, Phase 3, Phase 4** &nbsp; 📦 *Product*

Myne's product phasing. See `vision.md` Phase 1 Scope and `decisions.md` for definitions and timelines. Roughly: P1 = single-user desktop local-only; P2 = sync server + optional web client; P3 = mobile clients + full web client; P4 = sharing + real-time collaboration + plugin API.

Used in: `vision.md`, `decisions.md`

### **plausibly-deniable encryption** &nbsp; ⚠️ *Threat*

Encryption schemes (e.g., VeraCrypt's hidden volumes) where a vault can be opened to multiple distinct plaintexts depending on which password is supplied, providing deniability under coercion. Myne v0.1 does not implement plausibly-deniable encryption; coercion (A12) is explicitly out of scope. v005 may revisit but only with caution — partial deniability schemes are easy to misimplement and easy to claim falsely.

Used in: `threat-model.md` §5, §7

### **Poly1305** &nbsp; 🔐 *Primitive*

The one-time MAC algorithm by Daniel J. Bernstein, used as the authenticator inside ChaCha20-Poly1305 and XChaCha20-Poly1305. In Myne's CTX-wrapped construction the 16-byte Poly1305 tag T is recomputed at decrypt time from `(K, N, AAD, ciphertext)` rather than stored on disk; only the 32-byte CTX commitment tag T' is persisted.

Used in: `spec/protocol.md` §5.1

### **post-compromise security** &nbsp; ⚠️ *Threat*

The property that protocol participants can recover from a compromise of state — future communication remains protected even after a transient compromise. Provided by ratchet-style protocols (Signal Double Ratchet, MLS); not provided by Myne v0.1's static key hierarchy. A `appname-v005` design goal.

Used in: `threat-model.md` §7

### **post-quantum cryptography** &nbsp; 🔐 *Primitive*

Cryptographic primitives believed secure against quantum-computing attacks. Myne v0.1 is not post-quantum. The `appname-v005` roadmap introduces hybrid X25519 + ML-KEM-768 (FIPS 203) for KEM operations and Ed25519 + ML-DSA-65 (FIPS 204) for signatures.

Used in: `e2ee-notes-evaluation.md`; `spec/protocol.md` §11

### **PQXDH (Post-Quantum Extended Triple Diffie-Hellman)** &nbsp; 🏗️ *Construction*

Signal's post-quantum-augmented X3DH key-agreement protocol, with hybrid X25519 + ML-KEM-768. Reference design pattern for Myne's `appname-v005` user-to-user key agreement (sharing).

Used in: `spec/protocol.md` §11 (out of scope for v0.1)

### **protocol identifier** &nbsp; 📋 *Protocol*

The string `"myne-protocol-v0.1"` that names this specification. Distinct from the protocol version *byte* (`0x01`), the AAD prefix (`"myne.v0.1|"`), and the context-string prefix (`"myne.v0.1 "`). All four reference the same major version but appear in different call sites.

Used in: `spec/protocol.md` §1.3

### **protocol version** &nbsp; 📋 *Protocol*

The single-byte field at offset 4 of every Myne on-disk file (per-note `.myn` and `vault.meta`). v0.1 = `0x01`. Bound into the AAD of every AEAD operation so that any version downgrade fails the tag check.

Used in: `spec/protocol.md` §1.3, §10

### **React** &nbsp; 🛠️ *Tooling*

The UI library used for the Phase 1 desktop client UI inside the Tauri WebView, and the planned UI library for the Phase 3 web and mobile clients (the latter via React Native). React 19 with TypeScript per the scaffold. Chosen for the maturity of its CodeMirror 6 (`@uiw/react-codemirror`) and Cytoscape.js (`react-cytoscapejs`) integrations — the two largest UI dependencies in the Phase 1 scope. Shared React components are anticipated to live in a future `packages/ui/` workspace member when Phase 3 web work begins, decoupling the desktop UI bundler from the web bundler.

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

### **reproducible builds** &nbsp; 🛠️ *Tooling*

Build artifacts that can be regenerated bit-for-bit from public source code by independent third parties. Myne commits to reproducible builds for desktop (Tauri), web, and server binaries — feasible in months for Tauri (vs. ~10 person-years for Chromium-based Electron). Part of the compensating-controls plan in lieu of a paid third-party audit.

Used in: `threat-model.md` §6
Reference: https://reproducible-builds.org

### **root_key** &nbsp; 🗝️ *Key/identifier* (deep entry)

The cryptographic core of a Myne vault. A 32-byte random value generated by the OS CSPRNG at vault creation. **Not derived from the password** — instead, two copies are stored on disk encrypted under independent wrap keys (`password_wrap_key` and `recovery_wrap_key`), per the dual-credential wrap pattern. Held in client memory only between unlock and lock; zeroized on lock or process exit. Every Myne subkey (the `server-auth` reservation, the active `itemsKey_wrap_key`, the `backup-key`) is derived from `root_key` via the `derive_key` helper. The architecture is essential to recovery — if `root_key` were a function of the password, losing the password would unconditionally destroy the vault.

Used in: `spec/protocol.md` §3.1

### **RustCrypto** &nbsp; 🛠️ *Tooling*

A collection of pure-Rust cryptographic crates (`hkdf`, `chacha20poly1305`, `argon2`, `ml-kem`, `ml-dsa`, etc.). Myne uses RustCrypto as a fallback when libsodium bindings prove inadequate, but libsodium remains the canonical reference. The `ml-kem` and `ml-dsa` crates are the likely Rust path for v005's post-quantum primitives.

Used in: `spec/protocol.md` §2.2

### **salt** &nbsp; 📋 *Protocol*

A non-secret, per-vault random value mixed into KDF input to prevent precomputation attacks across accounts and time. Myne constructs two distinct 16-byte salts — `salt_password` and `salt_recovery` — each from a SHA-256 of `(domain prefix || account_number_hash || random_16_bytes)`, with the random component generated once at vault creation and stored in `vault.meta`.

Used in: `spec/protocol.md` §3.1

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

The three-state enum that holds the current vault auth state inside `VaultRuntimeState`'s `RwLock<Slot>` (Rust-side singleton, one instance per app process). Variants: `Slot::Empty` (no vault open; the default at process start and the post-`vault_lock` state), `Slot::Recovering { ... }` (post-recovery / pre-password-commit), `Slot::Unlocked(UnlockedVault)` (full editor access). Editor commands match only `Slot::Unlocked(uv) => ...`; the `Slot::Recovering` and `Slot::Empty` variants are structurally rejected at compile time. The shape is the type-system realization of `recovery-flow.md` §4.1 + §4.3's "no soft-unlocked session" guarantee — security lives in the type, not in UI discipline. Phase 2 multi-vault is a mechanical type swap (`HashMap<VaultId, Slot>`); the lifecycle reasoning carries forward unchanged.

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization"

### **SlotKind** &nbsp; 📋 *Protocol*

The discriminator for the [`Slot`] enum, exposed across the IPC boundary by the `vault_status` Tauri command. Three variants: `Empty | Recovering | Unlocked`. Serde-Serialize encoding is the bare variant name (no `#[serde(tag)]` wrapper), so the JSON payload on the wire is one of three bare strings — `"Empty"`, `"Recovering"`, `"Unlocked"`. The TypeScript hand-mirror at `src/types/slot-kind.ts` is therefore a string-literal union, not an object discriminator. Used by frontend boot-time and post-WebView-reload routing — never on the post-recovery happy path (the in-process `Slot::Recovering` → `Slot::Unlocked` transition uses the IPC `Ok(())` from `vault_complete_recovery` as the success signal; a defensive `vault_status` round-trip would be paranoia).

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization"

### **state-level actor** &nbsp; ⚠️ *Threat*

Adversary class A10. Nation-state-class adversary with zero-day capabilities, supply-chain access, hardware-implant capability, and the legal power to compel operator cooperation. Myne's status against A10 is Best-effort: boring, well-vetted primitives plus a published spec, with no claim of defense against zero-days or hardware implants beyond what A2 covers.

Used in: `threat-model.md` §1 (A10)

### **supply-chain compromise** &nbsp; ⚠️ *Threat*

Adversary class A8: a transitive dependency in npm, Cargo, or Go modules ships malicious code. Myne's mitigations are hash-pinned lockfiles, minimal direct-dependency surface, dependency-review at update time, and `cargo-vet`/`cargo-audit` in CI. Status: Best-effort — cannot fully defend against a determined attacker in the dependency graph, but the Tauri/Cargo dependency tree is materially smaller than Electron/npm would be.

Used in: `threat-model.md` §1 (A8), §7

### **Tauri** &nbsp; 🛠️ *Tooling*

A Rust-based framework for building cross-platform desktop applications with web-technology UIs. Myne's Phase 1 desktop-client framework (`decisions.md` Deferred #5 resolution). Supersedes the prior Electron baseline. Advantages: small TCB, ~10 MB binary vs ~150 MB Electron, ~40 MB idle RAM vs ~250 MB, achievable reproducible builds, structural memory hygiene via Rust's `zeroize`/`secrecy`/`subtle` crates, smaller updater attack surface.

Used in: `decisions.md`, `vision.md`, `threat-model.md` §3 TB7

### **threat model** &nbsp; ⚠️ *Threat*

The structured catalog of adversaries, assets, trust boundaries, and defensive posture that defines what Myne protects against and what it explicitly does not. The authoritative document is `threat-model.md`. Marketing copy must not exceed the guarantees there; that document is normative for what users may rely on.

Used in: `threat-model.md`

### **traffic analysis** &nbsp; ⚠️ *Threat*

Adversary class A13: a server-side or network observer correlating sync timing, blob sizes, and account activity to infer behavior even without decrypting content. Myne v0.1 is Best-effort against A13 — sync timing, blob count, and blob size are visible to anyone observing the network or the server, and connection IPs are visible transiently (not logged). Padding, cover traffic, and timing randomization are deferred beyond v0.1.

Used in: `threat-model.md` §1 (A13), §7

### **trust boundary** &nbsp; ⚠️ *Threat*

A line in the system where the security model changes — what is trusted on one side is not trusted on the other. Myne catalogs nine boundaries (TB1–TB9). See `threat-model.md` §3 for the full table.

Used in: `threat-model.md` §3

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

### **vault** &nbsp; 📦 *Product*

A user's encrypted note collection — the unit of Myne's data model. Concretely: a directory containing `vault.meta`, a `notes/` subdirectory of `.myn` files, and (reserved for v0.1) an `attachments/` subdirectory.

Used in: `spec/protocol.md` §9.1

### **vault creation session** &nbsp; 📦 *Product*

The backend-resident state held between the `begin` and `commit` IPC calls of the vault-creation flow. A `VaultCreationSession` (Rust struct in `src-tauri/src/plugins/vault_creation/state.rs`) carries the freshly generated `account_number`, `recovery_phrase`, `root_key`, two Argon2id salts, the cached password and recovery wrap keys, the chosen `KdfParams`, and a `created_at: Instant` timestamp. Lives in a `Mutex<HashMap<Uuid, VaultCreationSession>>` indexed by **session token**. Bounded by `MAX_CONCURRENT_SESSIONS = 4` and `SESSION_TTL_SECS = 600` (10 minutes); evicted by a background `tokio::time::interval(60s)` task whose evicted tokens land in a parallel **tombstone** map for up to `TOMBSTONE_RETENTION_SECS = 3600` (1 hour). `root_key` and the wrap keys never cross the IPC boundary — they live only in this session until `commit` consumes it.

Used in: `decisions.md` 2026-04-28 "Vault creation flow", "Vault creation session TTL"

### **vault.meta** &nbsp; 📦 *Product* (deep entry)

The single binary file holding vault-level cryptographic state. Magic bytes `MYV1` for v0.1. Layout per `spec/protocol.md` §9.3: protocol version, account_number_hash, the 11-byte canonical KDF parameters block, both salt-randomness fields (`random_salt_password_16`, `random_salt_recovery_16`), nonces and ciphertexts for both wrapped root-key copies (`enc_root_key_password`, `enc_root_key_recovery`), and the items_key_id, items_key_nonce, and `enc_items_key`. `vault.meta` plus the `.myn` files are the only artifacts that leave the device in any future sync scenario; both are opaque ciphertext plus a small public header.

Used in: `spec/protocol.md` §9.3

### **vault_<verb_past> tracing event-name pattern** &nbsp; 🛠️ *Tooling*

Project-wide naming discipline for `tracing::info!(event = "...")` success-event emissions across the auth-pipeline plugins. Format: `vault_<verb in past tense>`. Concrete instances in v0.1: `vault_unlocked` (vault_unlock command success), `vault_locked` (vault_lock command success), `vault_recovered_with_phrase` (A8d phrase-recovery success), `vault_recovery_completed` (A8f post-recovery password commit success), and the forthcoming `vault_password_changed` (MYND-22's vault_change_password commit success). Future Phase 2 plugins (OPAQUE, hardware-unlock, etc.) extend the pattern without per-plugin `decisions.md` entries — the convention is self-evident from the existing instances. Phase 2 ops-tooling primitive: log aggregation queries can pattern-match `event = "vault_*"` once a `tracing-subscriber` is wired (deferred today). Pinned by `decisions.md` 2026-05-06 "Tracing event-name pattern: vault_<verb_past> across auth-pipeline plugins".

Used in: `src-tauri/src/plugins/{vault_unlock,vault_recover}/commands.rs`; `decisions.md` 2026-05-06.

### **vault_meta_bytes_hash** &nbsp; 🛠️ *Tooling*

Public-material `[u8; 32]` field on the desktop client's `Slot::Unlocked` carrying `SHA-256(vault.meta bytes)` captured at slot-populate time. Populated by `vault_unlock` (digest of unlock-time read bytes) and by `vault_complete_recovery` (digest of the freshly-rewritten bytes; AFTER `atomic_write` succeeds). Serves as the **in-memory CAS anchor** for `vault_change_password`'s in-place rewrite — the command compares the slot-held hash against a fresh digest of the on-disk bytes before committing the rewrite, returning `VaultMetaChangedExternally` and force-relocking on mismatch. SHA-256 of public bytes is itself public material; held bare without `Zeroize`. Pinned by `decisions.md` 2026-05-06 entry "Slot::Unlocked anchor field for vault.meta CAS" (MYND-22 foundation hardening).

Used in: `src-tauri/src/plugins/vault_unlock/state.rs::UnlockedVault.vault_meta_bytes_hash`; `decisions.md` 2026-05-06.

### **vault_status** &nbsp; 🛠️ *Tooling*

The Tauri command `vault_unlock:status` that returns the current [`SlotKind`]. Read-only (`tokio::sync::RwLock::read`); never fails in practice — the `Result<SlotKind, VaultUnlockError>` return is purely IPC-contract uniformity with the rest of the unlock plugin. Lives in `vault_unlock` because the plugin owns the runtime-state singleton; permission `vault-unlock:default allow-status`. Frontend boot-time and post-WebView-reload routing call `vault_status` to recover from the case where Tauri's Rust state outlives the WebView's JS state across Cmd+R / hot-reload — `Empty` routes to unlock (or vault-creation if no `vault.meta` exists), `Recovering` routes to the password-reset form, `Unlocked` routes to the editor. Explicitly NOT part of the post-recovery happy path: a defensive round-trip after `vault_complete_recovery` would be paranoia per `decisions.md` 2026-05-02 (the IPC contract pins `Slot::Unlocked` as the success postcondition).

Used in: `src-tauri/src/plugins/vault_unlock/commands.rs::status`; `src/types/slot-kind.ts`

### **Vite** &nbsp; 🛠️ *Tooling*

The build tool and dev server used by the Phase 1 desktop client to bundle the React UI before Tauri ships it as a static asset bundle. Chosen over Next.js (`decisions.md` 2026-04-26) because Tauri ships a static bundle — Next.js's SSR / RSC / API-route value is architecturally unused, while its ~10× larger transitive npm dependency footprint vs Vite is paid in full. The smaller direct-npm-dependency surface aligns with the threat-model §7 "deliberately small direct-dependency surface" commitment for A8/TB9.

Used in: `decisions.md`; `threat-model.md` §7
Reference: https://vite.dev

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
| Damm-32 | Account number check digit | hand-rolled (open issue) |

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
| `backup-key` | Encrypts user backup files | Derived only | Session |
| `account_number` (95-bit + Damm) | User identifier; bearer token in P2+ | User offline storage | Permanent |
| `account_number_hash` (SHA-256[:16]) | Argon2id salt binding | `vault.meta` | Vault lifetime |

### Index 3 — Magic bytes and context-prefix registries

| Major version | Per-note magic | Vault-meta magic | AAD prefix | Context-string prefix | Status |
|---|---|---|---|---|---|
| v0.1 | `MY01` | `MYV1` | `"myne.v0.1|"` | `"myne.v0.1 "` | Active (this document) |
| v005 | `NT05` | `NTV5` | `"myne.v005|"` | `"myne.v005 "` | Reserved; specification TBD |

The four prefixes for a single major version are deliberately non-interchangeable: each lives in a different cryptographic call site, and using one in place of another is a protocol violation. See entry **`myne.v0.1` prefix** and `spec/protocol.md` §10.3.

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
