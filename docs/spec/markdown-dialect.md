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
- Editor implementation details (CodeMirror 6 extension wiring, decoration kinds, slash command shape) — see `agent-tooling/features/editor-mvp/rfc.md` and the editor-mvp PRDs.

## 2. Dialect identity

Myne v0.1 adopts **GFM (GitHub-Flavored Markdown) plus a footnote extension plus a wikilink extension plus YAML frontmatter recognition**. Internally referred to as **D1**. The dialect is:

- **The smallest pin that covers Myne v0.1's editor decoration commitments** (tables, task lists, footnotes, wikilinks, frontmatter).
- **Byte-stable round-trip** with notes imported from Obsidian vaults: a note written by Obsidian, imported into Myne, and never edited inside Myne, must serialize back to the same bytes when exported. (Obsidian conventions Myne does not natively render — `> [!callout]` syntax in v0.1, `^block-id` markers — are still preserved at the byte level. See §6.)
- **Forward-incompatible by design** with v005. v005 will pin its own dialect. Cross-major migration is out of scope per `protocol.md` §10.1; the same applies here.

## 3. Recognized syntax categories

The parser recognizes the union of CommonMark + GFM extensions + footnote extension + wikilink extension + YAML frontmatter. Concretely:

### 3.1 Block elements (CommonMark base)

- ATX headings `# H1` … `###### H6` (only ATX is canonical for new writes; Setext `===` / `---` underline form is recognized on parse for round-trip but never emitted)
- Paragraphs (text separated by blank lines)
- Indented code blocks (4-space indent) — recognized for round-trip but **never emitted**; new code blocks always use fenced form
- Fenced code blocks (`` ``` `` or `~~~`) with optional language label (` ```ts `)
- Block quotes (`> ` prefix)
- Bullet lists (`- ` / `* ` / `+ `; canonical emit form for new writes is `- `)
- Ordered lists (`1. ` / `1) `; canonical emit form is `1. `)
- Horizontal rules (`---` / `***` / `___`; canonical emit form is `---`)
- HTML blocks (raw HTML — recognized at parse, rendered as plain monospace by default; full sanitized rendering is out of scope for v0.1)

### 3.2 Inline elements (CommonMark base)

- Emphasis: `*italic*`, `_italic_`, `**bold**`, `__bold__` (canonical emit forms: `*italic*` and `**bold**` — see §5)
- Inline code: `` `code` ``
- Inline links: `[text](url)` and `[text](url "title")`
- Reference links: `[text][ref]` + `[ref]: url` — recognized for round-trip but **never emitted**; new links use inline form
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

Myne writes one canonical field to YAML frontmatter from the host on `note_update`, per [`decisions.md`](../decisions.md) 2026-05-07 "User-meaningful timestamp storage path: YAML frontmatter convention":

| Field | Type | Semantics | Writer |
|---|---|---|---|
| `updated` | RFC 3339 string (UTC) | User-meaningful last-edit timestamp | Dialect surgery module — invoked by the host on every save (`src/dialect/surgery.ts::patchUpdatedField` in the v0.1 reference implementation; see [`decisions.md`](../decisions.md) 2026-05-09 "Frontmatter byte-level surgery owned by TS dialect module" — supersedes the 2026-05-07 writer mechanic) |

Mechanics:

- The field is **unprefixed** (no `myne_` namespace). Obsidian Templater/Linter and the wider markdown ecosystem use unprefixed `updated:` for this purpose; Myne aligns with that convention so a user who walks away from Myne sees a field every other editor recognizes (`PRODUCT.md` design principle 5 — plain-markdown portability).
- Each save calls the canonical surgery function: the first save after `note_create` prepends the canonical frontmatter block with the `updated:` line; subsequent saves preserve the block and overwrite only the `updated:` value byte-by-byte (preserving trailing comments and quote style, collapsing YAML block-scalar form to single-line canonical). Other frontmatter fields (`title:`, `tags:`, user-authored fields) are preserved per the §3.6 "Unknown frontmatter fields are preserved on write" rule.
- A user who manually sets `updated:` to a custom value sees it overwritten on the next save — autosave is Myne's responsibility. Users who want a manually-managed timestamp use a different field name (e.g., `last_reviewed:`).
- `created_at` is **not** stored in frontmatter — it is derived from the UUIDv7 filename's millisecond time component per [`protocol.md`](protocol.md) §9.1 (already public-accepted leak; no new commitment violation, no frontmatter write needed).
- The set of Myne-managed canonical frontmatter fields is forward-incompatible-by-design with v005: v005 may rename, drop, or supersede `updated:` per its own dialect specification.

