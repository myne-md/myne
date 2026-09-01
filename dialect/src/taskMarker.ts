// The GFM task-marker shape, stated once (myne-md/myne#593).
//
// # Why this file exists
//
// `@lezer/markdown`'s GFM `TaskList` leaf tests `/^\[[ xX]\][ \t]/` against the
// text after a list marker. The SEPARATOR is not decoration: without it the
// parser does not see a task at all, so `- [ ]foo` is an ordinary bullet whose
// text happens to start with `[ ]`.
//
// That shape had been restated in five places, in four different forms, and two
// of them left the separator out. The cost is not theoretical. `list.ts`'s copy
// was the lax one, so `- [ ]foo` was rendered with a task checkbox the parser
// did not agree existed, and the Enter fix in `list-continuation.ts` exists
// because a split that ate the separator turned a task back into raw markup
// while every writer still thought it was a task. Two more copies were lax in
// the same way: `taskFieldWriter.ts`'s `isTaskLine` and `taskWriteCore.ts`'s
// `flipMarker` both accepted `- [ ]foo`, so a field written to it, or a
// checkbox flipped on it, landed on a line no reader parses as a task. Both are
// rebuilt from the shape below in the change that adds this file, so the count
// of lax copies is now zero rather than two.
//
// Nothing catches a sixth copy: every one of them compiles, and a divergence
// shows up as a checkbox that renders and does nothing, or a field written into
// prose. So the shape lives here, beside the parser it mirrors, and the callers
// import it.
//
// # Why a mirror rather than the parser itself
//
// The parser answers about a parsed tree. These callers ask about a raw string,
// often mid-edit, before any parse has run: a line the user is typing, a line
// being rewritten by a task-field writer, the text left above a split. A regex
// over the string is what that question takes, which is why the duplication
// exists at all. One copy of it is the fix, not zero.

/** The `[ ]` / `[x]` / `[X]` checkbox AND the separator the parser requires
 *  after it, anchored at the start of the text that follows a list marker.
 *
 *  Mirrors `@lezer/markdown`'s GFM `TaskList` leaf exactly. A caller testing a
 *  whole line wants {@link TASK_LINE_RE} instead. */
export const TASK_MARKER_RE = /^\[[ xX]\][ \t]/;

/** A whole task line: leading indent, a bullet marker, the checkbox, and the
 *  separator the parser requires after it. The capture groups are the prefix up
 *  to and including the bullet, and the checkbox character, so a caller
 *  rewriting the marker in place can keep both.
 *
 *  The separator is a LOOKAHEAD rather than part of the match, so `match[0]`
 *  ends at `]`. A caller rebuilding the line as `prefix + marker +
 *  line.slice(match[0].length)` (which `flipMarker` does) would otherwise eat
 *  the separator it just required, turning `- [x] a` into `- [ ]a` and leaving a
 *  line the parser no longer reads as a task. Required and not consumed is the
 *  only shape that serves both readings.
 *
 *  Deliberately does NOT accept an ordered marker (`1.`): GFM's task-list
 *  extension is defined on bullet lists, which is what every caller here means.
 */
export const TASK_LINE_RE = /^(\s*[-*+][ \t]+)\[([ xX])\](?=[ \t])/;

/** Whether the text FOLLOWING a list marker begins a task item.
 *
 * `text` is what comes after the bullet, not the whole line. Five characters is
 * enough for the longest form a caller needs to slice (`[ ] `), and a caller
 * with the whole line in hand should use {@link isTaskLine}. */
export function isTaskMarker(text: string): boolean {
  return TASK_MARKER_RE.test(text);
}

/** Whether a whole line is a bullet task item, separator included. */
export function isTaskLine(line: string): boolean {
  return TASK_LINE_RE.test(line);
}
