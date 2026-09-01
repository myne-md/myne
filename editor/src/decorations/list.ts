// Plain bullet / ordered list rendering (MYND-208, render-conformance-harness
// task 4; `decisions.md` 2026-06-08 — reverses the prior implicit
// "lists render highlight-only" status).
//
// BULLET markers (`-`/`*`/`+`) render as a glyph (`•` top level, `◦` nested).
// The disc reveals its raw `- ` ONLY when the caret sits ON the marker itself
// (like a heading's `#`) — NOT for the whole line — so editing the item's text
// keeps the disc instead of flickering back to raw. ORDERED markers (`1.`) stay
// editable text: muted OFF the cursor line, un-muted (revealed) ON it. Every
// list line gets a hanging indent so a wrapped label hangs under the label
// rather than running back under its own marker.
// Render-only: the buffer is never mutated (§6 C1).
//
// Task-list items (`- [ ]` / `- [x]`) have their MARKER owned by `task-list.ts`
// (it hides the `-` and renders a checkbox), so this decoration paints no glyph
// for one, but their LINE BOX is still this file's, because the hanging indent
// belongs to every list line and nothing else emits one (myne-md/myne#594).
// The nesting indent is NOT the source's leading whitespace: that is hidden and
// re-drawn as one fixed step per level, which is what makes the wrapped column
// exact rather than measured against a space of unknown width.

import { isTaskMarker } from "@myne/dialect/taskMarker";
import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { isCursorLine, isInsideRange } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

// The bullet is drawn by CSS (a filled disc top-level, a hollow ring when
// nested) rather than a Unicode glyph — `•` and `◦` render at wildly different
// sizes/baselines across fonts (the tiny-high-dot vs big-ring look), so a CSS
// circle keeps both consistent and crisp.
class ListBulletWidget extends WidgetType {
  constructor(private readonly nested: boolean) {
    super();
  }
  eq(other: ListBulletWidget): boolean {
    return other.nested === this.nested;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.nested
      ? "cm-list-bullet cm-list-bullet-ring"
      : "cm-list-bullet";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

/** True if the list item starting at this mark is a GFM task item (`- [ ]` /
 *  `- [x]`), whose MARKER `task-list.ts` owns: `list.ts` renders no glyph for
 *  one (its line box is still this file's, see `buildListDecorations`).
 *
 *  The shape comes from `@myne/dialect/taskMarker` rather than being restated,
 *  and the leading-whitespace tolerance is this caller's own: it is handed the
 *  text after the mark, which can begin with the gap. Restating it here is what
 *  made this predicate LAXER than the parser once, so `- [ ]foo`, an ordinary
 *  bullet item whose text happens to start with `[ ]`, had its bullet
 *  suppressed here while `task-list.ts`, finding no `TaskMarker` node, drew no
 *  checkbox either, and the line rendered with no marker at all. */
function isTaskItem(doc: string): boolean {
  return isTaskMarker(doc.slice(spaceRunLength(doc, 0)));
}

/** Number of ancestor list nodes above this one (0 = top level). */
function listDepth(node: {
  parent: { name: string; parent: unknown } | null;
}): number {
  let depth = 0;
  let cur = node.parent;
  while (cur !== null) {
    if (cur.name === "BulletList" || cur.name === "OrderedList") depth++;
    cur = (cur as { parent: { name: string; parent: unknown } | null }).parent;
  }
  // The mark's immediate list ancestor counts as level 1 in the walk; map to a
  // 0-based depth for glyph selection.
  return Math.max(0, depth - 1);
}

/** The marker column each list shape occupies, as CSS the THEME declares.
 *
 *  These used to be JS numbers mirroring `theme.ts` under a "keep in step"
 *  comment, which was a cosmetic coupling until myne-md/myne#594 made it
 *  arithmetic: the hanging indent is computed FROM the marker width, so editing
 *  `.cm-task-checkbox`'s `margin-right` in the theme silently misaligned every
 *  wrapped task row. Reading the same custom property both sides draw from
 *  leaves one value, and it leaves it where a custom theme can reach it.
 *
 *  The fallbacks are what the theme declares today, so a host that mounts the
 *  decorations without the Myne theme still renders a sane column. */
const BULLET_WIDTH = "var(--cm-list-marker-bullet, 1.4ch)";
const CHECKBOX_WIDTH = "var(--cm-list-marker-task, 22px)";

/** How far ONE level of nesting indents a list. A design value rather than a
 *  measured one, which is the point: the source's own leading whitespace is
 *  hidden and this is drawn in its place, so the column is exact and a list
 *  indented with two spaces per level looks like one indented with four. */
const INDENT_PER_LEVEL = "var(--cm-list-indent-step, 1.5em)";

/** The offset the item's label starts at: the marker's own whitespace run,
 *  skipped. The one statement of "where does the body of this item begin",
 *  which `task-list.ts` asks too. The two must agree or the hanging indent
 *  and the painted label part company (myne-md/myne#594). */
export function listLabelStart(
  line: { from: number; text: string },
  markTo: number,
): number {
  return markTo + spaceRunLength(line.text, markTo - line.from);
}

/** How many spaces and tabs run from `from` in `text`.
 *
 * The one whitespace scanner in this file. It was three: the gap after a list
 * marker, the leading indent of a line, and a per-character test in the Enter
 * command next door, all the same primitive written three ways in one change.
 *
 * `listLabelStart` used to answer its question with `doc.sliceString(markTo,
 * line.to)`, copying the whole remainder of the line to count one or two
 * spaces, on every list line, on every decoration rebuild. This plugin is
 * cursor-aware, so that is every keystroke, every viewport change and every
 * cursor move. `line.text` is already materialised by the `doc.lineAt` the
 * caller just did. */
export function spaceRunLength(text: string, from: number): number {
  let n = from;
  while (n < text.length && (text[n] === " " || text[n] === "\t")) n += 1;
  return n - from;
}

/** Leading whitespace of `text`, in characters. */
function indentLength(text: string): number {
  return spaceRunLength(text, 0);
}

function buildListDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  const doc = view.state.doc;
  // Hoisted out of the range loop: it is the same tree for every visible range.
  const tree = syntaxTree(view.state);
  const seenLines = new Set<number>();

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "ListMark") return undefined;
        const line = doc.lineAt(node.from);
        // Five characters, not four: the parser's task rule needs the separator
        // AFTER `[ ]` to see a task at all, and so does `isTaskItem`.
        const afterMark = doc.sliceString(node.to, Math.min(node.to + 5, line.to));
        const isTask = isTaskItem(afterMark);

