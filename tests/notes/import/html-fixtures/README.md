# HTML→markdown conformance corpus

**This corpus is a divergence gate, not just a test suite.**

The Myne project contains **two** HTML→markdown implementations, deliberately:

| Implementation | Where | Runtime |
|---|---|---|
| Importer converter | `src/notes/import/html/` (this repo) | Tauri WebView, sanitized detached DOM |
| Clipper capture walker | `myne-clipper/src/content/capture.ts` | Browser extension, adversary-controlled page DOM |

The grill of 2026-07-25 (Q3) chose **not** to extract a shared package — the
cross-repo coordination cost was judged higher than the divergence risk, and the
clipper's walker is self-described as "FUNCTIONAL, NOT YET FAITHFUL". The accepted
mitigation (R1) is this corpus: both implementations are pinned against **one** set
of fixture pairs, so drift shows up as a failing test rather than as a user noticing
that a nested list imports differently depending on how it entered the vault.

**Consequence to keep in mind:** this detects divergence, it does not prevent it.
The corpus is only as good as its coverage.

## Layout

```
NN-name.html          the input
NN-name.expected.md   the exact expected markdown
```

`html-fixtures.test.ts` discovers pairs by directory scan, so **adding a fixture
requires no test edit**.

## Regenerating expected output

After an *intentional* emit change:

```bash
UPDATE_HTML_FIXTURES=1 npx vitest run tests/notes/import/html-fixtures.test.ts
```

Then **read the diff before committing it**. The flag rewrites expectations
unconditionally — it will happily enshrine a regression. This corpus caught a real
one on first generation: a `<div>` of mixed inline content was being split into one
block per inline run, which would have shredded every Evernote note (ENML uses
`<div>` as its paragraph element). That bug was invisible in unit tests and obvious
in a fixture.

## Fixture provenance rules

Per grill O4, fixtures come from exactly two places:

1. **Hand-authored** per construct — deterministic, reviewable, covers the
   documented allowlist delta one element at a time.
2. **Real exports from throwaway accounts** containing only synthetic content —
   catches real-world export structure (Notion's wrapper `<article>`, ENML's
   `<div>`-as-paragraph, attribute noise) that hand-authored HTML does not.

**Never commit a fixture derived from a personal export.** This is a public
repository for a privacy-focused product; scrubbing is manual and error-prone, and a
missed scrub is exactly the failure the product exists to prevent. If a real export
is needed, generate it from a throwaway account with synthetic notes.

## Adding a construct to the allowlist

A new entry in `IMPORT_DELTA_TAGS` (`src/notes/import/html/sanitize.ts`) is a
**security-relevant** change to the second untrusted-markup boundary in the
codebase. It needs, in the same change: a fixture pair here, a unit test in
`html-to-markdown.test.ts`, and a line in the delta table in
`private-companion/features/importer-breadth-spine/prd.md`.

## Current coverage

| Fixture | Covers |
|---|---|
| `01-headings` | `h1`–`h6`, paragraph separation |
| `02-lists-nested` | `ul`, `ol`, nesting + indentation |
| `03-table` | GFM pipe table from `thead`/`tbody` |
| `04-inline-emphasis` | `strong`, `em`, `del`, `code`, `mark` |
| `05-links-images` | absolute + relative `href`, `img` with `alt` |
| `06-code-block` | `pre` → fence, verbatim (no markdown escaping) |
| `07-blockquote` | `blockquote`, `hr` |
| `08-hostile-markup` | `<script>` / `<iframe>` / `<style>` / `on*` / `javascript:` / `data:` all removed while surrounding text survives |
| `09-notion-page` | realistic Notion page-export shape (`<article>` wrapper, UUID-suffixed relative link) |
| `10-enml-body` | realistic ENML body (`<div>` as paragraph — the regression fixture) |
