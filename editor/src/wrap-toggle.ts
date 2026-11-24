// `toggleWrap` — apply or remove markdown delimiter pairs around a
// selection range. Idempotent toggle so toolbar B / I / S / `<>` buttons
// and Cmd+B / Cmd+I / Cmd+E keymap bindings can both add and remove the
// formatting, matching standard editor UX (typed `**foo**` then clicking B
// again on the wrapped text → `foo`, not `****foo****`).
//
// Decision pipeline (per the 2026-05-17 markdown edge-case research
// catalog at `private-companion/researches/2026-05-17-markdown-toggle-edge-cases.md`):
//
//   1. **Smart-toggle for collapsed cursor at marker boundary.** Cursor
//      right before a `close` marker that has a matching opener earlier
//      on the line → jump cursor past the closer (Obsidian 0.14.4+).
//      Cursor right after an `open` marker that has a matching closer
//      later on the line → jump cursor before the opener.
//
//   2. **Nested-emphasis unwrap via marker run-length analysis.** Treat
//      a contiguous `*`-run before/after the selection as a stack of
//      `**` bold + `*` italic layers. Italic toggle strips the italic
//      layer iff run length is odd; bold toggle strips one bold layer
//      iff run length >= 2. Covers cases like:
//        - `**foo**` + bold → `foo` (clean unwrap)
//        - `***foo***` + bold → `*foo*` (strip outer bold, italic stays)
//        - `***foo***` + italic → `**foo**` (strip inner italic, bold stays)
//        - `**foo**` + italic → wraps to `***foo***` (no italic layer to
//          strip; nest by adding new pair)
//
//   3. **Inside-selection marker unwrap.** Selection text itself starts
//      and ends with `open`/`close` — strip those characters from the
//      inside.
//
//   4. **Opposite-marker straddle splitting.** Italic toggle (`*`) on
//      a selection whose source contains `**` bold markers — split at
//      each `**` and wrap each non-empty chunk. Symmetric for bold
//      toggle (`**`) on selections containing `*` italic markers.
//
//   5. **Multi-paragraph per-paragraph wrap.** Selection spans `\n\n`
//      paragraph break — wrap each paragraph separately (Obsidian 1.5.2
//      semantics).
//
//   6. **Plain wrap.** Default — insert `open` before, `close` after.

import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type StateCommand,
  type Text,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { cachedLocateFrontmatter } from "./frontmatter-cache";
import { rangeOverlapsAttachmentEmbed } from "./decorations/attachment-embed";

const BOLD_MARKER = "**";

/** Length of a contiguous run of `markerChar` characters extending from
 * the byte immediately {before|after} `pos`. */
function markerRunLength(
  doc: Text,
  pos: number,
  markerChar: string,
  direction: "before" | "after",
): number {
  let count = 0;
  if (direction === "before") {
    let p = pos;
    while (p - 1 >= 0 && doc.sliceString(p - 1, p) === markerChar) {
      count++;
      p--;
    }
  } else {
    let p = pos;
    while (p < doc.length && doc.sliceString(p, p + 1) === markerChar) {
      count++;
      p++;
    }
  }
  return count;
}

/** Decompose a marker run of length `R` into bold layers (`R / 2`) plus
 * italic layer (`R % 2`). For the toggle marker of length `L`:
 *   - L=1 italic: strip 1 char iff R is odd (italic layer present)
 *   - L=2 bold: strip 2 chars iff R >= 2 (at least one bold layer)
 *   - Other lengths fall back to a strict-equality check on the run. */
function canUnwrapNested(runBefore: number, runAfter: number, len: number): boolean {
  if (runBefore < len || runAfter < len) return false;
  if (len === 1) {
    // Italic / inline-code / strike single — italic layer present iff odd.
    return runBefore % 2 === 1 && runAfter % 2 === 1;
  }
  if (len === 2) {
    // Bold / strike double — bold layer present iff run >= 2.
    return runBefore >= 2 && runAfter >= 2;
  }
  // Longer markers (rare) — only exact-equal run allowed.
  return runBefore === len && runAfter === len;
}

