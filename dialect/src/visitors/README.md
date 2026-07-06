# `src/dialect/visitors/` — Tree visitors that produce `ParseResult` fields

Each file here walks the lezer parse tree and produces one output field:

- `frontmatter.ts` — uses `js-yaml` on the FM block; produces `Frontmatter` (Task 6).
- `headings.ts` — produces `HeadingRef[]` (Task 7).
- `wikilinks.ts` — produces `WikilinkRef[]` (Task 8).
- `inlineTags.ts` — produces `InlineTagRef[]`, un-normalized (Task 9).
- `mediaRefs.ts` — produces `MediaRef[]` for `![](path)` form only (Task 10).
- `fullText.ts` — produces the decoration-stripped, frontmatter-excluded,
  code-included plain-text string (Task 11).

Composed by `src/dialect/parse.ts` (Task 12).
