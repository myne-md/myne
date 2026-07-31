// Minimal hand-rolled line diff (MYND-97, SYNC-10). Added/removed/unchanged
// lines between two texts — NO external dependency (the minimum-direct-dep /
// TB9 discipline; `@codemirror/merge` was rejected in the file-recovery-ui
// grill). LCS-based, which is plenty for note-sized content; a coarse fallback
// bounds memory for pathologically large inputs.
//
// Lifted out of the desktop `src/notes/lineDiff.ts` into `@myne/dialect`
// (MYND-334, following the SYNC-45 conflict-copy precedent) so the desktop
// snapshot panel, the desktop conflict view and the mobile client all diff
// through one implementation instead of three drifting copies. Behaviour is
// unchanged by the move.
//
// Pure text-in → diff-out: no IO, no note knowledge, no normalization (callers
// normalize first). That keeps it trivially inside the platform-seam rule — a
// pure string function takes zero `@tauri-apps/*` imports by construction.

/**
 * A run of text inside one changed line, tagged by how it relates to the other
 * side. A `del` line's segments are `same`/`del` only; an `add` line's are
 * `same`/`add` only, and each line's segments concatenate back to its `text`.
 */
export type DiffSegment =
  | { type: "same"; text: string }
  | { type: "add"; text: string }
  | { type: "del"; text: string };

export type DiffLine =
  | { type: "same"; text: string }
  | { type: "add"; text: string; segments?: DiffSegment[] }
  | { type: "del"; text: string; segments?: DiffSegment[] };

// Above this many lines on either side, skip the O(n·m) LCS table and fall back
// to a coarse "everything replaced" diff (bounded memory). Notes are normally
// far smaller; this only guards a 16 MiB worst case.
const LCS_LINE_CAP = 5000;

/**
 * Compute a line-level diff transforming `oldText` into `newText`.
 * Returns the lines in output order, each tagged `same` / `add` (present only
 * in new) / `del` (present only in old).
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  return computeLineDiff(oldText, newText).lines;
}

/**
 * The line pass, plus whether it took the coarse over-cap path — the word pass
 * needs to know, because in a coarse diff the del and add blocks are two whole
 * documents standing next to each other, not lines that correspond.
 */
function computeLineDiff(
  oldText: string,
  newText: string,
): { lines: DiffLine[]; coarse: boolean } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  if (n > LCS_LINE_CAP || m > LCS_LINE_CAP) {
    // Coarse fallback: show the whole old block removed, the whole new added.
    return {
      coarse: true,
      lines: [
        ...a.map((text): DiffLine => ({ type: "del", text })),
        ...b.map((text): DiffLine => ({ type: "add", text })),
      ],
    };
  }

  // dp[i][j] = LCS length of a[i..] and b[j..].
  const dp: number[][] = Array.from(
    { length: n + 1 },
    () => new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i] });
    i++;
  }
  while (j < m) {
    out.push({ type: "add", text: b[j] });
    j++;
  }
  return { lines: out, coarse: false };
}

/** Count of changed (added + removed) lines — for a compact "N changes" summary. */
export function changedLineCount(diff: DiffLine[]): number {
  return diff.reduce((acc, d) => (d.type === "same" ? acc : acc + 1), 0);
}

// --- Word-level intra-line refinement ---------------------------------------
//
// The line pass alone renders a one-word edit as a whole replaced line, which
// reads as "everything changed" when almost nothing did. A second LCS pass over
// the tokens of each corresponding del/add pair narrows that to the words that
// actually moved. Same discipline as above: no dependency, and a cap so a
// pathological line falls back instead of allocating an n·m table.

// Token classes: word runs, whitespace runs, punctuation runs. Splitting
// punctuation off its word is what lets `word,` → `word.` highlight the mark
// alone; keeping whitespace as tokens is what lets the segments concatenate
// back to the original line exactly.
const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]+/gu;

// Above this many tokens on either side of a pair, skip the token LCS and leave
// the pair unrefined (the line-level del/add still renders). A minified blob or
// a base64 line is exactly the input this guards against.
const LCS_TOKEN_CAP = 1000;

/**
 * Line diff with word-level `segments` attached to each corresponding del/add
 * pair. Line-level output is identical to {@link lineDiff} — segments are
 * purely additive, so existing line-level consumers are unaffected.
 */
export function diffWithSegments(oldText: string, newText: string): DiffLine[] {
  const { lines, coarse } = computeLineDiff(oldText, newText);
  // A coarse diff pairs nothing: its del block is the whole old document and
  // its add block the whole new one, so token-matching them would be noise.
  return coarse ? lines : refineSegments(lines);
}

/**
 * Attach word segments to del/add lines that correspond. Within each maximal
 * run of dels immediately followed by a run of adds, the k-th del is refined
 * against the k-th add; a surplus on either side is a pure removal/insertion
 * and stays unrefined.
 */
function refineSegments(lines: DiffLine[]): DiffLine[] {
  const out = lines.slice();
  let i = 0;
  while (i < out.length) {
    if (out[i].type !== "del") {
      i++;
      continue;
    }
    let delEnd = i;
    while (delEnd < out.length && out[delEnd].type === "del") delEnd++;
    let addEnd = delEnd;
    while (addEnd < out.length && out[addEnd].type === "add") addEnd++;

    const pairs = Math.min(delEnd - i, addEnd - delEnd);
    for (let k = 0; k < pairs; k++) {
      const del = out[i + k];
      const add = out[delEnd + k];
      const refined = segmentPair(del.text, add.text);
      if (!refined) continue;
      out[i + k] = { type: "del", text: del.text, segments: refined.del };
      out[delEnd + k] = { type: "add", text: add.text, segments: refined.add };
    }
    i = Math.max(addEnd, delEnd);
  }
  return out;
}

/**
 * Token-level LCS of one del/add pair, split into the two per-line segment
 * lists. Returns `null` when refinement is not worth it or not safe: an empty
 * line, or a line over the token cap.
 */
function segmentPair(
  oldLine: string,
  newLine: string,
): { del: DiffSegment[]; add: DiffSegment[] } | null {
  if (oldLine === "" || newLine === "") return null;

  const a = oldLine.match(TOKEN_RE) ?? [];
  const b = newLine.match(TOKEN_RE) ?? [];
  if (a.length > LCS_TOKEN_CAP || b.length > LCS_TOKEN_CAP) return null;

  const ops = tokenOps(a, b);
  // Matching only whitespace is not a meaningful match — two entirely different
  // sentences share their spaces. Treat that as a whole-line replacement so the
  // reader sees one del and one add rather than shredded punctuation.
  const meaningful = ops.some((o) => o.type === "same" && o.text.trim() !== "");
  if (!meaningful) {
    return {
      del: [{ type: "del", text: oldLine }],
      add: [{ type: "add", text: newLine }],
    };
  }

  return {
    del: mergeSegments(ops.filter((o) => o.type !== "add")),
    add: mergeSegments(ops.filter((o) => o.type !== "del")),
  };
}

/** LCS walk over tokens, same shape as the line pass. */
function tokenOps(a: string[], b: string[]): DiffSegment[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from(
    { length: n + 1 },
    () => new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i] });
    i++;
  }
  while (j < m) {
    out.push({ type: "add", text: b[j] });
    j++;
  }
  return out;
}

/** Collapse runs of same-typed tokens into one segment each. */
function mergeSegments(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.type === s.type) out[out.length - 1] = { ...last, text: last.text + s.text };
    else out.push(s);
  }
  return out;
}
