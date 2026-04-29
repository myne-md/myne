# Editor Tooling — Research Notes

> **Status: research, not a decision.** This document compiles the concrete tools, packages, and reference implementations that Phase 1's CodeMirror-based markdown editor stack will draw from. Numbers and versions are accurate as of **2026-04-29** and need re-verification when an actual `package.json` change lands. Decisions about which of these to pin live in `decisions.md`; this file is the input for those entries, not a substitute.
>
> Companion document: `research-kendi-markdown-editoru.md` (root of repo) — broader "build vs. buy" research that establishes *why* CodeMirror 6 is the foundation. This file answers *which packages*.

---

## 1. Scope

The Phase 1 desktop editor (`src/screens/Editor.tsx`) is currently an empty `<textarea>` shell (`decisions.md` 2026-04-29). The next implementation step replaces that surface with a CodeMirror 6-based editor that supports:

- live markdown highlighting (via `@codemirror/lang-markdown` + `@lezer/markdown`),
- `[[wikilinks]]` parsing and decoration (custom — no published CM6 extension exists; see §5),
- atomic-range delete behaviour for wikilink chips (via `EditorView.atomicRanges`),
- syntax-character hiding when the cursor is off-line (Bear/Typora-style live formatting; see §6).

Everything else — backlinks pane data, graph view, full-text search, file persistence, encryption pipeline integration — is out of scope for this document and tracked elsewhere.

## 2. Required runtime packages — pinned candidates

All `@codemirror/*` and `@lezer/*` packages are MIT, authored by Marijn Haverbeke, and share a common semver discipline (6.x is the stable line; 7.x has not been announced). Cross-package version drift is non-trivial — `@codemirror/view 6.41.1` requires `@codemirror/state ^6.6.0`, etc. Pin all CM packages together, lock them with a single PR, and update them together.

| Package | Latest | Last publish | Unpacked | Direct deps | License | Repo (canonical) |
|---|---|---|---|---|---|---|
| `@codemirror/state` | 6.6.0 | 2026-03-12 | ~424 KB | `@marijn/find-cluster-break` | MIT | github.com/codemirror/state |
| `@codemirror/view` | 6.41.1 | 2026-04-18 | ~1.18 MB | `@codemirror/state`, `crelt`, `style-mod`, `w3c-keyname` | MIT | **code.haverbeke.berlin/codemirror/view** |
| `@codemirror/commands` | 6.10.3 | 2026-03-12 | ~238 KB | `@codemirror/{state,view,language}`, `@lezer/common` | MIT | github.com/codemirror/commands |
| `@codemirror/language` | 6.12.3 | 2026-03-25 | ~302 KB | `@codemirror/{state,view}`, `@lezer/{lr,common,highlight}`, `style-mod` | MIT | github.com/codemirror/language |
| `@codemirror/search` | 6.7.0 | 2026-04-21 | ~134 KB | `@codemirror/{state,view}`, `crelt` | MIT | **code.haverbeke.berlin/codemirror/search** |
| `@codemirror/lang-markdown` | 6.5.0 | 2025-10-23 | ~71 KB | `@codemirror/{state,view,language,lang-html,autocomplete}`, `@lezer/{common,markdown}` | MIT | github.com/codemirror/lang-markdown |
| `@lezer/markdown` | 1.6.3 | 2026-01-06 | ~441 KB | `@lezer/common`, `@lezer/highlight` | MIT | github.com/lezer-parser/markdown *(repo banner: moved to code.haverbeke.berlin/lezer/markdown; archived 2026-04-16)* |

**Repo migration note (TB9-relevant).** Several `@codemirror/*` and `@lezer/*` repositories have started migrating off GitHub to Marijn's self-hosted Forgejo at `code.haverbeke.berlin/...`. The npm packages are still published on the public registry under `marijn`, but a reproducible-build audit chain that references the source repo URL (per `threat-model.md` §6, §3 TB9) needs to follow each package to its new canonical home. Pin a hash from the npm tarball, not from a GitHub commit, until this stabilises.

