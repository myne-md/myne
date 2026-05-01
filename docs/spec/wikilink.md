# Wikilink Specification — v0.1

> Normative specification of Myne's wikilink syntax, parsing rules, and decoration / authoring behavior. Companion to [`markdown-dialect.md`](markdown-dialect.md). This document binds every Myne client.

## 1. Scope

Wikilinks are Myne's first-class internal-link syntax: `[[Note]]`-style references that resolve against the current vault and render as atomic chip widgets in the editor. This document defines:

- the recognized syntax forms,
- the canonical authoring form for new Myne-written wikilinks,
- the dual-syntax handling rule for imported vs. Myne-authored wikilinks,
- decoration behavior (chip rendering, atomicity, broken-link styling),
- editor-time UX (autocomplete picker, hover-tooltip resolution, manual conversion command),
- auto-update on rename semantics including transactional rollback.

Wikilinks are **not** standard markdown. No CommonMark / GFM / Pandoc / Djot dialect natively defines them. They are a Myne extension on top of [`markdown-dialect.md`](markdown-dialect.md) D1.

## 2. Recognized syntax forms

The parser recognizes the union of forms below. Forms in **Authoring** column show whether Myne emits this form when authoring new wikilinks; forms in **Round-trip** column show whether Myne preserves this form byte-for-byte on read/write of imported content.

| # | Form | Authoring | Round-trip | Notes |
|---|---|---|---|---|
| 1 | `[[Note Title]]` | no | yes | Title-only; Obsidian-imported default |
| 2 | `[[Note Title\|Display]]` | no | yes | Title-only with display alias |
| 3 | `[[Note Title#Heading]]` | no | yes | Title-only with heading anchor |
| 4 | `[[Note Title^block-id]]` | no | yes | Title-only with block reference |
| 5 | `[[vault/relative/path.md]]` | no¹ | yes | Path-only without alias |
| 6 | `[[vault/relative/path.md\|Display]]` | **yes** | yes | **Canonical Myne authoring form** (§4) |
| 7 | `[[vault/relative/path.md#Heading]]` | no¹ | yes | Path with heading anchor |
| 8 | `![[Note Title]]` | no | yes | Embed/transclusion form (rendered as labeled chip; no transclusion engine) |
| 9 | `![[image.png]]` | no | yes | Image embed (rendering gated on attachment-encryption pipeline) |
| 10 | `[[]]` (empty) | no | yes (preserved as plain text) | Triggers note-picker autocomplete in editor; on disk stays as literal `[[]]` |

¹ Forms 5 and 7 are recognized for round-trip but not emitted by Myne-authoring affordances. New Myne wikilinks always include a display alias (form 6) — see §4.

### 2.1 Lexical rules

- **Opening delimiter**: two consecutive `[` characters, not preceded by an unescaped `[`.
- **Closing delimiter**: two consecutive `]` characters, not preceded by an unescaped `]`.
- **Embed prefix**: a single `!` character immediately preceding the opening `[[`. The `!` is part of the wikilink token (forms 8–9).
- **Alias divider**: `|` (U+007C) within a wikilink separates the target from the display alias. The alias divider is **not** an escape boundary; characters on either side are literal.
- **Heading anchor delimiter**: `#` within the target portion (before any `|`) separates the note reference from a heading anchor.
- **Block reference delimiter**: `^` within the target portion (before any `|`) separates the note reference from a block ID.
- **Forbidden inside a wikilink target**: the substring `]]`. Note titles and paths therefore **must not** contain `]]`. This is inherited from Obsidian's restriction; v0.1 does not provide an escape sequence for `]]` inside wikilinks.
- **Line breaks**: a wikilink terminates at the first line break encountered between `[[` and `]]`. A wikilink does not span multiple lines.

### 2.2 Parsing precedence

The wikilink parser is registered with `before: "Link"` in `@codemirror/lang-markdown`'s extension protocol — wikilinks outrank standard markdown `[text](url)` link parsing, so `[[X]]` is always a wikilink, never a nested-bracket link.

## 3. Path encoding for new Myne wikilinks

When Myne authors a new wikilink (via the autocomplete picker, the `/wiki` slash command, the `Cmd+Shift+L` keyboard shortcut, or any programmatic insertion), the emitted form is:

```
[[vault/relative/path.md|Display Title]]
```

with the following rules:

### 3.1 Path is vault-relative

Paths are **relative to the vault root** — the directory containing `vault.meta` per [`protocol.md`](protocol.md) §9.1. Concretely, `notes/2025/01-10.md` (relative) — never `/Users/foo/Vaults/MyVault/notes/2025/01-10.md` (absolute filesystem path).

