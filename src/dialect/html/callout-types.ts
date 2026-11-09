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
  /** i18n key for the default title — REUSES the editor's keys
   *  (`editor.callout.label.*`) so editor + HTML projection stay in lockstep
   *  and a single translation drives both. Resolved at emit time via i18n.t. */
  readonly labelKey: string;
}

/** Obsidian-full type set (case-insensitive) → tone + default-title i18n key. */
export const CALLOUT_HTML_TYPES: Readonly<Record<string, CalloutHtmlType>> = {
  note: { tone: "accent", labelKey: "editor.callout.label.note" },
  info: { tone: "info", labelKey: "editor.callout.label.info" },
  todo: { tone: "info", labelKey: "editor.callout.label.todo" },
  tip: { tone: "success", labelKey: "editor.callout.label.tip" },
  hint: { tone: "success", labelKey: "editor.callout.label.hint" },
  important: { tone: "success", labelKey: "editor.callout.label.important" },
  success: { tone: "success", labelKey: "editor.callout.label.success" },
  check: { tone: "success", labelKey: "editor.callout.label.success" },
  done: { tone: "success", labelKey: "common.done" },
  question: { tone: "warning", labelKey: "editor.callout.label.question" },
  faq: { tone: "warning", labelKey: "editor.callout.label.faq" },
  warning: { tone: "warning", labelKey: "editor.callout.label.warning" },
  caution: { tone: "warning", labelKey: "editor.callout.label.caution" },
  attention: { tone: "warning", labelKey: "editor.callout.label.attention" },
  failure: { tone: "danger", labelKey: "editor.callout.label.failure" },
  fail: { tone: "danger", labelKey: "editor.callout.label.failure" },
  missing: { tone: "danger", labelKey: "editor.callout.label.missing" },
  danger: { tone: "danger", labelKey: "editor.callout.label.danger" },
  error: { tone: "danger", labelKey: "editor.callout.label.error" },
  bug: { tone: "danger", labelKey: "editor.callout.label.bug" },
  example: { tone: "accent", labelKey: "editor.callout.label.example" },
  quote: { tone: "accent", labelKey: "editor.callout.label.quote" },
  cite: { tone: "accent", labelKey: "editor.callout.label.quote" },
};

/** Callout header on a blockquote's first source line (after the leading `>`
 *  markers): `[!type]`, optional fold `+`/`-`, optional custom title. Same
 *  pattern as the editor decoration. */
export const CALLOUT_HEADER_RE = /^(\s*>\s*)\[!(\w+)\]([+-]?)\s*(.*)$/;
