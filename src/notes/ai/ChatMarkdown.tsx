// Markdown in the AI transcript (myne-md/myne#771).
//
// A model's answer is written in markdown, always — it is what every model
// emits and what the agent's own edit format is made of — and the transcript
// rendered it as `white-space: pre-wrap` plain text. So a reader saw
// `**Development workflow orchestration**` with the asterisks, `` `tf:drive` ``
// with the backticks, and a numbered list as one run-on paragraph. On the one
// surface whose honesty note asks the user to READ the answer carefully.
//
// ── Why this is not the editor's renderer ──────────────────────────────────
// The editor is CodeMirror, which is a document: a whole editing surface, its
// decorations, its extensions and its state. A chat bubble is a paragraph of
// read-only text, and mounting an editor per turn in a 280px panel would be
// orders of magnitude more machinery than the job needs — and would give the
// model's output the affordances of a document the user owns, which is exactly
// the wrong invitation.
//
// ── Why it cannot be `dangerouslySetInnerHTML` ─────────────────────────────
// The text is MODEL OUTPUT quoting NOTE CONTENT: two untrusted sources in one
// string, on a surface `threat-model.md` §7 treats as prompt-injection
// reachable. `@myne/dialect/miniMarkdown` is a token parser with no HTML
// passthrough, and this renders its tokens as React elements — so there is no
// path from a model's reply to markup in the DOM, by construction rather than
// by sanitisation.
//
// ── The subset, and what falls through ─────────────────────────────────────
// Bold, italic, inline code, links, headings, quotes, lists, code blocks and
// rules. Wikilinks and attachment embeds are parsed by the shared parser and
// rendered here as their plain LABEL: a model quoting `[[some note]]` is
// quoting, not linking, and a chat bubble that navigated the workspace on a
// click would be a model moving the user around their vault.

import type { CSSProperties, ReactNode } from "react";
import {
  parseBlocks,
  type Block,
  type Inline,
} from "@myne/dialect/miniMarkdown";

const CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.92em",
  background: "var(--bg-3)",
  borderRadius: "var(--radius-1)",
  padding: "0 var(--space-1)",
};

const BLOCK_CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.92em",
  background: "var(--bg-3)",
  borderRadius: "var(--radius-1)",
  padding: "var(--space-1) var(--space-2)",
  margin: "var(--space-1) 0",
  // A model answering about code emits long lines, and a 280px panel is the
  // narrowest surface in the app: wrapping is the only option that does not put
  // a horizontal scrollbar inside a chat bubble.
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const QUOTE_STYLE: CSSProperties = {
  borderInlineStart: "2px solid var(--line-2)",
  paddingInlineStart: "var(--space-2)",
  margin: "var(--space-1) 0",
  color: "var(--fg-2)",
};

const LIST_STYLE: CSSProperties = {
  margin: "var(--space-1) 0",
  paddingInlineStart: "var(--space-4)",
};

/** A block's own bottom margin. The first block has none, so a bubble's text
 *  starts flush with its caption rather than a gap below it. */
const blockMargin = (first: boolean): CSSProperties =>
  first ? { marginBlockStart: 0 } : {};

function renderInline(tokens: readonly Inline[]): ReactNode {
  return tokens.map((tok, i) => {
    switch (tok.kind) {
      case "bold":
        return <strong key={i}>{tok.text}</strong>;
      case "italic":
        return <em key={i}>{tok.text}</em>;
      case "code":
        return (
          <code key={i} style={CODE_STYLE}>
            {tok.text}
          </code>
        );
      case "link":
        // `rel` and `target` are not set, and no href is followed: the string
        // is model output, so a clickable link here is a model choosing where
        // the user's browser goes. The URL is shown as the text it was written
        // as, which is the honest rendering of a link nobody should follow on
        // this surface's say-so.
        return (
          <span key={i} style={{ textDecoration: "underline" }}>
            {tok.text}
          </span>
        );
      case "wikilink":
        return <span key={i}>{tok.label}</span>;
      case "attachment":
        return <span key={i}>{tok.label}</span>;
      default:
        return <span key={i}>{tok.text}</span>;
    }
  });
}

function renderBlock(block: Block, i: number): ReactNode {
  const first = i === 0;
  switch (block.kind) {
    case "heading": {
      // A heading inside a chat bubble is not a document heading: it must not
      // join the page's outline, where it would appear between the panel's own
      // landmarks as a section a model invented. Rendered as bold text at the
      // bubble's own size, which is what it means here.
      return (
        <p
          key={i}
          style={{
            ...blockMargin(first),
            marginBlockEnd: "var(--space-1)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          {renderInline(block.content)}
        </p>
      );
    }
    case "paragraph":
      return (
        <p key={i} style={{ ...blockMargin(first), marginBlockEnd: "var(--space-1)" }}>
          {renderInline(block.content)}
        </p>
      );
    case "code":
      return (
        <pre key={i} style={{ ...BLOCK_CODE_STYLE, ...blockMargin(first) }}>
          {block.text}
        </pre>
      );
    case "quote":
      return (
        <blockquote key={i} style={{ ...QUOTE_STYLE, ...blockMargin(first) }}>
          {renderInline(block.content)}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>);
      return block.ordered ? (
        <ol key={i} style={{ ...LIST_STYLE, ...blockMargin(first) }}>
          {items}
        </ol>
      ) : (
        <ul key={i} style={{ ...LIST_STYLE, ...blockMargin(first) }}>
          {items}
        </ul>
      );
    }
    case "hr":
      return (
        <hr
          key={i}
          style={{
            ...blockMargin(first),
            border: 0,
            borderTop: "1px solid var(--line-1)",
            margin: "var(--space-2) 0",
          }}
        />
      );
    default:
      return null;
  }
}

/**
 * Render one turn's text.
 *
 * `testId` is passed through so the surface's existing scenarios keep reaching
 * the same node: what changed is what is INSIDE it, not where it is.
 */
export function ChatMarkdown({
  text,
  style,
  testId,
}: {
  text: string;
  style?: CSSProperties;
  testId?: string;
}) {
  const blocks = parseBlocks(text);
  return (
    <div style={style} data-testid={testId}>
      {blocks.map(renderBlock)}
    </div>
  );
}
