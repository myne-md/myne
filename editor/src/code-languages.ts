// Curated CodeMirror language registry for fenced code-block syntax highlighting
// (MYND-154, feature editor-mvp-codeblocks).
//
// Hand-curated, NOT `@codemirror/language-data` — per TB9 (minimal dependency
// tree, `agent-tooling/docs/threat-model.md`) the language-data registry would drag ~21
// unused lang packs into the lockfile. We pin only the eight packs the ten
// baseline languages need, all under the codemirror / lezer-parser
// concentrated-trust org.
//
// EAGER (static) imports: the language packs are statically imported and each
// `LanguageSupport` is constructed once at module load, so a descriptor's
// `support` is set immediately and the parseMixed wrap (code-highlight.ts)
// nests + colors synchronously on the first parse. This supersedes the original
// lazy `import()` plan (grill Q8): in the running Tauri WebView the async
// load + post-load reparse did not reliably apply coloring on note open, and
// for a local-disk desktop app the bundle/parse cost of eager packs is
// acceptable (3 of these — js/html/css — are already eager via
// `@codemirror/lang-markdown`'s static dependency on `lang-html`).
//
// `resolveCodeLanguage` is the hand-authored alias/case table — an unknown or
// misspelled tag resolves to `null` (no fallback guess).

import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { yaml } from "@codemirror/lang-yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { diff } from "@codemirror/legacy-modes/mode/diff";

// TS/JSX/TSX all route through `@codemirror/lang-javascript`; bash + diff have
// no first-class Lezer pack and come from `@codemirror/legacy-modes` CM5
// stream-modes (coarser tokens — accepted, see decisions.md).
export const CODE_LANGUAGES: readonly LanguageDescription[] = [
  LanguageDescription.of({
    name: "javascript",
    alias: ["js", "node", "mjs", "cjs"],
    support: javascript(),
  }),
  LanguageDescription.of({
    name: "jsx",
    alias: [],
    support: javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: "typescript",
    alias: ["ts"],
    support: javascript({ typescript: true }),
  }),
  LanguageDescription.of({
    name: "tsx",
    alias: [],
    support: javascript({ typescript: true, jsx: true }),
  }),
  LanguageDescription.of({ name: "python", alias: ["py", "py3", "python3"], support: python() }),
  LanguageDescription.of({ name: "rust", alias: ["rs"], support: rust() }),
  LanguageDescription.of({ name: "json", alias: [], support: json() }),
  LanguageDescription.of({ name: "html", alias: ["htm", "xhtml"], support: html() }),
  LanguageDescription.of({ name: "css", alias: [], support: css() }),
  LanguageDescription.of({ name: "yaml", alias: ["yml"], support: yaml() }),
  LanguageDescription.of({
    name: "bash",
    alias: ["sh", "shell", "zsh", "shellscript", "console"],
    support: new LanguageSupport(StreamLanguage.define(shell)),
  }),
  LanguageDescription.of({
    name: "diff",
    alias: ["patch"],
    support: new LanguageSupport(StreamLanguage.define(diff)),
  }),
];

// Lowercased name + alias → descriptor. Single source of truth: the `name`/
// `alias` fields above. Built once at module load.
const BY_NAME: ReadonlyMap<string, LanguageDescription> = (() => {
  const map = new Map<string, LanguageDescription>();
  for (const lang of CODE_LANGUAGES) {
    map.set(lang.name.toLowerCase(), lang);
    for (const a of lang.alias) map.set(a.toLowerCase(), lang);
  }
  return map;
})();

/**
 * Resolve a fenced block's info-string to a curated language descriptor.
 *
 * Case-insensitive, matches the first whitespace-delimited token (CommonMark
 * allows trailing words after the language tag). Returns `null` for an empty,
 * unknown, or misspelled tag — no fuzzy guessing, so an untagged or unknown
 * block stays monochrome monospace (ticket acceptance + grill Q9).
 */
export function resolveCodeLanguage(info: string): LanguageDescription | null {
  const token = info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (token === "") return null;
  return BY_NAME.get(token) ?? null;
}