/** True iff the line-relative substring `text` contains an odd count of
 * `marker` occurrences. A standalone-marker oddness check is the simplest
 * heuristic for "is there an unmatched opener earlier on this line." */
function hasUnmatchedMarker(text: string, marker: string): boolean {
  if (marker === "") return false;
  let count = 0;
  let idx = 0;
  while (idx <= text.length - marker.length) {
    if (text.slice(idx, idx + marker.length) === marker) {
      // Skip the next `marker.length` characters so `**` doesn't count
      // as two `*`s when marker is `*`.
      count++;
      idx += marker.length;
    } else {
      idx++;
    }
  }
  return count % 2 === 1;
}

/** Find the first index in `text` matching `marker` that is NOT part of
 * a longer marker run (i.e., a standalone `*` not embedded in `**`). */
function indexOfStandaloneMarker(text: string, marker: string): number {
  const ch = marker[0]!;
  for (let i = 0; i <= text.length - marker.length; i++) {
    if (text.slice(i, i + marker.length) === marker) {
      if (
        (i === 0 || text[i - 1] !== ch) &&
        (i + marker.length === text.length || text[i + marker.length] !== ch)
      ) {
        return i;
      }
    }
  }
  return -1;
}

/** Backward-scan variant — returns the LAST index in `text` matching
 * `marker` as a standalone (not part of a longer run). */
function lastIndexOfStandaloneMarker(text: string, marker: string): number {
  const ch = marker[0]!;
  for (let i = text.length - marker.length; i >= 0; i--) {
    if (text.slice(i, i + marker.length) === marker) {
      if (
        (i === 0 || text[i - 1] !== ch) &&
        (i + marker.length === text.length || text[i + marker.length] !== ch)
      ) {
        return i;
      }
    }
  }
  return -1;
}

