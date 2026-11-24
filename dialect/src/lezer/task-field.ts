// Inline task-field recognizer for the Myne markdown dialect (MYND-611).
//
// Spec: docs/spec/markdown-dialect.md — the inline task-field grammar (normative
// text lands with task 5 of this feature).
//
// Two recognized forms, one node shape. Myne READS three dialects and WRITES one
// (PRD "Three dialects in, one out"); this file is the read side, and it types
// nothing — a `TaskField` here is "something shaped like a field", not "a due date".
// Value typing is task 2, emission is task 3.
//
//   - Dataview-style bracketed  `[due:: 2026-08-01]`
//   - Obsidian emoji            `📅 2026-08-01`
//
// Both emit:  TaskField[ TaskFieldMark, TaskFieldKey, TaskFieldMark?, TaskFieldValue?, TaskFieldMark? ]
// so a single consumer walks one node shape regardless of which dialect the file
// happens to use.
//
// PRECEDENCE. The bracketed form collides with CommonMark link syntax, so it is
// registered `before: "Link"` — the same slot, and for the same reason, as
// `footnote.ts` (`[^id]`) and `wikilink.ts`. Without it, `[due:: 2026-08-01]`
// is claimed as a link label first and the field never forms.
//
// EXCLUSION ZONES are structural, not a second tokenizer pass: once a code span,
// fenced block, wikilink interior, HTML block, or frontmatter node consumes a
// range, `parseInline` is never invoked inside it (the `inline-tag.ts` precedent).
//
// Recognizer-only: emits nodes, never mutates source bytes (§6 C1).

import type { InlineContext, MarkdownConfig } from "@lezer/markdown";

const CHAR_LBRACKET = 91; // [
const CHAR_RBRACKET = 93; // ]
const CHAR_COLON = 58; // :
const CHAR_HASH = 35; // #
const CHAR_NEWLINE = 10;
const CHAR_SPACE = 32;
const CHAR_TAB = 9;
const CHAR_VARIATION_SELECTOR_16 = 0xfe0f;

/**
 * Obsidian Tasks emoji markers that carry a value after them (a date, or a
 * recurrence expression). Myne supports a subset of these as typed fields; the
 * rest are recognized here so task 2 can preserve them as raw text rather than
 * having them silently vanish from an imported vault.
 */
const VALUED_EMOJI_MARKERS: ReadonlySet<string> = new Set([
  "📅", // due
  "⏳", // scheduled   (unsupported-but-preserved)
  "🛫", // start       (unsupported-but-preserved)
  "✅", // done
  "❌", // cancelled   (unsupported-but-preserved)
  "➕", // created     (unsupported-but-preserved)
  "🔁", // repeat
  "⏰", // remind
  "🆔", // id          (unsupported-but-preserved)
  "⛔", // dependsOn   (unsupported-but-preserved)
]);

/** Priority markers stand alone — the emoji *is* the value. */
const BARE_EMOJI_MARKERS: ReadonlySet<string> = new Set([
  "🔺", // highest
  "⏫", // high
  "🔼", // medium
  "🔽", // low
  "⏬", // lowest
]);

/** A key is a run of letters, digits, `-` or `_`. Deliberately narrower than
 *  Dataview (which tolerates spaces in keys): a permissive key rule makes every
 *  `[` in ordinary prose a parse candidate, and the five written keys plus
 *  Obsidian's read-only set are all single words. */
function isKeyChar(c: number): boolean {
  if (c >= 0x61 && c <= 0x7a) return true; // a-z
  if (c >= 0x41 && c <= 0x5a) return true; // A-Z
  if (c >= 0x30 && c <= 0x39) return true; // 0-9
  if (c === 0x2d || c === 0x5f) return true; // - _
  return false;
}

function isSpaceOrTab(c: number): boolean {
  return c === CHAR_SPACE || c === CHAR_TAB;
}

/**
 * If an emoji task marker starts at `pos`, return the offset just past it
 * (including a trailing variation selector); otherwise -1. Markers are up to two
 * UTF-16 code units, so the two-unit form is tried first — `🔽` (a surrogate
 * pair) must not be mistaken for a one-unit marker via its lead surrogate.
 */
function matchEmojiMarker(cx: InlineContext, pos: number): number {
  for (const units of [2, 1]) {
    if (pos + units > cx.end) continue;
    const candidate = cx.slice(pos, pos + units);
    if (VALUED_EMOJI_MARKERS.has(candidate) || BARE_EMOJI_MARKERS.has(candidate)) {
      let end = pos + units;
      if (end < cx.end && cx.char(end) === CHAR_VARIATION_SELECTOR_16) end++;
      return end;
    }
  }
  return -1;
}

