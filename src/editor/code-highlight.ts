// Nested code-block syntax highlighting for the Myne editor (MYND-154 task 3).
//
// Two pieces:
//   1. `codeNestMarkdownExtension` — a custom `parseMixed` wrap mounted via
//      `markdown({ extensions: [...] })`. It nests a per-language Lezer parser
//      inside a FencedCode body. We do NOT use `@codemirror/lang-markdown`'s
//      stock `codeLanguages` option: its callback only sees the info-string,
//      never the node, so it cannot tell a CLOSED fence from an unclosed one.
//      Our wrap sees the node and returns `null` for an unclosed fence — so an
//      unclosed block mounts no nested parser and its coloring does NOT bleed
//      down the document (grill Q11). The language packs are eager-imported
//      (code-languages.ts), so a descriptor's `support` is always set and the
//      wrap nests synchronously — no async/skipping-parser path.
//   2. `codeSyntaxHighlighting` — one code-only `HighlightStyle`. It maps Lezer
//      code tags to the `--syntax-*` tokens (task 2). It deliberately OMITS
//      `processingInstruction` (markdown tags every syntax mark with it — grill
//      Q5 — so coloring it would repaint revealed markdown chrome) and
//      `monospace` (so untagged/unknown blocks stay plain). Markdown's
//      structural tags (heading/emphasis/strong/link/list/quote) are not code
//      tags, so the existing custom-decoration markdown chrome is untouched.

import { parseMixed, type SyntaxNodeRef, type Input } from "@lezer/common";
import type { MarkdownConfig } from "@lezer/markdown";
import {
  HighlightStyle,
  syntaxHighlighting,
  type LanguageDescription,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { type Extension } from "@codemirror/state";
import { resolveCodeLanguage } from "./code-languages";

/**
 * Decide whether a node should have a code language nested into it, and which.
 *
 * Pure + node-agnostic (takes primitives) so it is unit-testable without a
 * parser. Returns the language to nest, or `null` to skip nesting (→ no
 * coloring): for a non-fenced node, an UNCLOSED fence (< 2 `CodeMark`
 * children), or an untagged/unknown info-string.
 */
export function fencedCodeNestLanguage(
  nodeName: string,
  codeMarkCount: number,
  info: string,
): LanguageDescription | null {
  if (nodeName !== "FencedCode") return null;
  // A closed fence has two CodeMark children (open + close); an unclosed one
  // has only the opener and extends to EOF. Gate coloring on closed (Q11).
  if (codeMarkCount < 2) return null;
  return resolveCodeLanguage(info);
}

function readInfo(node: SyntaxNodeRef, input: Input): string {
  const infoNode = node.node.getChild("CodeInfo");
  return infoNode ? input.read(infoNode.from, infoNode.to) : "";
}

/** MarkdownConfig adding the nested-code parser wrap. Add to `markdown({ extensions })`. */
export const codeNestMarkdownExtension: MarkdownConfig = {
  wrap: parseMixed((node, input) => {
    const lang = fencedCodeNestLanguage(
      node.type.name,
      node.node.getChildren("CodeMark").length,
      readInfo(node, input),
    );
    // `support` is eager (code-languages.ts) so it is always set; the guard
    // satisfies the type and simply skips nesting in the impossible-null case.
    if (!lang?.support) return null;
    return {
      parser: lang.support.language.parser,
      overlay: (n) => n.type.name === "CodeText",
    };
  }),
};

// Code-only highlight style. Tag groups map to the `--syntax-*` palette (task 2).
// processingInstruction + monospace are intentionally absent (see header).
// Exported so the read-only code-in-blockquote widget (fenced-code.ts) can
// re-highlight its (block-replaced, no-longer-live) code with the SAME classes —
// the injected stylesheet from `codeSyntaxHighlighting` colors them identically.
export const codeHighlightStyle = HighlightStyle.define([
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.operatorKeyword,
      t.moduleKeyword,
      t.definitionKeyword,
      t.modifier,
      t.self,
    ],
    color: "var(--syntax-keyword)",
  },
  {
    tag: [t.string, t.special(t.string), t.regexp, t.escape, t.character],
    color: "var(--syntax-string)",
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: "var(--syntax-comment)",
  },
  {
    tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom],
    color: "var(--syntax-number)",
  },
  {
    tag: [t.variableName, t.local(t.variableName), t.special(t.variableName)],
    color: "var(--syntax-variable)",
  },
  {
    tag: [t.propertyName, t.attributeValue, t.labelName],
    color: "var(--syntax-property)",
  },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.function(t.variableName)),
      t.macroName,
    ],
    color: "var(--syntax-function)",
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)],
    color: "var(--syntax-type)",
  },
  {
    tag: [
      t.operator,
      t.typeOperator,
      t.derefOperator,
      t.arithmeticOperator,
      t.logicOperator,
      t.bitwiseOperator,
      t.compareOperator,
      t.updateOperator,
      t.definitionOperator,
      t.punctuation,
      t.separator,
      t.bracket,
      t.paren,
      t.brace,
      t.squareBracket,
    ],
    color: "var(--syntax-operator)",
  },
  {
    tag: [t.tagName, t.attributeName, t.angleBracket],
    color: "var(--syntax-tag)",
  },
  {
    // NOTE: deliberately NOT processingInstruction (grill Q5) — markdown tags
    // its syntax marks with it; coloring it would repaint revealed markdown.
    tag: [t.meta, t.annotation, t.documentMeta],
    color: "var(--syntax-meta)",
  },
  { tag: [t.invalid], color: "var(--syntax-invalid)" },
]);

/** `syntaxHighlighting` extension for code blocks. Add to the editor extension array. */
export const codeSyntaxHighlighting: Extension = syntaxHighlighting(codeHighlightStyle);
