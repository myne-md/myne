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
| 11 | `[[Projects/]]` (trailing slash) | no² | yes | **Folder-target wikilink** — resolves to the named folder's index note (§5.5); reuses backlinks / hover / graph |
| 12 | `![[att:<attachment-id-hex>\|filename]]` | **yes**³ | yes | **Attachment embed (form C).** The canonical Myne form for an embedded encrypted attachment. The `att:` scheme prefix routes resolution to the `vault.attachments` catalog ([`protocol.md`](protocol.md) §9.10), **not** the note index. Renders inline per §5.1. |

¹ Forms 5 and 7 are recognized for round-trip but not emitted by Myne-authoring affordances. New Myne wikilinks always include a display alias (form 6) — see §4.

² Form 11 (the folder-target wikilink) is recognized and resolved but, like the path-only forms, is not the canonical authoring emission — Myne's affordances emit the note-targeting form 6; a user types `[[Projects/]]` by hand when they want the folder's index note. The form round-trips byte-for-byte.

³ Form 12 is authored by Myne but is **never typed by a user**. It is emitted by every attachment-insert path (paste, drag, the picker, the attachments library's "insert into note", and the sanctioned import transform of [`markdown-dialect.md`](markdown-dialect.md) §6), and it renders as an atomic widget with no source-lift (§5.4), so the caret never enters it and the `att:` target is never exposed as editable text. A user therefore cannot hand-write or hand-edit one inside Myne; authoring affordances are the only path. Form 12 is a Myne extension with no Obsidian counterpart: on an attachments-included export it is rewritten back to a plain wikilink embed referencing the exported file ([`markdown-dialect.md`](markdown-dialect.md) §6, export transform 1).

### 2.1 Lexical rules

- **Opening delimiter**: two consecutive `[` characters, not preceded by an unescaped `[`.
- **Closing delimiter**: two consecutive `]` characters, not preceded by an unescaped `]`.
- **Embed prefix**: a single `!` character immediately preceding the opening `[[`. The `!` is part of the wikilink token (forms 8–9).
- **Alias divider**: `|` (U+007C) within a wikilink separates the target from the display alias. The alias divider is **not** an escape boundary; characters on either side are literal.
- **Heading anchor delimiter**: `#` within the target portion (before any `|`) separates the note reference from a heading anchor.
- **Block reference delimiter**: `^` within the target portion (before any `|`) separates the note reference from a block ID.
- **Folder-target trailing slash**: a target portion (before any `|`, `#`, or `^`) ending in a single `/` marks a **folder-target wikilink** (form 11) — the target names a folder, not a note, and resolves to that folder's index note (§5.5). The trailing slash is the sole discriminator from a title-only target; `[[Projects]]` targets a note titled "Projects", `[[Projects/]]` targets the index note of the folder "Projects".
- **Attachment scheme prefix**: a target beginning with the literal `att:` (form 12) marks an **attachment embed**. The remainder must be a 64-character lowercase-hex attachment-id ([`protocol.md`](protocol.md) §9.9); a target that carries the prefix but whose remainder is not a valid id is **not** an attachment embed and degrades to an ordinary embed chip rather than erroring. The prefix is only meaningful on the embed form (`![[…]]`).
- **Layout segments (form 12 only)**: the alias of an attachment embed is a `|`-separated list. **Segment 1 is always the display filename**; from segment 2 on, a segment of the shape `<key>=<value>` where `<key>` is in the closed vocabulary `w` / `h` / `align` / `alt` carries an [embed layout segment](../glossary.md), and a segment with no `<key>=` prefix **rejoins the filename** with its `|`. `alt=` is **terminal**: everything after it up to the closing `]]` is alt text, pipes included. Decoration behaviour and the value grammar are §5.1.
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

**Virtual-path note (MYND-144).** Under Myne's virtual folders, this "vault-relative path" is itself **virtual** — the on-disk layout is always flat `notes/<uuid>.myn` ([`protocol.md`](protocol.md) §9.1), never a `<folder>/<title>.md` directory tree. The path a Myne-authored wikilink carries is the **derived** form `<folder>/<title>.md` — a note's `folder:` frontmatter ([`markdown-dialect.md`](markdown-dialect.md) §3.6.1) joined with its `title:` — and it resolves through the vault index, not the filesystem. Resolution is therefore **title-keyed** with the folder segment as a disambiguator (§5.3); the path stays in the source bytes as a human-readable, walk-away-friendly cache, not a literal on-disk reference. This refines the original C2 "self-resolving without the index" property from a machine-guarantee to a human-guarantee (the index lookup happens regardless of which key resolution uses, because there is no `<folder>/<title>.md` file on disk to follow).

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
- For embeds: `![[Note]]` displays "Embed: Note" with a distinct chip styling. A **raw-path** image embed `![[image.png]]` also displays as a labeled chip ("Embed: image.png"): it names a file the vault does not own, so there is nothing to decrypt and render. Only the **attachment form** (form 12, `![[att:<id>|filename]]`) renders media inline.
- For attachment embeds (form 12): the chip is replaced by the resolved attachment itself. A raster or SVG attachment renders as an inline `<img>` served from the decrypting `attachment://<id>` handler (SVG through `<img>` only, in secure static mode, so its markup never enters the DOM); a PDF renders as a bounded scrollable reader with a mandatory generic-icon fallback; audio and video render as inline players; anything else renders as a file card whose content is never shown inline. An id the catalog does not resolve renders as a **tombstone** chip, distinguishing an attachment that was deleted from a reference that was never valid, and the note bytes are never rewritten in either case. Each of the RESOLVED renderings above carries an overflow menu for the file actions (export, rename, remove, reveal); a tombstone carries none, having no file to act on. The **layout segments** below are authorable only on the image and PDF renderings, and only through that menu: a form-12 embed is atomic and never source-lifts (§5.4), so the caret cannot enter it to type one.

An attachment embed's alias may carry **layout segments** (§2.1). The closed value grammar is `w = <1..8192> | <1..100>%`, `h = <1..8192>`, `align = left | center | right`, and `alt = <free text, terminal>`; every value is validated before it reaches the rendering surface.

- **Width is a maximum intent, not a guarantee.** An explicit width is always paired with a clamp to the editor's content column. The column is a user preference, so an unclamped width would both overflow the default column and break the layout of existing notes when that preference changes. A width expressed as a percentage is resolved against the same column, which is how "as wide as the page" is said; no pixel count expresses it.
- **An out-of-grammar value is dropped, never clamped and never rewritten.** Substituting the nearest legal number would silently replace a choice the author stated. The note's bytes are not modified in any case.
- **Reporting splits by case.** A **known** key carrying an invalid value is reported persistently in the rendered block, carrying the offending text verbatim (the `markdown-dialect.md` §3.9.3 shape). An **unrecognised** key is passed over **silently**: clients ship on independent versions against one synced vault, so a key one client does not know means the note is newer, not wrong, and there is nothing its reader could act on.
- **Alt text is the accessible name.** An authored alt replaces the filename on the rendered media and on the embed's accessible name. An authored EMPTY alt marks the media decorative and is a distinct state from an absent one; the surrounding container stays reachable so its overflow menu is not hidden with it.
- **Alignment applies to the embed's own box**, not to surrounding text, and never through a style string built from note-authored bytes.

### 5.2 Atomicity (load-bearing)

Wikilink chips are registered with `EditorView.atomicRanges` so that:

- **Backspace** (cursor immediately right of the chip) deletes the entire chip in one keystroke, including the `[[ ]]` delimiters in the source.
- **Forward delete** (cursor immediately left of the chip) deletes the entire chip likewise.
- **Left / right arrow** keys skip over the chip in one motion.
- **Selection** spanning the chip selects the chip atomically — partial chip selection is not possible via cursor navigation. Mouse drag-selection is permitted to span the chip; in that case the underlying source `[[…]]` becomes part of the selection at byte level.

Atomicity applies to **all** recognized wikilink forms.

### 5.3 Broken-link styling

Resolution is **title-keyed** for all forms (MYND-144). Under virtual folders there is no `<folder>/<title>.md` file to match on disk (§3.1), so the earlier two-mode rule (title-only via index vs. path-form via exact filesystem path) collapses into a single title-keyed model in which the folder segment of a path-form link is a **disambiguator**, not the primary key. The resolution algorithm:

1. Look up notes whose `title:` matches the target's title component (the final path segment with the `.md` extension stripped).
2. **Single hit** → resolve to it. (This is why moving a note between folders never breaks a link — the title is unchanged.)
3. **Multiple hits** (title collision) → use the link's folder segment as a first-tier disambiguator (a note whose `folder:` matches the link's folder prefix wins), ahead of Obsidian's "shortest path" tiebreak.
4. **No folder match** → fall back to the shortest-path heuristic; surface ambiguity in the hover tooltip (§6.2, "(N matches)").
5. **Zero hits** → the wikilink is **broken**.