export function toggleWrap(open: string, close: string): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = [];
    const newRanges: SelectionRange[] = [];

    // AST-aware refuse paths (silent no-op):
    //   (i)  Selection inside an InlineCode node — emphasis has no
    //        semantic effect inside code (CommonMark Rule 17).
    //   (ii) Selection partially overlaps a URL node — wrapping would
    //        break the link structure (CommonMark Rule 17: link groups
    //        more tightly than emphasis).
    //   (iii) Selection inside the YAML frontmatter body — typing `*`
    //        in YAML must not render as italic; refusing the toggle
    //        avoids leaking emphasis bytes into the YAML payload.
    const tree = syntaxTree(state);
    const fmRange = cachedLocateFrontmatter(state.doc);
    const refuse = state.selection.ranges.some((r) => {
      if (isPositionInsideNode(tree, r.from, "InlineCode")) return true;
      // Fenced / indented code blocks (MYND-154): emphasis markers must not be
      // injected into code source.
      if (isPositionInsideNode(tree, r.from, "FencedCode")) return true;
      if (isPositionInsideNode(tree, r.from, "CodeBlock")) return true;
      if (selectionPartiallyOverlapsNode(tree, r.from, r.to, "URL")) return true;
      // Attachment embeds are atomic widgets (image / PDF) — you cannot apply
      // inline emphasis to one. Wrapping the raw `![[att:…]]` source in `**`/`*`
      // is meaningless, so refuse the toggle when the selection touches an embed.
      if (rangeOverlapsAttachmentEmbed(state, r.from, r.to)) return true;
      if (
        fmRange !== null &&
        r.from >= fmRange.bodyStart &&
        r.to <= fmRange.bodyEnd
      ) {
        return true;
      }
      return false;
    });
    if (refuse) return false;

    for (const originalRange of state.selection.ranges) {
      // ---- Step 0: trim trailing newlines from selection ----
      // Wrap markers should land BEFORE the line break so the emphasis
      // stays inside the original paragraph.
      let range = originalRange;
      if (!range.empty) {
        let effectiveTo = range.to;
        while (
          effectiveTo > range.from &&
          state.doc.sliceString(effectiveTo - 1, effectiveTo) === "\n"
        ) {
          effectiveTo--;
        }
        if (effectiveTo !== range.to) {
          range =
            range.anchor <= range.head
              ? EditorSelection.range(range.from, effectiveTo)
              : EditorSelection.range(effectiveTo, range.from);
        }
      }

      // ---- Step 1: smart-toggle for collapsed cursor at marker edge ----
      if (range.empty && open === close) {
        const smartResult = trySmartToggleCursor(state, range, open);
        if (smartResult !== null) {
          newRanges.push(smartResult);
          continue;
        }
      }

      // ---- Step 5: multi-paragraph per-paragraph wrap ----
      if (!range.empty) {
        const text = state.doc.sliceString(range.from, range.to);
        if (text.includes("\n\n")) {
          const paragraphResult = wrapPerParagraph(state, range, open, close);
          if (paragraphResult !== null) {
            changes.push(...paragraphResult.changes);
            newRanges.push(paragraphResult.range);
            continue;
          }
        }
      }

      // ---- Step 2: nested-emphasis unwrap via run-length analysis ----
      // Only applies when open === close (symmetric markers like `**`, `*`,
      // `~~`, `` ` ``).
      if (open === close) {
        const markerChar = open[0]!;
        const runBefore = markerRunLength(state.doc, range.from, markerChar, "before");
        const runAfter = markerRunLength(state.doc, range.to, markerChar, "after");
        if (canUnwrapNested(runBefore, runAfter, open.length)) {
          changes.push({
            from: range.from - open.length,
            to: range.from,
            insert: "",
          });
          changes.push({
            from: range.to,
            to: range.to + close.length,
            insert: "",
          });
          newRanges.push(
            EditorSelection.range(
              range.anchor - open.length,
              range.head - open.length,
            ),
          );
          continue;
        }
      }

      // ---- Step 3: inside-selection marker unwrap ----
      const text = state.doc.sliceString(range.from, range.to);
      if (
        text.length >= open.length + close.length &&
        text.startsWith(open) &&
        text.endsWith(close)
      ) {
        const stripped = text.slice(open.length, text.length - close.length);
        changes.push({ from: range.from, to: range.to, insert: stripped });
        const from = range.from;
        const to = from + stripped.length;
        newRanges.push(
          range.anchor <= range.head
            ? EditorSelection.range(from, to)
            : EditorSelection.range(to, from),
        );
        continue;
      }

      // ---- Step 4: opposite-marker straddle splitting ----
      const straddleResult = tryStraddleSplit(text, open, close);
      if (straddleResult !== null && straddleResult !== text) {
        changes.push({
          from: range.from,
          to: range.to,
          insert: straddleResult,
        });
        const newTo = range.from + straddleResult.length;
        newRanges.push(
          range.anchor <= range.head
            ? EditorSelection.range(range.from, newTo)
            : EditorSelection.range(newTo, range.from),
        );
        continue;
      }

      // ---- Step 6: plain wrap ----
      const wrapped = `${open}${text}${close}`;
      changes.push({ from: range.from, to: range.to, insert: wrapped });
      const innerFrom = range.from + open.length;
      const innerTo = innerFrom + text.length;
      newRanges.push(
        range.anchor <= range.head
          ? EditorSelection.range(innerFrom, innerTo)
          : EditorSelection.range(innerTo, innerFrom),
      );
    }

    if (changes.length === 0 && newRanges.length === 0) return false;
    if (changes.length === 0) {
      dispatch(
        state.update({
          selection: EditorSelection.create(newRanges),
          userEvent: "format.toggle",
        }),
      );
      return true;
    }
    dispatch(
      state.update({
        changes,
        selection: EditorSelection.create(newRanges),
        userEvent: "format.toggle",
      }),
    );
    return true;
  };
}