**Rationale.** Absolute filesystem paths break the moment the vault moves to another machine, OS, or mount point — defeating `vision.md`'s portability commitment. Vault-relative paths are also already valid Obsidian wikilink syntax (Obsidian supports `[[folder/Note Name]]` natively), so the form round-trips into Obsidian without reinterpretation.

### 3.2 Path includes the `.md` extension

The emitted path includes the `.md` file extension. Concretely, `[[notes/2025/01-10.md|Wednesday]]` — never `[[notes/2025/01-10|Wednesday]]`.

**Rationale.** The wedge sentence in `vision.md` says "your files stay plaintext-readable after decryption". With the `.md` extension explicit, anyone reading the source markdown can identify the link target as a literal file on disk and follow it without consulting the vault index. Obsidian accepts both with-extension and without-extension forms, so byte-stable round-trip into Obsidian is preserved.

### 3.3 Display alias is mandatory for new emissions

The emitted form always includes the `|Display Title` portion. The alias is what the rendered chip shows; the path is the resolution target. Myne's authoring affordances do not emit form 5 (`[[path.md]]` without alias) — the path-only form is recognized for round-trip but never written.

**Rationale.** A path-only chip rendering "notes/2025/01-10.md" as the display label is illegible at a glance. The `|Display` portion lets Myne render a clean chip while keeping the source self-resolving.

### 3.4 Path normalization

Paths are normalized before emission:

- forward slashes (`/`) only — never backslashes
- no leading `/` (relative, not absolute)
- no `./` or `../` segments
- no trailing whitespace
- no URL-encoding (`%20` for spaces is **not** used; spaces in path components are emitted as literal spaces)

## 4. Dual-syntax handling

Myne's authoring form (§3) and Obsidian's title-only form (§2 forms 1–4) coexist in the same vault. The two coexist because of the C1 hard rule:

> **C1.** Vault imports must not silently rewrite note content. Imported wikilinks are preserved in their original form.

When a vault is imported from Obsidian, all its wikilinks land in title-only forms 1–4. When the user authors a new wikilink inside Myne, the path-with-alias form 6 is emitted. **Both forms coexist indefinitely** — Myne never converts imported wikilinks to its authoring form unless the user explicitly invokes the manual conversion command (§7).

The decoration layer treats both forms identically: every recognized wikilink renders as a chip showing its alias-or-title. Click-resolution differs: title-only forms resolve via vault-index lookup; path-form follows the path directly.

## 5. Decoration behavior

### 5.1 Chip rendering

Every recognized wikilink renders as an **atomic chip widget**. Concretely:

- The chip displays the alias if the wikilink has one (`[[Note|Display]]` → "Display"); otherwise the title or final path component (`[[Note]]` → "Note"; `[[notes/01-10.md]]` → "01-10.md" stripped of extension).
- For heading anchors: `[[Note#Heading]]` displays "Note › Heading" using the U+203A right-single-quotation-mark separator.
- For block references: `[[Note^block-id]]` displays the same chip as `[[Note]]` — the `^block-id` portion is preserved in the source byte-for-byte but ignored at decoration time.
- For embeds: `![[Note]]` displays "Embed: Note" with a distinct chip styling. Image embeds `![[image.png]]` display "Embed: image.png" until the attachment-encryption pipeline lands; full image rendering is deferred.

### 5.2 Atomicity (load-bearing)

Wikilink chips are registered with `EditorView.atomicRanges` so that:

- **Backspace** (cursor immediately right of the chip) deletes the entire chip in one keystroke, including the `[[ ]]` delimiters in the source.
- **Forward delete** (cursor immediately left of the chip) deletes the entire chip likewise.
- **Left / right arrow** keys skip over the chip in one motion.
- **Selection** spanning the chip selects the chip atomically — partial chip selection is not possible via cursor navigation. Mouse drag-selection is permitted to span the chip; in that case the underlying source `[[…]]` becomes part of the selection at byte level.

Atomicity applies to **all** recognized wikilink forms.

### 5.3 Broken-link styling

A wikilink is **broken** when its target cannot be resolved against the current vault index. For title-only forms (1–4), resolution succeeds when at least one note in the vault has a matching title; ties are resolved by Obsidian's "shortest path" heuristic. For path forms (5–7), resolution succeeds when a note exists at exactly the specified vault-relative path.

Broken wikilinks render with a distinct chip style: lighter foreground color, no underline, italic display text. The "Create note on click" affordance for broken wikilinks is deferred to v0.1.x.

### 5.4 Cursor behavior — chip stays atomic regardless of cursor position

