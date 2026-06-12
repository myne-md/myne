// Callout type table for the HTML projection emitter (MYND-255).
//
// Mirrors the editor's `src/editor/decorations/callout.ts` CALLOUT_TYPES map
// (which is module-private there — duplicated here rather than editing the
// shared editor file; keep the two in lockstep). The emitter projects a
// `> [!TYPE]` blockquote to a typed container div carrying CLASS NAMES only —
// colors/icons come from the print stylesheet (task 3), never inline styles.

/** Semantic tone a callout type maps to (the print CSS color hook). */
export type CalloutTone = "info" | "success" | "warning" | "danger" | "accent";

export interface CalloutHtmlType {
  readonly tone: CalloutTone;
  readonly label: string;
}

/** Obsidian-full type set (case-insensitive) → tone + default title. */
export const CALLOUT_HTML_TYPES: Readonly<Record<string, CalloutHtmlType>> = {
  note: { tone: "accent", label: "Note" },
  info: { tone: "info", label: "Info" },
  todo: { tone: "info", label: "Todo" },
  tip: { tone: "success", label: "Tip" },
  hint: { tone: "success", label: "Hint" },
  important: { tone: "success", label: "Important" },
  success: { tone: "success", label: "Success" },
  check: { tone: "success", label: "Success" },
  done: { tone: "success", label: "Done" },
  question: { tone: "warning", label: "Question" },
  faq: { tone: "warning", label: "FAQ" },
  warning: { tone: "warning", label: "Warning" },
  caution: { tone: "warning", label: "Caution" },
  attention: { tone: "warning", label: "Attention" },
  failure: { tone: "danger", label: "Failure" },
  fail: { tone: "danger", label: "Failure" },
  missing: { tone: "danger", label: "Missing" },
  danger: { tone: "danger", label: "Danger" },
  error: { tone: "danger", label: "Error" },
  bug: { tone: "danger", label: "Bug" },
  example: { tone: "accent", label: "Example" },
  quote: { tone: "accent", label: "Quote" },
  cite: { tone: "accent", label: "Quote" },
};

/** Callout header on a blockquote's first source line (after the leading `>`
 *  markers): `[!type]`, optional fold `+`/`-`, optional custom title. Same
 *  pattern as the editor decoration. */
export const CALLOUT_HEADER_RE = /^(\s*>\s*)\[!(\w+)\]([+-]?)\s*(.*)$/;