function isBareMarker(cx: InlineContext, from: number, to: number): boolean {
  let text = cx.slice(from, to);
  if (text.endsWith("️")) text = text.slice(0, -1);
  return BARE_EMOJI_MARKERS.has(text);
}

/**
 * End of an emoji field's value, scanning from `pos`. The value runs to the end
 * of the line, except that it stops at the next emoji marker (so consecutive
 * markers split into separate fields) and at a `#tag` (so a trailing tag stays a
 * tag rather than being swallowed into a recurrence expression — `#chores` after
 * a due date is ordinary in an imported vault).
 */
function emojiValueEnd(cx: InlineContext, pos: number): number {
  let scan = pos;
  let lastNonSpace = pos;
  while (scan < cx.end) {
    const c = cx.char(scan);
    if (c === CHAR_NEWLINE) break;
    if (matchEmojiMarker(cx, scan) >= 0) break;
    // A `[` starts the bracketed form — the two dialects appear on one line in
    // a half-migrated vault, and the emoji value must not swallow the bracket.
    if (c === CHAR_LBRACKET) break;
    // A `#` only ends the value when it starts a token — `every 2 weeks` has no
    // `#`, but `2026-08-01 #chores` does, and a mid-word `#` is not a tag.
    if (c === CHAR_HASH && (scan === pos || isSpaceOrTab(cx.char(scan - 1)))) break;
    scan++;
    if (!isSpaceOrTab(c)) lastNonSpace = scan;
  }
  return lastNonSpace;
}

export const TaskField: MarkdownConfig = {
  defineNodes: ["TaskField", "TaskFieldMark", "TaskFieldKey", "TaskFieldValue"],
  parseInline: [
    {
      // `[key:: value]` — outranks Link, per the footnote/wikilink precedent.
      name: "TaskField",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== CHAR_LBRACKET) return -1;

        const keyStart = pos + 1;
        let scan = keyStart;
        while (scan < cx.end && isKeyChar(cx.char(scan))) scan++;
        if (scan === keyStart) return -1; // empty key: `[:: v]`
        const keyEnd = scan;

        if (scan + 1 >= cx.end) return -1;
        if (cx.char(scan) !== CHAR_COLON || cx.char(scan + 1) !== CHAR_COLON) return -1;
        const sepEnd = scan + 2;

        let valueStart = sepEnd;
        while (valueStart < cx.end && isSpaceOrTab(cx.char(valueStart))) valueStart++;

        let valueEnd = valueStart;
        let closeAt = -1;
        for (let i = valueStart; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === CHAR_NEWLINE) break; // a field does not span lines
          if (c === CHAR_RBRACKET) {
            closeAt = i;
            break;
          }
          if (!isSpaceOrTab(c)) valueEnd = i + 1;
        }
        if (closeAt < 0) return -1; // unterminated

        const children = [
          cx.elt("TaskFieldMark", pos, keyStart), // `[`
          cx.elt("TaskFieldKey", keyStart, keyEnd),
          cx.elt("TaskFieldMark", keyEnd, sepEnd), // `::`
        ];
        if (valueEnd > valueStart) {
          children.push(cx.elt("TaskFieldValue", valueStart, valueEnd));
        }
        children.push(cx.elt("TaskFieldMark", closeAt, closeAt + 1)); // `]`

        return cx.addElement(cx.elt("TaskField", pos, closeAt + 1, children));
      },
    },
    {
      // `📅 2026-08-01` / `⏫` — the Obsidian emoji dialect, same pass, same node shape.
      name: "TaskFieldEmoji",
      before: "Link",
      parse(cx, _next, pos) {
        const markerEnd = matchEmojiMarker(cx, pos);
        if (markerEnd < 0) return -1;

        const children = [cx.elt("TaskFieldKey", pos, markerEnd)];

        if (isBareMarker(cx, pos, markerEnd)) {
          // A priority marker is the whole field: no value node.
          return cx.addElement(cx.elt("TaskField", pos, markerEnd, children));
        }

        let valueStart = markerEnd;
        while (valueStart < cx.end && isSpaceOrTab(cx.char(valueStart))) valueStart++;
        const valueEnd = emojiValueEnd(cx, valueStart);

        if (valueEnd <= valueStart) {
          // A valued marker with nothing after it still forms a field, so the
          // marker is not left as loose text for another rule to claim.
          return cx.addElement(cx.elt("TaskField", pos, markerEnd, children));
        }

        children.push(cx.elt("TaskFieldValue", valueStart, valueEnd));
        return cx.addElement(cx.elt("TaskField", pos, valueEnd, children));
      },
    },
  ],
};