On a conflict between a path-form link's baked-in folder segment and the target note's actual `folder:` frontmatter, the **frontmatter wins** — the path string is a human-facing cache, not the runtime authority. The resolver never rewrites a stale segment at resolution time (that would be the §7.3-forbidden lazy migration); staleness instead surfaces via the R1 hover tooltip (§6.2), which shows the *true* resolved path.

**Accepted residual (slot-reoccupation).** If an inbound-link auto-update (§8) is *missed* and the note that occupied a `<folder>/<title>` slot has left while another note has taken that title in that folder, a stale path-form link will resolve to the new occupant. Only a stable note-UUID key would prevent this, and a UUID key is disqualified by the C2 self-describing / walk-away / Obsidian-round-trip commitments; the title-keyed model is never worse than an exact-path model and recovers more cases, with the window kept narrow by §8 freshness + hover-truth. This residual is accepted for v0.1.

Broken wikilinks render with a distinct chip style: lighter foreground color, no underline, italic display text. The "Create note on click" affordance for broken wikilinks is deferred to v0.1.x.

### 5.4 Cursor behavior — chip stays atomic regardless of cursor position

Unlike other markdown decorations (headings, bold, links), **wikilink chips do not lift on cursor entry**. A line containing a wikilink shows the chip whether the cursor is on the line or off it. To edit a wikilink's source, the user either deletes the chip atomically and types a new one, or uses an explicit "edit wikilink" affordance (deferred — not in baseline).