Unlike other markdown decorations (headings, bold, links), **wikilink chips do not lift on cursor entry**. A line containing a wikilink shows the chip whether the cursor is on the line or off it. To edit a wikilink's source, the user either deletes the chip atomically and types a new one, or uses an explicit "edit wikilink" affordance (deferred — not in baseline).

This is intentional: lifting a wikilink chip would expose `[[vault/relative/path.md|Display]]` as raw text on the active line, which the secondary persona experiences as "this is suddenly a programmer tool". The chip stays.

## 6. Editor-time UX

### 6.1 Autocomplete picker

When the user types `[[`, an autocomplete picker opens. The picker:

- searches the in-memory vault note index by title and by path;
- supports fuzzy matching (a query of `01-10` matches both a note titled "01-10-2025 Wednesday" and a note at path `notes/2025/01-10.md`);
- displays results as a list with each item showing the note's title above a smaller secondary line with the vault-relative path;
- on selection (Enter or click), inserts the canonical emit form (§3): `[[vault/relative/path.md|Display Title]]` with the cursor positioned immediately after the closing `]]`;
- dismisses on Esc, leaving the typed `[[` in source as plain text;
- does **not** create a new note when the query has no matches (note creation requires a separate explicit user action — out of scope for v0.1).

The picker is also reachable via the `/wiki` slash command and the `Cmd+Shift+L` keyboard shortcut.

### 6.2 Hover-tooltip resolution (R1)

Every chip — both Myne-authored path forms and imported title-only forms — shows the resolved vault-relative path on hover. Concretely:

- For path-form `[[notes/2025/01-10.md|Wednesday]]`: hover shows "Wednesday → notes/2025/01-10.md".
- For title-only `[[Wednesday]]` (imported): hover shows "Wednesday → notes/2025/01-10.md" (resolved via vault index).
- For broken links: hover shows "(no match)" or, if multiple ambiguous matches exist for a title, "(N matches)" with the first match shown.

R1 hover tooltip never mutates the source. The path information is rendered, not authored.

### 6.3 Disambiguation on resolution failure

When a title-only wikilink resolves to multiple notes (e.g., the vault has two notes titled "Wednesday" at different paths), Myne picks the first match by Obsidian's shortest-path rule and surfaces ambiguity in the hover tooltip ("(2 matches)"). The user can resolve ambiguity by invoking R2 (§7) on the note containing the ambiguous link — R2 prompts for a path choice during the conversion.

## 7. Manual conversion command (R2)

R2 is the user-initiated migration path from imported title-only wikilinks to Myne-authored path forms.

### 7.1 Per-note conversion (v0.1)

The command palette entry **"Convert imported wikilinks in this note to Myne syntax"** walks the active note, locates every title-only wikilink (forms 1–4), resolves each via vault index, and produces the path-with-alias form (§3). Behavior:

- A diff preview is shown before commit, listing every proposed rewrite.
- The user confirms or cancels.
- Wikilinks that resolve ambiguously (multiple matching titles) prompt for path selection inline within the diff preview.
- Wikilinks that fail to resolve (no matching title) are skipped and surfaced in the preview as "skipped — no match".
- On confirmation, the note is rewritten in a single CodeMirror transaction; the rewrite is undoable via the standard editor undo stack.

R2 mutates the note's bytes — but this is **not** a C1 violation. C1 covers import-time silent rewrites; R2 is post-import, user-initiated, and transparent (diff preview before commit).

### 7.2 Bulk-vault conversion (v0.1.x)

Vault-wide R2 — converting every imported wikilink across every note in a single pass — is deferred to v0.1.x. The deferral is to give the per-note flow time to surface UX issues before scaling.

### 7.3 Lazy migration on edit (forbidden)

Silently rewriting a note's wikilinks the first time the user edits any line of that note is **explicitly forbidden** by C1. A user who fixes a typo on line 3 must not see lines 17 and 42 also change in their diff. The R2 command is the only sanctioned migration path.

## 8. Auto-update on rename

When a note file is renamed or moved within the vault, Myne walks the vault index, locates every wikilink referencing the renamed file, and rewrites each to point at the new path or title. This is not a C1 violation: rename is a user-initiated action, and the user expects the link graph to stay consistent.

### 8.1 Trigger sources

Auto-update fires on:

- **Editor-internal rename** — sidebar right-click → rename, command palette rename action.
- **Sidebar drag-move** — dragging a note to a different folder in the sidebar.

Auto-update does **not** fire on:

- **OS-level rename** (Finder, `mv`, Explorer). The user only sees encrypted `<uuid>.myn` blobs at the OS level — there is no human-readable filename for them to rename outside of Myne.

### 8.2 Form preservation