**Total transitive surface (rough).** With all seven packages installed plus their transitive `@lezer/{common,lr,highlight}` + `@marijn/find-cluster-break` + `crelt` + `style-mod` + `w3c-keyname` + `@codemirror/{lang-html,autocomplete,lint}`, expect ~15-18 npm packages total. All authored by Marijn or directly maintained by the lezer-parser org. This concentration is itself a TB9 consideration — single point of trust, single audit target.

## 3. Optional: meta-package and React wrapper

Two packages exist as "ergonomic shortcuts" — neither is required, both pull in extra surface that Myne should evaluate against TB9 before committing.

### 3.1 `codemirror` (the meta package)

| Field | Value |
|---|---|
| Latest | 6.0.2 (2025-06-19, ~10 months old) |
| Unpacked | ~21 KB (it's a re-export shim) |
| Pulls in | `@codemirror/{state,view,commands,language,lang-html,autocomplete,lint,search}` |
| License | MIT |

**Recommendation:** **Skip it.** This package's only job is to bundle a "basic setup" so a getting-started example fits in five lines. It pulls in `@codemirror/lang-html` and `@codemirror/autocomplete` and `@codemirror/lint` whether you want them or not. Importing the individual `@codemirror/*` packages directly costs Myne ~15 LOC of `import` statements and saves ~3 transitive dependencies that the project doesn't need.

### 3.2 `@uiw/react-codemirror`

| Field | Value |
|---|---|
| Latest | 4.25.9 (2026-03-25) |
| Unpacked | ~794 KB |
| Pulls in | `codemirror`, `@codemirror/{state,commands,theme-one-dark}`, `@uiw/codemirror-extensions-basic-setup`, `@babel/runtime` |
| Peer deps | `react >=17.0.0`, `react-dom >=17.0.0` (open upper bound — works with React 19) |
| License | MIT |
| Maintainer | jaywcjlove / uiwjs (third-party, *not* Marijn) |

**Trade-off.** `@uiw/react-codemirror` saves ~30-50 LOC of React lifecycle wiring (mount/unmount EditorView, prop-change → dispatch, controlled-component mirror) and is widely used. But:

- It pulls in `@codemirror/theme-one-dark` and `@uiw/codemirror-extensions-basic-setup` — neither of which fits Myne's design system (`docs/design/colors_and_type.css` is the canonical theme; one-dark is wrong palette).
- It introduces a *second* maintainer (uiwjs) into the trust chain. TB9 surface widens.
- React 19 support is implicit (peer dep `react >=17.0.0` with no upper bound) but not stated explicitly in the README.

**Recommendation:** Write a ~30-LOC custom wrapper instead. Pattern is well-known:

```tsx
// Sketch only — not normative.
function CMEditor({ value, onChange, extensions }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current!,
    });
    viewRef.current = view;
    return () => view.destroy();
  }, []);
  // controlled-mirror effect omitted.
  return <div ref={hostRef} />;
}
```

This trade is ~30 LOC of code-we-own against ~6 transitive packages and a wrong-palette theme. Per `decisions.md` 2026-04-26 ("Phase 1 desktop UI: Vite + React + TypeScript"), the project has already chosen the smaller dependency surface in similar tradeoffs.

## 4. Markdown parser stack

`@codemirror/lang-markdown` is the integration layer. It composes:

- **`@lezer/markdown`** — the actual parser (incremental, CommonMark + extension points).
- **`@codemirror/language`** — language-support infrastructure for CM6.
- **`@codemirror/lang-html`** — required because Markdown can embed inline HTML, and the parser hands HTML regions to a sub-parser. *Cannot be removed.*
- **`@codemirror/autocomplete`** — used for HTML-tag completion inside Markdown's HTML blocks.

### 4.1 What `@codemirror/lang-markdown` exposes

Verbatim from the package source (paraphrasing only the namespace):

- `markdown(config?)` — the main extension. Config fields: `defaultCodeLanguage`, `codeLanguages`, `addKeymap` (default `true`), `extensions` (an array of `MarkdownExtension`s for parser customisation), `base` (defaults to `commonmarkLanguage`), `completeHTMLTags`, `htmlTagLanguage`.
- `markdownLanguage` — pre-bundled GFM + subscript + superscript + emoji.
- `commonmarkLanguage` — strict CommonMark.
- `insertNewlineContinueMarkup`, `deleteMarkupBackward` — Markdown-aware editing commands.
- `markdownKeymap` — default keybindings (already wired in if `addKeymap !== false`).
- `pasteURLAsLink` — convenience extension that auto-converts pasted URLs into `[text](url)`.

### 4.2 Choosing `commonmarkLanguage` vs `markdownLanguage`

GFM ships task-list syntax (`- [ ]`), tables, strikethrough (`~~`), autolinks. Phase 1 vision (`vision.md`) does not commit to GFM — it commits to "plain markdown after decryption." If Myne's wedge is portability-into-any-editor, GFM is the safer base because Obsidian, GitHub, VS Code, and most viewers render it.

**Open decision.** Pin `markdownLanguage` (GFM) or `commonmarkLanguage` (strict). Recommendation pending `decisions.md` entry; the strict CommonMark path means task lists become regular bullets on disk.

## 5. The Wikilink Extension — why we write it ourselves

**Searched the npm registry on 2026-04-29: no published package adds `[[wikilinks]]` parsing to `@codemirror/lang-markdown` / `@lezer/markdown`.** Every wikilink-tagged package targets a different ecosystem (remark/micromark/mdast, markdown-it, Joplin's CodeMirror 5, Docsify, etc.). The market gap is real; Myne authors its own.

### 5.1 The shape of a `MarkdownConfig` for wikilinks

`@lezer/markdown`'s extension API is the canonical hook. Per the official `src/extension.ts`, the shape Myne needs is:

```typescript
import type { MarkdownConfig } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";

export const Wikilink: MarkdownConfig = {
  defineNodes: [
    { name: "Wikilink", style: t.link },
    { name: "WikilinkMark", style: t.processingInstruction },
  ],
  parseInline: [{
    name: "Wikilink",
    parse(cx, next, pos) {
      // '[' = 91; require two consecutive '['s
      if (next !== 91 /* '[' */ || cx.char(pos + 1) !== 91) return -1;
      // scan forward for ']]', bail at end-of-line
      let end = pos + 2;
      while (end < cx.end) {
        const c = cx.char(end);
        if (c === 93 /* ']' */ && cx.char(end + 1) === 93) {
          // accept
          cx.addElement(cx.elt("Wikilink", pos, end + 2, [
            cx.elt("WikilinkMark", pos, pos + 2),
            cx.elt("WikilinkMark", end, end + 2),
          ]));
          return end + 2;
        }
        if (c === 10 /* '\n' */) return -1;
        end++;
      }
      return -1;
    },
    // outrank the regular [text](url) Link parser
    before: "Link",
  }],
};
```

This is sketch-quality, not normative. The concrete edge cases (alias divider `|` à la `[[Page|Display]]`, escape sequences inside `[[ ]]`, nested brackets, empty wikilink) get pinned in the eventual `spec/wikilink.md` once the syntax decision settles. See `remark-wiki-link` (§5.3) for a reference behavioural surface.

### 5.2 Wiring it into `@codemirror/lang-markdown`

```typescript
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "./wikilink-extension";

const extensions = [
  // ...
  markdown({ base: markdownLanguage, extensions: [Wikilink] }),
];
```

The custom node `Wikilink` then appears in `syntaxTree(state).iterate(...)` walks, and a separate `ViewPlugin` paints the visual decoration (next section).

### 5.3 Behavioural reference — `remark-wiki-link` (different stack, same concepts)

`remark-wiki-link` (npm: `remark-wiki-link`, MIT, 10.4k weekly downloads) is the most-downloaded wikilink package on npm but targets the remark/unified pipeline, not CM6. Its **option surface is reusable as a behavioural spec** even though the code is not transferable:

- `aliasDivider` — string separator for `[[Page|Display Text]]` (Obsidian uses `|`; remark-wiki-link defaults to `:`).
- `permalinks: string[]` — list of "existing" pages, used to mark wikilinks as `new` vs `existing`.
- `pageResolver(name) → string[]` — function that produces canonical permalinks from a wikilink target.
- `hrefTemplate(permalink) → string` — function that produces the click target.

Myne will likely adopt the Obsidian convention (`|` divider) and resolve permalinks against the in-memory note index, but those decisions are outside this doc.

## 6. Decoration / rendering — the "live preview" layer

CodeMirror 6 exposes four decoration kinds; the right choice for each visual is constrained.

| Decoration | Use it for | Provided from |
|---|---|---|
| `Decoration.mark` | Add CSS class to a range (style/hide syntax characters) | `ViewPlugin` (cheap) |
| `Decoration.widget` | Insert a DOM element at a position (inline or block) | `ViewPlugin` for inline; `StateField` for block widgets |
| `Decoration.replace` | Hide a range and substitute a widget | `StateField` if it changes vertical layout, otherwise `ViewPlugin` |
| `Decoration.line` | Per-line attributes on the wrapping `<div class="cm-line">` | `ViewPlugin` |

**Normative rule from CodeMirror docs:** *"Decorations that significantly change the vertical layout of the editor, for example by replacing line breaks or inserting block widgets, must be provided directly"* — i.e., from a `StateField`, not a `ViewPlugin`. See `codemirror.net/examples/decoration/` (linked in §10).

### 6.1 Reference implementation to study

**`segphault/codemirror-rich-markdoc`** — MIT, 104 stars, last pushed 2024-11-20. Solves the exact problem Myne faces (custom syntax → AST node → live decoration → block widget) for Markdoc tags. The full file `src/index.ts` is ~25 lines; `src/richEdit.ts` (the `Decoration.mark` walker) is ~50 lines. Translation to wikilinks: replace `parseBlock` with `parseInline`, change the trigger from `{` (123) to `[` (91), change node name from `MarkdocTag` to `Wikilink`, change CSS class from `cm-markdoc-tag` to `cm-myne-wikilink`.

**`nothingislost/obsidian-cm6-attributes`** — **no LICENSE file**; demonstrates the same `ViewPlugin + syntaxTree.iterate` pattern but for Obsidian-internal hashtag and link decorations. **Do not copy code from this repo without the author's permission**, but reading it as a pattern reference is fine.

### 6.2 Atomic ranges (load-bearing for wikilink chips)

`EditorView.atomicRanges.of(...)` registers a function that returns a `RangeSet<Decoration>` of "atom" ranges. The cursor jumps over these atomically; backspace deletes them in one step. This is exactly what we want for wikilink chips: pressing backspace inside `[[Note Title]]` should remove the entire chip, not chip away one character at a time.

Without atomic ranges, a wikilink chip widget that hides the surrounding `[[ ]]` becomes unselectable in confusing ways. Pin this as a hard requirement.

## 7. Sanitization — when we'd actually need it

CodeMirror's render path does **not** turn user text into HTML. Decorations are CSS classes; widgets are DOM nodes that *we* construct. The only XSS risk is if Myne, inside a `WidgetType.toDOM()`, writes a string into `innerHTML` that came from note content.

The two situations where this could happen:

1. **A wikilink target chip whose label is a note title.** The label *is* note content, attacker-controlled in principle (synced from another device). Render with `textContent`, not `innerHTML`. No sanitizer needed.
2. **A future block-level widget that renders an embedded HTML snippet** (math, table preview, etc.). If implemented, sanitize before injecting.

For scenario 2 only, pin **`dompurify`** v3.4.1 (MIT/Apache-2.0, Cure53, zero runtime deps). Verbatim purpose from the README: *"DOMPurify is a DOM-only, super-fast, uber-tolerant XSS sanitizer for HTML, MathML and SVG."*

Until block-level HTML widgets actually exist, **do not install DOMPurify**. The minimal-direct-surface principle applies (`threat-model.md` §7 Tauri supply-chain).

## 8. Tools deliberately *not* used

Recorded so future contributors don't re-evaluate them:

| Tool | Why not |
|---|---|
| **Lexical** (Meta) | Doc model is a node tree; `@lexical/markdown` is a translation layer. Contradicts `vision.md` "no proprietary format, no internal database that owns your content." Long-session memory characteristics flagged in Emergence Engineering benchmarks (2024). See `research-kendi-markdown-editoru.md` Çelişki 3. |
| **ProseMirror** | Same node-tree-vs-string concern as Lexical. Excellent toolkit, wrong abstraction layer for plain-markdown-on-disk. |
| **Slate**, **Tiptap**, **Draft.js** | Same category as Lexical/ProseMirror. |
| **Monaco Editor** | ~2 MB+ bundle, designed for IDE workloads, weak prose autocorrect, large multi-maintainer surface. Wrong instrument. |
| **MDXEditor** | Heavy abstraction, embeds Lexical, large transitive footprint. |
| **`@uiw/react-md-editor`** | Wraps a `<textarea>`-style minimal editor. Doesn't support live decoration, atomic-range chips, or inline wikilink rendering. Useful for "GitHub Issues clone", insufficient for vision.md. |
| **EditContext API** | Chrome 121+ only; Tauri uses WKWebView on macOS and WebKitGTK on Linux, neither of which support EditContext. Cross-platform Tauri build cannot rely on it. |
| **`pulldown-cmark` (Rust) for editor render** | Useful for *file-IO-only* parsing on the Rust side (e.g., when computing backlinks index). Unsuitable for the live editor render path because the editor needs same-thread incremental AST that `@lezer/markdown` provides on the JS side. May still be pinned later for a Rust-side parser; out of scope here. |

## 9. Open decision items (not resolved here)

These need explicit `decisions.md` entries before the editor PR lands:

1. **Strict CommonMark vs GFM.** §4.2.
2. **Custom React wrapper vs `@uiw/react-codemirror`.** §3.2.
3. **Wikilink syntax pin.** Alias divider (`|` à la Obsidian, `:` à la remark-wiki-link, or other), nesting rules, escape rules. Lives in a future `spec/wikilink.md` once decided.
4. **Theme integration.** `docs/design/colors_and_type.css` defines tokens in CSS variables; CodeMirror needs them mapped via `EditorView.theme(...)`. Whether this happens via a single Myne theme module or via separate light/dark theme objects is open.
5. **Search extension scope.** `@codemirror/search` provides Ctrl/Cmd-F search inside the editor. Vault-wide search is a different feature (full-text index across all decrypted notes). Decide whether the in-editor search is wired in Phase 1 or deferred.
6. **Whether to vendor the `@codemirror/*` source** for reproducible-build attestation, given the Forgejo migration. (TB9 / `threat-model.md` §6 implication.)

## 10. References

- CodeMirror System Guide — https://codemirror.net/docs/guide/
- CodeMirror Decoration Example — https://codemirror.net/examples/decoration/
- CodeMirror Reference Manual — https://codemirror.net/docs/ref/
- `@lezer/markdown` README — https://github.com/lezer-parser/markdown/blob/main/README.md (repo migrated to code.haverbeke.berlin/lezer/markdown, archived on GitHub 2026-04-16)
- `@lezer/markdown` extension source — https://github.com/lezer-parser/markdown/blob/main/src/extension.ts
- `segphault/codemirror-rich-markdoc` — https://github.com/segphault/codemirror-rich-markdoc *(MIT, the closest license-clean reference for "custom node + live decoration")*
- `nothingislost/obsidian-cm6-attributes` — https://github.com/nothingislost/obsidian-cm6-attributes *(no license — read only, do not copy)*
- DOMPurify — https://github.com/cure53/DOMPurify *(only if §7 scenario 2 materialises)*
- `remark-wiki-link` — https://github.com/landakram/remark-wiki-link *(behavioural reference, wrong stack)*
- Companion broader research — `research-kendi-markdown-editoru.md` (repo root)

---

## Maintenance

When package versions in §2 are pinned in `package.json`, update this file's "Latest" / "Last publish" columns in the same PR. When the wikilink syntax is pinned, move the normative parts of §5 into `spec/wikilink.md` and shrink §5 here to a pointer.