        const marker = doc.sliceString(node.from, node.to);
        const isBullet = /^[-*+]$/.test(marker);
        // A bullet reveals its raw `- ` ONLY when the caret sits ON the marker
        // itself (like a heading's `#`), not for the whole line — so editing the
        // item's text keeps the disc. Ordered markers reveal on the cursor LINE.
        const bulletRevealed =
          isBullet && isInsideRange(view, node.from, node.to);
        const bulletRendered = isBullet && !bulletRevealed;
        const depth = listDepth(node.node);
        // Where this item's label begins: the marker column's width for the
        // hanging indent, and the end of what the bullet's own widget replaces.
        const labelStart = listLabelStart(line, node.to);
        // How much of the marker's run the bullet widget takes: its trailing
        // whitespace too, UNLESS that is the rest of the line. A `.cm-line`
        // whose DOM is nothing but widgets has no editable position in it, and a
        // character typed there is attributed to the widget's start: the letter
        // lands before the marker and the item stops being a list item
        // (myne-md/myne#598).
        const markerReplaceTo = labelStart < line.to ? labelStart : node.to;
        // …which is also what decides whether hiding the source indent is safe:
        // the two replacements are adjacent, so it is their SUM that can empty
        // the line, and neither can answer that alone.
        const lineKeepsText = markerReplaceTo < line.to;