/** Returns true iff `pos` is strictly inside a syntax-tree node of the
 * given name (not at its boundary). Empty tree (no language extension)
 * returns false. */
function isPositionInsideNode(
  tree: ReturnType<typeof syntaxTree>,
  pos: number,
  nodeName: string,
): boolean {
  let inside = false;
  tree.iterate({
    from: Math.max(0, pos - 1),
    to: pos + 1,
    enter: (node) => {
      if (node.name === nodeName && node.from < pos && node.to > pos) {
        inside = true;
        return false;
      }
      return undefined;
    },
  });
  return inside;
}

/** Returns true iff the range `[from, to)` overlaps a node of the given
 * name without fully containing it (selection straddles the node). */
function selectionPartiallyOverlapsNode(
  tree: ReturnType<typeof syntaxTree>,
  from: number,
  to: number,
  nodeName: string,
): boolean {
  let partial = false;
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (node.name !== nodeName) return undefined;
      const fullyContained = node.from >= from && node.to <= to;
      const overlaps = node.from < to && node.to > from;
      if (overlaps && !fullyContained) {
        partial = true;
        return false;
      }
      return undefined;
    },
  });
  return partial;
}

/** Obsidian-style smart-toggle for collapsed cursor at a marker edge.
 * - Cursor right before a `close` marker with a matching opener earlier
 *   on the line → jump cursor past the closer.
 * - Cursor right after an `open` marker with a matching closer later
 *   on the line → jump cursor before the opener.
 * Returns `null` to fall through to default empty-selection wrap. */
function trySmartToggleCursor(
  state: EditorState,
  range: SelectionRange,
  marker: string,
): SelectionRange | null {
  const head = range.head;
  const len = marker.length;
  const line = state.doc.lineAt(head);
  const lineFrom = line.from;
  const lineTo = line.to;

  // (a) Right before a closer: doc[head..head+len] === marker AND the
  //     marker is standalone (not part of a longer run) AND a matching
  //     opener exists earlier on the line.
  const afterChars = state.doc.sliceString(head, Math.min(head + len, lineTo));
  if (afterChars === marker) {
    const charAfterMarker =
      head + len < state.doc.length
        ? state.doc.sliceString(head + len, head + len + 1)
        : "";
    const charBeforeCursor =
      head > 0 ? state.doc.sliceString(head - 1, head) : "";
    const isStandalone = charAfterMarker !== marker[len - 1];
    const isAdjacentToContent = charBeforeCursor !== "" && charBeforeCursor !== marker[0];
    if (isStandalone && isAdjacentToContent) {
      const earlierOnLine = state.doc.sliceString(lineFrom, head);
      if (hasUnmatchedMarker(earlierOnLine, marker)) {
        return EditorSelection.cursor(head + len);
      }
    }
  }

  // (b) Right after an opener: doc[head-len..head] === marker AND
  //     standalone AND matching closer exists later on the line.
  const beforeChars = state.doc.sliceString(Math.max(head - len, lineFrom), head);
  if (beforeChars === marker) {
    const charBeforeMarker =
      head - len > 0 ? state.doc.sliceString(head - len - 1, head - len) : "";
    const charAfterCursor =
      head < state.doc.length ? state.doc.sliceString(head, head + 1) : "";
    const isStandalone = charBeforeMarker !== marker[0];
    const isAdjacentToContent = charAfterCursor !== "" && charAfterCursor !== marker[len - 1];
    if (isStandalone && isAdjacentToContent) {
      const laterOnLine = state.doc.sliceString(head, lineTo);
      if (hasUnmatchedMarker(laterOnLine, marker)) {
        return EditorSelection.cursor(head - len);
      }
    }
  }

  // (c) Cursor inside emphasis content (between markers, not at boundary).
  //     Find the nearest standalone marker BEFORE cursor on the line AND
  //     a matching one AFTER. If both present, jump cursor past the
  //     closer — equivalent to Obsidian "Cmd+I inside italic text jumps
  //     to end of span."
  const earlierOnLine = state.doc.sliceString(lineFrom, head);
  const laterOnLine2 = state.doc.sliceString(head, lineTo);
  const openerLocalIdx = lastIndexOfStandaloneMarker(earlierOnLine, marker);
  const closerLocalIdx = indexOfStandaloneMarker(laterOnLine2, marker);
  if (openerLocalIdx !== -1 && closerLocalIdx !== -1) {
    return EditorSelection.cursor(head + closerLocalIdx + marker.length);
  }

  return null;
}

