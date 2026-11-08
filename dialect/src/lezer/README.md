# `src/dialect/lezer/` — Custom `MarkdownConfig` extensions for `@lezer/markdown`

Each file here contributes one `MarkdownConfig` extension to the shared parser instance:

- `frontmatter.ts` — single-pass `^---\n…\n---$` block recognizer (Task 6).
- `wikilink.ts` — recognizes all five wikilink forms per `agent-tooling/docs/spec/markdown-dialect.md` §3.5 + `agent-tooling/docs/spec/wikilink.md` §4 (Task 8).
- `inline-tag.ts` — recognizes inline `#tag` per `agent-tooling/docs/spec/markdown-dialect.md` §3.7 (Task 9).

The extensions are composed in `src/dialect/parse.ts` (Task 12) and shared
with the editor's CodeMirror surface (`src/editor/`) — single dialect
implementation across editor and indexer.