This is intentional: lifting a wikilink chip would expose `[[vault/relative/path.md|Display]]` as raw text on the active line, which the secondary persona experiences as "this is suddenly a programmer tool". The chip stays.

### 5.5 Folder-target resolution (MYND-370)

A **folder-target wikilink** (form 11, trailing slash — §2.1) resolves to the **index note** of the named folder: the in-folder note carrying `folder_index: true` ([`markdown-dialect.md`](markdown-dialect.md) §3.6.1). The resolution algorithm:

1. Fold the target's folder path (case-fold + NFC + trailing-slash normalization, the §3.6.2 folder identity rule) and match it against the vault's reconstructed folder set.
2. **Folder exists, has an index note** → resolve to that note (its `folder:` folds-equal to the target *and* it carries `folder_index: true`). The chip renders with the index note's title, and the link participates in backlinks, hover, and the graph exactly like a note-targeting wikilink — the folder-target form is a different *spelling* of "link to this note", not a different link kind. Resolution is **unaffected** by the index note being hidden from the sidebar folder tree (`decisions.md` 2026-06-27): the resolver projects from `resolverCache` (which still includes folder notes), so a folder note that is no longer a visible sidebar row still resolves here.
3. **Folder exists, no index note** → the wikilink is **broken** with the distinct hover hint **"(no folder note)"** (§6.2): the folder is real, but no in-folder note has been designated its index.
4. **Folder does not exist** → the wikilink is **broken** with the distinct hover hint **"(no match)"** (§6.2), the same hint a note-target that resolves to zero notes shows.

Broken folder-target links render with the same broken-link styling as §5.3. If two in-folder notes both carry `folder_index: true` (a conflict), resolution picks the deterministic winner — the note with the smallest `note_uuid` — and the conflict is flagged so the user can resolve it; the link still resolves rather than breaking.

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
- For a broken **folder-target** wikilink (form 11, §5.5): hover distinguishes the two failure modes — **"(no folder note)"** when the folder exists but has no index note (`folder_index: true`), versus **"(no match)"** when the named folder does not exist at all.

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

- **Title rename** (correctness-critical) — sidebar right-click → rename, command palette rename action. This rewrites a note's `title:`, which is the resolution **key** (§5.3); a stale inbound link would genuinely break, so the update is **transactional** (§8.3).
- **Folder move / folder rename** (best-effort, MYND-144) — moving a note to a different folder (sidebar drag-move) or renaming a folder. These change a note's `folder:`, **not** the resolution key, so resolution survives a stale link (title-keyed, §5.3). Inbound path-form links get a **cosmetic** refresh of their folder segment — best-effort, **not** transactional: a partial failure leaves a stale folder segment that the resolver tolerates (and the R1 hover surfaces, §6.2). Title-only imported links are unaffected by a folder move (their title is unchanged). **A folder rename also refreshes inbound folder-target wikilinks** (form 11, §5.5): because such a link carries the folder path literally in its target, a folder rename rewrites the path segment of every `[[OldFolder/]]` to `[[NewFolder/]]` on the same best-effort, non-transactional pass — a stale folder-target segment is a resolver-tolerated cosmetic drift, never a correctness break (the index-note binding itself is path-free, §3.6.1, so the link's *target note* tracks the rename even before the segment is refreshed).

Auto-update does **not** fire on:

- **OS-level rename** (Finder, `mv`, Explorer). The user only sees encrypted `<uuid>.myn` blobs at the OS level — there is no human-readable filename for them to rename outside of Myne.

### 8.2 Form preservation

Auto-update **preserves the syntactic shape** of every wikilink it touches:

- An imported title-only wikilink `[[Old Title]]` becomes `[[New Title]]` after rename — the form stays title-only; only the title text updates.
- A Myne-authored path-form `[[notes/2025/old-path.md|Display]]` becomes `[[notes/2025/new-path.md|Display]]` — the form stays path-form; only the path updates (and the alias, per the mirror rule below).
- An imported `[[Old Title|Display]]` becomes `[[New Title|Display]]` — a **genuinely-custom** alias (one that does not equal the renamed title) is preserved.
- **Alias-mirror rule.** Myne's picker emits the canonical form with the alias defaulted to the title (`[[<path>.md|<Title>]]`, §3 / `emitNoteWikilink`), so for an auto-authored link the alias is *not* a deliberate label — it is the title in display position. An alias that **folds-equal to the renamed title** therefore tracks the new title (`[[old.md|Old Title]]` → `[[new.md|New Title]]`); only an alias that differs from the renamed title is treated as custom and preserved. Without this, every Myne-authored inbound chip would freeze at the old name on rename even though its target/path updated — the rendered chip displays the alias, not the live note title. Fold-insensitive, using the same key the link matched on.
- An imported `[[Old Title#Heading]]` becomes `[[New Title#Heading]]` — the anchor is preserved.
- An imported `[[Old Title^block-id]]` becomes `[[New Title^block-id]]` — the block ID is preserved.
- An embed `![[Old Title]]` becomes `![[New Title]]` — the embed prefix is preserved.
- A folder-target `[[OldFolder/]]` becomes `[[NewFolder/]]` on a **folder** rename (§8.1) — the trailing-slash folder-target shape is preserved; only the folder path segment updates.

Auto-update never **promotes** a wikilink's syntactic form during a rename. A user who explicitly wants imported title-only wikilinks rewritten as Myne path-forms must invoke R2 (§7).

### 8.3 Transactional rollback

**This transactional rollback applies to title rename only** (the correctness-critical trigger, §8.1) — title is the resolution key, so a half-applied rename would leave genuinely-broken links. Folder move / folder rename do **not** use this rollback: they get a best-effort, non-transactional cosmetic refresh (§8.1), because a stale folder segment does not break resolution under the title-keyed model.

If a title rename triggers updates across N files and any update fails (disk full, permission error, encryption error in the per-note save pipeline), **all updates roll back** and the rename is reported as failed. The vault is left in its pre-rename state.

The rollback shape requires either:

- **(a) Pre-write journal**: write each updated `.myn` blob to a temporary file `<uuid>.myn.tmp` first; once all N writes succeed, atomically rename each `.tmp` to `.myn` (filesystem `rename(2)` is atomic on POSIX). Failure mid-way leaves orphan `.tmp` files which a sweeper deletes on next vault-open.
- **(b) Pre-write backup**: copy each existing `.myn` to `<uuid>.myn.bak` before re-encryption; on any failure, restore each `.bak` to `.myn`. Doubles disk usage briefly during rename.

The choice between (a) and (b) is an open implementation decision (see `myne-agents/features/editor-mvp/rfc.md` Open Question #1) and may require a paragraph addition to [`protocol.md`](protocol.md) §9 once it lands.

## 9. Out of scope for v0.1

The following wikilink-related behaviors are **not** part of v0.1:

- **Note transclusion engine.** `![[Other Note]]` renders as a labeled chip ("Embed: Other Note") with click-through, but does **not** transclude the linked note's content inline. Transclusion would require an internal database tracking sync targets — direct collision with `vision.md`'s "no internal database that owns content" anti-feature.
- **Authoring of `^block-id` markers.** Block IDs are recognized at parse for round-trip stability with imported Obsidian vaults, but Myne authoring affordances never *create* new block IDs. This avoids expanding Myne's surface in the direction of "blocks-as-citizens" architecture which was rejected during the 2026-05-01 grill.
- **"Create note on click" for broken wikilinks.** A broken wikilink chip shows broken-link styling but clicking it does nothing in v0.1. Note creation requires a separate explicit user action; the create-from-broken-link affordance is deferred to v0.1.x.
- **Image rendering for the raw-path form `![[image.png]]`.** Recognized at parse and rendered as a labeled chip. This is not a deferral waiting on the attachment pipeline: that pipeline ships in v0.1 ([`protocol.md`](protocol.md) §11.2) and the **attachment form** (form 12) renders inline today (§5.1). A raw-path ref names a file outside the vault, so there is nothing to decrypt; the Obsidian importer rewrites the ingestable ones into form 12 and leaves the rest as placeholder comments ([`markdown-dialect.md`](markdown-dialect.md) §6).
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

This wikilink specification covers Myne v0.1 only. A later version will pin its own wikilink specification (potentially with a different syntactic form for path-vs-title disambiguation). No in-place wikilink-syntax upgrades within v0.1.