/** Multi-paragraph wrap: split selection at `\n\n` and wrap each
 * paragraph segment separately. Returns null if the selection doesn't
 * actually span a paragraph break after trimming. */
function wrapPerParagraph(
  state: EditorState,
  range: SelectionRange,
  open: string,
  close: string,
): { changes: ChangeSpec[]; range: SelectionRange } | null {
  const text = state.doc.sliceString(range.from, range.to);
  const paragraphs: Array<{ start: number; end: number; content: string }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const breakIdx = text.indexOf("\n\n", cursor);
    if (breakIdx === -1) {
      const content = text.slice(cursor);
      if (content.trim() !== "") {
        paragraphs.push({ start: cursor, end: text.length, content });
      }
      break;
    }
    const content = text.slice(cursor, breakIdx);
    if (content.trim() !== "") {
      paragraphs.push({ start: cursor, end: breakIdx, content });
    }
    cursor = breakIdx + 2;
  }
  if (paragraphs.length < 2) return null;

  // Build replacement text — each paragraph wrapped, separator preserved.
  let out = "";
  let prevEnd = 0;
  for (const p of paragraphs) {
    out += text.slice(prevEnd, p.start);
    out += `${open}${p.content}${close}`;
    prevEnd = p.end;
  }
  out += text.slice(prevEnd);

  return {
    changes: [{ from: range.from, to: range.to, insert: out }],
    range: EditorSelection.range(range.from, range.from + out.length),
  };
}

/** Opposite-marker straddle splitting. When toggling italic (`*`) on a
 * selection that contains `**` bold markers, split at each `**` and
 * wrap each non-empty chunk individually. Symmetric for bold toggle
 * (`**`) on selections containing standalone `*` italic markers.
 * Returns the rewritten selection text, or `null` to fall through. */
function tryStraddleSplit(text: string, open: string, close: string): string | null {
  if (open !== close) return null;
  // Italic toggle straddling bold:
  if (open === "*" && text.includes(BOLD_MARKER)) {
    const parts = text.split(BOLD_MARKER);
    const wrapped = parts
      .map((p) => (p === "" ? "" : `${open}${p}${close}`))
      .join(BOLD_MARKER);
    return wrapped;
  }
  // Bold toggle straddling italic (single `*` not part of `**`):
  if (open === "**") {
    const standaloneIdx = indexOfStandaloneMarker(text, "*");
    if (standaloneIdx !== -1) {
      // Split at every standalone `*` (not part of `**`). For simplicity,
      // re-scan and split.
      const chunks: string[] = [];
      let start = 0;
      let i = 0;
      while (i < text.length) {
        if (
          text[i] === "*" &&
          (i === 0 || text[i - 1] !== "*") &&
          (i === text.length - 1 || text[i + 1] !== "*")
        ) {
          // Standalone italic marker at i.
          chunks.push(text.slice(start, i));
          chunks.push("*"); // delimiter
          start = i + 1;
          i++;
        } else {
          i++;
        }
      }
      chunks.push(text.slice(start));
      // Wrap text chunks (every-other index), keep delimiter chunks intact.
      let out = "";
      for (let j = 0; j < chunks.length; j++) {
        if (j % 2 === 0) {
          // text chunk
          out += chunks[j] === "" ? "" : `${open}${chunks[j]}${close}`;
        } else {
          // delimiter
          out += chunks[j];
        }
      }
      return out;
    }
  }
  return null;
}
