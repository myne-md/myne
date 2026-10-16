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
// rules. Attachment embeds are parsed by the shared parser and rendered here as
// their plain LABEL.
//
// **Wikilinks are too, with one exception, and this header stated the rule
// absolutely until myne-md/myne#867.** A model quoting `[[some note]]` is
// quoting rather than linking, and a chat bubble that navigated the workspace on
// any click would be a model moving the user around their vault. What changed is
// that a wikilink which RESOLVES to a note the vault holds is now the same press
// as the note's name in prose: the model named that note, the vault has it, and
// the click opens it in a tab and does nothing else. The rule the reader should
// carry is therefore "a link only where the vault holds the target", not "no
// links at all": a wikilink to something the vault does not hold, a folder
// target and an alias all stay the plain label they were. The bound, and why the
// candidate set is the vault's rather than the run's, is `decisions/ai/0690`.

import type { CSSProperties, ReactNode } from "react";
import {
  parseBlocks,
  type Block,
  type Inline,
} from "@myne/dialect/miniMarkdown";
import {
  linkifyMentions,
  type MentionTarget,
} from "./noteMentions";

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

/** A note mention: a text link, never a chip. It sits inside a sentence, and
 *  anything that changes the line's rhythm mid-paragraph reads as a widget
 *  dropped into prose. The accent plus an underline is the app's existing link
 *  treatment, and a `<button>` rather than an `<a>` because there is no href to
 *  announce: the press calls the surface, which opens the note. */
const MENTION_STYLE: CSSProperties = {
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  color: "var(--accent)",
  textDecoration: "underline",
  cursor: "pointer",
};

/** The props every text-carrying arm of {@link renderInline} needs. Bundled
 *  rather than threaded as three more positional parameters, which is how the
 *  recursion below stops being readable. */
interface MentionContext {
  targets: readonly MentionTarget[] | undefined;
  onOpenNote: ((noteUuid: string) => void) | undefined;
}

/** A run of text, with any note mention in it rendered as a link.
 *
 *  Returns the string unchanged when there is nothing to link, so the common
 *  case produces no extra elements. */
function renderText(text: string, keyBase: string, ctx: MentionContext): ReactNode {
  if (ctx.targets === undefined || ctx.onOpenNote === undefined) return text;
  const segments = linkifyMentions(text, ctx.targets);
  if (segments.every((seg) => seg.noteUuid === undefined)) return text;
  return segments.map((seg, j) => {
    const noteUuid = seg.noteUuid;
    return noteUuid === undefined ? (
      <span key={`${keyBase}-${j}`}>{seg.text}</span>
    ) : (
      <button
        key={`${keyBase}-${j}`}
        type="button"
        className="myne-text-link"
        data-testid="ai.mention-link"
        style={MENTION_STYLE}
        onClick={() => ctx.onOpenNote?.(noteUuid)}
      >
        {seg.text}
      </button>
    );
  });
}

/** The note a `[[wikilink]]` target names, or `undefined`.
 *
 *  Through the same matcher as the prose, so a token that names a note and a
 *  sentence that names one cannot disagree about which strings count. The
 *  token must be the WHOLE target: `linkifyMentions` returns more than one
 *  segment when the target is only partly a note, and a partly-matching link
 *  target is the near-miss this whole module refuses. */
function wikilinkNote(
  target: string,
  ctx: MentionContext,
): string | undefined {
  if (ctx.targets === undefined) return undefined;
  const segments = linkifyMentions(target, ctx.targets);
  if (segments.length !== 1) return undefined;
  return segments[0].noteUuid;
}

/** A block's own bottom margin. The first block has none, so a bubble's text
 *  starts flush with its caption rather than a gap below it. */
const blockMargin = (first: boolean): CSSProperties =>
  first ? { marginBlockStart: 0 } : {};

function renderInline(tokens: readonly Inline[], ctx: MentionContext): ReactNode {
  return tokens.map((tok, i) => {
    switch (tok.kind) {
      case "bold":
        return <strong key={i}>{renderText(tok.text, `b-${i}`, ctx)}</strong>;
      case "italic":
        return <em key={i}>{renderText(tok.text, `i-${i}`, ctx)}</em>;
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
      case "wikilink": {
        // The note the TARGET names, when the link shows that same name. A chat
        // bubble used to render every wikilink as plain text, on
        // the reasoning that a model quoting `[[x]]` is quoting rather than
        // linking; myne-md/myne#867 supersedes that for a target the vault
        // actually holds, and leaves it standing for one it does not.
        //
        // **An aliased wikilink stays plain text** (myne-md/myne#867 review,
        // D3). `[[Private/Bank|Summary of your trip]]` would otherwise show one
        // name and open another, and on a surface prompt injection can reach,
        // a link whose visible text and destination disagree is exactly the
        // exposure decision 0690 rules out. A link here names, in its own text,
        // the note it opens; `noteMentions.ts`'s header states the same bound.
        const aliased = tok.label !== tok.target;
        const uuid = aliased ? undefined : wikilinkNote(tok.target, ctx);
        if (uuid === undefined || ctx.onOpenNote === undefined) {
          return <span key={i}>{tok.label}</span>;
        }
        return (
          <button
            key={i}
            type="button"
            className="myne-text-link"
            data-testid="ai.mention-link"
            style={MENTION_STYLE}
            onClick={() => ctx.onOpenNote?.(uuid)}
          >
            {tok.label}
          </button>
        );
      }
      case "attachment":
        return <span key={i}>{tok.label}</span>;
      default:
        return <span key={i}>{renderText(tok.text, `t-${i}`, ctx)}</span>;
    }
  });
}

function renderBlock(block: Block, i: number, ctx: MentionContext): ReactNode {
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
          {renderInline(block.content, ctx)}
        </p>
      );
    }
    case "paragraph":
      return (
        <p key={i} style={{ ...blockMargin(first), marginBlockEnd: "var(--space-1)" }}>
          {renderInline(block.content, ctx)}
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
          {renderInline(block.content, ctx)}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, j) => <li key={j}>{renderInline(item, ctx)}</li>);
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
  mentionTargets,
  onOpenNote,
}: {
  text: string;
  style?: CSSProperties;
  testId?: string;
  /**
   * Strings that name a note, from `buildMentionTargets`. Absent means the
   * pre-change rendering: every name stays plain text, which is what a caller
   * with no note-set (a test, a surface with no vault index) gets.
   */
  mentionTargets?: readonly MentionTarget[];
  /** Called with the note's id when a mention is pressed. This component
   *  performs no navigation and no host call of its own: the surface owns where
   *  a click lands, and with no callback the link is not rendered at all. */
  onOpenNote?: (noteUuid: string) => void;
}) {
  const blocks = parseBlocks(text);
  const ctx: MentionContext = { targets: mentionTargets, onOpenNote };
  return (
    <div style={style} data-testid={testId}>
      {blocks.map((block, i) => renderBlock(block, i, ctx))}
    </div>
  );
}
