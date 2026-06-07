# Myne Markdown Dialect — v0.1

> Normative specification of the markdown dialect Myne v0.1 reads and writes. Companion to [`protocol.md`](protocol.md) (cryptographic format) and [`wikilink.md`](wikilink.md) (wikilink-specific syntax). This document binds every Myne client.

## 1. Scope

This specification defines:

- which markdown syntax Myne v0.1 **parses** as structured AST nodes,
- which syntax Myne v0.1 **renders** with editor decorations,
- which syntax Myne v0.1 **emits** when authoring new content,
- the file extension and frontmatter conventions on disk after decryption,
- round-trip stability guarantees with imported Obsidian vaults.

This document does **not** define:

- The `[[wikilink]]` family — see [`wikilink.md`](wikilink.md).
- The encrypted `.myn` blob format — see [`protocol.md`](protocol.md) §9.2.
- Editor implementation details (CodeMirror 6 extension wiring, decoration kinds, slash command shape) — see `myne-agents/features/editor-mvp/rfc.md` and the editor-mvp PRDs.

## 2. Dialect identity

Myne v0.1 adopts **GFM (GitHub-Flavored Markdown) plus a footnote extension plus a wikilink extension plus YAML frontmatter recognition**. Internally referred to as **D1**. The dialect is:

- **The smallest pin that covers Myne v0.1's editor decoration commitments** (tables, task lists, footnotes, wikilinks, frontmatter).
- **Byte-stable round-trip** with notes imported from Obsidian vaults: a note written by Obsidian, imported into Myne, and never edited inside Myne, must serialize back to the same bytes when exported. (Obsidian conventions Myne does not natively render — `> [!callout]` syntax in v0.1, `^block-id` markers — are still preserved at the byte level. See §6.)
- **Forward-incompatible by design** with v005. v005 will pin its own dialect. Cross-major migration is out of scope per `protocol.md` §10.1; the same applies here.

## 3. Recognized syntax categories

The parser recognizes the union of CommonMark + GFM extensions + footnote extension + wikilink extension + YAML frontmatter. Concretely:

### 3.1 Block elements (CommonMark base)

- ATX headings `# H1` … `###### H6` (only ATX is canonical for new writes; Setext `===` / `---` underline form is recognized on parse for round-trip and, since MYND-146, **rendered** with a cursor-aware decoration — the title takes H1/H2 typography and the underline line hides off-cursor — but is still **never emitted**. Rendering ≠ emitting: the bytes are preserved per §6 C1 and a new heading still writes the ATX form.)
- Paragraphs (text separated by blank lines)
- Indented code blocks (4-space indent) — recognized for round-trip but **never emitted**; new code blocks always use fenced form
- Fenced code blocks (`` ``` `` or `~~~`) with optional language label (` ```ts `)
- Block quotes (`> ` prefix)
- Bullet lists (`- ` / `* ` / `+ `; canonical emit form for new writes is `- `)
- Ordered lists (`1. ` / `1) `; canonical emit form is `1. `)
- Horizontal rules (`---` / `***` / `___`; canonical emit form is `---`)
- HTML blocks (raw HTML — recognized at parse, rendered as plain monospace by default; full sanitized rendering is out of scope for v0.1)
- Definition lists (Pandoc-style `Term` then `: Definition`) — **recognized and rendered** since MYND-152 (scope reversal, `decisions.md` 2026-05-30; previously §7 out-of-scope). The pinned v0.1 subset is **tight only**: a single term line immediately followed (no blank line between) by one or more definition lines, each `:` + a space + the definition text (a bare `:` is an empty definition); multiple consecutive `:` lines attach as multiple definitions of that term. **Not** in the subset (preserved byte-stably as ordinary paragraphs, not parsed as definition lists): the blank-line-separated "loose" form, lazy continuation lines (a definition wrapping onto a non-`:` line), and multiple terms sharing one definition block. Rendered with a cursor-aware decoration (term styled, definitions indented, leading `:` hidden off-cursor); **never emitted** — no authoring affordance produces a definition list, and bytes are preserved per §6 C1. The custom parser node is informative in §8.

### 3.2 Inline elements (CommonMark base)