Auto-update **preserves the syntactic shape** of every wikilink it touches:

- An imported title-only wikilink `[[Old Title]]` becomes `[[New Title]]` after rename — the form stays title-only; only the title text updates.
- A Myne-authored path-form `[[notes/2025/old-path.md|Display]]` becomes `[[notes/2025/new-path.md|Display]]` — the form stays path-form; only the path updates.
- An imported `[[Old Title|Display]]` becomes `[[New Title|Display]]` — the alias is preserved.
- An imported `[[Old Title#Heading]]` becomes `[[New Title#Heading]]` — the anchor is preserved.
- An imported `[[Old Title^block-id]]` becomes `[[New Title^block-id]]` — the block ID is preserved.
- An embed `![[Old Title]]` becomes `![[New Title]]` — the embed prefix is preserved.

Auto-update never **promotes** a wikilink's syntactic form during a rename. A user who explicitly wants imported title-only wikilinks rewritten as Myne path-forms must invoke R2 (§7).

### 8.3 Transactional rollback

If a rename triggers updates across N files and any update fails (disk full, permission error, encryption error in the per-note save pipeline), **all updates roll back** and the rename is reported as failed. The vault is left in its pre-rename state.

The rollback shape requires either:

- **(a) Pre-write journal**: write each updated `.myn` blob to a temporary file `<uuid>.myn.tmp` first; once all N writes succeed, atomically rename each `.tmp` to `.myn` (filesystem `rename(2)` is atomic on POSIX). Failure mid-way leaves orphan `.tmp` files which a sweeper deletes on next vault-open.
- **(b) Pre-write backup**: copy each existing `.myn` to `<uuid>.myn.bak` before re-encryption; on any failure, restore each `.bak` to `.myn`. Doubles disk usage briefly during rename.

The choice between (a) and (b) is an open implementation decision (see `myne-agents/features/editor-mvp/rfc.md` Open Question #1) and may require a paragraph addition to [`protocol.md`](protocol.md) §9 once it lands.

## 9. Out of scope for v0.1

The following wikilink-related behaviors are **not** part of v0.1:

- **Note transclusion engine.** `![[Other Note]]` renders as a labeled chip ("Embed: Other Note") with click-through, but does **not** transclude the linked note's content inline. Transclusion would require an internal database tracking sync targets — direct collision with `vision.md`'s "no internal database that owns content" anti-feature.
- **Authoring of `^block-id` markers.** Block IDs are recognized at parse for round-trip stability with imported Obsidian vaults, but Myne authoring affordances never *create* new block IDs. This avoids expanding Myne's surface in the direction of "blocks-as-citizens" architecture which was rejected during the 2026-05-01 grill.
- **"Create note on click" for broken wikilinks.** A broken wikilink chip shows broken-link styling but clicking it does nothing in v0.1. Note creation requires a separate explicit user action; the create-from-broken-link affordance is deferred to v0.1.x.
- **Image rendering for `![[image.png]]`.** Recognized at parse; rendered as labeled chip until the attachment-encryption pipeline lands.
- **Bulk-vault R2 conversion.** Per-note R2 only in v0.1; vault-wide pass deferred to v0.1.x.
- **Multi-vault wikilinks.** A wikilink target is always within the current vault. Cross-vault references (e.g., `[[other-vault::Note]]` syntax) are not part of v0.1.
- **Wikilinks inside fenced code blocks.** A `[[Note]]` appearing inside a `` ```ts `` fenced code block is **not** recognized as a wikilink — it stays as code text. This matches Obsidian's behavior.

## 10. Reserved syntax / forbidden patterns

The following are forbidden in v0.1; clients must reject or flag them:

- **`]]` inside note titles or paths.** A note whose title or filesystem name contains `]]` cannot be the target of a wikilink — the wikilink parser cannot terminate. Myne's note creation flow rejects titles containing `]]`. Imported notes whose titles contain `]]` are flagged at import time and the user is prompted to rename.
- **Empty alias.** `[[Note|]]` (alias divider with no display text) is parser-tolerated but renders as if no alias were present. Myne authoring never emits this form.
- **Empty path.** `[[]]` is preserved as plain text on disk. The autocomplete picker is the only consumer of empty `[[`; the picker is editor-time UX, not on-disk syntax.
- **Wikilinks across line breaks.** A `[[…]]` that contains a line break between `[[` and `]]` is not a wikilink; it parses as plain text.

## 11. Versioning

This wikilink specification covers Myne v0.1 only. v005 will pin its own wikilink specification (potentially with a different syntactic form for path-vs-title disambiguation). No in-place wikilink-syntax upgrades within v0.1.