### 3.7 Inline-tag extension

Notes may contain inline tags — `#`-prefixed identifiers in body text that consumers (search, backlink, sidebar UI) treat as structured metadata distinct from the YAML frontmatter `tags:` list. The grammar below mirrors Obsidian's runtime behavior so an Obsidian-imported vault produces the same tag set in Myne as it does in Obsidian. Each rule is verified against observed Obsidian behavior in `agent-tooling/researches/2026-05-09-obsidian-inline-tag-behavior.md` (the Q-numbered findings cited per rule).

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

**Implication for Myne authoring.** When a user imports a vault and then edits a note, only the lines they directly change adopt canonical emit forms. Untouched lines stay as written by the original author.

**Implication for migration.** Lazy migration on edit (rewriting all non-canonical syntax in a touched file on save) is **explicitly forbidden** by C1. A user who wants to migrate an imported note's syntax to Myne canonical forms must invoke an explicit, transparent conversion command (the wikilink-specific R2 command is the only such command in v0.1; see [`wikilink.md`](wikilink.md) §7).

## 7. Out of scope for v0.1

The following syntax is **not** parsed or rendered in v0.1. Authoring affordances do not produce them; imported content containing them is preserved byte-for-byte and rendered as plain text:

- **Math.** `$inline$` and `$$display$$` LaTeX-style math. Deferred to v0.1.x ("second step"); KaTeX integration is the implementation path.
- **Attribute syntax.** `{#id .class key=value}` Pandoc-style attributes. Not native to GFM; not in v0.1.
- **Definition lists.** `Term\n: Definition` Pandoc-style. Not in v0.1.
- **Callouts / admonitions.** `> [!NOTE]` GitHub/Obsidian convention. Recognized at parse for round-trip; the v0.1 baseline editor renders the callout block as a normal block quote (the `[!NOTE]` marker stays as plain text inside the quote). Full callout decoration is deferred to v0.1.x.
- **Iframes / embeds.** Raw `<iframe>` HTML. Recognized as raw HTML; rendered as plain monospace; sandboxing is out of scope until the attachment-encryption pipeline lands.
- **Custom container blocks.** `:::` div containers (Pandoc / Djot syntax). Not in v0.1.
- **Mermaid / PlantUML diagrams.** Recognized as fenced code blocks with `mermaid` / `plantuml` language label; rendered as monospace code; diagram rendering is deferred.
- **Inline images.** `![alt](path)` and `![[image.png]]` are parsed and round-trip-stable, but inline image rendering is gated on the attachment-encryption pipeline that is not part of v0.1.

## 8. Parser configuration (informative)

For the v0.1 reference implementation in the desktop client:

- Parser: `@codemirror/lang-markdown` configured with `markdownLanguage` (CodeMirror's GFM-bundled base language) plus a footnote `MarkdownConfig` extension plus the Wikilink `MarkdownConfig` extension defined in [`wikilink.md`](wikilink.md) plus a frontmatter-recognizer that tags the leading `---\n…\n---` block as a special node.
- The frontmatter recognizer is single-pass and does not parse the YAML body; it only delimits the block. YAML parsing happens in a separate pass (when the Properties UI lands; deferred).
- HTML embedded inside markdown is recognized via `@codemirror/lang-html` (forced transitive of `lang-markdown`); v0.1 renders raw HTML as plain monospace, with no sanitization (because nothing is rendered beyond plain monospace, there is no XSS surface).

This section is informative — a future Myne client implementation may choose any parser that produces an AST conformant to §3 and emits per §5. The dialect, not the parser, is what binds clients.

## 9. Versioning

This dialect specification covers Myne v0.1 only. v005 will pin its own dialect specification with its own magic-byte and AAD-prefix scheme per [`protocol.md`](protocol.md) §10. There is no provision for in-place dialect upgrades within v0.1.