- Emphasis: `*italic*`, `_italic_`, `**bold**`, `__bold__` (canonical emit forms: `*italic*` and `**bold**` — see §5)
- Inline code: `` `code` ``
- Inline links: `[text](url)` and `[text](url "title")`
- Reference links: `[text][ref]` (and collapsed `[text][]` / shortcut `[ref]`) + `[ref]: url` — recognized for round-trip and, since MYND-148, **rendered** with a cursor-aware decoration: a resolved usage shows its visible text as a link and the resolved `[ref]: url` definition line hides off-cursor; a dangling reference (no matching definition) stays plain text. Still **never emitted** — new links use inline form, bytes preserved per §6 C1. A `[ref]: url` definition is matched to its uses by CommonMark reference rules (case-folded, internal whitespace collapsed). See also the shared **link reference definition** collector consumed by reference images (§7, MYND-149/MYND-164).
- Autolinks: `<https://example.com>` (CommonMark form) and bare `https://example.com` (GFM extension)
- Hard line breaks: trailing two spaces or `\` at line end
- Raw inline HTML (recognized; rendered as plain text)

### 3.3 GFM extensions

- Tables: pipe-delimited with `|---|` alignment row. Per-column alignment via `:---`, `---:`, `:---:`.
- Task lists: `- [ ]` / `- [x]` (lowercase `x` is canonical emit; uppercase `X` recognized for round-trip)
- Strikethrough: `~~text~~`
- Autolinked URLs (no angle brackets required)

### 3.4 Footnote extension

- Inline footnote reference: `[^N]` (where `N` is an identifier — typically an integer, but any non-whitespace string is permitted)
- Footnote definition: `[^N]: definition text` (typically grouped at end of document; position is not normative)

### 3.5 Wikilink extension

The full grammar lives in [`wikilink.md`](wikilink.md). At a glance, the parser recognizes:

- `[[Note]]` — title-only link
- `[[Note|Display]]` — title with display alias
- `[[Note#Heading]]` — heading anchor
- `[[Note^block-id]]` — block reference (recognized for round-trip; not emitted)
- `[[vault/relative/path.md|Display]]` — vault-relative path with alias (Myne-native authoring form per §4 of [`wikilink.md`](wikilink.md))
- `![[Note]]` and `![[image.png]]` — embed forms (rendered as labeled chips; no transclusion engine in v0.1)

### 3.6 YAML frontmatter

A document **may** begin with a YAML metadata block delimited by `---` lines:

```
---
title: Some Title
tags: [foo, bar]
---

# Note body starts here
```

The frontmatter block must:
- begin on line 1 (no preceding blank lines or content),
- open with a line consisting of exactly `---`,
- close with a line consisting of exactly `---`,
- contain valid YAML 1.2 between the delimiters.

Frontmatter is recognized as a structured block and rendered as a code block in the v0.1 baseline editor. The Properties UI (editable key-value grid) is deferred to a post-v0.1 release. Unknown frontmatter fields are preserved on write — Myne never strips fields it does not recognize.

#### 3.6.1 Myne-managed canonical frontmatter fields

Myne writes five canonical fields to YAML frontmatter from the host, all via the dialect surgery module per [`decisions.md`](../decisions.md) 2026-05-09 "Frontmatter byte-level surgery owned by TS dialect module" (which supersedes the 2026-05-07 writer mechanic):

| Field | Type | Semantics | Writer | Trigger |
|---|---|---|---|---|
| `updated` | RFC 3339 string (UTC) | User-meaningful last-edit timestamp | `src/dialect/surgery.ts::patchUpdatedField` | Every save (per [`decisions.md`](../decisions.md) 2026-05-07 "User-meaningful timestamp storage path") |
| `title` | YAML string (plain scalar) | User-visible note title surfaced by sidebar / note-titles batch | `src/dialect/surgery.ts::patchTitleField` | Rename action only — always writes the FM `title:` field per [`decisions.md`](../decisions.md) 2026-05-28 "Note title is frontmatter-only (no first-`# H1` fallback)" (supersedes 2026-05-15 mirror-existing β tree) |
| `folder` | YAML string (canonical trailing-slash path, e.g. `Projects/Myne/`; **absent** = vault root / unfiled) | Virtual folder the note lives in — the on-disk layout stays flat (`notes/<uuid>.myn`), the sidebar tree is reconstructed client-side from this field (MYND-144). Folder structure is `threat-model.md` **AS3** (Sensitive, inside the encrypted blob) | `src/dialect/surgery.ts::patchFolderField` | Create (`createNote(folder)` via `buildInitialPlaintext`) + move (`src/notes/moveNote.ts`) only — never body autosave |
| `trashed` | RFC 3339 string (UTC); **value-strict** — only a parseable RFC 3339 value marks the note trashed, any other value leaves it live | Note is soft-deleted (in the vault trash); **absent** = live. Trash-state lives inside the AEAD blob exactly like `folder:` — no `<vault>/.trash/` directory and no on-disk-layout change (`protocol.md` §9.1 stays flat). The Trash panel reconstructs the trashed set client-side from this field; trashed notes are excluded from sidebar / folder-tree / search (MYND-133) | `src/dialect/surgery.ts::patchTrashedField` | Trash + restore actions (`src/notes/trashNote.ts`) only — never body autosave |
| `template` | **value-strict boolean** — only the canonical `true` form marks the note a template; any other value (`1`, `yes`, `True`, quoted `"true"`) or absence = ordinary note (exactly mirroring how `trashed:` is value-strict on RFC 3339) | Note is a reusable template skeleton: **hidden** from the sidebar file-tree, folder-tree, and search (the same exclusion machinery as `trashed:`) but **surfaced** in the template picker + management UI — the inverse-visibility twin of `trashed:` (trash hides from views *and* picker; template hides from views but *appears* in the picker). **Absent** = ordinary note. Template-state lives inside the AEAD blob exactly like `trashed:` — no on-disk-layout change (`protocol.md` §9.1 stays flat) (MYND-186) | `src/dialect/surgery.ts::patchTemplateField` | Template create / convert actions (`src/notes/templates.ts`) only — never body autosave |

Mechanics — shared across all four fields:

- Fields are **unprefixed** (no `myne_` namespace). Obsidian Templater/Linter and the wider markdown ecosystem use unprefixed `updated:` and `title:` for these purposes; Myne aligns with the convention so a user who walks away from Myne sees fields every other editor recognizes (`PRODUCT.md` design principle 5 — plain-markdown portability).
- Each writer follows the same 3-state surgery matrix: state A (no FM block) → prepend `---\n<key>: <value>\n---\n\n` (canonical Obsidian-Templater shape with one trailing blank line); state B (FM exists, key absent) → insert `<key>: <value>\n` at the end of the FM block (just before the closing `---`); state C (FM exists, key present) → replace the value byte-by-byte, preserving trailing comments, preserving quote style (`unquoted`, `'single'`, `"double"`), and collapsing YAML block-scalar form (`<key>: |\n  …\n`) to single-line canonical form. The state-C collapse is justified by the fields being Myne-managed — a user who wants multi-line content in these fields uses a different field name.
- **`patchFolderField`, `patchTrashedField`, and `patchTemplateField` extend the matrix with a 4th operation — state D (delete-field)** — for move-to-root (folder), restore (trashed), and convert-template-to-note (template): it removes only the target line (key + value + that line's trailing comment + newline); if ≥1 residual key or comment remains, the FM block is kept; if the block becomes truly empty (no key, no comment), the whole block is removed so the output is byte-identical to an FM-less note (symmetric with `buildInitialPlaintext(null) === ""`). A lone user comment keeps the block — Myne removes its own field and the void it left, never user structure.
- **The five managed flags compose on one blob without clobbering** (per the §3.6 unknown-field-preservation rule): each writer touches only its own line, so a single note can carry any combination — e.g. `template: true` + `trashed: <ts>` simultaneously (a deleted template, restorable from Trash, re-entering the template set on restore). Setting or deleting one managed field preserves every other managed field, user-authored field, and comment byte-for-byte.
- Other frontmatter fields (`tags:`, user-authored fields) are preserved per the §3.6 "Unknown frontmatter fields are preserved on write" rule.
- `created_at` is **not** stored in frontmatter — it is derived from the UUIDv7 filename's millisecond time component per [`protocol.md`](protocol.md) §9.1 (already public-accepted leak; no new commitment violation, no frontmatter write needed).
- The set of Myne-managed canonical frontmatter fields is forward-incompatible-by-design with v005: v005 may rename, drop, or supersede `updated:` / `title:` / `folder:` / `trashed:` / `template:` per its own dialect specification.

Mechanics — per-field:

- **`updated`** is owned by autosave: a user who manually sets `updated:` to a custom value sees it overwritten on the next save — autosave is Myne's responsibility. Users who want a manually-managed timestamp use a different field name (e.g., `last_reviewed:`).
- **`title`** is owned by the rename action only — body autosave does NOT write `title:`. Rename always writes the frontmatter `title:` field (`src/notes/renameNote.ts` → `patchTitleField`, applying the same 3-state matrix as `updated:`). The body's first `# H1` line is **not** a title source or a title write target: a note with no FM `title:` reads as "Untitled" until named, and the read path (`note_titles_batch` / `loadNoteBatch`) derives the title from `title:` only. `patchFirstH1Line` remains a structural-transform primitive in `src/dialect/surgery.ts` (e.g. for the editor's heading-cycle command) but is no longer invoked by rename. See [`decisions.md`](../decisions.md) 2026-05-28 "Note title is frontmatter-only (no first-`# H1` fallback)" (supersedes the 2026-05-15 mirror-existing source-of-truth (β) tree).
- **`folder`** is owned by the create + move actions only — body autosave does NOT write `folder:`. A note created inside a folder receives its `folder:` at create (`createNote(folder)` → `buildInitialPlaintext`, the a2 create-timing path); a move rewrites it (`src/notes/moveNote.ts` → `patchFolderField`); a move to the vault root **deletes** the field (state D). A note with no `folder:` is **root / unfiled**. The value is a virtual path — the on-disk layout never reflects it (`protocol.md` §9.1 stays flat `notes/<uuid>.myn`), so the folder structure travels inside the encrypted blob (AS3) and survives a plaintext export. Deliberately-created folders that hold no note are persisted separately in `vault.prefs` (`protocol.md` §9.5.2 `deliberate_folders`), not in any note's frontmatter. See [`decisions.md`](../decisions.md) 2026-05-29 "Native folder hierarchy" (MYND-144).
- **`trashed`** is owned by the trash + restore actions only — body autosave does NOT write `trashed:`. The trash action (`src/notes/trashNote.ts::trashNote`) writes `trashed: <now>` (RFC 3339 UTC) via `patchTrashedField` then re-encrypts through the existing `note_update` IPC; the restore action (`restoreNote`) **deletes** the field (state D). There is no dedicated `note_trash`/`note_restore` backend command — trash/restore are TS orchestrators over `note_update`, exactly like `folder:` is rewritten by `moveNote` (`decisions.md` 2026-06-03). Unlike the other three, `trashed:` is **value-strict**: Myne treats the note as trashed only when the value parses as a valid RFC 3339 timestamp — a user's own `trashed: true` / non-timestamp value leaves the note live. The field is unprefixed for canonical-field consistency, but unlike `updated:` / `title:` it carries **no** Obsidian ecosystem convention (Obsidian uses OS-level trash, not a frontmatter flag); value-strictness plus the MYND-51 importer's flag-don't-rewrite rule contain the field-name collision footgun. A Myne-native note that a user has manually given a valid-RFC 3339 `trashed:` is the residual accepted risk (it would be filed to trash). Trashed notes are excluded client-side from sidebar enumeration, folder-tree reconstruction, and full-text search; only the Trash panel reads them. See [`decisions.md`](../decisions.md) 2026-05-07 "Note delete UX" (the deferral this implements) + the v0.2 vault-internal soft-trash entry (MYND-133).
- **`template`** is owned by the template create + convert actions only — body autosave does NOT write `template:`. The convert-to-template action (`src/notes/templates.ts::convertNoteToTemplate`) writes `template: true` via `patchTemplateField` then re-encrypts through the existing `note_update` IPC; convert-back (`convertTemplateToNote`) **deletes** the field (state D); creating a template (`createTemplate`) mints a new note already carrying the flag via the existing `note_create` IPC. There is no dedicated backend command — template CRUD are TS orchestrators over `note_create` / `note_update`, exactly like `trashed:` (`decisions.md` 2026-06-07). Like `trashed:`, `template:` is **value-strict**: Myne treats the note as a template only when the value is the canonical, unquoted boolean `true` — a user's own `template: 1` / `template: "true"` / `template: yes` leaves the note an ordinary note. The field is unprefixed for canonical-field consistency, but carries **no** Obsidian ecosystem convention (Obsidian designates a template by *folder*, not a frontmatter flag); value-strictness contains the field-name collision footgun. A template is the **inverse-visibility twin** of trash: a `template:`-flagged note is excluded client-side from sidebar enumeration, folder-tree reconstruction, and full-text search (the same exclusion machinery as `trashed:`), but — unlike a trashed note — is *surfaced* in the template picker and management UI. A note that is both `template: true` and `trashed:` is in the Trash (restorable) and absent from the template enumeration until restored. This is a documentation contract only: no `protocol.md` §9.1/§9.2 change, no new magic byte, no AAD/version bump — the marker rides the existing `.myn` envelope. See [`decisions.md`](../decisions.md) 2026-06-07 "Note templates: carrier, schema, start-empty, daily-notes framing" (MYND-186).

#### 3.6.2 Folder path grammar

A `folder:` value is a slash-delimited path of **segments**. A folder segment and a note title are the **same structural object** — both are segments of the virtual wikilink target `<folder>/<title>.md` (see [`wikilink.md`](wikilink.md)) — so one segment grammar governs both, enforced by a single `src/dialect/folderPath.ts::isLegalSegment` predicate reused at folder-create, note-create, note-rename, and import-scan.

**Forbidden in a segment** (Myne-authored input): `/` and `\` (path delimiters — a `/` inside a title would forge a folder boundary); `|`, `#`, `^` (wikilink alias / heading-anchor / block-ref delimiters per [`wikilink.md`](wikilink.md) §2.1); `]]` and bare `[` / `]` (the unescapable wikilink terminator per §10); any C0 control character (U+0000–U+001F) or DEL (U+007F); leading or trailing whitespace; a trailing `.` (Windows trailing-dot-strip footgun); a whole-segment `.` or `..` (traversal); and the empty segment (`//`). Everything else is permitted — interior spaces, most punctuation, Unicode letters, and emoji — preserving Obsidian's permissive folder/title character set. Rich or "loud" display text belongs in the wikilink **alias** (`[[…|Display]]`), not in the title or folder segment, which stay resolution-safe.

**Enforcement is provenance-split** (generalizing §6 C1 + [`wikilink.md`](wikilink.md) §10 from the `]]`-only rule to the full grammar): Myne-authored input is **rejected at the UI** before it reaches the surgery layer, via the single `folderPath.ts::isLegalSegment` + `isLegalPathLength` gate (wrapped by `validateFolderNameInput` for typed input); imported content (Obsidian vaults) is **preserved byte-for-byte** (C1) but **flagged with a rename prompt** — never silently rewritten. The Myne-authored gate is live at the folder **create** and folder **rename** inputs (`useFolderManagement`, MYND-144). The same predicate is the intended gate for note-**title** create/rename and is the contract the MYND-51 importer's rename-**flag** path checks against — those consumers land with their own features. A folder **move** (drag-drop) introduces no new segment — it relocates a note under an already-gated folder path — so it carries no separate grammar check.

**Identity** is case-**insensitive**: two segments are the same folder when their **Unicode case-fold + NFC** forms match (`Projects/` ≡ `projects/`), reusing the §3.7.8 inline-tag identity rule. Raw bytes are preserved on disk for display and walk-away; folding is a comparison-key operation only (`folderPath.ts::foldSegment`). Case-sensitivity was rejected as a walk-away footgun — case-only-distinct folders collide when exported to a case-insensitive filesystem (macOS / Windows).

**Canonical forms.** The vault **root** is the **absence** of the `folder:` field (`folder: ""` is read as root and normalized to absent on write; `folder: "/"` is rejected). The canonical storage form carries a **trailing slash** (`Projects/`, `Projects/Myne/`); reads tolerate a missing trailing slash and duplicate / leading slashes (collapsed on normalization), but emission is always trailing-slash. The `.md` extension discriminates a root path-form wikilink target (`Foo.md`) from a title-only target (`Foo`); exactly one trailing `.md` is appended on derive and stripped on parse, so a note literally titled `Foo.md` round-trips (`Foo.md` → `Foo.md.md` → `Foo.md`).

**Caps.** A segment is ≤ 255 bytes UTF-8 (`NAME_MAX` on ext4 / APFS / NTFS); a total vault-relative path (folder + title + `.md`) is ≤ 1024 bytes (`PATH_MAX` on macOS); depth is bounded implicitly by path length, not separately capped (parallel to §3.7.4's unbounded tag nesting). Overflow is a Part-1 enforcement event (Myne-authored reject, import flag). Windows legacy `MAX_PATH` (260) and reserved device names (`CON`, `NUL`, `COM1`, …) are handled as a **documented walk-away caveat + import warning**, not part of the core grammar — keeping platform quirks out of the cross-client byte contract.

**Importer coordination (MYND-51).** The Obsidian importer writes folder structure to this same canonical `folder:` field; the field name and the trailing-slash form defined here are the contract the importer consumes / produces. (Whether the importer also persists *empty* source directories to `deliberate_folders` is an importer-side fidelity decision, out of scope here.)

### 3.7 Inline-tag extension

Notes may contain inline tags — `#`-prefixed identifiers in body text that consumers (search, backlink, sidebar UI) treat as structured metadata distinct from the YAML frontmatter `tags:` list. The grammar below mirrors Obsidian's runtime behavior so an Obsidian-imported vault produces the same tag set in Myne as it does in Obsidian. Each rule is verified against observed Obsidian behavior in `myne-agents/researches/2026-05-09-obsidian-inline-tag-behavior.md` (the Q-numbered findings cited per rule).

#### 3.7.1 Boundary

An inline tag begins at a `#` character preceded by either the start of a line OR a Unicode whitespace character. A `#` immediately following a non-whitespace character (e.g. `abc#tag`) is **not** an inline tag. (Research Q1.)

#### 3.7.2 Allowed character set

An inline-tag body consists of one or more Unicode code points, each of which is **not** in any of the following:

- U+2000 through U+206F (Unicode General Punctuation block)
- U+2E00 through U+2E7F (Unicode Supplemental Punctuation block)
- The ASCII characters: `'`, `!`, `"`, `#`, `$`, `%`, `&`, `(`, `)`, `*`, `+`, `,`, `.`, `:`, `;`, `<`, `=`, `>`, `?`, `@`, `^`, `` ` ``, `{`, `|`, `}`, `~`, `[`, `]`, `\`
- Any Unicode whitespace character

All other code points are permitted, including Unicode letters (Latin, Cyrillic, CJK, Arabic, etc.), digits, `_`, `-`, `/`, and emoji presentation. (Research Q2, Q4, Q14.)

This is a **deny-list** rather than the simpler positive allow-list given in the Obsidian Help documentation, because the runtime Obsidian regex (extracted from `app.js` and acknowledged by the Obsidian Help maintainer in `obsidianmd/obsidian-help` issue #816 as the actual behavior) is more permissive than the docs and is the authoritative source for compatibility with imported Obsidian vaults.

#### 3.7.3 Numeric-only reject (inline only)

An inline-tag body must contain at least one character that is not an ASCII digit. A body composed entirely of ASCII digits (e.g. `#1984`) is not a valid inline tag. The form `#y1984` is valid (`y` is non-digit). The form `#100-grit` is valid (`-grit` contains non-digit characters). The hex-string form `#00FFFF` is valid (hex letters are not ASCII digits).

This rule applies **only to inline tags**. YAML frontmatter `tags:` list entries are not subject to it; `tags: [1984]` produces a valid frontmatter tag value. The asymmetry is intentional and matches Obsidian's behavior — the inline `#1984` form is rejected because it is overwhelmingly a numbering convention (e.g. "Suite #200"), but a frontmatter list entry is an explicit user assertion that the value is a tag. (Research Q3, Q9; Obsidian core verbatim in `obsidianmd/obsidian-importer` issue #10.)

#### 3.7.4 Nested form

An inline-tag body may contain `/` characters, separating the tag into hierarchical segments. The number of segments is unbounded by this specification. (Research Q5.)

Index-layer derivation of parent-chain semantics (e.g., `#a/b/c` populating `#a` and `#a/b` as well as `#a/b/c` in a tag index) is not the parser's responsibility — the parser exposes the full tag string verbatim; the consuming index layer decides whether to expand the parent chain.

#### 3.7.5 Exclusion zones

The inline-tag tokenizer **does not** match within the following nested syntactic zones:

1. Fenced code blocks (`` ``` `` and `~~~`)
2. Indented code blocks (4-space indent)
3. Inline code (`` ` ``)
4. The interior of a wikilink, including target, alias, heading anchor, and block-id components (`[[…]]`, `[[…|…]]`, `[[…#…]]`, `[[…^…]]`, `![[…]]`)
5. Raw HTML embeds (block and inline)
6. The YAML frontmatter block (per §3.6's line-1-anchored detection)

When the parser is built on a nested-node syntax tree (e.g., the `@lezer/markdown` reference implementation per §8), zones (1)–(6) are excluded structurally because the inline-tag tokenizer runs only at the outer-inline-text level and does not descend into nested nodes. (Research Q7, Q9.)

**Future hook (v0.1.x).** When math (`$…$`, `$$…$$`) lands per §7's deferred items, the inline-tag tokenizer must additionally exclude math zones. v0.1 implementations may safely skip this case because math is not yet parsed.

#### 3.7.6 Frontmatter scope

The inline-tag tokenizer does **not** match within the YAML frontmatter block. Tags inside frontmatter are parsed as YAML 1.2 list values from the `tags:` key (per §3.6).

The numeric-only-reject rule (§3.7.3) applies only to inline tags. Frontmatter `tags:` entries may be entirely numeric. (Research Q3, Q9.)

#### 3.7.7 Recognize-only

The inline-tag tokenizer **only recognizes** tag occurrences. It MUST NOT rewrite, normalize, or canonicalize the bytes of any matched tag. The byte-stability guarantee in §6 (C1) extends to inline-tag bytes alongside the existing list (non-canonical emphasis, alternate list markers, etc.).

A user who wants to programmatically rewrite tags (e.g., a "rename tag across vault" affordance) must invoke an explicit, transparent conversion command — the parser does not perform implicit rewrites on save or on load. (Spec discipline derived from §6 C1.)

#### 3.7.8 Case identity

The inline-tag tokenizer surfaces tag bytes verbatim — un-normalized, un-folded. Tag identity (whether `#Tag` and `#TAG` collide for index purposes) is determined by the consuming layer. In Myne v0.1, the tag index applies Unicode case-fold and NFC normalization at index-write time, matching Obsidian's globally case-insensitive behavior.

The parser exposes raw bytes to keep its output deterministic and to push encoding policy to one place; downstream consumers (search index, sidebar UI, backlink graph) all share the same fold/normalize rule by virtue of going through the index layer. (Research Q10.)

## 4. File extension and on-disk identity

- The post-decryption plaintext content of a note is stored as **UTF-8 markdown text**.
- The file extension when a note is exported, mirrored, or otherwise materialized as plaintext is **`.md`**.
- The encrypted blob extension on disk is `.myn` per [`protocol.md`](protocol.md) §9.1. `.myn` is **never** a markdown content extension; it is exclusively an encrypted-blob extension.
- A user who copies a Myne vault to another machine sees `.myn` files at the OS level, not `.md` files. The post-decryption `.md` form is what the user obtains by exporting from inside Myne or by walking away from Myne entirely (per `vision.md` portability commitment).

## 5. Canonical emit forms

When Myne authors new content (slash command, selection toolbar, keyboard shortcut, or any programmatic mutation), the canonical syntax is:

| Construct | Canonical form | Rationale |
|---|---|---|
| Italic | `*italic*` | GFM-default; tighter visually than `_italic_` |
| Bold | `**bold**` | GFM-default; consistent with italic delimiter family |
| Strikethrough | `~~text~~` | Only GFM form |
| Heading | ATX (`# `, `## `, etc.) | Setext is recognized on parse but never emitted |
| Bullet list | `- ` | GFM-default; Obsidian-default; visually quieter than `* ` |
| Ordered list | `1. ` | Standard form |
| Code block | Fenced (`` ``` ``) | Indented form is recognized for round-trip but never emitted |
| Horizontal rule | `---` | Three dashes; matches frontmatter delimiter visually but unambiguous in context |
| Inline link | `[text](url)` | Reference form is recognized for round-trip but never emitted |
| Wikilink (new authoring) | `[[vault/relative/path.md\|Display]]` | See [`wikilink.md`](wikilink.md) §4 |

**The canonical emit form is what slash commands, the selection toolbar, and keyboard shortcuts produce.** A user who hand-writes `_italic_` or `1) ordered` is **never** silently rewritten — non-canonical forms recognized at parse are preserved byte-for-byte unless the user themselves edits them.

## 6. Round-trip stability with Obsidian-imported notes

**Hard rule (C1, from 2026-05-01 grill).** Notes imported from an Obsidian vault are preserved byte-for-byte in their original form. Myne never silently rewrites:

- non-canonical emphasis delimiters (`__bold__`, `_italic_`)
- alternate list markers (`* ` bullets, `1) ` ordered)
- Setext headings (`Heading\n======`)
- reference links (`[text][ref]` + later `[ref]: url`)
- indented code blocks
- task list `[X]` (uppercase) variants
- callout / admonition syntax not yet rendered by Myne (`> [!NOTE]`)
- block ID markers (`^block-id`)
- HTML embeds
- inline `#tag` bytes (per §3.7 — recognizer-only; never rewritten)

**Rendering does not weaken C1.** Several of the forms above are now *rendered* with cursor-aware decorations (Setext headings — MYND-146; reference links — MYND-148; and, post-2026-05-30, definition lists — MYND-152, §3.1). Rendering is purely visual: the decoration hides or restyles glyphs on screen but never mutates the buffer, and the cursor-aware reveal restores the raw source for editing. A note containing any of these forms that is rendered, focus/blur-cycled, and exported untouched is byte-identical. C1 binds every decoration in the editor — reaffirmed, not relaxed, by the rendering work.

**Implication for Myne authoring.** When a user imports a vault and then edits a note, only the lines they directly change adopt canonical emit forms. Untouched lines stay as written by the original author.

**Implication for migration.** Lazy migration on edit (rewriting all non-canonical syntax in a touched file on save) is **explicitly forbidden** by C1. A user who wants to migrate an imported note's syntax to Myne canonical forms must invoke an explicit, transparent conversion command (the wikilink-specific R2 command is the only such command in v0.1; see [`wikilink.md`](wikilink.md) §7).

## 7. Out of scope for v0.1

The following syntax is **not** parsed or rendered in v0.1. Authoring affordances do not produce them; imported content containing them is preserved byte-for-byte and rendered as plain text:

- **Math.** `$inline$` and `$$display$$` LaTeX-style math. Deferred to v0.1.x ("second step"); KaTeX integration is the implementation path.
- **Attribute syntax.** `{#id .class key=value}` Pandoc-style attributes. Not native to GFM; not in v0.1.
- **Callouts / admonitions.** `> [!NOTE]` GitHub/Obsidian convention. Recognized at parse for round-trip; the v0.1 baseline editor renders the callout block as a normal block quote (the `[!NOTE]` marker stays as plain text inside the quote). Full callout decoration is deferred to v0.1.x.
- **Iframes / embeds.** Raw `<iframe>` HTML. Recognized as raw HTML; rendered as plain monospace; sandboxing is out of scope until the attachment-encryption pipeline lands.
- **Custom container blocks.** `:::` div containers (Pandoc / Djot syntax). Not in v0.1.
- **Mermaid / PlantUML diagrams.** Recognized as fenced code blocks with `mermaid` / `plantuml` language label; rendered as monospace code; diagram rendering is deferred.
- **Inline images.** `![alt](path)` and `![[image.png]]` are parsed and round-trip-stable, but inline image rendering is gated on the attachment-encryption pipeline that is not part of v0.1. **Reference-style images** (`![alt][ref]`) resolve against the same link reference definition table as reference links (§3.2) — but their v0.1 rider (hiding a definition line referenced only by an image, even though no `<img>` is drawn) is **deferred to MYND-164**, tracked alongside the attachment-encryption pipeline. Until then, a definition referenced only by an image stays visible.

## 8. Parser configuration (informative)

For the v0.1 reference implementation in the desktop client:

- Parser: `@codemirror/lang-markdown` configured with `markdownLanguage` (CodeMirror's GFM-bundled base language) plus a footnote `MarkdownConfig` extension plus the Wikilink `MarkdownConfig` extension defined in [`wikilink.md`](wikilink.md) plus a frontmatter-recognizer that tags the leading `---\n…\n---` block as a special node.
- Definition lists (§3.1) use a custom `MarkdownConfig` extension (a `LeafBlockParser`, the same hook CommonMark uses for setext headings and link references) that emits a `DefinitionList` block node with `DefinitionTerm` / `DefinitionMarker` (`:`) / `DefinitionDesc` children for the pinned tight subset. GFM has no definition-list node, so this extension is the sole producer; it is registered both in the shared serialization parser and in the editor's `markdown({ extensions })` so the editor's `syntaxTree` carries the node for decoration. Setext headings and reference links require **no** parser extension — `markdownLanguage` already produces `SetextHeading1`/`SetextHeading2` and reference-style `Link` nodes; MYND-146/148 are decoration-only.
- Footnotes (§3.4) use a custom `MarkdownConfig` extension (`src/dialect/lezer/footnote.ts`, MYND-153) because the `GFM` bundle (`[Table, TaskList, Strikethrough, Autolink]`) carries no footnote config and `@lezer/markdown` exports none. It emits an inline `FootnoteReference` node (registered `before: "Link"` so `[^…]` outranks standard link parsing) and a block `FootnoteDefinition` node (registered `before: "LinkReference"` so a `[^id]: text` line is claimed as a footnote rather than half-parsed as a CommonMark link reference definition), each exposing `FootnoteMark` (`[^`, `]` / `]:`) and `FootnoteLabel` (the identifier) children. The `FootnoteDefinition` is a **composite block**: its body parses as nested block content via a continuation rule (`NodeSpec.composite`), so multi-paragraph footnotes and fenced code / blockquotes *inside* a footnote render correctly. Like definition lists it is registered in both the shared serialization parser and the editor's `markdown({ extensions })`. The v0.1 subset: an identifier is a non-empty whitespace-free run with no `]`; a definition begins a block line (`[^id]:`, content optional — a bare `[^id]:` is an empty definition) and its body continues onto following lines that are blank or indented ≥4 columns (the Pandoc / GitHub continuation rule), ending at the first less-indented non-blank line; a footnote-definition line also interrupts an open paragraph (so consecutive `[^1]:`/`[^2]:` lines are distinct definitions). Recognizer-only — it emits nodes and never mutates bytes. The editor renders the reference as a superscript marker and collects definitions into a derived end-of-document list (a VIEW; in-source definition lines stay byte-stable in place); see `decisions.md` 2026-05-31.
- The frontmatter recognizer is single-pass and does not parse the YAML body; it only delimits the block. YAML parsing happens in a separate pass (when the Properties UI lands; deferred).
- HTML embedded inside markdown is recognized via `@codemirror/lang-html` (forced transitive of `lang-markdown`); v0.1 renders raw HTML as plain monospace, with no sanitization (because nothing is rendered beyond plain monospace, there is no XSS surface).

This section is informative — a future Myne client implementation may choose any parser that produces an AST conformant to §3 and emits per §5. The dialect, not the parser, is what binds clients.

## 9. Versioning

This dialect specification covers Myne v0.1 only. v005 will pin its own dialect specification with its own magic-byte and AAD-prefix scheme per [`protocol.md`](protocol.md) §10. There is no provision for in-place dialect upgrades within v0.1.