        // Hanging indent, in units this file OWNS rather than in units it has to
        // guess (myne-md/myne#594).
        //
        // A wrapped row has to start where the label starts, and that column is
        // `leading indent + marker`. The marker half is known: the disc is
        // `1.4ch` and the checkbox is 22px, both of them CSS the theme declares.
        // The leading indent was the half that could not be: it is SOURCE
        // WHITESPACE, painted at the font's space width, while the offset had to
        // be written in `ch`, the width of a "0". Under the default monospace
        // editor font those are the same number and the arithmetic was
        // invisible. Under any proportional one a space is roughly half a `ch`,
        // so every wrapped row sat about `indent columns x (ch - space)` too far
        // right, growing with nesting depth.
        //
        // So the indent stops being source whitespace: it is REPLACED and
        // re-drawn as `depth x INDENT_PER_LEVEL_EM` of padding. The column is
        // then exact by construction under every font and every text size, and a
        // list indented with two spaces per level renders like one indented with
        // four, the same normalisation the bullet glyph already applies to
        // `-` / `*` / `+`.
        //
        // (An inline-block around the label is the other way to hang a wrapped
        // row without measuring anything, and it does not work here: an
        // inline-block's shrink-to-fit width resolves against its CONTAINING
        // BLOCK, not against the space left on the line, so a long label asks for
        // the full line width, fails to fit beside its own marker, and drops to
        // the next row at the line's left edge, further left than the bug it
        // was fixing.)
        if (!seenLines.has(line.from)) {
          seenLines.add(line.from);
          const indent = indentLength(line.text);
          // The marker column, in the unit the theme draws that marker in.
          //
          // The third arm is `ch` and that is a KNOWN approximation, not an
          // oversight, so it is written down rather than left to look like one.
          // It covers the two cases where the marker is REVEALED source text:
          // an ordered marker (`1. `), and a bullet on the caret's own line.
          // Source text is painted at the font's own metrics, which is exactly
          // the argument above for why the leading indent could not stay in
          // `ch`, so a wrapped row under `10. ` on a proportional font hangs
          // slightly off, by the difference between `ch` and what the digits,
          // period and space actually measure.
          //
          // The fix the indent got does not transfer: that column is a fixed
          // step per nesting level, and this one is not. `1.` and `100.` are
          // different widths, so no theme-declared constant expresses it, and
          // the marker cannot be replaced and re-drawn the way the indent is
          // because being the source is the point of revealing it. What would
          // close it is measuring the rendered marker, which a decoration
          // built from document positions has no way to do. Bounded and
          // shrinking rather than open: it applies only while the caret is on
          // the line, or to ordered lists, and never to the resting bullet or
          // checkbox rendering above, which are theme-declared and exact.
          const markerWidth = isTask
            ? CHECKBOX_WIDTH
            : bulletRendered
              ? BULLET_WIDTH
              : `${labelStart - node.from}ch`;
          // Whether the source indent below is about to be hidden. The padding
          // stands IN for it, so the two have to agree: when the indent stays
          // visible the spaces are painted as text AND the padding adds the same
          // step again, and the row lands one level further in than its
          // siblings. The gate below is the authority on when that happens, so
          // it is read here rather than restated.
          const indentHidden = indent > 0 && lineKeepsText;
          decorations.push(
            Decoration.line({
              class: "cm-list-item-line",
              attributes: {
                // `--cm-line-lead` is whatever an enclosing construct has already
                // claimed of the line's left edge: a blockquote sets it to clear
                // its own bars. Reading it here makes the two insets ADD rather
                // than overwrite: both write `padding-left` on the same
                // `.cm-line`, and the later declaration simply won, which is what
                // the old `inBlockquote` carve-out dodged by emitting nothing.
                style:
                  `text-indent:calc(-1 * ${markerWidth});` +
                  `padding-left:calc(var(--cm-line-lead, 0px)` +
                  ` + ${indentHidden || indent === 0 ? depth : 0} * ${INDENT_PER_LEVEL}` +
                  ` + ${markerWidth} + 6px)`,
              },
            }).range(line.from),
          );
          // Hide the source indent the padding now stands for, but never when
          // the marker is the last thing on the line, which would leave the line
          // with no text node at all and nowhere for a typed character to land
          // (myne-md/myne#598). An EMPTY item still has its separator, so it is
          // hidden there too and sits in its siblings' column rather than one
          // step further in.
          if (indentHidden) {
            decorations.push(
              Decoration.replace({}).range(line.from, line.from + indent),
            );
          }
        }
        // Everything below paints the MARKER, which on a task line belongs to
        // `task-list.ts`.
        if (isTask) return undefined;

        if (isBullet) {
          // Render the disc unless the caret is on the marker (then the raw `- `
          // shows for editing). Replace the marker AND its trailing whitespace
          // with the bullet; the gap to the body is the bullet's `margin-right`
          // (theme), so a leftover source space doesn't widen it.
          if (bulletRendered) {
            // …but stop at the marker on an EMPTY item, leaving that whitespace
            // as real text (myne-md/myne#598).
            //
            // An empty item is the one line where "marker plus its whitespace"
            // is the WHOLE line, so replacing all of it leaves a `.cm-line`
            // whose DOM is nothing but widget: no text node anywhere in it.
            // Typing into a line like that has no editable position to land in,
            // and the character is attributed to the widget's start: the letter
            // appears BEFORE the marker (`f- `), the item stops parsing as a
            // list item, and its disc turns back into a raw `-`. It is the
            // state every "Enter, Enter to leave a list" gesture ends in.
            //
            // One space of real text is enough to fix it and shows nothing: the
            // gap to a body that does not exist is invisible. A task item never
            // had the hole: `task-list.ts` replaces the marker characters only
            // and always leaves the separator behind.
            decorations.push(
              Decoration.replace({
                widget: new ListBulletWidget(depth > 0),
              }).range(node.from, markerReplaceTo),
            );
          }
        } else if (/^\d+[.)]$/.test(marker)) {
          // Ordered numbers stay editable text — mute them OFF the cursor line,
          // reveal (un-mute) on it.
          if (!isCursorLine(view, line.from, line.to)) {
            decorations.push(
              Decoration.mark({ class: "cm-list-number" }).range(node.from, node.to),
            );
          }
        }
        return undefined;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort(
    (a, b) => a.from - b.from || a.value.startSide - b.value.startSide,
  );
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function listDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildListDecorations);
}
